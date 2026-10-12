import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RECEIPT_SNIFF_BYTES, sniffReceiptType, typeOfReceiptPath } from './receipt-files';
import { INBOX_RECEIPT_BUCKET, type InboxReceiptType } from './receipts';

/**
 * The server's half of a receipt's file: reading its first bytes before it is
 * opened, and removing files the database has let go. Removal needs the
 * service client, because the bucket lets nobody who is signed in delete; what
 * may be removed is still the database's decision, asked one path at a time,
 * immediately before each removal (`finance_receipt_deletion_queued`).
 *
 * A path begins with a workspace id: nothing here logs one. Only fixed
 * sentences and error codes are logged.
 */

/** How long the first-bytes read may take before the file counts as unreadable. */
const FIRST_BYTES_TIMEOUT_MS = 5_000;

/**
 * The first bytes of what a signed link serves. Asks for a range, and stops
 * reading as soon as it has enough, so a store that ignores the range still
 * costs a few kilobytes and not the whole file. Null when nothing could be read.
 */
export async function firstBytesOf(
  url: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = FIRST_BYTES_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  try {
    const res = await fetcher(url, {
      headers: { Range: `bytes=0-${RECEIPT_SNIFF_BYTES - 1}` },
      cache: 'no-store',
      // A store that accepts the connection and then stalls must not hold the person's request open.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let have = 0;
    while (have < RECEIPT_SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      have += value.length;
    }
    await reader.cancel().catch(() => {});
    const out = new Uint8Array(Math.min(have, RECEIPT_SNIFF_BYTES));
    let at = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, out.length - at);
      out.set(part, at);
      at += part.length;
      if (at >= out.length) break;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Whether the stored bytes are the type the receipt says: `match`, `mismatch`,
 * or `unreadable` when the file could not be fetched at all. A HEIC and a
 * HEIF are the same container, so either answers for the other. Asked before
 * a link is handed out, and again before a file is ever sent to a model.
 */
export async function storedFileCheck(
  url: string,
  type: InboxReceiptType,
  fetcher: typeof fetch = fetch,
  timeoutMs = FIRST_BYTES_TIMEOUT_MS,
): Promise<'match' | 'mismatch' | 'unreadable'> {
  const bytes = await firstBytesOf(url, fetcher, timeoutMs);
  if (!bytes) return 'unreadable';
  const found = sniffReceiptType(bytes);
  if (found === type) return 'match';
  const heif = (t: InboxReceiptType | null) => t === 'image/heic' || t === 'image/heif';
  return heif(found) && heif(type) ? 'match' : 'mismatch';
}

/** Removes one object and says whether it is certainly gone. Storage answers a remove that removed nothing without an error. */
async function removeOne(service: SupabaseClient, path: string): Promise<boolean> {
  try {
    const { data, error } = await service.storage.from(INBOX_RECEIPT_BUCKET).remove([path]);
    if (error) {
      console.error('[finance/receipts] a receipt file could not be removed.');
      return false;
    }
    return Array.isArray(data);
  } catch {
    console.error('[finance/receipts] a receipt file could not be removed.');
    return false;
  }
}

/**
 * Removes the file of a receipt that was just deleted, if the database has
 * queued exactly that path, and takes it off the list. Never throws and never
 * fails the delete it follows: a file that stays is removed by the clean-up
 * run. Answers whether the file is gone and off the list.
 */
export async function removeReleasedReceiptFile(service: SupabaseClient, path: string): Promise<boolean> {
  // Only a path of exactly the shape the app uploads is ever handed to the service client here.
  if (typeOfReceiptPath(path) === null) return false;
  try {
    // Asked immediately before the removal: only what the database has let go is ever removed.
    const queued = await service.rpc('finance_receipt_deletion_queued', { p_path: path });
    if (queued.error || queued.data !== true) {
      if (queued.error) console.error('[finance/receipts] the removal list could not be read:', queued.error.code);
      return false;
    }
    if (!(await removeOne(service, path))) return false;
    // Takes the path off the list only if its object is really gone: the database looks.
    const done = await service.rpc('finance_receipt_deletions_done', { p_paths: [path] });
    if (done.error) {
      console.error('[finance/receipts] a removed file could not be taken off the list:', done.error.code);
      return false;
    }
    return done.data === 1;
  } catch {
    console.error('[finance/receipts] a receipt file could not be removed.');
    return false;
  }
}

export type ReceiptCleanupResult = {
  /** Files nobody recorded within the hour, newly put on the list by this run. */
  queued: number;
  /** Paths taken off the list because their files are gone. */
  removed: number;
  /** Something did not work, or the run stopped at its time limit: the rest waits for the next run. */
  failed: boolean;
};

/**
 * The clean-up run. Service-role client only. It queues every file an hour old
 * that no receipt holds, reads the oldest paths on the list, and for each one
 * asks the database again, removes the object, and at the end hands back the
 * paths it tried: the database takes off the list only those whose objects
 * are gone. It removes nothing the list does not name, and nothing outside
 * the receipts bucket. `budgetMs` keeps one run short; what is left is first
 * in line next time.
 */
export async function cleanReceiptFiles(
  service: SupabaseClient,
  { limit = 100, budgetMs = 20_000, now = () => Date.now() }: { limit?: number; budgetMs?: number; now?: () => number } = {},
): Promise<ReceiptCleanupResult> {
  const started = now();
  const orphans = await service.rpc('finance_receipt_queue_orphans');
  let failed = Boolean(orphans.error);
  if (orphans.error) console.error('receipt cleanup: queueing unheld files failed', orphans.error.code);
  const queued = typeof orphans.data === 'number' ? orphans.data : 0;

  const due = await service.rpc('finance_receipt_deletions_due', { p_limit: limit });
  if (due.error) {
    console.error('receipt cleanup: read failed', due.error.code);
    return { queued, removed: 0, failed: true };
  }
  const paths = Array.isArray(due.data) ? due.data.filter((p): p is string => typeof p === 'string') : [];
  if (paths.length === 0) return { queued, removed: 0, failed };

  const tried: string[] = [];
  for (const path of paths) {
    if (now() - started > budgetMs) {
      failed = true;
      break;
    }
    const still = await service.rpc('finance_receipt_deletion_queued', { p_path: path });
    if (still.error) {
      console.error('receipt cleanup: re-check failed', still.error.code);
      failed = true;
      continue;
    }
    // Taken off the list since it was read (the delete action got there first): not ours to touch.
    if (still.data !== true) continue;
    if (!(await removeOne(service, path))) failed = true;
    tried.push(path);
  }
  if (tried.length === 0) return { queued, removed: 0, failed };

  const done = await service.rpc('finance_receipt_deletions_done', { p_paths: tried });
  if (done.error) {
    console.error('receipt cleanup: mark done failed', done.error.code);
    return { queued, removed: 0, failed: true };
  }
  const removed = typeof done.data === 'number' ? done.data : 0;
  return { queued, removed, failed: failed || removed < tried.length };
}
