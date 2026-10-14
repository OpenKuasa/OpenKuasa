import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ExpensePayForm,
  expensePaidText,
  expensePaidTitle,
  expensePayCurrent,
  expensePayError,
  expensePayHint,
  expensePayPayload,
  markExpensePaid,
  markExpensePaidInput,
  newExpensePayForm,
} from '@/lib/finance/expense-payment';
import type { ExpenseRow } from '@/lib/finance/expenses';
import type { FinanceAccount } from '@/lib/finance/money';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

const EXPENSE = '55555555-5555-4555-8555-555555555555';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const CONTACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BANK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CASH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VOUCHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SEEN = '2026-10-12T09:15:22.123456+00:00';

const ACCOUNTS: FinanceAccount[] = [
  { id: CASH, name: 'Petty Cash', kind: 'cash', bank_name: null },
  { id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank' },
];

function approved(over: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: EXPENSE,
    expense_date: '2026-10-05',
    category_id: CATEGORY,
    category_name: 'Rent',
    vendor_id: null,
    vendor_name: 'Kedai Ali',
    amount: 120,
    sst_amount: 6,
    notes: null,
    status: 'approved',
    display_status: 'approved',
    paid: 0,
    held: 0,
    method: null,
    paid_on: null,
    updated_at: SEEN,
    ...over,
  };
}

const payment = { id: EXPENSE, updated_at: SEEN, account_id: BANK, txn_date: '2026-10-12', method: 'bank_transfer' as const, reference: 'TT 1', amount: 120 };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => markExpensePaidInput.safeParse(value).error?.issues[0]?.message;
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

describe('markExpensePaidInput', () => {
  it('asks for the expense as it was shown, an account, a real date and a method', () => {
    expect(first({ ...payment, id: 'nope' })).toBe('That expense no longer exists.');
    expect(first(without(payment, 'updated_at'))).toBe('This expense was changed after you opened it. Check it again, then mark it paid.');
    expect(first({ ...payment, updated_at: '2026-10-12 09:15:22' })).toBe('This expense was changed after you opened it. Check it again, then mark it paid.');
    expect(first({ ...payment, account_id: '' })).toBe('Choose the account the money leaves.');
    expect(first({ ...payment, txn_date: '12 Oct' })).toBe('Enter a valid date.');
    expect(first({ ...payment, txn_date: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...payment, method: 'barter' })).toBe('Choose how it was paid.');
    expect(first(null)).toBe('Check the account, the method and the amount, then try again.');
  });
  it('asks for an amount above 0 that fits the column, and refuses NaN', () => {
    for (const amount of [0, 0.004, -5, Number.NaN, Number.POSITIVE_INFINITY, '120', 1_000_000_000_000]) {
      expect(first({ ...payment, amount }), String(amount)).toBe('Enter an amount above 0.');
    }
    expect(markExpensePaidInput.parse({ ...payment, amount: 10.006 }).amount).toBe(10.01);
  });
  it('keeps only its own fields: never a payee, a status or a workspace', () => {
    const parsed = markExpensePaidInput.parse({ ...payment, status: 'scheduled', org_id: 'other', contact_id: CONTACT, party_name: 'Me', category_id: CATEGORY });
    expect(Object.keys(parsed).sort()).toEqual(['account_id', 'amount', 'id', 'method', 'reference', 'txn_date', 'updated_at']);
    expect(markExpensePaidInput.parse(without(payment, 'reference')).reference).toBeNull();
    expect(markExpensePaidInput.parse({ ...payment, reference: '   ' }).reference).toBeNull();
    expect(first({ ...payment, reference: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
});

/** Answers the read of the expense, the voucher function and the read of the voucher's number, in that order. */
function database(answers: { shown?: unknown; still?: unknown; rpc?: { data: unknown; error: unknown }; number?: unknown }) {
  return fakeFinance((call: FinanceCall) => {
    if (call.kind === 'rpc') return answers.rpc ?? { data: VOUCHER, error: null };
    if (call.name === 'finance_transactions') return { data: answers.number === undefined ? { number: 'PV-0007' } : answers.number, error: null };
    if ('updated_at' in call.filters) return { data: answers.shown === undefined ? { id: EXPENSE, vendor_id: null, vendor_name: 'Kedai Ali' } : answers.shown, error: null };
    return { data: answers.still ?? null, error: null };
  });
}

describe('markExpensePaid', () => {
  it('reads the expense as shown, then records one posted voucher against it, paid to its typed vendor', async () => {
    const { ctx, calls } = database({});
    expect(await markExpensePaid(ctx, payment)).toEqual({ ok: true, data: { id: EXPENSE, voucher_id: VOUCHER, number: 'PV-0007' } });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ kind: 'table', name: 'finance_expenses', op: 'select', columns: 'id,vendor_id,vendor_name' });
    expect(calls[0].filters).toEqual({ id: EXPENSE, org_id: 'org-1', status: 'approved', updated_at: SEEN });
    expect(calls[1]).toMatchObject({ kind: 'rpc', name: 'finance_record_voucher' });
    expect(calls[1].args).toEqual({
      target_org: 'org-1',
      voucher: { account_id: BANK, txn_date: '2026-10-12', method: 'bank_transfer', reference: 'TT 1', status: 'posted', party_name: 'Kedai Ali' },
      allocations: [{ expense_id: EXPENSE, amount: 120 }],
    });
    expect(calls[2]).toMatchObject({ kind: 'table', name: 'finance_transactions', op: 'select', columns: 'number', filters: { id: VOUCHER, org_id: 'org-1' } });
  });
  it('pays a contact when the expense names one, and never both', async () => {
    const { ctx, calls } = database({ shown: { id: EXPENSE, vendor_id: CONTACT, vendor_name: null } });
    expect((await markExpensePaid(ctx, { ...payment, amount: 30 })).ok).toBe(true);
    const voucher = (calls[1].args as { voucher: Record<string, unknown> }).voucher;
    expect(voucher.contact_id).toBe(CONTACT);
    expect(voucher).not.toHaveProperty('party_name');
    expect(voucher).not.toHaveProperty('category_id');
    expect((calls[1].args as { allocations: unknown }).allocations).toEqual([{ expense_id: EXPENSE, amount: 30 }]);
  });
  it('answers paid with no number when the voucher could not be read back', async () => {
    expect(await markExpensePaid(database({ number: null }).ctx, payment)).toEqual({ ok: true, data: { id: EXPENSE, voucher_id: VOUCHER, number: null } });
  });
  it('records nothing when the expense is gone, is not approved any more, or was changed', async () => {
    const gone = database({ shown: null });
    expect(await markExpensePaid(gone.ctx, payment)).toEqual({ ok: false, error: 'That expense no longer exists.' });
    expect(gone.calls.map((c) => c.kind)).toEqual(['table', 'table']);
    expect(gone.calls[1]).toMatchObject({ name: 'finance_expenses', columns: 'id,status', filters: { id: EXPENSE, org_id: 'org-1' } });
    expect(gone.calls[1].filters).not.toHaveProperty('updated_at');
    for (const status of ['pending', 'rejected']) {
      const { ctx, calls } = database({ shown: null, still: { id: EXPENSE, status } });
      expect(await markExpensePaid(ctx, payment), status).toEqual({ ok: false, error: 'This expense is not approved any more, so it cannot be paid.' });
      expect(calls.some((c) => c.kind === 'rpc')).toBe(false);
    }
    const changed = database({ shown: null, still: { id: EXPENSE, status: 'approved' } });
    expect(await markExpensePaid(changed.ctx, payment)).toEqual({
      ok: false,
      error: 'This expense was changed after you opened it. Check it again, then mark it paid.',
    });
    expect(changed.calls.some((c) => c.kind === 'rpc')).toBe(false);
  });
  it('words each refusal of the database', async () => {
    const refused = async (code: string) => (await markExpensePaid(database({ rpc: { data: null, error: { code } } }).ctx, payment)) as { ok: false; error: string };
    expect((await refused('FIN04')).error).toBe('This expense is not approved any more, so it cannot be paid.');
    expect((await refused('FIN05')).error).toBe('That is more than is still to pay on this expense.');
    expect((await refused('FIN06')).error).toBe('That expense no longer exists.');
    // An account archived after the card was opened: the shared sentence, not the general one.
    expect((await refused('FIN37')).error).toBe('The account this is on has been archived. Restore it on Banking, or use another account, then try again.');
    expect((await refused('FIN14')).error).toBe('Only an owner or admin can post, pay or void. Ask one of them to do this.');
    expect((await refused('23503')).error).toBe('That account no longer exists. Choose another account.');
    expect((await refused('23514')).error).toBe('Check the account, the method and the amount, then try again.');
    expect((await refused('23502')).error).toBe('Check the account, the method and the amount, then try again.');
    expect((await refused('42501')).error).toBe('You do not have permission to make changes here.');
    expect((await refused('22003')).error).toBe('That amount is too large.');
    expect((await refused('XX000')).error).toBe('That change could not be saved. Please try again.');
    // A function that answers neither an id nor an error is not a payment.
    expect((await markExpensePaid(database({ rpc: { data: null, error: null } }).ctx, payment)).ok).toBe(false);
  });
  it('refuses an input the schema refuses, before anything is read', async () => {
    const { ctx, calls } = database({});
    await expect(markExpensePaid(ctx, { ...payment, amount: Number.NaN })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('the Mark paid card', () => {
  const form = (over: Partial<ExpensePayForm> = {}): ExpensePayForm => ({ ...newExpensePayForm(approved(), ACCOUNTS, '2026-10-12'), ...over });

  it('starts with the first bank account, today, a bank transfer and all that is left', () => {
    expect(newExpensePayForm(approved(), ACCOUNTS, '2026-10-12')).toEqual({
      accountId: BANK, date: '2026-10-12', method: 'bank_transfer', reference: '', amount: '120.00',
    });
    expect(newExpensePayForm(approved({ paid: 30, held: 20 }), ACCOUNTS, '2026-10-12').amount).toBe('70.00');
    expect(newExpensePayForm(approved({ paid: 100.1, held: 19.9 }), ACCOUNTS, '2026-10-12').amount).toBe('');
    expect(newExpensePayForm(approved(), [ACCOUNTS[0]], '2026-10-12').accountId).toBe(CASH);
    expect(newExpensePayForm(approved(), [], '2026-10-12').accountId).toBe('');
  });
  it('sends the expense as shown and the amount as a number', () => {
    expect(expensePayPayload(approved(), form({ reference: ' TT 1 ', amount: '70' }))).toEqual({
      id: EXPENSE, updated_at: SEEN, account_id: BANK, txn_date: '2026-10-12', method: 'bank_transfer', reference: ' TT 1 ', amount: 70,
    });
    expect(Number.isNaN(expensePayPayload(approved(), form({ amount: '1,200.50' })).amount)).toBe(true);
    expect(Number.isNaN(expensePayPayload(approved(), form({ amount: '' })).amount)).toBe(true);
  });
  it('can be sent as it opens, and for any part of what is left', () => {
    expect(expensePayError(approved(), form(), ACCOUNTS)).toBeNull();
    expect(expensePayError(approved(), form({ amount: '0.01' }), ACCOUNTS)).toBeNull();
    expect(expensePayError(approved({ paid: 30, held: 20 }), form({ amount: '70' }), ACCOUNTS)).toBeNull();
  });
  it('refuses more than is left, counting what is paid and what is to be paid', () => {
    expect(expensePayError(approved(), form({ amount: '120.01' }), ACCOUNTS)).toBe('That is more than is still to pay on this expense.');
    expect(expensePayError(approved({ paid: 30, held: 20 }), form({ amount: '70.01' }), ACCOUNTS)).toBe('That is more than is still to pay on this expense.');
    // Too big for the column is still more than is left: the card says so, not "above 0".
    expect(expensePayError(approved(), form({ amount: '99999999999999' }), ACCOUNTS)).toBe('That is more than is still to pay on this expense.');
    expect(expensePayError(approved(), form({ amount: '1000000000000' }), ACCOUNTS)).toBe('That is more than is still to pay on this expense.');
    expect(expensePayError(approved({ paid: 120, display_status: 'paid' }), form(), ACCOUNTS)).toBe('Nothing is left to pay on this expense.');
    expect(expensePayError(approved({ held: 120 }), form(), ACCOUNTS)).toBe('Nothing is left to pay on this expense.');
  });
  it('says what is wrong with the box, the date, the account and the expense', () => {
    expect(expensePayError(approved(), form({ amount: '' }), ACCOUNTS)).toBe('Enter an amount above 0.');
    expect(expensePayError(approved(), form({ amount: '0' }), ACCOUNTS)).toBe('Enter an amount above 0.');
    expect(expensePayError(approved(), form({ amount: '1,200.50' }), ACCOUNTS)).toBe('Enter the amount as a number, without commas or RM: 1200.50.');
    expect(expensePayError(approved(), form({ amount: 'RM 20' }), ACCOUNTS)).toBe('Enter the amount as a number, without commas or RM: 1200.50.');
    expect(expensePayError(approved(), form({ amount: '12.345' }), ACCOUNTS)).toBe('Enter the amount to two decimal places.');
    expect(expensePayError(approved(), form({ date: '', amount: '1,0' }), ACCOUNTS)).toBe('Enter a valid date.');
    expect(expensePayError(approved(), form({ accountId: '' }), ACCOUNTS)).toBe('Choose the account the money leaves.');
    expect(expensePayError(approved(), form({ accountId: '' }), [])).toBe('There is no account to pay from. Add a bank or cash account on Banking first.');
    expect(expensePayError(approved({ status: 'rejected', display_status: 'rejected' }), form(), ACCOUNTS)).toBe(
      'This expense is not approved any more, so it cannot be paid.',
    );
    expect(expensePayError(approved(), form({ reference: 'x'.repeat(201) }), ACCOUNTS)).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('says what is still to pay, what already stands against the expense, and what marking paid records', () => {
    const VOUCHER = ' This records a payment voucher, paid now: it shows on Payment Vouchers and Banking. To undo a wrong one, void it on Payment Vouchers.';
    expect(expensePayHint(approved())).toBe(`RM 120.00 is still to pay on this expense. Paying less leaves the rest for another payment.${VOUCHER}`);
    expect(expensePayHint(approved({ paid: 30 }))).toBe(
      `RM 90.00 is still to pay on this expense: RM 30.00 is paid. Paying less leaves the rest for another payment.${VOUCHER}`,
    );
    expect(expensePayHint(approved({ held: 20 }))).toBe(
      `RM 100.00 is still to pay on this expense: RM 20.00 is in a payment not yet paid. Paying less leaves the rest for another payment.${VOUCHER}`,
    );
    expect(expensePayHint(approved({ paid: 30, held: 20 }))).toBe(
      `RM 70.00 is still to pay on this expense: RM 30.00 is paid and RM 20.00 is in a payment not yet paid. Paying less leaves the rest for another payment.${VOUCHER}`,
    );
    // An expense that can no longer be paid says only that: nothing about a voucher that will not be recorded.
    expect(expensePayHint(approved({ paid: 120, display_status: 'paid' }))).toBe('Nothing is left to pay on this expense.');
    expect(expensePayHint(approved({ held: 120 }))).toBe('Nothing is left to pay on this expense.');
    expect(expensePayHint(approved({ status: 'rejected', display_status: 'rejected' }))).toBe('This expense is not approved any more, so it cannot be paid.');
    expect(expensePayHint(approved({ status: 'pending', display_status: 'pending' }))).toBe('This expense is not approved any more, so it cannot be paid.');
  });
  it('follows the list under the open card, and says so when the expense is gone from it', () => {
    const opened = approved();
    const now = approved({ paid: 30 });
    expect(expensePayCurrent(opened, [approved({ id: 'other' }), now])).toEqual({ row: now, gone: false });
    expect(expensePayCurrent(opened, [approved({ id: 'other' })])).toEqual({ row: opened, gone: true });
    expect(expensePayCurrent(opened, [])).toEqual({ row: opened, gone: true });
    // Gone, the hint and the refusal both say so: never "still to pay", never a payment sent.
    expect(expensePayHint(opened, true)).toBe('That expense no longer exists.');
    expect(expensePayError(opened, form(), ACCOUNTS, true)).toBe('That expense no longer exists.');
    expect(expensePayHint(opened, false)).toBe(expensePayHint(opened));
    expect(expensePayError(opened, form(), ACCOUNTS, false)).toBeNull();
  });
  it('words the note for a payment in full and in part, with and without the number', () => {
    const note = { expenseId: EXPENSE, amount: 120, paidBefore: 0, vendor: 'Kedai Ali', account: 'Main Bank', number: 'PV-0007' };
    expect(expensePaidText(note)).toBe('RM 120.00 to Kedai Ali was paid from Main Bank as PV-0007. The payment is on Banking and on');
    expect(expensePaidText({ ...note, number: null })).toBe('RM 120.00 to Kedai Ali was paid from Main Bank. The payment is on Banking and on');
  });
  it('titles the note from the refreshed row, never from the row as the card opened', () => {
    const note = { expenseId: EXPENSE, amount: 100, paidBefore: 0, vendor: 'Kedai Ali', account: 'Main Bank', number: 'PV-0007' };
    // In full: the list now reads the expense paid.
    expect(expensePaidTitle(note, approved({ amount: 100, paid: 100, display_status: 'paid' }))).toBe('Expense paid');
    // In part: the list reads some of it paid.
    expect(expensePaidTitle({ ...note, amount: 30 }, approved({ amount: 100, paid: 30 }))).toBe('Part of the expense paid');
    // Money held for a payment not made yet is not paid: paying the rest of a part-held expense is only a part.
    expect(expensePaidTitle({ ...note, amount: 100 }, approved({ amount: 126, paid: 100, held: 26 }))).toBe('Part of the expense paid');
    // The stale case: a held payment was deleted meanwhile, so 100 was not all that was owed. Before the list refreshes, or if the
    // row cannot be found, the note says only that a payment was recorded; it never says the expense is paid.
    expect(expensePaidTitle(note, approved({ amount: 126, paid: 0, held: 26 }))).toBe('Payment recorded');
    expect(expensePaidTitle(note, approved({ amount: 100, paid: 0 }))).toBe('Payment recorded');
    expect(expensePaidTitle(note, undefined)).toBe('Payment recorded');
    // Refreshed, with the held payment gone: 100 of 126 is paid and 26 is still owed.
    expect(expensePaidTitle(note, approved({ amount: 126, paid: 100 }))).toBe('Part of the expense paid');
    // Paid before by someone else: what was paid then counts.
    expect(expensePaidTitle({ ...note, amount: 70, paidBefore: 30 }, approved({ amount: 100, paid: 100, display_status: 'paid' }))).toBe('Expense paid');
  });
});
