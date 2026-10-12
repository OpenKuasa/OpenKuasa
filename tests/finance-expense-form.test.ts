import { describe, expect, it } from 'vitest';
import {
  TYPED_VENDOR,
  type WrittenExpense,
  afterRefusedExpenseSave,
  editExpenseForm,
  expenseActions,
  expenseFormError,
  expenseHiddenNote,
  expenseName,
  expensePayload,
  expensePaymentNote,
  expenseSaveHint,
  isPartPaid,
  newExpenseForm,
  writtenExpenseTitle,
} from '@/lib/finance/expense-form';
import { type ExpenseRow, saveExpenseInput } from '@/lib/finance/expenses';

const CATEGORY = '99999999-9999-4999-8999-999999999999';
const CONTACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function row(over: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    expense_date: '2026-10-05',
    category_id: CATEGORY,
    category_name: 'Supplies',
    vendor_id: null,
    vendor_name: 'Kedai Ali',
    amount: 120,
    sst_amount: 6,
    notes: 'Printer paper',
    status: 'pending',
    display_status: 'pending',
    paid: 0,
    held: 0,
    method: null,
    paid_on: null,
    ...over,
  };
}
const approved = (over: Partial<ExpenseRow> = {}) => row({ status: 'approved', display_status: 'approved', ...over });

describe('the form', () => {
  it('starts dated today with a typed vendor, and chooses the only category', () => {
    expect(newExpenseForm([{ id: CATEGORY, name: 'Rent' }], '2026-10-12')).toEqual({
      date: '2026-10-12', categoryId: CATEGORY, vendor: TYPED_VENDOR, vendorName: '', amount: '', sst: '', notes: '',
    });
    expect(newExpenseForm([{ id: CATEGORY, name: 'Rent' }, { id: CONTACT, name: 'Travel' }], '2026-10-12').categoryId).toBe('');
    expect(newExpenseForm([], '2026-10-12').categoryId).toBe('');
  });
  it('is built from the row when an expense is changed', () => {
    expect(editExpenseForm(row())).toEqual({
      id: row().id, date: '2026-10-05', categoryId: CATEGORY, vendor: TYPED_VENDOR, vendorName: 'Kedai Ali', amount: '120', sst: '6', notes: 'Printer paper',
    });
    // A contact: the view gives the contact's name, which is not a typed name.
    expect(editExpenseForm(row({ vendor_id: CONTACT, vendor_name: 'Supplier A', sst_amount: 0, notes: null, amount: 99.5 }))).toMatchObject({
      vendor: CONTACT, vendorName: '', amount: '99.5', sst: '', notes: '',
    });
  });
  it('sends a contact or a typed name, numbers for amounts, and 0 for an empty SST box', () => {
    const form = { ...editExpenseForm(row()), sst: ' ' };
    expect(expensePayload(form)).toEqual({
      id: row().id, expense_date: '2026-10-05', category_id: CATEGORY, vendor_id: null, vendor_name: 'Kedai Ali', amount: 120, sst_amount: 0, notes: 'Printer paper',
    });
    expect(expensePayload({ ...form, id: undefined, vendor: CONTACT, vendorName: 'left over' })).toMatchObject({ vendor_id: CONTACT, vendor_name: null });
    expect('id' in expensePayload({ ...form, id: undefined })).toBe(false);
    // What the form sends is what the schema takes.
    expect(saveExpenseInput.safeParse(expensePayload(editExpenseForm(row()))).success).toBe(true);
  });
  it('refuses an amount with a comma instead of reading it as another number', () => {
    const form = editExpenseForm(row());
    expect(Number.isNaN(expensePayload({ ...form, amount: '1,200.50' }).amount)).toBe(true);
    expect(expenseFormError({ ...form, amount: '1,200.50' })).toBe('Enter an amount above 0.');
    expect(expenseFormError({ ...form, amount: '' })).toBe('Enter an amount above 0.');
    expect(expenseFormError({ ...form, sst: '1,0' })).toBe('Enter the SST that is inside the amount: 0 or more.');
    expect(expenseFormError({ ...form, sst: 'six' })).toBe('Enter the SST that is inside the amount: 0 or more.');
  });
  it('names the first thing wrong, in the order of the form', () => {
    const form = editExpenseForm(row());
    expect(expenseFormError(form)).toBeNull();
    expect(expenseFormError({ ...form, categoryId: '', vendorName: '', amount: '' })).toBe('Choose an expense category.');
    expect(expenseFormError({ ...form, vendorName: '  ', amount: '' })).toBe('Say who was paid: choose a contact or type a name.');
    expect(expenseFormError({ ...form, date: '' })).toBe('Enter a valid date.');
    expect(expenseFormError({ ...form, sst: '121' })).toBe('The SST cannot be more than the amount.');
    expect(expenseFormError({ ...form, notes: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
    expect(expenseFormError({ ...form, vendor: CONTACT, vendorName: '' })).toBeNull();
  });
  it('forgets the id of an expense that is gone, and nothing else', () => {
    const form = editExpenseForm(row());
    const after = afterRefusedExpenseSave(form, 'That expense no longer exists.');
    expect(after.form).toEqual({ ...form, id: undefined });
    expect(after.error).toBe('That expense no longer exists. Save again to record it as a new expense.');
    expect(afterRefusedExpenseSave(form, 'Enter an amount above 0.')).toEqual({ form, error: 'Enter an amount above 0.' });
    const fresh = { ...form, id: undefined };
    expect(afterRefusedExpenseSave(fresh, 'That expense no longer exists.').form).toBe(fresh);
  });
  it('says what saving will do for this person', () => {
    expect(expenseSaveHint(true, undefined)).toBe('An expense you save is approved at once: you are an owner or admin.');
    expect(expenseSaveHint(true, row())).toBe('Saving approves this expense as you leave it: you are an owner or admin. To leave it waiting, cancel.');
    expect(expenseSaveHint(false, undefined)).toContain('waits as Pending approval');
    expect(expenseSaveHint(false, row())).toContain('waits as Pending approval');
    expect(expenseSaveHint(false, row({ status: 'rejected', display_status: 'rejected' }))).toBe(
      'Saving sends this expense for approval again. An owner or admin approves or rejects it.',
    );
  });
});

describe('what a row offers', () => {
  it('a pending expense: edit and delete for anyone who may write; approve and reject for an owner or admin', () => {
    expect(expenseActions(row(), true)).toEqual(['edit', 'approve', 'reject', 'delete']);
    expect(expenseActions(row(), false)).toEqual(['edit', 'delete']);
  });
  it('a rejected expense: edit and delete, never approve', () => {
    const rejected = row({ status: 'rejected', display_status: 'rejected' });
    expect(expenseActions(rejected, true)).toEqual(['edit', 'delete']);
    expect(expenseActions(rejected, false)).toEqual(['edit', 'delete']);
  });
  it('an approved expense: reject for an owner or admin while no payment stands against it, and nothing else', () => {
    expect(expenseActions(approved(), true)).toEqual(['reject']);
    expect(expenseActions(approved(), false)).toEqual([]);
    expect(expenseActions(approved({ held: 120 }), true)).toEqual([]);
    expect(expenseActions(approved({ paid: 30 }), true)).toEqual([]);
    expect(expenseActions(approved({ paid: 120, display_status: 'paid' }), true)).toEqual([]);
    expect(expenseActions(approved({ paid: 120, display_status: 'paid' }), false)).toEqual([]);
  });
  it('never offers a member approve or reject, whatever the row', () => {
    const rows = [row(), row({ status: 'rejected', display_status: 'rejected' }), approved(), approved({ paid: 1 }), approved({ held: 1 })];
    for (const r of rows) {
      expect(expenseActions(r, false)).not.toContain('approve');
      expect(expenseActions(r, false)).not.toContain('reject');
    }
  });
  it('names an expense by its amount and vendor', () => {
    expect(expenseName(row())).toBe('the expense of RM 120.00 to Kedai Ali');
  });
});

describe('an expense that is paid in part', () => {
  it('is an approved expense with something paid', () => {
    expect(isPartPaid(approved({ paid: 30 }))).toBe(true);
    expect(isPartPaid(approved())).toBe(false);
    expect(isPartPaid(approved({ held: 30 }))).toBe(false);
    expect(isPartPaid(approved({ paid: 120, display_status: 'paid' }))).toBe(false);
  });
  it('says what was paid, what is to be paid and what has no payment yet', () => {
    expect(expensePaymentNote(approved({ paid: 30, held: 20 }))).toBe('RM 30.00 paid · RM 20.00 to be paid · RM 70.00 with no payment yet');
    expect(expensePaymentNote(approved({ paid: 30 }))).toBe('RM 30.00 paid · RM 90.00 with no payment yet');
    expect(expensePaymentNote(approved({ held: 120 }))).toBe('RM 120.00 to be paid');
    expect(expensePaymentNote(approved({ paid: 100.1, held: 19.9 }))).toBe('RM 100.10 paid · RM 19.90 to be paid');
  });
  it('says nothing for an expense with no payment, a paid one, a pending one or a rejected one', () => {
    expect(expensePaymentNote(approved())).toBeNull();
    expect(expensePaymentNote(approved({ paid: 120, display_status: 'paid' }))).toBeNull();
    expect(expensePaymentNote(row())).toBeNull();
    expect(expensePaymentNote(row({ status: 'rejected', display_status: 'rejected' }))).toBeNull();
  });
});

describe('an expense just written that is not in the list', () => {
  const written = (status: WrittenExpense['status']): WrittenExpense => ({ id: 'e1', status, vendor: 'Kedai Ali', amount: 120, date: '2026-10-05' });
  it('says nothing while its row is on screen', () => {
    expect(expenseHiddenNote(written('pending'), true, true)).toBeNull();
    expect(expenseHiddenNote(written('rejected'), false, true)).toBeNull();
  });
  it('points a rejected expense to the status filter', () => {
    expect(expenseHiddenNote(written('rejected'), false, false)).toBe(
      'The expense of RM 120.00 to Kedai Ali, dated 05 Oct 2026, was rejected. Choose Rejected in the status filter to see it.',
    );
  });
  it('points anything else the filters hide to the filters, and a row past the tenth to View all', () => {
    expect(expenseHiddenNote(written('pending'), false, false)).toBe(
      'The expense of RM 120.00 to Kedai Ali, dated 05 Oct 2026, was saved and waits for approval. Clear the search and the filters to see it.',
    );
    expect(expenseHiddenNote(written('approved'), true, false)).toBe(
      'The expense of RM 120.00 to Kedai Ali, dated 05 Oct 2026, was approved. Choose View all to see it.',
    );
    expect(expenseHiddenNote(written(null), true, false)).toBe('The expense of RM 120.00 to Kedai Ali, dated 05 Oct 2026, was saved. Choose View all to see it.');
  });
  it('titles the note by what happened', () => {
    expect(writtenExpenseTitle(written('approved'))).toBe('Expense approved');
    expect(writtenExpenseTitle(written('rejected'))).toBe('Expense rejected');
    expect(writtenExpenseTitle(written('pending'))).toBe('Expense sent for approval');
    expect(writtenExpenseTitle(written(null))).toBe('Expense saved');
  });
});
