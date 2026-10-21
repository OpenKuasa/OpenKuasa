/**
 * Pure helpers for what a visitor sends through a public lead form: the field
 * rules and their messages, the public link, and the "new today" and 14-day
 * figures. No I/O, so the public page, the Lead Forms screen and the tests all
 * share one definition of each rule.
 *
 * The same field rules are enforced again in SQL by `submit_public_form`,
 * because that function can be called without going through the page.
 */
import type { FormSubmission } from './types';

/* ---- the public link ------------------------------------------------- */

/**
 * Where a form is filled in. The form's id is the public identifier: a
 * workspace has no public name of its own to put in the link.
 */
export function publicFormPath(formId: string): string {
  return `/f/${formId}`;
}

/** The full link to share, for a site served from `origin`. */
export function publicFormUrl(origin: string, formId: string): string {
  return `${origin.replace(/\/+$/, '')}${publicFormPath(formId)}`;
}

/**
 * The address this site is being reached at, from the request's headers. Behind
 * a proxy the forwarded host and scheme are the ones a visitor would use.
 */
export function originFromHeaders(get: (name: string) => string | null): string | null {
  const first = (value: string | null) => value?.split(',')[0]?.trim() || null;
  const host = first(get('x-forwarded-host')) ?? first(get('host'));
  if (!host || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const forwarded = first(get('x-forwarded-proto'));
  const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : local ? 'http' : 'https';
  return `${proto}://${host}`;
}

/* ---- the fields ------------------------------------------------------ */

export const SUBMISSION_NAME_MAX = 120;
export const SUBMISSION_EMAIL_MAX = 254;
export const SUBMISSION_PHONE_MAX = 40;
export const SUBMISSION_MESSAGE_MAX = 2000;

/**
 * A field people never see. A filled one means a script wrote the submission,
 * which is then thanked and thrown away. The name is one no browser keeps an
 * autofill value for, so a real visitor's browser does not fill it in.
 */
export const HONEYPOT_FIELD = 'referral_code';

export const SUBMISSION_MESSAGES = {
  name: 'Enter your name.',
  nameTooLong: `Keep your name to ${SUBMISSION_NAME_MAX} characters or fewer.`,
  email: 'Enter your email address.',
  emailInvalid: 'Enter an email address like name@example.com.',
  emailTooLong: `Keep the email address to ${SUBMISSION_EMAIL_MAX} characters or fewer.`,
  phoneTooLong: `Keep the phone number to ${SUBMISSION_PHONE_MAX} characters or fewer.`,
  messageTooLong: 'Keep the message to 2,000 characters or fewer.',
  closed: 'This form is not accepting responses.',
  throttled: 'This form is receiving a lot of responses right now. Try again in a minute.',
  failed: 'Your response could not be sent. Please try again.',
  consent: 'Please tick the box to agree before sending.',
} as const;

/** What the four fields hold, as typed. */
export type SubmissionValues = {
  name: string;
  email: string;
  phone: string;
  message: string;
};
export type SubmissionField = keyof SubmissionValues;
/** Problems are reported beside the four fields and beside the consent box. */
export type SubmissionErrors = Partial<Record<SubmissionField | 'consent', string>>;

/** The order the fields appear in, which is the order problems are reported in. */
export const SUBMISSION_FIELDS: readonly SubmissionField[] = ['name', 'email', 'phone', 'message'];
/** Every place a problem can be shown, in page order: the fields, then the consent box. */
export const SUBMISSION_PROBLEM_ORDER: readonly (SubmissionField | 'consent')[] = [
  ...SUBMISSION_FIELDS,
  'consent',
];

/** The name of the consent box. A ticked native box posts "on". */
export const CONSENT_FIELD = 'consent';

/**
 * The problems the public form shows, from the server's last answer and what
 * the visitor has done with the consent box since:
 * - `blocked`: the browser just stopped a send because the box was unticked,
 *   so only that is shown (the server's answer is about an earlier send);
 * - `tickedSince`: the box has been ticked since the server answered, so the
 *   server's complaint about the box is out of date and is dropped. Its other
 *   problems stay until the next send.
 */
export function shownSubmissionErrors(
  server: SubmissionErrors | undefined,
  { blocked, tickedSince }: { blocked: boolean; tickedSince: boolean },
): SubmissionErrors | undefined {
  if (blocked) return { consent: SUBMISSION_MESSAGES.consent };
  if (!server || !tickedSince || !server.consent) return server;
  const { consent: _stale, ...rest } = server;
  void _stale;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** A checked submission, ready to send. */
export type SubmissionInput = {
  name: string;
  email: string;
  phone: string | null;
  message: string | null;
};

/** What is sent to the database: a checked submission and whether the box was ticked. */
export type SubmissionToSend = SubmissionInput & { consent: boolean };

export type ParsedSubmission =
  | { ok: true; input: SubmissionInput }
  | { ok: false; errors: SubmissionErrors };

/** Counted the way the database counts: one per character, not per UTF-16 unit. */
function length(value: string): number {
  return [...value].length;
}

const oneLine = (value: string) => value.trim().replace(/\s+/g, ' ');

/** The shape the Contacts page asks for: something@something.something. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks what a visitor typed. Every field with a problem gets its own message,
 * so the page can put each one beside the field it is about.
 */
export function parseSubmission(values: SubmissionValues): ParsedSubmission {
  const name = oneLine(values.name);
  const email = values.email.trim().toLowerCase();
  const phone = oneLine(values.phone);
  const message = values.message.trim();
  const errors: SubmissionErrors = {};

  if (!name) errors.name = SUBMISSION_MESSAGES.name;
  else if (length(name) > SUBMISSION_NAME_MAX) errors.name = SUBMISSION_MESSAGES.nameTooLong;

  if (!email) errors.email = SUBMISSION_MESSAGES.email;
  else if (length(email) > SUBMISSION_EMAIL_MAX) errors.email = SUBMISSION_MESSAGES.emailTooLong;
  else if (!EMAIL_SHAPE.test(email)) errors.email = SUBMISSION_MESSAGES.emailInvalid;

  if (length(phone) > SUBMISSION_PHONE_MAX) errors.phone = SUBMISSION_MESSAGES.phoneTooLong;
  if (length(message) > SUBMISSION_MESSAGE_MAX) errors.message = SUBMISSION_MESSAGES.messageTooLong;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: { name, email, phone: phone || null, message: message || null } };
}

/**
 * How a name becomes a contact's first and last name: everything before the
 * first space, and everything after it. `submit_public_form` splits the same way.
 */
export function splitName(name: string): { first: string; last: string | null } {
  const whole = oneLine(name);
  const space = whole.indexOf(' ');
  if (space < 0) return { first: whole, last: null };
  return { first: whole.slice(0, space), last: whole.slice(space + 1) };
}

/** What the page does after `submit_public_form` has answered. */
export type SubmissionOutcome =
  | { kind: 'ok' }
  | { kind: 'not_found' }
  | { kind: 'closed' }
  | { kind: 'throttled' }
  | { kind: 'invalid'; errors: SubmissionErrors }
  | { kind: 'failed' };

const STATUS_ERRORS: Record<string, SubmissionErrors> = {
  invalid_name: { name: SUBMISSION_MESSAGES.name },
  name_too_long: { name: SUBMISSION_MESSAGES.nameTooLong },
  invalid_email: { email: SUBMISSION_MESSAGES.emailInvalid },
  email_too_long: { email: SUBMISSION_MESSAGES.emailTooLong },
  phone_too_long: { phone: SUBMISSION_MESSAGES.phoneTooLong },
  message_too_long: { message: SUBMISSION_MESSAGES.messageTooLong },
  consent_required: { consent: SUBMISSION_MESSAGES.consent },
};

/** Reads the one word `submit_public_form` answers with. */
export function submissionOutcome(status: unknown): SubmissionOutcome {
  if (status === 'ok') return { kind: 'ok' };
  if (status === 'not_found') return { kind: 'not_found' };
  if (status === 'closed') return { kind: 'closed' };
  if (status === 'throttled') return { kind: 'throttled' };
  const errors =
    typeof status === 'string' && Object.hasOwn(STATUS_ERRORS, status)
      ? STATUS_ERRORS[status]
      : undefined;
  return errors ? { kind: 'invalid', errors } : { kind: 'failed' };
}

/* ---- stored submissions ---------------------------------------------- */

/** The columns of `public.form_submissions` the app reads. */
export const FORM_SUBMISSION_COLUMNS =
  'id,form_id,contact_id,payload,consent_text,consented_at,created_at';

/** How many of a form's submissions the Lead Forms screen lists. */
export const SUBMISSIONS_SHOWN = 20;

export type FormSubmissionRow = {
  id: string;
  form_id: string;
  contact_id: string | null;
  payload: unknown;
  consent_text?: string | null;
  consented_at?: string | null;
  created_at: string;
};

/** Reads the fixed fields out of a stored payload; anything else is ignored. */
export function mapFormSubmission(row: FormSubmissionRow): FormSubmission {
  const payload =
    row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};
  const text = (key: string) => {
    const value = payload[key];
    return typeof value === 'string' && value.trim() ? value : null;
  };
  return {
    id: row.id,
    form_id: row.form_id,
    contact_id: row.contact_id,
    name: text('name') ?? '',
    email: text('email') ?? '',
    phone: text('phone'),
    message: text('message'),
    // Kept only as a pair: one without the other is not shown as consent.
    consent_text: row.consent_text && row.consented_at ? row.consent_text : null,
    consented_at: row.consent_text && row.consented_at ? row.consented_at : null,
    created_at: row.created_at,
  };
}

/* ---- figures --------------------------------------------------------- */

/** Days are counted in Malaysian time, wherever the server happens to run. */
export const SUBMISSIONS_TIME_ZONE = 'Asia/Kuala_Lumpur';
/** Malaysia keeps one offset all year, so a day there always starts here. */
const DAY_START_OFFSET = '+08:00';
const DAY_MS = 86_400_000;

export const SUBMISSIONS_TREND_DAYS = 14;

/** The calendar day in Malaysia an instant falls on, as "2026-10-10". */
export function malaysiaDay(at: Date | string): string | null {
  const date = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SUBMISSIONS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** The last `days` calendar days in Malaysia, oldest first, ending with today. */
function trendDays(now: Date, days: number): string[] {
  const today = malaysiaDay(now) ?? '';
  // Midday keeps each step of 24 hours safely inside the day it lands on.
  const middayToday = new Date(`${today}T12:00:00${DAY_START_OFFSET}`).getTime();
  return Array.from({ length: days }, (_, i) =>
    malaysiaDay(new Date(middayToday - (days - 1 - i) * DAY_MS)) ?? '',
  );
}

/**
 * The instant the trend's first day starts, as an ISO time. Submissions from
 * here on are all the two figures below need.
 */
export function submissionsTrendStart(now: Date, days = SUBMISSIONS_TREND_DAYS): string {
  const [first] = trendDays(now, days);
  return new Date(`${first}T00:00:00${DAY_START_OFFSET}`).toISOString();
}

/** How many of the given submission times fall on today, in Malaysia. */
export function submissionsToday(times: string[], now: Date): number {
  const today = malaysiaDay(now);
  return times.reduce((count, at) => (malaysiaDay(at) === today ? count + 1 : count), 0);
}

export type SubmissionsTrendPoint = { label: string; submissions: number };

/**
 * Submissions per day for the last `days` days in Malaysia, oldest first. A day
 * with none is still there, at zero. Labels read "9 Oct".
 */
export function submissionsTrend(
  times: string[],
  now: Date,
  days = SUBMISSIONS_TREND_DAYS,
): SubmissionsTrendPoint[] {
  const counts = new Map<string, number>();
  for (const at of times) {
    const day = malaysiaDay(at);
    if (day) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const label = new Intl.DateTimeFormat('en-GB', {
    timeZone: SUBMISSIONS_TIME_ZONE,
    day: 'numeric',
    month: 'short',
  });
  return trendDays(now, days).map((day) => ({
    label: label.format(new Date(`${day}T12:00:00${DAY_START_OFFSET}`)),
    submissions: counts.get(day) ?? 0,
  }));
}

/** "10 Oct 2026, 14:05", in Malaysian time so the server and the browser agree. */
export function formatSubmissionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: SUBMISSIONS_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
