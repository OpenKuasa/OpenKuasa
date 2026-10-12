'use client';

import {
  RECEIPT_FILE_MESSAGES,
  RECEIPT_SNIFF_BYTES,
  cleanFileName,
  inboxReceiptPath,
  isHeif,
  jpgFileName,
  receiptSizeProblem,
  sniffReceiptType,
  uploadFailure,
} from '@/lib/finance/receipt-files';
import { INBOX_RECEIPT_BUCKET, type InboxReceiptType } from '@/lib/finance/receipts';
import { createClient } from '@/lib/supabase/client';
import { heicToJpeg } from './receipt-heic';

/**
 * The browser's half of adding a receipt: check the file, turn a HEIC into a
 * JPG when the browser can, and put it straight into the private bucket as
 * the signed-in person, so the bucket's own rule decides. The file never goes
 * through the app's server. Nothing here logs a name or a path.
 */

const M = RECEIPT_FILE_MESSAGES;

/** The first bytes of a file or a blob, or null when the device would not read it. */
export async function headOf(blob: Blob): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await blob.slice(0, RECEIPT_SNIFF_BYTES).arrayBuffer());
  } catch {
    return null;
  }
}

export type PreparedReceipt = { body: Blob; type: InboxReceiptType; name: string };

/**
 * Decides what will be uploaded for a picked file, or why nothing will be.
 * The type is read from the file's first bytes: its name and the type the
 * device reports are not asked. A HEIC or HEIF becomes a JPG when it can be
 * converted and the JPG fits; otherwise the original goes up as it is.
 */
export async function prepareReceipt(
  file: File,
  onConverting: () => void,
): Promise<{ ok: true; data: PreparedReceipt } | { ok: false; error: string }> {
  const sizeProblem = receiptSizeProblem(file.size);
  if (sizeProblem) return { ok: false, error: sizeProblem };
  const head = await headOf(file);
  if (!head) return { ok: false, error: M.unreadable };
  const type = sniffReceiptType(head);
  if (!type) return { ok: false, error: M.wrongType };
  if (isHeif(type)) {
    onConverting();
    const jpg = await heicToJpeg(file);
    if (jpg && !receiptSizeProblem(jpg.size)) {
      const jpgHead = await headOf(jpg);
      if (jpgHead && sniffReceiptType(jpgHead) === 'image/jpeg') {
        return { ok: true, data: { body: jpg, type: 'image/jpeg', name: jpgFileName(file.name) } };
      }
    }
  }
  return { ok: true, data: { body: file, type, name: cleanFileName(file.name) } };
}

/**
 * Uploads into the workspace's folder under a new random name and answers
 * with the path. A plain upload, never an overwrite. The type sent is the
 * one read from the bytes, which is also the one the path's extension names:
 * the database refuses to record a file where the two disagree.
 */
export async function storeReceipt(
  orgId: string,
  prepared: PreparedReceipt,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const path = inboxReceiptPath(orgId, prepared.type);
  try {
    const { error } = await createClient()
      .storage.from(INBOX_RECEIPT_BUCKET)
      .upload(path, prepared.body, { contentType: prepared.type, upsert: false });
    if (!error) return { ok: true, path };
    return { ok: false, error: uploadFailure(error as { status?: unknown; statusCode?: unknown }) };
  } catch {
    return { ok: false, error: M.network };
  }
}

/**
 * The bytes behind a short link, as an object URL the page can draw, or null.
 * Used for the preview of a JPG or PNG: the browser fetches the file, checks
 * its first bytes are that image type, and draws its own copy. The page never
 * points an image or a frame at the stored file. Revoke the URL when done.
 */
export async function previewUrlOf(url: string, type: InboxReceiptType): Promise<string | null> {
  if (type !== 'image/jpeg' && type !== 'image/png') return null;
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sniffReceiptType(bytes.subarray(0, RECEIPT_SNIFF_BYTES)) !== type) return null;
    // The blob's type is the one just checked, never the one the store sent.
    return URL.createObjectURL(new Blob([bytes], { type }));
  } catch {
    return null;
  }
}

/** Starts the download of a short link. Storage serves it as an attachment, so the page stays where it is. */
export function startDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
