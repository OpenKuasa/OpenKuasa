/**
 * The rules behind the Letters screen and its Templates section that can be said without a browser: who is shown
 * a control, the sentences of the second steps, whether a letter can be issued and why not, where the cursor goes
 * when a placeholder is inserted, and what the printable letter says. Pure: no clock, no network, and no import of
 * a write path or an action, so a member's page can import it.
 *
 * Draft safety is held twice on purpose. The database and `buildLettersModel` already give a member their own
 * issued letters only; `visibleLetterRows` filters again, so a draft handed to a member's screen by mistake still
 * draws no row.
 */
import { WRITE_FAILED } from './capabilities';
import { type LetterRow, type LettersModel, canManageDocuments } from './documents';
import { PLACEHOLDERS, unfilledInLetter } from './letter-placeholders';

// ---- Who is shown what -----------------------------------------------------------

type ViewerKind = { isHr: boolean; isDemo: boolean };

/** Owners and admins outside the demo: the only people who are shown a control that changes a letter or a template. */
export const showsLetterControls = (viewer: ViewerKind): boolean => canManageDocuments(viewer);

/** The Letters screen: owner controls only for an owner or admin outside the demo, with the data loaded. */
export const lettersScreenControls = (viewer: ViewerKind, loaded: boolean) => ({
  write: loaded && showsLetterControls(viewer),
});

/**
 * The rows the screen draws. A member (not the team view): issued letters only, awaiting acknowledgement first, then
 * as the model has them (newest first). The team view: drafts first, then as the model has them.
 */
export function visibleLetterRows(model: LettersModel): LetterRow[] {
  if (!model.team) {
    const issued = model.rows.filter((row) => row.status === 'issued');
    return [...issued.filter((r) => r.awaiting_acknowledgement), ...issued.filter((r) => !r.awaiting_acknowledgement)];
  }
  return [...model.rows.filter((r) => r.status === 'draft'), ...model.rows.filter((r) => r.status !== 'draft')];
}

// ---- Sentences -------------------------------------------------------------------

export { ACK_NOTE as ACK_LINE } from './documents-screens';

export const letterIssueSentence = (name: string): string => `${name} will be able to see this letter.`;
export const letterPullBackSentence = (name: string): string =>
  `${name} will no longer see this letter, and any acknowledgement is cleared.`;
export const deleteDraftSentence = (name: string, title: string): string =>
  `Delete the draft "${title}" to ${name}? This cannot be undone.`;
export const removeTemplateSentence = (name: string): string =>
  `Remove the template "${name}"? Letters already started from it are not changed.`;

// ---- Issuing ---------------------------------------------------------------------

export type IssueState = { allowed: boolean; reason: string | null; names: string[] };

export const EMPTY_BODY_REASON = 'The letter has no text yet.';

/**
 * Whether a letter with this title and body can be issued. It looks at the text as it is now, not at a list the
 * database reported earlier: a known placeholder anywhere in the title or body (an employee whose name is literally
 * `{designation}`) blocks issuing. An empty or blank body blocks it too, and that reason comes first.
 */
export function issueState(title: string, body: string): IssueState {
  const names = unfilledInLetter(title, body);
  if (body.trim() === '') return { allowed: false, reason: EMPTY_BODY_REASON, names };
  if (names.length > 0) {
    return { allowed: false, reason: `Replace ${names.map((n) => `{${n}}`).join(', ')} before issuing.`, names };
  }
  return { allowed: true, reason: null, names };
}

// ---- Placeholders in a textarea -------------------------------------------------------

/**
 * Puts `{name}` where the cursor is, replacing any selection, and says where the cursor goes (just after it).
 * Positions are clamped and may come in either order. A name that is not one of the seven, or a result longer
 * than `max`, leaves the text and the caret (at the start of the selection) as they were.
 */
export function insertPlaceholder(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  name: string,
  max?: number,
): { text: string; caret: number } {
  const clamp = (n: number) => Math.min(Math.max(Math.trunc(Number.isFinite(n) ? n : 0), 0), text.length);
  const a = clamp(selectionStart);
  const b = clamp(selectionEnd);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  const token = `{${name}}`;
  if (!PLACEHOLDERS.includes(name)) return { text, caret: start };
  const next = text.slice(0, start) + token + text.slice(end);
  if (max !== undefined && next.length > max) return { text, caret: start };
  return { text: next, caret: start + token.length };
}

/** Why an insert did nothing because of the length limit, or null when it fits (or the name is not a placeholder). */
export function insertRefusal(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  name: string,
  max: number,
  fieldLabel: string,
): string | null {
  if (!PLACEHOLDERS.includes(name)) return null;
  const result = insertPlaceholder(text, selectionStart, selectionEnd, name, max);
  const fits = insertPlaceholder(text, selectionStart, selectionEnd, name);
  return result.text === fits.text ? null : `That would make the ${fieldLabel} longer than ${max} characters.`;
}

export type PlaceholderSpot = { field: 'title' | 'body'; start: number; end: number };

/** Where `{name}` first appears: the title before the body. Null when it is not there. */
export function placeholderSpot(title: string, body: string, name: string): PlaceholderSpot | null {
  const token = `{${name}}`;
  const inTitle = title.indexOf(token);
  if (inTitle >= 0) return { field: 'title', start: inTitle, end: inTitle + token.length };
  const inBody = body.indexOf(token);
  if (inBody >= 0) return { field: 'body', start: inBody, end: inBody + token.length };
  return null;
}

// ---- "Save and issue" ----------------------------------------------------------------

/**
 * What to say when "Save and issue" did not finish. `refusal` is the sentence the rules gave, or null when the call
 * threw. Once the draft is saved the person is told so, never the generic write-failed sentence.
 */
export function issueFailureSentence(saved: boolean, refusal: string | null): string {
  if (saved) return `Saved as a draft, but not issued. ${refusal ?? 'Try again.'}`;
  return refusal ?? WRITE_FAILED;
}

export const DRAFT_KEPT_NOTE = 'The draft is kept in your list of letters.';

// ---- The New letter start ------------------------------------------------------------

export type StartChoice = { ok: true; kind: 'blank' | 'template' } | { ok: false; error: string };

/** The first step of a new letter: an employee, then blank (no template chosen) or from a template. */
export function startChoice(values: { employeeId: string; templateId: string }): StartChoice {
  if (values.employeeId === '') return { ok: false, error: 'Choose an employee.' };
  return { ok: true, kind: values.templateId === '' ? 'blank' : 'template' };
}

export type LetterFormValues = { letter_type: string; title: string; body: string; ack_requested: boolean };

/** What the letter form holds when it opens: blank for a new letter, the draft for an edit. */
export function letterFormDefaults(
  row: { letter_type: string; title: string; body: string; ack_requested: boolean } | null,
): LetterFormValues {
  if (!row) return { letter_type: 'offer', title: '', body: '', ack_requested: false };
  return { letter_type: row.letter_type, title: row.title, body: row.body, ack_requested: row.ack_requested };
}

// ---- The printable letter ------------------------------------------------------------

export const DRAFT_NOTE = 'Draft: the employee cannot see this yet.';

export type LetterViewModel = {
  workspace: string;
  date_line: string;
  employee_name: string;
  title: string;
  /** Plain text, line breaks kept. Rendered as text, never as HTML. */
  body: string;
  draft: boolean;
  draft_note: string | null;
  can_acknowledge: boolean;
};

export function letterView(row: LetterRow, workspaceName: string): LetterViewModel {
  const draft = row.status === 'draft';
  return {
    workspace: workspaceName.trim() === '' ? 'Your workspace' : workspaceName,
    date_line: draft ? 'Not issued yet' : `Issued ${row.date_label}`,
    employee_name: row.employee_name,
    title: row.title,
    body: row.body,
    draft,
    draft_note: draft ? DRAFT_NOTE : null,
    can_acknowledge: !draft && row.can_acknowledge,
  };
}
