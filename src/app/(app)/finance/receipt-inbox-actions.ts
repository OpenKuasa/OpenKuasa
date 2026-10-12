'use server';

import { revalidatePath } from 'next/cache';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { canPreview } from '@/lib/finance/receipt-files';
import { removeReleasedReceiptFile, storedFileCheck } from '@/lib/finance/receipt-files-server';
import {
  RECEIPT_INBOX_MESSAGES,
  type ReceiptLink,
  deleteInboxReceipt,
  getReceiptFile,
  receiptIdInput,
  registerReceipt,
  registerReceiptInput,
  reviewReceipt,
  reviewReceiptInput,
  signReceiptLink,
} from '@/lib/finance/receipt-inbox';
import { type FinResult, type FinanceWriteContext, NOT_ALLOWED } from '@/lib/finance/result';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';

/**
 * The Receipts Inbox's server actions. They are in a file of their own, not
 * in `actions.ts`, because two of them are not the usual guard → parse →
 * write: opening a file reads and signs, and deleting a receipt is followed
 * by removing its file with the service client. The guard is the same one:
 * a viewer and the demo workspace change nothing.
 *
 * No file passes through here. The browser uploads straight to the private
 * bucket; `registerReceiptAction` is told only where the file is.
 */

const FORBIDDEN: FinResult<never> = { ok: false, error: NOT_ALLOWED };
// Only the inbox shows a receipt until one can be matched; then the expense and bill screens join this list.
const RECEIPT_INBOX_PATHS = ['/finance/receipts-inbox'];

/** A write context, or null when the viewer may not change this workspace's data. */
async function writeCtx(): Promise<FinanceWriteContext | null> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'edit-data')) return null;
  return { client: await createClient(), orgId: viewer.orgId };
}

function refresh() {
  for (const path of RECEIPT_INBOX_PATHS) revalidatePath(path);
}

function firstMessage(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? 'That input was not valid.';
}

/** Records a file the browser has just uploaded as a receipt in "To review". */
export async function registerReceiptAction(input: unknown): Promise<FinResult<{ id: string }>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = registerReceiptInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await registerReceipt(ctx, parsed.data);
  refresh();
  return result;
}

/** Saves the details a person typed; a receipt in review becomes unmatched. Anyone who may edit. */
export async function reviewReceiptAction(input: unknown): Promise<FinResult<{ id: string }>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = reviewReceiptInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await reviewReceipt(ctx, parsed.data);
  refresh();
  return result;
}

/**
 * Deletes a receipt that is tied to nothing, then removes its file at once.
 * The receipt is gone whether or not the file could be removed: the database
 * has the path on its list, and the clean-up run takes what is left.
 */
export async function deleteReceiptAction(input: unknown): Promise<FinResult<{ id: string }>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = receiptIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await deleteInboxReceipt(ctx, parsed.data);
  refresh();
  if (!result.ok) return result;
  if (result.data.file_path) {
    try {
      await removeReleasedReceiptFile(serviceClient(), result.data.file_path);
    } catch {
      // No service key on this server: the clean-up run removes the file.
      console.error('[finance/receipts] a deleted receipt’s file was left for the clean-up run.');
    }
  }
  // The path stays on the server.
  return { ok: true, data: { id: result.data.id } };
}

/**
 * A short link to a receipt's file, for anyone who can see the receipt
 * (viewers too: the bucket's read rule is membership). The path is read and
 * the link signed as the caller. Before the link is handed out the server
 * reads the file's first bytes: a file that is not what its receipt says is
 * not opened.
 */
export async function receiptLinkAction(input: unknown): Promise<FinResult<ReceiptLink>> {
  const viewer = await getViewer();
  const parsed = receiptIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const file = await getReceiptFile(ctx, parsed.data.id);
  if (!file.ok) return file;
  const link = await signReceiptLink(ctx, file.data);
  if (!link.ok) return link;
  const stored = await storedFileCheck(link.data.url, file.data.type);
  if (stored === 'unreadable') return { ok: false, error: RECEIPT_INBOX_MESSAGES.fileUnavailable };
  if (stored === 'mismatch') {
    console.error('[finance/receipts] a stored file is not the type its receipt says.');
    return { ok: false, error: RECEIPT_INBOX_MESSAGES.notWhatItSays };
  }
  return { ok: true, data: { url: link.data.url, type: file.data.type, preview: canPreview(file.data.type) } };
}
