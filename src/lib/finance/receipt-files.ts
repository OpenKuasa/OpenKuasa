/**
 * Receipts Inbox: everything that is decided about a file before and while it
 * is uploaded. What a file really is (read from its first bytes, never from
 * its name or from what the device says), where it is stored, the name that
 * is kept to show, what an upload's refusal means, and the state of the
 * upload queue. Pure, with no server imports: the browser runs these before
 * an upload and the server runs the same ones again before it opens a file.
 */
import { INBOX_RECEIPT_MAX_BYTES, INBOX_RECEIPT_TYPES, type InboxReceiptType } from './receipts';

export const RECEIPT_FILE_MESSAGES = {
  wrongType: 'That is not a JPG, PNG, PDF or HEIC file. A receipt is a photo or a PDF.',
  empty: 'That file is empty.',
  tooBig: 'That file is larger than 10 MB. Choose a smaller one, or take the photo at a lower quality.',
  unreadable: 'That file could not be read from your device. Choose it again.',
  // Storage refused the upload under the bucket's rule: the workspace is out of room, or the person may no longer write.
  refused:
    'The upload was refused. Your workspace may have used its 1 GB for receipts, or you may no longer be allowed to add files here. Reload the page and try again.',
  // Saving a file from a short link to the person's device failed.
  downloadFailed: 'The file could not be downloaded. Please try again.',
  network: 'The upload did not finish. Check your connection and try again.',
  // The file is in the bucket and the inbox does not have it yet.
  notSaved: 'The file was uploaded, but it could not be added to the inbox. Try again: nothing needs to be uploaded twice.',
} as const;

/** A pick that did not all fit: how many were left out, and that they can be added once these are done. */
export function tooManyLeftOut(left: number): string {
  const these = left === 1 ? 'file was' : 'files were';
  return `Twenty files can wait at once. ${left} ${these} left out. Add ${left === 1 ? 'it' : 'them'} when these have finished.`;
}

const M = RECEIPT_FILE_MESSAGES;

/** How much of a file is read to tell what it is: enough for an `ftyp` box with a dozen brands. */
export const RECEIPT_SNIFF_BYTES = 64;

const startsWith = (bytes: Uint8Array, magic: number[], at = 0): boolean =>
  bytes.length >= at + magic.length && magic.every((byte, i) => bytes[at + i] === byte);

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// %PDF-
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
// ftyp, at byte 4 of an ISO base media file
const FTYP = [0x66, 0x74, 0x79, 0x70];

/** Brands of a still picture coded with HEVC (ISO/IEC 23008-12): stored as `image/heic`. */
const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx'];
/** The format's own brands, which say nothing about the coding: stored as `image/heif` unless a HEIC brand is listed too. */
const HEIF_BRANDS = ['mif1', 'msf1'];
/** The same container holding AV1: an AVIF, which is not one of the five types. */
const AVIF_BRANDS = ['avif', 'avis'];

/** The four-letter brands of an `ftyp` box: the major brand first, then the compatible ones that fit in `bytes`. */
function ftypBrands(bytes: Uint8Array): string[] {
  if (!startsWith(bytes, FTYP, 4) || bytes.length < 12) return [];
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.length, boxSize >= 16 ? boxSize : bytes.length);
  const brand = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  const brands = [brand(8)];
  // Bytes 12 to 16 are the minor version.
  for (let at = 16; at + 4 <= end; at += 4) brands.push(brand(at));
  return brands;
}

/**
 * What a file is, read from its first bytes: one of the five types, or null.
 * The name and the type the device reports are never asked. Give it the
 * first `RECEIPT_SNIFF_BYTES` bytes; fewer is fine for a JPG, PNG or PDF.
 */
export function sniffReceiptType(bytes: Uint8Array): InboxReceiptType | null {
  if (startsWith(bytes, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(bytes, PNG_MAGIC)) return 'image/png';
  if (startsWith(bytes, PDF_MAGIC)) return 'application/pdf';
  const brands = ftypBrands(bytes);
  if (brands.length === 0 || brands.some((b) => AVIF_BRANDS.includes(b))) return null;
  if (HEIC_BRANDS.includes(brands[0])) return 'image/heic';
  if (HEIF_BRANDS.includes(brands[0])) return brands.some((b) => HEIC_BRANDS.includes(b)) ? 'image/heic' : 'image/heif';
  return null;
}

/** A HEIC or HEIF: the two types the browser tries to turn into a JPG, and the two that are never previewed. */
export function isHeif(type: InboxReceiptType): boolean {
  return type === 'image/heic' || type === 'image/heif';
}

/** The types a preview is drawn for. A PDF and a stored HEIC are downloads only. */
export function canPreview(type: InboxReceiptType): boolean {
  return type === 'image/jpeg' || type === 'image/png';
}

/** Why a file of this size cannot be a receipt, as a sentence, or null. */
export function receiptSizeProblem(size: number): string | null {
  if (!(size > 0)) return M.empty;
  if (size > INBOX_RECEIPT_MAX_BYTES) return M.tooBig;
  return null;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EXTENSIONS = Object.values(INBOX_RECEIPT_TYPES).join('|');
/** Exactly what the bucket's upload rule and the table's check allow: `<workspace uuid>/<uuid>.<one of five>`, lower case. */
const INBOX_RECEIPT_PATH = new RegExp(`^(${UUID})/${UUID}\\.(${EXTENSIONS})$`);

/** `<workspace id>/<random uuid>.<ext>`. The uuid is made here, by whoever uploads; the name of the file is never in it. */
export function inboxReceiptPath(orgId: string, type: InboxReceiptType, uuid: string = crypto.randomUUID()): string {
  return `${orgId.toLowerCase()}/${uuid.toLowerCase()}.${INBOX_RECEIPT_TYPES[type]}`;
}

/** True for a path of exactly that shape, in that workspace's folder. */
export function isInboxReceiptPath(path: string, orgId: string): boolean {
  const match = INBOX_RECEIPT_PATH.exec(path);
  return match !== null && match[1] === orgId.toLowerCase();
}

/** The type a stored path's extension names, or null. The database works it out the same way. */
export function typeOfReceiptPath(path: string): InboxReceiptType | null {
  const extension = INBOX_RECEIPT_PATH.exec(path)?.[2];
  const found = Object.entries(INBOX_RECEIPT_TYPES).find(([, ext]) => ext === extension);
  return found ? (found[0] as InboxReceiptType) : null;
}

export const RECEIPT_NAME_MAX = 200;
// Control characters, the marks that reorder text (which can make a name read as another one), and the
// invisible ones: U+061C, U+200B to U+200F, U+202A to U+202E, U+2066 to U+2069.
const UNSAFE_NAME_CHARS = /[\p{Cc}\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** Text a person typed, without control, direction or zero-width characters, one space between words, trimmed. */
export function cleanTypedText(text: string): string {
  return text.replace(UNSAFE_NAME_CHARS, '').replace(/\s+/g, ' ').trim();
}

/**
 * The name kept to show for a file: what the device called it, without any
 * folder, control character or text-reordering mark, at most 200 characters,
 * and never empty. It is text to draw and nothing else: it is never part of a
 * path or a link.
 */
export function cleanFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const clean = cleanTypedText(base);
  // By character, not by UTF-16 unit: half an emoji is not valid text.
  return Array.from(clean).slice(0, RECEIPT_NAME_MAX).join('') || 'receipt';
}

/** The name of the JPG a HEIC or HEIF was turned into: the same name with `.jpg` (never `.jpg.jpg`). */
export function jpgFileName(name: string): string {
  const clean = cleanFileName(name);
  const stem = clean.replace(/\.(heic|heif|jpe?g|png|pdf)$/i, '');
  return `${Array.from(stem).slice(0, RECEIPT_NAME_MAX - 4).join('') || 'receipt'}.jpg`;
}

/** The name a downloaded receipt is saved under: ours, never the person's. */
export function receiptDownloadName(type: InboxReceiptType): string {
  return `receipt.${INBOX_RECEIPT_TYPES[type]}`;
}

/**
 * What storage's refusal of an upload means, as a sentence. Storage answers
 * with a status of its own (`statusCode`, sometimes inside a 400), so both
 * are read. No status at all is a request that never got an answer.
 */
export function uploadFailure(error: { status?: unknown; statusCode?: unknown } | null | undefined): string {
  const codes = [Number(error?.statusCode), Number(error?.status)];
  if (codes.includes(413)) return M.tooBig;
  if (codes.includes(415)) return M.wrongType;
  if (codes.includes(401) || codes.includes(403)) return M.refused;
  return M.network;
}

/* ---- the upload queue --------------------------------------------------- */

/** How many files may wait or run at once. */
export const UPLOAD_QUEUE_MAX = 20;
/**
 * A stored file may be recorded for 30 minutes (the database's rule). After 25
 * the retry uploads it again instead: a save that would be refused is not tried.
 */
export const RECORD_WINDOW_MS = 25 * 60 * 1000;

export type UploadStep = 'waiting' | 'checking' | 'converting' | 'uploading' | 'saving' | 'done' | 'failed';

export const UPLOAD_STEP_LABELS: Record<UploadStep, string> = {
  waiting: 'Waiting',
  checking: 'Checking',
  converting: 'Converting to JPG',
  uploading: 'Uploading',
  saving: 'Adding to the inbox',
  done: 'Added',
  failed: 'Not added',
};

export type UploadItem = {
  /** Made by the queue; a file's name is not unique. */
  key: string;
  /** The cleaned name, as it will be shown. */
  name: string;
  size: number;
  step: UploadStep;
  error: string | null;
  /** Set once the file is in the bucket: a retry then records this path and uploads nothing. */
  path: string | null;
  /** When it was stored, in milliseconds. */
  storedAt: number | null;
};

/** Adds picked files to the queue, up to the cap; a failed file does not count toward it. `refused` is how many did not fit. */
export function queueAdd(
  items: UploadItem[],
  picked: { key: string; name: string; size: number }[],
): { items: UploadItem[]; refused: number } {
  const open = items.filter((i) => i.step !== 'done' && i.step !== 'failed').length;
  const room = Math.max(0, UPLOAD_QUEUE_MAX - open);
  const taken = picked.slice(0, room);
  return {
    items: [
      ...items,
      ...taken.map((p) => ({ key: p.key, name: cleanFileName(p.name), size: p.size, step: 'waiting' as const, error: null, path: null, storedAt: null })),
    ],
    refused: picked.length - taken.length,
  };
}

/** One item changed; the rest as they were. */
export function queueSet(items: UploadItem[], key: string, patch: Partial<Omit<UploadItem, 'key'>>): UploadItem[] {
  return items.map((i) => (i.key === key ? { ...i, ...patch } : i));
}

/** The next file to work on: the first one waiting. One runs at a time. */
export function queueNext(items: UploadItem[]): UploadItem | null {
  if (queueBusy(items)) return null;
  return items.find((i) => i.step === 'waiting') ?? null;
}

/** Whether a file is being checked, converted, uploaded or saved right now. */
export function queueBusy(items: UploadItem[]): boolean {
  return items.some((i) => i.step === 'checking' || i.step === 'converting' || i.step === 'uploading' || i.step === 'saving');
}

/** The queue without the files that are in the inbox now. */
export function queueWithoutDone(items: UploadItem[]): UploadItem[] {
  return items.filter((i) => i.step !== 'done');
}

/** "2 of 3 added", "3 added", "1 of 3 added · 1 not added". Empty when the queue is. */
export function queueSummary(items: UploadItem[]): string {
  if (items.length === 0) return '';
  const done = items.filter((i) => i.step === 'done').length;
  const failed = items.filter((i) => i.step === 'failed').length;
  const head = done === items.length ? `${done} added` : `${done} of ${items.length} added`;
  return failed ? `${head} · ${failed} not added` : head;
}

/**
 * What "Try again" does for a failed file: `save` records the file that is
 * already in the bucket, while the database would still take it; `upload`
 * starts over under a new name. A file left behind by a restart is removed by
 * the clean-up run an hour after it was uploaded.
 */
export function retryPlan(item: UploadItem, now: number): 'save' | 'upload' {
  return item.path !== null && item.storedAt !== null && now - item.storedAt < RECORD_WINDOW_MS ? 'save' : 'upload';
}
