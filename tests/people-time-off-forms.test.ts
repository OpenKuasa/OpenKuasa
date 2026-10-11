import { describe, expect, it } from 'vitest';
import { TIME_OFF_FORM_DEFAULTS, toTimeOffInput } from '@/lib/people/time-off-forms';

const filled = { ...TIME_OFF_FORM_DEFAULTS, off_date: '2026-10-20', start_time: '09:00', end_time: '11:30' };

describe('toTimeOffInput', () => {
  it('sends the date, the times and a trimmed reason, with no employee', () => {
    expect(toTimeOffInput({ ...filled, reason: '  dentist  ' })).toEqual({
      ok: true,
      input: { off_date: '2026-10-20', start_time: '09:00', end_time: '11:30', reason: 'dentist' },
    });
  });

  it('sends a blank reason as null', () => {
    const result = toTimeOffInput({ ...filled, reason: '   ' });
    expect(result.ok && result.input.reason).toBeNull();
  });

  it('asks for a date and both times when they are empty', () => {
    expect(toTimeOffInput(TIME_OFF_FORM_DEFAULTS)).toEqual({ ok: false, error: 'Choose the day.' });
    expect(toTimeOffInput({ ...filled, start_time: '' })).toEqual({ ok: false, error: 'Choose the start and end times.' });
    expect(toTimeOffInput({ ...filled, end_time: '' })).toEqual({ ok: false, error: 'Choose the start and end times.' });
  });

  it('refuses a date that does not exist', () => {
    expect(toTimeOffInput({ ...filled, off_date: '2026-02-31' })).toEqual({ ok: false, error: 'Choose a real date.' });
  });

  it('refuses times that are not HH:MM', () => {
    expect(toTimeOffInput({ ...filled, start_time: '9am' }).ok).toBe(false);
    expect(toTimeOffInput({ ...filled, end_time: '25:00' }).ok).toBe(false);
  });

  it('refuses an end that is not after the start', () => {
    const expected = { ok: false, error: 'The end time must be after the start time.' };
    expect(toTimeOffInput({ ...filled, end_time: '09:00' })).toEqual(expected);
    expect(toTimeOffInput({ ...filled, end_time: '08:00' })).toEqual(expected);
  });

  it('refuses a reason over 500 characters', () => {
    expect(toTimeOffInput({ ...filled, reason: 'x'.repeat(501) })).toEqual({
      ok: false,
      error: 'Keep the reason to 500 characters.',
    });
    expect(toTimeOffInput({ ...filled, reason: 'x'.repeat(500) }).ok).toBe(true);
  });
});
