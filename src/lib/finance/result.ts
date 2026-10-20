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

export function pgCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Logs the database error for triage; the person only ever sees the general message. */
export function writeFailed(fnName: string, error: unknown): { ok: false; error: string } {
  console.error(`[finance] ${fnName} failed:`, error);
  return { ok: false, error: WRITE_FAILED };
}
