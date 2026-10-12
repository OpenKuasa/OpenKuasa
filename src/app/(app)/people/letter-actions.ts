'use server';

import {
  acknowledgeLetter,
  deleteLetter,
  deleteLetterTemplate,
  issueLetter,
  saveLetter,
  saveLetterTemplate,
  startLetterFromTemplate,
  unissueLetter,
} from '@/lib/people/letter-writes';
import { asAdmin, asMember, changed, refused, withoutEmployee } from './performance-guards';

// Every action passes its input to the write path, which validates it. The workspace is always the session's.

const SOURCE = 'letter-actions';

// ---- The employee's own ---------------------------------------------------------------------

/**
 * "I have read this" on an issued letter addressed to the viewer. The database records it for the signed-in
 * employee only, and refuses a draft; no employee id is taken from the input.
 */
export async function acknowledgeLetterAction(input: unknown) {
  const guard = await asMember(SOURCE, true);
  if (refused(guard)) return guard;
  return changed(await acknowledgeLetter(guard.ctx, withoutEmployee(input)));
}

// ---- Owner or admin -----------------------------------------------------------------------

export async function saveLetterAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  return changed(await saveLetter(guard.ctx, input));
}

export async function startLetterFromTemplateAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  return changed(await startLetterFromTemplate(guard.ctx, input));
}

export async function issueLetterAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  return changed(await issueLetter(guard.ctx, input));
}

export async function unissueLetterAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  return changed(await unissueLetter(guard.ctx, input));
}

export async function deleteLetterAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  return changed(await deleteLetter(guard.ctx, input));
}

export async function saveLetterTemplateAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  return changed(await saveLetterTemplate(guard.ctx, input));
}

export async function deleteLetterTemplateAction(input: unknown) {
  const guard = await asAdmin(SOURCE);
  if (refused(guard)) return guard;
  return changed(await deleteLetterTemplate(guard.ctx, input));
}
