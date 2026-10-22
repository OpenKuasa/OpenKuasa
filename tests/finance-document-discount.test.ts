import { describe, expect, it } from 'vitest';
import {
  billTotals,
  DOC_DISCOUNT_LEAVES_NOTHING,
  docDiscountSen,
  documentTotals,
  lineAmounts,
  lineSen,
  type LineNumbers,
} from '@/lib/finance/bill-math';

const none = { pct: null, amount: null };

/** A small seeded generator (mulberry32), so the random cases are the same on every run. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLines(rand: () => number): LineNumbers[] {
  const rates = [0, 5, 6, 8, 10];
  const count = 1 + Math.floor(rand() * 6);
  const lines: LineNumbers[] = [];
  for (let i = 0; i < count; i++) {
    const line: LineNumbers = {
      quantity: Math.round(rand() * 50_000) / 1000,
      unit_price: Math.round(rand() * 5_000_000) / 10_000,
      sst_rate: rates[Math.floor(rand() * rates.length)],
    };
    const kind = Math.floor(rand() * 3);
    if (kind === 1) line.discount_pct = Math.round(rand() * 10_000) / 100;
    if (kind === 2) line.discount_amount = Math.round(rand() * 5_000) / 100;
    lines.push(line);
  }
  return lines;
}

describe('the document discount split (the database cases)', () => {
  it('10% off 100.00 @ 8%, 50.00 @ 6% and 0.01 @ 0%: the leftover sen go to the largest remainders', () => {
    const lines: LineNumbers[] = [
      { quantity: 1, unit_price: 100, sst_rate: 8 },
      { quantity: 1, unit_price: 50, sst_rate: 6 },
      { quantity: 1, unit_price: 0.01, sst_rate: 0 },
    ];
    const split = docDiscountSen(lines, { pct: 10, amount: null });
    // D = round(150.01 * 10%, 2) = 15.00; floors 9.99 / 4.99 / 0.00, leftover 2 sen to lines 2 then 1.
    expect(split.discount).toBe(BigInt(1500));
    expect(split.shares).toEqual([BigInt(1000), BigInt(500), BigInt(0)]);

    const withShares = lines.map((line, i) => ({ ...line, doc_discount_share: Number(split.shares[i]) / 100 }));
    expect(withShares.map((line) => lineAmounts(line))).toEqual([
      { amount: 90, sst: 7.2 },
      { amount: 45, sst: 2.7 },
      { amount: 0.01, sst: 0 },
    ]);
    expect(documentTotals(lines, { pct: 10, amount: null })).toEqual({
      subtotal: 150.01,
      discount: 15,
      sst: 9.9,
      total: 144.91,
    });
  });

  it('a fixed 0.10 off three lines of 10.00: the extra sen goes to the lowest position', () => {
    const lines: LineNumbers[] = [1, 2, 3].map(() => ({ quantity: 1, unit_price: 10, sst_rate: 0 }));
    const split = docDiscountSen(lines, { pct: null, amount: 0.1 });
    expect(split.discount).toBe(BigInt(10));
    expect(split.shares).toEqual([BigInt(4), BigInt(3), BigInt(3)]);
    expect(documentTotals(lines, { pct: null, amount: 0.1 })).toEqual({ subtotal: 30, discount: 0.1, sst: 0, total: 29.9 });
  });

  it('a line discount of 5% and a document discount of 10%: the share is taken on the net after 5%', () => {
    const lines: LineNumbers[] = [{ quantity: 1, unit_price: 100, sst_rate: 8, discount_pct: 5 }];
    const split = docDiscountSen(lines, { pct: 10, amount: null });
    // Net 95.00, D = 9.50, amount 85.50, SST 8% of 85.50 = 6.84.
    expect(split.discount).toBe(BigInt(950));
    expect(split.shares).toEqual([BigInt(950)]);
    expect(lineAmounts({ ...lines[0], doc_discount_share: 9.5 })).toEqual({ amount: 85.5, sst: 6.84 });
    expect(documentTotals(lines, { pct: 10, amount: null })).toEqual({ subtotal: 95, discount: 9.5, sst: 6.84, total: 92.34 });
  });
});

describe('the document discount split (properties)', () => {
  it('with no document discount and a share of 0, every figure is billTotals\' own (100 seeded cases)', () => {
    const rand = seeded(20261022);
    for (let n = 0; n < 100; n++) {
      const lines = randomLines(rand);
      const plain = billTotals(lines);
      expect(documentTotals(lines, none)).toEqual({ ...plain, discount: 0 });
      expect(documentTotals(lines, { pct: 0, amount: 0 })).toEqual({ ...plain, discount: 0 });
      for (const line of lines) {
        expect(lineSen({ ...line, doc_discount_share: 0 })).toEqual(lineSen(line));
      }
      expect(docDiscountSen(lines, none).shares.every((s) => s === BigInt(0))).toBe(true);
    }
  });

  it('the shares sum to D, and no share is more than its line\'s net (100 seeded cases)', () => {
    const rand = seeded(334);
    for (let n = 0; n < 100; n++) {
      const lines = randomLines(rand);
      const nets = lines.map((line) => lineSen(line).amount);
      const sum = nets.reduce((a, b) => a + b, BigInt(0));
      const d =
        rand() < 0.5
          ? { pct: Math.max(0.01, Math.round(rand() * 9_999) / 100), amount: null }
          : { pct: null, amount: Math.max(0.01, Math.round(rand() * Number(sum)) / 100) };
      const split = docDiscountSen(lines, d);
      expect(split.discount <= sum).toBe(true);
      expect(split.shares.reduce((a, b) => a + b, BigInt(0))).toBe(split.discount);
      split.shares.forEach((share, i) => {
        expect(share >= BigInt(0)).toBe(true);
        expect(share <= nets[i]).toBe(true);
      });
      // Every line's amount after its share adds back up to the subtotal less D.
      const totals = documentTotals(lines, d);
      const after = lines.reduce(
        (acc, line, i) => acc + lineSen({ ...line, doc_discount_share: Number(split.shares[i]) / 100 }).amount,
        BigInt(0),
      );
      expect(Math.round(totals.subtotal * 100) - Math.round(totals.discount * 100)).toBe(Number(after));
    }
  });

  it('ties go to the lower index, wherever the tied lines are', () => {
    // 10.00 / 20.00 / 10.00 (Σ 40.00). A fixed 0.05: floors 1 / 2 / 1 sen, remainders 0.25 / 0.5 / 0.25, so the
    // one sen left goes to line 2. A fixed 0.06: floors 1 / 3 / 1, remainders 0.5 / 0 / 0.5, a tie: line 1 wins.
    const lines: LineNumbers[] = [10, 20, 10].map((p) => ({ quantity: 1, unit_price: p, sst_rate: 6 }));
    expect(docDiscountSen(lines, { pct: null, amount: 0.05 }).shares).toEqual([BigInt(1), BigInt(3), BigInt(1)]);
    expect(docDiscountSen(lines, { pct: null, amount: 0.06 }).shares).toEqual([BigInt(2), BigInt(3), BigInt(1)]);
    // Four equal lines and 0.02: the two lowest indexes take the sen.
    const four: LineNumbers[] = [1, 2, 3, 4].map(() => ({ quantity: 1, unit_price: 1, sst_rate: 0 }));
    expect(docDiscountSen(four, { pct: null, amount: 0.02 }).shares).toEqual([BigInt(1), BigInt(1), BigInt(0), BigInt(0)]);
  });

  it('a line with a net of 0 takes no share, and a discount of everything is capped at the sum', () => {
    const lines: LineNumbers[] = [
      { quantity: 0, unit_price: 10, sst_rate: 8 },
      { quantity: 1, unit_price: 10, sst_rate: 8 },
    ];
    expect(docDiscountSen(lines, { pct: null, amount: 3 }).shares).toEqual([BigInt(0), BigInt(300)]);
    // D over Σ net is the form's FIN62 case; the split, like the database's, never goes past Σ net.
    expect(docDiscountSen(lines, { pct: null, amount: 50 })).toEqual({ discount: BigInt(1000), shares: [BigInt(0), BigInt(1000)] });
    expect(docDiscountSen([], { pct: 10, amount: null })).toEqual({ discount: BigInt(0), shares: [] });
    expect(DOC_DISCOUNT_LEAVES_NOTHING).toBe('A discount on the whole document must leave something to pay.');
  });

  it('takes the share off the unrounded value for the SST', () => {
    // 1 x 0.055 @ 10% (amount 0.06) with a share of 0.01 leaves 0.045: amount 0.05, and SST 10% of 0.045 =
    // 0.0045 -> 0.00, where 10% of the rounded 0.05 would be 0.005 -> 0.01.
    expect(lineAmounts({ quantity: 1, unit_price: 0.055, sst_rate: 10, doc_discount_share: 0.01 })).toEqual({ amount: 0.05, sst: 0 });
    // The same after a line discount: 1 x 0.11 less 50% is 0.055; the share comes off that.
    expect(lineAmounts({ quantity: 1, unit_price: 0.11, sst_rate: 10, discount_pct: 50, doc_discount_share: 0.01 })).toEqual({ amount: 0.05, sst: 0 });
    // And after a fixed line discount: 1 x 0.1 less 0.05 is 0.05 exactly; a share of 0.01 leaves 0.04.
    expect(lineAmounts({ quantity: 1, unit_price: 0.1, sst_rate: 10, discount_amount: 0.05, doc_discount_share: 0.01 })).toEqual({ amount: 0.04, sst: 0 });
  });

  it('a line on a half sen that takes its whole net as its share ends at 0.00, never -0.01', () => {
    // 0.5 x 0.01 = 0.005 (net 0.01) and 10.00, both @ 10%; a fixed 6.00 (Σ net 10.01).
    // Floors 0 / 5.99, remainders 600 / 401 (in 1/1001 sen): the leftover sen goes to the small line.
    const lines: LineNumbers[] = [
      { quantity: 0.5, unit_price: 0.01, sst_rate: 10 },
      { quantity: 1, unit_price: 10, sst_rate: 10 },
    ];
    const d = { pct: null, amount: 6 };
    const split = docDiscountSen(lines, d);
    expect(split.shares).toEqual([BigInt(1), BigInt(599)]);
    const after = lines.map((line, i) => lineSen({ ...line, doc_discount_share: Number(split.shares[i]) / 100 }));
    expect(after).toEqual([
      { amount: BigInt(0), sst: BigInt(0) },
      { amount: BigInt(401), sst: BigInt(40) },
    ]);
    const amounts = after.reduce((a, b) => a + b.amount, BigInt(0));
    const ssts = after.reduce((a, b) => a + b.sst, BigInt(0));
    expect(amounts).toBe(BigInt(1001) - split.discount);
    const totals = documentTotals(lines, d);
    expect(totals).toEqual({ subtotal: 10.01, discount: 6, sst: 0.4, total: 4.41 });
    expect(Math.round(totals.total * 100)).toBe(Number(amounts + ssts));
  });
});
