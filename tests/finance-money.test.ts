import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteScheduledPayment,
  markPaymentPaid,
  recordPaymentOut,
  recordPaymentOutInput,
  voidPayment,
} from '@/lib/finance/money';
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';

const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const BILL_1 = '77777777-7777-4777-8777-777777777777';
const BILL_2 = '88888888-8888-4888-8888-888888888888';

/** The shared stand-in for the Supabase client. One canned answer is given to every request, the payments-out check included. */
const fakeClient = (answer: FinanceAnswer) => fakeFinance(answer);

/**
 * Answers the payments-out check with a row (a payment to a supplier) or none
 * (a refund, or any other money out), and everything else with `other`.
 */
const paymentOr = (isPaymentOut: boolean, other: FinanceAnswer) => (call: FinanceCall) =>
  call.name === 'finance_payments_out' ? { data: isPaymentOut ? [{ transaction_id: TXN }] : [], error: null } : other;

const valid = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx' as const,
  allocations: [{ bill_id: BILL_1, amount: 100 }],
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => recordPaymentOutInput.safeParse(value).error?.issues[0]?.message;

describe('recordPaymentOutInput', () => {
  it('asks for an account, a real date and a known method', () => {
    expect(first({ ...valid, account_id: '' })).toBe('Choose the account the money leaves.');
    expect(first({ ...valid, txn_date: '5 Oct' })).toBe('Enter a valid date.');
    expect(first({ ...valid, method: 'barter' })).toBe('Choose how it was paid.');
  });
  it('asks for at least one bill, each once, each with an amount above 0', () => {
    expect(first({ ...valid, allocations: [] })).toBe('Choose at least one bill to pay.');
    expect(first({ ...valid, allocations: [{ bill_id: BILL_1, amount: 0 }] })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, allocations: [{ bill_id: BILL_1, amount: 1 }, { bill_id: BILL_1, amount: 2 }] }))
      .toBe('Each bill can appear once on a payment.');
  });
  it('rounds amounts to two decimals and defaults to a payment made now', () => {
    const parsed = recordPaymentOutInput.parse({ ...valid, reference: ' ', allocations: [{ bill_id: BILL_1, amount: 32.506 }] });
    expect(parsed).toMatchObject({ scheduled: false, reference: null, notes: null });
    expect(parsed.allocations).toEqual([{ bill_id: BILL_1, amount: 32.51 }]);
  });
});

describe('recordPaymentOutInput rounding', () => {
  it('refuses an amount that rounds to 0 and rounds a half cent up', () => {
    expect(first({ ...valid, allocations: [{ bill_id: BILL_1, amount: 0.004 }] })).toBe('Enter an amount above 0.');
    expect(recordPaymentOutInput.parse({ ...valid, allocations: [{ bill_id: BILL_1, amount: 0.005 }] }).allocations)
      .toEqual([{ bill_id: BILL_1, amount: 0.01 }]);
  });
});

describe('payment writes', () => {
  it('records through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeClient({ data: TXN, error: null });
    const result = await recordPaymentOut(ctx, {
      ...valid,
      allocations: [{ bill_id: BILL_1, amount: 100 }, { bill_id: BILL_2, amount: 32.5 }],
    });
    expect(result).toEqual({ ok: true, data: { id: TXN } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_record_payment_out' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      payment: { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', reference: null, notes: null, status: 'posted' },
      allocations: [{ bill_id: BILL_1, amount: 100 }, { bill_id: BILL_2, amount: 32.5 }],
    });
  });
  it('sends a scheduled payment as scheduled', async () => {
    const { ctx, calls } = fakeClient({ data: TXN, error: null });
    await recordPaymentOut(ctx, { ...valid, scheduled: true });
    expect((calls[0].args!.payment as { status: string }).status).toBe('scheduled');
  });
  it('marks a scheduled payment paid and returns its number, once the payments-out view has shown it', async () => {
    const { ctx, calls } = fakeFinance(paymentOr(true, { data: 'PV-0003', error: null }));
    expect(await markPaymentPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual({ ok: true, data: { id: TXN, number: 'PV-0003' } });
    expect(calls[0]).toMatchObject({
      name: 'finance_payments_out', op: 'select', filters: { org_id: 'org-1', transaction_id: TXN }, limit: 1,
    });
    expect(calls[0].columns).toBe('transaction_id');
    expect(calls[1]).toMatchObject({ kind: 'rpc', name: 'finance_mark_payment_paid' });
    expect(calls[1].args).toEqual({ target_org: 'org-1', target_txn: TXN, paid_on: '2026-10-09' });
    expect(calls).toHaveLength(2);
  });
  it('voids by setting the status and deletes a scheduled payment, both kept to money out and to the workspace', async () => {
    const voided = fakeFinance(paymentOr(true, { data: { id: TXN }, error: null }));
    expect(await voidPayment(voided.ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(voided.calls[0]).toMatchObject({ name: 'finance_payments_out', filters: { org_id: 'org-1', transaction_id: TXN } });
    expect(voided.calls[1]).toMatchObject({ name: 'finance_transactions', op: 'update' });
    expect(Object.keys(voided.calls[1].values!).sort()).toEqual(['status', 'updated_at']);
    expect(voided.calls[1].values).toMatchObject({ status: 'void' });
    expect(voided.calls[1].filters).toEqual({ id: TXN, org_id: 'org-1', direction: 'out' });

    const removed = fakeFinance(paymentOr(true, { data: { id: TXN }, error: null }));
    expect(await deleteScheduledPayment(removed.ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(removed.calls[0]).toMatchObject({ name: 'finance_payments_out', filters: { org_id: 'org-1', transaction_id: TXN } });
    expect(removed.calls[1]).toMatchObject({ name: 'finance_transactions', op: 'delete' });
    expect(removed.calls[1].filters).toEqual({ id: TXN, org_id: 'org-1', direction: 'out' });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN03', 'The amounts against the bills add up to more than the payment.'],
      ['FIN04', 'A payment can only go against a posted bill.'],
      ['FIN05', 'That is more than is still owed on a bill.'],
      ['FIN06', 'One payment can only pay bills from one supplier.'],
      ['FIN09', 'This payment is posted and can no longer be changed. Void it instead.'],
      ['FIN11', 'That payment no longer exists.'],
      ['FIN14', 'Only an owner or admin can post, pay or void. Ask one of them to do this.'],
      ['23503', 'The account or a bill on this payment no longer exists.'],
    ];
    for (const [code, message] of cases) {
      // The view has shown the payment; the write itself is what the database refuses.
      const { ctx } = fakeFinance(paymentOr(true, { data: null, error: { code } }));
      expect(await recordPaymentOut(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await markPaymentPaid(ctx, { id: TXN, paid_on: '2026-10-09' }), code).toEqual({ ok: false, error: message });
      expect(await voidPayment(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
      expect(await deleteScheduledPayment(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says the payment is gone when void or delete touches no row', async () => {
    const { ctx } = fakeFinance(paymentOr(true, { data: null, error: null }));
    expect(await voidPayment(ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
    expect(await deleteScheduledPayment(ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
  });
});

describe('money out that is not a payment to a supplier', () => {
  const gone = { ok: false, error: 'That payment no longer exists.' };

  it('is refused without a write: a refund’s id marks nothing paid, voids nothing and deletes nothing', async () => {
    // The payments-out view joins each allocation to its bill, so a refund is never in it.
    const marked = fakeFinance(paymentOr(false, { data: 'PV-0007', error: null }));
    expect(await markPaymentPaid(marked.ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual(gone);
    expect(marked.calls.map((c) => c.kind)).toEqual(['table']);
    expect(marked.calls.map((c) => c.name)).toEqual(['finance_payments_out']);

    const voided = fakeFinance(paymentOr(false, { data: { id: TXN }, error: null }));
    expect(await voidPayment(voided.ctx, { id: TXN })).toEqual(gone);
    expect(voided.calls.map((c) => c.name)).toEqual(['finance_payments_out']);
    expect(voided.calls.map((c) => c.op)).toEqual(['select']);

    const removed = fakeFinance(paymentOr(false, { data: { id: TXN }, error: null }));
    expect(await deleteScheduledPayment(removed.ctx, { id: TXN })).toEqual(gone);
    expect(removed.calls.map((c) => c.name)).toEqual(['finance_payments_out']);
    expect(removed.calls.map((c) => c.op)).toEqual(['select']);
  });
  it('is refused the same way when the view answers with nothing at all', async () => {
    const empty = (call: FinanceCall) => (call.name === 'finance_payments_out' ? { data: null, error: null } : { data: { id: TXN }, error: null });
    const { ctx, calls } = fakeFinance(empty);
    expect(await voidPayment(ctx, { id: TXN })).toEqual(gone);
    expect(calls).toHaveLength(1);
  });
  it('asks the view for one row only: a payment split across bills is several rows there', async () => {
    const split = (call: FinanceCall) =>
      call.name === 'finance_payments_out' ? { data: [{ transaction_id: TXN }], error: null } : { data: { id: TXN }, error: null };
    const { ctx, calls } = fakeFinance(split);
    expect(await voidPayment(ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls[0].limit).toBe(1);
  });
  it('logs and gives the general message when the check cannot be read, and writes nothing', async () => {
    const failing = (call: FinanceCall) =>
      call.name === 'finance_payments_out' ? { data: null, error: { code: 'XX000' } } : { data: { id: TXN }, error: null };
    const general = { ok: false, error: 'That change could not be saved. Please try again.' };
    const { ctx, calls } = fakeFinance(failing);
    expect(await markPaymentPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual(general);
    expect(await voidPayment(ctx, { id: TXN })).toEqual(general);
    expect(await deleteScheduledPayment(ctx, { id: TXN })).toEqual(general);
    expect(calls.every((c) => c.name === 'finance_payments_out')).toBe(true);
    expect(logged).toHaveBeenCalled();
  });
  it('tells a viewer they may not when row-level security refuses the check itself', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: '42501' } });
    expect(await voidPayment(ctx, { id: TXN })).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
  });
  it('still refuses an id that is not an id before anything is asked', async () => {
    const { ctx, calls } = fakeFinance(paymentOr(true, { data: { id: TXN }, error: null }));
    await expect(voidPayment(ctx, { id: 'nope' })).rejects.toThrow();
    await expect(deleteScheduledPayment(ctx, { id: 'nope' })).rejects.toThrow();
    await expect(markPaymentPaid(ctx, { id: 'nope', paid_on: '2026-10-09' })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
