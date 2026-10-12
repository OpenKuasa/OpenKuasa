/**
 * The app's write path for expense claims and overtime. Every change is one
 * call to a database function (`hr_submit_claim`, `hr_decide_overtime`, ...):
 * the two tables take no direct writes, and the functions decide who may do
 * what, work out what overtime pays and keep a claim's receipt and paid mark
 * right. This file only validates the shape of an input, makes the call and
 * turns a refusal into a sentence.
 *
 * A refusal arrives as a Postgres error whose message begins with a code, for
 * example `PAY_NOT_PENDING`. `org_id` and the acting user are never arguments:
 * the database works both out from the session. Amounts are whole sen here;
 * {@link ringgitToSen} is for turning what a person typed into sen.
 */
import { z } from 'zod';
import {
  type CapResult,
  type PeopleWriteContext,
  refuse,
  writeFailed,
} from './capabilities';
import { isRealDate } from './dates';
import { PAYROLL_REFUSALS } from './payroll-refusals';
import type { Claim, OvertimeDayKind } from './types';

import { OWN_REQUEST_REFUSAL, decideInput, requestIdInput } from './leave';

// Defined once, in leave.ts; re-exported so a caller of this file needs one import.
export { decideInput, requestIdInput };

// ---- Sentences ---------------------------------------------------------------

/** Each refusal code the claim and overtime functions raise, and what the person is told. */
export const PAY_REFUSALS: Record<string, string> = {
  PAY_NOT_ALLOWED: "You can't make that change.",
  // An admin deciding, or marking as paid, their own claim or overtime; the workspace's owner may.
  PAY_OWN_REQUEST: OWN_REQUEST_REFUSAL,
  PAY_NOT_FOUND: 'That request was not found.',
  PAY_NOT_PENDING: 'That request has already been decided or cancelled.',
  PAY_NOT_APPROVED: 'Only an approved claim can be marked as paid.',
  PAY_NOT_PAID: 'That claim is not marked as paid.',
  PAY_ALREADY_PAID: 'That claim is marked as paid. Undo the paid mark first.',
  PAY_INACTIVE_EMPLOYEE: 'That employee is inactive.',
  PAY_TOO_MANY_HOURS: 'That would be more than 24 hours of overtime on one day.',
  PAY_BAD_RECEIPT: 'That receipt could not be attached. Please upload it again.',
  PAY_BAD_INPUT: "That request isn't valid. Check the details and try again.",
};

type DbError = { code?: string; message?: string } | null | undefined;

/** The leading `PAY_...` code of a database message, or null when it does not begin with one. */
const leadingCode = (message: string | undefined): string | null => /^PAY_[A-Z_]+/.exec(message ?? '')?.[0] ?? null;

/**
 * A known code is answered with its sentence; anything else is logged, code
 * and message only, and answered generically. `PAY_BAD_INPUT` (a date after
 * today, a paid date before the claim's, anything the checks below let past)
 * has a sentence, as `LEAVE_BAD_INPUT` does, and can come from any function.
 */
function failed(fn: string, error: DbError): CapResult<never> {
  const code = leadingCode(error?.message);
  if (code && Object.hasOwn(PAY_REFUSALS, code)) return refuse(PAY_REFUSALS[code]);
  // Raised by cancel and decide overtime once a payroll run has paid the record; its sentence lives with payroll's.
  if (code === 'PAY_IN_PAID_RUN') return refuse(PAYROLL_REFUSALS.PAY_IN_PAID_RUN);
  return writeFailed(fn, error);
}

// ---- Inputs --------------------------------------------------------------------

const CATEGORIES = ['medical', 'travel', 'meals', 'equipment', 'other'] as const;
const MAX_CLAIM_CENTS = 100_000_000; // RM 1,000,000, as the database allows.

// Any Postgres uuid: `.uuid()` would refuse ids that are valid but not RFC-versioned.
const employee = z.guid().describe('The employee, by their id from listEmployees.');
const date = (what: string) =>
  z
    .string()
    .refine(isRealDate, `${what} must be a real date, as YYYY-MM-DD.`)
    .refine((value) => value >= '2000-01-01', `${what} cannot be before the year 2000.`);
const description = z.string().trim().max(500, 'Keep the description to 500 characters.').nullable().optional();
const reason = z.string().trim().max(500, 'Keep the reason to 500 characters.').nullable().optional();
const reference = z.string().trim().max(100, 'Keep the reference to 100 characters.').nullable().optional();

// No cross-field refinements here: they would stop a later task from `.omit()`-ing a field to make a
// variant of a schema. The database checks dates against today (in Malaysia) and the paid date against the claim's.
export const submitClaimInput = z.object({
  employee_id: employee,
  category: z.enum(CATEGORIES),
  amount_cents: z
    .number()
    .int('The amount must be whole sen.')
    .min(1, 'Enter an amount above zero.')
    .max(MAX_CLAIM_CENTS, 'Keep a claim to RM 1,000,000 or less.')
    .describe('The amount in sen (RM 85.00 is 8500).'),
  claim_date: date('The claim date'),
  description,
  receipt_path: z.string().min(1, PAY_REFUSALS.PAY_BAD_RECEIPT).max(300, PAY_REFUSALS.PAY_BAD_RECEIPT).nullable().optional(),
});

const hours = z
  .number()
  .min(0.5, 'Overtime is at least half an hour.')
  .max(24, 'Overtime cannot be more than 24 hours in a day.')
  .refine((n) => Number.isInteger(n * 2), 'Use whole or half hours.');

export const submitOvertimeInput = z.object({
  employee_id: employee,
  work_date: date('The date worked'),
  hours,
  reason,
});
export const previewOvertimeInput = submitOvertimeInput.omit({ reason: true });
export const markClaimPaidInput = z.object({
  id: z.guid().describe('The claim, by its id.'),
  paid_on: date('The date paid'),
  reference,
});

export type OvertimePreview = {
  day_kind: OvertimeDayKind;
  multiplier: number;
  hourly_rate_cents: number | null;
  amount_cents: number | null;
};

function parse<S extends z.ZodType>(schema: S, input: unknown): CapResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return refuse(parsed.error.issues[0]?.message ?? 'That input was not valid.');
}

// ---- Calls -----------------------------------------------------------------------

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const orNull = (value: string | null | undefined): string | null => (value ? value : null);

/** One database function. `pick` shapes its reply, or returns null for a reply that is not what was promised. */
async function call<T>(
  ctx: PeopleWriteContext,
  fn: string,
  rpc: string,
  args: Row,
  pick: (row: Row) => T | null,
): Promise<CapResult<T>> {
  const { data, error } = await ctx.client.rpc(rpc, args);
  if (error) return failed(fn, error);
  const picked = isRow(data) ? pick(data) : null;
  if (picked === null) return writeFailed(fn, { message: 'unexpected reply' });
  return { ok: true, data: picked };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const whole = (value: unknown): number | null => {
  const n = Number(value);
  return value === null || value === '' || value === undefined || !Number.isFinite(n) ? null : n;
};
/** A number, or null that is allowed; `undefined` means the value is neither (the reply is wrong). */
const maybeWhole = (value: unknown): number | null | undefined => (value === null ? null : (whole(value) ?? undefined));

const pickStatus = (row: Row): { id: string; status: string } | null => {
  const id = text(row.id);
  const status = text(row.status);
  return id && status ? { id, status } : null;
};

const DAY_KINDS: OvertimeDayKind[] = ['weekday', 'rest_day', 'public_holiday'];

export async function submitClaim(
  ctx: PeopleWriteContext,
  input: z.infer<typeof submitClaimInput>,
): Promise<CapResult<{ id: string; status: string; has_receipt: boolean }>> {
  const parsed = parse(submitClaimInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'submitClaim',
    'hr_submit_claim',
    {
      p_employee: v.employee_id,
      p_category: v.category,
      p_amount_cents: v.amount_cents,
      p_claim_date: v.claim_date,
      p_description: orNull(v.description),
      // Null is "no receipt"; an empty string would be refused by the database.
      p_receipt_path: orNull(v.receipt_path),
    },
    (row) => {
      const saved = pickStatus(row);
      return saved && typeof row.has_receipt === 'boolean' ? { ...saved, has_receipt: row.has_receipt } : null;
    },
  );
}

/** The path of the receipt the cancel let go of comes back so the file can be removed; null when there was none. */
export async function cancelClaim(
  ctx: PeopleWriteContext,
  input: z.infer<typeof requestIdInput>,
): Promise<CapResult<{ id: string; status: string; removed_receipt_path: string | null }>> {
  const parsed = parse(requestIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'cancelClaim', 'hr_cancel_claim', { p_request: parsed.data.id }, (row) => {
    const saved = pickStatus(row);
    const path = row.removed_receipt_path;
    if (!saved || (path !== null && path !== undefined && typeof path !== 'string')) return null;
    return { ...saved, removed_receipt_path: text(path) };
  });
}

export async function decideClaim(
  ctx: PeopleWriteContext,
  input: z.infer<typeof decideInput>,
): Promise<CapResult<{ id: string; status: string }>> {
  const parsed = parse(decideInput, input);
  if (!parsed.ok) return parsed;
  const { id, approve, note } = parsed.data;
  return call(ctx, 'decideClaim', 'hr_decide_claim', { p_request: id, p_approve: approve, p_note: orNull(note) }, pickStatus);
}

export async function markClaimPaid(
  ctx: PeopleWriteContext,
  input: z.infer<typeof markClaimPaidInput>,
): Promise<CapResult<{ id: string; status: string; paid_on: string }>> {
  const parsed = parse(markClaimPaidInput, input);
  if (!parsed.ok) return parsed;
  const { id, paid_on, reference: ref } = parsed.data;
  return call(
    ctx,
    'markClaimPaid',
    'hr_mark_claim_paid',
    { p_request: id, p_paid_on: paid_on, p_reference: orNull(ref) },
    (row) => {
      const saved = pickStatus(row);
      const paidOn = text(row.paid_on);
      return saved && paidOn ? { ...saved, paid_on: paidOn } : null;
    },
  );
}

export async function unmarkClaimPaid(
  ctx: PeopleWriteContext,
  input: z.infer<typeof requestIdInput>,
): Promise<CapResult<{ id: string; status: string }>> {
  const parsed = parse(requestIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'unmarkClaimPaid', 'hr_unmark_claim_paid', { p_request: parsed.data.id }, pickStatus);
}

/**
 * What the database would pay for overtime on a date: the kind of day, the multiplier, the hourly rate and the
 * amount. The rate and the amount are null when no salary is on file. Writes nothing. Never carries the reason.
 */
export async function previewOvertime(
  ctx: PeopleWriteContext,
  input: z.infer<typeof previewOvertimeInput>,
): Promise<CapResult<OvertimePreview>> {
  const parsed = parse(previewOvertimeInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'previewOvertime',
    'hr_overtime_preview',
    { p_employee: v.employee_id, p_work_date: v.work_date, p_hours: v.hours },
    (row) => {
      const kind = DAY_KINDS.find((k) => k === row.day_kind);
      const multiplier = whole(row.multiplier);
      const rate = maybeWhole(row.hourly_rate_cents);
      const amount = maybeWhole(row.amount_cents);
      if (!kind || multiplier === null || rate === undefined || amount === undefined) return null;
      return { day_kind: kind, multiplier, hourly_rate_cents: rate, amount_cents: amount };
    },
  );
}

export async function submitOvertime(
  ctx: PeopleWriteContext,
  input: z.infer<typeof submitOvertimeInput>,
): Promise<CapResult<{ id: string; status: string; amount_cents: number; hourly_rate_cents: number | null }>> {
  const parsed = parse(submitOvertimeInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'submitOvertime',
    'hr_submit_overtime',
    { p_employee: v.employee_id, p_work_date: v.work_date, p_hours: v.hours, p_reason: orNull(v.reason) },
    (row) => {
      const saved = pickStatus(row);
      const amount = whole(row.amount_cents);
      const rate = maybeWhole(row.hourly_rate_cents);
      return saved && amount !== null && rate !== undefined ? { ...saved, amount_cents: amount, hourly_rate_cents: rate } : null;
    },
  );
}

export async function cancelOvertime(
  ctx: PeopleWriteContext,
  input: z.infer<typeof requestIdInput>,
): Promise<CapResult<{ id: string; status: string }>> {
  const parsed = parse(requestIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'cancelOvertime', 'hr_cancel_overtime', { p_request: parsed.data.id }, pickStatus);
}

/** Approving works the figures out first when the record was made with no salary on file; `amount_cents` is what it now pays. */
export async function decideOvertime(
  ctx: PeopleWriteContext,
  input: z.infer<typeof decideInput>,
): Promise<CapResult<{ id: string; status: string; amount_cents: number | null }>> {
  const parsed = parse(decideInput, input);
  if (!parsed.ok) return parsed;
  const { id, approve, note } = parsed.data;
  return call(ctx, 'decideOvertime', 'hr_decide_overtime', { p_request: id, p_approve: approve, p_note: orNull(note) }, (row) => {
    const saved = pickStatus(row);
    // Null is the manager route: the database leaves the amount out for anyone who is not an owner or admin.
    const amount = maybeWhole(row.amount_cents);
    return saved && amount !== undefined ? { ...saved, amount_cents: amount } : null;
  });
}

// ---- Figures the screens and Lekiu share ---------------------------------------------

const yearOf = (day: string): number => Number(day.slice(0, 4));

/**
 * The sen this employee has approved or paid in that category in the claim's calendar year, not counting the
 * claim itself. The one formula for the approvals queue and for Lekiu's lookups. The year is the claim's own
 * date's, not today's.
 */
export function approvedThisYear(
  claim: { id: string; employee_id: string; category: string; claim_date: string },
  claims: Claim[],
): number {
  const year = yearOf(claim.claim_date);
  return claims
    .filter(
      (c) =>
        c.id !== claim.id &&
        c.employee_id === claim.employee_id &&
        c.category === claim.category &&
        (c.status === 'approved' || c.status === 'paid') &&
        yearOf(c.claim_date) === year,
    )
    .reduce((total, c) => total + c.amount_cents, 0);
}

const RINGGIT = /^(\d+)(?:\.(\d{1,2}))?$/;

/** What a person typed as Ringgit ('85', '85.5', '85.50') in whole sen; anything else (signs, commas, a third decimal, text) is null. */
export function ringgitToSen(value: string): number | null {
  const match = RINGGIT.exec(value.trim());
  if (!match) return null;
  const sen = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(sen) ? sen : null;
}
