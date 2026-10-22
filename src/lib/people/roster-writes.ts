/**
 * The app's write path for the roster and for hours. Each change is one call
 * to a database function (`hr_save_roster`, `hr_save_hours`): the two tables
 * take no direct writes, and the functions decide who may do what. This file
 * only validates the shape of an input, makes the call and turns a refusal
 * into a sentence.
 *
 * A refusal arrives as a Postgres error whose message begins with a code, for
 * example `HOURS_OUTSIDE_WINDOW`. The workspace for the roster comes from the
 * session's context, never from the input.
 */
import { z } from 'zod';
import { type CapResult, type PeopleWriteContext, refuse, writeFailed } from './capabilities';
import { addDays, isRealDate, weekStart } from './dates';
import { shiftTypeOf } from './roster';
import { SHIFT_COLORS, type ShiftColor, type ShiftType } from './types';

/** Each refusal code the two functions raise, and what the person is told. */
export const ROSTER_REFUSALS: Record<string, string> = {
  ROSTER_NOT_ALLOWED: 'Only owners and admins can change the roster.',
  ROSTER_NOT_MONDAY: 'A roster week starts on a Monday.',
  ROSTER_BAD_INPUT: 'Some of the roster was not accepted. Refresh the page and try again.',
  ROSTER_BAD_EMPLOYEE: 'One of those employees is not in this workspace. Refresh the page and try again.',
  ROSTER_INACTIVE_EMPLOYEE: 'One of those employees is inactive, so their shifts cannot be changed.',
  ROSTER_BAD_SHIFT_TYPE: 'One of those shift types is not in this workspace. Refresh the page and try again.',
  ROSTER_ARCHIVED_SHIFT_TYPE: 'One of those shift types is archived, so it cannot be picked. Choose another type.',
  HOURS_NOT_ALLOWED: "You can't record hours for that employee.",
  HOURS_FUTURE_DAY: "Hours can't be recorded for a day that hasn't happened yet.",
  HOURS_OUTSIDE_WINDOW: 'You can record your own hours for this week and last week only. Ask an owner or admin to correct an older week.',
  HOURS_INACTIVE_EMPLOYEE: 'This employee record is inactive, so hours cannot be recorded.',
  HOURS_BAD_INPUT: 'Hours must be 0 to 24 in steps of half an hour, and billable hours no more than the hours.',
  SHIFT_TYPE_NOT_ALLOWED: 'Only owners and admins can change shift types.',
  SHIFT_TYPE_NOT_FOUND: 'That shift type was not found.',
  SHIFT_TYPE_EXISTS: 'There is already a shift type with that name.',
  SHIFT_TYPE_ARCHIVED: 'That shift type is archived. Bring it back before changing it.',
  SHIFT_TYPE_BAD_INPUT:
    'That shift type was not accepted. It needs a name of up to 40 characters, a colour from the list, and both times or neither (an off type has none).',
};

type DbError = { code?: string; message?: string } | null | undefined;

const leadingCode = (message: string | undefined): string | null =>
  /^(ROSTER|HOURS|SHIFT_TYPE)_[A-Z_]+/.exec(message ?? '')?.[0] ?? null;

function failed(fn: string, error: DbError): CapResult<never> {
  const code = leadingCode(error?.message);
  if (code && Object.hasOwn(ROSTER_REFUSALS, code)) return refuse(ROSTER_REFUSALS[code]);
  return writeFailed(fn, error);
}

// ---- Inputs --------------------------------------------------------------------

/** The most cells one save may carry: a week for 1,000 employees. The database holds the same limit. */
export const MAX_ROSTER_CELLS = 7000;

const guid = z.guid();
const date = z
  .string()
  .refine(isRealDate, 'A date must be a real date, as YYYY-MM-DD.')
  .refine((value) => value >= '2000-01-01' && value <= '2100-12-31', 'A date must be between 2000 and 2100.');

export const saveRosterInput = z
  .object({
    week_start: date.refine((value) => weekStart(value) === value, 'A roster week starts on a Monday.'),
    cells: z
      .array(z.object({ employee_id: guid, work_date: date, shift_type_id: guid.nullable() }))
      .max(MAX_ROSTER_CELLS, 'That is too many cells for one save.'),
  })
  .refine(
    (v) => v.cells.every((c) => c.work_date >= v.week_start && c.work_date <= addDays(v.week_start, 6)),
    'Every cell must be in the week being saved.',
  );

const halfHours = (what: string) =>
  z
    .number()
    .min(0, `${what} cannot be below 0.`)
    .max(24, `${what} cannot be more than 24.`)
    .refine((value) => Number.isInteger(value * 2), `${what} must be in steps of half an hour.`);

export const saveHoursInput = z
  .object({
    employee_id: guid,
    work_date: date,
    hours: halfHours('Hours').nullable(),
    billable_hours: halfHours('Billable hours').nullable(),
  })
  .refine((v) => v.hours !== null || v.billable_hours === null, 'Enter the hours before the billable hours.')
  .refine((v) => v.hours === null || (v.billable_hours ?? 0) <= v.hours, 'Billable hours cannot be more than the hours.');

function parse<S extends z.ZodType>(schema: S, input: unknown): CapResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return refuse(parsed.error.issues[0]?.message ?? 'That input was not valid.');
}

// ---- Calls -----------------------------------------------------------------------

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);
const hoursOf = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

export type RosterSaved = { week: string; saved: number; removed: number };

/** Saves the changed cells of one week for the session's workspace, all or nothing. */
export async function saveRoster(
  ctx: PeopleWriteContext,
  input: z.infer<typeof saveRosterInput>,
): Promise<CapResult<RosterSaved>> {
  const parsed = parse(saveRosterInput, input);
  if (!parsed.ok) return parsed;
  const { data, error } = await ctx.client.rpc('hr_save_roster', {
    p_org: ctx.orgId,
    p_week: parsed.data.week_start,
    p_cells: parsed.data.cells,
  });
  if (error) return failed('saveRoster', error);
  const week = isRow(data) && typeof data.week === 'string' ? data.week : null;
  const saved = isRow(data) ? count(data.saved) : null;
  const removed = isRow(data) ? count(data.removed) : null;
  if (week === null || saved === null || removed === null) return writeFailed('saveRoster', { message: 'unexpected reply' });
  return { ok: true, data: { week, saved, removed } };
}

export type HoursSaved = { employee_id: string; work_date: string; hours: number | null; billable_hours: number | null };

/** Saves (or, with no hours, clears) one day's hours for one employee. */
export async function saveHours(
  ctx: PeopleWriteContext,
  input: z.infer<typeof saveHoursInput>,
): Promise<CapResult<HoursSaved>> {
  const parsed = parse(saveHoursInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  const { data, error } = await ctx.client.rpc('hr_save_hours', {
    p_employee: v.employee_id,
    p_work_date: v.work_date,
    p_hours: v.hours,
    p_billable: v.hours === null ? null : v.billable_hours,
  });
  if (error) return failed('saveHours', error);
  if (!isRow(data)) return writeFailed('saveHours', { message: 'unexpected reply' });
  const hours = hoursOf(data.hours);
  const billable = hoursOf(data.billable_hours);
  if (typeof data.employee_id !== 'string' || typeof data.work_date !== 'string' || hours === undefined || billable === undefined) {
    return writeFailed('saveHours', { message: 'unexpected reply' });
  }
  return { ok: true, data: { employee_id: data.employee_id, work_date: data.work_date, hours, billable_hours: billable } };
}

// ---- Shift types -----------------------------------------------------------------

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times must be times of day, as HH:MM.');

export const saveShiftTypeInput = z
  .object({
    id: guid.nullish(),
    name: z.string().trim().min(1, 'Give the shift type a name.').max(40, 'Keep the name to 40 characters.'),
    is_off: z.boolean(),
    start_time: clock.nullable(),
    end_time: clock.nullable(),
    color: z.enum(SHIFT_COLORS as unknown as [ShiftColor, ...ShiftColor[]]),
  })
  .refine((v) => (v.start_time === null) === (v.end_time === null), 'Give both a start and an end time, or neither.')
  .refine((v) => !v.is_off || v.start_time === null, 'An off type has no times.');

export const archiveShiftTypeInput = z.object({ id: guid, archived: z.boolean() });

const pickType = (data: unknown): ShiftType | null => {
  if (!isRow(data) || typeof data.id !== 'string' || typeof data.name !== 'string' || typeof data.is_off !== 'boolean') return null;
  return shiftTypeOf({
    id: data.id,
    name: data.name,
    start_time: typeof data.start_time === 'string' ? data.start_time : null,
    end_time: typeof data.end_time === 'string' ? data.end_time : null,
    is_off: data.is_off,
    color: typeof data.color === 'string' ? data.color : 'slate',
    archived_at: data.archived === true ? 'archived' : null,
  });
};

/** Adds a shift type (no id) or changes one, in the session's workspace. */
export async function saveShiftType(
  ctx: PeopleWriteContext,
  input: z.infer<typeof saveShiftTypeInput>,
): Promise<CapResult<ShiftType>> {
  const parsed = parse(saveShiftTypeInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  const { data, error } = await ctx.client.rpc('hr_save_shift_type', {
    p_org: ctx.orgId,
    p_id: v.id ?? null,
    p_name: v.name,
    p_start_time: v.start_time,
    p_end_time: v.end_time,
    p_is_off: v.is_off,
    p_color: v.color,
  });
  if (error) return failed('saveShiftType', error);
  const type = pickType(data);
  return type ? { ok: true, data: type } : writeFailed('saveShiftType', { message: 'unexpected reply' });
}

/** Archives a shift type, or brings one back. */
export async function archiveShiftType(
  ctx: PeopleWriteContext,
  input: z.infer<typeof archiveShiftTypeInput>,
): Promise<CapResult<ShiftType>> {
  const parsed = parse(archiveShiftTypeInput, input);
  if (!parsed.ok) return parsed;
  const { data, error } = await ctx.client.rpc('hr_archive_shift_type', { p_id: parsed.data.id, p_archived: parsed.data.archived });
  if (error) return failed('archiveShiftType', error);
  const type = pickType(data);
  return type ? { ok: true, data: type } : writeFailed('archiveShiftType', { message: 'unexpected reply' });
}

/**
 * Adds the three default types to a workspace that has none (an owner or admin, outside the demo). Used when the
 * Shift Calendar finds no types for HR; never throws, so a failure only leaves the picker empty.
 */
export async function ensureShiftTypes(ctx: PeopleWriteContext): Promise<number> {
  try {
    const { data, error } = await ctx.client.rpc('hr_ensure_shift_types', { p_org: ctx.orgId });
    if (error) {
      console.error('[people/roster] default shift types:', error.code ?? 'no-code');
      return 0;
    }
    return isRow(data) && typeof data.added === 'number' ? data.added : 0;
  } catch (error) {
    console.error('[people/roster] default shift types:', error instanceof Error ? error.name : 'error');
    return 0;
  }
}
