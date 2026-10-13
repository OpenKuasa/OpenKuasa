import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { listPaymentVouchers } from '@/lib/finance/cash-book';
import { markExpensePaid } from '@/lib/finance/expense-payment';
import { listExpenseCategories, listExpenses, saveExpense } from '@/lib/finance/expenses';
import { listLedgerLines } from '@/lib/finance/ledger';
import { listAccounts, markPaymentPaid, recordPaymentOut, voidPayment } from '@/lib/finance/money';
import { NEEDS_SIGN_OFF } from '@/lib/finance/result';
import { voucherActions } from '@/lib/finance/voucher-form';
import { VOUCHER_MESSAGES, deleteVoucher, markVoucherPaid, recordVoucher, voidVoucher } from '@/lib/finance/vouchers';

// Paying and voiding a voucher against the hosted database, through the
// screen's own read and write functions with a real client. Run by the
// controller only. No migration goes with this stage, so it can run on the
// branch before it merges. The smoke account is an owner, so a browser pass
// cannot show what a member is answered: this file does, with a member
// invited into a workspace. Every workspace is made through
// tests/helpers/live-workspaces.ts, which deletes what it creates.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const M = VOUCHER_MESSAGES;

type Ctx = { client: SupabaseClient; orgId: string };
type Workspace = { owner: Ctx; member: Ctx; bank: string; category: string };

/** A new signed-up user and the workspace they own, a member invited into it, its first bank account and an expense category. */
async function ownerAndMember(orgName: string): Promise<Workspace> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'voucher-pay-member-pass-123');
  const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  const owner = { client: c, orgId: orgId as string };
  const accounts = await listAccounts(owner);
  const categories = await listExpenseCategories(owner);
  return {
    owner,
    member: { client: m, orgId: orgId as string },
    bank: accounts.find((a) => a.kind === 'bank')!.id,
    category: categories.find((x) => x.name === 'Utilities')!.id,
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
/** A day earlier than today, so a payment's date can be seen to move to the day it was paid. */
function daysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** What the form sends for a voucher of RM `amount` to a typed payee. */
function typed(w: Workspace, amount: number) {
  return { account_id: w.bank, txn_date: today(), method: 'fpx' as const, category_id: w.category, amount, party_name: 'Tenaga Nasional', reference: '', notes: '' };
}

/** The voucher's row as the screen reads it. */
async function rowOf(ctx: Ctx, id: string) {
  const row = (await listPaymentVouchers(ctx)).find((v) => v.transaction_id === id);
  expect(row, `voucher ${id} is on the screen`).toBeDefined();
  return row!;
}

/** The voucher's lines in the books: how many, and what they come to on each side. */
async function booksOf(ctx: Ctx, id: string) {
  const lines = (await listLedgerLines(ctx)).filter((l) => l.source_id === id);
  const sum = (key: 'debit' | 'credit') => Math.round(lines.reduce((total, l) => total + l[key], 0) * 100) / 100;
  // What the voucher leaves on each account once every line is counted: nothing, when it has been reversed.
  const net = new Map<string | null, number>();
  for (const l of lines) net.set(l.account_id, Math.round(((net.get(l.account_id) ?? 0) + l.debit - l.credit) * 100) / 100);
  return { lines: lines.length, debit: sum('debit'), credit: sum('credit'), voided: lines.filter((l) => l.entry_key.endsWith(':void')).length, net: [...net.values()] };
}

testWithSupabase('a To be paid voucher is marked paid by an owner only, on the day given, once; then voided by an owner only, once', async () => {
  const w = await ownerAndMember(`Voucher pay ${Date.now()}`);

  const saved = await recordVoucher(w.owner, typed(w, 300));
  expect(saved).toMatchObject({ ok: true, data: { status: 'scheduled' } });
  if (!saved.ok) return;
  const id = saved.data.id;
  const toPay = await rowOf(w.owner, id);
  expect(voucherActions(toPay, true)).toEqual(['markPaid', 'delete']);
  expect(voucherActions(toPay, false)).toEqual(['delete']);
  expect(await booksOf(w.owner, id)).toMatchObject({ lines: 0 });

  // A member is told who pays, by the database, whatever the screen offered them; nothing changes.
  const paidOn = daysAgo(3);
  expect(await markVoucherPaid(w.member, { id, paid_on: paidOn })).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
  // Not paid yet, so it cannot be voided.
  expect(await voidVoucher(w.owner, { id })).toEqual({ ok: false, error: M.notPaid });
  expect((await rowOf(w.owner, id)).status).toBe('scheduled');

  const paid = await markVoucherPaid(w.owner, { id, paid_on: paidOn });
  expect(paid).toMatchObject({ ok: true, data: { id } });
  if (!paid.ok) return;
  expect(paid.data.number).toMatch(/^PV-\d+$/);
  const paidRow = await rowOf(w.owner, id);
  // Its date is now the day it was paid; nothing else of it moved.
  expect(paidRow).toMatchObject({ status: 'posted', number: paid.data.number, txn_date: paidOn, amount: 300, account_id: w.bank, category_id: w.category, method: 'fpx' });
  expect(voucherActions(paidRow, true)).toEqual(['void']);
  expect(voucherActions(paidRow, false)).toEqual([]);
  expect(await booksOf(w.owner, id)).toMatchObject({ lines: 2, debit: 300, credit: 300, voided: 0 });

  // Paid once: the second person is told so. A paid voucher is not deleted.
  expect(await markVoucherPaid(w.owner, { id, paid_on: today() })).toEqual({ ok: false, error: M.alreadyPaid });
  expect(await deleteVoucher(w.owner, { id, status: 'posted' })).toEqual({ ok: false, error: M.cannotDelete });

  expect(await voidVoucher(w.member, { id })).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
  expect((await rowOf(w.owner, id)).status).toBe('posted');
  expect(await voidVoucher(w.owner, { id })).toEqual({ ok: true, data: { id } });
  const voided = await rowOf(w.owner, id);
  // It keeps its number and stays in the list.
  expect(voided).toMatchObject({ status: 'void', number: paid.data.number, txn_date: paidOn });
  expect(voucherActions(voided, true)).toEqual([]);
  // The books hold the entry and its reversal: nothing is left on either account.
  const books = await booksOf(w.owner, id);
  expect(books).toMatchObject({ lines: 4, debit: 600, credit: 600, voided: 2 });
  expect(books.net.every((n) => n === 0)).toBe(true);

  expect(await voidVoucher(w.owner, { id })).toEqual({ ok: false, error: M.alreadyVoided });
  expect(await markVoucherPaid(w.owner, { id, paid_on: today() })).toEqual({ ok: false, error: M.alreadyVoided });
});

testWithSupabase('"Paid now" pays an owner’s voucher at once; a member’s waits whatever was asked, which is why the action asks first', async () => {
  const w = await ownerAndMember(`Voucher paid now ${Date.now()}`);

  const paid = await recordVoucher(w.owner, { ...typed(w, 120), paid_now: true });
  expect(paid).toMatchObject({ ok: true, data: { status: 'posted' } });
  if (!paid.ok) return;
  const row = await rowOf(w.owner, paid.data.id);
  expect(row.number).toMatch(/^PV-\d+$/);
  expect(row.approved_at).not.toBeNull();
  expect(await booksOf(w.owner, paid.data.id)).toMatchObject({ lines: 2, debit: 120, credit: 120 });

  // The database does not refuse a member's "paid now": it leaves the voucher waiting, unpaid and unnumbered.
  // recordVoucherAction refuses a member before this is reached (tests/finance-voucher-pay-void-actions.test.ts).
  const asked = await recordVoucher(w.member, { ...typed(w, 45), paid_now: true });
  expect(asked).toMatchObject({ ok: true, data: { status: 'pending_approval' } });
  if (!asked.ok) return;
  expect((await rowOf(w.owner, asked.data.id)).number).toBeNull();
  expect(await markVoucherPaid(w.owner, { id: asked.data.id, paid_on: today() })).toEqual({ ok: false, error: M.notToBePaid });
  expect(await deleteVoucher(w.member, { id: asked.data.id, status: 'pending_approval' })).toMatchObject({ ok: true });

  expect(await markVoucherPaid(w.owner, { id: asked.data.id, paid_on: today() })).toEqual({ ok: false, error: M.gone });
  expect(await voidVoucher(w.owner, { id: asked.data.id })).toEqual({ ok: false, error: M.gone });
});

testWithSupabase('voiding the voucher of an expense marked paid puts the expense back to Approved, and it can be paid again', async () => {
  const w = await ownerAndMember(`Voucher expense void ${Date.now()}`);

  const expense = await saveExpense(w.owner, { expense_date: today(), category_id: w.category, vendor_name: 'Kedai Runcit', amount: 100 });
  expect(expense).toMatchObject({ ok: true, data: { status: 'approved' } });
  if (!expense.ok) return;
  const expenseRow = async () => (await listExpenses(w.owner)).find((e) => e.id === expense.data.id)!;
  const shown = await expenseRow();

  const first = await markExpensePaid(w.owner, { id: shown.id, updated_at: shown.updated_at, account_id: w.bank, txn_date: today(), method: 'cash', reference: '', amount: 100 });
  expect(first).toMatchObject({ ok: true });
  if (!first.ok) return;
  expect(await expenseRow()).toMatchObject({ display_status: 'paid', paid: 100, held: 0 });
  const voucher = await rowOf(w.owner, first.data.voucher_id);
  expect(voucher).toMatchObject({ kind: 'expense', status: 'posted', amount: 100 });
  expect(voucherActions(voucher, true)).toEqual(['void']);
  expect(voucherActions(voucher, false)).toEqual([]);

  // The undo of a wrong Mark paid.
  expect(await voidVoucher(w.member, { id: voucher.transaction_id })).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
  expect(await voidVoucher(w.owner, { id: voucher.transaction_id })).toMatchObject({ ok: true });
  const back = await expenseRow();
  expect(back).toMatchObject({ status: 'approved', display_status: 'approved', paid: 0, held: 0, paid_on: null, method: null });
  const books = await booksOf(w.owner, voucher.transaction_id);
  expect(books).toMatchObject({ lines: 4, voided: 2 });
  expect(books.net.every((n) => n === 0)).toBe(true);

  // Owed again, so it is paid again: a new voucher with the next number. The voided one stays, as Void.
  const again = await markExpensePaid(w.owner, { id: back.id, updated_at: back.updated_at, account_id: w.bank, txn_date: today(), method: 'fpx', reference: '', amount: 100 });
  expect(again).toMatchObject({ ok: true });
  if (!again.ok) return;
  expect(again.data.voucher_id).not.toBe(voucher.transaction_id);
  expect(await expenseRow()).toMatchObject({ display_status: 'paid', paid: 100 });
  expect((await rowOf(w.owner, voucher.transaction_id)).status).toBe('void');
});

testWithSupabase('a payment to a supplier is not paid or voided from Payment Vouchers: Payments Out does both', async () => {
  const w = await ownerAndMember(`Voucher supplier ${Date.now()}`);
  const { client: c, orgId } = w.owner;
  const supplier = await c.from('finance_contacts').insert({ org_id: orgId, name: 'Syarikat Maju', is_customer: false, is_supplier: true }).select('id').single();
  expect(supplier.error, supplier.error?.message).toBeNull();
  const bill = await c.rpc('finance_save_bill', {
    target_org: orgId,
    bill: { supplier_id: supplier.data!.id, bill_date: today(), due_date: today() },
    lines: [{ description: 'Design work', quantity: 10, unit_price: 12.5, sst_rate: 6 }], // RM 132.50
  });
  expect(bill.error, bill.error?.message).toBeNull();
  const posted = await c.rpc('finance_post_bill', { target_org: orgId, target_bill: bill.data });
  expect(posted.error, posted.error?.message).toBeNull();

  const scheduled = await recordPaymentOut(w.member, {
    account_id: w.bank, txn_date: today(), method: 'fpx', reference: '', notes: '', scheduled: true,
    allocations: [{ bill_id: bill.data as string, amount: 100 }],
  });
  expect(scheduled).toMatchObject({ ok: true });
  if (!scheduled.ok) return;
  const id = scheduled.data.id;
  const row = await rowOf(w.owner, id);
  expect(row).toMatchObject({ kind: 'bill', status: 'scheduled' });
  expect(voucherActions(row, true)).toEqual([]);
  // Asked by a direct call, the voucher's own writes leave it alone.
  expect(await markVoucherPaid(w.owner, { id, paid_on: today() })).toEqual({ ok: false, error: M.notHere });
  expect((await rowOf(w.owner, id)).status).toBe('scheduled');

  expect(await markPaymentPaid(w.owner, { id, paid_on: today() })).toMatchObject({ ok: true });
  expect(await voidVoucher(w.owner, { id })).toEqual({ ok: false, error: M.notHere });
  expect((await rowOf(w.owner, id)).status).toBe('posted');
  expect(await voidPayment(w.owner, { id })).toMatchObject({ ok: true });
  expect((await rowOf(w.owner, id)).status).toBe('void');
});
