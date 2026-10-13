/** Pure summaries for the payroll, attendance, timesheet, performance and leave-balance lookups. */

import type {
  AttendanceDay,
  Employee,
  Goal,
  LeaveBalance,
  LeaveType,
  PayrollRun,
  Payslip,
  Review,
  TimesheetEntry,
} from './types';

const UNKNOWN = 'Unknown';
const names = (employees: Employee[]) => new Map(employees.map((e) => [e.id, e.name]));
const twoDecimals = (n: number) => Math.round(n * 100) / 100;
const oneDecimal = (n: number) => Math.round(n * 10) / 10;

export type PayrollRunTotals = {
  period_month: string;
  status: PayrollRun['status'];
  headcount: number;
  gross_cents: number;
  deductions_cents: number;
  net_cents: number;
};

/** Totals for each payroll run this caller can see, newest first. */
export function payrollSummary(runs: PayrollRun[], payslips: Payslip[]): PayrollRunTotals[] {
  return [...runs]
    .sort((a, b) => b.period_month.localeCompare(a.period_month))
    .map((run) => {
      const slips = payslips.filter((p) => p.payroll_run_id === run.id);
      const gross = slips.reduce((sum, p) => sum + p.gross_cents, 0);
      const net = slips.reduce((sum, p) => sum + p.net_cents, 0);
      return {
        period_month: run.period_month,
        status: run.status,
        headcount: slips.length,
        gross_cents: gross,
        deductions_cents: gross - net,
        net_cents: net,
      };
    });
}

export function attendanceCounts(days: AttendanceDay[]) {
  const count = (status: AttendanceDay['status']) => days.filter((d) => d.status === status).length;
  const present = count('present');
  const late = count('late');
  const absent = count('absent');
  const expected = present + late + absent;
  return {
    present,
    late,
    absent,
    on_leave: count('on_leave'),
    /**
     * Share of recorded days that were present or late (on leave not counted). A day with no row is not an absence,
     * so this is a share of recorded days, not of days expected. Null when there were none. Not for today.
     */
    rate_pct: expected === 0 ? null : Math.round(((present + late) / expected) * 100),
  };
}

/** Who was late and how often, most often first. */
export function lateByEmployee(days: AttendanceDay[], employees: Employee[]): { employee: string; late: number }[] {
  const name = names(employees);
  const late = new Map<string, number>();
  for (const day of days) if (day.status === 'late') late.set(day.employee_id, (late.get(day.employee_id) ?? 0) + 1);
  return [...late]
    .map(([id, count]) => ({ employee: name.get(id) ?? UNKNOWN, late: count }))
    .sort((a, b) => b.late - a.late || a.employee.localeCompare(b.employee));
}

/** Hours and billable hours per employee, most hours first. */
export function timesheetByEmployee(
  entries: TimesheetEntry[],
  employees: Employee[],
): { employee: string; hours: number; billable_hours: number }[] {
  const name = names(employees);
  const totals = new Map<string, { hours: number; billable_hours: number }>();
  for (const entry of entries) {
    const row = totals.get(entry.employee_id) ?? { hours: 0, billable_hours: 0 };
    row.hours += entry.hours;
    row.billable_hours += entry.billable_hours;
    totals.set(entry.employee_id, row);
  }
  return [...totals]
    .map(([id, row]) => ({
      employee: name.get(id) ?? UNKNOWN,
      hours: twoDecimals(row.hours),
      billable_hours: twoDecimals(row.billable_hours),
    }))
    .sort((a, b) => b.hours - a.hours || a.employee.localeCompare(b.employee));
}

/**
 * Goals and RELEASED reviews at a glance. A draft review is never counted, whoever asks and whatever rows they
 * hold: the average, the ratings and the top five are over released reviews only.
 */
export function performanceSummary(goals: Goal[], reviews: Review[]) {
  const released = reviews.filter((r) => r.status === 'released' && Number.isFinite(r.score));
  const goalCount = (status: Goal['status']) => goals.filter((g) => g.status === status).length;
  const rated = (rating: Review['rating']) => released.filter((r) => r.rating === rating).length;
  return {
    goals: { total: goals.length, on_track: goalCount('on_track'), at_risk: goalCount('at_risk'), done: goalCount('done') },
    /** Mean review score out of 5. Null when there are no released reviews. */
    average_score:
      released.length === 0 ? null : oneDecimal(released.reduce((sum, r) => sum + r.score, 0) / released.length),
    ratings: { exceeds: rated('exceeds'), meets: rated('meets'), below: rated('below') },
    top: [...released]
      .sort((a, b) => b.score - a.score || a.employee_name.localeCompare(b.employee_name))
      .slice(0, 5)
      .map((r) => ({ employee: r.employee_name, period: r.period, score: r.score })),
  };
}

export type LeaveBalanceRow = {
  employee: string;
  leave_type: LeaveType;
  year: number;
  entitled_days: number;
  used_days: number;
  remaining_days: number;
};

export function leaveBalanceRows(balances: LeaveBalance[], employees: Employee[]): LeaveBalanceRow[] {
  const name = names(employees);
  return balances
    .map((b) => ({
      employee: name.get(b.employee_id) ?? UNKNOWN,
      leave_type: b.leave_type,
      year: b.year,
      entitled_days: b.entitled_days,
      used_days: b.used_days,
      remaining_days: oneDecimal(b.entitled_days - b.used_days),
    }))
    .sort((a, b) => a.employee.localeCompare(b.employee) || a.leave_type.localeCompare(b.leave_type));
}
