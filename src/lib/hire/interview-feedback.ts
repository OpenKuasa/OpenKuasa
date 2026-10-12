// src/lib/hire/interview-feedback.ts
/**
 * Feedback on an interview, in words: the limits, the labels, the sentence
 * for every answer of the two feedback functions, the sentences after a
 * change, which items a row's menu offers for it, and the wording of the two
 * Approve cards. Pure: its only imports are types and the time helpers. Client
 * components, the capabilities, the chat cards and the tests all read the same
 * words here.
 *
 * Feedback is one judgment about a person, per interview: a rating from 1 to
 * 5, a recommendation and optional comments. It is separate from the
 * application's own rating, and recording it changes nothing else.
 */
import { shortDate, shortWhen, shortWhenToSecond } from './interview-time';
import type { InterviewStatus } from './types';

// ─── limits and labels ───────────────────────────────────────────────────────

/** The same limits as the checks on `hire_interviews`. `basis` is never stored: it is the Approve card's. */
export const FEEDBACK_LIMITS = { ratingMin: 1, ratingMax: 5, comments: 2000, basis: 500 } as const;
export const RECOMMENDATIONS = ['advance', 'hold', 'reject'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];
/** As a label. Inside a sentence the word itself is used, in lower case. */
export const RECOMMENDATION_LABEL: Record<Recommendation, string> = { advance: 'Advance', hold: 'Hold', reject: 'Reject' };

/** One interview's feedback. `recorded_at` is when it was last saved, exactly as the database wrote it. */
export type Feedback = { rating: number; recommendation: Recommendation; comments: string | null; recorded_at: string };
type Rated = Pick<Feedback, 'rating' | 'recommendation'>;

const isRecommendation = (value: unknown): value is Recommendation =>
  typeof value === 'string' && (RECOMMENDATIONS as readonly string[]).includes(value);
const isRating = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= FEEDBACK_LIMITS.ratingMin && value <= FEEDBACK_LIMITS.ratingMax;

/**
 * The four columns of a row as one value, or null when the row has no
 * feedback. Whole or nothing, as the table's own check has it: a saved time, a
 * rating and a recommendation together. Comments that were not read, or are
 * blank, are none.
 */
export function feedbackOf(
  row: { feedback_rating?: unknown; feedback_recommendation?: unknown; feedback_comments?: unknown; feedback_at?: unknown } | null | undefined,
): Feedback | null {
  if (!row || typeof row.feedback_at !== 'string' || !row.feedback_at) return null;
  if (!isRating(row.feedback_rating) || !isRecommendation(row.feedback_recommendation)) return null;
  const comments = typeof row.feedback_comments === 'string' && row.feedback_comments.trim() ? row.feedback_comments : null;
  return { rating: row.feedback_rating, recommendation: row.feedback_recommendation, comments, recorded_at: row.feedback_at };
}

/** "4 out of 5": how a rating reads everywhere. */
export const ratingWords = (rating: number): string => `${rating} out of 5`;
/** "4 out of 5 · Advance". */
export const feedbackSummary = (feedback: Rated): string => `${ratingWords(feedback.rating)} · ${RECOMMENDATION_LABEL[feedback.recommendation]}`;

/** The Feedback cell of the Interviews table: the summary, "None yet" for a completed interview without one, a dash otherwise. */
export function feedbackCell(status: InterviewStatus, feedback: Rated | null | undefined): string {
  if (feedback) return feedbackSummary(feedback);
  return status === 'completed' ? 'None yet' : '—';
}

/** "Feedback: 4 out of 5 · Advance · saved 21 Oct 2026": under an interview's line in the Applications panel. */
export const panelFeedbackLine = (feedback: Feedback): string => `Feedback: ${feedbackSummary(feedback)} · saved ${shortDate(feedback.recorded_at)}`;
export const PANEL_FEEDBACK_HELPER = 'Interview feedback is separate from the application\'s rating below.';

// ─── refusals ────────────────────────────────────────────────────────────────

export const FEEDBACK_SAVE_FAILED = 'That change could not be saved. Please try again.';
/** What is said when the stored feedback could not be read for a form that was refused as stale. Nothing was changed. */
export const FEEDBACK_NOT_LOADED = 'The feedback could not be loaded just now. Close this and open it again.';

/** What the save schema answers with. The form shows the same three sentences. */
export const FEEDBACK_INPUT_MESSAGES = {
  rating: 'Choose a rating from 1 to 5.',
  recommendation: 'Choose a recommendation.',
  comments: 'Keep the comments under 2,000 characters.',
} as const;

const NOT_FOUND = 'That interview could not be found. It may have been deleted with its application.';
const FORBIDDEN = 'You do not have permission to make changes here.';
/** One sentence for each word that has one. The `invalid_…` words have none: no screen or tool can send what they refuse. */
const SENTENCES: Record<'save' | 'clear', Record<string, string>> = {
  save: {
    not_found: NOT_FOUND,
    forbidden: FORBIDDEN,
    not_completed: 'Feedback is for a completed interview. Mark this one completed first.',
    has_feedback: 'This interview already has feedback. Open it to edit it.',
    changed: 'The feedback on this interview was changed a moment ago. Nothing was saved. Check it and try again.',
  },
  clear: {
    not_found: NOT_FOUND,
    forbidden: FORBIDDEN,
    no_feedback: 'This interview has no feedback to clear.',
  },
};

/**
 * What the person is told for a word one of the two feedback functions
 * answered with. Any other word, an error or no answer: the generic sentence.
 * (`has_feedback` from "mark as scheduled again" is that function's word, and
 * is said by `interviewMessage`.)
 */
export function feedbackMessage(word: unknown, doing: 'save' | 'clear'): string {
  const known = SENTENCES[doing];
  return typeof word === 'string' && Object.hasOwn(known, word) ? known[word] : FEEDBACK_SAVE_FAILED;
}

// ─── after a change ──────────────────────────────────────────────────────────

/** The name, or words that stand in for it when the row could not be read back. */
const whoIs = (name: string) => name.trim() || 'the candidate';

/**
 * The sentence after a save. `how` is what the database answered, never what
 * was sent: `replaced` when feedback was there before, `completed` when this
 * save is what marked the interview completed.
 */
export function savedFeedbackMessage(name: string, feedback: Rated, how: { replaced: boolean; completed: boolean }): string {
  const said = `${ratingWords(feedback.rating)}, ${feedback.recommendation}.`;
  if (how.completed) return `Marked the interview with ${whoIs(name)} as completed and saved feedback: ${said}`;
  return how.replaced
    ? `Replaced the feedback on the interview with ${whoIs(name)}: ${said}`
    : `Saved feedback on the interview with ${whoIs(name)}: ${said}`;
}

export const clearedFeedbackMessage = (name: string): string => `Cleared the feedback on the interview with ${whoIs(name)}.`;

// ─── what a row offers ───────────────────────────────────────────────────────

export type FeedbackMenuItem = 'complete_with_feedback' | 'add_feedback' | 'edit_feedback' | 'clear_feedback';

/**
 * The feedback items of a row's menu, in order. A scheduled interview can be
 * completed and given its feedback in one step. A completed one takes
 * feedback, or has its feedback edited or cleared. A cancelled interview and a
 * no-show did not take place, and offer nothing.
 */
export function feedbackMenuFor(status: InterviewStatus, hasFeedback: boolean): FeedbackMenuItem[] {
  if (status === 'scheduled') return ['complete_with_feedback'];
  if (status !== 'completed') return [];
  return hasFeedback ? ['edit_feedback', 'clear_feedback'] : ['add_feedback'];
}

/** True when "Mark as scheduled again" would be refused: a scheduled interview cannot carry feedback. */
export const feedbackBlocksReopen = (status: InterviewStatus, hasFeedback: boolean): boolean => status === 'completed' && hasFeedback;

// ─── what a model is given ───────────────────────────────────────────────────

/** How much of the comments a lookup hands to a model. */
export const COMMENTS_FOR_MODEL = 600;

/**
 * Feedback as a lookup's result carries it: null when there is none. Long
 * comments are cut and `comments_cut` says so. `recorded` is the time it was
 * saved in words, with its date and its year, beside the instant.
 */
export function feedbackForModel(feedback: Feedback | null | undefined): {
  rating: number; recommendation: Recommendation; comments: string | null; comments_cut: boolean; recorded_at: string; recorded: string;
} | null {
  if (!feedback) return null;
  const cut = feedback.comments !== null && feedback.comments.length > COMMENTS_FOR_MODEL;
  return {
    rating: feedback.rating,
    recommendation: feedback.recommendation,
    comments: cut ? `${feedback.comments!.slice(0, COMMENTS_FOR_MODEL)}…` : feedback.comments,
    comments_cut: cut,
    recorded_at: feedback.recorded_at,
    recorded: shortWhen(feedback.recorded_at),
  };
}

// ─── the Approve cards ───────────────────────────────────────────────────────

const DOT = ' · ';
const UNLISTED_INTERVIEW = 'an interview that was not in the list above';
/** Text on one line: a line break in it must not start a line of its own on a card. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The card's title. `who` is "<name> (<job>)" from a lookup in the
 * conversation, or null when the id was in none. Null for a tool that is not
 * one of the two.
 */
export function feedbackCardTitle(tool: string, who: string | null): string | null {
  const interview = who?.trim() ? who.trim() : UNLISTED_INTERVIEW;
  if (tool === 'saveInterviewFeedback') return `Record feedback on the interview with ${interview}?`;
  if (tool === 'clearInterviewFeedback') return `Clear the feedback on the interview with ${interview}?`;
  return null;
}

/** How much of the comments a card's own line shows. The card's list of values holds them whole. */
export const COMMENTS_ON_CARD = 600;

/**
 * The card's second line, from the tool's own input: everything that will be
 * saved, and what the save will not do. The comments are on one line, cut at
 * 600 characters with how many more there are. `basis` is the assistant's
 * grounds for a rating or a recommendation it proposed itself: shown, never
 * stored. Whether the save replaces existing feedback, and whether it also
 * marks the interview completed, are said only when the input says so; a gate
 * makes sure the input says so exactly when it is true
 * (lib/ai/hire-interview-gate.ts). Null for a tool that is not one of the two.
 */
export function feedbackCardDetail(tool: string, input: Record<string, unknown>): string | null {
  if (tool === 'clearInterviewFeedback') return 'The rating, the recommendation and the comments are removed. This cannot be undone.';
  if (tool !== 'saveInterviewFeedback') return null;
  const text = typeof input.comments === 'string' ? oneLine(input.comments) : '';
  const left = text.length - COMMENTS_ON_CARD;
  const comments = !text
    ? 'No comments'
    : left > 0
      ? `Comments: ${text.slice(0, COMMENTS_ON_CARD)}… (and ${left.toLocaleString('en-US')} more ${left === 1 ? 'character' : 'characters'})`
      : `Comments: ${text}`;
  const basis = typeof input.basis === 'string' ? oneLine(input.basis) : '';
  return [
    isRating(input.rating) ? ratingWords(input.rating) : 'No rating given',
    isRecommendation(input.recommendation) ? `Recommendation: ${RECOMMENDATION_LABEL[input.recommendation]}` : 'No recommendation given',
    comments,
    basis ? `Why: ${basis}` : '',
    input.mark_completed === true ? 'Also marks the interview completed.' : '',
    input.replace === true ? 'Replaces the feedback already recorded.' : '',
    'This does not move or reject the application.',
  ].filter(Boolean).join(DOT);
}

const STATUS_NOW: Record<InterviewStatus, string> = { scheduled: 'scheduled', completed: 'completed', cancelled: 'cancelled', no_show: 'a no-show' };

/**
 * "Now: completed · feedback 3 out of 5 · Hold · saved Wed 21 Oct 2026, 10:05:40 am", or "Now: completed · no
 * feedback yet": how the interview stands as the server reads it, for the line a feedback card carries under
 * "This interview: …". The saved time is to the second: when the user's yes arrives, the line is made again and
 * compared, so feedback that was added, changed or cleared since the card stops the change.
 */
export function feedbackNowLine(status: InterviewStatus, feedback: Pick<Feedback, 'rating' | 'recommendation' | 'recorded_at'> | null | undefined): string {
  const has = feedback ? `feedback ${feedbackSummary(feedback)} · saved ${shortWhenToSecond(feedback.recorded_at)}` : 'no feedback yet';
  return `Now: ${STATUS_NOW[status]} · ${has}`;
}
