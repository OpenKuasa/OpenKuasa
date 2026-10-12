// src/lib/hire/feedback-dialog-state.ts
/**
 * Everything the feedback form, the clear confirm, the row menu's feedback
 * items and the Applications panel's feedback lines decide, as plain
 * functions: the tests run with no DOM, so a decision made inside a component
 * could not be tested. Pure: nothing here reads the clock or touches the
 * browser.
 */
import type { InterviewFeedbackChange } from './capabilities';
import { MENU_WORDS, menuGroups, rowMenu } from './interview-dialog-state';
import {
  FEEDBACK_INPUT_MESSAGES, FEEDBACK_LIMITS, FEEDBACK_NOT_LOADED, FEEDBACK_SAVE_FAILED, RECOMMENDATIONS, feedbackBlocksReopen, feedbackMenuFor, feedbackMessage,
  ratingWords, type Feedback, type FeedbackMenuItem, type Recommendation,
} from './interview-feedback';
import { clock12, longDate } from './interview-time';
import { INTERVIEW_NOT_READ_BACK, interviewMessage, type InterviewMenuItem } from './interviews';
import type { InterviewRow } from './lists';

// ─── the form's values ───────────────────────────────────────────────────────

/** `add`: a completed interview with none. `edit`: one that has feedback. `complete`: a scheduled one, marked completed in the same save. */
export type FeedbackMode = 'add' | 'edit' | 'complete';
export type FeedbackField = 'rating' | 'recommendation' | 'comments';
export type FeedbackFormValues = { rating: number | null; recommendation: '' | Recommendation; comments: string };
export type FeedbackProblems = Partial<Record<FeedbackField, string>>;

/** The order the form shows its fields in: a failed submit takes focus to the first wrong one. */
const FIELD_ORDER: readonly FeedbackField[] = ['rating', 'recommendation', 'comments'];
export const RATINGS = [1, 2, 3, 4, 5] as const;

export const emptyFeedback = (): FeedbackFormValues => ({ rating: null, recommendation: '', comments: '' });
export const valuesFromFeedback = (feedback: Feedback): FeedbackFormValues =>
  ({ rating: feedback.rating, recommendation: feedback.recommendation, comments: feedback.comments ?? '' });
/** What the form opens with: what is stored when editing, nothing otherwise. */
export const startingValues = (mode: FeedbackMode, stored: Feedback | null | undefined): FeedbackFormValues =>
  (mode === 'edit' && stored ? valuesFromFeedback(stored) : emptyFeedback());

// ─── the checks ──────────────────────────────────────────────────────────────

/** Characters as the database counts them, after the ends are trimmed as the database trims them. */
const length = (text: string) => Array.from(text.trim()).length;

/** What is wrong, by field, before anything is sent. The server and the database check again. */
export function feedbackProblems(values: FeedbackFormValues): FeedbackProblems {
  const found: FeedbackProblems = {};
  const rating = values.rating;
  if (rating === null || !Number.isInteger(rating) || rating < FEEDBACK_LIMITS.ratingMin || rating > FEEDBACK_LIMITS.ratingMax) {
    found.rating = FEEDBACK_INPUT_MESSAGES.rating;
  }
  if (values.recommendation === '') found.recommendation = FEEDBACK_INPUT_MESSAGES.recommendation;
  if (length(values.comments) > FEEDBACK_LIMITS.comments) found.comments = FEEDBACK_INPUT_MESSAGES.comments;
  return found;
}

export function firstWrongFeedbackField(problems: FeedbackProblems): FeedbackField | null {
  return FIELD_ORDER.find((field) => problems[field]) ?? null;
}

// ─── what is sent ────────────────────────────────────────────────────────────

/** What the form sends. Never a `basis`: that is for a rating an assistant proposed. */
export type FeedbackInput = {
  id: string; rating: number; recommendation: Recommendation; comments: string | null; mark_completed?: true; replace?: true;
};
export type FeedbackSubmission = { kind: 'save'; input: FeedbackInput; seen: string | null } | { kind: 'nothing' };

/** Whether the values differ from the ones the form opened with. Spaces at the ends of the comments are not a difference. */
export function isFeedbackDirty(initial: FeedbackFormValues, values: FeedbackFormValues): boolean {
  return values.rating !== initial.rating || values.recommendation !== initial.recommendation || values.comments.trim() !== initial.comments.trim();
}

/**
 * What a submit that passed its checks does. From "Mark completed and add
 * feedback" it says `mark_completed`. An edit says `replace`, and carries the
 * time the stored feedback was last saved as `seen`, exactly as it was read: a
 * colleague's later edit or clear is then refused, not replaced. `nothing`
 * sends nothing: the form says "Nothing has been changed yet."
 */
export function feedbackSubmission(
  mode: FeedbackMode,
  values: FeedbackFormValues,
  target: { id: string; stored: Feedback | null },
): FeedbackSubmission {
  if (values.rating === null || values.recommendation === '') return { kind: 'nothing' };
  const comments = values.comments.trim();
  const input: FeedbackInput = { id: target.id, rating: values.rating, recommendation: values.recommendation, comments: comments === '' ? null : comments };
  if (mode === 'complete') return { kind: 'save', input: { ...input, mark_completed: true }, seen: null };
  if (mode === 'add') return { kind: 'save', input, seen: null };
  if (!target.stored || !isFeedbackDirty(valuesFromFeedback(target.stored), values)) return { kind: 'nothing' };
  return { kind: 'save', input: { ...input, replace: true }, seen: target.stored.recorded_at };
}

// ─── the count under the comments ────────────────────────────────────────────

/** The count is shown once fewer than this many characters remain. */
export const COUNT_FROM = 200;
export const charactersLeft = (comments: string): number => FEEDBACK_LIMITS.comments - Array.from(comments).length;
export const countShown = (left: number): boolean => left < COUNT_FROM;
export function countText(left: number): string {
  const n = Math.max(0, left);
  return `${n} ${n === 1 ? 'character' : 'characters'} left`;
}
/** What is read out after a keystroke: the count when it first appears and when it reaches 0, and nothing in between. */
export function countAnnouncement(before: number, left: number): string {
  if (!countShown(before) && countShown(left)) return countText(left);
  if (left <= 0 && before > 0) return countText(left);
  return '';
}

// ─── the form's words ────────────────────────────────────────────────────────

export function feedbackDialogTitle(mode: FeedbackMode, name: string): string {
  if (mode === 'complete') return 'Mark completed and add feedback';
  return `${mode === 'edit' ? 'Edit' : 'Add'} feedback on the interview with ${name}`;
}

/** Under the title: which interview, with its date and its year. From "Mark completed and add feedback" it also says what saving does. */
export function feedbackDialogDescription(mode: FeedbackMode, row: Pick<InterviewRow, 'name' | 'role' | 'scheduledAt'>): string {
  const when = `${longDate(row.scheduledAt)}, ${clock12(row.scheduledAt)}`;
  return mode === 'complete'
    ? `Interview with ${row.name} for ${row.role}, ${when}. Saving also marks it completed.`
    : `${row.role}, ${when}.`;
}

export const feedbackSubmitLabel = (busy: boolean): string => (busy ? 'Saving…' : 'Save feedback');
export const feedbackDiscardTitle = (mode: FeedbackMode): string => (mode === 'edit' ? 'Discard your changes?' : 'Discard this feedback?');
export const RATING_HELP = '1 is the lowest, 5 the highest.';
export const RECOMMENDATION_HELP = 'A note for whoever decides. It does not move or reject the application.';
export const COMMENTS_HELP = 'Optional. What the interview showed that bears on the job.';
/** How a rating's radio is read to a screen reader: "4 out of 5". */
export const ratingSpoken = (rating: number): string => ratingWords(rating);

// ─── what an action answered ─────────────────────────────────────────────────

/** An action's answer as the screen uses it. Anything malformed (a throw is passed as null) fails closed. */
export function feedbackResult(result: unknown): { ok: true; change: InterviewFeedbackChange } | { ok: false; error: string } {
  const failed = { ok: false as const, error: FEEDBACK_SAVE_FAILED };
  if (!result || typeof result !== 'object') return failed;
  const answer = result as { ok?: unknown; data?: unknown; error?: unknown };
  if (answer.ok === false) return typeof answer.error === 'string' && answer.error ? { ok: false, error: answer.error } : failed;
  if (answer.ok !== true || !answer.data || typeof answer.data !== 'object') return failed;
  const data = answer.data as { id?: unknown; message?: unknown; confirmed?: unknown };
  if (typeof data.id !== 'string' || typeof data.message !== 'string' || typeof data.confirmed !== 'boolean') return failed;
  return { ok: true, change: answer.data as InterviewFeedbackChange };
}

/** The sentence for the screen's notice line. A change that could not be read back has no name to put in it, so the note stands alone. */
export const feedbackNotice = (change: InterviewFeedbackChange): string =>
  (change.confirmed ? change.message : change.note ?? INTERVIEW_NOT_READ_BACK);

const SAVE_WORDS = ['not_found', 'forbidden', 'not_completed', 'has_feedback', 'changed'] as const;
/** The word a save's refusal was made from, found by its sentence. Null for the generic one and for anything else. */
export function feedbackRefusalWord(error: string): string | null {
  if (!error) return null;
  return SAVE_WORDS.find((word) => feedbackMessage(word, 'save') === error) ?? null;
}
/** The screen is fetched again when the refusal means it is out of date, and when the refusal cannot be named. */
export const feedbackRefreshAfter = (word: string | null): boolean => word !== 'forbidden';
/** The interview has gone, and its row with it: said on the notice line, and the dialog closes. */
export const feedbackGone = (word: string | null): boolean => word === 'not_found';

export const LOAD_CURRENT_FEEDBACK = 'Load the current feedback';
export const LOAD_CURRENT_FEEDBACK_HELP = 'This replaces what you typed with the feedback as it is now. Nothing is saved until you save again.';
export const FEEDBACK_CLEARED_MEANWHILE = 'The feedback on this interview was cleared a moment ago. Close this, then use “Add feedback” if it should have one.';
/** Offered only after the refusal that says someone else changed the feedback, once it was read, and not while saving. Nothing is sent again by itself. */
export const offersFeedbackReload = (word: string | null, loaded: boolean, pending: boolean): boolean => word === 'changed' && loaded && !pending;

/**
 * The answer of the action that reads an interview's stored feedback, after a
 * save was refused as stale. Only for the interview the form is about, and
 * only whole: anything else fails closed, so a form is never refilled with
 * half a feedback. None stored: it was cleared meanwhile, and the sentence
 * says what to do.
 */
export function currentFeedbackResult(answer: unknown, id: string): { ok: true; current: Feedback } | { ok: false; error: string } {
  const failed = { ok: false as const, error: FEEDBACK_NOT_LOADED };
  if (!answer || typeof answer !== 'object') return failed;
  const said = answer as { ok?: unknown; data?: unknown; error?: unknown };
  if (said.ok === false) return typeof said.error === 'string' && said.error ? { ok: false, error: said.error } : failed;
  if (said.ok !== true || !said.data || typeof said.data !== 'object') return failed;
  const d = said.data as { id?: unknown; feedback?: unknown };
  if (d.id !== id) return failed;
  if (d.feedback === null) return { ok: false, error: FEEDBACK_CLEARED_MEANWHILE };
  if (!d.feedback || typeof d.feedback !== 'object') return failed;
  const f = d.feedback as { rating?: unknown; recommendation?: unknown; comments?: unknown; recorded_at?: unknown };
  const recommendation = RECOMMENDATIONS.find((known) => known === f.recommendation);
  if (typeof f.rating !== 'number' || !Number.isInteger(f.rating) || f.rating < FEEDBACK_LIMITS.ratingMin || f.rating > FEEDBACK_LIMITS.ratingMax) return failed;
  if (!recommendation || typeof f.recorded_at !== 'string' || f.recorded_at === '') return failed;
  // Comments are text or none; anything else is not a feedback this form can show.
  const comments = f.comments === null ? null : typeof f.comments === 'string' ? f.comments : undefined;
  if (comments === undefined) return failed;
  return { ok: true, current: { rating: f.rating, recommendation, comments, recorded_at: f.recorded_at } };
}

// ─── where focus goes ────────────────────────────────────────────────────────

export type FeedbackPart = FeedbackField | 'alert' | 'unchanged' | 'reload' | 'count';
/** The DOM id of a part of the form: `base` is the form's own `useId`. */
export const feedbackFieldId = (base: string, part: FeedbackPart): string => `${base}-${part}`;
export const ratingId = (base: string, rating: number): string => `${base}-rating-${rating}`;
export const recommendationId = (base: string, recommendation: Recommendation): string => `${base}-recommendation-${recommendation}`;

export type FeedbackFocusMoment =
  | { after: 'open'; values: FeedbackFormValues }
  | { after: 'check'; problems: FeedbackProblems; values: FeedbackFormValues }
  | { after: 'refusal' };

/**
 * Where focus goes. On opening: the Rating group, on the stored rating when
 * editing and on the first option otherwise. After a failed check: the first
 * group or field that is wrong (null when nothing is). After a refusal: the
 * alert.
 */
export function feedbackFocusIdAfter(moment: FeedbackFocusMoment, base: string): string | null {
  if (moment.after === 'refusal') return feedbackFieldId(base, 'alert');
  const rating = ratingId(base, moment.values.rating ?? 1);
  if (moment.after === 'open') return rating;
  const wrong = firstWrongFeedbackField(moment.problems);
  if (wrong === 'rating') return rating;
  if (wrong === 'recommendation') return recommendationId(base, moment.values.recommendation || 'advance');
  return wrong === 'comments' ? feedbackFieldId(base, 'comments') : null;
}

// ─── a row's menu, with feedback ─────────────────────────────────────────────

export type RowMenuItem = InterviewMenuItem | FeedbackMenuItem;

export const FEEDBACK_MENU_WORDS: Record<FeedbackMenuItem, string> = {
  complete_with_feedback: 'Mark completed and add feedback',
  add_feedback: 'Add feedback',
  edit_feedback: 'Edit feedback',
  clear_feedback: 'Clear feedback',
};
export const ROW_MENU_WORDS: Record<RowMenuItem, string> = { ...MENU_WORDS, ...FEEDBACK_MENU_WORDS };

/**
 * The row's menu as it is drawn, in groups with a rule between: the interview
 * items as they were, and the feedback items among them. "Mark completed and
 * add feedback" comes directly after "Mark completed". "Add feedback" or
 * "Edit feedback" is first, above "Mark as scheduled again". "Clear feedback"
 * is last and alone.
 *
 * "Mark as scheduled again" stays in the menu of an interview that has
 * feedback: pressing it says why it cannot be done and what to do first
 * (`reopenRefusal`). Left out, nothing would tell the person why it had gone.
 */
export function rowMenuWithFeedback(row: InterviewRow): RowMenuItem[][] {
  const groups: RowMenuItem[][] = menuGroups(rowMenu(row)).map((group) => [...group]);
  const extra = feedbackMenuFor(row.statusKey, Boolean(row.feedback));
  if (extra.includes('complete_with_feedback')) {
    for (const group of groups) {
      const at = group.indexOf('completed');
      if (at >= 0) group.splice(at + 1, 0, 'complete_with_feedback');
    }
  }
  const first = extra.filter((item) => item === 'add_feedback' || item === 'edit_feedback');
  const last = extra.filter((item) => item === 'clear_feedback');
  return [...(first.length > 0 ? [first] : []), ...groups, ...(last.length > 0 ? [last] : [])];
}

/** The items drawn in the danger style, with their words: colour is never the only signal. */
export const isDestructive = (item: RowMenuItem): boolean => item === 'cancel' || item === 'clear_feedback';

/** The form an item opens, or null for an item that opens none. */
export function modeOf(item: RowMenuItem): FeedbackMode | null {
  if (item === 'complete_with_feedback') return 'complete';
  if (item === 'add_feedback') return 'add';
  return item === 'edit_feedback' ? 'edit' : null;
}

/**
 * Why "Mark as scheduled again" cannot be done for this row, or null when it
 * can be tried. Said at the row with no call to the server; the sentence names
 * the other route, which is in the same menu. A stale row gets the same
 * sentence from the database.
 */
export function reopenRefusal(row: Pick<InterviewRow, 'statusKey' | 'feedback'>): string | null {
  return feedbackBlocksReopen(row.statusKey, Boolean(row.feedback)) ? interviewMessage('has_feedback', 'interview') : null;
}

// ─── the clear confirm ───────────────────────────────────────────────────────

export const clearTitle = (name: string): string => `Clear the feedback on the interview with ${name}?`;
export const CLEAR_BODY = 'The rating, the recommendation and the comments are removed. The interview stays completed. This can\'t be undone.';
export const KEEP_FEEDBACK = 'Keep feedback';
export const clearLabel = (busy: boolean): string => (busy ? 'Clearing…' : 'Clear feedback');

// ─── the Applications panel ──────────────────────────────────────────────────

/** The line that says the two ratings are separate is shown only when some interview in the list has feedback. */
export const panelShowsHelper = (interviews: readonly { feedback?: Feedback }[]): boolean => interviews.some((interview) => Boolean(interview.feedback));
