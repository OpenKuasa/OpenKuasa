import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATEGORY_MESSAGES,
  createCategory,
  createCategoryInput,
  listCategories,
  renameCategory,
  renameCategoryInput,
  setCategoryActive,
  setCategoryActiveInput,
} from '@/lib/finance/categories';
import { NOT_ALLOWED, WRITE_FAILED } from '@/lib/finance/result';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

const M = CATEGORY_MESSAGES;
const ID = '11111111-1111-4111-8111-111111111111';
const SAVED = { id: ID, name: 'Fuel', kind: 'expense', active: true };

const ok = (data: unknown) => ({ data, error: null });
const refused = (code: string) => ({ data: null, error: { code, message: 'the database said no' } });
/** The requests a write made, as "table op". */
const made = (calls: FinanceCall[]) => calls.map((c) => `${c.name} ${c.op}`);

afterEach(() => vi.restoreAllMocks());

describe('createCategoryInput', () => {
  it('trims the name and keeps the kind', () => {
    expect(createCategoryInput.parse({ name: '  Fuel ', kind: 'expense' })).toEqual({ name: 'Fuel', kind: 'expense' });
    expect(createCategoryInput.parse({ name: 'x'.repeat(80), kind: 'income' }).name).toHaveLength(80);
  });

  it.each([
    [{ kind: 'expense' }, M.name],
    [{ name: '   ', kind: 'expense' }, M.name],
    [{ name: 7, kind: 'expense' }, M.name],
    [{ name: 'x'.repeat(81), kind: 'expense' }, M.nameTooLong],
    [{ name: 'Fuel' }, M.kind],
    [{ name: 'Fuel', kind: 'asset' }, M.kind],
  ])('refuses %j', (input, message) => {
    const parsed = createCategoryInput.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(message);
  });

  // The table trims spaces only (`name = btrim(name)`) and counts code points (`char_length`).
  it('holds a name to the table’s own rule: spaces are trimmed, other whitespace is not', () => {
    expect(createCategoryInput.parse({ name: 'Fuel\t', kind: 'expense' }).name).toBe('Fuel\t');
    expect(createCategoryInput.parse({ name: ' \tFuel ', kind: 'expense' }).name).toBe('\tFuel');
    expect(createCategoryInput.safeParse({ name: '\t', kind: 'expense' }).success).toBe(true);
  });

  it('counts the 80 characters as the table does: by code point, not by UTF-16 unit', () => {
    expect(createCategoryInput.safeParse({ name: '😀'.repeat(80), kind: 'expense' }).success).toBe(true);
    expect(createCategoryInput.safeParse({ name: '😀'.repeat(81), kind: 'expense' }).error?.issues[0]?.message).toBe(M.nameTooLong);
  });

  it('drops anything that is not a new category’s to send', () => {
    const parsed = createCategoryInput.parse({ name: 'Fuel', kind: 'expense', org_id: 'other', id: ID, active: false, default_for: 'sales' });
    expect(Object.keys(parsed).sort()).toEqual(['kind', 'name']);
  });
});

describe('renameCategoryInput and setCategoryActiveInput', () => {
  it('a rename carries a name and nothing else: no kind, and no word on whether it is archived', () => {
    expect(renameCategoryInput.parse({ id: ID, name: ' Petrol ', kind: 'income', active: false })).toEqual({ id: ID, name: 'Petrol' });
  });

  it('an archive or a restore carries that and nothing else: no name', () => {
    expect(setCategoryActiveInput.parse({ id: ID, active: false, name: 'x', kind: 'income' })).toEqual({ id: ID, active: false });
  });

  it('answers "no longer exists" for an id that is not one', () => {
    expect(renameCategoryInput.safeParse({ id: 'nope', name: 'A' }).error?.issues[0]?.message).toBe(M.gone);
    expect(setCategoryActiveInput.safeParse({ id: 'nope', active: true }).error?.issues[0]?.message).toBe(M.gone);
    expect(setCategoryActiveInput.safeParse({ id: ID }).error?.issues[0]?.message).toBe(M.active);
  });

  it('answers an active that is not true or false in the validation sentence, not "no longer exists"', () => {
    expect(setCategoryActiveInput.safeParse({ id: ID, active: 'no' }).error?.issues[0]?.message).toBe(M.active);
    expect(setCategoryActiveInput.safeParse({ id: ID, active: null }).error?.issues[0]?.message).toBe(M.active);
  });

  it('refuses an empty or over-long new name in the name’s own sentences', () => {
    expect(renameCategoryInput.safeParse({ id: ID, name: ' ' }).error?.issues[0]?.message).toBe(M.name);
    expect(renameCategoryInput.safeParse({ id: ID, name: 'x'.repeat(81) }).error?.issues[0]?.message).toBe(M.nameTooLong);
  });
});

describe('listCategories', () => {
  it('reads every category of the workspace, archived ones included, and marks the two the books lean on', async () => {
    const { ctx, calls } = fakeFinance((call) =>
      call.name === 'finance_categories'
        ? ok([
            { id: 'c1', name: 'Jualan', kind: 'income', active: true },
            { id: 'c2', name: 'Purchases', kind: 'expense', active: true },
            { id: 'c3', name: 'Travel', kind: 'expense', active: false },
          ])
        : ok([
            { category_id: 'c1', default_for: 'sales' },
            { category_id: 'c2', default_for: 'purchases' },
          ]),
    );
    expect(await listCategories(ctx)).toEqual([
      { id: 'c1', name: 'Jualan', kind: 'income', active: true, default_for: 'sales' },
      { id: 'c2', name: 'Purchases', kind: 'expense', active: true, default_for: 'purchases' },
      { id: 'c3', name: 'Travel', kind: 'expense', active: false, default_for: null },
    ]);
    expect(calls).toHaveLength(2);
    const [categories, marked] = calls;
    // No filter on kind or on active: both kinds, archived ones too.
    expect(categories).toMatchObject({ name: 'finance_categories', op: 'select', columns: 'id,name,kind,active', order: ['name asc', 'id asc'] });
    expect(categories.filters).toEqual({ org_id: 'org-1' });
    // The marks are named, never compared with null (`eq(column, null)` matches nothing through the API).
    expect(marked).toMatchObject({ name: 'finance_ledger_accounts', op: 'select', columns: 'category_id,default_for' });
    expect(marked.filters).toEqual({ org_id: 'org-1', 'default_for in': ['sales', 'purchases'] });
  });

  it('throws when either read fails, so the screen never draws a list it could not read', async () => {
    const failed = { data: null, error: { code: 'XX000', message: 'down' } };
    await expect(listCategories(fakeFinance((call) => (call.name === 'finance_categories' ? failed : ok([]))).ctx)).rejects.toBe(failed.error);
    await expect(listCategories(fakeFinance((call) => (call.name === 'finance_categories' ? ok([]) : failed)).ctx)).rejects.toBe(failed.error);
  });
});

describe('createCategory', () => {
  it('inserts the name and kind with the workspace from the context, and reads back four named columns', async () => {
    const { ctx, calls } = fakeFinance(ok(SAVED));
    expect(await createCategory(ctx, { name: ' Fuel ', kind: 'expense' })).toEqual({ ok: true, data: SAVED });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_categories',
      op: 'insert',
      values: { org_id: 'org-1', name: 'Fuel', kind: 'expense' },
      columns: 'id,name,kind,active',
      filters: {},
    });
    expect(Object.keys(calls[0].values ?? {}).sort()).toEqual(['kind', 'name', 'org_id']);
  });

  it.each([
    ['23505', M.nameTaken],
    ['23514', M.invalid],
    ['42501', M.needsSignOff],
  ])('words %s', async (code, message) => {
    expect(await createCategory(fakeFinance(refused(code)).ctx, { name: 'Fuel', kind: 'expense' })).toEqual({ ok: false, error: message });
  });

  it('never tells a person who may not add one that they may not "make changes here": the sentence names who can', () => {
    expect(M.needsSignOff).not.toBe(NOT_ALLOWED);
  });

  it('logs anything else and answers the general sentence', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await createCategory(fakeFinance(refused('23503')).ctx, { name: 'Fuel', kind: 'expense' })).toEqual({ ok: false, error: WRITE_FAILED });
    expect(await createCategory(fakeFinance(refused('FIN25')).ctx, { name: 'Fuel', kind: 'expense' })).toEqual({ ok: false, error: WRITE_FAILED });
    expect(await createCategory(fakeFinance(ok(null)).ctx, { name: 'Fuel', kind: 'expense' })).toEqual({ ok: false, error: WRITE_FAILED });
    expect(log).toHaveBeenCalledTimes(3);
  });
});

describe('renameCategory', () => {
  it('updates the name alone, in the workspace of the context, with a new updated_at', async () => {
    const { ctx, calls } = fakeFinance(ok({ ...SAVED, name: 'Petrol' }));
    expect(await renameCategory(ctx, { id: ID, name: 'Petrol' })).toEqual({ ok: true, data: { ...SAVED, name: 'Petrol' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'finance_categories', op: 'update', filters: { id: ID, org_id: 'org-1' }, columns: 'id,name,kind,active' });
    expect(Object.keys(calls[0].values ?? {}).sort()).toEqual(['name', 'updated_at']);
    expect(calls[0].values?.name).toBe('Petrol');
    expect(Number.isNaN(Date.parse(String(calls[0].values?.updated_at)))).toBe(false);
  });

  it('words a name another category of its kind has, and the name rule', async () => {
    expect(await renameCategory(fakeFinance(refused('23505')).ctx, { id: ID, name: 'Rent' })).toEqual({ ok: false, error: M.nameTaken });
    expect(await renameCategory(fakeFinance(refused('23514')).ctx, { id: ID, name: 'Rent' })).toEqual({ ok: false, error: M.invalid });
  });

  it('when no row was touched, reads the category: gone if it is not there', async () => {
    const { ctx, calls } = fakeFinance(ok(null));
    expect(await renameCategory(ctx, { id: ID, name: 'Petrol' })).toEqual({ ok: false, error: M.gone });
    expect(made(calls)).toEqual(['finance_categories update', 'finance_categories select']);
    expect(calls[1]).toMatchObject({ columns: 'id', filters: { id: ID, org_id: 'org-1' } });
  });

  it('when no row was touched and the category is still there, it was not theirs to change (a member’s update raises nothing)', async () => {
    const { ctx } = fakeFinance((call) => (call.op === 'update' ? ok(null) : ok({ id: ID })));
    expect(await renameCategory(ctx, { id: ID, name: 'Petrol' })).toEqual({ ok: false, error: M.needsSignOff });
  });

  it('answers the general sentence when that second read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx } = fakeFinance((call) => (call.op === 'update' ? ok(null) : refused('XX000')));
    expect(await renameCategory(ctx, { id: ID, name: 'Petrol' })).toEqual({ ok: false, error: WRITE_FAILED });
  });
});

describe('setCategoryActive', () => {
  /** Answers the read of the category's mark with `mark`, and the update with `updated`. */
  const marked = (mark: string | null) =>
    fakeFinance((call) => (call.name === 'finance_ledger_accounts' ? ok({ default_for: mark }) : ok({ ...SAVED, active: false })));

  it('archives: reads the category’s mark first, then updates active alone', async () => {
    const { ctx, calls } = marked(null);
    expect(await setCategoryActive(ctx, { id: ID, active: false })).toEqual({ ok: true, data: { ...SAVED, active: false } });
    expect(made(calls)).toEqual(['finance_ledger_accounts select', 'finance_categories update']);
    expect(calls[0]).toMatchObject({ columns: 'default_for', filters: { org_id: 'org-1', category_id: ID } });
    expect(calls[1]).toMatchObject({ filters: { id: ID, org_id: 'org-1' }, columns: 'id,name,kind,active' });
    expect(Object.keys(calls[1].values ?? {}).sort()).toEqual(['active', 'updated_at']);
    expect(calls[1].values?.active).toBe(false);
  });

  it('does not archive the category invoices post to, or the one bills default to, and writes nothing', async () => {
    const sales = marked('sales');
    expect(await setCategoryActive(sales.ctx, { id: ID, active: false })).toEqual({ ok: false, error: M.salesKept });
    expect(made(sales.calls)).toEqual(['finance_ledger_accounts select']);
    const purchases = marked('purchases');
    expect(await setCategoryActive(purchases.ctx, { id: ID, active: false })).toEqual({ ok: false, error: M.purchasesKept });
    expect(made(purchases.calls)).toEqual(['finance_ledger_accounts select']);
  });

  it('archives a category whose account cannot be found: the update then says whether the category is there', async () => {
    const { ctx, calls } = fakeFinance((call) => (call.op === 'update' ? ok({ ...SAVED, active: false }) : ok(null)));
    expect(await setCategoryActive(ctx, { id: ID, active: false })).toMatchObject({ ok: true });
    expect(made(calls)).toEqual(['finance_ledger_accounts select', 'finance_categories update']);
  });

  it('does not write when the mark could not be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, calls } = fakeFinance(refused('XX000'));
    expect(await setCategoryActive(ctx, { id: ID, active: false })).toEqual({ ok: false, error: WRITE_FAILED });
    expect(made(calls)).toEqual(['finance_ledger_accounts select']);
  });

  it('restores without asking anything first, a marked category too', async () => {
    const { ctx, calls } = fakeFinance(ok(SAVED));
    expect(await setCategoryActive(ctx, { id: ID, active: true })).toEqual({ ok: true, data: SAVED });
    expect(made(calls)).toEqual(['finance_categories update']);
    expect(calls[0].values?.active).toBe(true);
  });

  it('when no row was touched: gone, or not theirs to change', async () => {
    const gone = fakeFinance(ok(null));
    expect(await setCategoryActive(gone.ctx, { id: ID, active: true })).toEqual({ ok: false, error: M.gone });
    const theirs = fakeFinance((call) => (call.op === 'update' ? ok(null) : ok({ id: ID })));
    expect(await setCategoryActive(theirs.ctx, { id: ID, active: true })).toEqual({ ok: false, error: M.needsSignOff });
    // An archive by someone who may not: the mark reads as nothing marked, the update touches no row, the category is there.
    const member = fakeFinance((call) =>
      call.name === 'finance_ledger_accounts' ? ok({ default_for: null }) : call.op === 'update' ? ok(null) : ok({ id: ID }),
    );
    expect(await setCategoryActive(member.ctx, { id: ID, active: false })).toEqual({ ok: false, error: M.needsSignOff });
    expect(made(member.calls)).toEqual(['finance_ledger_accounts select', 'finance_categories update', 'finance_categories select']);
  });

  it('words a refusal the update raises', async () => {
    const { ctx } = fakeFinance((call) => (call.op === 'update' ? refused('42501') : ok(null)));
    expect(await setCategoryActive(ctx, { id: ID, active: true })).toEqual({ ok: false, error: M.needsSignOff });
  });
});
