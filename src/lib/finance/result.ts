import type { SupabaseClient } from '@supabase/supabase-js';

/** Who is writing: the caller's own client (so RLS applies) and their workspace. */
export type FinanceWriteContext = { client: SupabaseClient; orgId: string };

export type FinResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const PG_UNIQUE = '23505';
export const PG_FOREIGN_KEY = '23503';
export const PG_CHECK = '23514';
/** Row-level security refused the write. */
export const PG_FORBIDDEN = '42501';
/** A number does not fit its column: quantity × unit price can overflow. */
export const PG_OUT_OF_RANGE = '22003';

export const WRITE_FAILED = 'That change could not be saved. Please try again.';
export const READ_FAILED = 'That could not be loaded. Please try again.';
export const NOT_ALLOWED = 'You do not have permission to make changes here.';
export const TOO_LARGE = 'That amount is too large.';

/**
 * The database refused a sign-off: posting a bill or an invoice, issuing a credit note, paying a payment or
 * a refund, or voiding any of them, by someone who is not an owner or admin (`private.finance_may_sign_off`).
 */
export const FIN_SIGN_OFF = 'FIN14';
export const NEEDS_SIGN_OFF = 'Only an owner or admin can post, pay or void. Ask one of them to do this.';
/** A form that saves and then posts, sent by someone who may only save. */
export const DRAFT_NEEDS_SIGN_OFF = 'Saved as a draft. Only an owner or admin can post or issue it.';
/** A payment or refund recorded as paid now by someone who may only schedule one. */
export const PAID_NOW_NEEDS_SIGN_OFF =
  'Only an owner or admin can record this as paid. Save it as scheduled or pending instead.';

/**
 * The database refused money on an archived account (`private.finance_transaction_account_guard`,
 * 20261116110000): a payment started on one, moved onto one, or posted, scheduled, approved or sent for approval
 * while its account is archived. Every account picker lists active accounts only, so a person meets it when the
 * account was archived after their form was opened, or after the draft they are posting was saved.
 */
export const FIN_ACCOUNT_ARCHIVED = 'FIN37';
export const ACCOUNT_ARCHIVED =
  'The account this is on has been archived. Restore it on Banking, or use another account, then try again.';

/**
 * The database refused money on a bank or cash account in another currency (`private.finance_transaction_currency_guard`):
 * from 20261122110000 (stage 5b), a draft inserted on one (it carries no rate), or a draft moved between accounts in
 * different currencies (20261122120000, stage 5c, opened transfers with one). Payments there are recorded paid, with
 * their rate, and the draft forms list ringgit accounts, so a person meets it from a stale tab or a direct call. Each
 * data layer maps the code to its own sentence (movement-rate.ts `MOVEMENT_MESSAGES.draft`).
 */
export const FIN_FOREIGN_ACCOUNT = 'FIN50';

/**
 * The database refused a change to a payment that has left draft, or to its split
 * (`private.finance_transaction_still_guard` and `private.finance_allocation_still_guard`, 20261117090000). A payment
 * that is posted, void, waiting for approval, rejected or approved was held already and still answers `FIN09` or
 * `FIN14` first, so the only payment this code is raised for is one that is scheduled with nobody having had to
 * approve it: a supplier payment, a pending refund, a voucher for approved expenses. No write in this folder can
 * meet it: none edits a payment that is not a draft or sends one back to draft (`tests/finance-payment-held-still.test.ts`
 * holds them to that). It is named here so that a write which one day does has the sentence to answer with.
 */
export const FIN_HELD_STILL = 'FIN28';
export const HELD_STILL = 'This is waiting to be paid, so it can no longer be changed. Delete it and record it again.';

/**
 * The accounting settings' refusals (20261125140000_bendahara_accounting_settings.sql). FIN63 can meet any write
 * that posts, issues, pays or voids, so `writeFailed` answers all five for every finance write; the sentences are
 * here, beside it, and `SETTINGS_MESSAGES` (settings.ts) is built from them.
 */
/** A ledger effect dated on or before the books lock date (`private.finance_period_lock`). */
export const FIN_LOCKED = 'FIN63';
/** A books lock date after today in Malaysia. */
export const FIN_FUTURE_LOCK = 'FIN64';
/** A document's next number set lower than it already is (`finance_set_sequence`). */
export const FIN_NUMBER_BACK = 'FIN65';
/** A numbering prefix that is not 1 to 10 letters, numbers, dashes or slashes. */
export const FIN_BAD_PREFIX = 'FIN66';
/** A numbering prefix another document of the workspace already uses (`finance_set_sequence`). */
export const FIN_PREFIX_TAKEN = 'FIN67';

export const LOCKED = (date: string) => `This date is in a closed period: the books are locked to ${date}.`;
export const LOCKED_NO_DATE = 'This date is in a closed period: the books are locked.';
export const FUTURE_LOCK = "The books can't be locked to a date in the future.";
export const NUMBER_BACK = (n: number) => `The next number can't go back: it must be ${n} or more.`;
export const NUMBER_BACK_NO_NUMBER = "The next number can't go back.";
export const BAD_PREFIX = 'A prefix is 1 to 10 letters, numbers, dashes or slashes.';
export const PREFIX_TAKEN = 'Another document already uses this prefix.';

export function pgCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** The database error's message, detail and hint, where a refusal may name its date or number. */
function errorText(error: unknown): string[] {
  const e = (error ?? {}) as { message?: unknown; details?: unknown; hint?: unknown };
  return [e.message, e.details, e.hint].filter((t): t is string => typeof t === 'string');
}

/** The sentence for a settings refusal (FIN63–FIN67), or null for any other error. */
export function settingsRefusal(error: unknown): string | null {
  switch (pgCode(error)) {
    case FIN_LOCKED: {
      // The lock date as the database writes it: 30 Sep 2026.
      for (const text of errorText(error)) {
        const date = /\b\d{1,2} [A-Z][a-z]{2} \d{4}\b/.exec(text)?.[0];
        if (date) return LOCKED(date);
      }
      return LOCKED_NO_DATE;
    }
    case FIN_FUTURE_LOCK:
      return FUTURE_LOCK;
    case FIN_NUMBER_BACK: {
      for (const text of errorText(error)) {
        const n = /\b(\d+)\b/.exec(text)?.[1];
        if (n) return NUMBER_BACK(Number(n));
      }
      return NUMBER_BACK_NO_NUMBER;
    }
    case FIN_BAD_PREFIX:
      return BAD_PREFIX;
    case FIN_PREFIX_TAKEN:
      return PREFIX_TAKEN;
    default:
      return null;
  }
}

/**
 * Logs the database error for triage; the person only ever sees the general message. A settings refusal
 * (FIN63–FIN67) is not a failure: the person is told why, in its own sentence, and nothing is logged.
 */
export function writeFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = settingsRefusal(error);
  if (refusal) return { ok: false, error: refusal };
  console.error(`[finance] ${fnName} failed:`, error);
  return { ok: false, error: WRITE_FAILED };
}
