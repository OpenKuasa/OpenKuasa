/**
 * Paying and voiding a voucher: what the data layer asks of the database, and how it words each answer. The
 * database is a stand-in that records every request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markVoucherPaid,
  markVoucherPaidInput,
  recordVoucher,
  recordVoucherInput,
  voidVoucher,
  voidVoucherInput,
} from '@/lib/finance/vouchers';
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';

const VOUCHER = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const GONE = 'That voucher no longer exists.';
const FAILED = 'That change could not be saved. Please try again.';
const NEEDS = 'Only an owner or admin can post, pay or void. Ask one of them to do this.';
const NOT_HERE = 'A payment to a supplier is paid and voided on Payments Out, and a refund on Refunds.';

const typed = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx' as const,
  category_id: CATEGORY,
  amount: 300,
  party_name: 'Tenaga Nasional',
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const ok = (data: unknown): FinanceAnswer => ({ data, error: null });
const refused = (code: string): FinanceAnswer => ({ data: null, error: { code } });
/**
 * Answers the three requests paying and voiding make, in order: the read of the voucher's kind, the write, and the
 * read of its status that follows a write which changed nothing.
 */
function db(kind: FinanceAnswer, write: FinanceAnswer, status: FinanceAnswer = ok(null)) {
  return fakeFinance((call: FinanceCall) => {
    if (call.op === 'select') return call.columns === 'kind' ? kind : status;
    return write;
  });
}

describe('recording a voucher as paid now', () => {
  it('takes paid_now as true or false only, and leaves it out of what is parsed when it was not sent', () => {
    expect(recordVoucherInput.parse({ ...typed, paid_now: true }).paid_now).toBe(true);
    expect('paid_now' in recordVoucherInput.parse(typed)).toBe(false);
    expect(recordVoucherInput.safeParse({ ...typed, paid_now: 'yes' }).error?.issues[0]?.message).toBe(
      'Check who is paid, the amount and the method, then try again.',
    );
  });
  it('asks the database for paid, and never sends paid_now itself', async () => {
    const { ctx, calls } = fakeFinance((call: FinanceCall) => (call.kind === 'rpc' ? ok(VOUCHER) : ok({ status: 'posted' })));
    expect(await recordVoucher(ctx, { ...typed, paid_now: true })).toEqual({ ok: true, data: { id: VOUCHER, status: 'posted' } });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      voucher: {
        account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', category_id: CATEGORY, amount: 300,
        contact_id: null, party_name: 'Tenaga Nasional', reference: null, notes: null, status: 'posted',
      },
      allocations: [],
    });
  });
  it('asks for "To be paid" when paid_now is false or absent', async () => {
    for (const input of [typed, { ...typed, paid_now: false }]) {
      const { ctx, calls } = fakeFinance((call: FinanceCall) => (call.kind === 'rpc' ? ok(VOUCHER) : ok({ status: 'scheduled' })));
      await recordVoucher(ctx, input);
      expect((calls[0].args?.voucher as { status: string }).status).toBe('scheduled');
      expect('paid_now' in (calls[0].args?.voucher as object)).toBe(false);
    }
  });
});

describe('markVoucherPaid', () => {
  const input = { id: VOUCHER, paid_on: '2026-10-09' };

  it('asks for an id and a real date', () => {
    const first = (value: unknown) => markVoucherPaidInput.safeParse(value).error?.issues[0]?.message;
    expect(first({ id: 'x', paid_on: '2026-10-09' })).toBe(GONE);
    expect(first(undefined)).toBe(GONE);
    for (const paid_on of ['', '9 Oct', '2026-02-30', null, undefined]) {
      expect(first({ id: VOUCHER, paid_on }), String(paid_on)).toBe('Enter the date it was paid.');
    }
  });
  it('reads the voucher\'s kind on the screen\'s own view, then calls the function Payments Out and Refunds use', async () => {
    for (const kind of ['other', 'expense']) {
      const { ctx, calls } = db(ok({ kind }), ok('PV-0007'));
      expect(await markVoucherPaid(ctx, input), kind).toEqual({ ok: true, data: { id: VOUCHER, number: 'PV-0007' } });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        kind: 'table', name: 'finance_payment_vouchers', op: 'select', columns: 'kind', filters: { org_id: 'org-1', transaction_id: VOUCHER },
      });
      expect(calls[1]).toMatchObject({ kind: 'rpc', name: 'finance_mark_payment_paid' });
      expect(calls[1].args).toEqual({ target_org: 'org-1', target_txn: VOUCHER, paid_on: '2026-10-09' });
    }
  });
  it('leaves a payment to a supplier and a refund to their own screens, and writes nothing', async () => {
    for (const kind of ['bill', 'refund']) {
      const { ctx, calls } = db(ok({ kind }), ok('PV-0007'));
      expect(await markVoucherPaid(ctx, input), kind).toEqual({ ok: false, error: NOT_HERE });
      expect(calls).toHaveLength(1);
    }
  });
  it('says gone when the view has no such voucher (another workspace, a side of a transfer, deleted), and writes nothing', async () => {
    const { ctx, calls } = db(ok(null), ok('PV-0007'));
    expect(await markVoucherPaid(ctx, input)).toEqual({ ok: false, error: GONE });
    expect(calls).toHaveLength(1);
    const failed = db(refused('XX000'), ok('PV-0007'));
    expect(await markVoucherPaid(failed.ctx, input)).toEqual({ ok: false, error: FAILED });
    expect(failed.calls).toHaveLength(1);
  });
  it('tells why the database would not pay one that is not "To be paid", by what it now reads', async () => {
    const cases: [FinanceAnswer, string][] = [
      [ok({ status: 'posted' }), 'This voucher has already been paid.'],
      [ok({ status: 'void' }), 'This voucher has already been voided.'],
      [ok({ status: 'pending_approval' }), 'Only a voucher that is To be paid can be marked paid.'],
      [ok({ status: 'draft' }), 'Only a voucher that is To be paid can be marked paid.'],
      [ok({ status: 'rejected' }), 'Only a voucher that is To be paid can be marked paid.'],
      [ok(null), GONE],
      [refused('XX000'), FAILED],
    ];
    for (const [status, sentence] of cases) {
      const { ctx, calls } = db(ok({ kind: 'other' }), refused('FIN09'), status);
      expect(await markVoucherPaid(ctx, input), sentence).toEqual({ ok: false, error: sentence });
      expect(calls).toHaveLength(3);
      expect(calls[2]).toMatchObject({ name: 'finance_payment_vouchers', columns: 'status', filters: { org_id: 'org-1', transaction_id: VOUCHER } });
    }
  });
  it('words every other refusal, and reads nothing after one', async () => {
    const cannot = 'What this voucher pays can no longer take this payment, so it was not marked paid. Delete the voucher and record it again.';
    const cases: [string, string][] = [
      ['FIN14', NEEDS],
      ['FIN11', GONE],
      ['FIN04', cannot],
      ['FIN05', cannot],
      ['FIN37', 'The account this voucher is paid from has been archived, so it cannot be marked paid. Restore the account on Banking, then try again.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['FIN28', FAILED],
      ['XX000', FAILED],
    ];
    for (const [code, sentence] of cases) {
      const { ctx, calls } = db(ok({ kind: 'expense' }), refused(code));
      expect(await markVoucherPaid(ctx, input), code).toEqual({ ok: false, error: sentence });
      expect(calls).toHaveLength(2);
    }
    // Neither a number nor an error: not called paid.
    const nothing = db(ok({ kind: 'other' }), ok(null));
    expect(await markVoucherPaid(nothing.ctx, input)).toEqual({ ok: false, error: FAILED });
  });
});

describe('voidVoucher', () => {
  const input = { id: VOUCHER };

  it('asks for an id', () => {
    expect(voidVoucherInput.safeParse({ id: 'x' }).error?.issues[0]?.message).toBe(GONE);
    expect(voidVoucherInput.safeParse(null).error?.issues[0]?.message).toBe(GONE);
    // Nothing else is taken: not a status, not a workspace.
    expect(Object.keys(voidVoucherInput.parse({ id: VOUCHER, status: 'draft', org_id: 'other' }))).toEqual(['id']);
  });
  it('changes the status and nothing else, on money out that is no side of a transfer, in the workspace, while it is paid', async () => {
    for (const kind of ['other', 'expense']) {
      const { ctx, calls } = db(ok({ kind }), ok({ id: VOUCHER }));
      expect(await voidVoucher(ctx, input), kind).toEqual({ ok: true, data: { id: VOUCHER } });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ kind: 'table', name: 'finance_transactions', op: 'update' });
      expect(Object.keys(calls[1].values ?? {}).sort()).toEqual(['status', 'updated_at']);
      expect(calls[1].values?.status).toBe('void');
      expect(calls[1].filters).toEqual({ id: VOUCHER, org_id: 'org-1', direction: 'out', 'transfer_id is': null, status: 'posted' });
    }
  });
  it('leaves a payment to a supplier and a refund to their own screens, and writes nothing', async () => {
    for (const kind of ['bill', 'refund']) {
      const { ctx, calls } = db(ok({ kind }), ok({ id: VOUCHER }));
      expect(await voidVoucher(ctx, input), kind).toEqual({ ok: false, error: NOT_HERE });
      expect(calls).toHaveLength(1);
    }
    const gone = db(ok(null), ok({ id: VOUCHER }));
    expect(await voidVoucher(gone.ctx, input)).toEqual({ ok: false, error: GONE });
    expect(gone.calls).toHaveLength(1);
  });
  it('tells why no row matched, by what the voucher now reads', async () => {
    const notPaid = 'Only a paid voucher can be voided. One that has not been paid is deleted instead.';
    const cases: [FinanceAnswer, string][] = [
      [ok({ status: 'void' }), 'This voucher has already been voided.'],
      [ok({ status: 'scheduled' }), notPaid],
      [ok({ status: 'pending_approval' }), notPaid],
      [ok(null), GONE],
      [refused('XX000'), FAILED],
    ];
    for (const [status, sentence] of cases) {
      const { ctx, calls } = db(ok({ kind: 'other' }), ok(null), status);
      expect(await voidVoucher(ctx, input), sentence).toEqual({ ok: false, error: sentence });
      expect(calls).toHaveLength(3);
    }
  });
  it('words the refusals of the update itself', async () => {
    const cases: [string, string][] = [
      ['FIN14', NEEDS],
      ['42501', 'You do not have permission to make changes here.'],
      ['FIN09', FAILED],
    ];
    for (const [code, sentence] of cases) {
      const { ctx, calls } = db(ok({ kind: 'expense' }), refused(code));
      expect(await voidVoucher(ctx, input), code).toEqual({ ok: false, error: sentence });
      expect(calls).toHaveLength(2);
    }
  });
});
