import { describe, expect, it } from 'vitest';
import { addDays, monthStart, todayInMalaysia } from '@/lib/people/dates';
import {
  approvalCounts,
  approvalsHeading,
  attendanceOn,
  buildPeopleOverviewModel,
  headcountByDepartment,
  headcountTrend,
  leaveDaysByType,
  leaveLabel,
  onLeaveOn,
  pendingApprovals,
  upcomingOccasions,
} from '@/lib/people/overview';
import {
  attendanceCounts,
  lateByEmployee,
  leaveBalanceRows,
  payrollSummary,
  performanceSummary,
  timesheetByEmployee,
} from '@/lib/people/summaries';
import { createSeedPeopleData } from '@/lib/people/seed';
import {
  DEFAULT_PEOPLE_SETTINGS,
  type Employee,
  type LeaveRequest,
  type PeopleData,
  type Review,
  type TimesheetEntry,
} from '@/lib/people/types';

// A Friday, so there is attendance for "today".
const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = todayInMalaysia(NOW);
const data = createSeedPeopleData(NOW);

const EMPTY: PeopleData = {
  listDepartments: async () => [], listEmployees: async () => [], getEmployeePrivate: async () => null,
  listLeaveRequests: async () => [], listLeaveBalances: async () => [], listTimeOffRequests: async () => [],
  listClaims: async () => [], listOvertime: async () => [], listAttendance: async () => [],
  listTimesheet: async () => [], listShifts: async () => [], listPublicHolidays: async () => [],
  listPayrollRuns: async () => [], listPayslips: async () => [], listGoals: async () => [],
  listReviews: async () => [], listTrainings: async () => [],
  listTrainingEnrolments: async () => [], listAnnouncements: async () => [],
  listDocuments: async () => [], listLetters: async () => [], listLetterTemplates: async () => [], listPaymentVouchers: async () => [],
  getSettings: async () => structuredClone(DEFAULT_PEOPLE_SETTINGS),
};

describe('overview helpers', () => {
  it('counts active staff by department, biggest first, ties by name', async () => {
    expect(headcountByDepartment(await data.listEmployees())).toEqual([
      { department: 'Sales', headcount: 6 },
      { department: 'Operations', headcount: 5 },
      { department: 'Finance', headcount: 3 },
      { department: 'Management', headcount: 3 },
      { department: 'Marketing', headcount: 3 },
    ]);
  });

  it('leaves inactive staff out and names the department-less', () => {
    const base = { status: 'active', department_name: 'Sales' } as Employee;
    expect(
      headcountByDepartment([base, { ...base, status: 'inactive' }, { ...base, department_name: null }]),
    ).toEqual([{ department: 'Sales', headcount: 1 }, { department: 'Unassigned', headcount: 1 }]);
  });

  it('finds who is on approved leave on a day, including both ends', async () => {
    const leave = await data.listLeaveRequests();
    expect(onLeaveOn(leave, TODAY).map((r) => r.employee_name).sort()).toEqual(['Lim Wei Jie', 'Nurul Huda', 'Siti Lestari']);
    // Siti Lestari is away from two days before the seed's today to one day after.
    expect(onLeaveOn(leave, addDays(TODAY, 2)).map((r) => r.employee_name)).toEqual([]);
    expect(onLeaveOn(leave, addDays(TODAY, -2)).map((r) => r.employee_name)).toEqual(['Siti Lestari']);
  });

  it('lists what is waiting for approval across the four queues', async () => {
    const rows = pendingApprovals(
      await data.listLeaveRequests(), await data.listClaims(), await data.listOvertime(), await data.listTimeOffRequests(),
    );
    expect(approvalCounts(rows)).toEqual({ leave: 3, claims: 2, overtime: 1, time_off: 0, total: 6 });
    expect(rows.find((r) => r.employee === 'Faiz Hakim')).toMatchObject({
      kind: 'claim', type: 'Medical claim', detail: 'RM 240.00 · Clinic consultation',
    });
    expect(rows.find((r) => r.employee === 'Aisyah Rahim')).toMatchObject({
      kind: 'leave', type: 'Annual leave', detail: '2 days · 19 Oct–20 Oct',
    });
    expect(rows.find((r) => r.employee === 'Ahmad Zaki')).toMatchObject({
      kind: 'overtime', type: 'Overtime', detail: '4 hrs · 07 Oct',
    });
    expect(rows.find((r) => r.employee === 'Amirul Danial')?.detail).toBe('1 day · 14 Oct');
  });

  it('words the approvals card for HR and for everyone else', () => {
    expect(approvalsHeading(true)).toEqual({
      title: 'Pending approvals', subtitle: 'Awaiting your action', empty: 'Nothing is waiting for approval',
    });
    expect(approvalsHeading(false)).toEqual({
      title: 'Your requests', subtitle: 'Waiting for approval', empty: 'You have no requests waiting',
    });
  });

  it('adds up approved leave days taken in a month by type', async () => {
    expect(leaveDaysByType(await data.listLeaveRequests(), monthStart(TODAY))).toEqual([
      { label: 'Annual leave', days: 4 },
      { label: 'Emergency leave', days: 2 },
      { label: 'Medical leave', days: 1 },
    ]);
    expect(leaveLabel('unpaid')).toBe('Unpaid leave');
  });

  it('splits leave days across months by calendar days', () => {
    const req = (start: string, end: string, days: number, status: LeaveRequest['status'] = 'approved'): LeaveRequest =>
      ({ leave_type: 'annual', start_date: start, end_date: end, days, status }) as LeaveRequest;
    const across = [req('2026-10-29', '2026-11-03', 6)];
    expect(leaveDaysByType(across, '2026-10-01')).toEqual([{ label: 'Annual leave', days: 3 }]);
    expect(leaveDaysByType(across, '2026-11-01')).toEqual([{ label: 'Annual leave', days: 3 }]);
    const newYear = [req('2026-12-30', '2027-01-02', 4)];
    expect(leaveDaysByType(newYear, '2026-12-01')).toEqual([{ label: 'Annual leave', days: 2 }]);
    expect(leaveDaysByType(newYear, '2027-01-01')).toEqual([{ label: 'Annual leave', days: 2 }]);
    expect(leaveDaysByType([req('2026-10-05', '2026-10-05', 0.5)], '2026-10-01')).toEqual([
      { label: 'Annual leave', days: 0.5 },
    ]);
    expect(leaveDaysByType([req('2026-10-05', '2026-10-06', 2, 'pending'), req('2026-10-05', '2026-10-06', 2, 'rejected')], '2026-10-01')).toEqual([]);
    expect(leaveDaysByType(across, '2026-09-01')).toEqual([]);
    expect(leaveDaysByType(across, '2026-12-01')).toEqual([]);
  });

  it('gives headcount for each of the last eight months from join dates', async () => {
    const trend = headcountTrend(await data.listEmployees(), TODAY);
    expect(trend.map((t) => t.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(trend.at(-1)!.headcount).toBe(20);
    // Daniel Wong joined 210 days ago, in March.
    expect(trend[0].headcount).toBe(20);
    expect(headcountTrend(await data.listEmployees(), TODAY, 10)[0]).toEqual({ label: 'Jan', headcount: 19 });
  });

  it('lists birthdays and work anniversaries in the next 30 days, soonest first', async () => {
    expect(upcomingOccasions(await data.listEmployees(), TODAY)).toEqual([
      { name: 'Nurul Huda', occasion: 'Birthday', when: '18 Oct', kind: 'birthday' },
      { name: 'Amirul Danial', occasion: '2-year anniversary', when: '19 Oct', kind: 'anniversary' },
      { name: 'Ahmad Zaki', occasion: '3-year anniversary', when: '24 Oct', kind: 'anniversary' },
      { name: 'Aisyah Rahim', occasion: 'Birthday', when: '28 Oct', kind: 'birthday' },
      { name: 'Kavitha Nair', occasion: 'Birthday', when: '07 Nov', kind: 'birthday' },
    ]);
  });

  it('handles a 29 February birthday in a year without one', () => {
    const leap = { name: 'Leap', status: 'active', date_of_birth_day: 29, date_of_birth_month: 2, join_date: null } as Employee;
    expect(upcomingOccasions([leap], '2027-02-20')).toEqual([
      { name: 'Leap', occasion: 'Birthday', when: '28 Feb', kind: 'birthday' },
    ]);
  });

  it('counts attendance on a day and the share at work', async () => {
    const days = await data.listAttendance(TODAY, TODAY);
    expect(attendanceOn(days, TODAY)).toEqual({ present: 16, late: 1, absent: 0, on_leave: 3, clocked_in: 17 });
    // Clocked in means present or late with a clock-in; a row of today without one is not counted.
    const row = (status: 'present' | 'late' | 'absent', clock_in: string | null) => ({ ...days[0], work_date: TODAY, status, clock_in });
    expect(attendanceOn([row('present', '2026-10-09T01:00:00Z'), row('late', '2026-10-09T02:00:00Z'), row('absent', null), row('present', null)], TODAY).clocked_in).toBe(2);
    expect(attendanceOn([], TODAY)).toEqual({ present: 0, late: 0, absent: 0, on_leave: 0, clocked_in: 0 });
  });

  it('builds the Overview from the same helpers', async () => {
    const model = await buildPeopleOverviewModel(data, NOW);
    expect(model.today).toBe(TODAY);
    expect(model.totals).toEqual({
      headcount: 20, departments: 5, clocked_in_so_far: 17, on_leave_today: 3, pending_approvals: 6,
    });
    expect(model.onLeave).toEqual([
      { name: 'Lim Wei Jie', kind: 'Medical leave', when: '09 Oct' },
      { name: 'Nurul Huda', kind: 'Emergency leave', when: '09 Oct' },
      { name: 'Siti Lestari', kind: 'Annual leave', when: '07 Oct–10 Oct' },
    ]);
    expect(model.approvals).toHaveLength(6);
    expect(model.departments).toHaveLength(5);
    expect(model.trend).toHaveLength(8);
    expect(model.occasions).toHaveLength(5);
  });

  it('builds an empty Overview without NaN', async () => {
    const model = await buildPeopleOverviewModel(EMPTY, NOW);
    expect(model.totals).toEqual({
      headcount: 0, departments: 0, clocked_in_so_far: 0, on_leave_today: 0, pending_approvals: 0,
    });
    expect(model.trend.every((t) => t.headcount === 0)).toBe(true);
    expect(JSON.stringify(model)).not.toContain('NaN');
  });
});

describe('summaries', () => {
  it('totals each payroll run, newest first', async () => {
    const runs = payrollSummary(await data.listPayrollRuns(), await data.listPayslips());
    expect(runs).toHaveLength(8);
    expect(runs[0]).toMatchObject({ period_month: '2026-10-01', status: 'draft', headcount: 20, gross_cents: 10738750 });
    expect(runs[0].net_cents).toBe(runs[0].gross_cents - runs[0].deductions_cents);
    expect(runs[1]).toMatchObject({ period_month: '2026-09-01', status: 'paid' });
    expect(payrollSummary([], [])).toEqual([]);
  });

  it('counts attendance over a window and who was late most', async () => {
    const days = await data.listAttendance(addDays(TODAY, -6), TODAY);
    const counts = attendanceCounts(days);
    expect(counts.present + counts.late + counts.absent + counts.on_leave).toBe(days.length);
    expect(counts.rate_pct).toBeGreaterThan(80);
    expect(attendanceCounts([]).rate_pct).toBeNull();
    const late = lateByEmployee(days, await data.listEmployees());
    expect(late.every((row) => row.late > 0)).toBe(true);
    expect([...late].sort((a, b) => b.late - a.late)).toEqual(late);
  });

  it('adds up hours per employee', async () => {
    const entries = await data.listTimesheet(TODAY, TODAY);
    const rows = timesheetByEmployee(entries, await data.listEmployees());
    expect(rows).toHaveLength(17);
    expect(rows.every((r) => r.billable_hours <= r.hours)).toBe(true);
    expect(rows.reduce((sum, r) => sum + r.hours, 0)).toBe(entries.reduce((sum, e) => sum + e.hours, 0));
  });

  it('rounds hour totals so float steps do not leak', () => {
    const entry = (hours: number): TimesheetEntry =>
      ({ employee_id: 'e1', hours, billable_hours: hours }) as TimesheetEntry;
    const rows = timesheetByEmployee([entry(0.1), entry(0.2)], [{ id: 'e1', name: 'A' } as Employee]);
    expect(rows).toEqual([{ employee: 'A', hours: 0.3, billable_hours: 0.3 }]);
  });

  it('summarises goals, scores and ratings over released reviews only', async () => {
    const reviews = await data.listReviews();
    const summary = performanceSummary(await data.listGoals(), reviews);
    expect(summary.goals.total).toBe(40);
    expect(summary.goals.on_track + summary.goals.at_risk + summary.goals.done).toBe(40);
    // 20 reviews, two of them drafts: neither is rated, averaged or ranked.
    expect(reviews).toHaveLength(20);
    expect(summary.ratings.exceeds + summary.ratings.meets + summary.ratings.below).toBe(18);
    expect(summary.average_score).toBeGreaterThan(3);
    expect(summary.top).toHaveLength(5);
    const drafts = new Set(reviews.filter((r) => r.status === 'draft').map((r) => r.employee_name));
    expect(drafts.size).toBe(2);
    expect(summary.top.some((t) => drafts.has(t.employee))).toBe(false);
    expect(performanceSummary([], []).average_score).toBeNull();
  });

  it('never counts a draft, however high it scores, and is empty-safe for reviews with no competencies', () => {
    const review = (over: Partial<Review>): Review => ({
      id: 'r', employee_id: 'e', employee_name: 'A', period: 'H1 2026', competencies: {} as Review['competencies'],
      rating: 'meets', score: 3, comment: null, status: 'released', released_at: null, reviewer_name: null,
      reviewed_at: null, ...over,
    });
    const summary = performanceSummary([], [
      review({ id: '1', score: 4 }),
      review({ id: '2', score: 5, rating: 'exceeds', status: 'draft', employee_name: 'Draft Person' }),
    ]);
    expect(summary.average_score).toBe(4);
    expect(summary.ratings).toEqual({ exceeds: 0, meets: 1, below: 0 });
    expect(summary.top).toEqual([{ employee: 'A', period: 'H1 2026', score: 4 }]);
    expect(performanceSummary([], [review({ status: 'draft' })]).average_score).toBeNull();
    expect(JSON.stringify(summary)).not.toMatch(/NaN|Draft Person/);
  });

  it('gives each leave balance a name and what is left', async () => {
    const rows = leaveBalanceRows(await data.listLeaveBalances(2026), await data.listEmployees());
    expect(rows).toHaveLength(60);
    expect(rows.find((r) => r.employee === 'Aisyah Rahim' && r.leave_type === 'annual')).toMatchObject({
      entitled_days: 16, used_days: 2, remaining_days: 14,
    });
  });
});
