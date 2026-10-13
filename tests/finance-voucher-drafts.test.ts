import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveVoucher, saveVoucherInput, submitVoucher } from '@/lib/finance/vouchers';
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';

const VOUCHER = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const CONTACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BILL_A = 'b1111111-1111-4111-8111-111111111111';
const BILL_B = 'b2222222-2222-4222-8222-222222222222';

const shared = { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx' as const, reference: 'REF 1', notes: 'October' };
const forBills = { kind: 'bills' as const, ...shared, allocations: [{ bill_id: BILL_A, amount: 100 }, { bill_id: BILL_B, amount: 50.005 }] };
const forCategory = { kind: 'category' as const, ...shared, category_id: CATEGORY, amount: 300, party_name: 'Tenaga Nasional' };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveVoucherInput.safeParse(value).error?.issues[0]?.message;

describe('saveVoucherInput', () => {
  it('asks which of the two it is', () => {
    expect(first({ ...shared })).toBe('Choose what this voucher is for: a supplier’s bills, or an expense category.');
    expect(first({ ...forBills, kind: 'expenses' })).toBe('Choose what this voucher is for: a supplier’s bills, or an expense category.');
    expect(first(null)).toBe('Choose what this voucher is for: a supplier’s bills, or an expense category.');
  });
  it('takes bills, each once, with an amount above 0 rounded to the sen, and no payee, category or amount of its own', () => {
    const parsed = saveVoucherInput.parse({ ...forBills, category_id: CATEGORY, amount: 9, contact_id: CONTACT, party_name: 'X', status: 'scheduled', org_id: 'other' });
    expect(Object.keys(parsed).sort()).toEqual(['account_id', 'allocations', 'kind', 'method', 'notes', 'reference', 'send', 'txn_date']);
    expect(parsed).toMatchObject({ send: false, allocations: [{ bill_id: BILL_A, amount: 100 }, { bill_id: BILL_B, amount: 50.01 }] });
    expect(first({ ...forBills, allocations: [] })).toBe('Choose at least one bill this voucher pays.');
    expect(first({ ...forBills, allocations: undefined })).toBe('Choose at least one bill this voucher pays.');
    expect(first({ ...forBills, allocations: [{ bill_id: 'x', amount: 1 }] })).toBe('Choose at least one bill this voucher pays.');
    expect(first({ ...forBills, allocations: [{ bill_id: BILL_A, amount: 1 }, { bill_id: BILL_A.toUpperCase(), amount: 2 }] })).toBe('Each bill can appear once on a voucher.');
    expect(first({ ...forBills, allocations: Array.from({ length: 51 }, () => ({ bill_id: BILL_A, amount: 1 })) })).toBe('One voucher can pay at most 50 bills.');
    for (const amount of [0, 0.004, -5, Number.NaN, Number.POSITIVE_INFINITY, '100', 1_000_000_000_000]) {
      expect(first({ ...forBills, allocations: [{ bill_id: BILL_A, amount }] }), String(amount)).toBe('Enter an amount above 0.');
    }
  });
  it('takes a category with an amount and exactly one payee, as a recorded voucher does', () => {
    expect(saveVoucherInput.parse(forCategory)).toMatchObject({ kind: 'category', contact_id: null, party_name: 'Tenaga Nasional', amount: 300, send: false });
    expect(first({ ...forCategory, category_id: '' })).toBe('Choose an expense category.');
    expect(first({ ...forCategory, amount: Number.NaN })).toBe('Enter an amount above 0.');
    expect(first({ ...forCategory, contact_id: CONTACT })).toBe('Choose who is paid from your contacts or type a name, not both.');
    expect(first({ ...forCategory, party_name: ' ' })).toBe('Say who is paid: choose a contact or type a name.');
  });
  it('asks for an account, a date and a method, takes a draft’s id, and clears a reference or notes that are left out', () => {
    expect(first({ ...forBills, account_id: '' })).toBe('Choose the account the money leaves.');
    expect(first({ ...forBills, txn_date: '5 Oct' })).toBe('Enter a valid date.');
    expect(first({ ...forBills, method: 'barter' })).toBe('Choose how it is paid.');
    expect(first({ ...forBills, id: 'x' })).toBe('That voucher no longer exists.');
    expect(first({ ...forBills, send: 'yes' })).toBe('Check who is paid, the amount and the method, then try again.');
    expect(saveVoucherInput.parse({ kind: 'bills', id: VOUCHER, account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', allocations: forBills.allocations })).toMatchObject({
      id: VOUCHER, reference: null, notes: null,
    });
  });
});

/** Answers the function call with `rpc`, and the read of the status that follows it with `status`. */
function recording(rpc: FinanceAnswer, status: FinanceAnswer = { data: { status: 'draft' }, error: null }) {
  return fakeFinance((call: FinanceCall) => (call.kind === 'rpc' ? rpc : status));
}

describe('saveVoucher', () => {
  it('saves a draft for bills: no payee, category or amount is sent, the split is, and the status asked is draft', async () => {
    const { ctx, calls } = recording({ data: VOUCHER, error: null });
    expect(await saveVoucher(ctx, forBills)).toEqual({ ok: true, data: { id: VOUCHER, status: 'draft' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_voucher' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      voucher: { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', reference: 'REF 1', notes: 'October', status: 'draft' },
      allocations: [{ bill_id: BILL_A, amount: 100 }, { bill_id: BILL_B, amount: 50.01 }],
    });
    expect(calls[1]).toMatchObject({ kind: 'table', name: 'finance_payment_vouchers', op: 'select', filters: { org_id: 'org-1', transaction_id: VOUCHER } });
    expect(calls).toHaveLength(2);
  });
  it('changes a draft and sends it in the same call when asked', async () => {
    const { ctx, calls } = recording({ data: VOUCHER, error: null }, { data: { status: 'pending_approval' }, error: null });
    expect(await saveVoucher(ctx, { ...forBills, id: VOUCHER, send: true })).toEqual({ ok: true, data: { id: VOUCHER, status: 'pending_approval' } });
    expect(calls[0].args).toMatchObject({ voucher: { id: VOUCHER, status: 'pending_approval' } });
    expect(calls.filter((c) => c.kind === 'rpc')).toHaveLength(1);
  });
  it('saves a draft for a category with its amount and payee and an empty split', async () => {
    const { ctx, calls } = recording({ data: VOUCHER, error: null });
    await saveVoucher(ctx, forCategory);
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      voucher: { ...shared, status: 'draft', category_id: CATEGORY, amount: 300, contact_id: null, party_name: 'Tenaga Nasional' },
      allocations: [],
    });
  });
  it('still answers saved when the status cannot be read back, and not when the database answers nothing', async () => {
    const unread = recording({ data: VOUCHER, error: null }, { data: null, error: { code: 'XX000' } });
    expect(await saveVoucher(unread.ctx, forBills)).toEqual({ ok: true, data: { id: VOUCHER, status: null } });
    const nothing = recording({ data: null, error: null });
    expect(await saveVoucher(nothing.ctx, forBills)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
  });
  it('words each refusal, and reads nothing after one', async () => {
    const cases: [string, string][] = [
      ['FIN04', 'A voucher can only pay a posted bill.'],
      ['FIN05', 'That is more than is still owed on a bill, counting what payments and vouchers not yet paid already hold.'],
      ['FIN06', 'The bills on one voucher must all be one supplier’s, and must still exist.'],
      ['FIN09', 'This voucher is no longer a draft, so it cannot be changed. Check it again.'],
      ['FIN11', 'That voucher no longer exists.'],
      ['FIN15', 'Choose an expense category that still exists.'],
      ['FIN37', 'That account has been archived. Choose another account.'],
      ['23505', 'Each bill can appear once on a voucher.'],
      ['23503', 'The account, the contact or the category on this voucher no longer exists.'],
      ['23514', 'Check who is paid, the amount and the method, then try again.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
      // Not codes saving can meet through the screen: the general sentence, not a sign-off one.
      ['FIN14', 'That change could not be saved. Please try again.'],
      ['FIN03', 'That change could not be saved. Please try again.'],
    ];
    for (const [code, sentence] of cases) {
      const { ctx, calls } = recording({ data: null, error: { code } });
      expect(await saveVoucher(ctx, forBills), code).toEqual({ ok: false, error: sentence });
      expect(calls).toHaveLength(1);
    }
  });
});

/** What the draft's row showed when Send for approval was pressed: a voucher for bills has a contact and nothing typed. */
const SEEN = {
  id: VOUCHER, amount: 150, txn_date: '2026-10-05', method: 'fpx', account_id: ACCOUNT,
  contact_id: CONTACT, party_name: null, category_id: null, reference: null, notes: 'October',
} as const;

describe('submitVoucher', () => {
  it('changes the status and nothing else, on the draft as it was shown, kept to the workspace and to money out', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: VOUCHER }, error: null });
    expect(await submitVoucher(ctx, SEEN)).toEqual({ ok: true, data: { id: VOUCHER } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'table', name: 'finance_transactions', op: 'update' });
    expect(calls[0].filters).toEqual({
      id: VOUCHER, org_id: 'org-1', direction: 'out', 'transfer_id is': null, status: 'draft',
      amount: 150, txn_date: '2026-10-05', method: 'fpx', account_id: ACCOUNT,
      contact_id: CONTACT, 'party_name is': null, 'category_id is': null, 'reference is': null, notes: 'October',
    });
    expect(Object.keys(calls[0].values ?? {}).sort()).toEqual(['status', 'updated_at']);
    expect(calls[0].values?.status).toBe('pending_approval');
  });
  it('says why when no row matched: gone, changed, or no longer a draft', async () => {
    const changesNothing = (now: FinanceAnswer) => fakeFinance((call: FinanceCall) => (call.op === 'update' ? { data: null, error: null } : now));
    expect(await submitVoucher(changesNothing({ data: null, error: null }).ctx, SEEN)).toEqual({ ok: false, error: 'That voucher no longer exists.' });
    expect(await submitVoucher(changesNothing({ data: { status: 'draft' }, error: null }).ctx, SEEN)).toEqual({
      ok: false, error: 'This draft is not as it was shown to you, so it was not sent. Check it again.',
    });
    for (const status of ['pending_approval', 'scheduled', 'rejected', 'posted', 'void']) {
      expect(await submitVoucher(changesNothing({ data: { status }, error: null }).ctx, SEEN), status).toEqual({
        ok: false, error: 'This voucher is no longer a draft, so it was not sent for approval. Check it again.',
      });
    }
  });
  it('words an archived account, and gives a sign-off refusal no sentence of its own', async () => {
    const refused = (code: string) => fakeFinance({ data: null, error: { code } }).ctx;
    expect(await submitVoucher(refused('FIN37'), SEEN)).toEqual({
      ok: false, error: 'The account this draft is paid from has been archived, so it cannot be sent for approval. Edit it and choose another account.',
    });
    expect(await submitVoucher(refused('42501'), SEEN)).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
    expect(await submitVoucher(refused('FIN14'), SEEN)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
  });
});
