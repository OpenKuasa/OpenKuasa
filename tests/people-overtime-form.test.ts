import { describe, expect, it } from 'vitest';
import {
  NO_SALARY_NOTE,
  overtimeFormDefaults,
  overtimePreviewLines,
  toOvertimeInput,
  toOvertimePreviewInput,
} from '@/lib/people/overtime-forms';

const TODAY = '2026-10-11';
const filled = { ...overtimeFormDefaults(TODAY), work_date: '2026-10-09', hours: '2.5' };

describe('overtimeFormDefaults', () => {
  it('starts dated today with no hours', () => {
    expect(overtimeFormDefaults(TODAY)).toEqual({ work_date: TODAY, hours: '', reason: '' });
  });
});

describe('toOvertimeInput', () => {
  it('sends the date, the hours as a number and a trimmed reason, with no employee', () => {
    expect(toOvertimeInput({ ...filled, reason: '  Month end  ' }, TODAY)).toEqual({
      ok: true,
      input: { work_date: '2026-10-09', hours: 2.5, reason: 'Month end' },
    });
  });

  it('sends a blank reason as null', () => {
    const result = toOvertimeInput({ ...filled, reason: '   ' });
    expect(result.ok && result.input.reason).toBeNull();
  });

  it.each([['0.5', 0.5], ['1', 1], ['24', 24], [' 3 ', 3]])('accepts %j hours', (hours, expected) => {
    const result = toOvertimeInput({ ...filled, hours });
    expect(result.ok && result.input.hours).toBe(expected);
  });

  it.each([
    ['no date', { work_date: '' }, 'Choose the date worked.'],
    ['a date that does not exist', { work_date: '2026-13-01' }, 'Choose a real date.'],
    ['a date before 2000', { work_date: '1999-01-01' }, 'The date cannot be before the year 2000.'],
    ['a date in the future', { work_date: '2026-10-12' }, 'The date cannot be in the future.'],
    ['no hours', { hours: '' }, 'Enter the hours worked.'],
    ['hours that are text', { hours: 'two' }, 'Enter the hours as a number, like 2 or 2.5.'],
    ['negative hours', { hours: '-1' }, 'Enter the hours as a number, like 2 or 2.5.'],
    ['less than half an hour', { hours: '0.25' }, 'Overtime is at least half an hour.'],
    ['zero hours', { hours: '0' }, 'Overtime is at least half an hour.'],
    ['more than 24 hours', { hours: '24.5' }, 'Overtime cannot be more than 24 hours in a day.'],
    ['hours not in halves', { hours: '1.3' }, 'Use whole or half hours.'],
    ['a reason over 500 characters', { reason: 'x'.repeat(501) }, 'Keep the reason to 500 characters.'],
  ])('says what is wrong with %s', (_name, over, error) => {
    expect(toOvertimeInput({ ...filled, ...over }, TODAY)).toEqual({ ok: false, error });
  });
});

describe('toOvertimePreviewInput', () => {
  it('is the same without the reason', () => {
    expect(toOvertimePreviewInput({ ...filled, reason: 'private' }, TODAY)).toEqual({ work_date: '2026-10-09', hours: 2.5 });
  });

  it('is null until the date and hours can be worked out', () => {
    expect(toOvertimePreviewInput({ ...filled, hours: '' })).toBeNull();
    expect(toOvertimePreviewInput({ ...filled, hours: '1.3' })).toBeNull();
    expect(toOvertimePreviewInput({ ...filled, work_date: '' })).toBeNull();
  });

  it('is not held up by a reason that is too long', () => {
    expect(toOvertimePreviewInput({ ...filled, reason: 'x'.repeat(600) })).not.toBeNull();
  });
});

describe('overtimePreviewLines', () => {
  it('names the kind of day with its multiplier, and the amount in Ringgit, as the database gave them', () => {
    expect(overtimePreviewLines({ day_kind: 'rest_day', multiplier: 2, hourly_rate_cents: 2404, amount_cents: 12020 })).toEqual({
      kind: 'Rest day, paid at 2 times',
      amount: 'RM 120.20',
      note: null,
    });
    expect(overtimePreviewLines({ day_kind: 'weekday', multiplier: 1.5, hourly_rate_cents: 2404, amount_cents: 9015 }).kind).toBe(
      'Weekday, paid at 1.5 times',
    );
    expect(overtimePreviewLines({ day_kind: 'public_holiday', multiplier: 3, hourly_rate_cents: 100, amount_cents: 300 }).kind).toBe(
      'Public holiday, paid at 3 times',
    );
  });

  it('says the amount is not calculated, and why, when there is no salary', () => {
    expect(overtimePreviewLines({ day_kind: 'weekday', multiplier: 1.5, hourly_rate_cents: null, amount_cents: null })).toEqual({
      kind: 'Weekday, paid at 1.5 times',
      amount: 'Not calculated',
      note: NO_SALARY_NOTE,
    });
  });

  it('shows RM 0.00 for a calculated amount of zero rather than "Not calculated"', () => {
    expect(overtimePreviewLines({ day_kind: 'weekday', multiplier: 1.5, hourly_rate_cents: 0, amount_cents: 0 }).amount).toBe('RM 0.00');
  });
});
