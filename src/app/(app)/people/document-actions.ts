'use server';

import { z } from 'zod';
import { type CapResult, type PeopleWriteContext, refuse, writeOutcome } from '@/lib/people/capabilities';
import { isDocumentPathShape } from '@/lib/people/document-files';
import { documentLink, releaseDocumentFile, removeDocumentFile } from '@/lib/people/document-files-server';
import {
  acknowledgeDocument,
  addDocument,
  removeDocument,
  replaceDocumentFile,
  requestDocumentAck,
  updateDocument,
} from '@/lib/people/document-writes';
import { DOCUMENT_REFUSALS } from '@/lib/people/documents-refusals';
import { asAdmin, asMember, changed, refused, withoutEmployee } from './performance-guards';

// Every action passes its input to the write path, which validates it. The workspace is always the session's.
// A storage path never leaves the server: a replace or a remove removes the old file here and answers without it.

const SOURCE = 'document-actions';

/** The path in an input, when it is of the exact shape and in this workspace's folder; else null. */
function pathIn(input: unknown, orgId: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const path = (input as Record<string, unknown>).file_path;
  if (typeof path !== 'string' || !isDocumentPathShape(path) || !path.startsWith(`${orgId.toLowerCase()}/`)) return null;
  return path;
}

/**
 * A file was uploaded for an add or a replace. When the database DEFINITELY refused (not when the outcome is
 * unknown: the change may have gone through and the file with it), ask it whether the path can go and remove the
 * file only on its yes. Quiet: the person is told the refusal, not about the file.
 */
async function discardIfRefused(ctx: PeopleWriteContext, result: CapResult<unknown>, input: unknown): Promise<void> {
  if (writeOutcome(result) !== 'refused') return;
  const path = pathIn(input, ctx.orgId);
  if (path && (await releaseDocumentFile(ctx, path))) await removeDocumentFile(path);
}

// ---- The employee's own documents ---------------------------------------------------------
// The employee is the viewer's linked record, never a field of the input: a smuggled `employee_id` is dropped.
// The database also lets an employee change only their own, so a document id alone cannot reach a colleague's.

export async function addMyDocumentAction(input: unknown) {
  const guard = await asMember(SOURCE, true);
  if (refused(guard)) return guard;
  const sent = { ...withoutEmployee(input), employee_id: guard.employeeId! };
  const result = await addDocument(guard.ctx, sent);
  await discardIfRefused(guard.ctx, result, sent);
  return changed(result);
}

/** Removes an upload of the employee's own. Its file is removed after the database has let go of it. */
export async function removeMyDocumentAction(input: unknown) {
  const guard = await asMember(SOURCE, true);
  if (refused(guard)) return guard;
  const result = await removeDocument(guard.ctx, withoutEmployee(input));
  if (!result.ok) return result;
  if (result.data.path) await removeDocumentFile(result.data.path);
  return changed({ ok: true as const, data: { id: result.data.id, employee_id: result.data.employee_id } });
}

/** "I have read this": recorded for the viewer's own document only, by the database. */
export async function acknowledgeDocumentAction(input: unknown) {
  const guard = await asMember(SOURCE, true);
  if (refused(guard)) return guard;
  return changed(await acknowledgeDocument(guard.ctx, withoutEmployee(input)));
}

/**
 * A one-minute link to a document's file. It checks nothing itself: the link is made with the caller's own
 * session, so the document's row rule and storage's read rule decide. Only the link is returned.
 */
export async function documentLinkAction(input: unknown): Promise<CapResult<{ url: string }>> {
  const guard = await asMember(SOURCE, false);
  if (refused(guard)) return guard;
  const parsed = z.object({ document_id: z.guid() }).safeParse(input);
  if (!parsed.success) return refuse(DOCUMENT_REFUSALS.DOC_NOT_FOUND);
  return documentLink(guard.ctx, parsed.data.document_id);
}

// ---- Owner or admin -----------------------------------------------------------------------

export async function addDocumentForAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  const result = await addDocument(guard.ctx, input);
  await discardIfRefused(guard.ctx, result, input);
  return changed(result);
}

export async function updateDocumentAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  return changed(await updateDocument(guard.ctx, input));
}

/** Swaps a document's file. The old file is removed only after the database has swapped; a failure to remove it never fails this. */
export async function replaceDocumentFileAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  const result = await replaceDocumentFile(guard.ctx, input);
  await discardIfRefused(guard.ctx, result, input);
  if (!result.ok) return result;
  if (result.data.old_path) await removeDocumentFile(result.data.old_path);
  return changed({ ok: true as const, data: result.data.document });
}

/** Deletes a document. Its file is removed only after the database has deleted the row. */
export async function removeDocumentAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  const result = await removeDocument(guard.ctx, input);
  if (!result.ok) return result;
  if (result.data.path) await removeDocumentFile(result.data.path);
  return changed({ ok: true as const, data: { id: result.data.id, employee_id: result.data.employee_id } });
}

/** Asks the employee to acknowledge a document an owner or admin added, or withdraws the request. */
export async function requestDocumentAckAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  return changed(await requestDocumentAck(guard.ctx, input));
}
