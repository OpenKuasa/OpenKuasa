import { describe, expect, it } from 'vitest';
import {
  clockAction,
  todayLine,
  todayState,
  toCorrectionInput as convertCorrection,
  toHolidayInput,
  toSettingsInput,
} from '@/lib/people/attendance-forms';
import type { AttendanceDay, LeaveRequest, PublicHoliday, Weekday } from '@/lib/people/types';

const EMP = 'emp-1';
// 2026-10-12 is a Monday; 2026-10-10 a Saturday.
const MONDAY = '2026-10-12';
const SATURDAY = '2026-10-10';
const WEEK: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

const day = (over: Partial<AttendanceDay> = {}): AttendanceDay => ({
  id: 'd1',
  employee_id: EMP,
  work_date: MONDAY,
  clock_in: null,
  clock_out: null,
  status: 'absent',
  corrected: false,
  correction_note: null,
  ...over,
});
const holiday = (date: string, name = 'Deepavali'): PublicHoliday => ({
  id: 'h1',
  name,
  holiday_date: date,
  scope: 'national',
  state: null,
});
const leave = (over: Partial<LeaveRequest> = {}): LeaveRequest => ({
  id: 'l1',
  employee_id: EMP,
  employee_name: 'Aisyah',
  leave_type: 'annual',
  start_date: MONDAY,
  end_date: MONDAY,
  days: 1,
  half_day: false,
  reason: null,
  status: 'approved',
  decision_note: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});
const base = { today: MONDAY, day: null as AttendanceDay | null, workWeek: WEEK, holidays: [] as PublicHoliday[], leave: [] as LeaveRequest[], employeeId: EMP as string | null };

// 08:52 and 18:03 in Kuala Lumpur (UTC+8).
const IN = '2026-10-12T00:52:10+00:00';
const OUT = '2026-10-12T10:03:40+00:00';

describe('todayState', () => {
  it('is not_linked for a viewer with no employee record, whatever else is true', () => {
    expect(todayState({ ...base, employeeId: null })).toEqual({ kind: 'not_linked' });
    expect(todayState({ ...base, employeeId: null, day: day({ clock_in: IN }) })).toEqual({ kind: 'not_linked' });
  });

  it('is not_in on a working day with no row', () => {
    expect(todayState(base)).toEqual({ kind: 'not_in' });
  });

  it('is not_in for the nightly close or an early absent mark: a row with no clock-in', () => {
    expect(todayState({ ...base, day: day({ status: 'absent' }) })).toEqual({ kind: 'not_in' });
    expect(todayState({ ...base, day: day({ status: 'absent', corrected: true, correction_note: 'Away' }) })).toEqual({ kind: 'not_in' });
  });

  it('is in once a clock-in is recorded, with the time as the viewer reads it', () => {
    expect(todayState({ ...base, day: day({ clock_in: IN, status: 'present' }) })).toEqual({ kind: 'in', since: '8:52 am' });
  });

  it('is done with both times and the whole minutes between them', () => {
    expect(todayState({ ...base, day: day({ clock_in: IN, clock_out: OUT, status: 'late' }) })).toEqual({
      kind: 'done',
      from: '8:52 am',
      to: '6:03 pm',
      worked: '9 h 11 min',
    });
  });

  it('counts a day with a correction by its times, like any other', () => {
    const corrected = day({ clock_in: IN, clock_out: OUT, status: 'present', corrected: true, correction_note: 'Forgot' });
    expect(todayState({ ...base, day: corrected })).toMatchObject({ kind: 'done' });
    expect(todayState({ ...base, day: { ...corrected, clock_out: null } })).toMatchObject({ kind: 'in' });
  });

  it('is not_working_day for a weekend, by the work week it is given', () => {
    expect(todayState({ ...base, today: SATURDAY })).toEqual({ kind: 'not_working_day', why: 'weekend' });
    expect(todayState({ ...base, today: SATURDAY, workWeek: ['mon', 'sat'] })).toEqual({ kind: 'not_in' });
    expect(todayState({ ...base, workWeek: ['tue'] })).toEqual({ kind: 'not_working_day', why: 'weekend' });
  });

  it('falls back to Monday to Friday for a week with no day in it, as the database does', () => {
    expect(todayState({ ...base, workWeek: [] })).toEqual({ kind: 'not_in' });
    expect(todayState({ ...base, today: SATURDAY, workWeek: [] })).toEqual({ kind: 'not_working_day', why: 'weekend' });
  });

  it('is not_working_day for a public holiday, with its name', () => {
    expect(todayState({ ...base, holidays: [holiday(MONDAY, 'Deepavali')] })).toEqual({
      kind: 'not_working_day',
      why: 'holiday',
      holiday: 'Deepavali',
    });
    expect(todayState({ ...base, holidays: [holiday('2026-10-13')] })).toEqual({ kind: 'not_in' });
  });

  it('says holiday, not weekend, for a holiday that falls on a weekend', () => {
    expect(todayState({ ...base, today: SATURDAY, holidays: [holiday(SATURDAY, 'Hari Raya')] })).toEqual({
      kind: 'not_working_day',
      why: 'holiday',
      holiday: 'Hari Raya',
    });
  });

  it('is on_leave for approved full-day leave covering today, and only the employee own', () => {
    expect(todayState({ ...base, leave: [leave()] })).toEqual({ kind: 'on_leave' });
    expect(todayState({ ...base, leave: [leave({ start_date: '2026-10-09', end_date: '2026-10-13' })] })).toEqual({ kind: 'on_leave' });
    expect(todayState({ ...base, leave: [leave({ employee_id: 'someone-else' })] })).toEqual({ kind: 'not_in' });
  });

  it('is not on_leave for leave that is pending, rejected, cancelled or over', () => {
    for (const status of ['pending', 'rejected', 'cancelled'] as const) {
      expect(todayState({ ...base, leave: [leave({ status })] })).toEqual({ kind: 'not_in' });
    }
    expect(todayState({ ...base, leave: [leave({ start_date: '2026-10-05', end_date: '2026-10-11' })] })).toEqual({ kind: 'not_in' });
    expect(todayState({ ...base, leave: [leave({ start_date: '2026-10-13', end_date: '2026-10-14' })] })).toEqual({ kind: 'not_in' });
  });

  it('is not on_leave on a half day: someone on a half day still comes to work', () => {
    const half = leave({ half_day: true, days: 0.5 });
    expect(todayState({ ...base, leave: [half] })).toEqual({ kind: 'not_in' });
    expect(todayState({ ...base, leave: [half], day: day({ clock_in: IN }) })).toEqual({ kind: 'in', since: '8:52 am' });
  });

  it('shows a clock-in that exists even on a day that is no longer a working day', () => {
    expect(todayState({ ...base, today: SATURDAY, day: day({ work_date: SATURDAY, clock_in: IN }) })).toMatchObject({ kind: 'in' });
  });

  it('puts a holiday ahead of leave, in the database order', () => {
    expect(todayState({ ...base, holidays: [holiday(MONDAY)], leave: [leave()] })).toMatchObject({ why: 'holiday' });
  });

  it('ignores a row for another day', () => {
    expect(todayState({ ...base, day: day({ work_date: '2026-10-09', clock_in: IN }) })).toEqual({ kind: 'not_in' });
  });
});

describe('todayLine', () => {
  it('says each state in a sentence', () => {
    expect(todayLine({ kind: 'not_in' })).toBe('Not clocked in yet');
    expect(todayLine({ kind: 'in', since: '8:52 am' })).toBe('In since 8:52 am');
    expect(todayLine({ kind: 'done', from: '8:52 am', to: '6:03 pm', worked: '9 h 11 min' })).toBe('8:52 am to 6:03 pm, 9 h 11 min');
    expect(todayLine({ kind: 'on_leave' })).toBe('You are on approved leave today.');
    expect(todayLine({ kind: 'not_working_day', why: 'weekend' })).toBe('Today is not a working day.');
    expect(todayLine({ kind: 'not_working_day', why: 'holiday', holiday: 'Deepavali' })).toBe('Today is a public holiday: Deepavali.');
    expect(todayLine({ kind: 'not_working_day', why: 'holiday' })).toBe('Today is a public holiday.');
    expect(todayLine({ kind: 'not_linked' })).toBe("Your account isn't linked to an employee record yet.");
  });

  it('writes hours and minutes the short way, and noon and midnight right', () => {
    const line = (from: string, to: string) => {
      const state = todayState({ ...base, day: day({ clock_in: from, clock_out: to }) });
      return todayLine(state);
    };
    expect(line('2026-10-12T01:00:00Z', '2026-10-12T09:00:00Z')).toBe('9:00 am to 5:00 pm, 8 h');
    expect(line('2026-10-12T01:00:00Z', '2026-10-12T01:45:00Z')).toBe('9:00 am to 9:45 am, 45 min');
    expect(line('2026-10-12T03:59:00Z', '2026-10-12T04:00:00Z')).toBe('11:59 am to 12:00 pm, 1 min');
    expect(line('2026-10-11T16:05:00Z', '2026-10-11T16:06:00Z')).toBe('12:05 am to 12:06 am, 1 min');
  });
});

describe('clockAction', () => {
  it('offers Clock in when not in, Clock out when in, and nothing otherwise', () => {
    expect(clockAction({ kind: 'not_in' })).toBe('in');
    expect(clockAction({ kind: 'in', since: '8:52 am' })).toBe('out');
    expect(clockAction({ kind: 'done', from: 'a', to: 'b', worked: 'c' })).toBeNull();
    expect(clockAction({ kind: 'on_leave' })).toBeNull();
    expect(clockAction({ kind: 'not_linked' })).toBeNull();
    expect(clockAction({ kind: 'not_working_day', why: 'weekend' })).toBeNull();
  });
});

describe('todayState: a clock-in later than now', () => {
  it('is not_in, not "in since", for a row from older data whose clock-in is still to come', () => {
    // IN is 08:52 in Kuala Lumpur.
    expect(todayState({ ...base, nowHm: '08:00', day: day({ clock_in: IN, status: 'present' }) })).toEqual({ kind: 'not_in' });
    expect(todayState({ ...base, nowHm: '08:52', day: day({ clock_in: IN, status: 'present' }) })).toEqual({ kind: 'in', since: '8:52 am' });
    expect(todayState({ ...base, nowHm: '09:30', day: day({ clock_in: IN, status: 'present' }) })).toEqual({ kind: 'in', since: '8:52 am' });
  });
});

describe('toCorrectionInput', () => {
  // Today is Monday 12 Oct; the form's `values` are for a past day unless a test says otherwise.
  const toCorrectionInput = (v: Parameters<typeof convertCorrection>[0], today = '2026-10-12', nowHm?: string) =>
    convertCorrection(v, today, nowHm);
  const values = {
    employee_id: 'e1',
    work_date: '2026-10-09',
    status: 'present' as const,
    clock_in: '09:00',
    clock_out: '18:00',
    note: '  Forgot to clock in ',
  };

  it('sends times as HH:MM and a trimmed note', () => {
    expect(toCorrectionInput(values)).toEqual({
      ok: true,
      input: { employee_id: 'e1', work_date: '2026-10-09', status: 'present', clock_in: '09:00', clock_out: '18:00', note: 'Forgot to clock in' },
    });
  });

  it('reads HH:MM:SS from a time field as HH:MM', () => {
    expect(toCorrectionInput({ ...values, clock_in: '09:00:00', clock_out: '18:30:45' })).toMatchObject({
      ok: true,
      input: { clock_in: '09:00', clock_out: '18:30' },
    });
  });

  it('lets a clock-out be left empty, and an empty note be none', () => {
    expect(toCorrectionInput({ ...values, status: 'late', clock_out: '', note: '  ' })).toMatchObject({
      ok: true,
      input: { status: 'late', clock_out: null, note: null },
    });
  });

  it('needs a clock-in for present and late', () => {
    for (const status of ['present', 'late'] as const) {
      const result = toCorrectionInput({ ...values, status, clock_in: '' });
      expect(result).toEqual({ ok: false, error: 'Enter the time they clocked in.' });
    }
  });

  it('refuses a clock-out that is not after the clock-in', () => {
    const error = 'The clock-out must be after the clock-in.';
    expect(toCorrectionInput({ ...values, clock_out: '09:00' })).toEqual({ ok: false, error });
    expect(toCorrectionInput({ ...values, clock_out: '08:59' })).toEqual({ ok: false, error });
    expect(toCorrectionInput({ ...values, clock_out: '09:01' }).ok).toBe(true);
  });

  it('drops the times of an absent or on-leave day, which take none', () => {
    for (const status of ['absent', 'on_leave'] as const) {
      expect(toCorrectionInput({ ...values, status })).toMatchObject({ ok: true, input: { status, clock_in: null, clock_out: null } });
    }
  });

  it('does not check times that an absent day drops', () => {
    expect(toCorrectionInput({ ...values, status: 'absent', clock_in: 'junk', clock_out: '99:99' }).ok).toBe(true);
  });

  it('refuses a time that is not a time', () => {
    expect(toCorrectionInput({ ...values, clock_in: '9am' })).toEqual({ ok: false, error: 'Enter the clock-in as a time, like 09:00.' });
    expect(toCorrectionInput({ ...values, clock_out: '25:00' })).toEqual({ ok: false, error: 'Enter the clock-out as a time, like 18:00.' });
  });

  it('refuses a missing, unreal, too old or future date', () => {
    expect(toCorrectionInput({ ...values, work_date: '' })).toEqual({ ok: false, error: 'Choose the day to correct.' });
    expect(toCorrectionInput({ ...values, work_date: '2026-02-31' })).toEqual({ ok: false, error: 'Choose a real date.' });
    expect(toCorrectionInput({ ...values, work_date: '1999-12-31' })).toEqual({ ok: false, error: 'The date cannot be before the year 2000.' });
    expect(toCorrectionInput({ ...values, work_date: '2026-10-13' }, '2026-10-12')).toEqual({ ok: false, error: 'The date cannot be in the future.' });
    expect(toCorrectionInput({ ...values, work_date: '2026-10-12' }, '2026-10-12').ok).toBe(true);
  });

  it('refuses a note over 500 characters, and no employee', () => {
    expect(toCorrectionInput({ ...values, note: 'x'.repeat(501) })).toEqual({ ok: false, error: 'Keep the note to 500 characters.' });
    expect(toCorrectionInput({ ...values, employee_id: '' })).toEqual({ ok: false, error: 'Choose an employee.' });
  });
});

describe('toHolidayInput', () => {
  it('trims the name and keeps the id (null to add)', () => {
    expect(toHolidayInput({ id: null, name: '  Deepavali ', holiday_date: '2026-11-08' })).toEqual({
      ok: true,
      input: { id: null, name: 'Deepavali', holiday_date: '2026-11-08' },
    });
    expect(toHolidayInput({ id: 'h1', name: 'Deepavali', holiday_date: '2026-11-09' })).toMatchObject({ ok: true, input: { id: 'h1' } });
    expect(toHolidayInput({ id: '', name: 'Deepavali', holiday_date: '2026-11-09' })).toMatchObject({ ok: true, input: { id: null } });
  });

  it('refuses an empty or long name and a bad date', () => {
    expect(toHolidayInput({ id: null, name: '   ', holiday_date: '2026-11-08' })).toEqual({ ok: false, error: 'Give the holiday a name.' });
    expect(toHolidayInput({ id: null, name: 'x'.repeat(121), holiday_date: '2026-11-08' })).toEqual({ ok: false, error: 'Keep the name to 120 characters.' });
    expect(toHolidayInput({ id: null, name: 'X', holiday_date: '' })).toEqual({ ok: false, error: 'Choose the date.' });
    expect(toHolidayInput({ id: null, name: 'X', holiday_date: '2026-13-01' })).toEqual({ ok: false, error: 'Choose a real date.' });
    expect(toHolidayInput({ id: null, name: 'X', holiday_date: '1999-01-01' })).toEqual({ ok: false, error: 'Choose a date from 2000 to 2100.' });
    expect(toHolidayInput({ id: null, name: 'X', holiday_date: '2101-01-01' })).toEqual({ ok: false, error: 'Choose a date from 2000 to 2100.' });
  });
});

describe('toSettingsInput', () => {
  const values = { work_week: ['fri', 'mon', 'tue'] as Weekday[], work_start_time: '08:30', late_grace_minutes: '10' };

  it('sends the week Monday first, the time as HH:MM and the grace as a number', () => {
    expect(toSettingsInput(values)).toEqual({
      ok: true,
      input: { work_week: ['mon', 'tue', 'fri'], work_start_time: '08:30', late_grace_minutes: 10 },
    });
  });

  it('reads HH:MM:SS as HH:MM and accepts 0 and 240', () => {
    expect(toSettingsInput({ ...values, work_start_time: '08:30:00', late_grace_minutes: '0' })).toMatchObject({
      ok: true,
      input: { work_start_time: '08:30', late_grace_minutes: 0 },
    });
    expect(toSettingsInput({ ...values, late_grace_minutes: '240' }).ok).toBe(true);
  });

  it('refuses an empty week and a duplicate weekday', () => {
    expect(toSettingsInput({ ...values, work_week: [] })).toEqual({ ok: false, error: 'Choose at least one working day.' });
    expect(toSettingsInput({ ...values, work_week: ['mon', 'mon'] })).toEqual({ ok: false, error: 'Each working day can be chosen only once.' });
  });

  it('refuses a start time that is not a time', () => {
    expect(toSettingsInput({ ...values, work_start_time: '' })).toEqual({ ok: false, error: 'Enter the start time, like 09:00.' });
    expect(toSettingsInput({ ...values, work_start_time: '24:00' })).toEqual({ ok: false, error: 'Enter the start time, like 09:00.' });
  });

  it('refuses a grace period that is out of range, fractional or not a number', () => {
    const error = 'Enter the grace period as whole minutes, from 0 to 240.';
    for (const grace of ['-1', '241', '1.5', '', 'ten', ' ', '1e2']) {
      expect(toSettingsInput({ ...values, late_grace_minutes: grace }), grace).toEqual({ ok: false, error });
    }
  });
});

describe('toCorrectionInput: a time that has not happened yet today', () => {
  const values = {
    employee_id: 'e1',
    work_date: '2026-10-12',
    status: 'present' as const,
    clock_in: '09:00',
    clock_out: '18:00',
    note: '',
  };
  const REFUSAL = 'That time has not happened yet. For today, leave clock-out empty if they are still at work.';

  it('refuses a clock-out later than now, before asking the database', () => {
    expect(convertCorrection(values, '2026-10-12', '10:00')).toEqual({ ok: false, error: REFUSAL });
  });

  it('refuses a clock-in later than now', () => {
    expect(convertCorrection({ ...values, clock_in: '11:00', clock_out: '' }, '2026-10-12', '10:00')).toEqual({ ok: false, error: REFUSAL });
  });

  it('accepts times up to and including now, and a clock-out left empty', () => {
    expect(convertCorrection({ ...values, clock_out: '10:00' }, '2026-10-12', '10:00').ok).toBe(true);
    expect(convertCorrection({ ...values, clock_out: '' }, '2026-10-12', '10:00').ok).toBe(true);
  });

  it('does not apply to a past day, or to a status without times', () => {
    expect(convertCorrection({ ...values, work_date: '2026-10-09' }, '2026-10-12', '10:00').ok).toBe(true);
    expect(convertCorrection({ ...values, status: 'absent', clock_in: '23:00', clock_out: '23:30' }, '2026-10-12', '10:00').ok).toBe(true);
  });
});
