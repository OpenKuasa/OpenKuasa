import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';
import { addDays, todayInMalaysia, weekStart } from '@/lib/people/dates';
import { buildPeopleOverviewModel } from '@/lib/people/overview';
import { createSupabasePeopleData } from '@/lib/people/supabase';
import type { PeopleData } from '@/lib/people/types';

// Reads every HR table through the real provider as an anonymous demo guest, so a wrong
// column or an unresolvable join throws here instead of on the live screen.
const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

let c: SupabaseClient;
let demoId: string;

const AISYAH_ID = 'dea97d89-a5b6-f264-bd42-c6df73f664a7';

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  c = liveClient();
  await signInAnon(c);
  const { data } = await joinDemo(c);
  demoId = data as string;
});
afterAll(async () => { await c?.auth.signOut(); });

async function readAll(data: PeopleData) {
  const today = todayInMalaysia(new Date());
  const from = addDays(today, -55); // the last 56 days, today included
  const monday = weekStart(today);
  const year = Number(today.slice(0, 4));
  const [
    departments, employees, employeePrivate, leave, balances, timeOff, claims, overtime,
    attendance, timesheet, shifts, holidays, runs, payslips, goals, scorecards, reviews,
    trainings, enrolments, announcements, documents, letters, vouchers, settings,
  ] = await Promise.all([
    data.listDepartments(),
    data.listEmployees(),
    data.getEmployeePrivate(AISYAH_ID),
    data.listLeaveRequests(),
    data.listLeaveBalances(year),
    data.listTimeOffRequests(),
    data.listClaims(),
    data.listOvertime(),
    data.listAttendance(from, today),
    data.listTimesheet(from, today),
    data.listShifts(monday, addDays(monday, 6)),
    data.listPublicHolidays(),
    data.listPayrollRuns(),
    data.listPayslips(),
    data.listGoals(),
    data.listScorecards(),
    data.listReviews(),
    data.listTrainings(),
    data.listTrainingEnrolments(),
    data.listAnnouncements(),
    data.listDocuments(),
    data.listLetters(),
    data.listPaymentVouchers(),
    data.getSettings(),
  ]);
  return {
    today, departments, employees, employeePrivate, leave, balances, timeOff, claims, overtime,
    attendance, timesheet, shifts, holidays, runs, payslips, goals, scorecards, reviews,
    trainings, enrolments, announcements, documents, letters, vouchers, settings,
  };
}

testWithSupabase('reads every HR table through the PeopleData provider as a demo guest', async () => {
  const data = createSupabasePeopleData(c, demoId);
  const r = await readAll(data); // none of the 24 methods may throw

  // The demo's promised shape.
  expect(r.employees).toHaveLength(20);
  expect(r.employees.every((e) => e.department_name)).toBe(true);
  expect(r.departments).toHaveLength(5);
  expect(r.leave.filter((l) => l.status === 'approved' && l.start_date <= r.today && l.end_date >= r.today)).toHaveLength(3);
  const pending = <T extends { status: string }>(rows: T[]) => rows.filter((x) => x.status === 'pending').length;
  expect(pending(r.leave)).toBe(3);
  expect(pending(r.claims)).toBe(2);
  expect(pending(r.overtime)).toBe(1);
  expect(pending(r.timeOff)).toBe(0);
  expect(r.runs).toHaveLength(8);
  expect(r.runs.filter((p) => p.status === 'draft')).toHaveLength(1);
  for (const [name, rows] of Object.entries({
    balances: r.balances, attendance: r.attendance, timesheet: r.timesheet, shifts: r.shifts,
    holidays: r.holidays, payslips: r.payslips, goals: r.goals, scorecards: r.scorecards,
    reviews: r.reviews, trainings: r.trainings, enrolments: r.enrolments, announcements: r.announcements,
  })) {
    expect(rows.length, name).toBeGreaterThan(0);
  }

  // The four reads added for the remaining screens, with the demo's counts.
  expect(r.documents).toHaveLength(26);
  expect(r.letters).toHaveLength(5);
  expect(r.vouchers).toHaveLength(6);
  expect(r.settings.notifications).toMatchObject({ leave_requests: true, birthdays: false });
  for (const [name, rows] of Object.entries({ documents: r.documents, letters: r.letters })) {
    expect(rows.filter((x) => x.employee_name === 'Unknown'), name).toHaveLength(0);
  }

  // Joined names resolved.
  for (const [name, rows] of Object.entries({
    leave: r.leave, claims: r.claims, overtime: r.overtime, payslips: r.payslips,
    goals: r.goals, scorecards: r.scorecards, reviews: r.reviews,
  })) {
    expect(rows.filter((x) => x.employee_name === 'Unknown'), name).toHaveLength(0);
  }

  // A demo guest may read the demo workspace's private rows.
  expect(r.employees.find((e) => e.id === AISYAH_ID)?.name).toBe('Aisyah Rahim');
  expect(r.employeePrivate?.base_salary_cents).toBe(560000);

  // The Overview model agrees with the data.
  const model = await buildPeopleOverviewModel(data, new Date());
  expect(model.totals.headcount).toBe(20);
  expect(model.totals.on_leave_today).toBe(3);
  expect(model.totals.pending_approvals).toBe(6);
});
