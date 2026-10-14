import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { listIncomeCategories } from '@/lib/finance/cash-receipts';
import { CATEGORY_MESSAGES, type CategoryRow, createCategory, listCategories, renameCategory, setCategoryActive } from '@/lib/finance/categories';
import { categoryActions, categoryAddError, categoryLists, categoryMark } from '@/lib/finance/category-form';
import { listExpenseCategories, listExpenses, saveExpense } from '@/lib/finance/expenses';

// Expense and income categories against the hosted database, through the
// Categories card's own reads, rules and writes with a real client. Run by
// the controller only. It needs no migration of its own: the rules it meets
// are 20261116120000_bendahara_expense_stamp_and_category_writers (who may
// write, the name rule) and 20261108090000_bendahara_ledger_accounts (a
// category's account in the Chart of Accounts), both applied. What each role
// may do, at length, is proved by supabase/tests/bendahara_expense_rules_check.sql.
// This file adds what only the API shows: that the card's payloads are taken
// by PostgREST, that each refusal arrives as the sentence the card shows,
// and that a member's update, which raises nothing, is told who can.
// Every workspace and user is made through tests/helpers/live-workspaces.ts,
// which deletes them when the file ends.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const M = CATEGORY_MESSAGES;

type Ctx = { client: SupabaseClient; orgId: string };

/** A new signed-up user and the workspace they own, and a member invited into it. */
async function ownerAndMember(orgName: string): Promise<{ owner: Ctx; member: Ctx }> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  // A member needs an address to accept an invite sent to it; see finance-write-guards.rls.test.ts.
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'categories-member-pass-123');
  const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  return { owner: { client: c, orgId: orgId as string }, member: { client: m, orgId: orgId as string } };
}

/** A category's account in the Chart of Accounts, as anyone in the workspace reads it. */
async function ledgerAccount(who: Ctx, categoryId: string) {
  const { data, error } = await who.client
    .from('finance_ledger_accounts')
    .select('code,name,type,active,default_for')
    .eq('org_id', who.orgId)
    .eq('category_id', categoryId)
    .maybeSingle();
  expect(error, error?.message).toBeNull();
  return data as { code: string; name: string; type: string; active: boolean; default_for: string | null } | null;
}

const named = (rows: CategoryRow[], kind: 'expense' | 'income', name: string) => rows.find((r) => r.kind === kind && r.name === name)!;

testWithSupabase('the card lists the ten a workspace starts with, and an owner adds, renames, archives and restores one', async () => {
  const { owner } = await ownerAndMember(`Categories card ${Date.now()}`);

  const start = await listCategories(owner);
  const lists = categoryLists(start);
  expect(lists.expense.map((r) => r.name)).toEqual(['Marketing', 'Purchases', 'Rent', 'Salaries', 'Services', 'Supplies', 'Travel', 'Utilities']);
  expect(lists.income.map((r) => r.name)).toEqual(['Other income', 'Sales']);
  expect(start.every((r) => r.active)).toBe(true);
  expect(categoryMark(named(start, 'income', 'Sales'))).toBe('Invoices post here');
  expect(categoryMark(named(start, 'expense', 'Purchases'))).toBe('Bills default here');
  expect(start.filter((r) => r.default_for !== null)).toHaveLength(2);

  // Add: the row comes back, its account in the Chart of Accounts was made in the same write, and the expense form offers it.
  const fuel = await createCategory(owner, { name: '  Fuel ', kind: 'expense' });
  expect(fuel).toMatchObject({ ok: true, data: { name: 'Fuel', kind: 'expense', active: true } });
  if (!fuel.ok) return;
  const made = await ledgerAccount(owner, fuel.data.id);
  expect(made).toMatchObject({ name: 'Fuel', type: 'expense', active: true, default_for: null });
  expect(Number(made!.code)).toBeGreaterThanOrEqual(6000);
  expect((await listExpenseCategories(owner)).map((c) => c.name)).toContain('Fuel');

  // A name the kind already has, capitals aside: the card says so from its own list; the database says so to a direct call.
  const withFuel = await listCategories(owner);
  expect(categoryAddError({ name: 'fuel', kind: 'expense' }, withFuel)).toBe('There is already an expense category called Fuel.');
  expect(await createCategory(owner, { name: 'FUEL', kind: 'expense' })).toEqual({ ok: false, error: M.nameTaken });
  // The other kind may have the same name; its account takes the next free name.
  const income = await createCategory(owner, { name: 'Fuel', kind: 'income' });
  expect(income).toMatchObject({ ok: true, data: { name: 'Fuel', kind: 'income' } });
  if (!income.ok) return;
  expect(await ledgerAccount(owner, income.data.id)).toMatchObject({ name: 'Fuel (2)', type: 'income' });
  expect((await listIncomeCategories(owner)).map((c) => c.name)).toContain('Fuel');

  // The name rule, through the API (the schema trims, so only a direct write meets it).
  const spaced = await owner.client.from('finance_categories').insert({ org_id: owner.orgId, name: 'Rent ', kind: 'expense' }).select('id');
  expect(spaced.error?.code).toBe('23514');

  // Rename: the account follows, and a name another category of the kind has is refused.
  const petrol = await renameCategory(owner, { id: fuel.data.id, name: 'Petrol' });
  expect(petrol).toMatchObject({ ok: true, data: { id: fuel.data.id, name: 'Petrol', kind: 'expense', active: true } });
  expect(await ledgerAccount(owner, fuel.data.id)).toMatchObject({ name: 'Petrol', active: true });
  expect(await renameCategory(owner, { id: fuel.data.id, name: 'rent' })).toEqual({ ok: false, error: M.nameTaken });
  expect(await renameCategory(owner, { id: crypto.randomUUID(), name: 'Nobody' })).toEqual({ ok: false, error: M.gone });

  // Archive: it stays in the card's list, leaves the form's, and its account is archived with it.
  expect(await setCategoryActive(owner, { id: fuel.data.id, active: false })).toMatchObject({ ok: true, data: { name: 'Petrol', active: false } });
  const archived = named(await listCategories(owner), 'expense', 'Petrol');
  expect(archived.active).toBe(false);
  expect(categoryActions(archived)).toEqual(['rename', 'restore']);
  expect((await listExpenseCategories(owner)).map((c) => c.name)).not.toContain('Petrol');
  expect(await ledgerAccount(owner, fuel.data.id)).toMatchObject({ name: 'Petrol', active: false });
  // An archived one keeps its name: the card tells the person to restore it.
  expect(categoryAddError({ name: 'petrol', kind: 'expense' }, await listCategories(owner))).toBe(
    'An archived expense category is already called Petrol. Restore it from its row rather than adding it again.',
  );
  expect(await createCategory(owner, { name: 'petrol', kind: 'expense' })).toEqual({ ok: false, error: M.nameTaken });

  // An expense form that was open when its category was archived still saves under it (a known limit, in the docs).
  const stale = await saveExpense(owner, { expense_date: '2026-10-01', category_id: fuel.data.id, vendor_id: null, vendor_name: 'Check Station', amount: 12, sst_amount: 0, notes: null });
  expect(stale).toMatchObject({ ok: true });
  expect((await listExpenses(owner)).find((e) => e.vendor_name === 'Check Station')).toMatchObject({ category_id: fuel.data.id, category_name: 'Petrol' });

  // Restore: back on the form, and its account with it.
  expect(await setCategoryActive(owner, { id: fuel.data.id, active: true })).toMatchObject({ ok: true, data: { active: true } });
  expect((await listExpenseCategories(owner)).map((c) => c.name)).toContain('Petrol');
  expect(await ledgerAccount(owner, fuel.data.id)).toMatchObject({ active: true });
});

testWithSupabase('the two categories the books lean on are renamed and not archived', async () => {
  const { owner } = await ownerAndMember(`Categories marked ${Date.now()}`);
  const rows = await listCategories(owner);
  const sales = named(rows, 'income', 'Sales');
  const purchases = named(rows, 'expense', 'Purchases');
  expect(categoryActions(sales)).toEqual(['rename']);
  expect(categoryActions(purchases)).toEqual(['rename']);

  expect(await setCategoryActive(owner, { id: sales.id, active: false })).toEqual({ ok: false, error: M.salesKept });
  expect(await setCategoryActive(owner, { id: purchases.id, active: false })).toEqual({ ok: false, error: M.purchasesKept });

  expect(await renameCategory(owner, { id: sales.id, name: 'Jualan' })).toMatchObject({ ok: true, data: { name: 'Jualan' } });
  const after = await listCategories(owner);
  // The mark is on the account, not in the name: it stays, and both are still active.
  expect(after.find((r) => r.id === sales.id)).toMatchObject({ name: 'Jualan', active: true, default_for: 'sales' });
  expect(after.find((r) => r.id === purchases.id)).toMatchObject({ name: 'Purchases', active: true, default_for: 'purchases' });
  expect(await ledgerAccount(owner, sales.id)).toMatchObject({ name: 'Jualan', default_for: 'sales', active: true });
  // "Sales" is free again in income, and a new category of that name does not take the mark.
  const second = await createCategory(owner, { name: 'Sales', kind: 'income' });
  expect(second).toMatchObject({ ok: true });
  if (!second.ok) return;
  expect((await ledgerAccount(owner, second.data.id))?.default_for).toBeNull();
});

testWithSupabase('a member reads every category and changes none: each write answers who can, and nothing moves', async () => {
  const { owner, member } = await ownerAndMember(`Categories member ${Date.now()}`);
  const before = await listCategories(owner);
  // A member reads the same list, marks included.
  expect(await listCategories(member)).toEqual(before);
  const rent = named(before, 'expense', 'Rent');

  expect(await createCategory(member, { name: 'Member Fuel', kind: 'expense' })).toEqual({ ok: false, error: M.needsSignOff });
  // The database raises nothing for these two: it finds the member no row. The data layer reads the category and says who can.
  expect(await renameCategory(member, { id: rent.id, name: 'Member Rent' })).toEqual({ ok: false, error: M.needsSignOff });
  expect(await setCategoryActive(member, { id: rent.id, active: false })).toEqual({ ok: false, error: M.needsSignOff });

  expect(await listCategories(owner)).toEqual(before);
  expect((await ledgerAccount(owner, rent.id))?.name).toBe('Rent');
});
