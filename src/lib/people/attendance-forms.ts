/**
 * Attendance logic apart from the components: what today is for one employee
 * (the one rule behind the My Attendance screen, its button and Lekiu's "today"
 * lookup), and what a filled-in correction, holiday or settings form sends.
 * Pure: no clock, no network. Times are Malaysia time.
 *
 * {@link todayState} is a display aid. The database is the judge of every
 * clock-in and clock-out, and says so in its own sentence when this is wrong.
 * Whether a clock-in was present or late is never worked out here.
 */
import { clockTime, isRealDate, weekdayKey } from './dates';
import type { AttendanceDay, AttendanceStatus, LeaveRequest, PublicHoliday, Weekday } from './types';
import { WEEKDAYS } from './types';

// ---- Today -------------------------------------------------------------------------

/**
 * `since`, `from` and `to` are clock times already worded for the screen ("8:52 am"); `worked` is the whole
 * minutes between the two as the screen shows them ("9 h 11 min").
 */
export type TodayState =
  | { kind: 'not_linked' }
  | { kind: 'not_working_day'; why: 'weekend' | 'holiday'; holiday?: string }
  | { kind: 'on_leave' }
  | { kind: 'not_in' }
  | { kind: 'in'; since: string }
  | { kind: 'done'; from: string; to: string; worked: string };

const minutesOfDay = (instant: string): number => {
  const t = clockTime(instant); // HH:MM, or an em dash for an instant that is not one
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
};

/** `8:52 am`, `12:00 pm`, `12:05 am`. */
function clockLabel(instant: string): string {
  const t = clockTime(instant);
  if (!/^\d{2}:\d{2}$/.test(t)) return '—';
  const hour = Number(t.slice(0, 2));
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${t.slice(3, 5)} ${hour < 12 ? 'am' : 'pm'}`;
}

/** Whole minutes as the screen shows them: `9 h 11 min`, `8 h`, `45 min`. */
function span(minutes: number): string {
  const m = Math.max(0, minutes);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

const DEFAULT_WEEK: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

/**
 * What today is for one employee, from rows the page already has. The checks run in the database's order:
 * a clock-in that exists is shown as it is; otherwise a day that is not a working day (a public holiday, named,
 * ahead of a weekend), then approved full-day leave, else the employee has not clocked in. A half-day leave
 * is not "on leave": the database lets that person clock in. A work week naming no known day counts as
 * Monday to Friday, as the database reads it. A row that is only a correction with no clock-in does not
 * count as clocked in, nor does a clock-in later than `nowHm`.
 */
export function todayState(input: {
  today: string;
  day: AttendanceDay | null;
  workWeek: Weekday[];
  holidays: PublicHoliday[];
  leave: LeaveRequest[];
  employeeId: string | null;
  /** The time now in Malaysia as `HH:MM`. Given, a clock-in later than it (older data only) does not count as clocked in. */
  nowHm?: string;
}): TodayState {
  const { today, day, holidays, leave, employeeId, nowHm } = input;
  if (!employeeId) return { kind: 'not_linked' };

  const started = day && day.work_date === today && day.clock_in && !(nowHm && clockTime(day.clock_in) > nowHm);
  if (day && started && day.clock_in) {
    if (!day.clock_out) return { kind: 'in', since: clockLabel(day.clock_in) };
    return {
      kind: 'done',
      from: clockLabel(day.clock_in),
      to: clockLabel(day.clock_out),
      worked: span(minutesOfDay(day.clock_out) - minutesOfDay(day.clock_in)),
    };
  }

  const holiday = holidays.find((h) => h.holiday_date === today);
  if (holiday) return { kind: 'not_working_day', why: 'holiday', holiday: holiday.name };
  const week = WEEKDAYS.some((d) => input.workWeek.includes(d)) ? input.workWeek : DEFAULT_WEEK;
  if (!week.includes(weekdayKey(today))) return { kind: 'not_working_day', why: 'weekend' };

  const away = leave.some(
    (r) => r.employee_id === employeeId && r.status === 'approved' && !r.half_day && r.start_date <= today && r.end_date >= today,
  );
  if (away) return { kind: 'on_leave' };
  return { kind: 'not_in' };
}

/** The sentence for the top of My Attendance and for Lekiu's answer. */
export function todayLine(state: TodayState): string {
  switch (state.kind) {
    case 'not_linked':
      return "Your account isn't linked to an employee record yet.";
    case 'not_working_day':
      if (state.why === 'weekend') return 'Today is not a working day.';
      return state.holiday ? `Today is a public holiday: ${state.holiday}.` : 'Today is a public holiday.';
    case 'on_leave':
      return 'You are on approved leave today.';
    case 'not_in':
      return 'Not clocked in yet';
    case 'in':
      return `In since ${state.since}`;
    case 'done':
      return `${state.from} to ${state.to}, ${state.worked}`;
  }
}

/** Which button the screen shows, if any. */
export function clockAction(state: TodayState): 'in' | 'out' | null {
  if (state.kind === 'not_in') return 'in';
  if (state.kind === 'in') return 'out';
  return null;
}

// ---- Forms ---------------------------------------------------------------------------

type Converted<T> = { ok: true; input: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
/** A time field's value as `HH:MM` (a field with seconds is cut back), or null when it is not a time of day. */
const toHourMinute = (value: string): string | null => {
  const match = TIME.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : null;
};

export type CorrectionFormValues = {
  employee_id: string;
  work_date: string;
  status: AttendanceStatus;
  /** What the time field holds; empty for none. */
  clock_in: string;
  clock_out: string;
  note: string;
};

export type CorrectionFormInput = {
  employee_id: string;
  work_date: string;
  status: AttendanceStatus;
  clock_in: string | null;
  clock_out: string | null;
  note: string | null;
};

const NOTE_MAX = 500;

/** The sentence for a clock-in or clock-out later than now, on today. */
export const NOT_YET = 'That time has not happened yet. For today, leave clock-out empty if they are still at work.';

/**
 * Absent and on-leave days take no times, so any in the fields (left from choosing another status) are dropped,
 * not refused. A clock-out is optional, and must come after the clock-in. A future day is refused before asking
 * the server. For today, a clock-in or clock-out later than `nowHm` (the time now in Malaysia, `HH:MM`) is
 * refused too: the database would refuse it with a sentence too vague to act on. Without `nowHm` that check
 * is skipped and the database is the only judge.
 */
export function toCorrectionInput(values: CorrectionFormValues, today: string, nowHm?: string): Converted<CorrectionFormInput> {
  if (!values.employee_id) return bad('Choose an employee.');
  if (!values.work_date) return bad('Choose the day to correct.');
  if (!isRealDate(values.work_date)) return bad('Choose a real date.');
  if (values.work_date < '2000-01-01') return bad('The date cannot be before the year 2000.');
  if (values.work_date > today) return bad('The date cannot be in the future.');
  const note = values.note.trim();
  if (note.length > NOTE_MAX) return bad(`Keep the note to ${NOTE_MAX} characters.`);

  let clockIn: string | null = null;
  let clockOut: string | null = null;
  if (values.status === 'present' || values.status === 'late') {
    if (values.clock_in.trim() === '') return bad('Enter the time they clocked in.');
    clockIn = toHourMinute(values.clock_in);
    if (!clockIn) return bad('Enter the clock-in as a time, like 09:00.');
    if (values.clock_out.trim() !== '') {
      clockOut = toHourMinute(values.clock_out);
      if (!clockOut) return bad('Enter the clock-out as a time, like 18:00.');
      if (clockOut <= clockIn) return bad('The clock-out must be after the clock-in.');
    }
    if (nowHm && values.work_date === today && (clockIn > nowHm || (clockOut !== null && clockOut > nowHm))) {
      return bad(NOT_YET);
    }
  }
  return {
    ok: true,
    input: {
      employee_id: values.employee_id,
      work_date: values.work_date,
      status: values.status,
      clock_in: clockIn,
      clock_out: clockOut,
      note: note === '' ? null : note,
    },
  };
}

export type HolidayFormValues = { id: string | null; name: string; holiday_date: string };
export type HolidayFormInput = { id: string | null; name: string; holiday_date: string };

const NAME_MAX = 120;

export function toHolidayInput(values: HolidayFormValues): Converted<HolidayFormInput> {
  const name = values.name.trim();
  if (name === '') return bad('Give the holiday a name.');
  if (name.length > NAME_MAX) return bad(`Keep the name to ${NAME_MAX} characters.`);
  if (!values.holiday_date) return bad('Choose the date.');
  if (!isRealDate(values.holiday_date)) return bad('Choose a real date.');
  if (values.holiday_date < '2000-01-01' || values.holiday_date > '2100-12-31') return bad('Choose a date from 2000 to 2100.');
  return { ok: true, input: { id: values.id ? values.id : null, name, holiday_date: values.holiday_date } };
}

export type SettingsFormValues = {
  work_week: Weekday[];
  work_start_time: string;
  /** What was typed. */
  late_grace_minutes: string;
};

export type SettingsFormInput = { work_week: Weekday[]; work_start_time: string; late_grace_minutes: number };

/** The week is sent Monday first, as the database keeps it. */
export function toSettingsInput(values: SettingsFormValues): Converted<SettingsFormInput> {
  if (values.work_week.length === 0) return bad('Choose at least one working day.');
  if (new Set(values.work_week).size !== values.work_week.length) return bad('Each working day can be chosen only once.');
  const start = toHourMinute(values.work_start_time);
  if (!start) return bad('Enter the start time, like 09:00.');
  const typed = values.late_grace_minutes.trim();
  const grace = /^\d{1,3}$/.test(typed) ? Number(typed) : Number.NaN;
  if (!Number.isInteger(grace) || grace > 240) return bad('Enter the grace period as whole minutes, from 0 to 240.');
  return {
    ok: true,
    input: {
      work_week: WEEKDAYS.filter((day) => values.work_week.includes(day)),
      work_start_time: start,
      late_grace_minutes: grace,
    },
  };
}
