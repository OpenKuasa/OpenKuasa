/**
 * The Team Attendance screen's model: one day, a row per active employee, and the tiles over them. Pure: the
 * caller passes the rows and "today". Present or late is whatever the row carries (the database decided it);
 * nothing here works it out from a clock time. Times are Malaysia time.
 */
import { addDays, clockTime, formatDate, isRealDate, weekdayKey, weekdayName } from './dates';
import { isTeamView } from './own';
import type {
  AttendanceDay,
  AttendanceStatus,
  Employee,
  LeaveRequest,
  PeopleData,
  PeopleViewer,
  PublicHoliday,
  Weekday,
} from './types';
import { WEEKDAYS } from './types';

export type RowTone = 'good' | 'pending' | 'bad' | 'neutral';

/** What the correction form opens with: the row's own values, or a present day with no times. */
export type CorrectionPrefill = {
  status: AttendanceStatus;
  /** `HH:MM`, or empty. */
  clock_in: string;
  clock_out: string;
  note: string;
};

export type TeamAttendanceRow = {
  employeeId: string;
  name: string;
  department: string | null;
  /** The row's status; "on_leave" also for a working day with approved leave and no row yet. Null: nothing to show. */
  status: AttendanceStatus | null;
  /** The pill's wording; empty when there is nothing to show (a non-working day with no row). */
  label: string;
  tone: RowTone;
  /** Worded times ("8:52 am"); null when there is none or the status takes none. */
  clockIn: string | null;
  clockOut: string | null;
  /** "9 h 11 min" when both times are there. */
  hours: string | null;
  /** A past day with a clock-in and no clock-out. */
  noClockOut: boolean;
  /** Today, clocked in, not out yet: not a missing clock-out. */
  stillIn: boolean;
  corrected: boolean;
  note: string | null;
  prefill: CorrectionPrefill;
};

export type TeamAttendanceModel = {
  hr_only: false;
  /** The day shown, `YYYY-MM-DD`. */
  date: string;
  today: string;
  isToday: boolean;
  /** "Friday, 09 Oct 2026". */
  heading: string;
  workingDay: boolean;
  /** Why it is not a working day ("Public holiday: Deepavali", "Weekend"); null on a working day. */
  nonWorkingReason: string | null;
  previous: string;
  /** Null when the day shown is today. */
  next: string | null;
  tiles: { present: number; late: number; absent: number; onLeave: number; noClockOut: number };
  rows: TeamAttendanceRow[];
};

export type TeamAttendanceInput = {
  date: string;
  today: string;
  employees: Employee[];
  /** Rows for `date` only (others are ignored). */
  attendance: AttendanceDay[];
  leave: LeaveRequest[];
  holidays: PublicHoliday[];
  workWeek: Weekday[];
};

const DEFAULT_WEEK: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const EARLIEST = '2000-01-01';

/**
 * The day to show from a `?date=` value: a real date from the year 2000, never after today; otherwise today.
 * An array (the parameter given twice) is not a date.
 */
export function parseDay(raw: string | string[] | undefined, today: string): string {
  if (typeof raw !== 'string' || !isRealDate(raw) || raw < EARLIEST || raw > today) return today;
  return raw;
}

/** `8:52 am`, from an instant; null when it is not one. */
function worded(instant: string | null): string | null {
  if (!instant) return null;
  const t = clockTime(instant);
  if (!/^\d{2}:\d{2}$/.test(t)) return null;
  const hour = Number(t.slice(0, 2));
  return `${hour % 12 === 0 ? 12 : hour % 12}:${t.slice(3, 5)} ${hour < 12 ? 'am' : 'pm'}`;
}

/** "9 h 11 min" between two instants; null when the end is not after the start. */
function worked(from: string, to: string): string | null {
  const minutes = Math.floor((Date.parse(to) - Date.parse(from)) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  late: 'Late',
  absent: 'Absent',
  on_leave: 'On leave',
};
const STATUS_TONE: Record<AttendanceStatus, RowTone> = {
  present: 'good',
  late: 'pending',
  absent: 'bad',
  on_leave: 'neutral',
};

/** Whether `date` is a working day, and if not why: a holiday (named) before a weekend, as the database reads it. */
export function dayKind(
  date: string,
  workWeek: Weekday[],
  holidays: PublicHoliday[],
): { working: true } | { working: false; reason: string } {
  const holiday = holidays.find((h) => h.holiday_date === date);
  if (holiday) return { working: false, reason: `Public holiday: ${holiday.name}` };
  const week = WEEKDAYS.some((d) => workWeek.includes(d)) ? workWeek : DEFAULT_WEEK;
  if (!week.includes(weekdayKey(date))) return { working: false, reason: 'Not a working day' };
  return { working: true };
}

export function buildTeamAttendanceModel(input: TeamAttendanceInput): TeamAttendanceModel {
  const { date, today } = input;
  const isToday = date === today;
  const kind = dayKind(date, input.workWeek, input.holidays);
  const byEmployee = new Map<string, AttendanceDay>();
  for (const day of input.attendance) if (day.work_date === date) byEmployee.set(day.employee_id, day);

  const rows = input.employees
    .filter((e) => e.status === 'active')
    .map((employee): TeamAttendanceRow => {
      const day = byEmployee.get(employee.id) ?? null;
      const base = { employeeId: employee.id, name: employee.name, department: employee.department_name };

      if (day) {
        const times = day.status === 'present' || day.status === 'late';
        const clockIn = times ? worded(day.clock_in) : null;
        const clockOut = times ? worded(day.clock_out) : null;
        const open = times && day.clock_in !== null && day.clock_out === null;
        return {
          ...base,
          status: day.status,
          label: STATUS_LABEL[day.status],
          tone: STATUS_TONE[day.status],
          clockIn,
          clockOut,
          hours: times && day.clock_in && day.clock_out ? worked(day.clock_in, day.clock_out) : null,
          noClockOut: open && !isToday,
          stillIn: open && isToday,
          corrected: day.corrected,
          note: day.corrected ? day.correction_note : null,
          prefill: {
            status: day.status,
            clock_in: times && day.clock_in ? clockTime(day.clock_in) : '',
            clock_out: times && day.clock_out ? clockTime(day.clock_out) : '',
            note: day.correction_note ?? '',
          },
        };
      }

      const empty = { clockIn: null, clockOut: null, hours: null, noClockOut: false, stillIn: false, corrected: false, note: null };
      const prefill: CorrectionPrefill = { status: 'present', clock_in: '', clock_out: '', note: '' };
      if (!kind.working) return { ...base, ...empty, status: null, label: '', tone: 'neutral', prefill };

      // The nightly close writes leave days; until it runs, approved full-day leave still shows as leave.
      const away = input.leave.some(
        (r) =>
          r.employee_id === employee.id && r.status === 'approved' && !r.half_day && r.start_date <= date && r.end_date >= date,
      );
      if (away) return { ...base, ...empty, status: 'on_leave', label: 'On leave', tone: 'neutral', prefill };
      return {
        ...base,
        ...empty,
        status: null,
        label: isToday ? 'Not clocked in yet' : 'No record',
        tone: 'neutral',
        prefill,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const count = (status: AttendanceStatus) => rows.filter((r) => r.status === status).length;
  return {
    hr_only: false,
    date,
    today,
    isToday,
    heading: `${weekdayName(date)}, ${formatDate(date)}`,
    workingDay: kind.working,
    nonWorkingReason: kind.working ? null : kind.reason,
    previous: date > EARLIEST ? addDays(date, -1) : date,
    next: isToday ? null : addDays(date, 1),
    tiles: {
      present: count('present'),
      late: count('late'),
      absent: count('absent'),
      onLeave: count('on_leave'),
      noClockOut: rows.filter((r) => r.noClockOut).length,
    },
    rows,
  };
}

/** The screen's model for a viewer: the owners-and-admins notice for anyone else, and nothing is read for them. */
export async function loadTeamAttendance(
  data: PeopleData,
  viewer: PeopleViewer,
  rawDate: string | string[] | undefined,
  today: string,
): Promise<TeamAttendanceModel | { hr_only: true }> {
  if (!isTeamView(viewer)) return { hr_only: true };
  const date = parseDay(rawDate, today);
  const [employees, attendance, leave, holidays, settings] = await Promise.all([
    data.listEmployees(),
    data.listAttendance(date, date),
    data.listLeaveRequests(),
    data.listPublicHolidays(),
    data.getSettings(),
  ]);
  return buildTeamAttendanceModel({
    date,
    today,
    employees,
    attendance,
    leave,
    holidays,
    workWeek: settings.work_week,
  });
}
