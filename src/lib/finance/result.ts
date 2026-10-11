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

export function pgCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Logs the database error for triage; the person only ever sees the general message. */
export function writeFailed(fnName: string, error: unknown): { ok: false; error: string } {
  console.error(`[finance] ${fnName} failed:`, error);
  return { ok: false, error: WRITE_FAILED };
}
