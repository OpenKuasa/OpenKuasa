import { describe, expect, it } from 'vitest';
import { salesDocumentLine } from '@/lib/finance/document-lines';

/** A sales line is a document line with an optional discount: a percentage or a fixed ringgit amount, not both. */
const base = { description: 'Widget', quantity: 2, unit_price: 50 }; // 2 x 50 = RM 100.00

describe('salesDocumentLine discount', () => {
  it('keeps a percentage discount and leaves the ringgit one null', () => {
    const parsed = salesDocumentLine.parse({ ...base, discount_pct: 5 });
    expect(parsed.discount_pct).toBe(5);
    expect(parsed.discount_amount).toBeNull();
  });

  it('keeps a fixed ringgit discount and leaves the percentage null', () => {
    const parsed = salesDocumentLine.parse({ ...base, discount_amount: 10 });
    expect(parsed.discount_amount).toBe(10);
    expect(parsed.discount_pct).toBeNull();
  });

  it('stores a zero or missing discount as none', () => {
    expect(salesDocumentLine.parse(base).discount_pct).toBeNull();
    expect(salesDocumentLine.parse({ ...base, discount_pct: 0 }).discount_pct).toBeNull();
    expect(salesDocumentLine.parse({ ...base, discount_amount: 0 }).discount_amount).toBeNull();
  });

  it('refuses a percentage and a ringgit discount together', () => {
    const r = salesDocumentLine.safeParse({ ...base, discount_pct: 5, discount_amount: 10 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/not both/i);
  });

  it('refuses a fixed discount larger than the line', () => {
    const r = salesDocumentLine.safeParse({ ...base, discount_amount: 150 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/more than the line/i);
  });

  it('allows a fixed discount up to the whole line', () => {
    expect(salesDocumentLine.safeParse({ ...base, discount_amount: 100 }).success).toBe(true);
  });

  it('refuses a percentage below 0 or above 100', () => {
    expect(salesDocumentLine.safeParse({ ...base, discount_pct: -1 }).success).toBe(false);
    expect(salesDocumentLine.safeParse({ ...base, discount_pct: 150 }).success).toBe(false);
  });
});
