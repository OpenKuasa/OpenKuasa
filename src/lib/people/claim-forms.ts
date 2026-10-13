/**
 * The claim form's logic, apart from the component: what a filled-in form
 * sends. The form knows nothing about whose claim it is; the screen around it
 * adds the employee. The amount is typed in Ringgit and sent as whole sen.
 */
import { isRealDate } from './dates';
import { ringgitToSen } from './pay-requests';
import type { ClaimCategory } from './types';

export type ClaimFormValues = {
  category: ClaimCategory;
  /** What was typed, in Ringgit. */
  amount: string;
  claim_date: string;
  description: string;
  /** The uploaded receipt's path in the bucket, once it is up; null for none. */
  receipt_path: string | null;
};

/** What the form sends: no employee, which the screen or the server supplies. */
export type ClaimFormInput = {
  category: ClaimCategory;
  amount_cents: number;
  claim_date: string;
  description: string | null;
  receipt_path: string | null;
};

/** Where the receipt is in its upload. */
export type ReceiptUploadState = 'none' | 'uploading' | 'attached' | 'failed';

/**
 * A claim is not submitted past a failed upload: the person removes the file (and submits with no receipt on
 * purpose) or chooses it again until it goes up.
 */
export function receiptSubmitProblem(state: ReceiptUploadState): string | null {
  return state === 'failed' ? 'The receipt did not upload. Remove the file, or choose it again, before you submit.' : null;
}

/** A fresh form, dated today by default. */
export const claimFormDefaults = (today: string): ClaimFormValues => ({
  category: 'travel',
  amount: '',
  claim_date: today,
  description: '',
  receipt_path: null,
});

const DESCRIPTION_MAX = 500;
const AMOUNT_MAX_SEN = 100_000_000;

/** `today` (when known) lets the form refuse a date in the future before asking the server. */
export function toClaimInput(
  values: ClaimFormValues,
  today?: string,
): { ok: true; input: ClaimFormInput } | { ok: false; error: string } {
  const sen = ringgitToSen(values.amount);
  if (sen === null) return { ok: false, error: 'Enter the amount in Ringgit, like 85 or 85.50.' };
  if (sen <= 0) return { ok: false, error: 'Enter an amount above zero.' };
  if (sen > AMOUNT_MAX_SEN) return { ok: false, error: 'Keep a claim to RM 1,000,000 or less.' };
  if (!values.claim_date) return { ok: false, error: 'Choose the date of the expense.' };
  if (!isRealDate(values.claim_date)) return { ok: false, error: 'Choose a real date.' };
  if (values.claim_date < '2000-01-01') return { ok: false, error: 'The date cannot be before the year 2000.' };
  if (today && values.claim_date > today) return { ok: false, error: 'The date cannot be in the future.' };
  const description = values.description.trim();
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, error: `Keep the description to ${DESCRIPTION_MAX} characters.` };
  }
  return {
    ok: true,
    input: {
      category: values.category,
      amount_cents: sen,
      claim_date: values.claim_date,
      description: description === '' ? null : description,
      receipt_path: values.receipt_path ? values.receipt_path : null,
    },
  };
}
