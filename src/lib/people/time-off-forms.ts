/**
 * The time-off form's logic, apart from the component: what a filled-in form
 * sends. The form knows nothing about whose time-off it is; the server adds
 * the employee from the session.
 */

import { isRealDate } from './dates';

export type TimeOffFormValues = {
  off_date: string;
  /** `HH:MM`, as a time input gives it. */
  start_time: string;
  end_time: string;
  reason: string;
};

/** What the form sends to apply: no employee. */
export type TimeOffFormInput = {
  off_date: string;
  start_time: string;
  end_time: string;
  reason: string | null;
};

export const TIME_OFF_FORM_DEFAULTS: TimeOffFormValues = {
  off_date: '',
  start_time: '',
  end_time: '',
  reason: '',
};

const REASON_MAX = 500;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toTimeOffInput(
  values: TimeOffFormValues,
): { ok: true; input: TimeOffFormInput } | { ok: false; error: string } {
  if (!values.off_date) return { ok: false, error: 'Choose the day.' };
  if (!isRealDate(values.off_date)) return { ok: false, error: 'Choose a real date.' };
  if (!values.start_time || !values.end_time) return { ok: false, error: 'Choose the start and end times.' };
  if (!TIME.test(values.start_time) || !TIME.test(values.end_time)) {
    return { ok: false, error: 'Use times like 09:00.' };
  }
  // Same-length `HH:MM` strings compare in clock order.
  if (values.end_time <= values.start_time) return { ok: false, error: 'The end time must be after the start time.' };
  const reason = values.reason.trim();
  if (reason.length > REASON_MAX) return { ok: false, error: `Keep the reason to ${REASON_MAX} characters.` };
  return {
    ok: true,
    input: {
      off_date: values.off_date,
      start_time: values.start_time,
      end_time: values.end_time,
      reason: reason === '' ? null : reason,
    },
  };
}
