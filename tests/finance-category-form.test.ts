import { describe, expect, it } from 'vitest';
import { CATEGORY_MESSAGES, type CategoryRow } from '@/lib/finance/categories';
import {
  CATEGORY_RENAME_HELP,
  categoryActions,
  categoryAddError,
  categoryAddedNote,
  categoryArchiveEffect,
  categoryArchivedNote,
  categoryLists,
  categoryMark,
  categoryArchivePayload,
  categoryNameClash,
  categoryRestorePayload,
  categoryPayload,
  categoryRenameError,
  categoryRenamedNote,
  categoryRestoredNote,
  newCategoryForm,
  renameChangesNothing,
} from '@/lib/finance/category-form';
import { expensesScreenPlan } from '@/lib/finance/expense-form';

const M = CATEGORY_MESSAGES;

const row = (id: string, name: string, kind: 'expense' | 'income', more: Partial<CategoryRow> = {}): CategoryRow => ({
  id,
  name,
  kind,
  active: true,
  default_for: null,
  ...more,
});

// The ten a workspace starts with, and one archived.
const ROWS: CategoryRow[] = [
  row('e1', 'Rent', 'expense'),
  row('e2', 'Utilities', 'expense'),
  row('e3', 'Marketing', 'expense'),
  row('e4', 'Travel', 'expense'),
  row('e5', 'Supplies', 'expense'),
  row('e6', 'Salaries', 'expense'),
  row('e7', 'Services', 'expense'),
  row('e8', 'Purchases', 'expense', { default_for: 'purchases' }),
  row('i1', 'Sales', 'income', { default_for: 'sales' }),
  row('i2', 'Other income', 'income'),
  row('e9', 'Entertainment', 'expense', { active: false }),
];

describe('the two lists', () => {
  it('each kind’s active categories by name, capitals aside, then its archived ones', () => {
    const lists = categoryLists([...ROWS, row('e10', 'advertising', 'expense'), row('e11', 'Zakat', 'expense', { active: false })]);
    expect(lists.expense.map((r) => r.name)).toEqual([
      'advertising', 'Marketing', 'Purchases', 'Rent', 'Salaries', 'Services', 'Supplies', 'Travel', 'Utilities', 'Entertainment', 'Zakat',
    ]);
    expect(lists.income.map((r) => r.name)).toEqual(['Other income', 'Sales']);
  });

  it('shows all ten a workspace starts with, and nothing twice', () => {
    const lists = categoryLists(ROWS);
    expect(lists.expense.length + lists.income.length).toBe(ROWS.length);
    expect(categoryLists([])).toEqual({ expense: [], income: [] });
  });

  it('does not change the list it was given', () => {
    const before = ROWS.map((r) => r.id);
    categoryLists(ROWS);
    expect(ROWS.map((r) => r.id)).toEqual(before);
  });
});

describe('what a row shows and offers', () => {
  it('marks the two the books lean on by their mark, not their name', () => {
    expect(categoryMark(row('i1', 'Jualan', 'income', { default_for: 'sales' }))).toBe('Invoices post here');
    expect(categoryMark(row('e8', 'Belian', 'expense', { default_for: 'purchases' }))).toBe('Bills default here');
    expect(categoryMark(row('x', 'Sales', 'income'))).toBeNull();
  });

  it('offers Rename and Archive on an active category, Rename and Restore on an archived one, and never Delete', () => {
    expect(categoryActions(row('e1', 'Rent', 'expense'))).toEqual(['rename', 'archive']);
    expect(categoryActions(row('e9', 'Entertainment', 'expense', { active: false }))).toEqual(['rename', 'restore']);
    for (const r of ROWS) expect(categoryActions(r)).not.toContain('delete');
  });

  it('offers Rename alone on the two the books lean on, and Restore if one was archived by a direct call', () => {
    expect(categoryActions(row('i1', 'Sales', 'income', { default_for: 'sales' }))).toEqual(['rename']);
    expect(categoryActions(row('e8', 'Purchases', 'expense', { default_for: 'purchases' }))).toEqual(['rename']);
    expect(categoryActions(row('i1', 'Sales', 'income', { default_for: 'sales', active: false }))).toEqual(['rename', 'restore']);
  });
});

describe('a name that is taken', () => {
  it('is found within the kind, capitals and outer spaces aside, archived ones included', () => {
    expect(categoryNameClash(ROWS, 'expense', ' rent ')?.id).toBe('e1');
    expect(categoryNameClash(ROWS, 'expense', 'ENTERTAINMENT')?.id).toBe('e9');
    expect(categoryNameClash(ROWS, 'income', 'Rent')).toBeNull();
    expect(categoryNameClash(ROWS, 'expense', 'Sales')).toBeNull();
    expect(categoryNameClash(ROWS, 'expense', 'Ren')).toBeNull();
    // Spaces are trimmed as the table does; a tab is part of the name, so it is not the same name.
    expect(categoryNameClash(ROWS, 'expense', 'Rent\t')).toBeNull();
  });

  it('is not the category’s own name when it is being renamed', () => {
    expect(categoryNameClash(ROWS, 'expense', 'RENT', 'e1')).toBeNull();
    expect(categoryNameClash(ROWS, 'expense', 'RENT', 'e2')?.id).toBe('e1');
  });
});

describe('the add form', () => {
  it('starts empty, for an expense category, or for the kind it is given', () => {
    expect(newCategoryForm()).toEqual({ name: '', kind: 'expense' });
    expect(newCategoryForm('income')).toEqual({ name: '', kind: 'income' });
  });

  it('sends the name and the kind', () => {
    expect(categoryPayload({ name: ' Fuel ', kind: 'expense' })).toEqual({ name: ' Fuel ', kind: 'expense' });
  });

  it('is refused with the schema’s sentence for a name that is empty or too long', () => {
    expect(categoryAddError({ name: '  ', kind: 'expense' }, ROWS)).toBe(M.name);
    expect(categoryAddError({ name: 'x'.repeat(81), kind: 'expense' }, ROWS)).toBe(M.nameTooLong);
  });

  it('names the category that has the name already, and says to restore it when it is archived', () => {
    expect(categoryAddError({ name: 'rent', kind: 'expense' }, ROWS)).toBe('There is already an expense category called Rent.');
    expect(categoryAddError({ name: ' SALES', kind: 'income' }, ROWS)).toBe('There is already an income category called Sales.');
    expect(categoryAddError({ name: 'entertainment', kind: 'expense' }, ROWS)).toBe(
      'An archived expense category is already called Entertainment. Restore it from its row rather than adding it again.',
    );
  });

  it('takes a name the other kind has, and a new one', () => {
    expect(categoryAddError({ name: 'Rent', kind: 'income' }, ROWS)).toBeNull();
    expect(categoryAddError({ name: 'Fuel', kind: 'expense' }, ROWS)).toBeNull();
    expect(categoryAddError({ name: 'x'.repeat(80), kind: 'expense' }, ROWS)).toBeNull();
  });
});

describe('a new name', () => {
  const rent = ROWS[0];

  it('that is the name it has changes nothing, outer spaces aside; a change of capitals is a change', () => {
    expect(renameChangesNothing(rent, 'Rent')).toBe(true);
    expect(renameChangesNothing(rent, ' Rent ')).toBe(true);
    // The table trims spaces only: a name that now ends in a tab is a different name.
    expect(renameChangesNothing(rent, 'Rent\t')).toBe(false);
    expect(renameChangesNothing(rent, 'rent')).toBe(false);
    expect(renameChangesNothing(rent, '')).toBe(false);
  });

  it('is refused when empty, too long, or another category’s of the same kind', () => {
    expect(categoryRenameError(rent, ' ', ROWS)).toBe(M.name);
    expect(categoryRenameError(rent, 'x'.repeat(81), ROWS)).toBe(M.nameTooLong);
    expect(categoryRenameError(rent, 'travel', ROWS)).toBe('There is already an expense category called Travel.');
    expect(categoryRenameError(rent, 'Entertainment', ROWS)).toBe('An archived expense category is already called Entertainment. Choose another name.');
  });

  it('is taken when it only changes the capitals, is the other kind’s, or is new', () => {
    expect(categoryRenameError(rent, 'RENT', ROWS)).toBeNull();
    expect(categoryRenameError(rent, 'Sales', ROWS)).toBeNull();
    expect(categoryRenameError(rent, 'Sewa', ROWS)).toBeNull();
  });
});

describe('the sentences', () => {
  it('say where an expense category and an income category are offered', () => {
    expect(categoryArchiveEffect({ kind: 'expense' })).toBe(
      'It will no longer be offered on new expenses, supplier bills and payment vouchers, and its account in the Chart of Accounts is archived with it. What is already filed under it keeps it, and it can be restored.',
    );
    expect(categoryArchiveEffect({ kind: 'income' })).toBe(
      'It will no longer be offered on new cash receipts, and its account in the Chart of Accounts is archived with it. What is already filed under it keeps it, and it can be restored.',
    );
  });

  it('say what was done, with the name the database answered', () => {
    expect(categoryAddedNote({ name: 'Fuel', kind: 'expense' })).toBe('Fuel is added. It is offered on new expenses, supplier bills and payment vouchers.');
    expect(categoryAddedNote({ name: 'Grants', kind: 'income' })).toBe('Grants is added. It is offered on new cash receipts.');
    expect(categoryRenamedNote('Fuel', { name: 'Petrol' })).toBe('Fuel is now called Petrol.');
    expect(categoryArchivedNote({ name: 'Petrol' })).toBe('Petrol is archived. It stays in this list, where it can be restored.');
    expect(categoryRestoredNote({ name: 'Petrol', kind: 'expense' })).toBe('Petrol is restored. It is offered on new expenses, supplier bills and payment vouchers again.');
    expect(categoryRestoredNote({ name: 'Grants', kind: 'income' })).toBe('Grants is restored. It is offered on new cash receipts again.');
  });

  it('never promise a delete, and say the Chart of Accounts follows a rename only until it was renamed there', () => {
    expect(CATEGORY_RENAME_HELP).toContain('unless that one was renamed there');
    for (const text of [CATEGORY_RENAME_HELP, categoryArchiveEffect({ kind: 'expense' }), ...Object.values(M)]) {
      expect(text.toLowerCase()).not.toContain('delete');
    }
  });
});

describe('who manages categories on the Expenses screen', () => {
  it('an owner and an admin, and nobody else: not a member, a viewer or anyone in the demo workspace', () => {
    expect(expensesScreenPlan('owner', false).managesCategories).toBe(true);
    expect(expensesScreenPlan('admin', false).managesCategories).toBe(true);
    expect(expensesScreenPlan('member', false).managesCategories).toBe(false);
    expect(expensesScreenPlan('viewer', false).managesCategories).toBe(false);
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(expensesScreenPlan(role, true).managesCategories, role).toBe(false);
    }
  });
});

describe('what Archive and Restore send', () => {
  it('Archive sends active false and Restore sends active true, with the id and nothing else', () => {
    expect(categoryArchivePayload({ id: 'e1' })).toEqual({ id: 'e1', active: false });
    expect(categoryRestorePayload({ id: 'e1' })).toEqual({ id: 'e1', active: true });
  });
});
