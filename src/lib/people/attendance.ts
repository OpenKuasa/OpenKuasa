/**
 * Pure models for the four attendance screens: My Attendance, Timesheet,
 * Shift Calendar and Overtime. The database decides which rows come back;
 * these functions only turn rows into what a screen draws.
 */

import { todayState } from './attendance-forms';
import { addDays, clockTime, formatDate, formatDay, hoursBetween, monthStart, weekStart } from './dates';
import { isTeamView, leaveDaysByTypeInYear, ownRows } from './own';
import { overtimeModel, type OvertimeModel } from './overtime';
import { reportsOf, teamIds } from './reporting';
import { cellKey, mayEditHours, weekNav, type WeekNav } from './roster';
import { percent } from './series';
import { timesheetByEmployee } from './summaries';
import type {
  AttendanceDay,
  AttendanceStatus,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  OvertimeRecord,
  PeopleData,
  PeopleViewer,
  Shift,
  ShiftKind,
  TimesheetEntry,
  Weekday,
} from './types';
import { WEEKDAYS as ALL_WEEKDAYS } from './types';

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const UNKNOWN = 'Unknown';

type Tone = 'good' | 'pending' | 'bad' | 'neutral';

/** The weeks of attendance a screen may reach back (Screen Rule 4). */
export const ATTENDANCE_WEEKS = 8;

/** The first day of the attendance window: the Monday `ATTENDANCE_WEEKS - 1` weeks before this week's. */
export function attendanceWindowStart(today: string): string {
  return addDays(weekStart(today), -(ATTENDANCE_WEEKS - 1) * 7);
}

/** Monday to Sunday of the week `today` is in. */
export function currentWeek(today: string): { start: string; end: string } {
  const start = weekStart(today);
  return { start, end: addDays(start, 6) };
}

const nameMap = (employees: Employee[]) => new Map(employees.map((e) => [e.id, e.name]));

/* ---------------------------------------------------------------- */
/* My Attendance                                                     */
/* ---------------------------------------------------------------- */

export const ATTENDANCE_STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  late: 'Late',
  absent: 'Absent',
  on_leave: 'On leave',
};

const ATTENDANCE_TONE: Record<AttendanceStatus, Tone> = {
  present: 'good',
  late: 'pending',
  absent: 'bad',
  on_leave: 'neutral',
};

export type RecentClockIn = {
  work_date: string;
  /** `07 Oct 2026`. */
  date_label: string;
  clock_in: string | null;
  clock_out: string | null;
  /** Null when either end is missing. */
  hours: number | null;
  status: AttendanceStatus;
  status_label: string;
  tone: Tone;
  is_today: boolean;
  /** An owner or admin set this day by hand. */
  corrected: boolean;
  correction_note: string | null;
  /** A past day with a clock-in and no clock-out. Never today (it may still be open), nor a corrected day (it was set by hand). */
  no_clock_out: boolean;
};

export type MyAttendanceModel = {
  /** False when the account is linked to no employee: show the not-linked card. */
  linked: boolean;
  month: {
    present: number;
    /** Days this month that were present, late or absent (days on leave are not expected attendances). */
    recorded: number;
    late: number;
    /** `HH:MM`, or null when there was no clock-in this month. */
    avg_clock_in: string | null;
  };
  /** Annual leave left this year, or null when there is no annual balance row. */
  annual_left: number | null;
  /** The last 10 recorded days that have a clock-out. */
  hours: { label: string; hours: number }[];
  /** Hours per weekday (Mon to Fri), one row per week, oldest first. */
  pattern: { weeks: string[]; days: string[]; values: number[][] };
  leave_by_type: { key: LeaveType; label: string; days: number }[];
  leave_total: number;
  recent: RecentClockIn[];
};

const minutesOfClock = (instant: string): number | null => {
  const time = clockTime(instant);
  if (time === '—') return null;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
};

const clockLabel = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const workedHours = (d: AttendanceDay): number | null =>
  d.clock_in && d.clock_out ? hoursBetween(d.clock_in, d.clock_out) : null;

export function buildMyAttendance(input: {
  days: AttendanceDay[];
  leave: LeaveRequest[];
  balances: LeaveBalance[];
  viewer: PeopleViewer;
  today: string;
}): MyAttendanceModel {
  const { viewer, today } = input;
  const mine = ownRows(input.days, viewer).sort((a, b) => a.work_date.localeCompare(b.work_date));
  const year = Number(today.slice(0, 4));
  const first = monthStart(today);

  const thisMonth = mine.filter((d) => d.work_date >= first && d.work_date <= today);
  const expected = thisMonth.filter((d) => d.status !== 'on_leave');
  const clockIns = thisMonth
    .map((d) => (d.clock_in ? minutesOfClock(d.clock_in) : null))
    .filter((m): m is number => m !== null);
  const annual = ownRows(input.balances, viewer).find((b) => b.leave_type === 'annual' && b.year === year);

  const lastTen = mine.slice(-10);
  const hours = lastTen.flatMap((d) => {
    const worked = workedHours(d);
    return worked === null ? [] : [{ label: formatDay(d.work_date), hours: worked }];
  });

  const firstMonday = attendanceWindowStart(today);
  const byDate = new Map(mine.map((d) => [d.work_date, d]));
  const starts = Array.from({ length: ATTENDANCE_WEEKS }, (_, i) => addDays(firstMonday, i * 7));
  const values = starts.map((monday) =>
    Array.from({ length: 5 }, (_, i) => {
      const entry = byDate.get(addDays(monday, i));
      return (entry && workedHours(entry)) || 0;
    }),
  );

  const leaveByType = leaveDaysByTypeInYear(ownRows(input.leave, viewer), year).map((row) => ({
    key: row.leave_type,
    label: row.label,
    days: row.days,
  }));

  const recent = [...mine]
    .reverse()
    .slice(0, 10)
    .map((d) => ({
      work_date: d.work_date,
      date_label: formatDate(d.work_date),
      clock_in: d.clock_in ? clockTime(d.clock_in) : null,
      clock_out: d.clock_out ? clockTime(d.clock_out) : null,
      hours: workedHours(d),
      status: d.status,
      status_label: ATTENDANCE_STATUS_LABEL[d.status],
      tone: ATTENDANCE_TONE[d.status],
      is_today: d.work_date === today,
      corrected: d.corrected,
      correction_note: d.correction_note,
      no_clock_out: !d.corrected && d.clock_in !== null && d.clock_out === null && d.work_date < today,
    }));

  return {
    linked: viewer.employeeId !== null,
    month: {
      present: thisMonth.filter((d) => d.status === 'present' || d.status === 'late').length,
      recorded: expected.length,
      late: thisMonth.filter((d) => d.status === 'late').length,
      avg_clock_in:
        clockIns.length === 0
          ? null
          : clockLabel(Math.round(clockIns.reduce((sum, m) => sum + m, 0) / clockIns.length)),
    },
    annual_left: annual ? round1(annual.entitled_days - annual.used_days) : null,
    hours,
    pattern: {
      weeks: starts.map(formatDay),
      days: WEEKDAYS.slice(0, 5),
      values,
    },
    leave_by_type: leaveByType,
    leave_total: round1(leaveByType.reduce((sum, row) => sum + row.days, 0)),
    recent,
  };
}

/**
 * What to tell the employee after a clock-in or clock-out succeeded, from the row the database returned.
 * The status is the database's ("present" is on time); the times are worded in Malaysia time by `todayState`.
 */
export function clockResultMessage(
  action: 'in' | 'out',
  row: Pick<AttendanceDay, 'work_date' | 'clock_in' | 'clock_out' | 'status'>,
): string {
  const state = todayState({
    today: row.work_date,
    day: { id: '', employee_id: '', corrected: false, correction_note: null, ...row },
    workWeek: [...ALL_WEEKDAYS],
    holidays: [],
    leave: [],
    employeeId: 'self',
  });
  if (action === 'in') {
    if (state.kind !== 'in' && state.kind !== 'done') return 'Clocked in.';
    const since = state.kind === 'in' ? state.since : state.from;
    const how = row.status === 'present' ? ', on time' : row.status === 'late' ? ', late' : '';
    return `Clocked in at ${since}${how}.`;
  }
  if (state.kind !== 'done') return 'Clocked out.';
  return `Clocked out at ${state.to}. You worked ${state.worked}.`;
}

/** The work week for the Today card. When the week is unknown every day counts: a guess would be wrong, and the database's own sentence explains a refusal. */
export function workWeekFor(settings: { work_week: Weekday[] } | null): Weekday[] {
  return settings ? settings.work_week : [...ALL_WEEKDAYS];
}

/**
 * The work week as the caller may know it: from the settings when they can read them (HR, the sample company),
 * otherwise from `readWorkWeek` (the members' read). Null when it stays unknown: no read, no answer, or a failed
 * read, which is logged and never thrown, so the caller carries on as if every day were a working day.
 */
export async function knownWorkWeek(
  data: Pick<PeopleData, 'getSettings'>,
  readsSettings: boolean,
  readWorkWeek?: () => Promise<Weekday[] | null>,
): Promise<Weekday[] | null> {
  if (readsSettings) return (await data.getSettings()).work_week;
  if (!readWorkWeek) return null;
  try {
    return await readWorkWeek();
  } catch (error) {
    console.error('[people/attendance] work week:', error instanceof Error ? error.name : 'error');
    return null;
  }
}

/** The viewer's own attendance row for today, if there is one. */
export function ownDayToday(days: AttendanceDay[], viewer: PeopleViewer, today: string): AttendanceDay | null {
  if (viewer.employeeId === null) return null;
  return days.find((d) => d.employee_id === viewer.employeeId && d.work_date === today) ?? null;
}

/** The clock button's words; `pending` is a call in flight. */
export function clockButtonLabel(action: 'in' | 'out', pending: boolean): string {
  if (pending) return action === 'in' ? 'Clocking in…' : 'Clocking out…';
  return action === 'in' ? 'Clock in' : 'Clock out';
}

/* ---------------------------------------------------------------- */
/* Whose rows a week screen shows                                    */
/* ---------------------------------------------------------------- */

/** Who is looking at a week screen. The demo first: there everything is drawn and nothing is editable. */
export type WeekView = 'hr' | 'manager' | 'self' | 'demo';

export function weekView(viewer: PeopleViewer): WeekView {
  if (viewer.isDemo) return 'demo';
  if (viewer.isHr) return 'hr';
  return viewer.managesTeam === true ? 'manager' : 'self';
}

/**
 * The employees whose rows the viewer may see, or null for everyone (HR, the demo). A manager sees their own and
 * their direct reports'; anyone else their own. The database already returns no more than that; this keeps a
 * report's rows out of a member's screen even if the team lookup failed.
 */
function visibleIds(viewer: PeopleViewer, employees: Employee[]): Set<string> | null {
  const view = weekView(viewer);
  if (view === 'hr' || view === 'demo') return null;
  const ids = new Set<string>();
  if (viewer.employeeId) ids.add(viewer.employeeId);
  if (view === 'manager') for (const id of teamIds(employees, viewer)) ids.add(id);
  return ids;
}

/** The viewer's own row first, then by name. */
const byOwnThenName = (ownId: string | null) => (a: { employee_id: string; name: string }, b: { employee_id: string; name: string }) =>
  Number(b.employee_id === ownId) - Number(a.employee_id === ownId) || a.name.localeCompare(b.name);

/* ---------------------------------------------------------------- */
/* Timesheet                                                       */
/* ---------------------------------------------------------------- */

export type TimesheetRow = {
  employee_id: string;
  name: string;
  /** Hours for Monday to Sunday; null where nothing was logged. */
  per_day: (number | null)[];
  /** Billable hours for Monday to Sunday; null where nothing was logged. */
  billable_per_day: (number | null)[];
  billable: number;
  total: number;
  /** The viewer's own record. */
  own: boolean;
  /** Per day: whether the viewer may type hours there. The database decides again on save. */
  editable: boolean[];
};

export type TimesheetModel = {
  /** True for HR and the demo; false means the rows are the viewer's own (and a manager's reports') and not the whole team's. */
  team: boolean;
  view: WeekView;
  week_start: string;
  week_end: string;
  nav: WeekNav;
  days: { date: string; label: string }[];
  rows: TimesheetRow[];
  /** At least one cell takes input. */
  editable: boolean;
  totals: { hours: number; billable_hours: number; billable_share: number | null; members: number };
  by_employee: { employee: string; hours: number; billable_hours: number }[];
};

const weekDays = (start: string) =>
  WEEKDAYS.map((label, i) => ({ date: addDays(start, i), label }));

export function buildTimesheet(input: {
  entries: TimesheetEntry[];
  employees: Employee[];
  viewer: PeopleViewer;
  today: string;
  /** The Monday to show; this week when left out. */
  week?: string;
}): TimesheetModel {
  const { viewer, today } = input;
  const start = input.week ?? currentWeek(today).start;
  const end = addDays(start, 6);
  const days = weekDays(start);
  const view = weekView(viewer);
  const names = nameMap(input.employees);
  const visible = visibleIds(viewer, input.employees);
  const entries = input.entries.filter(
    (e) => e.work_date >= start && e.work_date <= end && (visible === null || visible.has(e.employee_id)),
  );

  const blank = (employeeId: string): TimesheetRow => {
    const own = employeeId === viewer.employeeId;
    return {
      employee_id: employeeId,
      name: names.get(employeeId) ?? UNKNOWN,
      per_day: Array(7).fill(null),
      billable_per_day: Array(7).fill(null),
      billable: 0,
      total: 0,
      own,
      editable: days.map((d) => mayEditHours({ date: d.date, today, isHr: viewer.isHr, isDemo: viewer.isDemo, own })),
    };
  };
  const byPerson = new Map<string, TimesheetRow>();
  const rowFor = (employeeId: string) => {
    const row = byPerson.get(employeeId) ?? blank(employeeId);
    byPerson.set(employeeId, row);
    return row;
  };
  // Rows with nothing logged yet: every active employee for HR to fill in; the viewer's own row, and a manager's
  // active reports, for everyone else outside the demo.
  if (view === 'hr') for (const e of input.employees) if (e.status === 'active') rowFor(e.id);
  if (view === 'self' || view === 'manager') {
    if (viewer.employeeId) rowFor(viewer.employeeId);
    if (view === 'manager') for (const e of reportsOf(input.employees, viewer.employeeId)) if (e.status === 'active') rowFor(e.id);
  }
  for (const entry of entries) {
    const row = rowFor(entry.employee_id);
    const index = days.findIndex((d) => d.date === entry.work_date);
    row.per_day[index] = round2((row.per_day[index] ?? 0) + entry.hours);
    row.billable_per_day[index] = round2((row.billable_per_day[index] ?? 0) + entry.billable_hours);
    row.billable = round2(row.billable + entry.billable_hours);
    row.total = round2(row.total + entry.hours);
  }
  const rows = [...byPerson.values()].sort(byOwnThenName(view === 'hr' || view === 'demo' ? null : viewer.employeeId));
  const hours = round2(rows.reduce((sum, r) => sum + r.total, 0));
  const billable = round2(rows.reduce((sum, r) => sum + r.billable, 0));
  const logged = new Set(entries.map((e) => e.employee_id));

  return {
    team: isTeamView(viewer),
    view,
    week_start: start,
    week_end: end,
    nav: weekNav(start, today),
    days,
    rows,
    editable: rows.some((r) => r.editable.some(Boolean)),
    totals: { hours, billable_hours: billable, billable_share: percent(billable, hours), members: logged.size },
    by_employee: timesheetByEmployee(entries, input.employees),
  };
}

/* ---------------------------------------------------------------- */
/* Shift Calendar                                                    */
/* ---------------------------------------------------------------- */

export const SHIFT_LABEL: Record<ShiftKind, string> = { morning: 'Morning', night: 'Night', off: 'Off' };

export type ShiftRow = {
  employee_id: string;
  name: string;
  department: string | null;
  cells: (ShiftKind | null)[];
  /** HR may change this row: an active employee, outside the demo. */
  editable: boolean;
};

export type ShiftCalendarModel = {
  team: boolean;
  view: WeekView;
  week_start: string;
  week_end: string;
  nav: WeekNav;
  days: { date: string; label: string }[];
  /** People with at least one shift this week; for HR also every active employee, to fill in. */
  rows: ShiftRow[];
  /** HR outside the demo: the grid takes edits. */
  editable: boolean;
  /** Last week's shifts by cell key (`employee|date`), for "Copy last week". Empty unless editable. */
  previous: Record<string, ShiftKind>;
  morning_count: number;
  night_count: number;
};

export function buildShiftCalendar(input: {
  shifts: Shift[];
  employees: Employee[];
  viewer: PeopleViewer;
  today: string;
  /** The Monday to show; this week when left out. */
  week?: string;
}): ShiftCalendarModel {
  const { viewer, today } = input;
  const start = input.week ?? currentWeek(today).start;
  const end = addDays(start, 6);
  const days = weekDays(start);
  const view = weekView(viewer);
  const editable = view === 'hr';
  const people = new Map(input.employees.map((e) => [e.id, e]));
  const visible = visibleIds(viewer, input.employees);
  const seen = input.shifts.filter((s) => visible === null || visible.has(s.employee_id));
  const shifts = seen.filter((s) => s.work_date >= start && s.work_date <= end);

  const byPerson = new Map<string, ShiftRow>();
  const rowFor = (employeeId: string) => {
    const person = people.get(employeeId);
    const row = byPerson.get(employeeId) ?? {
      employee_id: employeeId,
      name: person?.name ?? UNKNOWN,
      department: person?.department_name ?? null,
      cells: Array(7).fill(null),
      editable: editable && person?.status === 'active',
    };
    byPerson.set(employeeId, row);
    return row;
  };
  if (editable) for (const e of input.employees) if (e.status === 'active') rowFor(e.id);
  for (const shift of shifts) {
    const index = days.findIndex((d) => d.date === shift.work_date);
    rowFor(shift.employee_id).cells[index] = shift.shift;
  }

  const previous: Record<string, ShiftKind> = {};
  if (editable) {
    const from = addDays(start, -7);
    for (const s of seen) if (s.work_date >= from && s.work_date < start) previous[cellKey(s.employee_id, s.work_date)] = s.shift;
  }

  return {
    team: isTeamView(viewer),
    view,
    week_start: start,
    week_end: end,
    nav: weekNav(start, today),
    days,
    rows: [...byPerson.values()].sort(byOwnThenName(view === 'manager' ? viewer.employeeId : null)),
    editable,
    previous,
    morning_count: shifts.filter((s) => s.shift === 'morning').length,
    night_count: shifts.filter((s) => s.shift === 'night').length,
  };
}

/* ---------------------------------------------------------------- */
/* Overtime                                                          */
/* ---------------------------------------------------------------- */

/** How many records the table shows. */
export const OVERTIME_TABLE_LIMIT = 25;

export type OvertimeView = {
  team: boolean;
  model: OvertimeModel;
  /** Newest work date first, at most {@link OVERTIME_TABLE_LIMIT}. */
  records: OvertimeRecord[];
  /** More records exist than the table shows. */
  truncated: boolean;
};

export function buildOvertimeView(input: {
  records: OvertimeRecord[];
  employees: Employee[];
  viewer: PeopleViewer;
  today: string;
}): OvertimeView {
  const team = isTeamView(input.viewer);
  // The database hands a manager their reports' rows too: a viewer who is not a team viewer sees their own only.
  const records = team ? input.records : ownRows(input.records, input.viewer);
  const sorted = [...records].sort(
    (a, b) => b.work_date.localeCompare(a.work_date) || b.created_at.localeCompare(a.created_at),
  );
  return {
    team,
    // A member's records are their own: no department split.
    model: overtimeModel(records, team ? input.employees : [], input.today),
    records: sorted.slice(0, OVERTIME_TABLE_LIMIT),
    truncated: sorted.length > OVERTIME_TABLE_LIMIT,
  };
}
