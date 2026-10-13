import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATT_REFUSALS,
  attendanceSettingsInput,
  clockIn,
  clockOut,
  correctAttendance,
  correctAttendanceInput,
  deleteHoliday,
  holidayIdInput,
  saveAttendanceSettings,
  saveHoliday,
  saveHolidayInput,
} from '@/lib/people/attendance-writes';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = 'org-1';
const EMP = '22222222-2222-4222-8222-222222222222';
const HOLIDAY = '33333333-3333-4333-8333-333333333333';
const DAY = '44444444-4444-4444-8444-444444444444';
const ctxOf = (client: never) => ({ client, orgId: ORG });
const GENERIC = 'That change could not be saved. Please try again.';

afterEach(() => vi.restoreAllMocks());

const dayRow = (over: Record<string, unknown> = {}) => ({
  id: DAY,
  employee_id: EMP,
  work_date: '2026-10-12',
  clock_in: '2026-10-12T00:52:10.123+00:00',
  clock_out: null,
  status: 'present',
  ...over,
});

describe('ATT_REFUSALS', () => {
  it('has the spec sentence for every code the database raises', () => {
    expect(ATT_REFUSALS).toEqual({
      ATT_NOT_ALLOWED: "You can't make that change.",
      ATT_NOT_FOUND: 'That record was not found.',
      ATT_ALREADY_IN: 'You have already clocked in today.',
      ATT_NOT_IN: "You haven't clocked in today.",
      ATT_ALREADY_OUT: 'You have already clocked out today.',
      ATT_NOT_WORKING_DAY: 'Today is not a working day. Ask an owner or admin to record it if you worked.',
      ATT_ON_LEAVE: 'You are on approved leave today.',
      ATT_INACTIVE_EMPLOYEE: 'This employee record is inactive, so attendance cannot be clocked.',
      ATT_HOLIDAY_EXISTS: 'There is already a public holiday on that date.',
      ATT_BAD_INPUT:
        'Some of that was not accepted. A date or time may be in the future, a time may not be a time of day, a clock-out may not be after the clock-in, or a name or note may be too long or empty. Check it and try again.',
    });
  });
});

describe('the calls each function makes', () => {
  it('clocks in with the employee and nothing else, and hands back the day', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_clock_in': { data: dayRow() } });
    expect(await clockIn(ctxOf(client), { employee_id: EMP })).toEqual({
      ok: true,
      data: {
        id: DAY,
        work_date: '2026-10-12',
        clock_in: '2026-10-12T00:52:10.123+00:00',
        clock_out: null,
        status: 'present',
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('hr_clock_in');
    expect(calls[0].args).toEqual({ p_employee: EMP });
  });

  it('clocks out with the employee and nothing else', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_clock_out': { data: dayRow({ clock_out: '2026-10-12T10:03:00+00:00', status: 'late' }) },
    });
    const result = await clockOut(ctxOf(client), { employee_id: EMP });
    expect(result).toMatchObject({ ok: true, data: { clock_out: '2026-10-12T10:03:00+00:00', status: 'late' } });
    expect(calls[0].fn).toBe('hr_clock_out');
    expect(calls[0].args).toEqual({ p_employee: EMP });
  });

  it('never sends a time with a clock call, even when one is passed in', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_clock_in': { data: dayRow() } });
    await clockIn(ctxOf(client), { employee_id: EMP, clock_in: '08:00', work_date: '2026-10-01' } as never);
    expect(Object.keys(calls[0].args!)).toEqual(['p_employee']);
  });

  it('corrects a day with the database parameter names and a trimmed note', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_correct_attendance': { data: { ...dayRow(), corrected: true } },
    });
    const result = await correctAttendance(ctxOf(client), {
      employee_id: EMP,
      work_date: '2026-10-09',
      status: 'present',
      clock_in: '09:00',
      clock_out: '18:00',
      note: '  Forgot to clock in  ',
    });
    expect(result.ok).toBe(true);
    expect(calls[0].fn).toBe('hr_correct_attendance');
    expect(calls[0].args).toEqual({
      p_employee: EMP,
      p_work_date: '2026-10-09',
      p_status: 'present',
      p_clock_in: '09:00',
      p_clock_out: '18:00',
      p_note: 'Forgot to clock in',
    });
  });

  it('sends no times and no note as null', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_correct_attendance': { data: dayRow({ status: 'absent', clock_in: null }) } });
    await correctAttendance(ctxOf(client), { employee_id: EMP, work_date: '2026-10-09', status: 'absent', note: '   ' });
    expect(calls[0].args).toMatchObject({ p_clock_in: null, p_clock_out: null, p_note: null });
  });

  it('adds a holiday with the workspace from the context and a null id', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_save_holiday': { data: { id: HOLIDAY, name: 'Deepavali', holiday_date: '2026-11-08' } },
    });
    expect(await saveHoliday(ctxOf(client), { name: '  Deepavali ', holiday_date: '2026-11-08' })).toEqual({
      ok: true,
      data: { id: HOLIDAY, name: 'Deepavali', holiday_date: '2026-11-08' },
    });
    expect(calls[0].fn).toBe('hr_save_holiday');
    expect(calls[0].args).toEqual({ p_org: ORG, p_id: null, p_name: 'Deepavali', p_holiday_date: '2026-11-08' });
  });

  it('edits a holiday by its id, and ignores an org passed in the input', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_save_holiday': { data: { id: HOLIDAY, name: 'Deepavali', holiday_date: '2026-11-09' } },
    });
    await saveHoliday(ctxOf(client), { id: HOLIDAY, name: 'Deepavali', holiday_date: '2026-11-09', org_id: 'other' } as never);
    expect(calls[0].args).toEqual({ p_org: ORG, p_id: HOLIDAY, p_name: 'Deepavali', p_holiday_date: '2026-11-09' });
  });

  it('removes a holiday by its id alone', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_delete_holiday': { data: { id: HOLIDAY } } });
    expect(await deleteHoliday(ctxOf(client), { id: HOLIDAY })).toEqual({ ok: true, data: { id: HOLIDAY } });
    expect(calls[0].fn).toBe('hr_delete_holiday');
    expect(calls[0].args).toEqual({ p_id: HOLIDAY });
  });

  it('saves the settings, sends the week as given and gives the time back as HH:MM', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_save_attendance_settings': {
        data: { work_week: ['mon', 'tue', 'sat'], work_start_time: '08:30:00', late_grace_minutes: 10 },
      },
    });
    expect(
      await saveAttendanceSettings(ctxOf(client), { work_week: ['mon', 'tue', 'sat'], work_start_time: '08:30', late_grace_minutes: 10 }),
    ).toEqual({ ok: true, data: { work_week: ['mon', 'tue', 'sat'], work_start_time: '08:30', late_grace_minutes: 10 } });
    expect(calls[0].fn).toBe('hr_save_attendance_settings');
    expect(calls[0].args).toEqual({
      p_org: ORG,
      p_work_week: ['mon', 'tue', 'sat'],
      p_work_start_time: '08:30',
      p_late_grace_minutes: 10,
    });
  });
});

describe('every refusal code reaches the caller as its sentence', () => {
  const cases: [string, string, (c: never) => Promise<{ ok: boolean; error?: string }>][] = [
    ['hr_clock_in', 'clockIn', (c) => clockIn(ctxOf(c), { employee_id: EMP })],
    ['hr_clock_out', 'clockOut', (c) => clockOut(ctxOf(c), { employee_id: EMP })],
    [
      'hr_correct_attendance',
      'correctAttendance',
      (c) => correctAttendance(ctxOf(c), { employee_id: EMP, work_date: '2026-10-09', status: 'absent' }),
    ],
    ['hr_save_holiday', 'saveHoliday', (c) => saveHoliday(ctxOf(c), { name: 'X', holiday_date: '2026-11-08' })],
    ['hr_delete_holiday', 'deleteHoliday', (c) => deleteHoliday(ctxOf(c), { id: HOLIDAY })],
    [
      'hr_save_attendance_settings',
      'saveAttendanceSettings',
      (c) => saveAttendanceSettings(ctxOf(c), { work_week: ['mon'], work_start_time: '09:00', late_grace_minutes: 15 }),
    ],
  ];

  for (const [rpc, name, run] of cases) {
    it.each(Object.entries(ATT_REFUSALS))(`${name}: %s`, async (code, sentence) => {
      const { client } = fakeSupabase({ [`rpc.${rpc}`]: { error: { code: 'P0001', message: code } } });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await run(client)).toEqual({ ok: false, error: sentence });
      expect(logged).not.toHaveBeenCalled();
    });
  }

  it('answers a code that begins the message, with anything after it ignored', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_clock_in': { error: { message: 'ATT_ALREADY_IN: more text' } } });
    expect(await clockIn(ctxOf(client), { employee_id: EMP })).toEqual({ ok: false, error: ATT_REFUSALS.ATT_ALREADY_IN });
  });

  it('does not treat a code that merely appears inside a message as a refusal', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_clock_in': { error: { message: 'oops ATT_ALREADY_IN' } } });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await clockIn(ctxOf(client), { employee_id: EMP })).toEqual({ ok: false, error: GENERIC });
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('does not treat a bare prefix as a code', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_clock_in': { error: { message: 'ATT_' } } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await clockIn(ctxOf(client), { employee_id: EMP })).toEqual({ ok: false, error: GENERIC });
  });
});

describe('an unknown failure', () => {
  it('gives the generic sentence and logs the code and message only, never what was typed', async () => {
    const { client } = fakeSupabase({
      'rpc.hr_correct_attendance': { error: { code: 'XX000', message: 'internal error' } },
      'rpc.hr_save_holiday': { error: { code: 'XX000', message: 'internal error' } },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const note = 'SECRET-NOTE-TEXT';
    const name = 'SECRET-HOLIDAY-NAME';
    expect(
      await correctAttendance(ctxOf(client), { employee_id: EMP, work_date: '2026-10-09', status: 'absent', note }),
    ).toEqual({ ok: false, error: GENERIC });
    expect(await saveHoliday(ctxOf(client), { name, holiday_date: '2026-11-08' })).toEqual({ ok: false, error: GENERIC });
    const text = JSON.stringify(logged.mock.calls);
    expect(text).toContain('internal error');
    expect(text).not.toContain(note);
    expect(text).not.toContain(name);
  });

  it('gives the generic sentence for a reply that is not the promised shape', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_clock_in': { data: { id: DAY, status: 'sleeping' } } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await clockIn(ctxOf(client), { employee_id: EMP })).toEqual({ ok: false, error: GENERIC });
  });

  it('gives the generic sentence for an empty reply', async () => {
    const { client } = fakeSupabase();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await clockOut(ctxOf(client), { employee_id: EMP })).toEqual({ ok: false, error: GENERIC });
  });
});

describe('the inputs', () => {
  it('refuse a bad input in words, before any call', async () => {
    const { client, calls } = fakeSupabase();
    const bad = [
      await clockIn(ctxOf(client), { employee_id: 'nope' }),
      await correctAttendance(ctxOf(client), { employee_id: EMP, work_date: '2026-02-31', status: 'absent' }),
      await correctAttendance(ctxOf(client), { employee_id: EMP, work_date: '1999-12-31', status: 'absent' }),
      await correctAttendance(ctxOf(client), { employee_id: EMP, work_date: '2026-10-09', status: 'asleep' as never }),
      await correctAttendance(ctxOf(client), { employee_id: EMP, work_date: '2026-10-09', status: 'present', clock_in: '9am' }),
      await correctAttendance(ctxOf(client), { employee_id: EMP, work_date: '2026-10-09', status: 'present', clock_in: '24:00' }),
      await correctAttendance(ctxOf(client), { employee_id: EMP, work_date: '2026-10-09', status: 'absent', note: 'x'.repeat(501) }),
      await saveHoliday(ctxOf(client), { name: '   ', holiday_date: '2026-11-08' }),
      await saveHoliday(ctxOf(client), { name: 'x'.repeat(121), holiday_date: '2026-11-08' }),
      await saveHoliday(ctxOf(client), { name: 'X', holiday_date: '1999-01-01' }),
      await saveHoliday(ctxOf(client), { name: 'X', holiday_date: '2101-01-01' }),
      await saveHoliday(ctxOf(client), { id: 'nope', name: 'X', holiday_date: '2026-11-08' }),
      await deleteHoliday(ctxOf(client), { id: 'nope' }),
      await saveAttendanceSettings(ctxOf(client), { work_week: [], work_start_time: '09:00', late_grace_minutes: 15 }),
      await saveAttendanceSettings(ctxOf(client), { work_week: ['mon', 'mon'], work_start_time: '09:00', late_grace_minutes: 15 }),
      await saveAttendanceSettings(ctxOf(client), { work_week: ['mon'], work_start_time: '9:00', late_grace_minutes: 15 }),
      await saveAttendanceSettings(ctxOf(client), { work_week: ['mon'], work_start_time: '09:00', late_grace_minutes: 241 }),
      await saveAttendanceSettings(ctxOf(client), { work_week: ['mon'], work_start_time: '09:00', late_grace_minutes: -1 }),
      await saveAttendanceSettings(ctxOf(client), { work_week: ['mon'], work_start_time: '09:00', late_grace_minutes: 1.5 }),
      await saveAttendanceSettings(ctxOf(client), { work_week: ['funday' as never], work_start_time: '09:00', late_grace_minutes: 15 }),
    ];
    for (const result of bad) {
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error.length).toBeGreaterThan(5);
    }
    expect(calls).toEqual([]);
  });

  it('accept the edges: grace 0 and 240, a full week, a holiday on the first and last allowed dates', () => {
    const week = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    expect(attendanceSettingsInput.safeParse({ work_week: week, work_start_time: '00:00', late_grace_minutes: 0 }).success).toBe(true);
    expect(attendanceSettingsInput.safeParse({ work_week: ['sun'], work_start_time: '23:59', late_grace_minutes: 240 }).success).toBe(true);
    expect(saveHolidayInput.safeParse({ name: 'X', holiday_date: '2000-01-01' }).success).toBe(true);
    expect(saveHolidayInput.safeParse({ name: 'X', holiday_date: '2100-12-31' }).success).toBe(true);
    expect(saveHolidayInput.safeParse({ id: null, name: 'X', holiday_date: '2026-11-08' }).success).toBe(true);
    expect(holidayIdInput.safeParse({ id: HOLIDAY }).success).toBe(true);
  });

  it('take times on a correction only as HH:MM, nullable and optional', () => {
    const base = { employee_id: EMP, work_date: '2026-10-09', status: 'present' as const };
    expect(correctAttendanceInput.safeParse({ ...base, clock_in: '09:00', clock_out: null }).success).toBe(true);
    expect(correctAttendanceInput.safeParse({ ...base, clock_in: '09:00:00' }).success).toBe(false);
    expect(correctAttendanceInput.safeParse({ ...base, clock_in: '09:60' }).success).toBe(false);
  });

  it('accept an id the database makes that is not an RFC-versioned uuid', () => {
    expect(holidayIdInput.safeParse({ id: 'dea97d89-a5b6-f264-bd42-c6df73f664a7' }).success).toBe(true);
  });
});
