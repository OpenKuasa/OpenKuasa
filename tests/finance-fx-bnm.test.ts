import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMonths, daysBetween, malaysiaClock, monthOfDate } from '@/lib/finance/fx-dates';
import { LATEST_PATH, fxRateRow, monthPath, readLatestAnswer, readMonthAnswer } from '@/lib/finance/fx-bnm';

// Answers recorded from https://api.bnm.gov.my/public on 2026-10-15 with
// `Accept: application/vnd.BNM.API.v1+json` (the float noise is BNM's own).
const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/bnm', name), 'utf8')) as unknown;
const LATEST = fixture('latest-1700-2026-10-15.json');
const JPY_SEPTEMBER = fixture('jpy-1700-2026-09.json');
/** What BNM answers for a Sunday, verified for /exchange-rate/USD/date/2026-10-11?session=1700. */
const NOT_FOUND = { message: 'No records found.', code: 404 };

describe('readLatestAnswer', () => {
  const answer = readLatestAnswer(LATEST);
  const rows = answer.kind === 'rates' ? answer.rows : [];
  const byCode = (code: string) => rows.find((r) => r.currency === code);

  it('reads all 27 currencies of the 1700 session, each under the date BNM gives', () => {
    expect(answer.kind).toBe('rates');
    expect(rows).toHaveLength(27);
    expect(new Set(rows.map((r) => r.rate_date))).toEqual(new Set(['2026-10-15']));
    expect(new Set(rows.map((r) => r.session))).toEqual(new Set(['1700']));
  });

  it('keeps a unit-1 rate as it is, to 10 decimals per one unit', () => {
    expect(byCode('USD')).toEqual({
      currency: 'USD',
      rate_date: '2026-10-15',
      session: '1700',
      unit: 1,
      buying_rate: '4.080000',
      selling_rate: '4.083000',
      middle_rate: '4.081500',
      rate: '4.0815000000',
    });
  });

  it('divides a per-100 rate by 100', () => {
    expect(byCode('JPY')).toMatchObject({ unit: 100, middle_rate: '2.585700', rate: '0.0258570000' });
    expect(byCode('VND')).toMatchObject({ unit: 100, middle_rate: '0.015800', rate: '0.0001580000' });
    expect(byCode('IDR')).toMatchObject({ unit: 100, rate: '0.0002280000' });
  });

  it('drops the float noise: 4.9168000000000003 is stored as 4.916800', () => {
    expect(byCode('CHF')).toMatchObject({ buying_rate: '4.916800', selling_rate: '4.921600', middle_rate: '4.919200' });
  });

  it('keeps SDR, which has a middle rate and no buying or selling rate', () => {
    expect(byCode('SDR')).toMatchObject({ unit: 1, buying_rate: null, selling_rate: null, middle_rate: '5.521600' });
  });

  it('reads BNM saying it has nothing as nothing, and anything else as unusable', () => {
    expect(readLatestAnswer(NOT_FOUND)).toEqual({ kind: 'none' });
    expect(readLatestAnswer('<!DOCTYPE html><html>')).toEqual({ kind: 'unusable' });
    expect(readLatestAnswer({ data: [] })).toEqual({ kind: 'unusable' });
    // Another session's rates are not taken for the 1700 session's.
    const noon = { ...(LATEST as { meta: object }), meta: { ...(LATEST as { meta: object }).meta, session: '1200' } };
    expect(readLatestAnswer(noon)).toEqual({ kind: 'unusable' });
  });
});

describe('readMonthAnswer', () => {
  it('reads one currency for one month: every working day of September 2026', () => {
    const answer = readMonthAnswer(JPY_SEPTEMBER, 'JPY');
    expect(answer.kind).toBe('rates');
    const rows = answer.kind === 'rates' ? answer.rows : [];
    expect(rows).toHaveLength(21);
    expect(rows[0]).toEqual({
      currency: 'JPY',
      rate_date: '2026-09-01',
      session: '1700',
      unit: 100,
      buying_rate: '2.523300',
      selling_rate: '2.528900',
      middle_rate: '2.526100',
      rate: '0.0252610000',
    });
    // No weekend: 5 and 6 September 2026 were a Saturday and a Sunday.
    expect(rows.map((r) => r.rate_date)).not.toContain('2026-09-05');
  });

  it('refuses a month answer for another currency than the one asked for', () => {
    expect(readMonthAnswer(JPY_SEPTEMBER, 'USD')).toEqual({ kind: 'unusable' });
  });

  it('reads a month with no rates as nothing', () => {
    expect(readMonthAnswer(NOT_FOUND, 'JPY')).toEqual({ kind: 'none' });
  });
});

describe('fxRateRow', () => {
  it('skips a day with no middle rate (the 1130 session has none)', () => {
    expect(fxRateRow('USD', 1, { date: '2026-10-12', buying_rate: 4.1, selling_rate: 4.2, middle_rate: null })).toBeNull();
  });
});

describe('paths', () => {
  it('always names the 1700 session', () => {
    expect(LATEST_PATH).toBe('/exchange-rate?session=1700');
    expect(monthPath('USD', '2024-03')).toBe('/exchange-rate/USD/year/2024/month/3?session=1700');
  });
});

describe('fx-dates', () => {
  it('reads the Malaysian date and time, eight hours ahead of UTC', () => {
    expect(malaysiaClock(new Date('2026-10-15T09:29:00Z'))).toEqual({ date: '2026-10-15', minutes: 17 * 60 + 29, weekday: 4 });
    // 16:30 UTC on Saturday is 00:30 on Sunday in Malaysia.
    expect(malaysiaClock(new Date('2026-10-17T16:30:00Z'))).toEqual({ date: '2026-10-18', minutes: 30, weekday: 0 });
  });

  it('counts days and moves months across a year end', () => {
    expect(daysBetween('2026-10-02', '2026-10-15')).toBe(13);
    expect(daysBetween('2026-10-15', '2026-10-02')).toBe(-13);
    expect(monthOfDate('2026-10-15')).toBe('2026-10');
    expect(addMonths('2026-10', -24)).toBe('2024-10');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
});

describe('the dates BNM gives', () => {
  const read = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/bnm', name), 'utf8')) as unknown;
  it('must fall in the month asked for, and not after today', () => {
    const month = read('jpy-1700-2026-09.json');
    expect(readMonthAnswer(month, 'JPY', '2026-09', '2026-10-15').kind).toBe('rates');
    expect(readMonthAnswer(month, 'JPY', '2026-08', '2026-10-15').kind).toBe('unusable');
    expect(readMonthAnswer(month, 'JPY', '2026-09', '2026-09-02').kind).toBe('unusable');
  });
  it('a latest answer dated after today is refused', () => {
    const latest = read('latest-1700-2026-10-15.json');
    expect(readLatestAnswer(latest, '2026-10-15').kind).toBe('rates');
    expect(readLatestAnswer(latest, '2026-10-14').kind).toBe('unusable');
  });
});
