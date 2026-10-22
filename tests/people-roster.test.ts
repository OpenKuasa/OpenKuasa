import { describe, expect, it } from 'vitest';
import {
  SHIFT_COLOR_CLASS,
  cellKey,
  cellValue,
  changedCells,
  copyLastWeek,
  hoursText,
  hoursWindowStart,
  mayEditHours,
  parseWeek,
  pickCell,
  readHours,
  shiftTimes,
  shiftTypeLabel,
  shiftTypeOf,
  toHoursInput,
  toShiftTypeInput,
  weekHref,
  weekNav,
} from '@/lib/people/roster';

const TODAY = '2026-10-09'; // Friday

describe('parseWeek', () => {
  it('snaps any real date to its Monday', () => {
    expect(parseWeek('2026-10-05', TODAY)).toBe('2026-10-05');
    expect(parseWeek('2026-10-11', TODAY)).toBe('2026-10-05');
    expect(parseWeek('2026-03-04', TODAY)).toBe('2026-03-02');
  });

  it('falls back to this week for anything else', () => {
    for (const raw of [undefined, '', 'next', '2026-02-30', '26-10-05', ['2026-03-02', '2026-03-09'], '1999-12-27', '2101-01-03']) {
      expect(parseWeek(raw as string | string[] | undefined, TODAY)).toBe('2026-10-05');
    }
  });
});

describe('weekNav and weekHref', () => {
  it('gives the neighbours and whether it is this week', () => {
    expect(weekNav('2026-10-05', TODAY)).toEqual({
      start: '2026-10-05', end: '2026-10-11', previous: '2026-09-28', next: '2026-10-12', current: '2026-10-05', isCurrent: true,
    });
    expect(weekNav('2026-09-28', TODAY).isCurrent).toBe(false);
  });

  it('drops the parameter for this week', () => {
    expect(weekHref('/people/timesheet', '2026-10-05', '2026-10-05')).toBe('/people/timesheet');
    expect(weekHref('/people/timesheet', '2026-09-28', '2026-10-05')).toBe('/people/timesheet?week=2026-09-28');
  });
});

describe('roster edits', () => {
  const saved = { [cellKey('a', '2026-10-05')]: 'morning', [cellKey('a', '2026-10-06')]: null } as const;

  it('shows an edit over what was saved', () => {
    expect(cellValue(saved, {}, cellKey('a', '2026-10-05'))).toBe('morning');
    expect(cellValue(saved, { [cellKey('a', '2026-10-05')]: null }, cellKey('a', '2026-10-05'))).toBeNull();
    expect(cellValue(saved, {}, cellKey('b', '2026-10-05'))).toBeNull();
  });

  it('drops an edit changed back to what was saved', () => {
    const key = cellKey('a', '2026-10-05');
    const once = pickCell(saved, {}, key, 'night');
    expect(once).toEqual({ [key]: 'night' });
    expect(pickCell(saved, once, key, 'morning')).toEqual({});
    expect(pickCell(saved, {}, cellKey('a', '2026-10-06'), null)).toEqual({});
  });

  it('lists the changed cells in a fixed order, clears as null', () => {
    expect(changedCells({ [cellKey('b', '2026-10-06')]: 'off', [cellKey('a', '2026-10-07')]: null })).toEqual([
      { employee_id: 'a', work_date: '2026-10-07', shift: null },
      { employee_id: 'b', work_date: '2026-10-06', shift: 'off' },
    ]);
  });
});

describe('copyLastWeek', () => {
  const week = '2026-10-05';
  const previous = {
    [cellKey('a', '2026-09-28')]: 'morning',
    [cellKey('a', '2026-09-29')]: 'night',
    [cellKey('a', '2026-09-30')]: 'off',
    [cellKey('b', '2026-10-04')]: 'night',
    [cellKey('z', '2026-09-28')]: 'morning',
  } as const;

  it('fills only empty cells, never overwriting a saved or edited shift', () => {
    const saved = { [cellKey('a', '2026-10-05')]: 'off' } as const;
    const edits = { [cellKey('a', '2026-10-06')]: 'morning' } as const;
    const result = copyLastWeek({ employeeIds: ['a', 'b'], weekStart: week, saved, edits, previous });
    expect(result.filled).toBe(2);
    expect(result.edits).toEqual({
      [cellKey('a', '2026-10-06')]: 'morning',
      [cellKey('a', '2026-10-07')]: 'off',
      [cellKey('b', '2026-10-11')]: 'night',
    });
  });

  it('copies nobody who is not listed, and nothing when last week was empty', () => {
    expect(copyLastWeek({ employeeIds: ['c'], weekStart: week, saved: {}, edits: {}, previous }).filled).toBe(0);
    expect(copyLastWeek({ employeeIds: ['a'], weekStart: week, saved: {}, edits: {}, previous: {} })).toEqual({ edits: {}, filled: 0 });
  });

  it('fills a cell an edit had cleared', () => {
    const saved = { [cellKey('a', '2026-10-05')]: 'off' } as const;
    const result = copyLastWeek({ employeeIds: ['a'], weekStart: week, saved, edits: { [cellKey('a', '2026-10-05')]: null }, previous });
    expect(result.edits[cellKey('a', '2026-10-05')]).toBe('morning');
  });
});

describe('hours', () => {
  it('opens last week\'s Monday to today for staff', () => {
    expect(hoursWindowStart(TODAY)).toBe('2026-09-28');
    expect(hoursWindowStart('2026-10-05')).toBe('2026-09-28');
    expect(hoursWindowStart('2026-10-11')).toBe('2026-09-28');
    const may = (date: string, over: Partial<{ isHr: boolean; isDemo: boolean; own: boolean }> = {}) =>
      mayEditHours({ date, today: TODAY, isHr: false, isDemo: false, own: true, ...over });
    expect(may('2026-09-28')).toBe(true);
    expect(may('2026-09-27')).toBe(false);
    expect(may('2026-10-09')).toBe(true);
    expect(may('2026-10-10')).toBe(false);
    expect(may('2026-10-05', { own: false })).toBe(false);
    expect(may('2025-01-01', { isHr: true, own: false })).toBe(true);
    expect(may('2026-10-10', { isHr: true })).toBe(false);
    expect(may('2026-10-05', { isDemo: true, isHr: true })).toBe(false);
  });

  it('reads an hours box', () => {
    expect(readHours('', 'Hours')).toEqual({ ok: true, value: null });
    expect(readHours(' 7.5 ', 'Hours')).toEqual({ ok: true, value: 7.5 });
    expect(readHours('24', 'Hours')).toEqual({ ok: true, value: 24 });
    expect(readHours('24.5', 'Hours')).toEqual({ ok: false, error: 'Hours cannot be more than 24.' });
    expect(readHours('7.3', 'Hours')).toEqual({ ok: false, error: 'Hours must be in steps of half an hour.' });
    expect(readHours('-1', 'Hours').ok).toBe(false);
    expect(readHours('abc', 'Billable hours')).toEqual({ ok: false, error: 'Billable hours must be a number of hours.' });
  });

  it('builds what the save sends', () => {
    expect(toHoursInput('e', '2026-10-05', '8', '2')).toEqual({
      ok: true, input: { employee_id: 'e', work_date: '2026-10-05', hours: 8, billable_hours: 2 },
    });
    expect(toHoursInput('e', '2026-10-05', '8', '')).toMatchObject({ ok: true, input: { hours: 8, billable_hours: null } });
    expect(toHoursInput('e', '2026-10-05', '', '')).toMatchObject({ ok: true, input: { hours: null, billable_hours: null } });
    expect(toHoursInput('e', '2026-10-05', '', '0')).toMatchObject({ ok: true, input: { hours: null, billable_hours: null } });
    expect(toHoursInput('e', '2026-10-05', '', '2')).toEqual({ ok: false, error: 'Enter the hours before the billable hours.' });
    expect(toHoursInput('e', '2026-10-05', '4', '4.5')).toEqual({ ok: false, error: 'Billable hours cannot be more than the hours.' });
  });

  it('shows a stored number in a box', () => {
    expect(hoursText(8)).toBe('8');
    expect(hoursText(7.5)).toBe('7.5');
    expect(hoursText(null)).toBe('');
  });
});

describe('shift types', () => {
  it('words times, overnight when the end is at or before the start', () => {
    expect(shiftTimes({ start_time: '09:00', end_time: '18:00' })).toBe('09:00–18:00');
    expect(shiftTimes({ start_time: '22:00', end_time: '06:00' })).toBe('22:00–06:00 (overnight)');
    expect(shiftTimes({ start_time: '08:00', end_time: '08:00' })).toBe('08:00–08:00 (overnight)');
    expect(shiftTimes({ start_time: null, end_time: null })).toBeNull();
    expect(shiftTypeLabel({ name: 'Night', start_time: '21:00', end_time: '06:00' })).toBe('Night · 21:00–06:00 (overnight)');
    expect(shiftTypeLabel({ name: 'Off', start_time: null, end_time: null })).toBe('Off');
  });

  it('reads a row: HH:MM times, an unknown colour as slate, archived from its stamp', () => {
    expect(shiftTypeOf({ id: 't', name: 'N', start_time: '21:00:00', end_time: '06:00:00', is_off: false, color: 'blue', archived_at: null })).toEqual({
      id: 't', name: 'N', start_time: '21:00', end_time: '06:00', is_off: false, color: 'blue', archived: false,
    });
    expect(shiftTypeOf({ id: 't', name: 'N', start_time: null, end_time: null, is_off: true, color: 'violet', archived_at: '2026-10-01T00:00:00Z' })).toMatchObject({
      color: 'slate', archived: true, start_time: null,
    });
  });

  it('has a palette with no purple, violet, fuchsia or indigo', () => {
    for (const cls of Object.values(SHIFT_COLOR_CLASS)) expect(cls).not.toMatch(/purple|violet|fuchsia|indigo/);
  });

  it('builds what the type form sends, or why not', () => {
    const base = { name: ' Night ', is_off: false, start_time: '21:00', end_time: '06:00', color: 'blue' as const };
    expect(toShiftTypeInput(base)).toEqual({ ok: true, input: { name: 'Night', is_off: false, start_time: '21:00', end_time: '06:00', color: 'blue' } });
    expect(toShiftTypeInput({ ...base, is_off: true })).toMatchObject({ ok: true, input: { start_time: null, end_time: null } });
    expect(toShiftTypeInput({ ...base, end_time: '' })).toEqual({ ok: false, error: 'Give both a start and an end time, or neither.' });
    expect(toShiftTypeInput({ ...base, start_time: '', end_time: '' })).toMatchObject({ ok: true, input: { start_time: null } });
    expect(toShiftTypeInput({ ...base, name: '' })).toEqual({ ok: false, error: 'Give the shift type a name.' });
    expect(toShiftTypeInput({ ...base, name: 'x'.repeat(41) })).toEqual({ ok: false, error: 'Keep the name to 40 characters.' });
  });
});
