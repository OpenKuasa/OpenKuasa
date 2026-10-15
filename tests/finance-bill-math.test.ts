import { describe, expect, it } from 'vitest';
import { addDaysIso, billTotals, lineAmounts, localIsoDate } from '@/lib/finance/bill-math';

describe('lineAmounts', () => {
  it('multiplies quantity by unit price and takes the SST on top', () => {
    expect(lineAmounts({ quantity: 10, unit_price: 12.5, sst_rate: 6 })).toEqual({ amount: 125, sst: 7.5 });
    expect(lineAmounts({ quantity: 3, unit_price: 19.99, sst_rate: 0 })).toEqual({ amount: 59.97, sst: 0 });
  });

  it('rounds half up to the sen as the database does, where plain floating point would not', () => {
    // 1.005 * 100 is 100.49999999999999 in floating point; the database stores 100.50.
    expect(lineAmounts({ quantity: 100, unit_price: 1.005, sst_rate: 0 }).amount).toBe(100.5);
    // 0.615 * 3 = 1.845 -> 1.85; SST 8% of 1.845 = 0.1476 -> 0.15.
    expect(lineAmounts({ quantity: 3, unit_price: 0.615, sst_rate: 8 })).toEqual({ amount: 1.85, sst: 0.15 });
    // SST is taken on the unrounded product: 6% of 0.125 = 0.0075 -> 0.01, although 6% of 0.13 would round to 0.01 too.
    expect(lineAmounts({ quantity: 1, unit_price: 0.125, sst_rate: 6 })).toEqual({ amount: 0.13, sst: 0.01 });
  });

  it('keeps 3 decimals of quantity and 4 of unit price, as the schema does', () => {
    // 1.2346 -> 1.235 and 0.12345 -> 0.1235 (floating point puts 0.12345 * 10000 just above 1234.5).
    expect(lineAmounts({ quantity: 1.2346, unit_price: 100, sst_rate: 0 }).amount).toBe(123.5);
    expect(lineAmounts({ quantity: 1000, unit_price: 0.12345, sst_rate: 0 }).amount).toBe(123.5);
  });

  it('keeps 2 decimals of the SST rate, rounded as the database stores it', () => {
    // 1.005% is stored as 1.01%: SST on RM 10,000.00 is 101.00, not the 100.50 of the rate as typed.
    expect(lineAmounts({ quantity: 1, unit_price: 10_000, sst_rate: 1.005 })).toEqual({ amount: 10_000, sst: 101 });
    // 0.145% is stored as 0.15%.
    expect(lineAmounts({ quantity: 1, unit_price: 10_000, sst_rate: 0.145 }).sst).toBe(15);
    expect(billTotals([{ quantity: 1, unit_price: 10_000, sst_rate: 1.005 }])).toEqual({ subtotal: 10_000, sst: 101, total: 10_101 });
  });

  it('stays exact near the largest amount a bill line can hold', () => {
    // 99,999,999 x 9,999.9999 = 999,999,980,000.0001; 6% of that is 59,999,998,800.000006.
    expect(lineAmounts({ quantity: 99_999_999, unit_price: 9_999.9999, sst_rate: 6 })).toEqual({
      amount: 999_999_980_000,
      sst: 59_999_998_800,
    });
  });

  it('counts a box that is empty, negative or not a number as nothing', () => {
    expect(lineAmounts({ quantity: Number.NaN, unit_price: 5, sst_rate: 6 })).toEqual({ amount: 0, sst: 0 });
    expect(lineAmounts({ quantity: 2, unit_price: -5, sst_rate: 6 })).toEqual({ amount: 0, sst: 0 });
    expect(lineAmounts({ quantity: 2, unit_price: 5, sst_rate: Number.NaN })).toEqual({ amount: 10, sst: 0 });
  });
});

describe('lineAmounts with a discount (sales lines only)', () => {
  it('takes a percentage off the line before SST', () => {
    expect(lineAmounts({ quantity: 1, unit_price: 100, sst_rate: 6, discount_pct: 5 })).toEqual({ amount: 95, sst: 5.7 });
  });

  it('takes a fixed ringgit amount off the line before SST', () => {
    expect(lineAmounts({ quantity: 1, unit_price: 100, sst_rate: 6, discount_amount: 10 })).toEqual({ amount: 90, sst: 5.4 });
  });

  it('rounds the net to the sen on an awkward percentage', () => {
    // 3 x 9.99 = 29.97; less 5% = 28.4715 -> 28.47.
    expect(lineAmounts({ quantity: 3, unit_price: 9.99, sst_rate: 0, discount_pct: 5 }).amount).toBe(28.47);
  });

  it('is identical to no discount when the discount is zero or absent', () => {
    const base = { quantity: 100, unit_price: 1.005, sst_rate: 8 };
    const plain = lineAmounts(base);
    expect(lineAmounts({ ...base, discount_pct: 0 })).toEqual(plain);
    expect(lineAmounts({ ...base, discount_amount: 0 })).toEqual(plain);
    expect(lineAmounts({ ...base, discount_pct: null, discount_amount: null })).toEqual(plain);
  });

  it('never goes below zero when a fixed discount is larger than the line', () => {
    expect(lineAmounts({ quantity: 1, unit_price: 100, sst_rate: 6, discount_amount: 150 })).toEqual({ amount: 0, sst: 0 });
  });

  it('sums net-of-discount lines in a total', () => {
    expect(
      billTotals([
        { quantity: 1, unit_price: 100, sst_rate: 6, discount_pct: 5 }, // 95.00 + 5.70
        { quantity: 1, unit_price: 50, sst_rate: 0, discount_amount: 10 }, // 40.00 + 0
      ]),
    ).toEqual({ subtotal: 135, sst: 5.7, total: 140.7 });
  });
});

describe('billTotals', () => {
  it('adds each line after rounding it, so the total matches the sum of the lines shown', () => {
    // Three lines of 0.335 each round to 0.34: 1.02, not round(1.005) = 1.01.
    const line = { quantity: 1, unit_price: 0.335, sst_rate: 0 };
    expect(billTotals([line, line, line])).toEqual({ subtotal: 1.02, sst: 0, total: 1.02 });
  });

  it('gives subtotal, SST and total without floating point drift', () => {
    expect(
      billTotals([
        { quantity: 1, unit_price: 0.1, sst_rate: 6 },
        { quantity: 1, unit_price: 0.2, sst_rate: 6 },
        { quantity: 10, unit_price: 12.5, sst_rate: 8 },
      ]),
    ).toEqual({ subtotal: 125.3, sst: 10.02, total: 135.32 });
  });

  it('is zero for no lines', () => {
    expect(billTotals([])).toEqual({ subtotal: 0, sst: 0, total: 0 });
  });
});

describe('addDaysIso', () => {
  it('adds payment terms across a month end, a year end and a leap day', () => {
    expect(addDaysIso('2026-10-11', 30)).toBe('2026-11-10');
    expect(addDaysIso('2026-12-15', 30)).toBe('2027-01-14');
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysIso('2026-10-11', 0)).toBe('2026-10-11');
  });

  it('returns what it was given when that is not a date', () => {
    expect(addDaysIso('', 30)).toBe('');
    expect(addDaysIso('2026-02-30', 30)).toBe('2026-02-30');
    expect(addDaysIso('2026-10-11', Number.NaN)).toBe('2026-10-11');
  });
});

describe('localIsoDate', () => {
  it('reads the date off the local calendar, padded', () => {
    expect(localIsoDate(new Date(2026, 9, 11, 7, 30))).toBe('2026-10-11');
    expect(localIsoDate(new Date(2027, 0, 5, 23, 59))).toBe('2027-01-05');
  });
});

describe('absurd input', () => {
  it('treats a quantity too large to scale as unusable instead of throwing', () => {
    const line = { quantity: 1e306, unit_price: 1, sst_rate: 0 };
    expect(lineAmounts(line)).toEqual({ amount: 0, sst: 0 });
    expect(billTotals([line])).toEqual({ subtotal: 0, sst: 0, total: 0 });
  });

  it('leaves a date alone when adding days leaves the calendar', () => {
    expect(addDaysIso('2026-10-10', 1e12)).toBe('2026-10-10');
  });
});
