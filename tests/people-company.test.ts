import { describe, expect, it } from 'vitest';
import {
  buildAnnouncementsModel,
  buildDashboardModel,
  buildHolidaysModel,
  weeklyAttendanceRate,
} from '@/lib/people/company';
import { todayInMalaysia } from '@/lib/people/dates';
import { createSeedPeopleData } from '@/lib/people/seed';
import type { AttendanceDay, PayrollRun, PeopleData } from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = todayInMalaysia(NOW);
const data = createSeedPeopleData(NOW);

async function dashboardInput(source: PeopleData) {
  const [employees, leave, attendance, runs, payslips] = await Promise.all([
    source.listEmployees(),
    source.listLeaveRequests(),
    source.listAttendance('2026-08-10', TODAY),
    source.listPayrollRuns(),
    source.listPayslips(),
  ]);
  return { employees, leave, attendance, runs, payslips };
}

const day = (work_date: string, status: AttendanceDay['status']): AttendanceDay => ({
  id: `${work_date}-${status}`,
  employee_id: 'e1',
  work_date,
  clock_in: null,
  clock_out: null,
  status,
  corrected: false,
  correction_note: null,
});

describe('weeklyAttendanceRate', () => {
  it('is null for a week with no recorded days, not 0', () => {
    const weeks = weeklyAttendanceRate([day('2026-10-06', 'present'), day('2026-10-07', 'absent')], TODAY, 3);
    expect(weeks).toHaveLength(3);
    expect(weeks[0].value).toBeNull();
    expect(weeks[1].value).toBeNull();
    expect(weeks[2]).toMatchObject({ label: '05 Oct', value: 50 });
  });

  it('is null for a week of only leave', () => {
    expect(weeklyAttendanceRate([day('2026-10-06', 'on_leave')], TODAY, 1)[0].value).toBeNull();
  });

  it('counts late as present', () => {
    const weeks = weeklyAttendanceRate([day('2026-10-06', 'late'), day('2026-10-07', 'present')], TODAY, 1);
    expect(weeks[0].value).toBe(100);
  });
});

describe('buildDashboardModel', () => {
  it('builds the team figures from the sample company', async () => {
    const model = buildDashboardModel(await dashboardInput(data), TODAY, true);
    expect(model.team).toBe(true);
    expect(model.headcount).toBe(20);
    expect(model.trend).toHaveLength(8);
    expect(model.departments[0]).toEqual({ department: 'Sales', headcount: 6 });
    expect(model.attendanceToday?.clocked_in).toBeGreaterThan(0);
    expect(model.attendanceToday).not.toHaveProperty('rate_pct');
    expect(model.weeklyAttendance).toHaveLength(8);
    expect(model.leaveByType?.length).toBeGreaterThan(0);
    expect(model.joiners).toHaveLength(6);
    expect(model.payroll?.latest?.gross_cents).toBe(10_738_750);
    expect(model.payroll?.byMonth).toHaveLength(8);
    expect(model.payroll?.byMonth[7].label).toBe('Oct');
  });

  it('gives a member headcount and departments and marks the rest not team', async () => {
    const model = buildDashboardModel(await dashboardInput(data), TODAY, false);
    expect(model.team).toBe(false);
    expect(model.headcount).toBe(20);
    expect(model.trend).toHaveLength(8);
    expect(model.departments).toHaveLength(5);
    expect(model.attendanceToday).toBeNull();
    expect(model.weeklyAttendance).toBeNull();
    expect(model.leaveByType).toBeNull();
    expect(model.joiners).toBeNull();
    expect(model.payroll).toBeNull();
  });

  it('shows the newest run as the latest tile even with no payslips, and charts only months with payslips', async () => {
    const input = await dashboardInput(data);
    const empty: PayrollRun = { id: 'new', period_month: '2026-11-01', status: 'paid', paid_at: '2026-11-28T02:00:00Z', paid_by_name: null };
    const model = buildDashboardModel({ ...input, runs: [...input.runs, empty] }, TODAY, true);
    expect(model.payroll?.latest).toEqual({ period_month: '2026-11-01', gross_cents: 0, headcount: 0 });
    expect(model.payroll?.byMonth).toHaveLength(8);
    const only = buildDashboardModel({ ...input, runs: [empty], payslips: [] }, TODAY, true);
    expect(only.payroll?.latest).toEqual({ period_month: '2026-11-01', gross_cents: 0, headcount: 0 });
    expect(only.payroll?.byMonth).toEqual([]);
  });

  it('is zero and has no NaN for an empty workspace', () => {
    const empty = { employees: [], leave: [], attendance: [], runs: [], payslips: [] };
    const model = buildDashboardModel(empty, TODAY, true);
    expect(model.headcount).toBe(0);
    expect(model.departments).toEqual([]);
    expect(model.attendanceToday?.clocked_in).toBe(0);
    expect(model.weeklyAttendance?.every((w) => w.value === null)).toBe(true);
    expect(model.leaveByType).toEqual([]);
    expect(model.payroll?.latest).toBeNull();
    expect(model.payroll?.byMonth).toEqual([]);
    expect(JSON.stringify(model)).not.toMatch(/NaN|Infinity/);
  });
});

describe('buildAnnouncementsModel', () => {
  it('counts the sample announcements, one per category', async () => {
    const model = buildAnnouncementsModel(await data.listAnnouncements(), NOW);
    expect(model.total).toBe(5);
    expect(model.categories).toBe(5);
    expect(model.byCategory).toHaveLength(5);
    expect(model.byCategory.every((c) => c.value === 1)).toBe(true);
    expect(model.byCategory.map((c) => c.label)).toEqual(['General', 'Holiday', 'Benefits', 'Strategy', 'Policy']);
  });

  it('lists newest first with an author fallback and a relative time', async () => {
    const rows = await data.listAnnouncements();
    const model = buildAnnouncementsModel(
      [...rows, { ...rows[0], id: 'x', title: 'Fresh', published_at: '2026-10-09T03:00:00Z', author_name: null }],
      NOW,
    );
    expect(model.list[0]).toMatchObject({ title: 'Fresh', author: 'Unknown', when: '1 hour ago' });
    const times = model.list.map((a) => a.title);
    expect(times).toHaveLength(6);
  });

  it('counts only this month in This month', () => {
    const base = { id: '1', title: 'a', body: 'b', category: 'general' as const, author_name: 'A' };
    const model = buildAnnouncementsModel(
      [
        { ...base, published_at: '2026-10-02T01:00:00Z' },
        { ...base, id: '2', published_at: '2026-09-30T01:00:00Z' },
      ],
      NOW,
    );
    expect(model.thisMonth).toBe(1);
  });

  it('is empty without rows', () => {
    const model = buildAnnouncementsModel([], NOW);
    expect(model).toMatchObject({ total: 0, thisMonth: 0, categories: 0, byCategory: [], list: [] });
  });
});

describe('buildHolidaysModel', () => {
  it('finds Christmas Day as the next holiday after 9 October', async () => {
    const model = buildHolidaysModel(await data.listPublicHolidays(), TODAY);
    expect(model.next?.name).toBe('Christmas Day');
    expect(model.next?.daysAway).toBe(77);
    expect(model.next?.in).toBe('in 77 days');
    expect(model.year).toBe(2026);
    expect(model.total).toBe(6);
    expect(model.thisMonth).toBe(0);
  });

  it('orders the calendar by date, marks past rows and names the weekday', async () => {
    const model = buildHolidaysModel(await data.listPublicHolidays(), TODAY);
    const dates = model.rows.map((r) => r.date);
    expect([...dates].sort()).toEqual(dates);
    expect(model.rows.find((r) => r.name === 'Labour Day')).toMatchObject({ past: true, weekday: 'Friday' });
    expect(model.rows.find((r) => r.name === 'Christmas Day')?.past).toBe(false);
    expect(model.upcoming.map((r) => r.name)).toEqual(['Christmas Day']);
  });

  it('says nationwide for a national holiday and the state for a state one', async () => {
    const model = buildHolidaysModel(await data.listPublicHolidays(), TODAY);
    expect(model.rows.find((r) => r.name === 'Labour Day')).toMatchObject({ scope: 'National', state: 'Nationwide' });
    expect(model.rows.find((r) => r.name === "New Year's Day")).toMatchObject({ scope: 'State', state: 'Kuala Lumpur' });
  });

  it('says today and tomorrow', () => {
    const rows = [
      { id: '1', name: 'A', holiday_date: TODAY, scope: 'national' as const, state: null },
      { id: '2', name: 'B', holiday_date: '2026-10-10', scope: 'national' as const, state: null },
    ];
    expect(buildHolidaysModel(rows, TODAY).next?.in).toBe('today');
    expect(buildHolidaysModel(rows.slice(1), TODAY).next?.in).toBe('tomorrow');
  });

  it('is empty without rows', () => {
    const model = buildHolidaysModel([], TODAY);
    expect(model).toMatchObject({ total: 0, thisMonth: 0, next: null, rows: [], upcoming: [] });
  });
});
