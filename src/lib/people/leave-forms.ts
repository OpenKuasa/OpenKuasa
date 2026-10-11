/**
 * The leave form's logic, apart from the component: what a filled-in form
 * sends, and the sentences that describe a preview. The form knows nothing
 * about whose leave it is; the screen around it adds that.
 */
import { isRealDate } from './dates';
import type { LeavePreview } from './leave';
import type { LeaveType } from './types';

export type LeaveFormValues = {
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  half_day: boolean;
  reason: string;
};

/** What the form sends to apply: no employee, which the screen or the server supplies. */
export type LeaveFormInput = {
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  half_day: boolean;
  reason: string | null;
};

/** What the form sends to preview: the same, without the reason. */
export type LeavePreviewFormInput = Omit<LeaveFormInput, 'reason'>;

export const LEAVE_FORM_DEFAULTS: LeaveFormValues = {
  leave_type: 'annual',
  start_date: '',
  end_date: '',
  half_day: false,
  reason: '',
};

const REASON_MAX = 500;
/** A half day makes sense for one date only, so it is dropped (not refused) when the dates differ. */
const halfDayFor = (values: LeaveFormValues): boolean => values.half_day && values.start_date === values.end_date;

/** The dates are set and make a range the server could count; the text says what is wrong, if anything. */
function datesProblem(values: LeaveFormValues): string | null {
  if (!values.start_date || !values.end_date) return 'Choose the first and last day.';
  if (!isRealDate(values.start_date) || !isRealDate(values.end_date)) return 'Choose real dates.';
  if (values.end_date < values.start_date) return 'The last day cannot be before the first day.';
  return null;
}

export function toLeaveInput(
  values: LeaveFormValues,
): { ok: true; input: LeaveFormInput } | { ok: false; error: string } {
  const problem = datesProblem(values);
  if (problem) return { ok: false, error: problem };
  const reason = values.reason.trim();
  if (reason.length > REASON_MAX) return { ok: false, error: `Keep the reason to ${REASON_MAX} characters.` };
  return {
    ok: true,
    input: {
      leave_type: values.leave_type,
      start_date: values.start_date,
      end_date: values.end_date,
      half_day: halfDayFor(values),
      reason: reason === '' ? null : reason,
    },
  };
}

/** The preview's arguments, or null while the dates cannot be counted yet. Never carries the reason. */
export function toPreviewInput(values: LeaveFormValues): LeavePreviewFormInput | null {
  if (datesProblem(values)) return null;
  return {
    leave_type: values.leave_type,
    start_date: values.start_date,
    end_date: values.end_date,
    half_day: halfDayFor(values),
  };
}

/** 2 -> "2", 1.5 -> "1.5". */
const figure = (n: number): string => String(Math.round(n * 10) / 10);
const daysOf = (n: number): string => (n === 1 ? '1 day' : n === 0.5 ? 'half a day' : `${figure(n)} days`);

/** What a preview says: the days this costs, the balance per year after it, and a warning when over. */
export function previewLines(preview: LeavePreview): { days: string; balance: string[]; warning: string | null } {
  const balance = preview.years.map((year) =>
    year.remaining_after >= 0
      ? `${year.year}: ${figure(year.remaining_after)} of ${figure(year.entitled)} days left after this.`
      : `${year.year}: ${figure(-year.remaining_after)} ${-year.remaining_after === 1 ? 'day' : 'days'} over the ${figure(year.entitled)} days entitled.`,
  );
  return {
    days: daysOf(preview.days),
    balance,
    warning:
      preview.over_by > 0
        ? `That is ${daysOf(preview.over_by)} more than the balance. It can still be submitted, and whoever decides it will see this.`
        : null,
  };
}
