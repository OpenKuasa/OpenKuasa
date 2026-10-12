/**
 * The app's write path for documents. Every change is one call to a database function (`hr_add_document`,
 * `hr_replace_document_file`, ...): the table takes no direct writes, and the functions decide who may do what.
 * This file only checks the shape of an input, makes the call and turns a refusal into a sentence.
 *
 * A refusal arrives as a Postgres error whose message is a bare code, for example `DOC_BAD_FILE`. The acting user
 * is the session's. The workspace is the context's (never the input's); the employee comes from the input only for
 * the owner and admin actions, and from the viewer for an employee's own. A file's path is checked here to be of
 * the exact shape and inside the workspace's (and, on an add, the employee's) folder before the database is asked.
 *
 * Nothing typed (a title, a file's name) and no path is ever logged: only the database's code and the function's
 * name. The replies of a replace and a remove carry a storage path for the caller to remove; it must stay on the
 * server (the actions strip it).
 */
import { z } from 'zod';
import { type CapResult, type PeopleWriteContext, refuse, writeFailed } from './capabilities';
import { isDocumentPath, isDocumentPathShape, DOCUMENT_FILE_TYPES, DOCUMENT_MAX_BYTES } from './document-files';
import { DOCUMENT_REFUSALS } from './documents-refusals';
import { isRealDate } from './dates';
import { blank } from './loose-input';
import { type Row, isRow, parse, text } from './performance-rpc';
import { DOCUMENT_TYPES, type DocumentType } from './types';

export { DOCUMENT_REFUSALS };

type DbError = { code?: string; message?: string } | null | undefined;

/** The whole message when it is one bare upper-case code, else null. A message that merely mentions a code is not a refusal. */
const bareCode = (message: string | undefined): string | null => /^[A-Z][A-Z_]+$/.exec(message ?? '')?.[0] ?? null;

/** A known code is answered with its sentence; anything else is logged (the code only) and answered generically. */
export function failed(fn: string, error: DbError): CapResult<never> {
  const code = bareCode(error?.message);
  if (code && Object.hasOwn(DOCUMENT_REFUSALS, code)) return refuse(DOCUMENT_REFUSALS[code]);
  return writeFailed(fn, { code: error?.code });
}

/** One database function. `pick` shapes its reply, or returns null for a reply that is not what was promised. */
export async function callDb<T>(
  ctx: PeopleWriteContext,
  fn: string,
  rpc: string,
  args: Row,
  pick: (row: Row) => T | null,
): Promise<CapResult<T>> {
  const { data, error } = await ctx.client.rpc(rpc, args);
  if (error) return failed(fn, error);
  const picked = isRow(data) ? pick(data) : null;
  if (picked === null) return writeFailed(fn, { message: 'unexpected reply' });
  return { ok: true, data: picked };
}

// ---- Inputs ------------------------------------------------------------------

/** Any Postgres uuid: `.uuid()` would refuse ids that are valid but not RFC-versioned. */
export const id = (what: string) => z.guid(`That ${what} id was not valid.`);

const title = z.string().trim().min(1, 'Give the document a title.').max(200, 'Keep the title to 200 characters.');
const docType = z.enum(DOCUMENT_TYPES, 'Choose a type from the list.');
const expiry = z
  .preprocess(
    (value) => (typeof value === 'string' ? blank(value) : value),
    z
      .string()
      .refine((date) => isRealDate(date) && date >= '2000-01-01' && date <= '2100-12-31', 'Enter a real expiry date between 2000 and 2100.')
      .nullable(),
  )
  .optional();

const BAD_FILE = DOCUMENT_REFUSALS.DOC_BAD_FILE;
const filePath = z.string(BAD_FILE).refine(isDocumentPathShape, BAD_FILE);
const fileName = z
  .string(BAD_FILE)
  .transform((value) => value.trim())
  .refine((value) => value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f\u007f/\\]/.test(value), BAD_FILE);
const fileSize = z
  .number(BAD_FILE)
  .int(BAD_FILE)
  .min(1, BAD_FILE)
  .max(DOCUMENT_MAX_BYTES, BAD_FILE);
const fileType = z.string(BAD_FILE).refine((value) => Object.hasOwn(DOCUMENT_FILE_TYPES, value), BAD_FILE);
const fileFields = { file_path: filePath, file_name: fileName, file_size: fileSize, file_type: fileType };

export const addDocumentInput = z.object({
  employee_id: id('employee'),
  title,
  doc_type: docType,
  expires_on: expiry,
  ...fileFields,
});
export const updateDocumentInput = z.object({ document_id: id('document'), title, doc_type: docType, expires_on: expiry });
export const replaceDocumentFileInput = z.object({ document_id: id('document'), ...fileFields });
export const documentIdInput = z.object({ document_id: id('document') });
export const requestDocumentAckInput = z.object({
  document_id: id('document'),
  // Required: a missing flag is refused, never read as true or false.
  requested: z.boolean('Say whether to ask for an acknowledgement.'),
});

// ---- Replies -----------------------------------------------------------------

/** A document as the database returns it. There is never a path in it. */
export type SavedDocument = {
  id: string;
  employee_id: string;
  title: string;
  doc_type: DocumentType;
  expires_on: string | null;
  file_name: string | null;
  file_size: number | null;
  file_type: string | null;
  source: 'hr' | 'employee';
  ack_requested: boolean;
  acknowledged_at: string | null;
  created_at: string;
};

const textOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' ? value : undefined;

export function documentOf(row: Row): SavedDocument | null {
  const { id: docId, employee_id, title: name, doc_type, source, ack_requested, created_at } = row;
  const expires_on = textOrNull(row.expires_on);
  const file_name = textOrNull(row.file_name);
  const file_type = textOrNull(row.file_type);
  const acknowledged_at = textOrNull(row.acknowledged_at);
  const file_size = row.file_size === null ? null : typeof row.file_size === 'number' ? row.file_size : undefined;
  if (
    typeof docId !== 'string' ||
    typeof employee_id !== 'string' ||
    typeof name !== 'string' ||
    typeof doc_type !== 'string' ||
    !(DOCUMENT_TYPES as readonly string[]).includes(doc_type) ||
    (source !== 'hr' && source !== 'employee') ||
    typeof ack_requested !== 'boolean' ||
    typeof created_at !== 'string' ||
    expires_on === undefined ||
    file_name === undefined ||
    file_type === undefined ||
    acknowledged_at === undefined ||
    file_size === undefined
  ) {
    return null;
  }
  return {
    id: docId,
    employee_id,
    title: name,
    doc_type: doc_type as DocumentType,
    expires_on,
    file_name,
    file_size,
    file_type,
    source,
    ack_requested,
    acknowledged_at,
    created_at,
  };
}

// ---- Actions on a document ---------------------------------------------------------

/** Adds a document with its already-uploaded file. An employee adds to their own record only (the caller supplies the id). */
export async function addDocument(ctx: PeopleWriteContext, input: unknown): Promise<CapResult<SavedDocument>> {
  const parsed = parse(addDocumentInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  // The path must be this workspace's and this employee's before the database is asked (it checks too).
  if (!isDocumentPath(v.file_path, ctx.orgId, v.employee_id)) return refuse(BAD_FILE);
  return callDb(ctx, 'addDocument', 'hr_add_document', {
    p_employee: v.employee_id,
    p_title: v.title,
    p_doc_type: v.doc_type,
    p_expires_on: v.expires_on ?? null,
    p_file_path: v.file_path,
    p_file_name: v.file_name,
    p_file_size: v.file_size,
    p_file_type: v.file_type,
  }, documentOf);
}

export async function updateDocument(ctx: PeopleWriteContext, input: unknown): Promise<CapResult<SavedDocument>> {
  const parsed = parse(updateDocumentInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return callDb(ctx, 'updateDocument', 'hr_update_document', {
    p_document: v.document_id,
    p_title: v.title,
    p_doc_type: v.doc_type,
    p_expires_on: v.expires_on ?? null,
  }, documentOf);
}

/** Swaps the file. `old_path` is the file it replaced (null when the row had none): the caller removes it, best effort. */
export async function replaceDocumentFile(
  ctx: PeopleWriteContext,
  input: unknown,
): Promise<CapResult<{ document: SavedDocument; old_path: string | null }>> {
  const parsed = parse(replaceDocumentFileInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  if (!v.file_path.startsWith(`${ctx.orgId.toLowerCase()}/`)) return refuse(BAD_FILE);
  return callDb(ctx, 'replaceDocumentFile', 'hr_replace_document_file', {
    p_document: v.document_id,
    p_file_path: v.file_path,
    p_file_name: v.file_name,
    p_file_size: v.file_size,
    p_file_type: v.file_type,
  }, (row) => {
    const document = isRow(row.document) ? documentOf(row.document) : null;
    const old = row.old_path === null ? null : text(row.old_path);
    if (!document || (row.old_path !== null && old === null)) return null;
    return { document, old_path: old };
  });
}

/** Deletes a document. `path` is its file (null when it had none): the caller removes it, best effort. */
export async function removeDocument(
  ctx: PeopleWriteContext,
  input: unknown,
): Promise<CapResult<{ id: string; employee_id: string; path: string | null }>> {
  const parsed = parse(documentIdInput, input);
  if (!parsed.ok) return parsed;
  return callDb(ctx, 'removeDocument', 'hr_remove_document', { p_document: parsed.data.document_id }, (row) => {
    const docId = text(row.id);
    const employee = text(row.employee_id);
    const path = row.path === null ? null : text(row.path);
    if (!docId || !employee || (row.path !== null && path === null)) return null;
    return { id: docId, employee_id: employee, path };
  });
}

/** Asks the employee to acknowledge a document an owner or admin added, or withdraws the request. */
export async function requestDocumentAck(ctx: PeopleWriteContext, input: unknown): Promise<CapResult<SavedDocument>> {
  const parsed = parse(requestDocumentAckInput, input);
  if (!parsed.ok) return parsed;
  return callDb(ctx, 'requestDocumentAck', 'hr_request_document_ack', {
    p_document: parsed.data.document_id,
    p_requested: parsed.data.requested,
  }, documentOf);
}

/** The employee's own acknowledgement. The employee is the session's: the database records it for no one else. */
export async function acknowledgeDocument(ctx: PeopleWriteContext, input: unknown): Promise<CapResult<SavedDocument>> {
  const parsed = parse(documentIdInput, input);
  if (!parsed.ok) return parsed;
  return callDb(ctx, 'acknowledgeDocument', 'hr_acknowledge_document', { p_document: parsed.data.document_id }, documentOf);
}
