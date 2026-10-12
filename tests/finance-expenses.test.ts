import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveExpense,
  deleteExpense,
  expenseDecisionInput,
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
  it('does not call a save saved when the database answers neither an id nor an error', async () => {
    const { ctx, calls } = saving({ data: null, error: null });
    expect(await saveExpense(ctx, typed)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(calls).toHaveLength(1);
  });
  it('words each refusal, and reads nothing after one', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'This expense has been approved, so it can no longer be changed. An owner or admin can reject it first, while no payment stands against it.'],
      ['FIN11', 'That expense no longer exists.'],
      ['FIN15', 'Choose an expense category that still exists.'],
      ['23503', 'The category or the vendor on this expense no longer exists.'],
      ['23514', 'Check the vendor, the amount and the SST, then try again.'],
      ['23502', 'Check the vendor, the amount and the SST, then try again.'],
      ['FIN14', 'Only an owner or admin can approve or reject an expense. Ask one of them to do this.'],
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

// The exact text the view gave for `updated_at`, microseconds and offset included: it is sent back as it came.
const SEEN = '2026-10-12T09:15:22.123456+00:00';
const SHOWN: {
  status: 'pending' | 'approved' | 'rejected';
  amount: number;
  sst_amount: number;
  expense_date: string;
  category_id: string;
  vendor_id: string | null;
  vendor_name: string | null;
  notes: string | null;
} = {
  status: 'pending',
  amount: 120,
  sst_amount: 6,
  expense_date: '2026-10-05',
  category_id: CATEGORY,
  vendor_id: null,
  vendor_name: 'Kedai Ali',
  notes: 'Printer paper',
};
const SEEN_EXPENSE = { id: EXPENSE, updated_at: SEEN, ...SHOWN };
const CHANGED = 'This expense was changed after you opened it. Check it again, then approve or reject it.';

describe('expenseDecisionInput', () => {
  it('asks for the expense and the time it was last changed, as the view gave it', () => {
    expect(expenseDecisionInput.parse(SEEN_EXPENSE)).toEqual(SEEN_EXPENSE);
    expect(expenseDecisionInput.parse({ ...SEEN_EXPENSE, updated_at: '2026-10-12T09:15:22Z' }).updated_at).toBe('2026-10-12T09:15:22Z');
    expect(expenseDecisionInput.safeParse({ ...SEEN_EXPENSE, id: 'x' }).error?.issues[0]?.message).toBe('That expense no longer exists.');
    for (const bad of [undefined, '', 'yesterday', '2026-10-12', 5]) {
      expect(expenseDecisionInput.safeParse({ ...SEEN_EXPENSE, updated_at: bad }).error?.issues[0]?.message, String(bad)).toBe(CHANGED);
    }
    expect(Object.keys(expenseDecisionInput.parse({ ...SEEN_EXPENSE, org_id: 'other', approved_by: CONTACT })).sort()).toEqual(
      Object.keys(SEEN_EXPENSE).sort(),
    );
  });
  it('asks for the shape of every field the row showed', () => {
    const bad: Record<string, unknown[]> = {
      status: ['paid', '', undefined],
      amount: ['120', Number.NaN, undefined],
      sst_amount: ['6', Number.NaN, undefined],
      expense_date: ['5 Oct', '', undefined],
      category_id: ['x', null, undefined],
      vendor_id: ['x', undefined],
      vendor_name: [5, undefined],
      notes: [5, undefined],
    };
    for (const [field, values] of Object.entries(bad)) {
      for (const value of values) {
        expect(expenseDecisionInput.safeParse({ ...SEEN_EXPENSE, [field]: value }).error?.issues[0]?.message, `${field} ${String(value)}`).toBe(CHANGED);
      }
    }
    expect(expenseDecisionInput.safeParse({ ...SEEN_EXPENSE, vendor_id: CONTACT, vendor_name: 'Supplier A', notes: null }).success).toBe(true);
  });
});

describe('approveExpense, rejectExpense', () => {
  it('change the status and nothing else, on the expense as it was shown, kept to the workspace', async () => {
    for (const [fn, status] of [[approveExpense, 'approved'], [rejectExpense, 'rejected']] as const) {
      const { ctx, calls } = fakeFinance({ data: { id: EXPENSE }, error: null });
      expect(await fn(ctx, SEEN_EXPENSE)).toEqual({ ok: true, data: { id: EXPENSE } });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ kind: 'table', name: 'finance_expenses', op: 'update' });
      // The update matches the expense only as the row showed it, field by field, as the view returned each.
      expect(calls[0].filters).toEqual({
        id: EXPENSE, org_id: 'org-1', updated_at: SEEN, status: 'pending', amount: 120, sst_amount: 6, expense_date: '2026-10-05',
        category_id: CATEGORY, 'vendor_id is': null, vendor_name: 'Kedai Ali', notes: 'Printer paper',
      });
      expect(Object.keys(calls[0].values ?? {}).sort()).toEqual(['status', 'updated_at']);
      expect(calls[0].values?.status).toBe(status);
    }
  });
  /** An update that changes no row, then the read of whether the expense is still there. */
  const changesNothing = (stillThere: boolean) =>
    fakeFinance((call: FinanceCall) =>
      call.op === 'update' ? { data: null, error: null } : { data: stillThere ? { id: EXPENSE, status: 'pending' } : null, error: null },
    );
  it('match a decision with no notes by `is null`, never by equality', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: EXPENSE }, error: null });
    await approveExpense(ctx, { ...SEEN_EXPENSE, notes: null });
    expect(calls[0].filters).toMatchObject({ 'notes is': null });
    expect(calls[0].filters).not.toHaveProperty('notes');
    expect((await approveExpense(database({ ...stored, notes: null }), { ...SEEN_EXPENSE, notes: null })).ok).toBe(true);
  });
  it('say it was changed after it was shown when no row matched but the expense is still there', async () => {
    for (const fn of [approveExpense, rejectExpense]) {
      const { ctx, calls } = changesNothing(true);
      expect(await fn(ctx, SEEN_EXPENSE)).toEqual({ ok: false, error: CHANGED });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ kind: 'table', name: 'finance_expenses', op: 'select', columns: 'id,status', filters: { id: EXPENSE, org_id: 'org-1' } });
      expect(calls[1].filters).not.toHaveProperty('updated_at');
    }
  });
  it('say what happened when the expense now holds a different status than the one shown', async () => {
    const now = (status: string) =>
      fakeFinance((call: FinanceCall) => (call.op === 'update' ? { data: null, error: null } : { data: { id: EXPENSE, status }, error: null })).ctx;
    expect(await approveExpense(now('approved'), SEEN_EXPENSE)).toEqual({ ok: false, error: 'This expense has already been approved.' });
    expect(await rejectExpense(now('rejected'), SEEN_EXPENSE)).toEqual({ ok: false, error: 'This expense has already been rejected.' });
    expect(await approveExpense(now('rejected'), SEEN_EXPENSE)).toEqual({ ok: false, error: 'This expense has already been rejected.' });
    expect(await rejectExpense(now('approved'), { ...SEEN_EXPENSE, status: 'rejected' })).toEqual({ ok: false, error: 'This expense has already been approved.' });
    expect(await approveExpense(now('pending'), { ...SEEN_EXPENSE, status: 'rejected' })).toEqual({ ok: false, error: 'This expense is pending again.' });
  });
  /** A stand-in for the table: an update changes the row only if every filter matches it, as the database would decide. */
  const stored = {
    id: EXPENSE, org_id: 'org-1', updated_at: SEEN, status: 'pending', amount: '120.00', sst_amount: '6.00', expense_date: '2026-10-05',
    category_id: CATEGORY, vendor_id: null as string | null, vendor_name: 'Kedai Ali' as string | null, notes: 'Printer paper' as string | null,
  };
  const database = (row: Record<string, unknown>) =>
    fakeFinance((call: FinanceCall) => {
      if (call.op === 'select') return { data: { id: row.id, status: row.status }, error: null };
      const same = Object.entries(call.filters).every(([key, want]) => {
        if (key.endsWith(' is')) return row[key.slice(0, -3)] === want;
        // `eq(column, null)` matches nothing in the database: null is only ever compared with `is`.
        if (want === null) return false;
        const have = row[key];
        return typeof want === 'number' ? Number(have) === want : have === want;
      });
      return { data: same ? { id: row.id } : null, error: null };
    }).ctx;
  it('decide the expense only when the database still holds what the row showed', async () => {
    for (const fn of [approveExpense, rejectExpense]) {
      expect(await fn(database(stored), SEEN_EXPENSE)).toEqual({ ok: true, data: { id: EXPENSE } });
    }
  });
  it('refuse when any one field the row showed is different in the database, a direct update included', async () => {
    const changes: Record<string, unknown> = {
      updated_at: '2026-10-12T09:15:23.123456+00:00',
      amount: '9999.00',
      sst_amount: '7.00',
      expense_date: '2026-10-06',
      category_id: CONTACT,
      vendor_name: 'Kedai Abu',
      notes: 'Other',
    };
    for (const [field, value] of Object.entries(changes)) {
      for (const fn of [approveExpense, rejectExpense]) {
        expect(await fn(database({ ...stored, [field]: value }), SEEN_EXPENSE), field).toEqual({ ok: false, error: CHANGED });
      }
    }
    // Notes added where there were none, and removed where there were some.
    expect(await approveExpense(database({ ...stored, notes: 'x' }), { ...SEEN_EXPENSE, notes: null })).toEqual({ ok: false, error: CHANGED });
    expect(await approveExpense(database({ ...stored, notes: null }), SEEN_EXPENSE)).toEqual({ ok: false, error: CHANGED });
    expect((await approveExpense(database({ ...stored, notes: null }), { ...SEEN_EXPENSE, notes: null })).ok).toBe(true);
  });
  it('match a contact by its id, and a typed vendor by its name', async () => {
    // The view names a contact's vendor by the contact's name; the table's own vendor_name is empty then.
    const asContact = { ...SEEN_EXPENSE, vendor_id: CONTACT, vendor_name: 'Supplier A' };
    const { ctx, calls } = fakeFinance({ data: { id: EXPENSE }, error: null });
    await approveExpense(ctx, asContact);
    expect(calls[0].filters).toMatchObject({ vendor_id: CONTACT, 'vendor_name is': null });
    expect(calls[0].filters).not.toHaveProperty('vendor_id is');
    const contactRow = { ...stored, vendor_id: CONTACT, vendor_name: null };
    expect((await approveExpense(database(contactRow), asContact)).ok).toBe(true);
    // Changed to another contact, or to a typed name, after the screen was drawn.
    expect(await approveExpense(database({ ...contactRow, vendor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), asContact)).toEqual({ ok: false, error: CHANGED });
    expect(await approveExpense(database({ ...stored }), asContact)).toEqual({ ok: false, error: CHANGED });
    // A typed vendor changed to a contact.
    expect(await approveExpense(database(contactRow), SEEN_EXPENSE)).toEqual({ ok: false, error: CHANGED });
  });
  it('compare an amount as a number, however the database prints it', async () => {
    for (const printed of ['120', '120.0', '120.00']) {
      expect((await approveExpense(database({ ...stored, amount: printed }), SEEN_EXPENSE)).ok, printed).toBe(true);
    }
  });
  it('say "no longer exists" when no row matched and the expense is gone', async () => {
    for (const fn of [approveExpense, rejectExpense]) {
      expect(await fn(changesNothing(false).ctx, SEEN_EXPENSE)).toEqual({ ok: false, error: 'That expense no longer exists.' });
    }
  });
  it('word FIN01, FIN02 and FIN14 by what was being done', async () => {
    const refused = (code: string) => fakeFinance({ data: null, error: { code } }).ctx;
    const decider = 'Only an owner or admin can approve or reject an expense. Ask one of them to do this.';
    expect((await approveExpense(refused('FIN01'), SEEN_EXPENSE))).toEqual({
      ok: false,
      error: 'This expense cannot be approved as it now stands: it is already approved, or it was rejected and has to be edited first.',
    });
    expect(await approveExpense(refused('FIN14'), SEEN_EXPENSE)).toEqual({ ok: false, error: decider });
    expect(await rejectExpense(refused('FIN01'), SEEN_EXPENSE)).toEqual({ ok: false, error: 'This expense has already been rejected.' });
    expect(await rejectExpense(refused('FIN02'), SEEN_EXPENSE)).toEqual({
      ok: false,
      error: 'This expense has a payment against it, paid or still to be paid, so it cannot be rejected.',
    });
    expect(await rejectExpense(refused('FIN14'), SEEN_EXPENSE)).toEqual({ ok: false, error: decider });
    // FIN02 has no meaning for an approval: it is not worded as one.
    expect(await approveExpense(refused('FIN02'), SEEN_EXPENSE)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
  });
  it('word a refusal by the database for a viewer or an outsider', async () => {
    const refused = fakeFinance({ data: null, error: { code: '42501' } }).ctx;
    expect(await approveExpense(refused, SEEN_EXPENSE)).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
    expect(await rejectExpense(refused, SEEN_EXPENSE)).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
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
      error: 'This expense has a voided payment against it, so it is kept.',
    });
    expect(await deleteExpense(refused('42501'), { id: EXPENSE })).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
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
