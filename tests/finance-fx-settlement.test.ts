import { describe, expect, it } from 'vitest';
import {
  carriedSen,
  realisedSen,
  senFromNumber,
  senFromText,
  settlementPreview,
  shareRinggit,
} from '@/lib/finance/fx-settlement';

/**
 * The plan's worked examples (.superpowers/sdd/2026-10-16-bendahara-fx-sales.md, B, B1, B2), the same figures
 * supabase/tests/bendahara_fx_payments_in_check.sql asserts against the database, to the sen.
 */
const sen = (n: number) => BigInt(Math.round(n * 100));
const rate = (text: string) => BigInt(text.replace('.', '').padEnd(text.indexOf('.') + 10, '0'));

describe('reading money and rates', () => {
  it('reads decimal text as sen, and nothing else', () => {
    expect(senFromText('2883.5')).toBe(BigInt(288350));
    expect(senFromText(' 1658 ')).toBe(BigInt(165800));
    expect(senFromText('0.07')).toBe(BigInt(7));
    expect(senFromText('1,658')).toBeNull();
    expect(senFromText('1.005')).toBeNull();
    expect(senFromText('-1')).toBeNull();
  });
  it('reads a stored two-decimal balance as sen', () => {
    expect(senFromNumber(2856)).toBe(BigInt(285600));
    expect(senFromNumber(-453.6)).toBe(BigInt(-45360));
    expect(senFromNumber(0.1 + 0.2)).toBe(BigInt(30));
  });
});

describe('B: USD 1,080.00 at 4.2 paid in two parts', () => {
  const r = rate('4.2');
  it('payment 1, USD 400.00 as RM 1,658.00: carried 1,680.00, a loss of 22.00', () => {
    const carried = carriedSen(sen(400), r, sen(1080), sen(4536));
    expect(carried).toBe(sen(1680));
    expect(realisedSen(sen(1658), carried)).toBe(sen(-22));
  });
  it('payment 2, USD 680.00 as RM 2,883.50: closing, carried the 2,856.00 still open, a gain of 27.50', () => {
    const carried = carriedSen(sen(680), r, sen(680), sen(2856));
    expect(carried).toBe(sen(2856));
    expect(realisedSen(sen(2883.5), carried)).toBe(sen(27.5));
  });
});

describe('B1: the sen the closing rule exists for', () => {
  const r = rate('4.2555');
  it('USD 50.00 as RM 212.00 carries round(212.775) = 212.78', () => {
    expect(carriedSen(sen(50), r, sen(99.99), sen(425.52))).toBe(sen(212.78));
  });
  it('the last USD 49.99 carries the 212.74 still open, not round(212.732445) = 212.73', () => {
    const carried = carriedSen(sen(49.99), r, sen(49.99), sen(425.52 - 212.78));
    expect(carried).toBe(sen(212.74));
    expect(realisedSen(sen(213), carried)).toBe(sen(0.26));
  });
  it('never carries more than the ringgit still open on the invoice', () => {
    expect(carriedSen(sen(99.98), r, sen(99.99), sen(425.4))).toBe(sen(425.4));
  });
});

describe('B2: RM 1,000.00 over three invoices of USD 100.00', () => {
  const ids = ['cccccccc-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'];
  it('shares in proportion, the remainder to the largest, ties to the lowest id, adding up exactly', () => {
    const shares = shareRinggit(sen(1000), ids.map((id) => ({ id, sen: sen(100) })));
    expect(shares).toEqual([sen(333.33), sen(333.34), sen(333.33)]);
    expect(shares.reduce((a, b) => a + b, BigInt(0))).toBe(sen(1000));
  });
  it('gives the remainder to the largest part', () => {
    expect(shareRinggit(sen(100), [{ id: 'b', sen: sen(1) }, { id: 'a', sen: sen(2) }])).toEqual([sen(33.33), sen(66.67)]);
  });
  it('previews the realised loss of 260.00 (carried 1,260.00)', () => {
    const preview = settlementPreview(
      '1000',
      ids.map((id) => ({ id, amount: '100', rateText: '4.2000000000', openForeign: 100, openRinggit: 420 })),
    );
    expect(preview?.carried).toBe(1260);
    expect(preview?.realised).toBe(-260);
    expect(preview?.parts.map((p) => p.ringgit)).toEqual([333.33, 333.34, 333.33]);
  });
});

describe('settlementPreview', () => {
  it('is null while a figure is not a number yet', () => {
    const part = { id: 'a', amount: '400', rateText: '4.2000000000', openForeign: 1080, openRinggit: 4536 };
    expect(settlementPreview('', [part])).toBeNull();
    expect(settlementPreview('0', [part])).toBeNull();
    expect(settlementPreview('1658', [{ ...part, amount: 'x' }])).toBeNull();
    expect(settlementPreview('1658', [{ ...part, rateText: null }])).toBeNull();
    expect(settlementPreview('1658', [part])).toMatchObject({ carried: 1680, realised: -22 });
  });
});
