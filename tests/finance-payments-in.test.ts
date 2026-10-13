import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_PAGE_SIZE,
  listPaymentsIn,
  listPaymentsOut,
  recordPaymentIn,
  recordPaymentInInput,
  recordPaymentOut,
  voidPaymentIn,
} from '@/lib/finance/money';
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';

const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const INVOICE_1 = '77777777-7777-4777-8777-777777777777';
const INVOICE_2 = '88888888-8888-4888-8888-888888888888';

const valid = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx' as const,
  allocations: [{ invoice_id: INVOICE_1, amount: 100 }],
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => recordPaymentInInput.safeParse(value).error?.issues[0]?.message;

describe('recordPaymentInInput', () => {
  it('asks for an account, a real date and a known method', () => {
    expect(first({ ...valid, account_id: '' })).toBe('Choose the account the money went into.');
    expect(first({ ...valid, txn_date: '5 Oct' })).toBe('Enter a valid date.');
    expect(first({ ...valid, method: 'barter' })).toBe('Choose how it was paid.');
  });
  it('asks for at least one invoice, each once, each with an amount above 0, and at most 50', () => {
    expect(first({ ...valid, allocations: [] })).toBe('Choose at least one invoice this payment is for.');
    expect(first({ ...valid, allocations: [{ invoice_id: 'x', amount: 1 }] })).toBe('Choose at least one invoice this payment is for.');
    expect(first({ ...valid, allocations: [{ invoice_id: INVOICE_1, amount: 0 }] })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, allocations: [{ invoice_id: INVOICE_1, amount: 1 }, { invoice_id: INVOICE_1, amount: 2 }] }))
      .toBe('Each invoice can appear once on a payment.');
    const many = Array.from({ length: 51 }, (_, n) => ({
      invoice_id: `99999999-9999-4999-8999-${String(n).padStart(12, '0')}`,
      amount: 1,
    }));
    expect(first({ ...valid, allocations: many })).toBe('One payment can cover at most 50 invoices.');
  });
  it('rounds first, then checks: an amount that rounds to 0 is refused and half a sen rounds up', () => {
    expect(first({ ...valid, allocations: [{ invoice_id: INVOICE_1, amount: 0.004 }] })).toBe('Enter an amount above 0.');
    const parsed = recordPaymentInInput.parse({ ...valid, reference: ' ', allocations: [{ invoice_id: INVOICE_1, amount: 0.005 }] });
    expect(parsed.allocations).toEqual([{ invoice_id: INVOICE_1, amount: 0.01 }]);
    expect(parsed).toMatchObject({ reference: null, notes: null });
  });
  it('has no "scheduled": money in is recorded once it has arrived', () => {
    expect(Object.keys(recordPaymentInInput.parse({ ...valid, scheduled: true, status: 'scheduled' })).sort()).toEqual([
      'account_id', 'allocations', 'method', 'notes', 'reference', 'txn_date',
    ]);
  });
});

describe('payments in', () => {
  it('records through the database function, in the caller’s workspace, split across two invoices', async () => {
    const { ctx, calls } = fakeFinance({ data: TXN, error: null });
    const result = await recordPaymentIn(ctx, {
      ...valid,
      allocations: [{ invoice_id: INVOICE_1, amount: 100 }, { invoice_id: INVOICE_2, amount: 32.5 }],
    });
    expect(result).toEqual({ ok: true, data: { id: TXN } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_record_payment_in' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      payment: { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', reference: null, notes: null },
      allocations: [{ invoice_id: INVOICE_1, amount: 100 }, { invoice_id: INVOICE_2, amount: 32.5 }],
    });
  });
  it('words each database refusal for invoices and customers', async () => {
    const cases: [string, string][] = [
      ['FIN03', 'The amounts against the invoices add up to more than the payment.'],
      ['FIN04', 'A payment can only go against a posted invoice.'],
      ['FIN05', 'That is more than is still owed on an invoice.'],
      ['FIN06', 'One payment can only pay invoices from one customer.'],
      ['FIN09', 'This payment cannot be voided as it now stands: it has already been voided, or it is still a draft.'],
      ['FIN11', 'That payment no longer exists.'],
      ['23503', 'The account or an invoice on this payment no longer exists.'],
      ['23505', 'Each invoice can appear once on a payment.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await recordPaymentIn(ctx, valid), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('leaves a payment out’s sentences about bills and suppliers as they were', async () => {
    const out = { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx' as const, allocations: [{ bill_id: INVOICE_1, amount: 1 }] };
    const refused = async (code: string) => recordPaymentOut(fakeFinance({ data: null, error: { code } }).ctx, out);
    expect(await refused('FIN04')).toEqual({ ok: false, error: 'A payment can only go against a posted bill.' });
    expect(await refused('FIN06')).toEqual({ ok: false, error: 'One payment can only pay bills from one supplier.' });
  });
  /** Answers the payments-in check with a row (a payment against invoices) or none (any other money in), and the update with `other`. */
  const paymentInOr = (isPaymentIn: boolean, other: FinanceAnswer) => (call: FinanceCall) =>
    call.name === 'finance_payments_in' ? { data: isPaymentIn ? [{ transaction_id: TXN }] : [], error: null } : other;

  it('is voided by one status change, kept to money in and to the workspace, once Payments In shows it', async () => {
    const { ctx, calls } = fakeFinance(paymentInOr(true, { data: { id: TXN }, error: null }));
    expect(await voidPaymentIn(ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls.map((c) => [c.name, c.op])).toEqual([['finance_payments_in', 'select'], ['finance_transactions', 'update']]);
    // One row is asked for: a payment split across invoices is several rows there.
    expect(calls[0]).toMatchObject({ filters: { org_id: 'org-1', transaction_id: TXN }, limit: 1 });
    expect(calls[1].filters).toEqual({ id: TXN, org_id: 'org-1', direction: 'in' });
    expect(Object.keys(calls[1].values!).sort()).toEqual(['status', 'updated_at']);
    expect(calls[1].values).toMatchObject({ status: 'void' });
  });
  it('refuses money in that is not a payment against an invoice, without writing', async () => {
    // A receipt for income that settles no invoice is money in too, and Payments In never shows it.
    const { ctx, calls } = fakeFinance(paymentInOr(false, { data: { id: TXN }, error: null }));
    expect(await voidPaymentIn(ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
    expect(calls.map((c) => [c.name, c.op])).toEqual([['finance_payments_in', 'select']]);
    // The same when the view answers with nothing at all.
    const empty = fakeFinance((call: FinanceCall) =>
      call.name === 'finance_payments_in' ? { data: null, error: null } : { data: { id: TXN }, error: null },
    );
    expect(await voidPaymentIn(empty.ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
    expect(empty.calls).toHaveLength(1);
  });
  it('writes nothing when the check cannot be read: a viewer is told they may not, anything else is logged', async () => {
    const refused = fakeFinance((call: FinanceCall) =>
      call.name === 'finance_payments_in' ? { data: null, error: { code: '42501' } } : { data: { id: TXN }, error: null },
    );
    expect(await voidPaymentIn(refused.ctx, { id: TXN })).toEqual({
      ok: false, error: 'You do not have permission to make changes here.',
    });
    expect(refused.calls).toHaveLength(1);
    expect(logged).not.toHaveBeenCalled();
    const broken = fakeFinance((call: FinanceCall) =>
      call.name === 'finance_payments_in' ? { data: null, error: { code: 'XX000' } } : { data: { id: TXN }, error: null },
    );
    expect(await voidPaymentIn(broken.ctx, { id: TXN })).toEqual({
      ok: false, error: 'That change could not be saved. Please try again.',
    });
    expect(broken.calls).toHaveLength(1);
    expect(logged).toHaveBeenCalled();
  });
  it('says a payment that is already void, or a draft receipt, cannot be voided, and never to void it', async () => {
    const { ctx, calls } = fakeFinance(paymentInOr(true, { data: null, error: { code: 'FIN09' } }));
    const result = await voidPaymentIn(ctx, { id: TXN });
    expect(result).toEqual({ ok: false, error: 'This payment cannot be voided as it now stands: it has already been voided, or it is still a draft.' });
    expect(JSON.stringify(result)).not.toContain('Void it');
    expect(calls).toHaveLength(2);
  });
  it('says the payment is gone when voiding touches no row, and refuses an id that is not an id', async () => {
    const { ctx, calls } = fakeFinance(paymentInOr(true, { data: null, error: null }));
    expect(await voidPaymentIn(ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
    expect(calls).toHaveLength(2);
    await expect(voidPaymentIn(ctx, { id: 'nope' })).rejects.toThrow();
    // The id is refused before anything is read.
    expect(calls).toHaveLength(2);
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await recordPaymentIn(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});

describe('payment reads', () => {
  const row = (n: number) => ({
    allocation_id: `alloc-${n}`, transaction_id: 'txn-1', number: 'RC-0001', txn_date: '2026-10-05', method: 'fpx',
    amount: '60.00', transaction_amount: '100.00', status: 'posted', reference: null, account_id: 'bank',
    account_name: 'Main Bank', invoice_id: `inv-${n}`, invoice_no: `INV-000${n}`, customer_name: 'Aisyah Trading',
  });

  it('lists payments in from their view, one row per invoice, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1), row(2)], error: null });
    const rows = await listPaymentsIn(ctx);
    expect(rows).toEqual([
      { ...row(1), amount: 60, transaction_amount: 100 },
      { ...row(2), amount: 60, transaction_amount: 100 },
    ]);
    expect(calls[0]).toMatchObject({
      name: 'finance_payments_in',
      filters: { org_id: 'org-1' },
      order: ['txn_date desc', 'allocation_id asc'],
      range: [0, PAYMENT_PAGE_SIZE - 1],
    });
    expect(calls[0].columns).toBe(
      'allocation_id,transaction_id,number,txn_date,method,amount,transaction_amount,status,reference,account_id,account_name,invoice_id,invoice_no,customer_name',
    );
  });
  it('reads on past a full page', async () => {
    const full = Array.from({ length: PAYMENT_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [], error: null }));
    expect(await listPaymentsIn(ctx)).toHaveLength(PAYMENT_PAGE_SIZE);
    expect(calls).toHaveLength(2);
  });
  it('still lists payments out from their own view with the same columns as before', async () => {
    const { ctx, calls } = fakeFinance({ data: [], error: null });
    expect(await listPaymentsOut(ctx)).toEqual([]);
    expect(calls[0]).toMatchObject({ name: 'finance_payments_out', order: ['txn_date desc', 'allocation_id asc'] });
    expect(calls[0].columns).toBe(
      'allocation_id,transaction_id,number,txn_date,method,amount,transaction_amount,status,reference,account_id,account_name,bill_id,bill_no,supplier_name',
    );
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listPaymentsIn(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});
