import { describe, expect, it } from 'vitest';
import { buildSstReturn, type SstCreditRow, type SstLineRow, type SstPaidInvoice } from '@/lib/finance/sst-return';

/*
 * Service tax on payment basis (#222 stage 3): the return counts the money received, not the invoice date.
 * Tax to date is the paid share of the invoice's own tax, capped at the invoice total, less what credit notes
 * have taken off; a period's figure is the change in that. The reply on 3 Nov: rounding follows the
 * running total, and a fall goes to 13(a), never to a negative B2 line.
 */

const SEP_OCT = { start: '2026-09-01', end: '2026-10-31', due: '2026-11-30' };
const NOV_DEC = { start: '2026-11-01', end: '2026-12-31', due: '2027-01-31' };

/** The invoice's one line: 1,000.00 of taxable service plus 60.00 of tax. */
const line = (over: Partial<SstLineRow> = {}): SstLineRow => ({
  id: 'l1',
  invoice_id: 'inv-a',
  product_id: null,
  description: 'Consulting',
  sst_rate: 6,
  tax_type: 'service',
  sst_code: 'S12',
  amount_myr: 1000,
  sst_amount_myr: 60,
  invoice_date: '2026-08-05',
  invoice_status: 'posted',
  voided_on: null,
  ...over,
});

const paidInvoice = (over: Partial<SstPaidInvoice> = {}): SstPaidInvoice => ({
  invoice_id: 'inv-a',
  invoice_date: '2026-08-05',
  total_myr: 1060,
  sst_myr: { service: 60, sales: 0 },
  receipts: [],
  credits: [],
  rows: [line()],
  ...over,
});

const item = (rows: { item: string; value: number | null; tax: number }[], id: string) => rows.find((r) => r.item === id)!;

describe('buildSstReturn on payment basis', () => {
  it('counts a receipt against an invoice issued before the period', () => {
    const inv = paidInvoice({ receipts: [{ id: 'r1', paid_on: '2026-09-10', amount_myr: 530 }] });
    const ret = buildSstReturn('service', SEP_OCT, [], [], undefined, { basis: 'payment', paid: [inv] });

    expect(ret.item12).toBe(30);
    expect(item(ret.b2, '11(c)').value).toBe(500);
    expect(item(ret.b2, '11(c)').tax).toBe(30);
    expect(ret.b1).toHaveLength(1);
    expect(ret.b1[0]).toMatchObject({ description: 'Consulting', code: 'S12', value: 500 });
    expect(ret.item14).toBe(30);
  });

  it('rounds on the running total, so the periods add up to the invoice tax', () => {
    const inv = paidInvoice({
      receipts: [
        { id: 'r1', paid_on: '2026-07-15', amount_myr: 197.73 },
        { id: 'r2', paid_on: '2026-09-20', amount_myr: 517.51 },
        { id: 'r3', paid_on: '2026-11-05', amount_myr: 344.76 },
      ],
    });
    const sep = buildSstReturn('service', SEP_OCT, [], [], undefined, { basis: 'payment', paid: [inv] });
    const nov = buildSstReturn('service', NOV_DEC, [], [], undefined, { basis: 'payment', paid: [inv] });

    expect(sep.item12).toBe(29.3);
    expect(nov.item12).toBe(19.51);
    // 11.19 before the period, then 29.30 and 19.51: 60.00 in all, where rounding each receipt alone gives 59.99.
    expect(Math.round((11.19 + sep.item12 + nov.item12) * 100)).toBe(6000);
  });

  it('puts a fall in 13(a) when a credit note takes the tax down, and no negative B2 line', () => {
    const inv = paidInvoice({
      receipts: [{ id: 'r1', paid_on: '2026-09-10', amount_myr: 530 }],
      credits: [{ credit_date: '2026-11-10', amount_myr: 800 }],
    });
    const sep = buildSstReturn('service', SEP_OCT, [], [], undefined, { basis: 'payment', paid: [inv] });
    const nov = buildSstReturn('service', NOV_DEC, [], [], undefined, { basis: 'payment', paid: [inv] });

    expect(sep.item12).toBe(30);
    // 800.00 off a 1,060.00 invoice leaves 260.00 carrying 14.72 of tax, all of it counted once the 530.00 is in.
    expect(nov.item12).toBe(0);
    expect(item(nov.deductions, '13(a)').tax).toBe(15.28);
    expect(nov.item14).toBe(-15.28);
    expect(item(nov.b2, '11(c)').value).toBe(0);
    expect(nov.b1).toHaveLength(0);
  });

  it('counts nothing for an invoice issued in the period that has not been paid', () => {
    const inv = paidInvoice({ invoice_date: '2026-09-12', rows: [line({ invoice_date: '2026-09-12' })] });
    const ret = buildSstReturn('service', SEP_OCT, [], [], undefined, { basis: 'payment', paid: [inv] });

    expect(ret.item12).toBe(0);
    expect(ret.item14).toBe(0);
    expect(ret.b1).toHaveLength(0);
  });

  it('does not count the same receipt twice when a later period is read', () => {
    const inv = paidInvoice({ receipts: [{ id: 'r1', paid_on: '2026-09-10', amount_myr: 1060 }] });
    const sep = buildSstReturn('service', SEP_OCT, [], [], undefined, { basis: 'payment', paid: [inv] });
    const nov = buildSstReturn('service', NOV_DEC, [], [], undefined, { basis: 'payment', paid: [inv] });

    expect(sep.item12).toBe(60);
    expect(nov.item12).toBe(0);
  });

  it('never puts a sales return on payment basis', () => {
    const sales = line({ sst_rate: 10, tax_type: 'sales', amount_myr: 1000, sst_amount_myr: 100, invoice_date: '2026-09-10' });
    const credit: SstCreditRow = {
      id: 'c1',
      credit_date: '2026-09-20',
      status: 'issued',
      voided_on: null,
      amount_myr: 550,
      invoice_total_myr: 1100,
      invoice_sst_myr: { service: 0, sales: 100 },
    };
    const onInvoices = buildSstReturn('sales', SEP_OCT, [sales], [credit], undefined, { basis: 'invoice' });
    const onPayments = buildSstReturn('sales', SEP_OCT, [sales], [credit], undefined, { basis: 'payment', paid: [] });

    expect(onInvoices.item12).toBe(100);
    expect(onPayments).toEqual(onInvoices);
  });

  it('notes a paid line at a rate the form has no item for, and a line with no tax type', () => {
    const inv = paidInvoice({
      total_myr: 2700,
      sst_myr: { service: 200, sales: 0 },
      receipts: [{ id: 'r1', paid_on: '2026-09-10', amount_myr: 1350 }],
      rows: [
        line({ id: 'l1', sst_rate: 10, amount_myr: 1000, sst_amount_myr: 100 }),
        line({ id: 'l2', sst_rate: 7, tax_type: null, amount_myr: 500, sst_amount_myr: 35 }),
        line({ id: 'l3', sst_rate: 6, amount_myr: 1000, sst_amount_myr: 60 }),
        line({ id: 'l4', sst_rate: 10, tax_type: 'sales', amount_myr: 100, sst_amount_myr: 10 }),
      ],
    });
    const sep = buildSstReturn('service', SEP_OCT, [], [], undefined, { basis: 'payment', paid: [inv] });
    const nov = buildSstReturn('service', NOV_DEC, [], [], undefined, { basis: 'payment', paid: [inv] });

    // Half paid in Sep–Oct: each line is noted at half its value, and the sales line is not this return's.
    expect(sep.offForm).toEqual({ count: 1, value: 500, tax: 50 });
    expect(sep.untyped).toEqual({ count: 1, value: 250 });
    expect(sep.item12).toBe(30);
    // Nothing more arrives, so a later period notes nothing again.
    expect(nov.offForm.count).toBe(0);
    expect(nov.untyped.count).toBe(0);
  });

  it('leaves the invoice basis alone when it is not asked for', () => {
    const inv = paidInvoice({ receipts: [{ id: 'r1', paid_on: '2026-09-10', amount_myr: 1060 }] });
    const ret = buildSstReturn('service', SEP_OCT, [line({ invoice_date: '2026-09-10' })], [], undefined, {
      basis: 'invoice',
      paid: [inv],
    });

    expect(ret.item12).toBe(60);
    expect(ret.b1).toHaveLength(1);
  });
});
