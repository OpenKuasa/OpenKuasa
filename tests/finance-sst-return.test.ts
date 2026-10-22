import { describe, expect, it } from 'vitest';
import {
  SST_FORM_ITEMS,
  buildSstReturn,
  pickSstView,
  recentSstPeriods,
  type SstCreditRow,
  type SstFormLine,
  type SstLineRow,
} from '@/lib/finance/sst-return';
import type { SstSettings } from '@/lib/finance/sst';

const SEP_OCT = { start: '2026-09-01', end: '2026-10-31', due: '2026-11-30' };
const NOV_DEC = { start: '2026-11-01', end: '2026-12-31', due: '2027-01-31' };

let seq = 0;
const line = (over: Partial<SstLineRow> = {}): SstLineRow => {
  seq += 1;
  return {
    id: `l${String(seq).padStart(3, '0')}`,
    invoice_id: `i${seq}`,
    product_id: null,
    description: `Item ${seq}`,
    sst_rate: 6,
    tax_type: 'service',
    sst_code: null,
    amount_myr: 0,
    sst_amount_myr: 0,
    invoice_date: '2026-09-10',
    invoice_status: 'posted',
    voided_on: null,
    ...over,
  };
};

const credit = (over: Partial<SstCreditRow> = {}): SstCreditRow => {
  seq += 1;
  return {
    id: `c${seq}`,
    credit_date: '2026-09-15',
    status: 'issued',
    voided_on: null,
    amount_myr: 0,
    invoice_total_myr: 0,
    invoice_sst_myr: { service: 0, sales: 0 },
    ...over,
  };
};

const item = (lines: SstFormLine[], id: string) => lines.find((l) => l.item === id);

describe('SST_FORM_ITEMS', () => {
  it('lists the form rate items per type', () => {
    expect(SST_FORM_ITEMS.service).toEqual([
      { rate: 6, item: '11(c)', label: 'Service tax 6%' },
      { rate: 8, item: '11(d)', label: 'Service tax 8%' },
    ]);
    expect(SST_FORM_ITEMS.sales).toEqual([
      { rate: 5, item: '11(a)', label: 'Sales tax 5%' },
      { rate: 10, item: '11(b)', label: 'Sales tax 10%' },
    ]);
  });
});

describe('buildSstReturn: service', () => {
  const lines = [
    line({ amount_myr: 5000, sst_amount_myr: 300, sst_rate: 6 }),
    line({ amount_myr: 20000, sst_amount_myr: 1600, sst_rate: 8 }),
  ];

  it('fills B2 items 11(c), 11(d) and the typed 11(e)', () => {
    const r = buildSstReturn('service', SEP_OCT, lines, []);
    expect(r.type).toBe('service');
    expect(r.period).toEqual(SEP_OCT);
    expect(r.b2.map((l) => l.item)).toEqual(['11(c)', '11(d)', '11(e)']);
    expect(item(r.b2, '11(c)')).toMatchObject({ value: 5000, tax: 300 });
    expect(item(r.b2, '11(d)')).toMatchObject({ value: 20000, tax: 1600 });
    expect(item(r.b2, '11(e)')).toEqual({ item: '11(e)', label: 'Credit and charge cards, RM25 each', value: null, tax: 0, typed: true });
    expect(r.item12).toBe(1900);
    expect(r.b1Total).toBe(25000);
  });

  it('takes a credit note share into 13(a) and works out item 14', () => {
    const c = credit({ amount_myr: 1080, invoice_total_myr: 10800, invoice_sst_myr: { service: 800, sales: 0 } });
    const r = buildSstReturn('service', SEP_OCT, lines, [c]);
    expect(r.deductions.map((d) => [d.item, d.typed ?? false])).toEqual([
      ['13(a)', false],
      ['13(c)', true],
      ['13(d)', true],
    ]);
    expect(item(r.deductions, '13(a)')).toEqual({ item: '13(a)', label: 'Tax from credit notes', value: null, tax: 80 });
    expect(item(r.deductions, '13(c)')).toMatchObject({ label: 'Approved service tax deduction', value: null, tax: 0 });
    expect(item(r.deductions, '13(d)')).toMatchObject({ label: 'Bad debt relief (approved)', value: null, tax: 0 });
    expect(r.item14).toBe(1820);
  });

  it('counts an older line with no tax type by its rate', () => {
    const r = buildSstReturn('service', SEP_OCT, [line({ tax_type: null, sst_rate: 8, amount_myr: 100, sst_amount_myr: 8 })], []);
    expect(item(r.b2, '11(d)')).toMatchObject({ value: 100, tax: 8 });
    expect(r.item12).toBe(8);
    expect(r.untyped).toEqual({ count: 0, value: 0 });
  });
});

describe('buildSstReturn: sales', () => {
  it('fills 11(a), 11(b) and the sales deductions', () => {
    const lines = [
      line({ tax_type: 'sales', sst_rate: 5, amount_myr: 1000, sst_amount_myr: 50 }),
      line({ tax_type: 'sales', sst_rate: 10, amount_myr: 2000, sst_amount_myr: 200 }),
      line({ amount_myr: 5000, sst_amount_myr: 300 }),
    ];
    const r = buildSstReturn('sales', SEP_OCT, lines, []);
    expect(r.b2.map((l) => l.item)).toEqual(['11(a)', '11(b)']);
    expect(item(r.b2, '11(a)')).toMatchObject({ label: 'Sales tax 5%', value: 1000, tax: 50 });
    expect(item(r.b2, '11(b)')).toMatchObject({ label: 'Sales tax 10%', value: 2000, tax: 200 });
    expect(r.item12).toBe(250);
    expect(r.b1Total).toBe(3000);
    expect(r.deductions.map((d) => [d.item, d.label, d.typed ?? false])).toEqual([
      ['13(a)', 'Tax from credit notes', false],
      ['13(b)', 'Sales tax deduction', true],
      ['13A', 'Adjustment to the sales tax deduction', true],
      ['13(d)', 'Bad debt relief (approved)', true],
    ]);
    expect(r.item14).toBe(250);
  });

  it('splits a credit note on a mixed invoice by each type of tax', () => {
    const c = credit({ amount_myr: 1000, invoice_total_myr: 10000, invoice_sst_myr: { service: 600, sales: 400 } });
    expect(item(buildSstReturn('service', SEP_OCT, [], [c]).deductions, '13(a)')?.tax).toBe(60);
    expect(item(buildSstReturn('sales', SEP_OCT, [], [c]).deductions, '13(a)')?.tax).toBe(40);
  });

  it('gives a credit note on an invoice of total 0 no tax', () => {
    const c = credit({ amount_myr: 10, invoice_total_myr: 0, invoice_sst_myr: { service: 0, sales: 0 } });
    expect(item(buildSstReturn('service', SEP_OCT, [], [c]).deductions, '13(a)')?.tax).toBe(0);
  });
});

describe('buildSstReturn: lines off the form', () => {
  it('keeps a 7% service line out of B2 and counts it in offForm', () => {
    const r = buildSstReturn('service', SEP_OCT, [line({ sst_rate: 7, amount_myr: 1000, sst_amount_myr: 70 })], []);
    expect(r.b2.every((l) => l.tax === 0)).toBe(true);
    expect(r.item12).toBe(0);
    expect(r.b1).toEqual([]);
    expect(r.offForm).toEqual({ count: 1, value: 1000, tax: 70 });
    expect(buildSstReturn('sales', SEP_OCT, [line({ sst_rate: 7, amount_myr: 1000, sst_amount_myr: 70 })], []).offForm).toEqual({
      count: 0,
      value: 0,
      tax: 0,
    });
  });

  it('counts a line with no type at 7% as untyped on both returns', () => {
    const l = line({ tax_type: null, sst_rate: 7, amount_myr: 400, sst_amount_myr: 28 });
    for (const type of ['service', 'sales'] as const) {
      const r = buildSstReturn(type, SEP_OCT, [l], []);
      expect(r.untyped).toEqual({ count: 1, value: 400 });
      expect(r.offForm).toEqual({ count: 0, value: 0, tax: 0 });
      expect(r.item12).toBe(0);
    }
  });

  it('leaves no-SST and 0% lines out of everything', () => {
    const lines = [
      line({ tax_type: 'none', sst_rate: 0, amount_myr: 900 }),
      line({ tax_type: null, sst_rate: 0, amount_myr: 900 }),
    ];
    for (const type of ['service', 'sales'] as const) {
      const r = buildSstReturn(type, SEP_OCT, lines, []);
      expect(r.b1).toEqual([]);
      expect(r.b1Total).toBe(0);
      expect(r.item12).toBe(0);
      expect(r.offForm).toEqual({ count: 0, value: 0, tax: 0 });
      expect(r.untyped).toEqual({ count: 0, value: 0 });
    }
  });
});

describe('buildSstReturn: voids', () => {
  const base = { amount_myr: 5000, sst_amount_myr: 300, invoice_date: '2026-09-10', invoice_status: 'void' as const };

  it('leaves out an invoice voided in the period it was posted in', () => {
    const r = buildSstReturn('service', SEP_OCT, [line({ ...base, voided_on: '2026-10-05' })], []);
    expect(r.item12).toBe(0);
    expect(r.b1).toEqual([]);
    expect(item(r.deductions, '13(a)')?.tax).toBe(0);
  });

  it('counts an invoice voided later in its own period and its tax in 13(a) of the void period', () => {
    const l = line({ ...base, voided_on: '2026-11-01' });
    const sep = buildSstReturn('service', SEP_OCT, [l], []);
    expect(sep.item12).toBe(300);
    expect(sep.b1Total).toBe(5000);
    expect(item(sep.deductions, '13(a)')?.tax).toBe(0);
    expect(sep.voidedTax).toBe(0);
    const nov = buildSstReturn('service', NOV_DEC, [l], []);
    expect(item(nov.deductions, '13(a)')?.tax).toBe(300);
    expect(nov.voidedTax).toBe(300);
    expect(nov.b1).toEqual([]);
    expect(nov.b1Total).toBe(0);
    expect(nov.item12).toBe(0);
    expect(nov.item14).toBe(-300);
    // A void of a service line does not touch the sales return.
    expect(item(buildSstReturn('sales', NOV_DEC, [l], []).deductions, '13(a)')?.tax).toBe(0);
  });

  it('does not bring an off-form line voided later back through 13(a)', () => {
    const l = line({ ...base, sst_rate: 7, amount_myr: 1000, sst_amount_myr: 70, voided_on: '2026-11-01' });
    expect(buildSstReturn('service', SEP_OCT, [l], []).offForm).toEqual({ count: 1, value: 1000, tax: 70 });
    const nov = buildSstReturn('service', NOV_DEC, [l], []);
    expect(item(nov.deductions, '13(a)')?.tax).toBe(0);
    expect(nov.offForm).toEqual({ count: 0, value: 0, tax: 0 });
    expect(nov.voidedTax).toBe(0);
  });

  it('counts a credit note voided later in its own period and lowers 13(a) of the void period', () => {
    const c = credit({
      credit_date: '2026-09-15',
      status: 'void',
      voided_on: '2026-11-02',
      amount_myr: 1080,
      invoice_total_myr: 10800,
      invoice_sst_myr: { service: 800, sales: 0 },
    });
    expect(item(buildSstReturn('service', SEP_OCT, [], [c]).deductions, '13(a)')?.tax).toBe(80);
    const nov = buildSstReturn('service', NOV_DEC, [], [c]);
    expect(item(nov.deductions, '13(a)')?.tax).toBe(-80);
    expect(nov.item14).toBe(80);
    // A credit note's void is not an invoice's: voidedTax stays 0.
    expect(nov.voidedTax).toBe(0);
  });

  it('leaves out a credit note voided in the period it was issued in', () => {
    const c = credit({ status: 'void', voided_on: '2026-10-30', amount_myr: 1080, invoice_total_myr: 10800, invoice_sst_myr: { service: 800, sales: 0 } });
    expect(item(buildSstReturn('service', SEP_OCT, [], [c]).deductions, '13(a)')?.tax).toBe(0);
  });

  it('leaves out rows dated outside the period', () => {
    const r = buildSstReturn(
      'service',
      SEP_OCT,
      [line({ invoice_date: '2026-08-31', amount_myr: 100, sst_amount_myr: 6 }), line({ invoice_date: '2026-11-01', amount_myr: 100, sst_amount_myr: 6 })],
      [credit({ credit_date: '2026-11-01', amount_myr: 100, invoice_total_myr: 100, invoice_sst_myr: { service: 6, sales: 0 } })],
    );
    expect(r.item12).toBe(0);
    expect(item(r.deductions, '13(a)')?.tax).toBe(0);
  });
});

describe('buildSstReturn: B1', () => {
  it('groups one product under its latest description', () => {
    const r = buildSstReturn(
      'service',
      SEP_OCT,
      [
        line({ product_id: 'p1', description: 'Consultancy', invoice_date: '2026-09-20', amount_myr: 200, sst_amount_myr: 12 }),
        line({ product_id: 'p1', description: 'Consult', invoice_date: '2026-09-03', amount_myr: 100, sst_amount_myr: 6 }),
      ],
      [],
    );
    expect(r.b1).toHaveLength(1);
    expect(r.b1[0]).toMatchObject({ description: 'Consultancy', code: null, value: 300, ownUse: 0 });
  });

  it('groups lines without a product by trimmed, lower-cased description', () => {
    const r = buildSstReturn(
      'service',
      SEP_OCT,
      [
        line({ description: 'Delivery ', invoice_date: '2026-09-05', amount_myr: 10, sst_amount_myr: 0.6 }),
        line({ description: 'delivery', invoice_date: '2026-09-06', amount_myr: 20, sst_amount_myr: 1.2 }),
      ],
      [],
    );
    expect(r.b1).toHaveLength(1);
    expect(r.b1[0]).toMatchObject({ description: 'delivery', value: 30 });
  });

  it('keeps one product under two codes as two rows, sorted by description', () => {
    const r = buildSstReturn(
      'service',
      SEP_OCT,
      [
        line({ product_id: 'p2', description: 'Zeta work', sst_code: 'B', amount_myr: 50, sst_amount_myr: 3 }),
        line({ product_id: 'p2', description: 'Zeta work', sst_code: 'A', amount_myr: 70, sst_amount_myr: 4.2 }),
        line({ product_id: 'p3', description: 'alpha', amount_myr: 30, sst_amount_myr: 2.4, sst_rate: 8 }),
      ],
      [],
    );
    // Case-insensitive by description, then by code.
    expect(r.b1.map((b) => [b.description, b.code, b.value])).toEqual([
      ['alpha', null, 30],
      ['Zeta work', 'A', 70],
      ['Zeta work', 'B', 50],
    ]);
    expect(r.b1Total).toBe(150);
    expect(r.b1Total).toBe(r.b2.reduce((s, l) => s + (l.value ?? 0), 0));
  });

  it('adds in whole sen', () => {
    const r = buildSstReturn(
      'service',
      SEP_OCT,
      [0, 1, 2].map(() => line({ product_id: 'p9', description: 'Tiny', amount_myr: 0.1, sst_amount_myr: 0.1 })),
      [],
    );
    expect(r.b1[0].value).toBe(0.3);
    expect(r.b1Total).toBe(0.3);
    expect(item(r.b2, '11(c)')).toMatchObject({ value: 0.3, tax: 0.3 });
    expect(r.item12).toBe(0.3);
  });
});

describe('buildSstReturn: an empty period', () => {
  it('is all zeros', () => {
    for (const type of ['service', 'sales'] as const) {
      const r = buildSstReturn(type, SEP_OCT, [], []);
      expect(r.b1).toEqual([]);
      expect(r.b1Total).toBe(0);
      expect(r.b2.every((l) => l.tax === 0)).toBe(true);
      expect(r.item12).toBe(0);
      expect(item(r.deductions, '13(a)')?.tax).toBe(0);
      expect(r.item14).toBe(0);
      expect(r.offForm).toEqual({ count: 0, value: 0, tax: 0 });
      expect(r.untyped).toEqual({ count: 0, value: 0 });
    }
  });
});

describe('recentSstPeriods', () => {
  it('lists the last twelve periods, newest first', () => {
    const ps = recentSstPeriods('2026-10-22', 9);
    expect(ps).toHaveLength(12);
    expect(ps[0]).toEqual(SEP_OCT);
    expect(ps[1].start).toBe('2026-07-01');
    expect(ps[11]).toEqual({ start: '2024-11-01', end: '2024-12-31', due: '2025-01-31' });
  });

  it('takes a count and crosses a year end', () => {
    const ps = recentSstPeriods('2027-01-05', 1, 3);
    expect(ps.map((p) => p.start)).toEqual(['2027-01-01', '2026-11-01', '2026-09-01']);
  });
});

describe('pickSstView', () => {
  const settings = (over: Partial<SstSettings> = {}): SstSettings => ({
    period_start_month: 9,
    service_tax_no: null,
    sales_tax_no: null,
    service_tax_basis: 'invoice',
    ...over,
  });
  const today = '2026-10-22';

  it('shows sales when only a sales tax number is set, else service', () => {
    expect(pickSstView({}, settings({ sales_tax_no: 'S1' }), today)).toEqual({ type: 'sales', period: SEP_OCT });
    expect(pickSstView({}, settings({ sales_tax_no: 'S1', service_tax_no: 'V1' }), today).type).toBe('service');
    expect(pickSstView({}, settings(), today).type).toBe('service');
  });

  it('falls back to the current period for a date that is not a period start, or in the future', () => {
    expect(pickSstView({ period: '2026-08-01' }, settings(), today).period).toEqual(SEP_OCT);
    expect(pickSstView({ period: '2027-01-01' }, settings(), today).period).toEqual(SEP_OCT);
    expect(pickSstView({ period: '2026-02-30' }, settings(), today).period).toEqual(SEP_OCT);
    expect(pickSstView({ period: 'nonsense' }, settings(), today).period).toEqual(SEP_OCT);
  });

  it('takes the tax and period asked for', () => {
    expect(pickSstView({ tax: 'service', period: '2026-07-01' }, settings({ sales_tax_no: 'S1' }), today)).toEqual({
      type: 'service',
      period: { start: '2026-07-01', end: '2026-08-31', due: '2026-09-30' },
    });
    expect(pickSstView({ tax: ['sales', 'service'], period: ['2026-09-01', '2026-07-01'] }, settings(), today)).toEqual({
      type: 'sales',
      period: SEP_OCT,
    });
    expect(pickSstView({ tax: 'bogus' }, settings({ sales_tax_no: 'S1' }), today).type).toBe('sales');
  });
});
