// src/lib/hire/interviews.ts
/**
 * Interviews in words: the limits, the labels, the sentence for every answer
 * of the six interview functions, the sentences after a change, which items a
 * row's menu offers, and the wording of the Approve cards. Pure: its only
 * imports are types and the time helpers. Client components, the
 * capabilities, the chat cards and the tests all read the same words here.
 */
import { ZONE_LABEL, clock12, durationText, instantMs, klInstant, longDate, shortWhen, timeRange } from './interview-time';
import type { ApplicationOutcome, ApplicationStage, InterviewKind, InterviewStatus } from './types';

// ─── limits and labels ───────────────────────────────────────────────────────

/** The same limits as the checks on `hire_interviews`. */
export const INTERVIEW_LIMITS = { durationMin: 15, durationMax: 480, place: 300, interviewer: 120, notes: 2000 } as const;
export const INTERVIEW_KINDS = ['video', 'onsite', 'phone'] as const;
/** What an interview that was held, or should have been, can be marked as. */
export const INTERVIEW_OUTCOMES = ['completed', 'no_show'] as const;
export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number];

/** The type as a person reads it, in the form, the invitation and the cards. */
export const KIND_WORDS: Record<InterviewKind, string> = { video: 'Video call', onsite: 'In person', phone: 'Phone call' };
/** The label of the place line in the invitation and on a card: it follows the type. */
export const PLACE_LABEL: Record<InterviewKind, string> = { video: 'Link', onsite: 'Place', phone: 'Details' };
/** The lengths the form offers, in minutes. A stored length that is not here is added as its own option. */
export const DURATION_CHOICES = [15, 30, 45, 60, 90, 120, 180, 240] as const;

const OUTCOME_WORDS: Record<InterviewOutcome, string> = { completed: 'Completed', no_show: 'No-show' };

// ─── refusals ────────────────────────────────────────────────────────────────

export const INTERVIEW_SAVE_FAILED = 'That change could not be saved. Please try again.';
export const INTERVIEW_NOT_SENT = 'That change could not be sent. Check your connection and try again.';
export const INTERVIEW_NOT_READ_BACK = 'Saved. The interview could not be read back, so some details are not shown.';

/**
 * What the six input schemas answer with. All but `time` are sentences the
 * form shows too. `time` is what a model is told for a time such as "9:5" or
 * "3pm": no form can send one.
 */
export const INTERVIEW_INPUT_MESSAGES = {
  date: 'Use a real date, like 2026-10-31.',
  time: 'Give the time as HH:MM in 24-hour form, like 15:00.',
  together: 'Give the date and the time together.',
  length: 'Choose a length between 15 minutes and 8 hours.',
  place: 'Keep this under 300 characters.',
  interviewer: 'Keep the interviewer\'s name under 120 characters.',
  notes: 'Keep the notes under 2,000 characters.',
  outcome: 'Choose what happened.',
} as const;

const NOT_FOUND = {
  application: 'That application could not be found. It may have been deleted.',
  interview: 'That interview could not be found. It may have been deleted with its application.',
} as const;

/** One sentence for each word that has one. The `invalid_…` words have none: no screen or tool can send what they refuse. */
const SENTENCES: Record<string, string> = {
  forbidden: 'You do not have permission to make changes here.',
  not_active: 'This application is no longer active. Reopen it before scheduling or changing an interview.',
  in_past: 'That time has already passed in Kuala Lumpur. Choose a later one, or use “Record a past interview” if it already took place.',
  too_far_ahead: 'Choose a date within the next 12 months.',
  duplicate: 'This application already has an interview at that time.',
  not_scheduled: 'This interview is no longer scheduled. Mark it as scheduled again first.',
  not_closed: 'This interview is already scheduled.',
  unchanged: 'Nothing was changed: the interview already has these details.',
  changed: 'This interview was changed a moment ago. Nothing was saved. Check it and try again.',
  not_past: 'That time has not passed yet in Kuala Lumpur. To plan an interview, use “Schedule interview”.',
  too_far_back: 'Choose a date within the last 12 months.',
  has_feedback: 'This interview has feedback. Clear the feedback before marking it as scheduled again.',
};

/**
 * What the person is told for a word one of the six functions answered with.
 * `on` is what the id that was sent names: an application (scheduling, and
 * recording a past interview) or an interview (the other four). Any other
 * word, an error or no answer: the generic sentence.
 */
export function interviewMessage(word: unknown, on: 'application' | 'interview'): string {
  if (word === 'not_found') return NOT_FOUND[on];
  return typeof word === 'string' && Object.hasOwn(SENTENCES, word) ? SENTENCES[word] : INTERVIEW_SAVE_FAILED;
}

// ─── after a change ──────────────────────────────────────────────────────────

/** The name, or words that stand in for it when the row could not be read back. */
const whoIs = (name: string) => name.trim() || 'the candidate';
const NOTHING_SENT = 'Nothing has been sent to them.';

export function scheduledMessage(name: string, iso: string): string {
  return `Scheduled an interview with ${whoIs(name)} for ${longDate(iso)}, ${clock12(iso)}. ${NOTHING_SENT}`;
}

/** `iso` is null when the time was not part of the change and the row could not be read back. */
export function updatedMessage(name: string, iso: string | null): string {
  return iso
    ? `Updated the interview with ${whoIs(name)}. It is on ${longDate(iso)}, ${clock12(iso)}. ${NOTHING_SENT}`
    : `Updated the interview with ${whoIs(name)}. ${NOTHING_SENT}`;
}

export function cancelledMessage(name: string): string {
  return `Cancelled the interview with ${whoIs(name)}. ${NOTHING_SENT}`;
}

export function outcomeMessage(name: string, outcome: InterviewOutcome): string {
  return `Marked the interview with ${whoIs(name)} as ${outcome === 'completed' ? 'completed' : 'a no-show'}.`;
}

export function reopenedMessage(name: string): string {
  return `The interview with ${whoIs(name)} is scheduled again.`;
}

export function recordedPastMessage(name: string, iso: string, outcome: InterviewOutcome): string {
  const when = `${longDate(iso)}, ${clock12(iso)}`;
  return outcome === 'completed'
    ? `Recorded a completed interview with ${whoIs(name)} on ${when}. No invitation was made.`
    : `Recorded a no-show for the interview with ${whoIs(name)} on ${when}.`;
}

/** Added to the sentence after a rejection or a withdrawal. Empty when there is nothing ahead. */
export function stillScheduledMessage(name: string, count: number): string {
  if (!Number.isInteger(count) || count < 1) return '';
  return count === 1
    ? `1 interview with ${whoIs(name)} is still scheduled. Cancel it on the Interviews screen if it should not go ahead.`
    : `${count} interviews with ${whoIs(name)} are still scheduled. Cancel them on the Interviews screen if they should not go ahead.`;
}

// ─── what a row offers ───────────────────────────────────────────────────────

export type InterviewMenuItem = 'edit' | 'invitation' | 'completed' | 'no_show' | 'cancel' | 'reopen';

/**
 * The items of a row's menu, in order. A scheduled interview can be edited
 * only while its application is active (the function would refuse it
 * otherwise), and can always be marked or cancelled. A closed one offers the
 * undo alone.
 */
export function menuFor(status: InterviewStatus, applicationOutcome: ApplicationOutcome): InterviewMenuItem[] {
  if (status !== 'scheduled') return ['reopen'];
  const rest: InterviewMenuItem[] = ['invitation', 'completed', 'no_show', 'cancel'];
  return applicationOutcome === 'active' ? ['edit', ...rest] : rest;
}

// ─── when there is no invitation ─────────────────────────────────────────────

/** Added to a success sentence when the interview was saved after its start: why nothing is offered to hand over. */
export const STARTED_ALREADY = 'Its start has already passed, so there is no invitation or calendar file.';
/** A success sentence with that explanation after it. */
export const withNoInvitation = (message: string): string => `${message} ${STARTED_ALREADY}`;

/** What is said when the invitation could not be read or built. Nothing was changed, so it does not speak of saving. */
export const INVITATION_NOT_MADE = 'The invitation could not be made just now. Please try again.';

/** What is said when the interview's current details could not be read for a form that was refused as stale. */
export const INTERVIEW_NOT_LOADED = 'The interview could not be loaded just now. Close this and open it again.';

/**
 * What is said when an invitation is asked for and the interview's start has
 * passed. `items` is what that row's menu offers (`menuFor`): only a way out
 * that is really there is named, so "reschedule it" is not said for an
 * interview whose application is rejected or withdrawn.
 */
export function noInvitationMessage(items: readonly InterviewMenuItem[]): string {
  const said = 'This interview\'s start has already passed, so there is no invitation or calendar file for it.';
  if (!items.includes('completed') && !items.includes('no_show')) return said;
  return items.includes('edit') ? `${said} Mark what happened, or reschedule it.` : `${said} Mark what happened.`;
}

/**
 * Whether "Move to Interview" is offered after scheduling: exactly for an
 * active application at Applied or Screening, where the move is a forward one
 * and will be accepted. Not at Interview (already there), Offer (a step back
 * nobody means) or Hired (two steps back, refused).
 */
export function offerMoveToInterview(stage: ApplicationStage, outcome: ApplicationOutcome): boolean {
  return outcome === 'active' && (stage === 'applied' || stage === 'screening');
}

/** A scheduled interview whose start has passed: someone has to say what happened. */
export function needsOutcome(status: InterviewStatus, scheduledAt: string, now: Date): boolean {
  return status === 'scheduled' && instantMs(scheduledAt) < now.getTime();
}

// ─── the Approve cards ───────────────────────────────────────────────────────

/** "Tue 20 Oct 2026, 3:00 pm · video": the stored time and the stored type, as the card's identifying line. */
export function interviewLine(iso: string, kind: InterviewKind): string {
  return `${shortWhen(iso)} · ${kind}`;
}
export const THIS_INTERVIEW = (line: string) => `This interview: ${line}`;

const DOT = ' · ';

/** A name, a title or a place on one line: a line break in it must not start a line of its own on a card. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * "Tue 20 Oct 2026, 3:00 pm · video · 1 hour · Link: https://meet.example.com/abc": the stored interview as a card
 * about it says it, after "This interview:". Its length and its place are there too, so that the person sees what
 * they are changing, and so that a colleague's change of either between the card and the yes is noticed.
 */
export function interviewFullLine(row: { scheduled_at: string; kind: InterviewKind; duration_minutes: number; place: string | null }): string {
  const place = row.place ? oneLine(row.place) : '';
  return [
    interviewLine(row.scheduled_at, row.kind),
    durationText(row.duration_minutes),
    place ? `${PLACE_LABEL[row.kind]}: ${place}` : 'No place or link given',
  ].join(DOT);
}

/** How many other scheduled interviews a card lists before it says how many more there are. */
export const ALSO_SCHEDULED_MAX = 3;

/**
 * What else is scheduled with the same person, for a card about one of their interviews: one line each, at most
 * three, then how many more. One person can rightly have two interviews, and "cancel Aina's" does not say which:
 * the card shows the one it is about, and these lines show the person that there are others.
 */
export function alsoScheduledLines(
  name: string,
  others: readonly { scheduled_at: string; kind: InterviewKind; job: string }[],
): string[] {
  const who = oneLine(name) || 'the candidate';
  const lines = others
    .slice(0, ALSO_SCHEDULED_MAX)
    .map((other) => `Also scheduled for ${who}: ${interviewLine(other.scheduled_at, other.kind)} (${oneLine(other.job)})`);
  const more = others.length - ALSO_SCHEDULED_MAX;
  return more > 0 ? [...lines, `and ${more} more`] : lines;
}

const UNLISTED_APPLICATION = 'an application that was not in the list above';
const UNLISTED_INTERVIEW = 'an interview that was not in the list above';

/**
 * The card's title. `who` is "<name> (<job>)" from a lookup in the
 * conversation, or null when the id was in none. Null for a tool that is not
 * one of the six, and for an outcome that is neither of the two.
 */
export function interviewCardTitle(tool: string, input: Record<string, unknown>, who: string | null): string | null {
  const named = who?.trim() ? who.trim() : null;
  const application = named ?? UNLISTED_APPLICATION;
  const interview = named ?? UNLISTED_INTERVIEW;
  switch (tool) {
    case 'scheduleInterview': return `Schedule an interview with ${application}?`;
    case 'recordPastInterview': return `Record a past interview with ${application}?`;
    case 'rescheduleInterview': return `Change the interview with ${interview}?`;
    case 'cancelInterview': return `Cancel the interview with ${interview}?`;
    case 'setInterviewOutcome':
      if (input.outcome === 'completed') return `Mark the interview with ${interview} as completed?`;
      if (input.outcome === 'no_show') return `Mark the interview with ${interview} as a no-show?`;
      return null;
    case 'reopenInterview': return `Mark the interview with ${interview} as scheduled again?`;
    default: return null;
  }
}

/** A value of the input as text: trimmed, and empty for one that was not sent. */
const sent = (value: unknown) => (typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value));
const isKind = (value: unknown): value is InterviewKind => typeof value === 'string' && (INTERVIEW_KINDS as readonly string[]).includes(value);
const isOutcome = (value: unknown): value is InterviewOutcome =>
  typeof value === 'string' && (INTERVIEW_OUTCOMES as readonly string[]).includes(value);
/** A length the schemas would take, or null. */
const lengthOf = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= INTERVIEW_LIMITS.durationMin && value <= INTERVIEW_LIMITS.durationMax
    ? value
    : null;

/**
 * The date and time of the input in words. `minutes` null: the start alone.
 * A date or a time that cannot be read is shown as it was sent, with no zone
 * claimed for it.
 */
function whenOf(input: Record<string, unknown>, minutes: number | null): string {
  const [date, time] = [sent(input.date), sent(input.time)];
  const iso = klInstant(date, time);
  if (!iso) return [date, time].filter(Boolean).join(', ');
  return `${longDate(iso)}, ${minutes === null ? clock12(iso) : timeRange(iso, minutes)}, ${ZONE_LABEL}`;
}

/** How much of an interview's notes a card shows. */
const NOTES_SHOWN = 300;
/**
 * The notes a change would save, as a card shows them: on one line, cut at 300 characters. Empty when none were
 * sent. No candidate ever reads the notes, but they are saved, and an assistant wrote them: the person who approves
 * must see what they say.
 */
function notesShown(value: unknown): string {
  const text = oneLine(sent(value));
  if (!text) return '';
  return `Notes: ${text.length > NOTES_SHOWN ? `${text.slice(0, NOTES_SHOWN)}…` : text}`;
}

/** The parts of a new interview's card: when, the type, the place and the interviewer always; the notes when there are some. */
function newInterviewParts(input: Record<string, unknown>): { when: string; type: string; place: string; interviewer: string; notes: string } {
  const place = sent(input.place);
  const interviewer = sent(input.interviewer_name);
  return {
    // The schemas give a new interview 60 minutes when no length is sent.
    when: whenOf(input, lengthOf(input.duration_minutes) ?? 60),
    type: isKind(input.kind) ? KIND_WORDS[input.kind] : sent(input.kind),
    place: place ? `${isKind(input.kind) ? PLACE_LABEL[input.kind] : 'Place'}: ${place}` : 'No place or link given',
    interviewer: interviewer ? `With: ${interviewer}` : 'No interviewer given',
    notes: notesShown(input.notes),
  };
}

const has = (input: Record<string, unknown>, key: string) => input[key] !== undefined;

/**
 * The card's second line, from the tool's own input. The notes a change
 * would save are shown, cut at 300 characters. Null when the tool has nothing to add, or is not one
 * of the six.
 */
export function interviewCardDetail(tool: string, input: Record<string, unknown>): string | null {
  switch (tool) {
    case 'scheduleInterview': {
      const p = newInterviewParts(input);
      return [p.when, p.type, p.place, p.interviewer, p.notes, 'Nothing is sent to the candidate.'].filter(Boolean).join(DOT);
    }
    case 'recordPastInterview': {
      const p = newInterviewParts(input);
      const outcome = isOutcome(input.outcome) ? OUTCOME_WORDS[input.outcome] : sent(input.outcome);
      return [p.when, p.type, outcome, p.place, p.interviewer, p.notes, 'Recorded as already held. No invitation is made.'].filter(Boolean).join(DOT);
    }
    case 'rescheduleInterview': {
      const parts: string[] = [];
      const minutes = lengthOf(input.duration_minutes);
      if (has(input, 'date') || has(input, 'time')) parts.push(`New time: ${whenOf(input, minutes)}`);
      if (minutes !== null) parts.push(`Length: ${durationText(minutes)}`);
      if (has(input, 'kind')) parts.push(`Type: ${isKind(input.kind) ? KIND_WORDS[input.kind] : sent(input.kind)}`);
      if (has(input, 'place')) parts.push(`Place or link: ${sent(input.place) || 'cleared'}`);
      if (has(input, 'interviewer_name')) parts.push(`Interviewer: ${sent(input.interviewer_name) || 'cleared'}`);
      if (has(input, 'notes')) parts.push(notesShown(input.notes) || 'Notes: cleared');
      return [...parts, 'Nothing is sent to the candidate.'].join(DOT);
    }
    case 'cancelInterview': return 'It stays in the list as cancelled. Nothing is sent to the candidate.';
    default: return null;
  }
}
