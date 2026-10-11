import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYMENT_PAGE_SIZE } from '@/lib/finance/money';
import {
  REFUND_REASONS,
  REFUND_REASON_LABELS,
  deleteRefund,
  listRefunds,
  markRefundPaid,
  recordRefund,
  recordRefundInput,
  voidRefund,
} from '@/lib/finance/refunds';
import { fakeFinance } from './setup/fake-finance';

const TXN = '33333333-3333-4333-8333-333333333333';
const INVOICE = '55555555-5555-4555-8555-555555555555';
const NOTE = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = '77777777-7777-4777-8777-777777777777';

const valid = {
  invoice_id: INVOICE, account_id: ACCOUNT, txn_date: '2026-10-06', method: 'fpx' as const, reason: 'damaged_goods' as const, amount: 240,
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => recordRefundInput.safeParse(value).error?.issues[0]?.message;

describe('recordRefundInput', () => {
  it('asks for exactly one document: an invoice or a credit note', () => {
    const sentence = 'Choose the invoice or the credit note this refund is for.';
    expect(first({ ...valid, invoice_id: undefined })).toBe(sentence);
    expect(first({ ...valid, invoice_id: '' })).toBe(sentence);
    expect(first({ ...valid, invoice_id: null, credit_note_id: null })).toBe(sentence);
    expect(first({ ...valid, credit_note_id: NOTE })).toBe(sentence);
    expect(first({ ...valid, invoice_id: 'INV-1042' })).toBe(sentence);
    expect(first(valid)).toBeUndefined();
    expect(first({ ...valid, invoice_id: '', credit_note_id: NOTE })).toBeUndefined();
    expect(recordRefundInput.parse({ ...valid, invoice_id: '', credit_note_id: NOTE })).toMatchObject({ invoice_id: null, credit_note_id: NOTE });
  });
  it('asks for an account, a real date, a method and a reason from the list', () => {
    expect(first({ ...valid, account_id: '' })).toBe('Choose the account the money leaves.');
    expect(first({ ...valid, txn_date: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, method: 'barter' })).toBe('Choose how it was paid.');
    expect(first({ ...valid, reason: 'because' })).toBe('Choose a reason.');
    expect(first({ ...valid, reason: undefined })).toBe('Choose a reason.');
  });
  it('rounds the amount to the sen first, then asks for more than nothing', () => {
    expect(recordRefundInput.parse({ ...valid, amount: 240.005 }).amount).toBe(240.01);
    expect(first({ ...valid, amount: 0.004 })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, amount: '240' })).toBe('Enter an amount above 0.');
  });
  it('is paid out now unless it is said to be pending, and stores empty boxes as nothing', () => {
    expect(recordRefundInput.parse({ ...valid, reference: ' ', notes: '' })).toEqual({
      invoice_id: INVOICE, credit_note_id: null, account_id: ACCOUNT, txn_date: '2026-10-06', method: 'fpx',
      reason: 'damaged_goods', amount: 240, reference: null, notes: null, scheduled: false,
    });
    expect(first({ ...valid, notes: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('has a label for every reason', () => {
    expect(Object.keys(REFUND_REASON_LABELS).sort()).toEqual([...REFUND_REASONS].sort());
  });
});

describe('refund reads', () => {
  const row = (n: number) => ({
    allocation_id: `a-${n}`, transaction_id: `t-${n}`, number: `PV-${n}`, txn_date: '2026-10-06', method: 'fpx',
    amount: '240.00', transaction_amount: '240.00', status: 'posted', reference: null, reason: 'damaged_goods', notes: null,
    account_id: 'bank', account_name: 'Main Bank', invoice_id: 'inv-1', invoice_no: 'INV-1042',
    credit_note_id: 'cn-1', credit_note_no: 'CN-0034', customer_id: 'c1', customer_name: 'Aisyah Trading',
  });

  it('lists from the refunds view, in the caller’s workspace, newest first, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1)], error: null });
    expect(await listRefunds(ctx)).toEqual([{ ...row(1), amount: 240, transaction_amount: 240 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_refunds',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['txn_date desc', 'allocation_id asc'],
      range: [0, PAYMENT_PAGE_SIZE - 1],
    });
    for (const column of ['reason', 'credit_note_no', 'invoice_no', 'customer_id']) expect(calls[0].columns).toContain(column);
  });
  it('reads on past a full page', async () => {
    const full = Array.from({ length: PAYMENT_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listRefunds(ctx)).toHaveLength(PAYMENT_PAGE_SIZE + 1);
    expect(calls).toHaveLength(2);
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listRefunds(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('refund writes', () => {
  /** Answers the refunds-view check with a row (a real refund) or none (a payment to a supplier), and everything else with `other`. */
  const refundOr = (isRefund: boolean, other: { data: unknown; error: unknown }) => (call: { name: string }) =>
    call.name === 'finance_refunds' ? { data: isRefund ? [{ transaction_id: TXN }] : [], error: null } : other;

  it('records a refund paid out now through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: TXN, error: null });
    expect(await recordRefund(ctx, { ...valid, reference: ' TT 88 ' })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_record_refund' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      refund: {
        invoice_id: INVOICE, credit_note_id: null, account_id: ACCOUNT, txn_date: '2026-10-06', method: 'fpx',
        reason: 'damaged_goods', amount: 240, reference: 'TT 88', notes: null, status: 'posted',
      },
    });
  });
  it('records a pending refund against a credit note as scheduled', async () => {
    const { ctx, calls } = fakeFinance({ data: TXN, error: null });
    await recordRefund(ctx, { ...valid, invoice_id: null, credit_note_id: NOTE, scheduled: true });
    expect(calls[0].args!.refund).toMatchObject({ invoice_id: null, credit_note_id: NOTE, status: 'scheduled' });
    expect(calls[0].args!.refund).not.toHaveProperty('scheduled');
  });
  it('marks a pending refund paid with the function a payment out uses, and returns the number', async () => {
    const { ctx, calls } = fakeFinance(refundOr(true, { data: 'PV-0007', error: null }));
    expect(await markRefundPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual({ ok: true, data: { id: TXN, number: 'PV-0007' } });
    expect(calls[0]).toMatchObject({ name: 'finance_refunds', op: 'select', filters: { org_id: 'org-1', transaction_id: TXN }, limit: 1 });
    expect(calls[0].columns).toBe('transaction_id');
    expect(calls[1]).toMatchObject({ kind: 'rpc', name: 'finance_mark_payment_paid' });
    expect(calls[1].args).toEqual({ target_org: 'org-1', target_txn: TXN, paid_on: '2026-10-09' });
  });
  it('voids and deletes money out only, scoped to the workspace', async () => {
    const voided = fakeFinance(refundOr(true, { data: { id: TXN }, error: null }));
    expect(await voidRefund(voided.ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(voided.calls[0]).toMatchObject({ name: 'finance_refunds', filters: { org_id: 'org-1', transaction_id: TXN } });
    expect(voided.calls[1]).toMatchObject({
      name: 'finance_transactions', op: 'update', filters: { id: TXN, org_id: 'org-1', direction: 'out' },
    });
    expect(Object.keys(voided.calls[1].values!).sort()).toEqual(['status', 'updated_at']);

    const removed = fakeFinance(refundOr(true, { data: { id: TXN }, error: null }));
    expect(await deleteRefund(removed.ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(removed.calls[1]).toMatchObject({
      name: 'finance_transactions', op: 'delete', filters: { id: TXN, org_id: 'org-1', direction: 'out' },
    });
  });
  it('turns each database refusal into a sentence about a refund', async () => {
    const cases: [string, string][] = [
      ['FIN04', 'A refund needs a posted invoice, or an issued credit note, whose customer is in credit.'],
      ['FIN05', 'That is more than the customer is in credit, or more than is left of the credit note.'],
      ['FIN06', 'The invoice or credit note for this refund no longer exists.'],
      ['FIN09', 'That cannot be done to this refund as it now stands. It may have been paid out or voided since this page was loaded.'],
      ['FIN11', 'That refund no longer exists.'],
      ['FIN14', 'Only an owner or admin can post, pay or void. Ask one of them to do this.'],
      ['23503', 'The account on this refund no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance(refundOr(true, { data: null, error: { code } }));
      expect(await recordRefund(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await voidRefund(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
      expect(await deleteRefund(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
      // Paying a pending refund out has its own sentences for the two codes that mean its credit has gone.
      if (code !== 'FIN04' && code !== 'FIN05') {
        expect(await markRefundPaid(ctx, { id: TXN, paid_on: '2026-10-09' }), code).toEqual({ ok: false, error: message });
      }
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says what to do when paying a pending refund out is refused, and gives no such advice on a new refund', async () => {
    const paidOut = (code: string) =>
      markRefundPaid(fakeFinance(refundOr(true, { data: null, error: { code } })).ctx, { id: TXN, paid_on: '2026-10-09' });
    // The payment in behind the credit was voided while the refund waited. Nothing may be left of the credit,
    // so the sentence does not promise that a new refund can be recorded.
    expect(await paidOut('FIN05')).toEqual({
      ok: false,
      error:
        'This refund no longer fits in what the customer is in credit, or in what is left of its credit note, so it cannot be paid out. Delete it. If the customer is still in credit, a new refund can be recorded for no more than that.',
    });
    expect(await paidOut('FIN04')).toEqual({
      ok: false,
      error: 'This refund can no longer be paid out: its invoice is no longer posted, or its credit note is no longer issued. Delete it.',
    });
    // The new-refund form meets the same two codes with nothing waiting: nobody is told to delete a refund that does not exist.
    for (const code of ['FIN04', 'FIN05']) {
      const { ctx } = fakeFinance(refundOr(true, { data: null, error: { code } }));
      const recorded = await recordRefund(ctx, valid);
      expect(recorded, code).toMatchObject({ ok: false });
      if (!recorded.ok) expect(recorded.error, code).not.toMatch(/delete|waiting/i);
    }
  });
  it('words FIN09 so that it reads sensibly from every button that can meet it: Mark as paid, Void and Delete', async () => {
    const sentence = 'That cannot be done to this refund as it now stands. It may have been paid out or voided since this page was loaded.';
    const { ctx } = fakeFinance(refundOr(true, { data: null, error: { code: 'FIN09' } }));
    // Mark as paid and Delete on a refund that was paid out in another tab; Void on one already void.
    expect(await markRefundPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual({ ok: false, error: sentence });
    expect(await voidRefund(ctx, { id: TXN })).toEqual({ ok: false, error: sentence });
    expect(await deleteRefund(ctx, { id: TXN })).toEqual({ ok: false, error: sentence });
  });
  it('says the refund is gone when void or delete touches no row', async () => {
    const { ctx } = fakeFinance(refundOr(true, { data: null, error: null }));
    expect(await voidRefund(ctx, { id: TXN })).toEqual({ ok: false, error: 'That refund no longer exists.' });
    expect(await deleteRefund(ctx, { id: TXN })).toEqual({ ok: false, error: 'That refund no longer exists.' });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await recordRefund(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
  it('refuses a payment to a supplier: no write is issued unless the refunds view has the transaction', async () => {
    const gone = { ok: false, error: 'That refund no longer exists.' };
    const marked = fakeFinance(refundOr(false, { data: 'PV-0007', error: null }));
    expect(await markRefundPaid(marked.ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual(gone);
    expect(marked.calls.map((c) => c.kind)).toEqual(['table']);

    const voided = fakeFinance(refundOr(false, { data: { id: TXN }, error: null }));
    expect(await voidRefund(voided.ctx, { id: TXN })).toEqual(gone);
    expect(voided.calls.map((c) => c.name)).toEqual(['finance_refunds']);

    const removed = fakeFinance(refundOr(false, { data: { id: TXN }, error: null }));
    expect(await deleteRefund(removed.ctx, { id: TXN })).toEqual(gone);
    expect(removed.calls.map((c) => c.name)).toEqual(['finance_refunds']);
  });
  it('logs and gives the general message when the refunds check cannot be read', async () => {
    const failing = (call: { name: string }) =>
      call.name === 'finance_refunds' ? { data: null, error: { code: 'XX000' } } : { data: { id: TXN }, error: null };
    const general = { ok: false, error: 'That change could not be saved. Please try again.' };
    const { ctx, calls } = fakeFinance(failing);
    expect(await markRefundPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual(general);
    expect(await voidRefund(ctx, { id: TXN })).toEqual(general);
    expect(await deleteRefund(ctx, { id: TXN })).toEqual(general);
    expect(calls.every((c) => c.name === 'finance_refunds')).toBe(true);
    expect(logged).toHaveBeenCalled();
  });
});
