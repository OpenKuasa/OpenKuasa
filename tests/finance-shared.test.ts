import { describe, expect, it } from 'vitest';
import { BILL_LINES_MAX, BILL_MESSAGES, isIsoDate as isIsoDateFromBills, roundRate as roundRateFromBills } from '@/lib/finance/bills';
import {
  DOCUMENT_LINES_MAX,
  LINE_MESSAGES,
  documentLine,
  isIsoDate,
  isoDate,
  optionalText,
  roundRate,
  toDocumentLine,
} from '@/lib/finance/document-lines';
import * as purchaseViews from '@/lib/finance/purchase-views';
import {
  ELECTRONIC,
  LATEST_ROWS,
  METHOD_COLORS,
  addDays,
  count,
  displayDate,
  lastMonths,
  monthOf,
  paymentCount,
  sum,
  thousands,
  todayUtc,
} from '@/lib/finance/view-helpers';

describe('what bills and invoices share', () => {
  it('is one definition: bills.ts hands on the same functions, limit and sentences', () => {
    expect(isIsoDateFromBills).toBe(isIsoDate);
    expect(roundRateFromBills).toBe(roundRate);
    expect(BILL_LINES_MAX).toBe(DOCUMENT_LINES_MAX);
    for (const key of Object.keys(LINE_MESSAGES) as (keyof typeof LINE_MESSAGES)[]) {
      expect(BILL_MESSAGES[key], key).toBe(LINE_MESSAGES[key]);
    }
  });

  it('parses a line: rounds first, then checks, and parsing its own output changes nothing', () => {
    const once = documentLine.parse({ description: ' Gloves ', quantity: 1.23456, unit_price: 0.123456, sst_rate: 1.005, uom: ' box ', product_id: '' });
    expect(once).toEqual({
      product_id: null, description: 'Gloves', quantity: 1.235, uom: 'box', pack_size: null, unit_price: 0.1235, sst_rate: 1.01,
    });
    expect(documentLine.parse(once)).toEqual(once);
    expect(documentLine.safeParse({ description: 'Gloves', quantity: 0.0004, unit_price: 1 }).error?.issues[0]?.message).toBe('Enter a quantity above 0.');
    expect(documentLine.safeParse({ description: 'Gloves', quantity: 1, unit_price: 1, sst_rate: 100.005 }).error?.issues[0]?.message)
      .toBe('Enter an SST rate between 0 and 100.');
  });

  it('accepts only real calendar dates, and turns an empty box into null', () => {
    expect(isoDate.safeParse('2026-02-29').success).toBe(false);
    expect(isoDate.safeParse('2028-02-29').success).toBe(true);
    expect(isoDate.safeParse('0202-10-01').error?.issues[0]?.message).toBe('Enter a valid date.');
    expect(optionalText.parse('  ')).toBeNull();
    expect(optionalText.parse(' Net 30 ')).toBe('Net 30');
    expect(optionalText.parse(null)).toBeNull();
    expect(optionalText.safeParse('x'.repeat(201)).error?.issues[0]?.message).toBe('That is too long. Keep it to 200 characters or fewer.');
  });

  it('reads a saved line with its figures as numbers', () => {
    expect(
      toDocumentLine({
        id: 'l1', product_id: null, description: 'Gloves', quantity: '10.000', uom: null, pack_size: 'box of 4',
        unit_price: '12.5000', sst_rate: '6.00', amount: '125.00', sst_amount: '7.50',
      }),
    ).toEqual({
      id: 'l1', product_id: null, description: 'Gloves', quantity: 10, uom: null, pack_size: 'box of 4',
      unit_price: 12.5, sst_rate: 6, amount: 125, sst_amount: 7.5,
    });
  });
});

describe('what the purchase and sales figures share', () => {
  it('is one definition: purchase-views.ts hands on the same helpers', () => {
    expect(purchaseViews.displayDate).toBe(displayDate);
    expect(purchaseViews.todayUtc).toBe(todayUtc);
    expect(purchaseViews.LATEST_ROWS).toBe(LATEST_ROWS);
    expect(LATEST_ROWS).toBe(10);
  });

  it('names the last eight months, oldest first, across a year end', () => {
    expect(lastMonths('2026-10-09').map((m) => m.key)).toEqual([
      '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(lastMonths('2026-02-28')).toEqual([
      { key: '2025-07', label: 'Jul' }, { key: '2025-08', label: 'Aug' }, { key: '2025-09', label: 'Sep' }, { key: '2025-10', label: 'Oct' },
      { key: '2025-11', label: 'Nov' }, { key: '2025-12', label: 'Dec' }, { key: '2026-01', label: 'Jan' }, { key: '2026-02', label: 'Feb' },
    ]);
    // The 31st has no counterpart in a shorter month; the window is counted in months, not days.
    expect(lastMonths('2026-03-31', 3).map((m) => m.key)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('adds days across a month end, and takes the month of a date', () => {
    expect(addDays('2026-10-28', 7)).toBe('2026-11-04');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(monthOf('2026-10-09')).toBe('2026-10');
  });

  it('adds sen without drift, and rounds a chart figure to RM thousands with one decimal', () => {
    expect(sum([0.1, 0.2], (n) => n)).toBe(0.3);
    expect(sum([], (n: number) => n)).toBe(0);
    expect(thousands(4000)).toBe(4);
    expect(thousands(2549.99)).toBe(2.5);
    expect(thousands(30)).toBe(0);
  });

  it('counts a payment split across documents once, and words a count', () => {
    expect(paymentCount([{ transaction_id: 'a' }, { transaction_id: 'a' }, { transaction_id: 'b' }])).toBe(2);
    expect(paymentCount([])).toBe(0);
    expect(count(1, 'invoice')).toBe('1 invoice');
    expect(count(0, 'invoice')).toBe('0 invoices');
  });

  it('groups five methods as electronic and gives all seven a colour', () => {
    expect([...ELECTRONIC].sort()).toEqual(['bank_transfer', 'card', 'duitnow', 'ewallet', 'fpx']);
    expect(Object.keys(METHOD_COLORS).sort()).toEqual(['bank_transfer', 'card', 'cash', 'cheque', 'duitnow', 'ewallet', 'fpx']);
  });
});
