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

/** What a file name's extension says the type is, for a browser that reports none (HEIC is the usual case). */
const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heic',
  pdf: 'application/pdf',
};

/**
 * The type to judge and to send to storage. A real type is kept as it is (an extension never overrides it);
 * only an empty type or `application/octet-stream` is worked out from the file name's extension, and an
 * unknown extension leaves the type as it was, which then fails the check.
 */
export function receiptMediaType(file: { type: string; name?: string }): string {
  // HEIF is HEIC for our purposes (and for the bucket, which has no image/heif); the `.heif` extension agrees.
  if (file.type.trim().toLowerCase() === 'image/heif') return 'image/heic';
  if (file.type !== '' && file.type !== 'application/octet-stream') return file.type;
  const dot = file.name ? file.name.lastIndexOf('.') : -1;
  if (!file.name || dot < 0) return file.type;
  const extension = file.name.slice(dot + 1).trim().toLowerCase();
  return Object.hasOwn(EXTENSION_TYPES, extension) ? EXTENSION_TYPES[extension] : file.type;
}

/** Why a file cannot be a receipt, as a sentence, or null when it can. Checked in the browser and again on the server. */
export function receiptProblem(file: { type: string; size: number; name?: string }): string | null {
  if (!Object.hasOwn(RECEIPT_TYPES, receiptMediaType(file))) return WRONG_TYPE;
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
 * `fileName` is only used to work out the type when the browser gave none.
 * A file that is uploaded and never attached is removed by the caller (`discardReceiptAction`, or `removeReceipt`
 * in the chat tool): nobody but the service client can delete from the bucket.
 */
export async function uploadReceipt(
  client: SupabaseClient,
  userId: string,
  body: Blob | ArrayBuffer | Buffer,
  mediaType: string,
  fileName?: string,
): Promise<CapResult<{ path: string }>> {
  const type = receiptMediaType({ type: mediaType, name: fileName });
  const problem = receiptProblem({ type, size: 'size' in body ? body.size : body.byteLength });
  if (problem) return refuse(problem);
  const path = receiptPath(userId, type);
  try {
    const { error } = await client.storage.from(RECEIPT_BUCKET).upload(path, body, { contentType: type, upsert: false });
    if (!error) return { ok: true, data: { path } };
  } catch {
    // Reported the same way as a refused upload.
  }
  console.error('[people/receipts] a receipt could not be uploaded.');
  return refuse(UPLOAD_FAILED);
}

// ---- Which file is the receipt -----------------------------------------------------
//
// ONE rule, used by the server (which file the claim tool uploads) and by the approval card (what it says about
// the receipt), so the two can never disagree about the same message. Client-safe: no storage, no Buffer.

/** What a claim's question carried: a usable receipt, nothing that could be one, or a file that was refused (and why). */
export type ReceiptState = { state: 'attached' } | { state: 'none' } | { state: 'unusable'; problem: string };

export type ReceiptPick = { state: 'attached'; index: number } | { state: 'none' } | { state: 'unusable'; problem: string };

const mediaTypeOf = (value: string): string => value.split(';')[0].trim().toLowerCase();
/** A part's media type, lowercased and without parameters; an empty or generic one is worked out from its file name. */
export const resolvedTypeOf = (part: { mediaType: string; filename?: string }): string =>
  receiptMediaType({ type: mediaTypeOf(part.mediaType), name: part.filename });
const couldBeReceipt = (mediaType: string): boolean => mediaType.startsWith('image/') || mediaType === 'application/pdf';

/**
 * The decoded size of a base64 data URL, 0 for any other data URL (unreadable here), and null for a link (a stored
 * file: its size is not known until the server fetches it).
 */
export function dataUrlSize(url: string): number | null {
  if (!url.startsWith('data:')) return null;
  const match = /^data:[^,]*;base64,([\s\S]*)$/.exec(url);
  if (!match) return 0;
  const body = match[1];
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

/**
 * Among a question's file parts, the first USABLE image or PDF (type and size through {@link receiptProblem}), not
 * merely the first. A link's size is unknown here, so it is judged on its type alone. If there are images or PDFs
 * and none is usable, the first one's reason is returned.
 */
export function pickReceipt(parts: { mediaType: string; url: string; filename?: string }[]): ReceiptPick {
  let first: string | null = null;
  for (let index = 0; index < parts.length; index += 1) {
    const type = resolvedTypeOf(parts[index]);
    if (!couldBeReceipt(type)) continue;
    const size = dataUrlSize(parts[index].url);
    const problem = receiptProblem({ type, size: size ?? 1 });
    if (!problem) return { state: 'attached', index };
    first ??= problem;
  }
  return first === null ? { state: 'none' } : { state: 'unusable', problem: first };
}

/** The nearest user message before `index`: the question a claim proposed at `index` was answering. */
export function userMessageBefore<T extends { role: string }>(messages: T[], index: number): T | null {
  for (let i = index - 1; i >= 0; i -= 1) if (messages[i].role === 'user') return messages[i];
  return null;
}
