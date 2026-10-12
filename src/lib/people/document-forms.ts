/**
 * What the document, letter and template forms hold and what they send, and the ONE place a document's expiry
 * state is worked out. Pure: no clock (callers pass today's date, in Malaysia, as `YYYY-MM-DD`), no network.
 * The database re-checks everything; these only say it in words first. Nothing here logs.
 */
import { daysBetween, isRealDate } from './dates';
import { DOCUMENT_TYPES, LETTER_TYPES } from './types';

export type Converted<T> = { ok: true; input: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const DOCUMENT_TITLE_MAX = 200;
export const LETTER_TITLE_MAX = 200;
export const LETTER_BODY_MAX = 10000;
export const TEMPLATE_NAME_MAX = 120;
/** A document that expires today or within this many days is "expiring soon". */
export const EXPIRY_WINDOW_DAYS = 90;

export type ExpiryState = 'none' | 'expiring' | 'expired';

/**
 * `expired` when the date is before today, `expiring` from today up to 90 days away (day 90 included), else
 * `none`. Both dates are Malaysia dates. The only function that decides this: every screen, model and tool uses it.
 */
export function expiryState(expires_on: string | null, today: string): ExpiryState {
  if (!expires_on) return 'none';
  const days = daysBetween(today, expires_on);
  if (days < 0) return 'expired';
  return days <= EXPIRY_WINDOW_DAYS ? 'expiring' : 'none';
}

const TYPE_PROBLEM = 'Choose a type from the list.';
const expiryOk = (date: string): boolean => isRealDate(date) && date >= '2000-01-01' && date <= '2100-12-31';

/** What the add and edit document forms send. `allowedTypes` is the list the person may choose from. An empty expiry is none. */
export function toDocumentInput(
  values: { title: string; doc_type: string; expires_on: string },
  allowedTypes: readonly string[] = DOCUMENT_TYPES,
): Converted<{ title: string; doc_type: string; expires_on: string | null }> {
  const title = values.title.trim();
  if (title === '') return bad('Give the document a title.');
  if (title.length > DOCUMENT_TITLE_MAX) return bad(`Keep the title to ${DOCUMENT_TITLE_MAX} characters.`);
  if (!allowedTypes.includes(values.doc_type)) return bad(TYPE_PROBLEM);
  const expiry = values.expires_on.trim();
  if (expiry !== '' && !expiryOk(expiry)) return bad('Enter a real expiry date between 2000 and 2100, or leave it empty.');
  return { ok: true, input: { title, doc_type: values.doc_type, expires_on: expiry === '' ? null : expiry } };
}

/** What the letter form sends. The body is kept exactly as typed; an empty one is allowed for a draft. */
export function toLetterInput(values: {
  letter_type: string;
  title: string;
  body: string;
  ack_requested: boolean;
}): Converted<{ letter_type: string; title: string; body: string; ack_requested: boolean }> {
  const title = values.title.trim();
  if (title === '') return bad('Give the letter a title.');
  if (title.length > LETTER_TITLE_MAX) return bad(`Keep the title to ${LETTER_TITLE_MAX} characters.`);
  if (values.body.length > LETTER_BODY_MAX) return bad('Keep the letter to 10,000 characters.');
  if (!(LETTER_TYPES as readonly string[]).includes(values.letter_type)) return bad(TYPE_PROBLEM);
  return {
    ok: true,
    input: { letter_type: values.letter_type, title, body: values.body, ack_requested: values.ack_requested === true },
  };
}

/** What the template form sends. Placeholders in the title and body are kept as typed. */
export function toTemplateInput(values: {
  name: string;
  letter_type: string;
  title: string;
  body: string;
}): Converted<{ name: string; letter_type: string; title: string; body: string }> {
  const name = values.name.trim();
  if (name === '') return bad('Give the template a name.');
  if (name.length > TEMPLATE_NAME_MAX) return bad(`Keep the name to ${TEMPLATE_NAME_MAX} characters.`);
  const title = values.title.trim();
  if (title === '') return bad('Give the template a title.');
  if (title.length > LETTER_TITLE_MAX) return bad(`Keep the title to ${LETTER_TITLE_MAX} characters.`);
  if (values.body.length > LETTER_BODY_MAX) return bad('Keep the letter to 10,000 characters.');
  if (!(LETTER_TYPES as readonly string[]).includes(values.letter_type)) return bad(TYPE_PROBLEM);
  return { ok: true, input: { name, letter_type: values.letter_type, title, body: values.body } };
}
