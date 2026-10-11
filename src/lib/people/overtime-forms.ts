/**
 * The overtime form's logic, apart from the component: what a filled-in form
 * sends, and the sentences that describe a preview. The form knows nothing
 * about whose overtime it is; the screen around it adds that. Amounts are
 * only ever shown as the database worked them out, never recomputed here.
 */
import { isRealDate } from './dates';
import type { OvertimePreview } from './pay-requests';
import { rm } from '@/lib/reach/format';
import type { OvertimeDayKind } from './types';

export type OvertimeFormValues = {
  work_date: string;
  /** What was typed: whole or half hours. */
  hours: string;
  reason: string;
};

/** What the form sends to submit: no employee, which the screen or the server supplies. */
export type OvertimeFormInput = { work_date: string; hours: number; reason: string | null };
/** What the form sends to preview: the same, without the reason. */
export type OvertimePreviewFormInput = Omit<OvertimeFormInput, 'reason'>;

/** A fresh form, dated today by default. */
export const overtimeFormDefaults = (today: string): OvertimeFormValues => ({ work_date: today, hours: '', reason: '' });

const REASON_MAX = 500;

/** The hours typed as a number, or a sentence saying what is wrong. */
function hoursOf(text: string): { hours: number } | { problem: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { problem: 'Enter the hours worked.' };
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { problem: 'Enter the hours as a number, like 2 or 2.5.' };
  const hours = Number(trimmed);
  if (hours < 0.5) return { problem: 'Overtime is at least half an hour.' };
  if (hours > 24) return { problem: 'Overtime cannot be more than 24 hours in a day.' };
  if (!Number.isInteger(hours * 2)) return { problem: 'Use whole or half hours.' };
  return { hours };
}

/** The date is set and real; the text says what is wrong, if anything. `today` (when known) refuses a future date. */
function dateProblem(date: string, today?: string): string | null {
  if (!date) return 'Choose the date worked.';
  if (!isRealDate(date)) return 'Choose a real date.';
  if (date < '2000-01-01') return 'The date cannot be before the year 2000.';
  if (today && date > today) return 'The date cannot be in the future.';
  return null;
}

export function toOvertimeInput(
  values: OvertimeFormValues,
  today?: string,
): { ok: true; input: OvertimeFormInput } | { ok: false; error: string } {
  const dateIssue = dateProblem(values.work_date, today);
  if (dateIssue) return { ok: false, error: dateIssue };
  const parsed = hoursOf(values.hours);
  if ('problem' in parsed) return { ok: false, error: parsed.problem };
  const reason = values.reason.trim();
  if (reason.length > REASON_MAX) return { ok: false, error: `Keep the reason to ${REASON_MAX} characters.` };
  return { ok: true, input: { work_date: values.work_date, hours: parsed.hours, reason: reason === '' ? null : reason } };
}

/** The preview's arguments, or null while the date and hours cannot be worked out yet. Never carries the reason. */
export function toOvertimePreviewInput(values: OvertimeFormValues, today?: string): OvertimePreviewFormInput | null {
  const parsed = toOvertimeInput({ ...values, reason: '' }, today);
  return parsed.ok ? { work_date: parsed.input.work_date, hours: parsed.input.hours } : null;
}

const KIND_LABEL: Record<OvertimeDayKind, string> = {
  weekday: 'Weekday',
  rest_day: 'Rest day',
  public_holiday: 'Public holiday',
};

/** 1.5 -> "1.5", 2 -> "2". */
const figure = (n: number): string => String(Math.round(n * 10) / 10);

export const NO_SALARY_NOTE =
  'No salary is on file yet. The amount will be worked out once HR sets the salary.';

/** What a preview says: the kind of day and its multiplier, the amount, and a note when there is no salary to work it from. */
export function overtimePreviewLines(preview: OvertimePreview): { kind: string; amount: string; note: string | null } {
  const kind = `${KIND_LABEL[preview.day_kind]}, paid at ${figure(preview.multiplier)} times`;
  if (preview.amount_cents === null) return { kind, amount: 'Not calculated', note: NO_SALARY_NOTE };
  return { kind, amount: rm(preview.amount_cents), note: null };
}
