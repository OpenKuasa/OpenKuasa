import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveVoucher,
  deleteVoucher,
  deleteVoucherInput,
  recordVoucher,
  recordVoucherInput,
  rejectVoucher,
  voucherDecisionInput,
} from '@/lib/finance/vouchers';
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';

const VOUCHER = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const CONTACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const typed = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx' as const,
  category_id: CATEGORY,
  amount: 300,
  party_name: 'Tenaga Nasional',
  reference: 'ACC 1',
  notes: 'October',
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => recordVoucherInput.safeParse(value).error?.issues[0]?.message;
/** The same object with one field left out. */
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

describe('recordVoucherInput', () => {
  it('asks for an account, a real date, a method and a category', () => {
    expect(first({ ...typed, account_id: '' })).toBe('Choose the account the money leaves.');
    expect(first(without(typed, 'account_id'))).toBe('Choose the account the money leaves.');
    expect(first({ ...typed, txn_date: '5 Oct' })).toBe('Enter a valid date.');
    expect(first({ ...typed, method: 'barter' })).toBe('Choose how it is paid.');
    expect(first({ ...typed, category_id: '' })).toBe('Choose an expense category.');
    expect(first(null)).toBe('Check who is paid, the amount and the method, then try again.');
  });
  it('asks for an amount above 0 that fits the column, and refuses NaN', () => {
    for (const amount of [0, 0.004, -5, Number.NaN, Number.POSITIVE_INFINITY, '300', 1_000_000_000_000]) {
      expect(first({ ...typed, amount }), String(amount)).toBe('Enter an amount above 0.');
    }
    expect(recordVoucherInput.parse({ ...typed, amount: 10.006 }).amount).toBe(10.01);
  });
  it('takes a contact or a typed name as whoever is paid: exactly one', () => {
    expect(first({ ...typed, contact_id: CONTACT })).toBe('Choose who is paid from your contacts or type a name, not both.');
    expect(first({ ...typed, party_name: null, contact_id: 'someone' })).toBe('Choose who is paid from your contacts or type a name, not both.');
    expect(first(without(typed, 'party_name'))).toBe('Say who is paid: choose a contact or type a name.');
    expect(first({ ...typed, party_name: '   ' })).toBe('Say who is paid: choose a contact or type a name.');
    expect(recordVoucherInput.parse({ ...typed, party_name: ' ', contact_id: CONTACT })).toMatchObject({ contact_id: CONTACT, party_name: null });
    expect(recordVoucherInput.parse({ ...typed, party_name: '  Tenaga ', contact_id: '' })).toMatchObject({ contact_id: null, party_name: 'Tenaga' });
  });
  it('keeps text short, and never takes a status or anything the database writes', () => {
    expect(first({ ...typed, notes: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
    expect(first({ ...typed, party_name: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
    const parsed = recordVoucherInput.parse({ ...typed, status: 'posted', approved_by: CONTACT, org_id: 'other', number: 'PV-1', id: VOUCHER });
    expect(Object.keys(parsed).sort()).toEqual(
      ['account_id', 'amount', 'category_id', 'contact_id', 'method', 'notes', 'party_name', 'reference', 'txn_date'],
    );
  });
});

/** Answers the function call with `rpc`, and the read of the status that follows it with `status`. */
function recording(rpc: FinanceAnswer, status: FinanceAnswer = { data: { status: 'pending_approval' }, error: null }) {
  return fakeFinance((call: FinanceCall) => (call.kind === 'rpc' ? rpc : status));
}

describe('recordVoucher', () => {
  it('asks the database for "To be paid" with no split, then reads how it left the voucher', async () => {
    const { ctx, calls } = recording({ data: VOUCHER, error: null }, { data: { status: 'scheduled' }, error: null });
    expect(await recordVoucher(ctx, typed)).toEqual({ ok: true, data: { id: VOUCHER, status: 'scheduled' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_record_voucher' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      voucher: {
        account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', category_id: CATEGORY, amount: 300,
        contact_id: null, party_name: 'Tenaga Nasional', reference: 'ACC 1', notes: 'October', status: 'scheduled',
      },
      allocations: [],
    });
    expect(calls[1]).toMatchObject({
      kind: 'table', name: 'finance_payment_vouchers', op: 'select', columns: 'status', filters: { org_id: 'org-1', transaction_id: VOUCHER },
    });
    expect(calls).toHaveLength(2);
  });
  it('answers what a member is left with: waiting', async () => {
    const { ctx } = recording({ data: VOUCHER, error: null });
    expect(await recordVoucher(ctx, typed)).toEqual({ ok: true, data: { id: VOUCHER, status: 'pending_approval' } });
  });
  it('still answers recorded when the status cannot be read back', async () => {
    const { ctx } = recording({ data: VOUCHER, error: null }, { data: null, error: { code: 'XX000' } });
    expect(await recordVoucher(ctx, typed)).toEqual({ ok: true, data: { id: VOUCHER, status: null } });
  });
  it('does not call it recorded when the database answers neither an id nor an error', async () => {
    const { ctx, calls } = recording({ data: null, error: null });
    expect(await recordVoucher(ctx, typed)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(calls).toHaveLength(1);
  });
  it('words each refusal, and reads nothing after one', async () => {
    const cases: [string, string][] = [
      ['FIN15', 'Choose an expense category that still exists.'],
      ['FIN37', 'That account has been archived. Choose another account.'],
      ['23503', 'The account, the contact or the category on this voucher no longer exists.'],
      ['23514', 'Check who is paid, the amount and the method, then try again.'],
      ['23502', 'Check who is paid, the amount and the method, then try again.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
      ['XX000', 'That change could not be saved. Please try again.'],
      // Not a code recording can meet through the screen: it gets the general sentence, not a sign-off one.
      ['FIN14', 'That change could not be saved. Please try again.'],
    ];
    for (const [code, sentence] of cases) {
      const { ctx, calls } = recording({ data: null, error: { code } });
      expect(await recordVoucher(ctx, typed), code).toEqual({ ok: false, error: sentence });
      expect(calls).toHaveLength(1);
    }
  });
});

/** What the row showed when the owner pressed Approve or Reject. */
const SEEN = {
  id: VOUCHER,
  amount: 300,
  txn_date: '2026-10-05',
  method: 'fpx',
  account_id: ACCOUNT,
  contact_id: null,
  party_name: 'Tenaga Nasional',
  category_id: CATEGORY,
  reference: 'ACC 1',
  notes: 'October',
} as const;
const CHANGED = 'This voucher is not as it was shown to you. Check it again before you decide.';

describe('voucherDecisionInput', () => {
  it('takes the voucher as its row showed it, and nothing else', () => {
    expect(voucherDecisionInput.parse(SEEN)).toEqual(SEEN);
    expect(Object.keys(voucherDecisionInput.parse({ ...SEEN, status: 'scheduled', org_id: 'other', approved_by: CONTACT })).sort()).toEqual(
      Object.keys(SEEN).sort(),
    );
    expect(voucherDecisionInput.safeParse({ ...SEEN, id: 'x' }).error?.issues[0]?.message).toBe('That voucher no longer exists.');
    expect(voucherDecisionInput.safeParse(undefined).error?.issues[0]?.message).toBe('That voucher no longer exists.');
  });
  it('asks for the shape of every field the row showed', () => {
    const bad: Record<string, unknown[]> = {
      amount: ['300', Number.NaN, undefined],
      txn_date: ['5 Oct', '', undefined],
      method: ['barter', undefined],
      account_id: ['x', null, undefined],
      contact_id: ['x', undefined],
      party_name: [5, undefined],
      category_id: ['x', undefined],
      reference: [5, undefined],
      notes: [5, undefined],
    };
    for (const [field, values] of Object.entries(bad)) {
      for (const value of values) {
        expect(voucherDecisionInput.safeParse({ ...SEEN, [field]: value }).error?.issues[0]?.message, `${field} ${String(value)}`).toBe(CHANGED);
      }
    }
    // A payment to a supplier that waits: a contact, no typed name, no category.
    expect(voucherDecisionInput.safeParse({ ...SEEN, contact_id: CONTACT, party_name: null, category_id: null }).success).toBe(true);
  });
});

describe('approveVoucher, rejectVoucher', () => {
  it('change the status and nothing else, on the voucher as it was shown, kept to the workspace and to money out', async () => {
    for (const [fn, status] of [[approveVoucher, 'scheduled'], [rejectVoucher, 'rejected']] as const) {
      const { ctx, calls } = fakeFinance({ data: { id: VOUCHER }, error: null });
      expect(await fn(ctx, SEEN)).toEqual({ ok: true, data: { id: VOUCHER } });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ kind: 'table', name: 'finance_transactions', op: 'update' });
      // Only a voucher that is still waiting, is no side of a transfer, and holds every field the row showed.
      expect(calls[0].filters).toEqual({
        id: VOUCHER, org_id: 'org-1', direction: 'out', 'transfer_id is': null, status: 'pending_approval',
        amount: 300, txn_date: '2026-10-05', method: 'fpx', account_id: ACCOUNT,
        'contact_id is': null, party_name: 'Tenaga Nasional', category_id: CATEGORY, reference: 'ACC 1', notes: 'October',
      });
      expect(Object.keys(calls[0].values ?? {}).sort()).toEqual(['status', 'updated_at']);
      expect(calls[0].values?.status).toBe(status);
    }
  });
  it('match a column that holds nothing by `is null`, never by equality', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: VOUCHER }, error: null });
    await approveVoucher(ctx, { ...SEEN, contact_id: CONTACT, party_name: null, category_id: null, reference: null, notes: null });
    expect(calls[0].filters).toEqual({
      id: VOUCHER, org_id: 'org-1', direction: 'out', 'transfer_id is': null, status: 'pending_approval',
      amount: 300, txn_date: '2026-10-05', method: 'fpx', account_id: ACCOUNT,
      contact_id: CONTACT, 'party_name is': null, 'category_id is': null, 'reference is': null, 'notes is': null,
    });
  });
  const APPROVED = '2026-10-12T03:00:00.000Z';
  /** An update that changes no row, then the read of what the voucher is now. */
  const changesNothing = (now: FinanceAnswer) => fakeFinance((call: FinanceCall) => (call.op === 'update' ? { data: null, error: null } : now));
  it('say what happened when no row matched: gone, decided meanwhile, or not as shown', async () => {
    const cases: [FinanceAnswer, string][] = [
      [{ data: null, error: null }, 'That voucher no longer exists.'],
      [{ data: { status: 'scheduled', approved_at: APPROVED }, error: null }, 'This voucher has already been approved.'],
      [{ data: { status: 'posted', approved_at: APPROVED }, error: null }, 'This voucher has already been approved.'],
      [{ data: { status: 'void', approved_at: APPROVED }, error: null }, 'This voucher has already been approved.'],
      // "To be paid" or later with nobody having approved it (a supplier payment a member scheduled): nothing was approved meanwhile.
      [{ data: { status: 'scheduled', approved_at: null }, error: null }, CHANGED],
      [{ data: { status: 'posted', approved_at: null }, error: null }, CHANGED],
      [{ data: { status: 'void', approved_at: null }, error: null }, CHANGED],
      [{ data: { status: 'scheduled' }, error: null }, CHANGED],
      [{ data: { status: 'rejected' }, error: null }, 'This voucher has already been rejected.'],
      [{ data: { status: 'pending_approval' }, error: null }, CHANGED],
      [{ data: { status: 'draft' }, error: null }, CHANGED],
      [{ data: null, error: { code: 'XX000' } }, 'That change could not be saved. Please try again.'],
    ];
    for (const fn of [approveVoucher, rejectVoucher]) {
      for (const [now, sentence] of cases) {
        const { ctx, calls } = changesNothing(now);
        expect(await fn(ctx, SEEN), sentence).toEqual({ ok: false, error: sentence });
        expect(calls[1]).toMatchObject({ name: 'finance_payment_vouchers', op: 'select', filters: { org_id: 'org-1', transaction_id: VOUCHER } });
      }
    }
  });
  it('word each refusal of the update itself', async () => {
    const needs = 'Only an owner or admin can approve or reject a voucher. Ask one of them to do this.';
    const archived =
      'The account this voucher is paid from has been archived, so it cannot be approved. Reject or delete it, then record it again from another account.';
    const failed = 'That change could not be saved. Please try again.';
    const cases: [typeof approveVoucher, string, string][] = [
      [approveVoucher, 'FIN14', needs],
      [rejectVoucher, 'FIN14', needs],
      [approveVoucher, 'FIN37', archived],
      // Rejecting moves no money on the account, so the archive rule has no sentence there.
      [rejectVoucher, 'FIN37', failed],
      [approveVoucher, '42501', 'You do not have permission to make changes here.'],
      [approveVoucher, 'FIN09', failed],
    ];
    for (const [fn, code, sentence] of cases) {
      const { ctx, calls } = fakeFinance({ data: null, error: { code } });
      expect(await fn(ctx, SEEN), code).toEqual({ ok: false, error: sentence });
      expect(calls).toHaveLength(1);
    }
  });
});

describe('deleteVoucher', () => {
  it('asks for an id and the status the row showed', () => {
    expect(deleteVoucherInput.safeParse({ id: 'x', status: 'draft' }).error?.issues[0]?.message).toBe('That voucher no longer exists.');
    expect(deleteVoucherInput.safeParse(undefined).error?.issues[0]?.message).toBe('That voucher no longer exists.');
    expect(deleteVoucherInput.safeParse({ id: VOUCHER }).error?.issues[0]?.message).toBe(
      'This voucher has changed since you opened it, so it was not deleted. Check it again.',
    );
  });
  it('deletes money out that is no side of a transfer, in the workspace, while it has the status shown', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: VOUCHER }, error: null });
    expect(await deleteVoucher(ctx, { id: VOUCHER, status: 'pending_approval' })).toEqual({ ok: true, data: { id: VOUCHER } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'table', name: 'finance_transactions', op: 'delete' });
    expect(calls[0].filters).toEqual({ id: VOUCHER, org_id: 'org-1', direction: 'out', 'transfer_id is': null, status: 'pending_approval' });
  });
  it('says gone, or changed, when no row matched', async () => {
    const none = (now: FinanceAnswer) => fakeFinance((call: FinanceCall) => (call.op === 'delete' ? { data: null, error: null } : now));
    const gone = none({ data: null, error: null });
    expect(await deleteVoucher(gone.ctx, { id: VOUCHER, status: 'scheduled' })).toEqual({ ok: false, error: 'That voucher no longer exists.' });
    const moved = none({ data: { status: 'scheduled' }, error: null });
    expect(await deleteVoucher(moved.ctx, { id: VOUCHER, status: 'pending_approval' })).toEqual({
      ok: false,
      error: 'This voucher has changed since you opened it, so it was not deleted. Check it again.',
    });
  });
  it('words the refusal of a paid voucher', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN09' } });
    expect(await deleteVoucher(ctx, { id: VOUCHER, status: 'posted' })).toEqual({
      ok: false,
      error: 'This voucher has been paid or voided, so it cannot be deleted.',
    });
  });
});
