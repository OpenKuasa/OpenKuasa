/**
 * The app's write path for letters and letter templates. Every change is one call to a database function
 * (`hr_save_letter`, `hr_issue_letter`, ...): the tables take no direct writes. This file only checks the shape of
 * an input, makes the call and turns a refusal into a sentence (the shared helpers are in `document-writes.ts`).
 *
 * The acting user is the session's. The workspace is the context's, never the input's: a new template goes to
 * `ctx.orgId`. A letter's body is kept exactly as typed. Whether a letter still has a placeholder is the
 * database's decision at issue; `letter-placeholders.ts` mirrors its rule so a screen can say which are left.
 * Nothing typed (a title, a body, a template) is ever logged: only the database's code and the function's name.
 */
import { z } from 'zod';
import { type CapResult, type PeopleWriteContext } from './capabilities';
import { callDb, id } from './document-writes';
import { type Row, isRow, optionalGuid, parse, text } from './performance-rpc';
import { LETTER_TYPES, type LetterType } from './types';

const TYPE_MESSAGE = 'Choose a type from the list.';
const letterType = z.enum(LETTER_TYPES, TYPE_MESSAGE);
const letterTitle = z.string().trim().min(1, 'Give the letter a title.').max(200, 'Keep the title to 200 characters.');
/** Kept exactly as typed; none (or null) is empty. Whether it can be issued empty is the database's call. */
const letterBody = z.preprocess(
  (value) => (value === undefined || value === null ? '' : value),
  z.string().max(10000, 'Keep the letter to 10,000 characters.'),
);

export const saveLetterInput = z.object({
  employee_id: id('employee'),
  letter_id: optionalGuid('The draft to change, by its id. Leave out to add one.'),
  letter_type: letterType,
  title: letterTitle,
  body: letterBody,
  ack_requested: z.boolean('Say whether to ask for an acknowledgement.').nullish(),
});
export const startLetterInput = z.object({ employee_id: id('employee'), template_id: id('template') });
export const letterIdInput = z.object({ letter_id: id('letter') });
export const saveTemplateInput = z.object({
  template_id: optionalGuid('The template to change, by its id. Leave out to add one.'),
  name: z.string().trim().min(1, 'Give the template a name.').max(120, 'Keep the name to 120 characters.'),
  letter_type: letterType,
  title: z.string().trim().min(1, 'Give the template a title.').max(200, 'Keep the title to 200 characters.'),
  body: letterBody,
});
export const templateIdInput = z.object({ template_id: id('template') });

/** A letter as the database returns it. */
export type SavedLetter = {
  id: string;
  employee_id: string;
  letter_type: LetterType;
  title: string;
  body: string;
  status: 'draft' | 'issued';
  /** `YYYY-MM-DD`, the Malaysia date it was issued; null on a draft. */
  issued_on: string | null;
  ack_requested: boolean;
  acknowledged_at: string | null;
};

export type SavedTemplate = { id: string; name: string; letter_type: LetterType; title: string; body: string };

const isLetterType = (value: unknown): value is LetterType =>
  typeof value === 'string' && (LETTER_TYPES as readonly string[]).includes(value);

export function letterOf(row: Row): SavedLetter | null {
  const { id: letterId, employee_id, letter_type, title, body, status, ack_requested } = row;
  const issued_on = row.issued_on === null ? null : typeof row.issued_on === 'string' ? row.issued_on : undefined;
  const acknowledged_at = row.acknowledged_at === null ? null : typeof row.acknowledged_at === 'string' ? row.acknowledged_at : undefined;
  if (
    typeof letterId !== 'string' ||
    typeof employee_id !== 'string' ||
    !isLetterType(letter_type) ||
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    (status !== 'draft' && status !== 'issued') ||
    typeof ack_requested !== 'boolean' ||
    issued_on === undefined ||
    acknowledged_at === undefined
  ) {
    return null;
  }
  return { id: letterId, employee_id, letter_type, title, body, status, issued_on, ack_requested, acknowledged_at };
}

function templateOf(row: Row): SavedTemplate | null {
  const { id: templateId, name, letter_type, title, body } = row;
  if (
    typeof templateId !== 'string' ||
    typeof name !== 'string' ||
    !isLetterType(letter_type) ||
    typeof title !== 'string' ||
    typeof body !== 'string'
  ) {
    return null;
  }
  return { id: templateId, name, letter_type, title, body };
}

/** Adds a draft (no `letter_id`) or changes one. Asking for an acknowledgement is part of this, and only while a draft. */
export async function saveLetter(ctx: PeopleWriteContext, input: unknown): Promise<CapResult<SavedLetter>> {
  const parsed = parse(saveLetterInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return callDb(ctx, 'saveLetter', 'hr_save_letter', {
    p_employee: v.employee_id,
    p_letter: v.letter_id ?? null,
    p_letter_type: v.letter_type,
    p_title: v.title,
    p_body: v.body,
    p_ack_requested: v.ack_requested === true,
  }, letterOf);
}

/** A new draft from a template, placeholders filled from the employee's record. `unfilled` names those with no value. */
export async function startLetterFromTemplate(
  ctx: PeopleWriteContext,
  input: unknown,
): Promise<CapResult<{ letter: SavedLetter; unfilled: string[] }>> {
  const parsed = parse(startLetterInput, input);
  if (!parsed.ok) return parsed;
  return callDb(ctx, 'startLetterFromTemplate', 'hr_start_letter_from_template', {
    p_employee: parsed.data.employee_id,
    p_template: parsed.data.template_id,
  }, (row) => {
    const letter = isRow(row.letter) ? letterOf(row.letter) : null;
    const unfilled = Array.isArray(row.unfilled) && row.unfilled.every((n) => typeof n === 'string') ? (row.unfilled as string[]) : null;
    return letter && unfilled ? { letter, unfilled } : null;
  });
}

/** Draft to issued: the employee can then see it. Refused while a placeholder is left or there is no text. */
export async function issueLetter(ctx: PeopleWriteContext, input: unknown): Promise<CapResult<SavedLetter>> {
  const parsed = parse(letterIdInput, input);
  if (!parsed.ok) return parsed;
  return callDb(ctx, 'issueLetter', 'hr_issue_letter', { p_letter: parsed.data.letter_id }, letterOf);
}

/** Issued back to draft: the employee no longer sees it. Clears any acknowledgement. */
export async function unissueLetter(ctx: PeopleWriteContext, input: unknown): Promise<CapResult<SavedLetter>> {
  const parsed = parse(letterIdInput, input);
  if (!parsed.ok) return parsed;
  return callDb(ctx, 'unissueLetter', 'hr_unissue_letter', { p_letter: parsed.data.letter_id }, letterOf);
}

/** The employee's own acknowledgement of an issued letter. The employee is the session's. */
export async function acknowledgeLetter(ctx: PeopleWriteContext, input: unknown): Promise<CapResult<SavedLetter>> {
  const parsed = parse(letterIdInput, input);
  if (!parsed.ok) return parsed;
  return callDb(ctx, 'acknowledgeLetter', 'hr_acknowledge_letter', { p_letter: parsed.data.letter_id }, letterOf);
}

/** Deletes a draft. */
export async function deleteLetter(
  ctx: PeopleWriteContext,
  input: unknown,
): Promise<CapResult<{ id: string; employee_id: string }>> {
  const parsed = parse(letterIdInput, input);
  if (!parsed.ok) return parsed;
  return callDb(ctx, 'deleteLetter', 'hr_delete_letter', { p_letter: parsed.data.letter_id }, (row) => {
    const letterId = text(row.id);
    const employee = text(row.employee_id);
    return letterId && employee ? { id: letterId, employee_id: employee } : null;
  });
}

/** Adds a template to the SESSION's workspace, or changes one. */
export async function saveLetterTemplate(ctx: PeopleWriteContext, input: unknown): Promise<CapResult<SavedTemplate>> {
  const parsed = parse(saveTemplateInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return callDb(ctx, 'saveLetterTemplate', 'hr_save_letter_template', {
    p_org: ctx.orgId,
    p_template: v.template_id ?? null,
    p_name: v.name,
    p_letter_type: v.letter_type,
    p_title: v.title,
    p_body: v.body,
  }, templateOf);
}

export async function deleteLetterTemplate(ctx: PeopleWriteContext, input: unknown): Promise<CapResult<{ id: string }>> {
  const parsed = parse(templateIdInput, input);
  if (!parsed.ok) return parsed;
  return callDb(ctx, 'deleteLetterTemplate', 'hr_delete_letter_template', { p_template: parsed.data.template_id }, (row) => {
    const templateId = text(row.id);
    return templateId ? { id: templateId } : null;
  });
}
