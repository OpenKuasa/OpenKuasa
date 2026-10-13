/**
 * The app's write path for attendance, public holidays and the three attendance
 * settings. Every change is one call to a database function (`hr_clock_in`,
 * `hr_correct_attendance`, ...): the three tables take no direct writes, and the
 * functions decide who may do what and whether a day is present or late. This
 * file only validates the shape of an input, makes the call and turns a refusal
 * into a sentence.
 *
 * No clock time ever comes from the caller. Clocking in and out send the
 * employee and nothing else; the database stamps the time and the day. A
 * correction states times as `HH:MM` on Malaysia's clock, for an owner or admin.
 *
 * A refusal arrives as a Postgres error whose message begins with a code, for
 * example `ATT_NOT_IN`. `org_id` of an employee's day and the acting user are
 * never arguments; the workspace is one only for a new holiday and the settings,
 * and there it comes from the session's context, never from the input.
 */
import { z } from 'zod';
import {
  type CapResult,
  type PeopleWriteContext,
  refuse,
  writeFailed,
} from './capabilities';
import { isRealDate } from './dates';
import { type AttendanceStatus, type Weekday, WEEKDAYS } from './types';

// ---- Sentences ---------------------------------------------------------------

/** Each refusal code the attendance functions raise, and what the person is told. */
export const ATT_REFUSALS: Record<string, string> = {
  ATT_NOT_ALLOWED: "You can't make that change.",
  ATT_NOT_FOUND: 'That record was not found.',
  ATT_ALREADY_IN: 'You have already clocked in today.',
  ATT_NOT_IN: "You haven't clocked in today.",
  ATT_ALREADY_OUT: 'You have already clocked out today.',
  ATT_NOT_WORKING_DAY: 'Today is not a working day. Ask an owner or admin to record it if you worked.',
  ATT_ON_LEAVE: 'You are on approved leave today.',
  ATT_INACTIVE_EMPLOYEE: 'This employee record is inactive, so attendance cannot be clocked.',
  ATT_HOLIDAY_EXISTS: 'There is already a public holiday on that date.',
  ATT_BAD_INPUT:
    'Some of that was not accepted. A date or time may be in the future, a time may not be a time of day, a clock-out may not be after the clock-in, or a name or note may be too long or empty. Check it and try again.',
};

type DbError = { code?: string; message?: string } | null | undefined;

/** The leading `ATT_...` code of a database message, or null when it does not begin with one. */
const leadingCode = (message: string | undefined): string | null => /^ATT_[A-Z_]+/.exec(message ?? '')?.[0] ?? null;

/** A known code is answered with its sentence; anything else is logged, code and message only, and answered generically. */
function failed(fn: string, error: DbError): CapResult<never> {
  const code = leadingCode(error?.message);
  if (code && Object.hasOwn(ATT_REFUSALS, code)) return refuse(ATT_REFUSALS[code]);
  return writeFailed(fn, error);
}

// ---- Inputs --------------------------------------------------------------------

// Any Postgres uuid: `.uuid()` would refuse ids that are valid but not RFC-versioned.
const guid = (what: string) => z.guid().describe(what);
const date = (what: string) =>
  z
    .string()
    .refine(isRealDate, `${what} must be a real date, as YYYY-MM-DD.`)
    .refine((value) => value >= '2000-01-01', `${what} cannot be before the year 2000.`);
const time = (what: string) =>
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${what} must be a time of day, as HH:MM.`);

const STATUSES = ['present', 'late', 'absent', 'on_leave'] as const satisfies readonly AttendanceStatus[];

// No cross-field refinements here (a clock-out after the clock-in, times only on a worked day): the database
// refuses them as ATT_BAD_INPUT, and a schema without them can be `.omit()`-ed by a later task. The database
// also checks the date against today in Malaysia.
export const correctAttendanceInput = z.object({
  employee_id: guid('The employee, by their id from listEmployees.'),
  work_date: date('The day'),
  status: z.enum(STATUSES),
  clock_in: time('The clock-in').nullish().describe('HH:MM, Malaysia time. Needed for present and late; none for absent and on leave.'),
  clock_out: time('The clock-out').nullish().describe('HH:MM, Malaysia time, after the clock-in. Optional.'),
  note: z.string().trim().max(500, 'Keep the note to 500 characters.').nullish(),
});

export const saveHolidayInput = z.object({
  id: guid('The holiday to change, by its id from listPublicHolidays. Leave out to add one.').nullish(),
  name: z.string().trim().min(1, 'Give the holiday a name.').max(120, 'Keep the name to 120 characters.'),
  holiday_date: date('The date').refine((value) => value <= '2100-12-31', 'The date cannot be after the year 2100.'),
});

export const holidayIdInput = z.object({ id: guid('The holiday, by its id from listPublicHolidays.') });

const weekday = z.enum(WEEKDAYS as [Weekday, ...Weekday[]]);
export const attendanceSettingsInput = z.object({
  work_week: z
    .array(weekday)
    .min(1, 'Choose at least one working day.')
    .refine((week) => new Set(week).size === week.length, 'Each working day can be chosen only once.'),
  work_start_time: time('The start time'),
  late_grace_minutes: z
    .number()
    .int('The grace period must be whole minutes.')
    .min(0, 'The grace period cannot be below 0 minutes.')
    .max(240, 'The grace period cannot be above 240 minutes.'),
});

/** Only the employee: the person is the viewer's own, and the database fixes the day and the time. */
const clockInput = z.object({ employee_id: guid('The employee, taken from the signed-in user.') });

function parse<S extends z.ZodType>(schema: S, input: unknown): CapResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return refuse(parsed.error.issues[0]?.message ?? 'That input was not valid.');
}

// ---- Calls -----------------------------------------------------------------------

export type ClockedDay = {
  id: string;
  work_date: string;
  clock_in: string | null;
  clock_out: string | null;
  status: AttendanceStatus;
};

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const orNull = (value: string | null | undefined): string | null => (value ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
/** `HH:MM:SS` from the database as `HH:MM`. */
const hourMinute = (value: unknown): string | null => {
  const t = text(value);
  return t && /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t) ? t.slice(0, 5) : null;
};

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

const pickDay = (row: Row): ClockedDay | null => {
  const id = text(row.id);
  const workDate = text(row.work_date);
  const status = STATUSES.find((s) => s === row.status);
  const clockIn = row.clock_in === null ? null : text(row.clock_in);
  const clockOut = row.clock_out === null ? null : text(row.clock_out);
  if (!id || !workDate || !status) return null;
  if ((row.clock_in !== null && clockIn === null) || (row.clock_out !== null && clockOut === null)) return null;
  return { id, work_date: workDate, clock_in: clockIn, clock_out: clockOut, status };
};

/** Clocks the employee in now. The day and the time are the database's; present or late is its call too. */
export async function clockIn(
  ctx: PeopleWriteContext,
  input: z.infer<typeof clockInput>,
): Promise<CapResult<ClockedDay>> {
  const parsed = parse(clockInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'clockIn', 'hr_clock_in', { p_employee: parsed.data.employee_id }, pickDay);
}

/** Clocks the employee out now. */
export async function clockOut(
  ctx: PeopleWriteContext,
  input: z.infer<typeof clockInput>,
): Promise<CapResult<ClockedDay>> {
  const parsed = parse(clockInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'clockOut', 'hr_clock_out', { p_employee: parsed.data.employee_id }, pickDay);
}

/** An owner or admin sets a past day (or today): any status, times in Malaysia time, an optional note. */
export async function correctAttendance(
  ctx: PeopleWriteContext,
  input: z.infer<typeof correctAttendanceInput>,
): Promise<CapResult<ClockedDay>> {
  const parsed = parse(correctAttendanceInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'correctAttendance',
    'hr_correct_attendance',
    {
      p_employee: v.employee_id,
      p_work_date: v.work_date,
      p_status: v.status,
      p_clock_in: orNull(v.clock_in),
      p_clock_out: orNull(v.clock_out),
      p_note: orNull(v.note),
    },
    pickDay,
  );
}

/** Adds a public holiday (no id) or changes one (its id). The workspace is the session's. */
export async function saveHoliday(
  ctx: PeopleWriteContext,
  input: z.infer<typeof saveHolidayInput>,
): Promise<CapResult<{ id: string; name: string; holiday_date: string }>> {
  const parsed = parse(saveHolidayInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'saveHoliday',
    'hr_save_holiday',
    { p_org: ctx.orgId, p_id: v.id ?? null, p_name: v.name, p_holiday_date: v.holiday_date },
    (row) => {
      const id = text(row.id);
      const name = text(row.name);
      const holidayDate = text(row.holiday_date);
      return id && name && holidayDate ? { id, name, holiday_date: holidayDate } : null;
    },
  );
}

/** Removes a public holiday. Anyone but an owner or admin of its workspace is told it was not found. */
export async function deleteHoliday(
  ctx: PeopleWriteContext,
  input: z.infer<typeof holidayIdInput>,
): Promise<CapResult<{ id: string }>> {
  const parsed = parse(holidayIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'deleteHoliday', 'hr_delete_holiday', { p_id: parsed.data.id }, (row) => {
    const id = text(row.id);
    return id ? { id } : null;
  });
}

/** Saves the work week, the start time and the grace period together. The week comes back Monday first. */
export async function saveAttendanceSettings(
  ctx: PeopleWriteContext,
  input: z.infer<typeof attendanceSettingsInput>,
): Promise<CapResult<{ work_week: Weekday[]; work_start_time: string; late_grace_minutes: number }>> {
  const parsed = parse(attendanceSettingsInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'saveAttendanceSettings',
    'hr_save_attendance_settings',
    {
      p_org: ctx.orgId,
      p_work_week: v.work_week,
      p_work_start_time: v.work_start_time,
      p_late_grace_minutes: v.late_grace_minutes,
    },
    (row) => {
      const week = Array.isArray(row.work_week) ? WEEKDAYS.filter((day) => (row.work_week as unknown[]).includes(day)) : [];
      const start = hourMinute(row.work_start_time);
      const grace = typeof row.late_grace_minutes === 'number' ? row.late_grace_minutes : Number.NaN;
      return week.length > 0 && start && Number.isInteger(grace) ? { work_week: week, work_start_time: start, late_grace_minutes: grace } : null;
    },
  );
}
