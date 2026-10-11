import { describe, expect, it } from 'vitest';
import {
  buildMyAttendance,
  buildOvertimeView,
  buildShiftCalendar,
  buildTimesheet,
  clockButtonLabel,
  clockResultMessage,
  ownDayToday,
  workWeekFor,
} from '@/lib/people/attendance';
import { createSeedPeopleData } from '@/lib/people/seed';
import {
  DEMO_EMPLOYEE_ID,
  type AttendanceDay,
  type OvertimeRecord,
  type PeopleViewer,
  type TimesheetEntry,
} from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z'); // Friday
const TODAY = '2026-10-09';
const data = createSeedPeopleData(NOW);

const HR3: PeopleViewer = { employeeId: 'seed-emp-3', isHr: true, isDemo: false };
const DEMO: PeopleViewer = { employeeId: DEMO_EMPLOYEE_ID, isHr: false, isDemo: true };
const MEMBER: PeopleViewer = { employeeId: 'seed-emp-5', isHr: false, isDemo: false };
const UNLINKED_HR: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };

const day = (over: Partial<AttendanceDay>): AttendanceDay => ({
  id: 'a',
  employee_id: 'e1',
  work_date: '2026-10-05',
  clock_in: '2026-10-05T01:00:00Z', // 09:00 in Kuala Lumpur
  clock_out: '2026-10-05T10:00:00Z', // 18:00
  status: 'present',
  corrected: false,
  correction_note: null,
  ...over,
});

async function myAttendance(viewer: PeopleViewer) {
  const [days, leave, balances] = await Promise.all([
    data.listAttendance('2026-08-17', TODAY),
    data.listLeaveRequests(),
    data.listLeaveBalances(2026),
  ]);
  return buildMyAttendance({ days, leave, balances, viewer, today: TODAY });
}

describe('buildMyAttendance', () => {
  it("uses only the viewer's own days, whoever else the database returned", async () => {
    const all = await data.listAttendance('2026-08-17', TODAY);
    const model = await myAttendance(HR3);
    expect(model.linked).toBe(true);
    const mine = all.filter((d) => d.employee_id === 'seed-emp-3');
    const thisMonth = mine.filter((d) => d.work_date >= '2026-10-01' && d.status !== 'on_leave');
    expect(model.month.recorded).toBe(thisMonth.length);
    expect(model.month.present).toBe(thisMonth.filter((d) => d.status === 'present' || d.status === 'late').length);
    expect(model.month.late).toBe(thisMonth.filter((d) => d.status === 'late').length);
    // Every recent row is employee 3's: the recent dates match their own rows exactly.
    const expected = mine.map((d) => d.work_date).sort().reverse().slice(0, 10);
    expect(model.recent.map((r) => r.work_date)).toEqual(expected);
  });

  it('shows the demo visitor their fixed employee, not the team', async () => {
    const all = await data.listAttendance('2026-08-17', TODAY);
    const model = await myAttendance(DEMO);
    const mine = all.filter((d) => d.employee_id === DEMO_EMPLOYEE_ID);
    expect(model.recent).toHaveLength(10);
    expect(model.recent[0].work_date).toBe(mine.map((d) => d.work_date).sort().reverse()[0]);
  });

  it('is not linked for an account with no employee, even for HR', async () => {
    const model = await myAttendance(UNLINKED_HR);
    expect(model.linked).toBe(false);
    expect(model.recent).toEqual([]);
    expect(model.month.recorded).toBe(0);
  });

  it('has an average clock-in of null when there are no clock-ins this month', () => {
    const model = buildMyAttendance({
      days: [day({ clock_in: null, clock_out: null, status: 'absent' })],
      leave: [],
      balances: [],
      viewer: { employeeId: 'e1', isHr: false, isDemo: false },
      today: TODAY,
    });
    expect(model.month.avg_clock_in).toBeNull();
    expect(model.annual_left).toBeNull();
  });

  it('averages the clock-in on the Malaysian clock', () => {
    const model = buildMyAttendance({
      days: [
        day({ work_date: '2026-10-05', clock_in: '2026-10-05T01:00:00Z' }),
        day({ id: 'b', work_date: '2026-10-06', clock_in: '2026-10-06T01:10:00Z' }),
      ],
      leave: [],
      balances: [],
      viewer: { employeeId: 'e1', isHr: false, isDemo: false },
      today: TODAY,
    });
    expect(model.month.avg_clock_in).toBe('09:05');
  });

  it('leaves a day with no clock-out out of the hours series and keeps it in the table', () => {
    const model = buildMyAttendance({
      days: [
        day({ work_date: '2026-10-08', clock_out: null }),
        day({ id: 'b', work_date: '2026-10-07', clock_in: '2026-10-07T01:00:00Z', clock_out: '2026-10-07T09:30:00Z' }),
      ],
      leave: [],
      balances: [],
      viewer: { employeeId: 'e1', isHr: false, isDemo: false },
      today: TODAY,
    });
    expect(model.hours).toEqual([{ label: '07 Oct', hours: 8.5 }]);
    expect(model.recent.map((r) => [r.work_date, r.hours])).toEqual([
      ['2026-10-08', null],
      ['2026-10-07', 8.5],
    ]);
  });

  it('builds an 8 week by 5 weekday pattern, zero where there are no hours', async () => {
    const model = await myAttendance(HR3);
    expect(model.pattern.values).toHaveLength(8);
    expect(model.pattern.values.every((row) => row.length === 5)).toBe(true);
    expect(model.pattern.weeks).toHaveLength(8);
    expect(model.pattern.weeks.at(-1)).toBe('05 Oct');
  });

  it('labels all four statuses', () => {
    const viewer = { employeeId: 'e1', isHr: false, isDemo: false };
    const model = buildMyAttendance({
      days: (['present', 'late', 'absent', 'on_leave'] as const).map((status, i) =>
        day({ id: String(i), work_date: `2026-10-0${i + 1}`, status }),
      ),
      leave: [],
      balances: [],
      viewer,
      today: TODAY,
    });
    expect(model.recent.map((r) => r.status_label).sort()).toEqual(['Absent', 'Late', 'On leave', 'Present']);
  });

  it('counts leave taken by real leave types and the annual balance left', async () => {
    const model = await myAttendance(DEMO);
    expect(model.leave_by_type.every((s) => s.label !== 'Replacement')).toBe(true);
    expect(model.leave_total).toBe(model.leave_by_type.reduce((t, s) => t + s.days, 0));
    expect(model.annual_left).not.toBeNull();
  });

  it('is empty, not broken, with no rows at all', () => {
    const model = buildMyAttendance({
      days: [], leave: [], balances: [], viewer: { employeeId: 'e1', isHr: false, isDemo: false }, today: TODAY,
    });
    expect(model.linked).toBe(true);
    expect(model.month).toEqual({ present: 0, recorded: 0, late: 0, avg_clock_in: null });
    expect(model.hours).toEqual([]);
    expect(model.recent).toEqual([]);
    expect(model.leave_by_type).toEqual([]);
    expect(model.leave_total).toBe(0);
    expect(model.pattern.values.flat().every((v) => v === 0)).toBe(true);
  });
});

describe('buildTimesheet', () => {
  it('covers Monday to Sunday of the current week for the team', async () => {
    const [entries, employees] = await Promise.all([data.listTimesheet('2026-10-05', '2026-10-11'), data.listEmployees()]);
    const model = buildTimesheet({ entries, employees, viewer: HR3, today: TODAY });
    expect(model.team).toBe(true);
    expect(model.week_start).toBe('2026-10-05');
    expect(model.week_end).toBe('2026-10-11');
    expect(model.days).toHaveLength(7);
    expect(model.rows.length).toBeGreaterThan(5);
    const total = entries.reduce((t, e) => t + e.hours, 0);
    expect(model.totals.hours).toBeCloseTo(total, 5);
    expect(model.totals.billable_share).toBe(Math.round((model.totals.billable_hours / model.totals.hours) * 100));
    expect(model.by_employee.length).toBe(model.rows.length);
    const rowTotal = model.rows.reduce((t, r) => t + r.total, 0);
    expect(rowTotal).toBeCloseTo(model.totals.hours, 5);
  });

  it("flags a member's model as not the team's", async () => {
    const mine: TimesheetEntry[] = (await data.listTimesheet('2026-10-05', '2026-10-11')).filter(
      (e) => e.employee_id === 'seed-emp-5',
    );
    const model = buildTimesheet({ entries: mine, employees: await data.listEmployees(), viewer: MEMBER, today: TODAY });
    expect(model.team).toBe(false);
    expect(model.rows).toHaveLength(1);
  });

  it('has a null share and no rows with no entries', () => {
    const model = buildTimesheet({ entries: [], employees: [], viewer: HR3, today: TODAY });
    expect(model.rows).toEqual([]);
    expect(model.totals).toEqual({ hours: 0, billable_hours: 0, billable_share: null, members: 0 });
    expect(model.by_employee).toEqual([]);
  });

  it('ignores entries from outside the week', () => {
    const entries: TimesheetEntry[] = [
      { id: 't', employee_id: 'e1', work_date: '2026-10-02', hours: 8, billable_hours: 6 },
    ];
    const model = buildTimesheet({ entries, employees: [], viewer: HR3, today: TODAY });
    expect(model.rows).toEqual([]);
  });
});

describe('buildShiftCalendar', () => {
  it("rosters the week's employees with morning, night and off, and counts", async () => {
    const [shifts, employees] = await Promise.all([data.listShifts('2026-10-05', '2026-10-11'), data.listEmployees()]);
    const model = buildShiftCalendar({ shifts, employees, viewer: HR3, today: TODAY });
    expect(model.team).toBe(true);
    expect(model.rows).toHaveLength(5);
    expect(model.rows.every((r) => r.cells.length === 7)).toBe(true);
    expect(model.morning_count).toBe(shifts.filter((s) => s.shift === 'morning').length);
    expect(model.night_count).toBe(shifts.filter((s) => s.shift === 'night').length);
  });

  it('gives an empty roster, not blank rows for every employee, when the week has no shifts', async () => {
    const employees = await data.listEmployees();
    const model = buildShiftCalendar({ shifts: [], employees, viewer: HR3, today: TODAY });
    expect(model.rows).toEqual([]);
    expect(model.morning_count).toBe(0);
    expect(model.night_count).toBe(0);
  });

  it('leaves a day blank (null) when no shift is set for it', () => {
    const model = buildShiftCalendar({
      shifts: [{ id: 's', employee_id: 'e1', work_date: '2026-10-07', shift: 'night' }],
      employees: [],
      viewer: MEMBER,
      today: TODAY,
    });
    expect(model.team).toBe(false);
    expect(model.rows[0].cells).toEqual([null, null, 'night', null, null, null, null]);
  });
});

describe('buildOvertimeView', () => {
  const record = (over: Partial<OvertimeRecord>): OvertimeRecord => ({
    id: 'r', employee_id: 'e1', employee_name: 'E', work_date: '2026-10-02', hours: 1, rate_multiplier: 1.5,
    amount_cents: 3750, hourly_rate_cents: 2500, day_kind: null, reason: null, decision_note: null, status: 'approved', created_at: '2026-10-02T00:00:00Z', ...over,
  });

  it('reproduces the overtime model for the team and lists records newest first', async () => {
    const view = buildOvertimeView({
      records: await data.listOvertime(), employees: await data.listEmployees(), viewer: HR3, today: TODAY,
    });
    expect(view.team).toBe(true);
    expect(view.model.month.hours).toBe(13);
    expect(view.model.month.amount_cents).toBe(48750);
    const dates = view.records.map((r) => r.work_date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(view.records.some((r) => r.status === 'rejected')).toBe(true);
  });

  it("flags a member's view and leaves the department split empty", async () => {
    const view = buildOvertimeView({
      records: [record({})], employees: await data.listEmployees(), viewer: MEMBER, today: TODAY,
    });
    expect(view.team).toBe(false);
    expect(view.model.by_department).toEqual([]);
  });

  it('is empty on no rows', () => {
    const view = buildOvertimeView({ records: [], employees: [], viewer: HR3, today: TODAY });
    expect(view.records).toEqual([]);
    expect(view.model.month.hours).toBe(0);
    expect(view.truncated).toBe(false);
  });

  it('caps the table and says so', () => {
    const many = Array.from({ length: 30 }, (_, i) => record({ id: String(i) }));
    const view = buildOvertimeView({ records: many, employees: [], viewer: HR3, today: TODAY });
    expect(view.records).toHaveLength(25);
    expect(view.truncated).toBe(true);
  });
});

describe('My Attendance history: corrected days and missing clock-outs', () => {
  const viewer: PeopleViewer = { employeeId: 'e1', isHr: false, isDemo: false };
  const build = (days: AttendanceDay[]) => buildMyAttendance({ days, leave: [], balances: [], viewer, today: TODAY });

  it('carries the correction and its note onto the row', () => {
    const model = build([
      day({ work_date: '2026-10-06', corrected: true, correction_note: 'Forgot to clock in' }),
      day({ id: 'b', work_date: '2026-10-07' }),
    ]);
    const byDate = Object.fromEntries(model.recent.map((r) => [r.work_date, r]));
    expect(byDate['2026-10-06'].corrected).toBe(true);
    expect(byDate['2026-10-06'].correction_note).toBe('Forgot to clock in');
    expect(byDate['2026-10-07'].corrected).toBe(false);
    expect(byDate['2026-10-07'].correction_note).toBeNull();
  });

  it('marks a past day with a clock-in and no clock-out as having no clock-out', () => {
    const model = build([day({ work_date: '2026-10-08', clock_in: '2026-10-08T01:00:00Z', clock_out: null })]);
    expect(model.recent[0].no_clock_out).toBe(true);
  });

  it('never marks today as having no clock-out, however late it is', () => {
    const model = build([day({ work_date: TODAY, clock_in: '2026-10-09T01:00:00Z', clock_out: null })]);
    expect(model.recent[0].is_today).toBe(true);
    expect(model.recent[0].no_clock_out).toBe(false);
  });

  it('shows a corrected past day with a clock-in and no clock-out as Corrected only', () => {
    const model = build([
      day({ work_date: '2026-10-08', clock_in: '2026-10-08T01:00:00Z', clock_out: null, corrected: true, correction_note: 'Left early' }),
    ]);
    expect(model.recent[0].corrected).toBe(true);
    expect(model.recent[0].no_clock_out).toBe(false);
  });

  it('does not mark a day with no clock-in, or a complete day', () => {
    const model = build([
      day({ work_date: '2026-10-06', clock_in: null, clock_out: null, status: 'absent' }),
      day({ id: 'b', work_date: '2026-10-07' }),
    ]);
    expect(model.recent.every((r) => r.no_clock_out === false)).toBe(true);
  });
});

describe('clockResultMessage', () => {
  it('says a clock-in was on time, from the status the database returned', () => {
    const row = { work_date: TODAY, clock_in: '2026-10-09T00:52:00Z', clock_out: null, status: 'present' as const };
    expect(clockResultMessage('in', row)).toBe('Clocked in at 8:52 am, on time.');
  });

  it('says a clock-in was late', () => {
    const row = { work_date: TODAY, clock_in: '2026-10-09T02:30:00Z', clock_out: null, status: 'late' as const };
    expect(clockResultMessage('in', row)).toBe('Clocked in at 10:30 am, late.');
  });

  it('words a clock-in with a status that is neither on time nor late neutrally', () => {
    for (const status of ['absent', 'on_leave'] as const) {
      const row = { work_date: TODAY, clock_in: '2026-10-09T00:52:00Z', clock_out: null, status };
      expect(clockResultMessage('in', row)).toBe('Clocked in at 8:52 am.');
    }
  });

  it('says when a clock-out happened and how long the day was', () => {
    const row = {
      work_date: TODAY,
      clock_in: '2026-10-09T00:52:00Z',
      clock_out: '2026-10-09T10:03:00Z',
      status: 'present' as const,
    };
    expect(clockResultMessage('out', row)).toBe('Clocked out at 6:03 pm. You worked 9 h 11 min.');
  });
});

describe('the My Attendance screen rules', () => {
  const SELF: PeopleViewer = { employeeId: 'e1', isHr: false, isDemo: false };

  it('counts every day as a working day for someone who cannot read the settings', () => {
    expect(workWeekFor(null)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect(workWeekFor({ work_week: ['mon', 'tue'] })).toEqual(['mon', 'tue']);
  });

  it("picks the viewer's own row for today, and no one else's or another day's", () => {
    const mine = day({ id: 'mine', employee_id: 'e1', work_date: TODAY });
    const days = [
      day({ id: 'other', employee_id: 'e2', work_date: TODAY }),
      day({ id: 'old', employee_id: 'e1', work_date: '2026-10-08' }),
      mine,
    ];
    expect(ownDayToday(days, SELF, TODAY)).toBe(mine);
    expect(ownDayToday(days.slice(0, 2), SELF, TODAY)).toBeNull();
    expect(ownDayToday(days, { ...SELF, employeeId: null }, TODAY)).toBeNull();
  });

  it('words the clock button once, for resting and for a call in flight', () => {
    expect(clockButtonLabel('in', false)).toBe('Clock in');
    expect(clockButtonLabel('out', false)).toBe('Clock out');
    expect(clockButtonLabel('in', true)).toBe('Clocking in…');
    expect(clockButtonLabel('out', true)).toBe('Clocking out…');
  });
});
