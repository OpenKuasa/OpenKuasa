/**
 * Pure helpers behind the Lekiu Overview and the lookups that answer the same
 * questions. Nothing here reads the clock or the database: callers pass rows
 * and a date, so the chat and the screen cannot disagree.
 */

import { rm } from '@/lib/reach/format';
import { isTeamView, ownRows } from './own';
import { attendanceCounts } from './summaries';
import { addDays, addMonths, daysBetween, formatDay, monthLabel, monthStart, todayInMalaysia } from './dates';
import type {
  AttendanceDay,
  Claim,
  ClaimCategory,
  Employee,
  LeaveRequest,
  LeaveType,
  OvertimeRecord,
  PeopleData,
  PeopleViewer,
  TimeOffRequest,
} from './types';

const LEAVE_LABEL: Record<LeaveType, string> = {
  annual: 'Annual leave',
  medical: 'Medical leave',
  emergency: 'Emergency leave',
  unpaid: 'Unpaid leave',
  maternity: 'Maternity leave',
  paternity: 'Paternity leave',
};
const CLAIM_LABEL: Record<ClaimCategory, string> = {
  medical: 'Medical claim',
  travel: 'Travel claim',
  meals: 'Meals claim',
  equipment: 'Equipment claim',
  other: 'Other claim',
};

export const leaveLabel = (type: LeaveType): string => LEAVE_LABEL[type];
export const claimLabel = (category: ClaimCategory): string => CLAIM_LABEL[category];

const dayRange = (from: string, to: string) => (from === to ? formatDay(from) : `${formatDay(from)}–${formatDay(to)}`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Active staff per department, biggest first, then by name. */
export function headcountByDepartment(employees: Employee[]): { department: string; headcount: number }[] {
  const counts = new Map<string, number>();
  for (const employee of employees) {
    if (employee.status !== 'active') continue;
    const department = employee.department_name ?? 'Unassigned';
    counts.set(department, (counts.get(department) ?? 0) + 1);
  }
  return [...counts]
    .map(([department, headcount]) => ({ department, headcount }))
    .sort((a, b) => b.headcount - a.headcount || a.department.localeCompare(b.department));
}

/** Approved leave that covers `date`, by name. */
export function onLeaveOn(leave: LeaveRequest[], date: string): LeaveRequest[] {
  return leave
    .filter((r) => r.status === 'approved' && r.start_date <= date && r.end_date >= date)
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

export type ApprovalKind = 'leave' | 'claim' | 'overtime' | 'time_off';
export type ApprovalRow = {
  id: string;
  kind: ApprovalKind;
  employee: string;
  /** What is being asked for, such as "Annual leave" or "Travel claim". */
  type: string;
  detail: string;
  requested_at: string;
};

/** Everything still waiting for a decision, newest request first. */
export function pendingApprovals(
  leave: LeaveRequest[],
  claims: Claim[],
  overtime: Pick<OvertimeRecord, 'id' | 'status' | 'employee_name' | 'hours' | 'work_date' | 'created_at'>[],
  timeOff: TimeOffRequest[],
): ApprovalRow[] {
  const waiting = <T extends { status: string }>(rows: T[]) => rows.filter((r) => r.status === 'pending');
  return [
    ...waiting(leave).map((r): ApprovalRow => ({
      id: r.id,
      kind: 'leave',
      employee: r.employee_name,
      type: leaveLabel(r.leave_type),
      detail: `${plural(r.days, 'day', 'days')} · ${dayRange(r.start_date, r.end_date)}`,
      requested_at: r.created_at,
    })),
    ...waiting(claims).map((r): ApprovalRow => ({
      id: r.id,
      kind: 'claim',
      employee: r.employee_name,
      type: claimLabel(r.category),
      detail: r.description ? `${rm(r.amount_cents)} · ${r.description}` : rm(r.amount_cents),
      requested_at: r.created_at,
    })),
    ...waiting(overtime).map((r): ApprovalRow => ({
      id: r.id,
      kind: 'overtime',
      employee: r.employee_name,
      type: 'Overtime',
      detail: `${plural(r.hours, 'hr', 'hrs')} · ${formatDay(r.work_date)}`,
      requested_at: r.created_at,
    })),
    ...waiting(timeOff).map((r): ApprovalRow => ({
      id: r.id,
      kind: 'time_off',
      employee: r.employee_name,
      type: 'Time-off',
      detail: `${formatDay(r.off_date)} · ${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`,
      requested_at: r.created_at,
    })),
  ].sort((a, b) => b.requested_at.localeCompare(a.requested_at));
}

export function approvalCounts(rows: ApprovalRow[]) {
  const of = (kind: ApprovalKind) => rows.filter((r) => r.kind === kind).length;
  return { leave: of('leave'), claims: of('claim'), overtime: of('overtime'), time_off: of('time_off'), total: rows.length };
}

/**
 * The words on the approvals card. Someone who is not HR is shown only their
 * own requests by the database, so the card must not call them "awaiting your
 * action".
 */
export function approvalsHeading(isHr: boolean): { title: string; subtitle: string; empty: string } {
  return isHr
    ? { title: 'Pending approvals', subtitle: 'Awaiting your action', empty: 'Nothing is waiting for approval' }
    : { title: 'Your requests', subtitle: 'Waiting for approval', empty: 'You have no requests waiting' };
}

/**
 * Approved leave days that fall in the month beginning `monthStartDate`, split by
 * calendar days when a request crosses a month end. Most days first.
 */
export function leaveDaysByType(leave: LeaveRequest[], monthStartDate: string): { label: string; days: number }[] {
  const next = addMonths(monthStartDate, 1);
  const days = new Map<LeaveType, number>();
  for (const r of leave) {
    if (r.status !== 'approved') continue;
    const from = r.start_date > monthStartDate ? r.start_date : monthStartDate;
    const lastDay = addDays(next, -1);
    const to = r.end_date < lastDay ? r.end_date : lastDay;
    if (from > to) continue;
    const total = daysBetween(r.start_date, r.end_date) + 1;
    const inside = daysBetween(from, to) + 1;
    days.set(r.leave_type, (days.get(r.leave_type) ?? 0) + (r.days * inside) / total);
  }
  return [...days]
    .map(([type, total]) => ({ label: leaveLabel(type), days: Math.round(total * 10) / 10 }))
    .sort((a, b) => b.days - a.days || a.label.localeCompare(b.label));
}

/**
 * Today's active staff counted by when they joined, at the end of each of the
 * last `months` months (today, for the current one). It is not a record of past
 * headcount: the tables hold no leaving date, so anyone who has left is missing
 * from every month.
 */
export function headcountTrend(employees: Employee[], today: string, months = 8): { label: string; headcount: number }[] {
  const first = monthStart(today);
  const active = employees.filter((e) => e.status === 'active');
  return Array.from({ length: months }, (_, i) => {
    const month = addMonths(first, i - (months - 1));
    const end = i === months - 1 ? today : addDays(addMonths(month, 1), -1);
    return {
      label: monthLabel(month),
      headcount: active.filter((e) => e.join_date === null || e.join_date <= end).length,
    };
  });
}

const two = (n: number) => String(n).padStart(2, '0');

/** The next time this month and day comes round, on or after `today`. 29 February falls back to the 28th. */
function nextOn(month: number, day: number, today: string): string {
  const year = Number(today.slice(0, 4));
  const at = (y: number) => {
    const last = new Date(Date.UTC(y, month, 0)).getUTCDate();
    return `${y}-${two(month)}-${two(Math.min(day, last))}`;
  };
  const thisYear = at(year);
  return thisYear >= today ? thisYear : at(year + 1);
}

export type Occasion = { name: string; occasion: string; when: string; kind: 'birthday' | 'anniversary' };

/** Birthdays and work anniversaries of active staff in the next `withinDays` days, soonest first. */
export function upcomingOccasions(employees: Employee[], today: string, withinDays = 30): Occasion[] {
  const found: (Occasion & { date: string })[] = [];
  for (const employee of employees) {
    if (employee.status !== 'active') continue;
    if (employee.date_of_birth_month !== null && employee.date_of_birth_day !== null) {
      const date = nextOn(employee.date_of_birth_month, employee.date_of_birth_day, today);
      found.push({ name: employee.name, occasion: 'Birthday', when: formatDay(date), kind: 'birthday', date });
    }
    if (employee.join_date) {
      const date = nextOn(Number(employee.join_date.slice(5, 7)), Number(employee.join_date.slice(8, 10)), today);
      const years = Number(date.slice(0, 4)) - Number(employee.join_date.slice(0, 4));
      if (years >= 1) {
        found.push({
          name: employee.name,
          occasion: `${years}-year anniversary`,
          when: formatDay(date),
          kind: 'anniversary',
          date,
        });
      }
    }
  }
  return found
    .filter((o) => daysBetween(today, o.date) <= withinDays)
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
    .map(({ name, occasion, when, kind }): Occasion => ({ name, occasion, when, kind }));
}

export type AttendanceCounts = {
  /** On time. */
  present: number;
  late: number;
  absent: number;
  on_leave: number;
  /**
   * Present or late with a clock-in. There is no rate for a day that is still going: the nightly job does not close
   * today, so the rows of today are only the people who have clocked in, and a share of those would read 100%.
   */
  clocked_in: number;
};

export function attendanceOn(days: AttendanceDay[], date: string): AttendanceCounts {
  const counts = attendanceCounts(days.filter((d) => d.work_date === date));
  return {
    present: counts.present,
    late: counts.late,
    absent: counts.absent,
    on_leave: counts.on_leave,
    clocked_in: days.filter((d) => d.work_date === date && (d.status === 'present' || d.status === 'late') && d.clock_in !== null).length,
  };
}

export type PeopleOverviewModel = {
  today: string;
  totals: {
    headcount: number;
    departments: number;
    /** Present or late with a clock-in today. Never a rate: see {@link AttendanceCounts}. */
    clocked_in_so_far: number;
    on_leave_today: number;
    pending_approvals: number;
  };
  trend: { label: string; headcount: number }[];
  departments: { department: string; headcount: number }[];
  leaveByType: { label: string; days: number }[];
  onLeave: { name: string; kind: string; when: string }[];
  approvals: ApprovalRow[];
  occasions: Occasion[];
};

/**
 * `ctx` is given by `loadPeople`. With it, a viewer who is not a team viewer (a manager) sees their own rows only:
 * the database also hands a manager their reports', and the Overview is not a team screen. Without it, or for a
 * team viewer, every row the data holds is used.
 */
export async function buildPeopleOverviewModel(
  data: PeopleData,
  now: Date,
  ctx?: { viewer: PeopleViewer },
): Promise<PeopleOverviewModel> {
  const today = todayInMalaysia(now);
  const [employees, allLeave, allClaims, allOvertime, allTimeOff, allAttendance] = await Promise.all([
    data.listEmployees(),
    data.listLeaveRequests(),
    data.listClaims(),
    data.listOvertime(),
    data.listTimeOffRequests(),
    data.listAttendance(today, today),
  ]);
  const narrow = ctx !== undefined && !isTeamView(ctx.viewer);
  const mine = <T extends { employee_id: string }>(rows: T[]): T[] => (narrow ? ownRows(rows, ctx.viewer) : rows);
  const leave = mine(allLeave);
  const claims = mine(allClaims);
  const overtime = mine(allOvertime);
  const timeOff = mine(allTimeOff);
  const attendance = mine(allAttendance);
  const departments = headcountByDepartment(employees);
  const away = onLeaveOn(leave, today);
  const approvals = pendingApprovals(leave, claims, overtime, timeOff);
  const counts = attendanceOn(attendance, today);
  return {
    today,
    totals: {
      headcount: employees.filter((e) => e.status === 'active').length,
      departments: departments.length,
      clocked_in_so_far: counts.clocked_in,
      on_leave_today: away.length,
      pending_approvals: approvals.length,
    },
    trend: headcountTrend(employees, today),
    departments,
    leaveByType: leaveDaysByType(leave, monthStart(today)),
    onLeave: away.map((r) => ({
      name: r.employee_name,
      kind: leaveLabel(r.leave_type),
      when: dayRange(r.start_date, r.end_date),
    })),
    approvals,
    occasions: upcomingOccasions(employees, today),
  };
}
