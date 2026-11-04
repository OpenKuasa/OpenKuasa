import { describe, expect, it } from 'vitest';
import { buildSstReturn } from '@/lib/finance/sst-return';
import { readSstPaidInvoices } from '@/lib/finance/sst-return-data';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

/*
 * The read behind a payment-basis return (#222 stage 3): the invoices the period moves, each with its own lines,
 * the money received up to the period's end, and the credit notes issued on it.
 */

const SEP_OCT = { start: '2026-09-01', end: '2026-10-31', due: '2026-11-30' };

const line = {
  id: 'l1',
  invoice_id: 'inv-a',
  product_id: null,
  description: 'Consulting',
  sst_rate: 6,
  tax_type: 'service',
  sst_code: 'S12',
  amount_myr: 1000,
  sst_amount_myr: 60,
  finance_invoices: { invoice_date: '2026-08-05', status: 'posted', voided_at: null },
};

const allocation = (id: string, transaction: string, amount: number) => ({
  id,
  invoice_id: 'inv-a',
  transaction_id: transaction,
  amount,
  amount_myr: null,
  carried_myr: null,
});

/** One receipt in the span, one receipt before it, and one credit note before it. */
const answer = (call: FinanceCall) => {
  if (call.name === 'finance_transactions' && call.columns === 'id') return { data: [{ id: 't1' }], error: null };
  if (call.name === 'finance_transactions') {
    return {
      data: [
        { id: 't1', txn_date: '2026-09-10', direction: 'in', status: 'posted' },
        { id: 't0', txn_date: '2026-07-20', direction: 'in', status: 'posted' },
        { id: 't9', txn_date: '2026-09-15', direction: 'out', status: 'posted' },
      ],
      error: null,
    };
  }
  if (call.name === 'finance_allocations' && call.columns === 'id,invoice_id') {
    return { data: [{ id: 'a1', invoice_id: 'inv-a' }], error: null };
  }
  if (call.name === 'finance_allocations') {
    return {
      data: [allocation('a1', 't1', 530), allocation('a0', 't0', 265), allocation('a9', 't9', 100)],
      error: null,
    };
  }
  if (call.name === 'finance_invoice_lines') return { data: [line], error: null };
  if (call.name === 'finance_credit_notes' && call.columns === 'id,invoice_id,credit_date,amount,amount_myr') {
    return { data: [{ id: 'n0', invoice_id: 'inv-a', credit_date: '2026-08-20', amount: 106, amount_myr: null }], error: null };
  }
  return { data: [], error: null };
};

describe('readSstPaidInvoices', () => {
  it('reads an invoice with the money in before the period, the money in the period, and the credit off it', async () => {
    const { ctx, calls } = fakeFinance(answer);
    const [inv] = await readSstPaidInvoices(ctx, SEP_OCT);

    expect(inv.invoice_id).toBe('inv-a');
    expect(inv.total_myr).toBe(1060);
    expect(inv.sst_myr.service).toBe(60);
    // Money out is not money received, so the refund is left out; the receipts are oldest first.
    expect(inv.receipts.map((r) => [r.paid_on, r.amount_myr])).toEqual([
      ['2026-07-20', 265],
      ['2026-09-10', 530],
    ]);
    expect(inv.credits.map((c) => [c.credit_date, c.amount_myr])).toEqual([['2026-08-20', 106]]);
    expect(inv.rows).toHaveLength(1);

    // Only the span's receipts are looked for; the rest of the invoice's are read by its id.
    const spanRead = calls.find((c) => c.name === 'finance_transactions' && c.columns === 'id')!;
    expect(spanRead.filters).toMatchObject({ direction: 'in', status: 'posted', 'txn_date gte': '2026-09-01', 'txn_date lte': '2026-10-31' });
  });

  it('builds the period figure from what it read', async () => {
    const { ctx } = fakeFinance(answer);
    const paid = await readSstPaidInvoices(ctx, SEP_OCT);
    const ret = buildSstReturn('service', SEP_OCT, [], [], undefined, { basis: 'payment', paid });

    // 265.00 of the invoice counted before the period and 795.00 by its end: three quarters of its 60.00 of tax,
    // of which a quarter was already in, so 30.00 this period.
    expect(ret.item12).toBe(30);
    expect(ret.b2[0].value).toBe(500);
  });

  it('reads nothing when the period moves no invoice', async () => {
    const { ctx } = fakeFinance({ data: [], error: null });
    expect(await readSstPaidInvoices(ctx, SEP_OCT)).toEqual([]);
  });
});
