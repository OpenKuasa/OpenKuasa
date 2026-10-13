// src/lib/hire/interview-dialog-state.ts
/**
 * Everything the interview form, the invitation step, the row menu, the cancel
 * confirm and the Applications panel's list decide, as plain functions: the
 * tests run with no DOM, so a decision made inside a component could not be
 * tested. Pure: nothing here reads the clock (a `now` is passed in) and nothing
 * touches the browser.
 */
import { STAGE_LABEL } from './applications-view';
import type { InterviewChange } from './capabilities';
import {
  clock12, durationText, instantMs, isRealDate, klDateOf, klInstant, klTimeOf, longDate, pastProblem, shortWhen, timeProblem,
} from './interview-time';
import {
  DURATION_CHOICES, INTERVIEW_KINDS, INTERVIEW_LIMITS, INTERVIEW_NOT_LOADED, INTERVIEW_NOT_READ_BACK, INTERVIEW_SAVE_FAILED, INVITATION_NOT_MADE,
  KIND_WORDS, interviewMessage, menuFor,
  offerMoveToInterview, stillScheduledMessage, type InterviewMenuItem,
} from './interviews';
import type { InterviewRow, PanelInterview, PickerApplication } from './lists';
import type { InterviewKind } from './types';

// ─── the form's values ───────────────────────────────────────────────────────

export type InterviewFormMode = 'schedule' | 'change' | 'past';
export type PastOutcome = 'completed' | 'no_show';
export type InterviewField =
  | 'application_id' | 'date' | 'time' | 'duration_minutes' | 'kind' | 'outcome' | 'place' | 'interviewer_name' | 'notes';

/**
 * What the form holds. The date and the time are Kuala Lumpur text exactly as
 * the browser's own pickers give it (`2026-10-20`, `15:00`): never an instant,
 * so the browser's zone never touches them. `outcome` is asked only when a
 * past interview is recorded.
 */
export type InterviewFormValues = {
  application_id: string;
  date: string;
  time: string;
  duration_minutes: number;
  kind: InterviewKind;
  outcome: '' | PastOutcome;
  place: string;
  interviewer_name: string;
  notes: string;
};
export type InterviewProblems = Partial<Record<InterviewField, string>>;

/** The order the form shows its fields in: a failed submit takes focus to the first wrong one. */
const FIELD_ORDER: readonly InterviewField[] = [
  'application_id', 'date', 'time', 'duration_minutes', 'kind', 'outcome', 'place', 'interviewer_name', 'notes',
];

/** A blank form, the same in every mode: an hour, by video, nothing else chosen. */
export function emptyValues(): InterviewFormValues {
  return { application_id: '', date: '', time: '', duration_minutes: 60, kind: 'video', outcome: '', place: '', interviewer_name: '', notes: '' };
}

/** A stored interview as the form shows it. The interviewer is the stored name, not the dash the table draws for none. */
export function valuesFrom(row: InterviewRow): InterviewFormValues {
  return {
    application_id: row.applicationId,
    date: klDateOf(row.scheduledAt),
    time: klTimeOf(row.scheduledAt),
    duration_minutes: row.durationMinutes,
    kind: row.kind,
    outcome: '',
    place: row.place ?? '',
    interviewer_name: row.interviewerName ?? '',
    notes: row.notes ?? '',
  };
}

// ─── the checks ──────────────────────────────────────────────────────────────

export const CHOOSE_APPLICATION = 'Choose an application.';
export const CHOOSE_DATE = 'Choose a date.';
export const REAL_DATE = 'Use a real date, like 2026-10-31.';
export const CHOOSE_TIME = 'Choose a time.';
export const BAD_LENGTH = 'Choose a length between 15 minutes and 8 hours.';
export const PLACE_TOO_LONG = 'Keep this under 300 characters.';
export const INTERVIEWER_TOO_LONG = 'Keep the interviewer\'s name under 120 characters.';
export const NOTES_TOO_LONG = 'Keep the notes under 2,000 characters.';
export const CHOOSE_OUTCOME = 'Choose what happened.';
export const NOTHING_CHANGED = 'Nothing has been changed yet.';

/** Characters as the database counts them, after the ends are trimmed as the database trims them. */
const length = (text: string) => Array.from(text.trim()).length;

/**
 * What is wrong, by field, before anything is sent. The server and the
 * database check again; these only save a round trip, and their sentences about
 * the clock are the server's own.
 *
 * `stored` is the form's starting values when an interview is being changed:
 * a time that was left as it was is not checked against the clock, so the notes
 * of an interview that began an hour ago can still be edited.
 */
export function interviewProblems(
  values: InterviewFormValues,
  now: Date,
  opts: { mode: InterviewFormMode; picking: boolean; stored?: InterviewFormValues },
): InterviewProblems {
  const found: InterviewProblems = {};
  if (opts.picking && !values.application_id) found.application_id = CHOOSE_APPLICATION;

  if (!values.date) found.date = CHOOSE_DATE;
  else if (!isRealDate(values.date)) found.date = REAL_DATE;
  if (!values.time) found.time = CHOOSE_TIME;
  if (!found.date && !found.time) {
    const iso = klInstant(values.date, values.time);
    if (!iso) {
      // The date is a real day, so it is the time that cannot be read.
      found.time = CHOOSE_TIME;
    } else {
      const moved = !opts.stored || opts.stored.date !== values.date || opts.stored.time !== values.time;
      const word = opts.mode === 'past' ? pastProblem(iso, now) : opts.mode === 'schedule' || moved ? timeProblem(iso, now) : null;
      if (word) found.date = interviewMessage(word, 'application');
    }
  }

  const minutes = values.duration_minutes;
  if (!Number.isInteger(minutes) || minutes < INTERVIEW_LIMITS.durationMin || minutes > INTERVIEW_LIMITS.durationMax) {
    found.duration_minutes = BAD_LENGTH;
  }
  if (opts.mode === 'past' && values.outcome === '') found.outcome = CHOOSE_OUTCOME;
  if (length(values.place) > INTERVIEW_LIMITS.place) found.place = PLACE_TOO_LONG;
  if (length(values.interviewer_name) > INTERVIEW_LIMITS.interviewer) found.interviewer_name = INTERVIEWER_TOO_LONG;
  if (length(values.notes) > INTERVIEW_LIMITS.notes) found.notes = NOTES_TOO_LONG;
  return found;
}

/** The first wrong field in the order the form shows them, whatever order the checks found them in. */
export function firstWrongField(problems: InterviewProblems): InterviewField | null {
  return FIELD_ORDER.find((field) => problems[field]) ?? null;
}

// ─── what is sent ────────────────────────────────────────────────────────────

export type ScheduleInput = {
  application_id: string; date: string; time: string; duration_minutes: number; kind: InterviewKind;
  place?: string; interviewer_name?: string; notes?: string;
};
export type PastInput = ScheduleInput & { outcome: PastOutcome };
/** Only what differs from what is stored. `null` clears a place, an interviewer or the notes. */
export type InterviewChanges = Partial<{
  date: string; time: string; duration_minutes: number; kind: InterviewKind;
  place: string | null; interviewer_name: string | null; notes: string | null;
}>;

/** What scheduling sends. A blank detail is left out: nobody gave it, and the invitation then has no such line. */
export function scheduleInput(values: InterviewFormValues, applicationId: string): ScheduleInput {
  const input: ScheduleInput = {
    application_id: applicationId, date: values.date, time: values.time, duration_minutes: values.duration_minutes, kind: values.kind,
  };
  const place = values.place.trim();
  const interviewer = values.interviewer_name.trim();
  const notes = values.notes.trim();
  if (place) input.place = place;
  if (interviewer) input.interviewer_name = interviewer;
  if (notes) input.notes = notes;
  return input;
}

/** What recording a past interview sends, or null while what happened is not chosen. */
export function pastInput(values: InterviewFormValues, applicationId: string): PastInput | null {
  if (values.outcome === '') return null;
  return { ...scheduleInput(values, applicationId), outcome: values.outcome };
}

/**
 * What a change sends: only the fields that differ from what the form opened
 * with, or null when none does. The date and the time travel together (the
 * server refuses one without the other). Spaces at the ends are not a change.
 */
export function changesFrom(stored: InterviewFormValues, values: InterviewFormValues): InterviewChanges | null {
  const changes: InterviewChanges = {};
  if (values.date !== stored.date || values.time !== stored.time) {
    changes.date = values.date;
    changes.time = values.time;
  }
  if (values.duration_minutes !== stored.duration_minutes) changes.duration_minutes = values.duration_minutes;
  if (values.kind !== stored.kind) changes.kind = values.kind;
  for (const field of ['place', 'interviewer_name', 'notes'] as const) {
    const next = values[field].trim();
    if (next !== stored[field].trim()) changes[field] = next === '' ? null : next;
  }
  return Object.keys(changes).length === 0 ? null : changes;
}

export type Submission =
  | { kind: 'schedule'; input: ScheduleInput }
  | { kind: 'past'; input: PastInput }
  | { kind: 'change'; input: { id: string } & InterviewChanges; seen: string }
  | { kind: 'nothing' };

/**
 * What a submit that passed its checks does. `stored` is the row as it was
 * when the form opened: its `updatedAt` goes along as `seen`, so a row a
 * colleague has changed since is not silently replaced. `nothing` sends
 * nothing: the form then says "Nothing has been changed yet."
 */
export function submission(
  mode: InterviewFormMode,
  values: InterviewFormValues,
  target: { applicationId: string; stored: InterviewRow | null },
): Submission {
  if (mode === 'schedule') return { kind: 'schedule', input: scheduleInput(values, target.applicationId) };
  if (mode === 'past') {
    const input = pastInput(values, target.applicationId);
    return input ? { kind: 'past', input } : { kind: 'nothing' };
  }
  if (!target.stored) return { kind: 'nothing' };
  const changes = changesFrom(valuesFrom(target.stored), values);
  if (!changes) return { kind: 'nothing' };
  return { kind: 'change', input: { id: target.stored.id, ...changes }, seen: target.stored.updatedAt };
}

/** Whether closing would lose something typed. */
export function isDirty(initial: InterviewFormValues, values: InterviewFormValues): boolean {
  return FIELD_ORDER.some((field) => values[field] !== initial[field]);
}

/** One send at a time: a second press while the first is being saved does nothing. */
export const canSubmit = (busy: boolean): boolean => !busy;
/** Escape, Cancel and a click outside do nothing while a change is being saved. */
export const mayClose = (busy: boolean): boolean => !busy;

// ─── the form's words ────────────────────────────────────────────────────────

export function dialogTitle(mode: InterviewFormMode, name: string | null): string {
  if (mode === 'change') return `Change the interview with ${name ?? ''}`.trim();
  const base = mode === 'past' ? 'Record a past interview' : 'Schedule an interview';
  return name ? `${base} with ${name}` : base;
}

const SCHEDULE_DESCRIPTION = 'Nothing is sent to the candidate: you get an invitation to copy afterwards.';
const PAST_DESCRIPTION = 'For an interview that already took place. Nothing is sent and no invitation is made.';

/** Under the title. It begins with the job once one is known: from a card, a panel or a row at once, from the header when an application is chosen. */
export function dialogDescription(mode: InterviewFormMode, job: string | null): string {
  const rest = mode === 'past' ? PAST_DESCRIPTION : SCHEDULE_DESCRIPTION;
  return job ? `For ${job}. ${rest}` : rest;
}

export function submitLabel(mode: InterviewFormMode, busy: boolean): string {
  if (mode === 'change') return busy ? 'Saving…' : 'Save changes';
  if (mode === 'past') return busy ? 'Recording…' : 'Record interview';
  return busy ? 'Scheduling…' : 'Schedule interview';
}

export const discardTitle = (mode: InterviewFormMode): string => (mode === 'change' ? 'Discard your changes?' : 'Discard this interview?');
export const dateHelper = (mode: InterviewFormMode): string => (mode === 'past' ? 'The day it took place, in Kuala Lumpur.' : 'In Kuala Lumpur.');
export const timeHelper = (mode: InterviewFormMode): string =>
  (mode === 'past' ? 'When it started, Kuala Lumpur time (GMT+8).' : 'Kuala Lumpur time (GMT+8).');
/** No invitation is made for a past interview, so its helper does not mention one. */
export const placeHelper = (mode: InterviewFormMode): string => (mode === 'past' ? 'Optional.' : 'Optional. Shown in the invitation.');
export const INTERVIEWER_HELP = 'Optional. A name, as you want the candidate to read it.';
export const NOTES_HELP = 'Optional. For your team only: never in the invitation.';
export const OUTCOME_HELP = 'Completed if the interview took place. No-show if the candidate did not turn up.';
export const FIND_HELP = 'Type a name or a job.';

const PLACE_FIELD: Record<InterviewKind, string> = { video: 'Meeting link', onsite: 'Place', phone: 'Phone number or details' };
/** The place field's label follows the type. */
export const placeLabel = (kind: InterviewKind): string => PLACE_FIELD[kind];

/**
 * The date picker's bound. `today` is today in Kuala Lumpur, worked out on the
 * server: the browser's own "today" can be another day. A hint only; the
 * server checks the instant against its own clock.
 */
export function dateBounds(mode: InterviewFormMode, today: string): { min?: string; max?: string } {
  if (!today) return {};
  return mode === 'past' ? { max: today } : { min: today };
}

/** The eight lengths on offer, and a stored length that is not among them, in its place. */
export function durationOptions(stored: number | null): { value: number; label: string }[] {
  const minutes: number[] = [...DURATION_CHOICES];
  if (stored !== null && !minutes.includes(stored)) minutes.push(stored);
  return minutes.sort((a, b) => a - b).map((value) => ({ value, label: durationText(value) }));
}

// ─── the application picker ──────────────────────────────────────────────────

export const PICKER_MAX = 200;
export type PickerOption = { id: string; label: string };

const CLOSED_WORD = { rejected: 'Rejected', withdrawn: 'Withdrawn' } as const;

/** "Aina Rahman — Sales Executive (Screening)"; a closed application says its outcome instead of its stage. */
export function pickerLabel(a: PickerApplication): string {
  return `${a.name} — ${a.job} (${a.outcome === 'active' ? STAGE_LABEL[a.stage] : CLOSED_WORD[a.outcome]})`;
}

/** Scheduling is for an active application. A past interview can be recorded for any. */
const offered = (applications: PickerApplication[], mode: InterviewFormMode) =>
  (mode === 'past' ? applications : applications.filter((a) => a.outcome === 'active'));

/** Alphabetical without regard to letter case, so "aina" and "Aina" sort together and the job then decides. */
const byWords = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/** The options the select draws: those that match, by name then job, cut at 200. `more` says the cut left some out. */
export function pickerOptions(
  applications: PickerApplication[],
  query: string,
  mode: InterviewFormMode,
): { options: PickerOption[]; more: boolean } {
  const q = query.trim().toLowerCase();
  const matches = offered(applications, mode)
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.job.toLowerCase().includes(q))
    .sort((a, b) => byWords(a.name, b.name) || byWords(a.job, b.job));
  return { options: matches.slice(0, PICKER_MAX).map((a) => ({ id: a.id, label: pickerLabel(a) })), more: matches.length > PICKER_MAX };
}

/** What the list cannot show, each as its own sentence or null. `cut` is true when the read reached its 1,000 rows. */
export function pickerNotes(
  applications: PickerApplication[],
  query: string,
  mode: InterviewFormMode,
  cut: boolean,
): { none: string | null; noMatch: string | null; more: string | null; cut: string | null } {
  const past = mode === 'past';
  const empty = offered(applications, mode).length === 0;
  const { options, more } = pickerOptions(applications, query, mode);
  return {
    none: empty ? (past ? 'There are no applications to record an interview for.' : 'There are no active applications to schedule for.') : null,
    noMatch: !empty && options.length === 0 ? (past ? 'No application matches.' : 'No active application matches.') : null,
    more: more ? 'Showing the first 200. Type more of the name.' : null,
    cut: cut
      ? `Only the newest 1,000 applications are listed here. If the one you want is missing, ${past ? 'record it' : 'schedule'} from its row on the Applications screen.`
      : null,
  };
}

/** The chosen application once the list has been narrowed: kept while it is still drawn, otherwise nothing is chosen. */
export const keptChoice = (options: PickerOption[], id: string): string => (options.some((option) => option.id === id) ? id : '');

// ─── what an action answered ─────────────────────────────────────────────────

/** An action's answer as the screen uses it. Anything malformed (a throw is passed as null) fails closed. */
export function interviewResult(result: unknown): { ok: true; change: InterviewChange } | { ok: false; error: string } {
  const failed = { ok: false as const, error: INTERVIEW_SAVE_FAILED };
  if (!result || typeof result !== 'object') return failed;
  const answer = result as { ok?: unknown; data?: unknown; error?: unknown };
  if (answer.ok === false) return typeof answer.error === 'string' && answer.error ? { ok: false, error: answer.error } : failed;
  if (answer.ok !== true || !answer.data || typeof answer.data !== 'object') return failed;
  const data = answer.data as { id?: unknown; message?: unknown; confirmed?: unknown };
  if (typeof data.id !== 'string' || typeof data.message !== 'string' || typeof data.confirmed !== 'boolean') return failed;
  return { ok: true, change: answer.data as InterviewChange };
}

/** The sentence for the screen's notice line. A change that could not be read back has no name to put in its sentence, so the note stands alone. */
export const noticeOf = (change: InterviewChange): string =>
  (change.confirmed ? change.message : change.note ?? INTERVIEW_NOT_READ_BACK);

/** Every word a database function or a capability check can refuse with that the screen treats differently from "try again". */
const REFUSAL_WORDS = [
  'not_found', 'forbidden', 'not_active', 'in_past', 'too_far_ahead', 'duplicate', 'not_scheduled', 'not_closed', 'unchanged', 'changed',
  'not_past', 'too_far_back',
] as const;

/** A form about an application (scheduling, recording) or about an interview (changing): `not_found` reads differently. */
export const onOf = (mode: InterviewFormMode): 'application' | 'interview' => (mode === 'change' ? 'interview' : 'application');

/**
 * The word a refusal was made from. An action answers with the sentence, so the
 * word is found by comparing it with the sentence each word gives: no sentence
 * is typed twice. Null for the generic one and for anything else.
 */
export function refusalWord(error: string, on: 'application' | 'interview'): string | null {
  if (!error) return null;
  return REFUSAL_WORDS.find((word) => interviewMessage(word, on) === error) ?? null;
}

/** The field a refusal is shown at and takes focus to. Null: the alert at the top of the form. */
export function fieldOfRefusal(word: string | null): InterviewField | null {
  if (word === 'in_past' || word === 'too_far_ahead' || word === 'not_past' || word === 'too_far_back') return 'date';
  if (word === 'duplicate') return 'time';
  return null;
}

/**
 * Whether the screen is fetched again after a refusal: when it means the
 * screen is out of date, and when the refusal cannot be named (the change may
 * in fact have happened, and the fresh row shows whether it did).
 */
export function refreshAfter(word: string | null): boolean {
  return word === null || word === 'changed' || word === 'not_found' || word === 'not_scheduled' || word === 'not_active';
}

/** A row that has gone takes its own refusal line with it, so that refusal is said on the notice line instead. */
export const sayOnNotice = (word: string | null): boolean => word === 'not_found';

/**
 * Whether every one of these times is an instant: text that says its own zone.
 * A time with no zone would be read in the machine's own, so nothing that goes
 * to a candidate (the invitation, the calendar file) is made from one.
 */
const allInstants = (...times: (string | null)[]): boolean => times.every((time) => time !== null && !Number.isNaN(instantMs(time)));

/**
 * What follows a save. The invitation step only after scheduling or changing,
 * and only with an invitation to show for a start that is an instant. Never
 * for a past interview: nothing is handed to a candidate for something that
 * already happened.
 */
export function stepAfter(mode: InterviewFormMode, change: Pick<InterviewChange, 'invitation' | 'scheduled_at'>): 'invitation' | 'done' {
  if (mode === 'past' || !allInstants(change.scheduled_at)) return 'done';
  return typeof change.invitation === 'string' && change.invitation !== '' ? 'invitation' : 'done';
}

/**
 * The time now, by the server's clock: the instant the server drew the page
 * with, plus how long the browser has had it. Only the DIFFERENCE of two
 * browser readings is used, so a browser clock that is hours wrong (or in
 * another zone) changes nothing. `receivedMs` is the browser's reading when
 * the page arrived (null: not yet noted, so no time has passed). A server
 * instant that cannot be read gives an invalid date, which the form's checks
 * then refuse a time against.
 */
export function clockAt(serverNow: string, receivedMs: number | null, browserMs: number): Date {
  const elapsed = receivedMs === null ? 0 : Math.max(0, browserMs - receivedMs);
  return new Date(instantMs(serverNow) + elapsed);
}
// ─── a form whose copy of the interview has gone stale ───────────────────────

/** The interview as it is stored now: what the edit form holds, and when the row was last changed. */
export type CurrentInterview = {
  scheduledAt: string; durationMinutes: number; kind: InterviewKind; place: string | null; interviewerName: string | null;
  notes: string | null; updatedAt: string;
};

const textOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

/**
 * The answer of the action that reads an interview for its edit form, after a
 * save was refused as stale. Only for the interview the form is about, only
 * while it is still scheduled, and only whole: anything else fails closed, so
 * a form is never refilled with half an interview.
 */
export function currentResult(answer: unknown, id: string): { ok: true; current: CurrentInterview } | { ok: false; error: string } {
  const failed = { ok: false as const, error: INTERVIEW_NOT_LOADED };
  if (!answer || typeof answer !== 'object') return failed;
  const said = answer as { ok?: unknown; data?: unknown; error?: unknown };
  if (said.ok === false) return typeof said.error === 'string' && said.error ? { ok: false, error: said.error } : failed;
  if (said.ok !== true || !said.data || typeof said.data !== 'object') return failed;
  const d = said.data as Record<string, unknown>;
  const kind = INTERVIEW_KINDS.find((known) => known === d.kind);
  if (d.id !== id || d.status !== 'scheduled' || !kind) return failed;
  if (typeof d.scheduled_at !== 'string' || Number.isNaN(instantMs(d.scheduled_at))) return failed;
  if (typeof d.updated_at !== 'string' || d.updated_at === '') return failed;
  if (typeof d.duration_minutes !== 'number' || !Number.isInteger(d.duration_minutes)) return failed;
  if (!textOrNull(d.place) || !textOrNull(d.interviewer_name) || !textOrNull(d.notes)) return failed;
  return {
    ok: true,
    current: {
      scheduledAt: d.scheduled_at, durationMinutes: d.duration_minutes, kind, place: d.place, interviewerName: d.interviewer_name,
      notes: d.notes, updatedAt: d.updated_at,
    },
  };
}

const KIND_SHORT: Record<InterviewKind, InterviewRow['type']> = { video: 'Video', onsite: 'Onsite', phone: 'Phone' };
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "22 Oct 2026", as a row's Date column has it, from a Kuala Lumpur date. */
function rowDate(klDate: string): string {
  const [year, month, day] = klDate.split('-');
  return `${day} ${MONTHS_SHORT[Number(month) - 1] ?? ''} ${year}`;
}

/**
 * The row an edit form is opened afresh with after the person chose to load
 * the current details: whose interview it is stays, everything that can be
 * edited and `updatedAt` (the next save's `seen`) are the stored ones. The
 * place is given no link: a link is only ever made on the server.
 */
export function rowWithCurrent(row: InterviewRow, current: CurrentInterview): InterviewRow {
  return {
    ...row,
    scheduledAt: current.scheduledAt,
    date: rowDate(klDateOf(current.scheduledAt)),
    time: clock12(current.scheduledAt),
    durationMinutes: current.durationMinutes,
    length: durationText(current.durationMinutes),
    kind: current.kind,
    type: KIND_SHORT[current.kind],
    place: current.place,
    placeLink: null,
    interviewer: current.interviewerName ?? '—',
    interviewerName: current.interviewerName,
    notes: current.notes,
    updatedAt: current.updatedAt,
  };
}

/**
 * Whether the form offers "Load the current details": only after the refusal
 * that says someone else changed the interview, only once those details were
 * read, and not while something is being saved. Nothing is ever sent again by
 * itself: the person sees the current values first and saves again themselves.
 */
export const offersReload = (word: string | null, loaded: boolean, pending: boolean): boolean => word === 'changed' && loaded && !pending;
export const LOAD_CURRENT = 'Load the current details';
export const LOAD_CURRENT_HELP = 'This replaces what you typed with the interview as it is now. Nothing is saved until you save again.';

export type FieldPart = InterviewField | 'find' | 'alert' | 'copy' | 'unchanged' | 'reload';
/** The DOM id of a part of the form: `base` is the form's own `useId`. */
export const fieldId = (base: string, part: FieldPart): string => `${base}-${part}`;

export type FocusMoment =
  | { after: 'open'; picking: boolean }
  | { after: 'check'; problems: InterviewProblems }
  | { after: 'refusal'; word: string | null }
  | { after: 'saved' };

/**
 * Where focus goes. On opening: the first field. After a failed check: the
 * first wrong field (null when nothing is wrong). After a refusal: its field,
 * else the alert. After a save that shows the invitation: "Copy invitation".
 */
export function focusIdAfter(moment: FocusMoment, base: string): string | null {
  if (moment.after === 'open') return fieldId(base, moment.picking ? 'find' : 'date');
  if (moment.after === 'check') {
    const wrong = firstWrongField(moment.problems);
    return wrong ? fieldId(base, wrong) : null;
  }
  if (moment.after === 'refusal') return fieldId(base, fieldOfRefusal(moment.word) ?? 'alert');
  return fieldId(base, 'copy');
}

// ─── the invitation step ─────────────────────────────────────────────────────

const INVITE_TITLE = { schedule: 'Interview scheduled', change: 'Interview updated', row: 'Invitation' } as const;
export const inviteTitle = (from: 'schedule' | 'change' | 'row'): string => INVITE_TITLE[from];
export const inviteLead = (name: string): string => `Nothing has been sent. Copy this into your own email or message to ${name}.`;
export const copyLabel = (copied: boolean): string => (copied ? 'Copied' : 'Copy invitation');
export const COPY_FAILED = 'Couldn\'t copy. Select the text above and copy it yourself.';
export const DOWNLOAD_LABEL = 'Download calendar file (.ics)';
export const DOWNLOAD_HELP = 'Opens in most calendar apps. Attach it to your message so the candidate gets a reminder from their own calendar.';
export const ICS_MIME = 'text/calendar;charset=utf-8';
export const MOVED = 'Moved to Interview.';
export const DONE = 'Done';
export const moveLabel = (busy: boolean): string => (busy ? 'Moving…' : 'Move to Interview');

/**
 * A calendar file as the browser is given it: a name and the content, both
 * made on the server. The browser saves it as it is and never builds one: a
 * row on a screen can be stale, and a file made from it would hand a candidate
 * a time that is no longer true.
 */
export type CalendarFile = { name: string; content: string };
/** What the server made for a row's "Invitation and calendar file": the text to copy and the file to download. */
export type Handover = { text: string; file: CalendarFile };

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The answer of the action that makes a row's invitation. Anything malformed (a throw is passed as null) fails closed. */
export function handoverResult(answer: unknown): { ok: true; handover: Handover } | { ok: false; error: string } {
  const failed = { ok: false as const, error: INVITATION_NOT_MADE };
  if (!answer || typeof answer !== 'object') return failed;
  const said = answer as { ok?: unknown; data?: unknown; error?: unknown };
  if (said.ok === false) return filled(said.error) ? { ok: false, error: said.error } : failed;
  if (said.ok !== true || !said.data || typeof said.data !== 'object') return failed;
  const { text, ics, fileName } = said.data as { text?: unknown; ics?: unknown; fileName?: unknown };
  if (!filled(text) || !filled(ics) || !filled(fileName)) return failed;
  return { ok: true, handover: { text, file: { name: fileName, content: ics } } };
}

/** The calendar file that came beside a saved change (the action's `calendar`), or null when none did. */
export function calendarOf(change: unknown): CalendarFile | null {
  if (!change || typeof change !== 'object') return null;
  const { calendar } = change as { calendar?: unknown };
  if (!calendar || typeof calendar !== 'object') return null;
  const { ics, fileName } = calendar as { ics?: unknown; fileName?: unknown };
  return filled(ics) && filled(fileName) ? { name: fileName, content: ics } : null;
}

/** A row's invitation: not asked for, being fetched from the server, or showing in its panel. */
export type HandoverState = 'idle' | 'loading' | 'shown';
/** One request at a time: not while one is loading or showing, and not while a change to the row is being saved. */
export const mayAskHandover = (state: HandoverState, busy: boolean): boolean => state === 'idle' && !busy;
/** What each moment does to it. An answer nobody is waiting for opens nothing. */
export function handoverAfter(state: HandoverState, event: 'ask' | 'made' | 'refused' | 'closed'): HandoverState {
  if (event === 'ask') return state === 'idle' ? 'loading' : state;
  if (event === 'made') return state === 'loading' ? 'shown' : state;
  return 'idle';
}
export const GETTING_INVITATION = 'Getting the invitation…';
/** The row's polite line while it waits: for a change being saved, or for its invitation. */
export const rowWaitingWord = (pending: boolean, state: HandoverState): string =>
  (state === 'loading' ? GETTING_INVITATION : pending ? 'Saving…' : '');

/** "Move to Interview" is offered exactly for an active application at Applied or Screening; never when that is not known. */
export function offersMove(change: InterviewChange): boolean {
  if (change.application_id === null || change.application_stage === null || change.application_outcome === null) return false;
  return offerMoveToInterview(change.application_stage, change.application_outcome);
}

export const moveInput = (applicationId: string) => ({ id: applicationId, stage: 'interview' as const });

/** The move's answer: done, or the refusal's own sentence. Anything malformed fails closed. */
export function moveResult(result: unknown): { ok: true } | { ok: false; error: string } {
  const failed = { ok: false as const, error: INTERVIEW_SAVE_FAILED };
  if (!result || typeof result !== 'object') return failed;
  const answer = result as { ok?: unknown; error?: unknown };
  if (answer.ok === true) return { ok: true };
  return typeof answer.error === 'string' && answer.error ? { ok: false, error: answer.error } : failed;
}

// ─── a row of the Interviews table ───────────────────────────────────────────

/** What a row's menu offers: by its status, and by whether its application is still active. */
export function rowMenu(row: InterviewRow): InterviewMenuItem[] {
  const items = menuFor(row.statusKey, row.applicationOutcome);
  // No invitation and no calendar file from a row whose times cannot be read as instants, or whose start had passed
  // when the server drew it ("Needs an outcome").
  const invites = !row.needsOutcome && allInstants(row.scheduledAt, row.createdAt, row.updatedAt);
  return invites ? items : items.filter((item) => item !== 'invitation');
}

const MENU_GROUPS: InterviewMenuItem[][] = [['edit', 'invitation'], ['completed', 'no_show'], ['cancel'], ['reopen']];
/** The items as the menu draws them: in groups with a rule between, "Cancel interview" last and alone. */
export const menuGroups = (items: InterviewMenuItem[]): InterviewMenuItem[][] =>
  MENU_GROUPS.map((group) => group.filter((item) => items.includes(item))).filter((group) => group.length > 0);

export const MENU_WORDS: Record<InterviewMenuItem, string> = {
  edit: 'Reschedule or edit',
  invitation: 'Invitation and calendar file',
  completed: 'Mark completed',
  no_show: 'Mark no-show',
  cancel: 'Cancel interview',
  reopen: 'Mark as scheduled again',
};
export const menuName = (name: string): string => `Actions for the interview with ${name}`;
export const outcomeInput = (id: string, outcome: PastOutcome) => ({ id, outcome });

/** The tags after a row's name. Only a scheduled interview is warned about: a closed one needs nothing done. */
export function tagsFor(row: InterviewRow): string[] {
  const tags: string[] = [];
  if (row.needsOutcome) tags.push('Needs an outcome');
  if (row.statusKey === 'scheduled' && row.applicationOutcome === 'rejected') tags.push('Application rejected');
  if (row.statusKey === 'scheduled' && row.applicationOutcome === 'withdrawn') tags.push('Application withdrawn');
  return tags;
}

/** The Time cell: the start as the row has it ("3:00 pm"), then the length. Beside the row's Date column. */
export const timeCell = (row: InterviewRow): string => `${row.time} · ${row.length}`;

export const cancelTitle = (name: string): string => `Cancel the interview with ${name}?`;
export function cancelBody(row: Pick<InterviewRow, 'name' | 'role' | 'scheduledAt'>): string {
  return `${row.role}, ${longDate(row.scheduledAt)}, ${clock12(row.scheduledAt)}. It stays in the list as cancelled. `
    + `Nothing is sent to ${row.name}: you will need to tell them.`;
}
export const KEEP_INTERVIEW = 'Keep interview';
export const cancelLabel = (busy: boolean): string => (busy ? 'Cancelling…' : 'Cancel interview');

/**
 * The DOM id of a control that opens the dialog, so focus can be given back to
 * it by id: a board card that moved to another column is drawn again as a new
 * element, and its id is the same.
 */
export function openerId(
  kind: 'header-schedule' | 'header-past' | 'row' | 'card' | 'panel-schedule' | 'panel-past',
  id = '',
): string {
  return kind === 'header-schedule' || kind === 'header-past' ? `hire-interview-${kind}` : `hire-interview-${kind}-${id}`;
}

// ─── the Applications panel ──────────────────────────────────────────────────

export const PANEL_HEADING = 'Interviews';
export const PANEL_EMPTY = 'No interviews yet.';
export const PANEL_ROWS = 5;

/** "Tue 20 Oct 2026, 3:00 pm · 1 hour · Video call · Farah Lim · Scheduled". An interviewer nobody gave is left out. */
export function panelLine(row: PanelInterview): string {
  return [shortWhen(row.scheduledAt), row.length, KIND_WORDS[row.kind], row.interviewerName, row.status].filter(Boolean).join(' · ');
}

/** At most five lines, and how many more there are. */
export function panelRows<T>(interviews: T[]): { shown: T[]; more: number } {
  return { shown: interviews.slice(0, PANEL_ROWS), more: Math.max(0, interviews.length - PANEL_ROWS) };
}
export const panelMore = (count: number): string => `and ${count} more on the Interviews screen`;

/**
 * After a rejection or a withdrawal: the sentence that says interviews are
 * still scheduled, or null when none is (or the answer does not say). `name`
 * is the one the control shows, used when the result came back without one.
 */
export function stillScheduledNotice(result: unknown, name: string): string | null {
  if (!result || typeof result !== 'object') return null;
  const answer = result as { ok?: unknown; data?: unknown };
  if (answer.ok !== true || !answer.data || typeof answer.data !== 'object') return null;
  const data = answer.data as { candidate?: unknown; scheduled_interviews?: unknown };
  const count = data.scheduled_interviews;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
  return stillScheduledMessage(typeof data.candidate === 'string' && data.candidate ? data.candidate : name, count);
}
