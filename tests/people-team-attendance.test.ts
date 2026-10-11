import { describe, expect, it } from 'vitest';
import { toCorrectionInput } from '@/lib/people/attendance-forms';
import { PEOPLE_PATHS } from '@/lib/people/paths';
import { buildTeamAttendanceModel, loadTeamAttendance, parseDay } from '@/lib/people/team-attendance';
import type { AttendanceDay, Employee, LeaveRequest, PeopleData, PeopleViewer, PublicHoliday } from '@/lib/people/types';

const TODAY = '2026-10-09'; // Friday
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;

const emp = (id: string, name: string, over: Partial<Employee> = {}): Employee => ({
  id,
  user_id: null,
  employee_no: id,
  name,
  work_email: null,
  department_id: null,
  department_name: 'Ops',
  designation: null,
  employment_type: 'full_time',
  is_manager: false,
  join_date: '2025-01-01',
  status: 'active',
  date_of_birth_day: null,
  date_of_birth_month: null,
  created_at: '2025-01-01T00:00:00Z',
  ...over,
});

const day = (over: Partial<AttendanceDay>): AttendanceDay => ({
  id: 'a',
  employee_id: 'e1',
  work_date: '2026-10-08',
  clock_in: '2026-10-08T00:52:00Z', // 8:52 am in Kuala Lumpur
  clock_out: '2026-10-08T10:03:00Z', // 6:03 pm
  status: 'present',
  corrected: false,
  correction_note: null,
  ...over,
});

const leave = (over: Partial<LeaveRequest>): LeaveRequest => ({
  id: 'l',
  employee_id: 'e2',
  employee_name: 'Bee',
  leave_type: 'annual',
  start_date: '2026-10-08',
  end_date: '2026-10-08',
  days: 1,
  half_day: false,
  reason: null,
  status: 'approved',
  decision_note: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});

const build = (over: Partial<Parameters<typeof buildTeamAttendanceModel>[0]> = {}) =>
  buildTeamAttendanceModel({
    date: '2026-10-08', // Thursday
    today: TODAY,
    employees: [emp('e1', 'Amirul'), emp('e2', 'Bee'), emp('e3', 'Chong')],
    attendance: [],
    leave: [],
    holidays: [],
    workWeek: [...WEEK],
    ...over,
  });

describe('parseDay', () => {
  it('takes a real day up to today', () => {
    expect(parseDay('2026-10-01', TODAY)).toBe('2026-10-01');
    expect(parseDay(TODAY, TODAY)).toBe(TODAY);
  });
  it('falls back to today when absent, malformed, impossible, repeated, too old or in the future', () => {
    for (const raw of [undefined, '', 'yesterday', '2026-02-31', '2026-10-10', '1999-12-31', ['2026-10-01', '2026-10-02']]) {
      expect(parseDay(raw, TODAY), String(raw)).toBe(TODAY);
    }
  });
});

describe('buildTeamAttendanceModel', () => {
  it('has a row per active employee, by name, and none for the inactive', () => {
    const model = build({ employees: [emp('e2', 'Bee'), emp('e1', 'Amirul'), emp('e9', 'Gone', { status: 'inactive' })] });
    expect(model.rows.map((r) => r.name)).toEqual(['Amirul', 'Bee']);
  });

  it('shows the status the row carries, with worded times and hours', () => {
    const model = build({ attendance: [day({})] });
    const row = model.rows[0];
    expect(row).toMatchObject({ status: 'present', label: 'Present', clockIn: '8:52 am', clockOut: '6:03 pm', hours: '9 h 11 min' });
    expect(row.noClockOut).toBe(false);
    expect(row.prefill).toMatchObject({ status: 'present', clock_in: '08:52', clock_out: '18:03' });
  });

  it('does not decide late itself: a clock-in at 11 am on a "present" row is present', () => {
    const model = build({ attendance: [day({ clock_in: '2026-10-08T03:00:00Z', status: 'present' })] });
    expect(model.rows[0].label).toBe('Present');
    expect(model.tiles.late).toBe(0);
  });

  it('shows "Corrected" with its note, and no note on a day nobody corrected', () => {
    const corrected = build({ attendance: [day({ corrected: true, correction_note: 'Forgot to clock out' })] });
    expect(corrected.rows[0]).toMatchObject({ corrected: true, note: 'Forgot to clock out' });
    expect(corrected.rows[0].prefill.note).toBe('Forgot to clock out');
    expect(build({ attendance: [day({ correction_note: 'stale' })] }).rows[0].note).toBeNull();
  });

  it('flags a past day with a clock-in and no clock-out, and counts it', () => {
    const model = build({ attendance: [day({ clock_out: null })] });
    expect(model.rows[0]).toMatchObject({ noClockOut: true, hours: null, clockOut: null });
    expect(model.tiles.noClockOut).toBe(1);
  });

  it('does not call someone still in today a missing clock-out', () => {
    const model = build({ date: TODAY, attendance: [day({ work_date: TODAY, clock_in: '2026-10-09T00:52:00Z', clock_out: null })] });
    expect(model.rows[0]).toMatchObject({ noClockOut: false, stillIn: true });
    expect(model.tiles.noClockOut).toBe(0);
  });

  it('drops the times of an absent or on-leave row', () => {
    const model = build({ attendance: [day({ status: 'absent', clock_in: null, clock_out: null })] });
    expect(model.rows[0]).toMatchObject({ label: 'Absent', clockIn: null, hours: null, noClockOut: false });
  });

  it('says "No record" for a past working day with no row, and "Not clocked in yet" for today', () => {
    expect(build().rows[0]).toMatchObject({ status: null, label: 'No record' });
    expect(build({ date: TODAY }).rows[0]).toMatchObject({ status: null, label: 'Not clocked in yet' });
  });

  it('shows approved full-day leave with no row as leave, but not half-day, pending or other days', () => {
    const rows = (l: LeaveRequest) => build({ leave: [l] }).rows.find((r) => r.employeeId === 'e2')!;
    expect(rows(leave({}))).toMatchObject({ status: 'on_leave', label: 'On leave' });
    expect(rows(leave({ half_day: true })).label).toBe('No record');
    expect(rows(leave({ status: 'pending' })).label).toBe('No record');
    expect(rows(leave({ start_date: '2026-10-09', end_date: '2026-10-09' })).label).toBe('No record');
  });

  it('shows nothing for an employee with no row on a weekend or a holiday, but still gives the prefill', () => {
    const weekend = build({ date: '2026-10-03' }); // Saturday
    expect(weekend.workingDay).toBe(false);
    expect(weekend.nonWorkingReason).toBe('Not a working day');
    expect(weekend.rows[0]).toMatchObject({ status: null, label: '' });
    expect(weekend.rows[0].prefill.status).toBe('present');

    const holiday: PublicHoliday = { id: 'h', name: 'Deepavali', holiday_date: '2026-10-08', scope: 'national', state: null };
    const model = build({ holidays: [holiday] });
    expect(model.workingDay).toBe(false);
    expect(model.nonWorkingReason).toBe('Public holiday: Deepavali');
    expect(model.rows[0].label).toBe('');
  });

  it('keeps a recorded weekend day (weekend work)', () => {
    const model = build({ date: '2026-10-03', attendance: [day({ work_date: '2026-10-03', clock_in: '2026-10-03T01:00:00Z', clock_out: null })] });
    expect(model.rows[0]).toMatchObject({ label: 'Present', noClockOut: true });
  });

  it('follows the workspace work week, and Monday to Friday when it names no known day', () => {
    expect(build({ date: '2026-10-03', workWeek: ['mon', 'sat'] }).workingDay).toBe(true);
    expect(build({ date: '2026-10-03', workWeek: [] }).workingDay).toBe(false);
    expect(build({ date: '2026-10-08', workWeek: [] }).workingDay).toBe(true);
  });

  it('counts the tiles from the rows', () => {
    const model = build({
      employees: [emp('e1', 'A'), emp('e2', 'B'), emp('e3', 'C'), emp('e4', 'D'), emp('e5', 'E')],
      attendance: [
        day({ id: '1', employee_id: 'e1' }),
        day({ id: '2', employee_id: 'e2', status: 'late', clock_out: null }),
        day({ id: '3', employee_id: 'e3', status: 'absent', clock_in: null, clock_out: null }),
        day({ id: '4', employee_id: 'e4', status: 'on_leave', clock_in: null, clock_out: null }),
      ],
    });
    expect(model.tiles).toEqual({ present: 1, late: 1, absent: 1, onLeave: 1, noClockOut: 1 });
  });

  it('ignores a row for another date', () => {
    expect(build({ attendance: [day({ work_date: '2026-10-07' })] }).rows[0].label).toBe('No record');
  });

  it('links to the day before and, except on today, the day after', () => {
    const past = build();
    expect(past).toMatchObject({ previous: '2026-10-07', next: '2026-10-09', isToday: false, heading: 'Thursday, 08 Oct 2026' });
    expect(build({ date: TODAY })).toMatchObject({ previous: '2026-10-08', next: null, isToday: true });
  });
});

describe('loadTeamAttendance', () => {
  const settings = { work_week: [...WEEK] };
  const spy = () => {
    const calls: string[] = [];
    const data = new Proxy(
      {},
      {
        get: (_t, name: string) => async () => {
          calls.push(name);
          if (name === 'getSettings') return settings;
          return [];
        },
      },
    ) as unknown as PeopleData;
    return { data, calls };
  };
  const HR: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
  const MEMBER: PeopleViewer = { employeeId: 'e1', isHr: false, isDemo: false };
  const DEMO: PeopleViewer = { employeeId: 'e1', isHr: false, isDemo: true };

  it('gives a member the notice and reads nothing', async () => {
    const { data, calls } = spy();
    expect(await loadTeamAttendance(data, MEMBER, undefined, TODAY)).toEqual({ hr_only: true });
    expect(calls).toEqual([]);
  });

  it('reads only the chosen day for an owner or admin, and for the demo', async () => {
    for (const viewer of [HR, DEMO]) {
      const model = await loadTeamAttendance(spy().data, viewer, '2026-10-01', TODAY);
      expect(model).toMatchObject({ hr_only: false, date: '2026-10-01' });
    }
    const asked: unknown[][] = [];
    const data = {
      listEmployees: async () => [],
      listAttendance: async (...args: unknown[]) => (asked.push(args), []),
      listLeaveRequests: async () => [],
      listPublicHolidays: async () => [],
      getSettings: async () => settings,
    } as unknown as PeopleData;
    await loadTeamAttendance(data, HR, '2099-01-01', TODAY);
    expect(asked).toEqual([[TODAY, TODAY]]);
  });
});

describe('the new page and its form', () => {
  it('is refreshed after a clock-in or a correction, because PEOPLE_PATHS holds it', () => {
    expect(PEOPLE_PATHS).toContain('/people/attendance');
  });

  it('refuses a future day with its own sentence when the form passes today', () => {
    const values = { employee_id: 'e1', work_date: '2026-10-10', status: 'absent' as const, clock_in: '', clock_out: '', note: '' };
    expect(toCorrectionInput(values, TODAY)).toEqual({ ok: false, error: 'The date cannot be in the future.' });
    expect(toCorrectionInput({ ...values, work_date: TODAY }, TODAY).ok).toBe(true);
  });
});
