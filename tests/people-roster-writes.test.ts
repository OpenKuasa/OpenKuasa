import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROSTER_REFUSALS,
  archiveShiftType,
  ensureShiftTypes,
  saveHours,
  saveHoursInput,
  saveRoster,
  saveRosterInput,
  saveShiftType,
  saveShiftTypeInput,
} from '@/lib/people/roster-writes';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = 'org-1';
const EMP = '22222222-2222-4222-8222-222222222222';
const EMP2 = '33333333-3333-4333-8333-333333333333';
const TYPE = '44444444-4444-4444-8444-444444444444';
const ctxOf = (client: never) => ({ client, orgId: ORG });
const GENERIC = 'That change could not be saved. Please try again.';

afterEach(() => vi.restoreAllMocks());

describe('ROSTER_REFUSALS', () => {
  it('has a sentence for every code the two functions raise', () => {
    expect(Object.keys(ROSTER_REFUSALS).sort()).toEqual([
      'HOURS_BAD_INPUT', 'HOURS_FUTURE_DAY', 'HOURS_INACTIVE_EMPLOYEE', 'HOURS_NOT_ALLOWED', 'HOURS_OUTSIDE_WINDOW',
      'ROSTER_ARCHIVED_SHIFT_TYPE', 'ROSTER_BAD_EMPLOYEE', 'ROSTER_BAD_INPUT', 'ROSTER_BAD_SHIFT_TYPE', 'ROSTER_INACTIVE_EMPLOYEE',
      'ROSTER_NOT_ALLOWED', 'ROSTER_NOT_MONDAY',
      'SHIFT_TYPE_ARCHIVED', 'SHIFT_TYPE_BAD_INPUT', 'SHIFT_TYPE_EXISTS', 'SHIFT_TYPE_NOT_ALLOWED', 'SHIFT_TYPE_NOT_FOUND',
    ]);
  });
});

describe('saveRosterInput', () => {
  const ok = { week_start: '2026-10-05', cells: [{ employee_id: EMP, work_date: '2026-10-11', shift_type_id: TYPE }] };
  it('takes a Monday and cells in that week, a null shift clearing a cell', () => {
    expect(saveRosterInput.safeParse(ok).success).toBe(true);
    expect(saveRosterInput.safeParse({ ...ok, cells: [{ employee_id: EMP, work_date: '2026-10-05', shift_type_id: null }] }).success).toBe(true);
    expect(saveRosterInput.safeParse({ week_start: '2026-10-05', cells: [] }).success).toBe(true);
  });
  it('refuses a week that is not a Monday, a cell outside it, a type that is not an id, a bad employee id', () => {
    const issue = (v: unknown) => saveRosterInput.safeParse(v).error?.issues[0]?.message;
    expect(issue({ ...ok, week_start: '2026-10-06' })).toBe('A roster week starts on a Monday.');
    expect(issue({ ...ok, cells: [{ employee_id: EMP, work_date: '2026-10-12', shift_type_id: TYPE }] })).toBe('Every cell must be in the week being saved.');
    expect(saveRosterInput.safeParse({ ...ok, cells: [{ employee_id: EMP, work_date: '2026-10-05', shift_type_id: 'morning' }] }).success).toBe(false);
    expect(saveRosterInput.safeParse({ ...ok, cells: [{ employee_id: 'x', work_date: '2026-10-05', shift_type_id: TYPE }] }).success).toBe(false);
    expect(saveRosterInput.safeParse({ ...ok, cells: [{ employee_id: EMP, work_date: '2026-10-05' }] }).success).toBe(false);
  });
});

describe('saveRoster', () => {
  it('sends the session workspace, the week and the cells, and reads the counts', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_roster': { data: { week: '2026-10-05', saved: 2, removed: 1 } } });
    const cells = [
      { employee_id: EMP, work_date: '2026-10-05', shift_type_id: TYPE },
      { employee_id: EMP2, work_date: '2026-10-06', shift_type_id: null },
    ];
    const result = await saveRoster(ctxOf(client as never), { week_start: '2026-10-05', cells });
    expect(result).toEqual({ ok: true, data: { week: '2026-10-05', saved: 2, removed: 1 } });
    expect(calls[0]).toMatchObject({ op: 'rpc', fn: 'hr_save_roster', args: { p_org: ORG, p_week: '2026-10-05', p_cells: cells } });
  });

  it('never sends a workspace from the input', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_roster': { data: { week: '2026-10-05', saved: 0, removed: 0 } } });
    await saveRoster(ctxOf(client as never), { week_start: '2026-10-05', cells: [], org_id: 'other' } as never);
    expect(calls[0].args).toEqual({ p_org: ORG, p_week: '2026-10-05', p_cells: [] });
  });

  it('turns a coded refusal into its sentence, and anything else into the generic one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const code of ['ROSTER_NOT_ALLOWED', 'ROSTER_BAD_EMPLOYEE', 'ROSTER_INACTIVE_EMPLOYEE', 'ROSTER_ARCHIVED_SHIFT_TYPE', 'ROSTER_BAD_SHIFT_TYPE']) {
      const { client } = fakeSupabase({ 'rpc.hr_save_roster': { error: { code: 'P0001', message: code } } });
      expect(await saveRoster(ctxOf(client as never), { week_start: '2026-10-05', cells: [] })).toEqual({ ok: false, error: ROSTER_REFUSALS[code] });
    }
    const { client } = fakeSupabase({ 'rpc.hr_save_roster': { error: { code: '23503', message: 'fk violation' } } });
    expect(await saveRoster(ctxOf(client as never), { week_start: '2026-10-05', cells: [] })).toEqual({ ok: false, error: GENERIC });
    const odd = fakeSupabase({ 'rpc.hr_save_roster': { data: { week: '2026-10-05' } } });
    expect(await saveRoster(ctxOf(odd.client as never), { week_start: '2026-10-05', cells: [] })).toEqual({ ok: false, error: GENERIC });
  });

  it('refuses bad input before any call', async () => {
    const { client, calls } = fakeSupabase();
    expect(await saveRoster(ctxOf(client as never), { week_start: '2026-10-07', cells: [] })).toEqual({ ok: false, error: 'A roster week starts on a Monday.' });
    expect(calls).toEqual([]);
  });
});

describe('saveHoursInput', () => {
  const issue = (v: unknown) => saveHoursInput.safeParse(v).error?.issues[0]?.message;
  const base = { employee_id: EMP, work_date: '2026-10-05' };
  it('takes hours and billable in half hours, billable no more than hours; no hours clears', () => {
    expect(saveHoursInput.safeParse({ ...base, hours: 8, billable_hours: 8 }).success).toBe(true);
    expect(saveHoursInput.safeParse({ ...base, hours: 0, billable_hours: null }).success).toBe(true);
    expect(saveHoursInput.safeParse({ ...base, hours: null, billable_hours: null }).success).toBe(true);
  });
  it('refuses the rest with a sentence', () => {
    expect(issue({ ...base, hours: 24.5, billable_hours: null })).toBe('Hours cannot be more than 24.');
    expect(issue({ ...base, hours: 7.3, billable_hours: null })).toBe('Hours must be in steps of half an hour.');
    expect(issue({ ...base, hours: -1, billable_hours: null })).toBe('Hours cannot be below 0.');
    expect(issue({ ...base, hours: 4, billable_hours: 4.5 })).toBe('Billable hours cannot be more than the hours.');
    expect(issue({ ...base, hours: null, billable_hours: 1 })).toBe('Enter the hours before the billable hours.');
    expect(saveHoursInput.safeParse({ ...base, work_date: '2026-02-30', hours: 1, billable_hours: null }).success).toBe(false);
  });
});

describe('saveHours', () => {
  it('saves a day and reads the entry back', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_save_hours': { data: { employee_id: EMP, work_date: '2026-10-05', hours: 7.5, billable_hours: 2 } },
    });
    const result = await saveHours(ctxOf(client as never), { employee_id: EMP, work_date: '2026-10-05', hours: 7.5, billable_hours: 2 });
    expect(result).toEqual({ ok: true, data: { employee_id: EMP, work_date: '2026-10-05', hours: 7.5, billable_hours: 2 } });
    expect(calls[0]).toMatchObject({ fn: 'hr_save_hours', args: { p_employee: EMP, p_work_date: '2026-10-05', p_hours: 7.5, p_billable: 2 } });
  });

  it('clears a day with nulls', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_save_hours': { data: { employee_id: EMP, work_date: '2026-10-05', hours: null, billable_hours: null } },
    });
    const result = await saveHours(ctxOf(client as never), { employee_id: EMP, work_date: '2026-10-05', hours: null, billable_hours: null });
    expect(result).toEqual({ ok: true, data: { employee_id: EMP, work_date: '2026-10-05', hours: null, billable_hours: null } });
    expect(calls[0].args).toEqual({ p_employee: EMP, p_work_date: '2026-10-05', p_hours: null, p_billable: null });
  });

  it('gives the server\'s sentence for a refusal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const code of ['HOURS_OUTSIDE_WINDOW', 'HOURS_NOT_ALLOWED', 'HOURS_FUTURE_DAY', 'HOURS_INACTIVE_EMPLOYEE', 'HOURS_BAD_INPUT']) {
      const { client } = fakeSupabase({ 'rpc.hr_save_hours': { error: { code: 'P0001', message: code } } });
      expect(await saveHours(ctxOf(client as never), { employee_id: EMP, work_date: '2026-10-05', hours: 1, billable_hours: null })).toEqual({
        ok: false, error: ROSTER_REFUSALS[code],
      });
    }
    const { client } = fakeSupabase({ 'rpc.hr_save_hours': { error: { message: 'ATT_NOT_ALLOWED' } } });
    expect(await saveHours(ctxOf(client as never), { employee_id: EMP, work_date: '2026-10-05', hours: 1, billable_hours: null })).toEqual({ ok: false, error: GENERIC });
  });
});

describe('shift types', () => {
  const row = { id: TYPE, name: 'Night', start_time: '21:00:00', end_time: '06:00:00', is_off: false, color: 'blue', archived: false };

  it('takes a name, a palette colour, and both times or neither; an off type none', () => {
    const ok = { name: 'Night', is_off: false, start_time: '21:00', end_time: '06:00', color: 'blue' };
    expect(saveShiftTypeInput.safeParse(ok).success).toBe(true);
    expect(saveShiftTypeInput.safeParse({ ...ok, start_time: null, end_time: null }).success).toBe(true);
    const issue = (v: unknown) => saveShiftTypeInput.safeParse(v).error?.issues[0]?.message;
    expect(issue({ ...ok, end_time: null })).toBe('Give both a start and an end time, or neither.');
    expect(issue({ ...ok, is_off: true })).toBe('An off type has no times.');
    expect(issue({ ...ok, name: ' ' })).toBe('Give the shift type a name.');
    expect(issue({ ...ok, start_time: '25:00' })).toBe('Times must be times of day, as HH:MM.');
    for (const color of ['purple', 'violet', 'fuchsia', 'indigo']) expect(saveShiftTypeInput.safeParse({ ...ok, color }).success, color).toBe(false);
  });

  it('saves a type in the session workspace and reads it back with HH:MM times', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_shift_type': { data: row } });
    const result = await saveShiftType(ctxOf(client as never), { name: ' Night ', is_off: false, start_time: '21:00', end_time: '06:00', color: 'blue' });
    expect(result).toEqual({ ok: true, data: { ...row, start_time: '21:00', end_time: '06:00' } });
    expect(calls[0].args).toEqual({
      p_org: ORG, p_id: null, p_name: 'Night', p_start_time: '21:00', p_end_time: '06:00', p_is_off: false, p_color: 'blue',
    });
  });

  it('archives and brings back, and gives the sentence for a refusal', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_archive_shift_type': { data: { ...row, archived: true } } });
    expect(await archiveShiftType(ctxOf(client as never), { id: TYPE, archived: true })).toMatchObject({ ok: true, data: { archived: true } });
    expect(calls[0].args).toEqual({ p_id: TYPE, p_archived: true });
    for (const code of ['SHIFT_TYPE_EXISTS', 'SHIFT_TYPE_NOT_FOUND', 'SHIFT_TYPE_ARCHIVED', 'SHIFT_TYPE_NOT_ALLOWED']) {
      const failing = fakeSupabase({ 'rpc.hr_save_shift_type': { error: { code: 'P0001', message: code } } });
      expect(await saveShiftType(ctxOf(failing.client as never), { name: 'X', is_off: true, start_time: null, end_time: null, color: 'stone' })).toEqual({
        ok: false, error: ROSTER_REFUSALS[code],
      });
    }
  });

  it('asks for the defaults, and reads a failure as none added', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_ensure_shift_types': { data: { added: 3 } } });
    expect(await ensureShiftTypes(ctxOf(client as never))).toBe(3);
    expect(calls[0].args).toEqual({ p_org: ORG });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = fakeSupabase({ 'rpc.hr_ensure_shift_types': { error: { code: 'P0001', message: 'SHIFT_TYPE_NOT_ALLOWED' } } });
    expect(await ensureShiftTypes(ctxOf(failing.client as never))).toBe(0);
  });
});
