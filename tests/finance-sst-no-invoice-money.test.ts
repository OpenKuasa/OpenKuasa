import { describe, expect, it } from 'vitest';
import { readSstNoInvoiceMoney } from '@/lib/finance/sst-return-data';
import { fakeFinance } from './setup/fake-finance';

/*
 * Money received with no invoice behind it (#222). A receipt can name an income category and settle nothing
 * (FIN15), so no invoice line carries its rate and the return has nowhere to put it. The screen names the money
 * instead, and this is the read behind that note: the posted income receipts of the period, from the same view
 * the Cash Receipts screen lists, which already leaves out transfers between the workspace's own accounts.
 */

const SEP_OCT = { start: '2026-09-01', end: '2026-10-31', due: '2026-11-30' };

describe('readSstNoInvoiceMoney', () => {
  it('adds up the ringgit of the posted income receipts', async () => {
    // One receipt in ringgit, one into a foreign account with its ringgit figure.
    const { ctx } = fakeFinance({
      data: [
        { transaction_id: 't-ringgit', amount_myr: 1000 },
        { transaction_id: 't-foreign', amount_myr: 1800 },
      ],
      error: null,
    });
    expect(await readSstNoInvoiceMoney(ctx, SEP_OCT)).toEqual({ count: 2, amount_myr: 2800 });
  });

  it('asks the cash receipts view for income receipts only, posted, dated in the period', async () => {
    const { ctx, calls } = fakeFinance({ data: [], error: null });
    await readSstNoInvoiceMoney(ctx, SEP_OCT);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('finance_cash_receipts');
    expect(calls[0].columns).toBe('transaction_id,amount_myr');
    expect(calls[0].filters).toMatchObject({
      org_id: 'org-1',
      kind: 'income',
      status: 'posted',
      'txn_date gte': '2026-09-01',
      'txn_date lte': '2026-10-31',
    });
  });

  it('is nothing when the period holds no income receipt', async () => {
    const { ctx } = fakeFinance({ data: [], error: null });
    expect(await readSstNoInvoiceMoney(ctx, SEP_OCT)).toEqual({ count: 0, amount_myr: 0 });
  });

  it('adds whole sen, so cents do not drift', async () => {
    const { ctx } = fakeFinance({
      data: [
        { transaction_id: 'a', amount_myr: 0.1 },
        { transaction_id: 'b', amount_myr: 0.2 },
      ],
      error: null,
    });
    expect(await readSstNoInvoiceMoney(ctx, SEP_OCT)).toEqual({ count: 2, amount_myr: 0.3 });
  });

  it('throws when the read fails, as the other reads of the return do', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: '57014', message: 'timeout' } });
    await expect(readSstNoInvoiceMoney(ctx, SEP_OCT)).rejects.toMatchObject({ code: '57014' });
  });
});
