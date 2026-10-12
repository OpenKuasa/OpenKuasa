import { describe, expect, it } from 'vitest';
import {
  centsToRinggit,
  monthLabel,
  nextRunMonth,
  ringgitToCents,
  toLineInput,
  toStatutoryInput,
} from '@/lib/people/payroll-forms';
import type { PayrollRun } from '@/lib/people/types';

const run = (period_month: string): PayrollRun => ({
  id: `run-${period_month}`,
  period_month,
  status: 'paid',
  paid_at: null,
  paid_by_name: null,
});

describe('ringgitToCents', () => {
  it.each([
    ['1,200', 120_000],
    ['1200', 120_000],
    ['1200.5', 120_050],
    ['1200.50', 120_050],
    ['RM 1200', 120_000],
    ['rm1,200.05', 120_005],
    [' 1200.50 ', 120_050],
    ['0.01', 1],
    ['0.1', 10],
    ['9,999,999.99', 999_999_999],
    ['1,234,567', 123_456_700],
  ])('reads %j as %i cents', (text, cents) => {
    expect(ringgitToCents(text)).toBe(cents);
  });

  it.each([
    [''],
    ['  '],
    ['0'],
    ['0.00'],
    ['-5'],
    ['-0.50'],
    ['1200.505'],
    ['1,20'],
    ['12,34,567'],
    ['1e3'],
    ['abc'],
    ['12abc'],
    ['1.'],
    ['.5'],
    ['1 200'],
    ['RM'],
    ['10,000,000'],
    ['9,999,999.995'],
    ['Infinity'],
    ['0,500'],
    ['1,2,3'],
    ['١٢٠٠'],
    ['99999999.99'],
    ['9'.repeat(10_000)],
    ['1'.repeat(5_000) + ',000'],
    ['NaN'],
  ])('refuses %j', (text) => {
    expect(ringgitToCents(text)).toBeNull();
  });
});

describe('centsToRinggit', () => {
  it.each([
    [120_050, 'RM 1,200.50'],
    [0, 'RM 0.00'],
    [5, 'RM 0.05'],
    [123_456_789, 'RM 1,234,567.89'],
    [100, 'RM 1.00'],
  ])('shows %i as %s', (cents, text) => {
    expect(centsToRinggit(cents)).toBe(text);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [12.5]])('shows %s as a dash, never RMNaN', (value) => {
    expect(centsToRinggit(value)).toBe('RM —');
  });

  it('puts the minus sign first on a negative figure', () => {
    expect(centsToRinggit(-120_050)).toBe('-RM 1,200.50');
  });
});

describe('monthLabel', () => {
  it('words a month', () => {
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(monthLabel('2027-01')).toBe('January 2027');
  });
});

describe('nextRunMonth', () => {
  it('is the month after the latest run', () => {
    expect(nextRunMonth([run('2026-08-01'), run('2026-09-01')], '2026-10-09')).toBe('2026-10');
  });

  it('is this month when there are no runs', () => {
    expect(nextRunMonth([], '2026-10-09')).toBe('2026-10');
  });

  it('crosses a year boundary', () => {
    expect(nextRunMonth([run('2026-11-01'), run('2026-12-01')], '2027-03-15')).toBe('2027-01');
  });

  it('is null when every month up to this one already has a run, since there is nothing to run', () => {
    expect(nextRunMonth([run('2026-10-01')], '2026-10-09')).toBeNull();
    expect(nextRunMonth([run('2026-11-01')], '2026-10-09')).toBeNull();
    expect(nextRunMonth([run('2026-09-01')], '2026-10-09')).toBe('2026-10');
  });

  it('starts from the month after the latest run even with a gap behind it', () => {
    expect(nextRunMonth([run('2026-01-01'), run('2026-03-01')], '2026-10-09')).toBe('2026-04');
  });

  it('does not depend on the order of the runs', () => {
    expect(nextRunMonth([run('2026-09-01'), run('2026-07-01'), run('2026-08-01')], '2026-12-01')).toBe('2026-10');
  });
});

describe('toLineInput', () => {
  it('converts a filled-in form and trims the name', () => {
    expect(toLineInput({ kind: 'earning', label: '  Sales commission ', amount: 'RM 1,200.5' })).toEqual({
      ok: true,
      input: { kind: 'earning', label: 'Sales commission', amount_cents: 120_050 },
    });
    expect(toLineInput({ kind: 'deduction', label: 'Uniform', amount: '60' })).toEqual({
      ok: true,
      input: { kind: 'deduction', label: 'Uniform', amount_cents: 6000 },
    });
  });

  it.each([
    [{ kind: 'unpaid', label: 'x', amount: '5' }],
    [{ kind: '', label: 'x', amount: '5' }],
    [{ kind: 'earning', label: '   ', amount: '5' }],
    [{ kind: 'earning', label: 'a'.repeat(81), amount: '5' }],
    [{ kind: 'earning', label: 'x', amount: '' }],
    [{ kind: 'earning', label: 'x', amount: '0' }],
    [{ kind: 'earning', label: 'x', amount: '-3' }],
    [{ kind: 'earning', label: 'x', amount: '5.123' }],
    [{ kind: 'earning', label: 'x', amount: '99999999' }],
  ])('refuses %j with a sentence', (values) => {
    const result = toLineInput(values);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(5);
  });

  it('accepts an 80-character name', () => {
    expect(toLineInput({ kind: 'earning', label: 'a'.repeat(80), amount: '1' }).ok).toBe(true);
  });
});

describe('toStatutoryInput', () => {
  it('converts a figure', () => {
    expect(toStatutoryInput({ field: 'epf', amount: '1,100.50' })).toEqual({
      ok: true,
      input: { field: 'epf', amount_cents: 110_050 },
    });
  });

  it('reads an empty amount as a reset', () => {
    expect(toStatutoryInput({ field: 'pcb', amount: '  ' })).toEqual({ ok: true, input: { field: 'pcb', amount_cents: null } });
  });

  it('allows zero, because a figure may be nothing', () => {
    expect(toStatutoryInput({ field: 'eis', amount: '0' })).toEqual({ ok: true, input: { field: 'eis', amount_cents: 0 } });
    expect(toStatutoryInput({ field: 'socso', amount: 'RM 0.00' })).toEqual({
      ok: true,
      input: { field: 'socso', amount_cents: 0 },
    });
  });

  it.each([
    [{ field: 'tax', amount: '5' }],
    [{ field: '', amount: '5' }],
    [{ field: 'epf', amount: '-5' }],
    [{ field: 'epf', amount: 'abc' }],
    [{ field: 'epf', amount: '1.234' }],
    [{ field: 'epf', amount: '10,000,000' }],
  ])('refuses %j', (values) => {
    const result = toStatutoryInput(values);
    expect(result.ok).toBe(false);
  });
});
