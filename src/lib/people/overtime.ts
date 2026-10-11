/**
 * The overtime figures three screens share (the Overtime page, My OT Claims,
 * the approvals queue). Rejected and cancelled records feed nothing.
 */

import { rm } from '@/lib/reach/format';
import { monthStart } from './dates';
import { bucketByMonth, sumBy, type Bucket } from './series';
import type { Employee, OvertimeRecord } from './types';

/**
 * Whether a record's amount is worked out. Records made before the hourly rate
 * was stored have an amount and no rate; only a record with neither has no
 * salary behind it. One rule for every screen, model and tool.
 */
export function overtimeCalculated(r: { hourly_rate_cents: number | null; amount_cents: number }): boolean {
  return !(r.hourly_rate_cents === null && r.amount_cents === 0);
}

/** The amount as shown: Ringgit, or "Not calculated" when no salary was on file. */
export function overtimeAmountText(r: { hourly_rate_cents: number | null; amount_cents: number }): string {
  return overtimeCalculated(r) ? rm(r.amount_cents) : 'Not calculated';
}

export type OvertimeModel = {
  month: { hours: number; amount_cents: number; approved_hours: number; pending_hours: number; pending_count: number };
  /** Hours, last 6 months. */
  by_month: Bucket[];
  by_rate: { rate: number; label: string; hours: number; amount_cents: number }[];
  /** Pending hours. */
  by_department: { department: string; hours: number }[];
  /** Distinct employees this month. */
  people_with_overtime: number;
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const sum = (values: number[]) => round2(values.reduce((total, v) => total + v, 0));

/**
 * `month` is today's calendar month by work_date. Pass `[]` for employees when
 * the records are one person's: by_department is then empty.
 */
export function overtimeModel(records: OvertimeRecord[], employees: Employee[], today: string): OvertimeModel {
  const live = records.filter((r) => r.status === 'approved' || r.status === 'pending');
  const thisMonth = monthStart(today);
  const inMonth = live.filter((r) => monthStart(r.work_date) === thisMonth);
  const approved = inMonth.filter((r) => r.status === 'approved');
  const pending = live.filter((r) => r.status === 'pending');

  const rates = [...new Set(live.map((r) => r.rate_multiplier))].sort((a, b) => a - b);
  const department = new Map(employees.map((e) => [e.id, e.department_name ?? 'Unassigned']));

  return {
    month: {
      hours: sum(inMonth.map((r) => r.hours)),
      amount_cents: inMonth.reduce((total, r) => total + r.amount_cents, 0),
      approved_hours: sum(approved.map((r) => r.hours)),
      pending_hours: sum(pending.map((r) => r.hours)),
      pending_count: pending.length,
    },
    by_month: bucketByMonth(live, (r) => r.work_date, (r) => r.hours, today, 6),
    by_rate: rates.map((rate) => {
      const matching = live.filter((r) => r.rate_multiplier === rate);
      return {
        rate,
        label: `${rate}x`,
        hours: sum(matching.map((r) => r.hours)),
        amount_cents: matching.reduce((total, r) => total + r.amount_cents, 0),
      };
    }),
    by_department: sumBy(pending, (r) => department.get(r.employee_id) ?? null, (r) => r.hours).map(
      ({ key, value }) => ({ department: key, hours: value }),
    ),
    people_with_overtime: new Set(inMonth.map((r) => r.employee_id)).size,
  };
}
