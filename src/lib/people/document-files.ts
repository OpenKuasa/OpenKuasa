/**
 * Document files. They live in a private storage bucket whose read rule goes through the document (see the
 * documents migration); this file is the client-safe half: what is allowed, what a path looks like, how a file is
 * described to the database, and how it is uploaded (with the browser's client, as the signed-in user). Signing a
 * link and removing a file need the server, so that lives in `document-files-server.ts`.
 *
 * Nothing here logs a file name or a storage path.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { type CapResult, refuse } from './capabilities';
import type { Converted } from './document-forms';
import { receiptMediaType } from './receipts';

export const DOCUMENT_BUCKET = 'hr-documents';
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** The media types the bucket accepts, and the extension each is stored with. */
export const DOCUMENT_FILE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

export const TOO_BIG = 'That file is larger than 10 MB.';
export const WRONG_TYPE = 'Use a PDF or an image (JPEG, PNG, WebP or HEIC).';
export const UPLOAD_FAILED = 'The upload did not finish. Try again.';
/** Not one of the three sentences the spec gives: an empty file is neither too big nor the wrong type. */
export const EMPTY_FILE = 'That file is empty.';

const FILE_NAME_MAX = 200;

/**
 * The type to judge, upload with and declare to the database: ONE value for all three. A real type is kept
 * (lower-cased); an empty type or `application/octet-stream` is worked out from the file name's extension (a
 * browser may report none for `.heic`), and `image/heif` is `image/heic`, which is all the bucket has.
 */
export function documentMediaType(file: { type: string; name?: string }): string {
  return receiptMediaType({ type: file.type.trim().toLowerCase(), name: file.name });
}

/** The file when it can be a document, else the sentence to show. Size and type only; checked again by the database. */
export function pickDocumentFile(file: File): Converted<File> {
  if (!Object.hasOwn(DOCUMENT_FILE_TYPES, documentMediaType(file))) return { ok: false, error: WRONG_TYPE };
  if (!(file.size > 0)) return { ok: false, error: EMPTY_FILE };
  if (file.size > DOCUMENT_MAX_BYTES) return { ok: false, error: TOO_BIG };
  return { ok: true, input: file };
}

const clean = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[/\\]/g, '-').trim();

/**
 * The file's name as the database accepts it: no control character, `/` or `\`, 1 to 200 characters. A long
 * name is cut before its extension; a name with nothing left becomes `document.<ext>`.
 */
export function documentFileName(file: { type: string; name?: string }): string {
  const ext = DOCUMENT_FILE_TYPES[documentMediaType(file)] ?? 'file';
  const name = clean(file.name ?? '');
  if (name === '' || /^\.+$/.test(name)) return `document.${ext}`;
  if (name.length <= FILE_NAME_MAX) return name;
  const dot = name.lastIndexOf('.');
  const tail = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  return clean(name.slice(0, FILE_NAME_MAX - tail.length)) + tail;
}

/**
 * What to tell the database about a file (`hr_add_document`, `hr_replace_document_file`): the size is the file's
 * real byte length and the type is the very one it is uploaded with, because the database compares both with
 * what storage recorded.
 */
export function documentFileFacts(file: File): { file_name: string; file_size: number; file_type: string } {
  return { file_name: documentFileName(file), file_size: file.size, file_type: documentMediaType(file) };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EXTENSIONS = [...new Set(Object.values(DOCUMENT_FILE_TYPES))].join('|');
/** Exactly what `documentPath` makes, and what the database accepts: `<org>/<employee>/<uuid>.<ext>`, lower case. */
export const DOCUMENT_PATH = new RegExp(`^${UUID}/${UUID}/${UUID}\\.(${EXTENSIONS})$`);

/** True for a path of exactly the shape `documentPath` makes, whatever workspace and employee it names. */
export const isDocumentPathShape = (path: string): boolean => DOCUMENT_PATH.test(path);

/** `<org>/<employee>/<random uuid>.<ext>`, lower case. Throws for a file that is not an allowed type. */
export function documentPath(orgId: string, employeeId: string, file: File): string {
  const type = documentMediaType(file);
  if (!Object.hasOwn(DOCUMENT_FILE_TYPES, type)) throw new Error('Not a document type.');
  return `${orgId.toLowerCase()}/${employeeId.toLowerCase()}/${crypto.randomUUID()}.${DOCUMENT_FILE_TYPES[type]}`;
}

/** True when `path` has the exact shape and sits in this workspace's folder, in this employee's folder. */
export function isDocumentPath(path: string, orgId: string, employeeId: string): boolean {
  if (!isDocumentPathShape(path)) return false;
  const [org, employee] = path.split('/');
  return org === orgId.toLowerCase() && employee === employeeId.toLowerCase();
}

/**
 * Uploads a file to `path` (made by {@link documentPath}) as the signed-in user, with the type
 * {@link documentFileFacts} will declare. The size, type and path shape are checked first, so the rule holds even
 * if a screen skipped it. The caller then attaches the path to a document; if that is refused (or the person
 * cancels) the file is left unattached: the add and replace actions release and remove it on a refusal (nobody but the
 * service client can delete from the bucket), and the sweep script clears what is left.
 */
export async function uploadDocumentFile(client: SupabaseClient, path: string, file: File): Promise<CapResult<{ path: string }>> {
  const picked = pickDocumentFile(file);
  if (!picked.ok) return refuse(picked.error);
  if (!isDocumentPathShape(path)) return refuse(UPLOAD_FAILED);
  try {
    // storage-js ignores `contentType` for a File/Blob body and records the body's own `.type`, so the body must
    // carry the very type that is later declared to the database (which compares the two).
    const type = documentMediaType(file);
    const body = new File([file], file.name, { type });
    const { error } = await client.storage.from(DOCUMENT_BUCKET).upload(path, body, { contentType: type, upsert: false });
    if (!error) return { ok: true, data: { path } };
  } catch {
    // Reported the same way as a refused upload.
  }
  console.error('[people/documents] a file could not be uploaded.');
  return refuse(UPLOAD_FAILED);
}
