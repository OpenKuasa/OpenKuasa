/**
 * Receipt files for expense claims. They live in a private storage bucket whose
 * read rule goes through the claim (see the claims migration); this file is the
 * client-safe half: what is allowed, what a path looks like and how a file is
 * uploaded (with the browser's client or the server's, as the signed-in user).
 * Removing a file needs the service client, which cannot be imported where
 * the browser can reach it, so that lives in `receipts-server.ts`.
 *
 * Nothing here logs a file name or a storage path: a path begins with a user id.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { type CapResult, refuse } from './capabilities';

export const RECEIPT_BUCKET = 'hr-receipts';
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
/** The media types the bucket accepts, and the extension each is stored with. */
export const RECEIPT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

const WRONG_TYPE = 'Attach a photo (JPEG, PNG, WebP or HEIC) or a PDF.';
const EMPTY = 'That file is empty.';
const TOO_BIG = 'Keep the file to 5 MB or less.';
const UPLOAD_FAILED = 'That file could not be uploaded.';

/** Why a file cannot be a receipt, as a sentence, or null when it can. Checked in the browser and again on the server. */
export function receiptProblem(file: { type: string; size: number }): string | null {
  if (!Object.hasOwn(RECEIPT_TYPES, file.type)) return WRONG_TYPE;
  if (!(file.size > 0)) return EMPTY;
  if (file.size > RECEIPT_MAX_BYTES) return TOO_BIG;
  return null;
}

/** `<user id>/<random uuid>.<ext>`: the folder is the uploader's own, which is all the bucket lets them write to. */
export function receiptPath(userId: string, mediaType: string): string {
  if (!Object.hasOwn(RECEIPT_TYPES, mediaType)) throw new Error('Not a receipt type.');
  return `${userId}/${crypto.randomUUID()}.${RECEIPT_TYPES[mediaType]}`;
}

/**
 * Uploads a receipt into the signed-in user's own folder and returns its path, to be passed to the claim.
 * The type and size are checked first, so the server leg of the rule holds even if a browser skipped it.
 * A file that is uploaded and never attached stays where it is: nobody but the service client can delete from the bucket.
 */
export async function uploadReceipt(
  client: SupabaseClient,
  userId: string,
  body: Blob | ArrayBuffer | Buffer,
  mediaType: string,
): Promise<CapResult<{ path: string }>> {
  const problem = receiptProblem({ type: mediaType, size: 'size' in body ? body.size : body.byteLength });
  if (problem) return refuse(problem);
  const path = receiptPath(userId, mediaType);
  try {
    const { error } = await client.storage.from(RECEIPT_BUCKET).upload(path, body, { contentType: mediaType, upsert: false });
    if (!error) return { ok: true, data: { path } };
  } catch {
    // Reported the same way as a refused upload.
  }
  console.error('[people/receipts] a receipt could not be uploaded.');
  return refuse(UPLOAD_FAILED);
}
