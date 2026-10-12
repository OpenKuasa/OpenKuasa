import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveExpense,
  deleteExpense,
  expenseIdInput,
  listExpenseCategories,
  rejectExpense,
  saveExpense,
  saveExpenseInput,
} from '@/lib/finance/expenses';
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';

const EXPENSE = '55555555-5555-4555-8555-555555555555';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const CONTACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const typed = {
  expense_date: '2026-10-05',
  category_id: CATEGORY,
  vendor_name: 'Kedai Ali',
  amount: 120,
  sst_amount: 6,
  notes: 'Printer paper',
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveExpenseInput.safeParse(value).error?.issues[0]?.message;
/** The same object with one field left out. */
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

describe('saveExpenseInput', () => {
  it('asks for a real date and a category', () => {
    expect(first({ ...typed, expense_date: '5 Oct' })).toBe('Enter a valid date.');
    expect(first(without(typed, 'expense_date'))).toBe('Enter a valid date.');
    expect(first({ ...typed, category_id: '' })).toBe('Choose an expense category.');
    expect(first(without(typed, 'category_id'))).toBe('Choose an expense category.');
    expect(first({ ...typed, id: 'nope' })).toBe('That expense no longer exists.');
    expect(first(null)).toBe('Check the vendor, the amount and the SST, then try again.');
  });
  it('asks for an amount above 0 that fits the column, and refuses NaN', () => {
    expect(first({ ...typed, amount: 0 })).toBe('Enter an amount above 0.');
    expect(first({ ...typed, amount: 0.004 })).toBe('Enter an amount above 0.');
    expect(first({ ...typed, amount: Number.NaN })).toBe('Enter an amount above 0.');
    expect(first({ ...typed, amount: Number.POSITIVE_INFINITY })).toBe('Enter an amount above 0.');
    expect(first({ ...typed, amount: '120' })).toBe('Enter an amount above 0.');
    expect(first({ ...typed, amount: 1_000_000_000_000 })).toBe('Enter an amount above 0.');
  });
  it('takes SST of 0 or more, never NaN and never more than the amount', () => {
    expect(first({ ...typed, sst_amount: -1 })).toBe('Enter the SST that is inside the amount: 0 or more.');
    expect(first({ ...typed, sst_amount: Number.NaN })).toBe('Enter the SST that is inside the amount: 0 or more.');
    expect(first({ ...typed, sst_amount: '6' })).toBe('Enter the SST that is inside the amount: 0 or more.');
    expect(first({ ...typed, sst_amount: 120.01 })).toBe('The SST cannot be more than the amount.');
    expect(saveExpenseInput.parse({ ...typed, sst_amount: 120 }).sst_amount).toBe(120);
    expect(saveExpenseInput.parse(without(typed, 'sst_amount')).sst_amount).toBe(0);
    // Both are rounded to the sen before they are compared.
    expect(saveExpenseInput.parse({ ...typed, amount: 10.004, sst_amount: 10.004 })).toMatchObject({ amount: 10, sst_amount: 10 });
  });
  it('takes a contact or a typed name as the vendor: exactly one', () => {
    expect(first({ ...typed, vendor_id: CONTACT })).toBe('Choose the vendor from your contacts or type a name, not both.');
    expect(first({ ...typed, vendor_name: null, vendor_id: 'someone' })).toBe('Choose the vendor from your contacts or type a name, not both.');
    expect(first(without(typed, 'vendor_name'))).toBe('Say who was paid: choose a contact or type a name.');
    expect(first({ ...typed, vendor_name: '   ' })).toBe('Say who was paid: choose a contact or type a name.');
    expect(saveExpenseInput.parse({ ...typed, vendor_name: ' ', vendor_id: CONTACT })).toMatchObject({ vendor_id: CONTACT, vendor_name: null });
    expect(saveExpenseInput.parse({ ...typed, vendor_name: '  Kedai Ali ', vendor_id: '' })).toMatchObject({ vendor_id: null, vendor_name: 'Kedai Ali' });
  });
  it('keeps text short, and never takes a status', () => {
    expect(first({ ...typed, notes: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
    expect(first({ ...typed, vendor_name: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
    const parsed = saveExpenseInput.parse({ ...typed, status: 'approved', approved_by: CONTACT, org_id: 'other', created_by: CONTACT });
    expect(Object.keys(parsed).sort()).toEqual(['amount', 'category_id', 'expense_date', 'notes', 'sst_amount', 'vendor_id', 'vendor_name']);
  });
  it('asks an id of the id input', () => {
    expect(expenseIdInput.safeParse({ id: 'x' }).error?.issues[0]?.message).toBe('That expense no longer exists.');
    expect(expenseIdInput.safeParse(undefined).error?.issues[0]?.message).toBe('That expense no longer exists.');
  });
});

/** Answers the function call with `rpc`, and the read of the status that follows it with `status`. */
function saving(rpc: FinanceAnswer, status: FinanceAnswer = { data: { status: 'pending' }, error: null }) {
  return fakeFinance((call: FinanceCall) => (call.kind === 'rpc' ? rpc : status));
}

describe('saveExpense', () => {
  it('sends the expense and nothing else, then reads how the database left it', async () => {
    const { ctx, calls } = saving({ data: EXPENSE, error: null }, { data: { status: 'approved' }, error: null });
    expect(await saveExpense(ctx, { ...typed, id: EXPENSE })).toEqual({ ok: true, data: { id: EXPENSE, status: 'approved' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_expense' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      expense: { id: EXPENSE, expense_date: '2026-10-05', category_id: CATEGORY, vendor_id: null, vendor_name: 'Kedai Ali', amount: 120, sst_amount: 6, notes: 'Printer paper' },
    });
    expect(calls[1]).toMatchObject({ kind: 'table', name: 'finance_expenses', op: 'select', columns: 'status', filters: { id: EXPENSE, org_id: 'org-1' } });
    expect(calls).toHaveLength(2);
  });
  it('sends no id for a new expense, and a contact with no name', async () => {
    const { ctx, calls } = saving({ data: EXPENSE, error: null });
    await saveExpense(ctx, { ...without(typed, 'vendor_name'), vendor_id: CONTACT } as never);
    expect(calls[0].args?.expense).toEqual({
      expense_date: '2026-10-05', category_id: CATEGORY, vendor_id: CONTACT, vendor_name: null, amount: 120, sst_amount: 6, notes: 'Printer paper',
    });
  });
  it('still answers saved when the status cannot be read back', async () => {
    const { ctx } = saving({ data: EXPENSE, error: null }, { data: null, error: { code: 'XX000' } });
    expect(await saveExpense(ctx, typed)).toEqual({ ok: true, data: { id: EXPENSE, status: null } });
  });
  it('words each refusal, and reads nothing after one', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'This expense has been approved, so it can no longer be changed. An owner or admin can reject it first, while no payment stands against it.'],
      ['FIN11', 'That expense no longer exists.'],
      ['FIN15', 'Choose an expense category that still exists.'],
      ['23503', 'The category or the vendor on this expense no longer exists.'],
      ['23514', 'Check the vendor, the amount and the SST, then try again.'],
      ['23502', 'Check the vendor, the amount and the SST, then try again.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
      ['XX000', 'That change could not be saved. Please try again.'],
    ];
    for (const [code, sentence] of cases) {
      const { ctx, calls } = saving({ data: null, error: { code } });
      expect(await saveExpense(ctx, typed), code).toEqual({ ok: false, error: sentence });
      expect(calls).toHaveLength(1);
    }
  });
});

describe('approveExpense, rejectExpense', () => {
  it('change the status and nothing else, kept to the workspace', async () => {
    for (const [fn, status] of [[approveExpense, 'approved'], [rejectExpense, 'rejected']] as const) {
      const { ctx, calls } = fakeFinance({ data: { id: EXPENSE }, error: null });
      expect(await fn(ctx, { id: EXPENSE })).toEqual({ ok: true, data: { id: EXPENSE } });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ kind: 'table', name: 'finance_expenses', op: 'update', filters: { id: EXPENSE, org_id: 'org-1' } });
      expect(Object.keys(calls[0].values ?? {}).sort()).toEqual(['status', 'updated_at']);
      expect(calls[0].values?.status).toBe(status);
    }
  });
  it('answer "no longer exists" when no row was changed', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    expect(await approveExpense(ctx, { id: EXPENSE })).toEqual({ ok: false, error: 'That expense no longer exists.' });
    expect(await rejectExpense(ctx, { id: EXPENSE })).toEqual({ ok: false, error: 'That expense no longer exists.' });
  });
  it('word FIN01, FIN02 and FIN14 by what was being done', async () => {
    const refused = (code: string) => fakeFinance({ data: null, error: { code } }).ctx;
    const decider = 'Only an owner or admin can approve or reject an expense. Ask one of them to do this.';
    expect((await approveExpense(refused('FIN01'), { id: EXPENSE }))).toEqual({
      ok: false,
      error: 'This expense cannot be approved as it now stands: it is already approved, or it was rejected and has to be edited first.',
    });
    expect(await approveExpense(refused('FIN14'), { id: EXPENSE })).toEqual({ ok: false, error: decider });
    expect(await rejectExpense(refused('FIN01'), { id: EXPENSE })).toEqual({ ok: false, error: 'This expense has already been rejected.' });
    expect(await rejectExpense(refused('FIN02'), { id: EXPENSE })).toEqual({
      ok: false,
      error: 'This expense has a payment against it, paid or still to be paid, so it cannot be rejected.',
    });
    expect(await rejectExpense(refused('FIN14'), { id: EXPENSE })).toEqual({ ok: false, error: decider });
    // FIN02 has no meaning for an approval: it is not worded as one.
    expect(await approveExpense(refused('FIN02'), { id: EXPENSE })).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
  });
});

describe('deleteExpense', () => {
  it('deletes one row of the workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: EXPENSE }, error: null });
    expect(await deleteExpense(ctx, { id: EXPENSE })).toEqual({ ok: true, data: { id: EXPENSE } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'table', name: 'finance_expenses', op: 'delete', filters: { id: EXPENSE, org_id: 'org-1' } });
  });
  it('words an approved expense, a voided payment and a row that is gone', async () => {
    const refused = (code: string) => fakeFinance({ data: null, error: { code } }).ctx;
    expect(await deleteExpense(refused('FIN01'), { id: EXPENSE })).toEqual({
      ok: false,
      error: 'An approved expense cannot be deleted. An owner or admin can reject it first, while no payment stands against it.',
    });
    expect(await deleteExpense(refused('23503'), { id: EXPENSE })).toEqual({
      ok: false,
      error: 'This expense has a voided payment against it, so it is kept. It stays in the list as Rejected.',
    });
    expect(await deleteExpense(fakeFinance({ data: null, error: null }).ctx, { id: EXPENSE })).toEqual({ ok: false, error: 'That expense no longer exists.' });
  });
});

describe('listExpenseCategories', () => {
  it('reads the active expense categories of the workspace, by name', async () => {
    const { ctx, calls } = fakeFinance({ data: [{ id: CATEGORY, name: 'Rent' }], error: null });
    expect(await listExpenseCategories(ctx)).toEqual([{ id: CATEGORY, name: 'Rent' }]);
    expect(calls[0]).toMatchObject({ name: 'finance_categories', columns: 'id,name', filters: { org_id: 'org-1', kind: 'expense', active: true }, order: ['name asc'] });
  });
});
