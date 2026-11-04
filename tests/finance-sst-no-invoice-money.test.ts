import { describe, expect, it } from 'vitest';
import { buildSstReturn } from '@/lib/finance/sst-return';
import { readSstNoInvoiceMoney } from '@/lib/finance/sst-return-data';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

/*
 * Money received with no invoice behind it (#222). A receipt can name an income category and settle nothing
 * (FIN15), so no invoice line carries its rate and the return has nowhere to put it. The screen names the money
 * instead, and this is the read behind that note: posted money in, in the period, on a row that no allocation
 * names. A transfer between the workspace's own accounts is not money received, so it is excluded by the read.
 */

const SEP_OCT = { start: '2026-09-01', end: '2026-10-31', due: '2026-11-30' };

const receipt = (id: string, amount: number, amount_myr: number | null) => ({ id, amount, amount_myr });

const answer = (call: FinanceCall) => {
  if (call.name === 'finance_transactions') {
    return {
      data: [
        // Two receipts that settle nothing: one in ringgit, one in a foreign account with its ringgit figure.
        receipt('t-unallocated-ringgit', 1000, null),
        receipt('t-unallocated-foreign', 400, 1800),
        // This one pays an invoice, so it is not the money the note is about.
        receipt('t-allocated', 530, null),
      ],
      error: null,
    };
  }
  if (call.name === 'finance_allocations') {
    return { data: [{ id: 'a1', transaction_id: 't-allocated' }], error: null };
  }
  return { data: [], error: null };
};

describe('readSstNoInvoiceMoney', () => {
  it('counts the posted money in that no allocation names, in ringgit', async () => {
    const { ctx } = fakeFinance(answer);
    expect(await readSstNoInvoiceMoney(ctx, SEP_OCT)).toEqual({ count: 2, amount_myr: 2800 });
  });

  it('asks only for money in, posted, not a transfer, dated in the period', async () => {
    const { ctx, calls } = fakeFinance(answer);
    await readSstNoInvoiceMoney(ctx, SEP_OCT);
    const read = calls.find((c) => c.name === 'finance_transactions')!;
    expect(read.columns).toBe('id,amount,amount_myr');
    expect(read.filters).toMatchObject({
      org_id: 'org-1',
      direction: 'in',
      status: 'posted',
      'transfer_id is': null,
      'txn_date gte': '2026-09-01',
      'txn_date lte': '2026-10-31',
    });
    // One read per chunk of the ids it found, and no read when there are none.
    const allocations = calls.filter((c) => c.name === 'finance_allocations');
    expect(allocations).toHaveLength(1);
    expect(allocations[0].filters).toEqual({
      org_id: 'org-1',
      'transaction_id in': ['t-unallocated-ringgit', 't-unallocated-foreign', 't-allocated'],
    });
  });

  it('is nothing, and reads no allocation, when the period holds no money in', async () => {
    const { ctx, calls } = fakeFinance({ data: [], error: null });
    expect(await readSstNoInvoiceMoney(ctx, SEP_OCT)).toEqual({ count: 0, amount_myr: 0 });
    expect(calls.filter((c) => c.name === 'finance_allocations')).toHaveLength(0);
  });

  it('is nothing when every receipt pays an invoice', async () => {
    const onlyAllocated = (call: FinanceCall) =>
      call.name === 'finance_transactions'
        ? { data: [receipt('t-allocated', 530, null)], error: null }
        : { data: [{ id: 'a1', transaction_id: 't-allocated' }], error: null };
    const { ctx } = fakeFinance(onlyAllocated);
    expect(await readSstNoInvoiceMoney(ctx, SEP_OCT)).toEqual({ count: 0, amount_myr: 0 });
  });
});

describe('the return names the money it cannot count', () => {
  it('carries the money the read found, and leaves item 12 alone', () => {
    const ret = buildSstReturn('service', SEP_OCT, [], [], undefined, { noInvoice: { count: 2, amount_myr: 2800 } });
    expect(ret.noInvoice).toEqual({ count: 2, amount: 2800 });
    // Money with no invoice has no rate, so it is on no item of the form.
    expect(ret.item12).toBe(0);
    expect(ret.item14).toBe(0);
  });

  it('is nothing when the option is not given', () => {
    expect(buildSstReturn('service', SEP_OCT, [], []).noInvoice).toEqual({ count: 0, amount: 0 });
  });
});
