import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postCashReceipt, recordCashReceipt, voidCashReceipt } from '@/lib/finance/cash-receipts';
import { recordPaymentIn, voidPaymentIn } from '@/lib/finance/money';
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';

// FIN77 and FIN78 (20261202100000): money in dated inside a service return marked filed, on a payment-basis
// workspace. The database words the refusal, naming the period and the ways out, so every money-in path shows
// that sentence instead of the general "could not be saved", and nothing is logged as a failure.

const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const INVOICE = '77777777-7777-4777-8777-777777777777';
const CATEGORY = '99999999-9999-4999-8999-999999999999';

const POSTED =
  'This receipt is dated in the 1 Sep – 31 Oct 2026 service tax return, which counts service tax on the money received. Date it in the current period, or take the filed mark off the return and file an amended return (Pindaan).';
const VOIDED =
  'This receipt is on the 1 Sep – 31 Oct 2026 service tax return, which counts service tax on the money received. If the receipt should never have been posted, take the filed mark off the return, void the receipt, and file an amended return (Pindaan).';

/** The receipt or payment-in check finds the row; every write gets `other`. */
const shownThen = (other: FinanceAnswer) => (call: FinanceCall) =>
  call.name === 'finance_cash_receipts' || call.name === 'finance_payments_in'
    ? { data: [{ transaction_id: TXN }], error: null }
    : other;
const refusedWith = (code: string, message: string) => shownThen({ data: null, error: { code, message } });

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

describe('money in dated inside a filed service return', () => {
  it('shows the database’s own sentence when posting is refused (FIN77)', async () => {
    const posted = { ok: false, error: POSTED };
    expect(await postCashReceipt(fakeFinance(refusedWith('FIN77', POSTED)).ctx, { id: TXN })).toEqual(posted);
    expect(
      await recordCashReceipt(fakeFinance(refusedWith('FIN77', POSTED)).ctx, {
        account_id: ACCOUNT, txn_date: '2026-10-15', method: 'cash', category_id: CATEGORY, amount: 50, party_name: 'Walk-in',
      }),
    ).toEqual(posted);
    expect(
      await recordPaymentIn(fakeFinance(refusedWith('FIN77', POSTED)).ctx, {
        account_id: ACCOUNT, txn_date: '2026-10-15', method: 'fpx', allocations: [{ invoice_id: INVOICE, amount: 100 }],
      }),
    ).toEqual(posted);
    expect(logged).not.toHaveBeenCalled();
  });

  it('shows the database’s own sentence when voiding is refused (FIN78)', async () => {
    const voided = { ok: false, error: VOIDED };
    expect(await voidCashReceipt(fakeFinance(refusedWith('FIN78', VOIDED)).ctx, { id: TXN })).toEqual(voided);
    expect(await voidPaymentIn(fakeFinance(refusedWith('FIN78', VOIDED)).ctx, { id: TXN })).toEqual(voided);
    expect(logged).not.toHaveBeenCalled();
  });

  it('falls back to the general message when the refusal carries no sentence', async () => {
    expect(await voidCashReceipt(fakeFinance(shownThen({ data: null, error: { code: 'FIN78' } })).ctx, { id: TXN })).toEqual({
      ok: false, error: 'That change could not be saved. Please try again.',
    });
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
