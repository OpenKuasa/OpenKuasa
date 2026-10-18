/**
 * The app's write path for leave and time-off. Every change is one call to a
 * database function (`hr_apply_leave`, `hr_decide_leave`, ...): the tables take
 * no direct writes, and the functions decide who may do what, count the days
 * and keep `used_days` right. This file only validates the shape of an input,
 * makes the call and turns a refusal into a sentence.
 *
 * A refusal arrives as a Postgres error whose message begins with a code, for
 * example `LEAVE_OVERLAP`. `org_id` and the acting user are never arguments:
 * the database works both out from the session.
 */
import { z } from 'zod';
import {
  type CapResult,
  type PeopleWriteContext,
  refuse,
  writeFailed,
} from './capabilities';
import { isRealDate } from './dates';
import { LEAVE_REFUSALS } from './refusals';
import type { LeaveBalance, LeaveRequest, LeaveType, RequestStatus } from './types';

// ---- Sentences ---------------------------------------------------------------

// The sentences live in refusals.ts, a leaf module, so the approval buttons can read one without loading zod.
// LEAVE_REFUSALS is used below and re-exported; OWN_REQUEST_REFUSAL is only re-exported (approvals-screen reads
// it from here), so it stays a straight re-export rather than an unused local binding.
export { LEAVE_REFUSALS };
export { OWN_REQUEST_REFUSAL } from './refusals';

type DbError = { code?: string; message?: string } | null | undefined;

/** The leading `LEAVE_...` code of a database message, or null when it does not begin with one. */
const leadingCode = (message: string | undefined): string | null => /^LEAVE_[A-Z_]+/.exec(message ?? '')?.[0] ?? null;

/** A known code is answered with its sentence; anything else is logged (code and message only) and answered generically. */
function failed(fn: string, error: DbError): CapResult<never> {
  const code = leadingCode(error?.message);
  if (code && Object.hasOwn(LEAVE_REFUSALS, code)) return refuse(LEAVE_REFUSALS[code]);
  return writeFailed(fn, error);
}

// ---- Inputs --------------------------------------------------------------------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Any Postgres uuid: `.uuid()` would refuse ids that are valid but not RFC-versioned.
const employee = z.guid().describe('The employee, by their id from listEmployees.');
const requestId = z.guid().describe('The request, by its id.');
const date = (what: string) =>
  z.string().refine(isRealDate, `${what} must be a real date, as YYYY-MM-DD.`);
const time = (what: string) => z.string().regex(TIME, `${what} must be a time, as HH:MM.`);
const reason = z.string().trim().max(500, 'Keep the reason to 500 characters.').nullable().optional();
const note = z.string().trim().max(500, 'Keep the note to 500 characters.').nullable().optional();

const LEAVE_TYPES = ['annual', 'medical', 'emergency', 'unpaid', 'maternity', 'paternity'] as const;
const BALANCE_TYPES = ['annual', 'medical', 'emergency'] as const;

// No cross-field refinements here (end after start, and so on): they would stop a later task from
// `.omit()`-ing a field to make a variant of a schema. The functions below check them, and so does the database.
export const applyLeaveInput = z.object({
  employee_id: employee,
  leave_type: z.enum(LEAVE_TYPES),
  start_date: date('The start date'),
  end_date: date('The end date'),
  half_day: z.boolean().optional().describe('Half a day; only for a single date.'),
  reason,
});
export const previewLeaveInput = applyLeaveInput.omit({ reason: true });
export const applyTimeOffInput = z.object({
  employee_id: employee,
  off_date: date('The date'),
  start_time: time('The start time'),
  end_time: time('The end time'),
  reason,
});
export const requestIdInput = z.object({ id: requestId });
export const decideInput = z.object({
  id: requestId,
  approve: z.boolean(),
  note: note.describe('Why it was rejected, if you want to say.'),
});
export const setLeaveEntitlementInput = z.object({
  employee_id: employee,
  leave_type: z.enum(BALANCE_TYPES),
  year: z.number().int('The year must be a whole number.').min(2000).max(2100),
  days: z
    .number()
    .min(0, 'Days cannot be negative.')
    .max(365, 'That is more than a year of days.')
    .refine((n) => Number.isInteger(n * 2), 'Use whole or half days.'),
});

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
const count = (value: unknown): number | null => {
  const n = Number(value);
  return value === null || value === '' || value === undefined || !Number.isFinite(n) ? null : n;
};

export type LeavePreview = {
  days: number;
  years: { year: number; days: number; entitled: number; used: number; pending: number; remaining_after: number }[];
  over_by: number;
};

function pickPreview(row: Row): LeavePreview | null {
  const days = count(row.days);
  const overBy = count(row.over_by);
  if (days === null || overBy === null || !Array.isArray(row.years)) return null;
  const years: LeavePreview['years'] = [];
  for (const part of row.years) {
    if (!isRow(part)) return null;
    const values = [part.year, part.days, part.entitled, part.used, part.pending, part.remaining_after].map(count);
    if (values.some((n) => n === null)) return null;
    const [year, partDays, entitled, used, pending, remaining] = values as number[];
    years.push({ year, days: partDays, entitled, used, pending, remaining_after: remaining });
  }
  return { days, years, over_by: overBy };
}

const pickStatus = (row: Row): { id: string; status: string } | null => {
  const id = text(row.id);
  const status = text(row.status);
  return id && status ? { id, status } : null;
};

/** What applying for or previewing leave sends: the same arguments, a half day only ever for one date. */
const leaveArgs = (v: z.infer<typeof previewLeaveInput>) => ({
  p_employee: v.employee_id,
  p_leave_type: v.leave_type,
  p_start: v.start_date,
  p_end: v.end_date,
  p_half_day: v.half_day ?? false,
});

/** A range that ends before it starts, or a half day over several dates, is refused before any call. */
const badRange = (v: { start_date: string; end_date: string; half_day?: boolean }): boolean =>
  v.end_date < v.start_date || (v.half_day === true && v.start_date !== v.end_date);

/** Counts the days a leave request would cost and what is left after it. Writes nothing. */
export async function previewLeave(
  ctx: PeopleWriteContext,
  input: z.infer<typeof previewLeaveInput>,
): Promise<CapResult<LeavePreview>> {
  const parsed = parse(previewLeaveInput, input);
  if (!parsed.ok) return parsed;
  if (badRange(parsed.data)) return refuse(LEAVE_REFUSALS.LEAVE_BAD_INPUT);
  return call(ctx, 'previewLeave', 'hr_leave_preview', leaveArgs(parsed.data), pickPreview);
}

export async function applyLeave(
  ctx: PeopleWriteContext,
  input: z.infer<typeof applyLeaveInput>,
): Promise<CapResult<{ id: string; days: number; status: string }>> {
  const parsed = parse(applyLeaveInput, input);
  if (!parsed.ok) return parsed;
  if (badRange(parsed.data)) return refuse(LEAVE_REFUSALS.LEAVE_BAD_INPUT);
  return call(
    ctx,
    'applyLeave',
    'hr_apply_leave',
    { ...leaveArgs(parsed.data), p_reason: orNull(parsed.data.reason) },
    (row) => {
      const saved = pickStatus(row);
      const days = count(row.days);
      return saved && days !== null ? { ...saved, days } : null;
    },
  );
}

export async function applyTimeOff(
  ctx: PeopleWriteContext,
  input: z.infer<typeof applyTimeOffInput>,
): Promise<CapResult<{ id: string; status: string }>> {
  const parsed = parse(applyTimeOffInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  if (v.end_time <= v.start_time) return refuse(LEAVE_REFUSALS.LEAVE_BAD_INPUT);
  return call(
    ctx,
    'applyTimeOff',
    'hr_apply_time_off',
    // Times go as HH:MM; the database answers HH:MM:SS.
    { p_employee: v.employee_id, p_off_date: v.off_date, p_start_time: v.start_time, p_end_time: v.end_time, p_reason: orNull(v.reason) },
    pickStatus,
  );
}

export async function cancelLeave(
  ctx: PeopleWriteContext,
  input: z.infer<typeof requestIdInput>,
): Promise<CapResult<{ id: string; status: string }>> {
  const parsed = parse(requestIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'cancelLeave', 'hr_cancel_leave', { p_request: parsed.data.id }, pickStatus);
}

export async function cancelTimeOff(
  ctx: PeopleWriteContext,
  input: z.infer<typeof requestIdInput>,
): Promise<CapResult<{ id: string; status: string }>> {
  const parsed = parse(requestIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'cancelTimeOff', 'hr_cancel_time_off', { p_request: parsed.data.id }, pickStatus);
}

export async function decideLeave(
  ctx: PeopleWriteContext,
  input: z.infer<typeof decideInput>,
): Promise<CapResult<{ id: string; status: string }>> {
  const parsed = parse(decideInput, input);
  if (!parsed.ok) return parsed;
  const { id, approve, note: why } = parsed.data;
  return call(ctx, 'decideLeave', 'hr_decide_leave', { p_request: id, p_approve: approve, p_note: orNull(why) }, pickStatus);
}

export async function decideTimeOff(
  ctx: PeopleWriteContext,
  input: z.infer<typeof decideInput>,
): Promise<CapResult<{ id: string; status: string }>> {
  const parsed = parse(decideInput, input);
  if (!parsed.ok) return parsed;
  const { id, approve, note: why } = parsed.data;
  return call(ctx, 'decideTimeOff', 'hr_decide_time_off', { p_request: id, p_approve: approve, p_note: orNull(why) }, pickStatus);
}

export async function setLeaveEntitlement(
  ctx: PeopleWriteContext,
  input: z.infer<typeof setLeaveEntitlementInput>,
): Promise<CapResult<{ employee_id: string; leave_type: string; year: number; entitled_days: number }>> {
  const parsed = parse(setLeaveEntitlementInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'setLeaveEntitlement',
    'hr_set_leave_entitlement',
    { p_employee: v.employee_id, p_leave_type: v.leave_type, p_year: v.year, p_days: v.days },
    (row) => {
      const employeeId = text(row.employee_id);
      const leaveType = text(row.leave_type);
      const year = count(row.year);
      const entitled = count(row.entitled_days);
      return employeeId && leaveType && year !== null && entitled !== null
        ? { employee_id: employeeId, leave_type: leaveType, year, entitled_days: entitled }
        : null;
    },
  );
}

// ---- Over balance --------------------------------------------------------------------

const HAS_BALANCE = new Set<LeaveType>(['annual', 'medical', 'emergency']);
const yearOf = (day: string): number => Number(day.slice(0, 4));
const tenths = (n: number): number => Math.round(n * 10) / 10;

/**
 * By how many days a request exceeds what is left, 0 when within balance or when the type has no balance.
 * left = entitled - used - (other PENDING requests of the same employee, type and year, excluding this one).
 * The one formula for the approvals queue and for Lekiu's lookups; the database's preview uses the same rule.
 *
 * Only a pending request can be over balance: an approved one is already inside `used_days`, so it is
 * 0 here, and so is a request whose year has no balance row (the database creates the rows when leave is
 * applied for, so a saved pending request normally has one).
 *
 * The year is the one the request starts in, and all its days are charged to it. The database's preview
 * sums each touched year's shortfall, which is the same for a request inside one year. For a request that
 * crosses New Year this has no end date or holiday list to split the days with, so it measures the whole
 * request against the starting year: it can differ from the preview, which charges each year only its part.
 */
export function overBalanceBy(
  request: { id: string; employee_id: string; leave_type: LeaveType; start_date: string; days: number; status: RequestStatus },
  balances: LeaveBalance[],
  requests: LeaveRequest[],
): number {
  if (request.status !== 'pending' || !HAS_BALANCE.has(request.leave_type)) return 0;
  const year = yearOf(request.start_date);
  const row = balances.find(
    (b) => b.employee_id === request.employee_id && b.leave_type === request.leave_type && b.year === year,
  );
  if (!row) return 0;
  const others = requests
    .filter(
      (r) =>
        r.id !== request.id &&
        r.status === 'pending' &&
        r.employee_id === request.employee_id &&
        r.leave_type === request.leave_type &&
        yearOf(r.start_date) === year,
    )
    .reduce((sum, r) => sum + Number(r.days), 0);
  const left = Number(row.entitled_days) - Number(row.used_days) - others;
  return Math.max(0, tenths(Number(request.days) - left));
}
