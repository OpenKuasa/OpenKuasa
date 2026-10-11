import { describe, expect, it } from 'vitest';
import { LEAVE_FORM_DEFAULTS, previewLines, toLeaveInput, toPreviewInput } from '@/lib/people/leave-forms';
import type { LeavePreview } from '@/lib/people/leave';

const filled = { ...LEAVE_FORM_DEFAULTS, start_date: '2026-10-20', end_date: '2026-10-22' };

describe('toLeaveInput', () => {
  it('sends the kind, the dates and a trimmed reason, with no employee', () => {
    expect(toLeaveInput({ ...filled, reason: '  family  ' })).toEqual({
      ok: true,
      input: { leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22', half_day: false, reason: 'family' },
    });
  });

  it('sends a blank reason as null', () => {
    const result = toLeaveInput({ ...filled, reason: '   ' });
    expect(result.ok && result.input.reason).toBeNull();
  });

  it('keeps a half day for a single date', () => {
    const result = toLeaveInput({ ...filled, end_date: '2026-10-20', half_day: true });
    expect(result.ok && result.input.half_day).toBe(true);
  });

  it('forces the half day off when the dates differ', () => {
    const result = toLeaveInput({ ...filled, half_day: true });
    expect(result.ok && result.input.half_day).toBe(false);
  });

  it.each([
    ['no dates', { start_date: '', end_date: '' }, 'Choose the first and last day.'],
    ['a missing last day', { end_date: '' }, 'Choose the first and last day.'],
    ['a date that does not exist', { end_date: '2026-02-31' }, 'Choose real dates.'],
    ['a last day before the first', { start_date: '2026-10-22', end_date: '2026-10-20' }, 'The last day cannot be before the first day.'],
    ['a reason over 500 characters', { reason: 'x'.repeat(501) }, 'Keep the reason to 500 characters.'],
  ])('says what is wrong with %s', (_name, over, error) => {
    expect(toLeaveInput({ ...filled, ...over })).toEqual({ ok: false, error });
  });
});

describe('toPreviewInput', () => {
  it('is the same without the reason', () => {
    expect(toPreviewInput({ ...filled, reason: 'private' })).toEqual({
      leave_type: 'annual',
      start_date: '2026-10-20',
      end_date: '2026-10-22',
      half_day: false,
    });
  });
  it('is null until the dates can be counted', () => {
    expect(toPreviewInput(LEAVE_FORM_DEFAULTS)).toBeNull();
    expect(toPreviewInput({ ...filled, end_date: '2026-10-19' })).toBeNull();
  });
});

const preview = (over: Partial<LeavePreview> = {}): LeavePreview => ({
  days: 3,
  over_by: 0,
  years: [{ year: 2026, days: 3, entitled: 14, used: 2, pending: 1, remaining_after: 8 }],
  ...over,
});

describe('previewLines', () => {
  it('says the days and the balance after', () => {
    expect(previewLines(preview())).toEqual({ days: '3 days', balance: ['2026: 8 of 14 days left after this.'], warning: null });
  });

  it('says one day and half a day in the singular', () => {
    expect(previewLines(preview({ days: 1 })).days).toBe('1 day');
    expect(previewLines(preview({ days: 0.5 })).days).toBe('half a day');
    expect(previewLines(preview({ days: 1.5 })).days).toBe('1.5 days');
  });

  it('warns when over the balance, and says by how much in each year', () => {
    const lines = previewLines(
      preview({
        over_by: 2.5,
        years: [{ year: 2026, days: 4, entitled: 14, used: 12, pending: 0, remaining_after: -2 }, { year: 2027, days: 1, entitled: 14, used: 14, pending: 0, remaining_after: -0.5 }],
      }),
    );
    expect(lines.balance).toEqual(['2026: 2 days over the 14 days entitled.', '2027: 0.5 days over the 14 days entitled.']);
    expect(lines.warning).toBe('That is 2.5 days more than the balance. It can still be submitted, and whoever decides it will see this.');
  });

  it('has no balance lines for leave that has no balance', () => {
    expect(previewLines(preview({ years: [] }))).toEqual({ days: '3 days', balance: [], warning: null });
  });
});
