/**
 * Live test of who may sign a finance document off, against the real database.
 * It needs 20261030123000_finance_write_guards.sql applied; until then the
 * member's posts, payments and voids succeed and this file fails. Skipped
 * without Supabase env vars.
 *
 * One workspace with its owner and a member (role `member`, a writer). The
 * member writes drafts and schedules; posting, paying and voiding are refused
 * to them with FIN14 and work for the owner. The columns of a payment that
 * only the database writes are refused to both. Three tests go through the
 * cash book functions (a cash receipt, two payment vouchers), which number a
 * payment and so run as the owner like the rest; two go through the
 * cash receipts data layer (a receipt for income, a receipt for invoices), and seven through
 * the expenses data layer (the form's writes, a payment against an expense, a decision on an
 * expense changed meanwhile, one of NaN, and marking an expense paid, in part, in full and after it
 * changed). The last one writes categories and the two closed columns of an expense directly: no
 * screen writes either yet.
 *
 * Workspaces and users come from tests/helpers/live-workspaces.ts, which also
 * removes them.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import {
  deleteCashReceipt,
  listIncomeCategories,
  postCashReceipt,
  saveCashReceipt,
  voidCashReceipt,
} from '@/lib/finance/cash-receipts';
import { expenseDecisionPayload } from '@/lib/finance/expense-form';
import { expensePayPayload, markExpensePaid, newExpensePayForm } from '@/lib/finance/expense-payment';
import { approveExpense, deleteExpense, listExpenseCategories, listExpenses, rejectExpense, saveExpense } from '@/lib/finance/expenses';
import { listAccounts } from '@/lib/finance/money';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const PASSWORD = 'finance-guards-pass-123';
/** The sign-off refusal raised by private.finance_sign_off_guard. */
const SIGN_OFF = 'FIN14';
const DENIED = '42501';

let owner: { c: SupabaseClient; userId: string };
let member: { c: SupabaseClient; userId: string };
let orgId = '';
let bank = '';
let customer = '';
let supplier = '';

function daysFromToday(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const LINE = { description: 'Design work', quantity: 10, unit_price: 12.5, sst_rate: 0 }; // 125.00

const saveInvoice = (c: SupabaseClient) =>
  c.rpc('finance_save_invoice', {
    target_org: orgId,
    invoice: { customer_id: customer, invoice_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [LINE],
  });
const saveBill = (c: SupabaseClient) =>
  c.rpc('finance_save_bill', {
    target_org: orgId,
    bill: { supplier_id: supplier, bill_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [LINE],
  });
const transactions = async () => {
  const { data, error } = await owner.c.from('finance_transactions').select('id').eq('org_id', orgId);
  expect(error, error?.message).toBeNull();
  return (data ?? []).length;
};

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = liveClient();
  const signedIn = await signInOwner(c);
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const org = await createOrg(c, 'Finance Guards Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  orgId = org.data as string;
  owner = { c, userId: signedIn.data.user!.id };

  // A member needs an address to accept an invite sent to it; see people-payroll.rls.test.ts.
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, PASSWORD);
  const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  member = { c: m, userId: signUp.userId as string };

  const { data: accounts } = await c.from('finance_accounts').select('id, name').eq('org_id', orgId);
  bank = accounts?.find((a) => a.name === 'Main Bank')?.id as string;
  const made = await c
    .from('finance_contacts')
    .insert([
      { org_id: orgId, name: 'Guarded Customer', is_customer: true, is_supplier: false },
      { org_id: orgId, name: 'Guarded Supplier', is_customer: false, is_supplier: true },
    ])
    .select('id, name');
  expect(made.error, made.error?.message).toBeNull();
  customer = made.data!.find((r) => r.name === 'Guarded Customer')!.id as string;
  supplier = made.data!.find((r) => r.name === 'Guarded Supplier')!.id as string;
});
afterAll(async () => {
  await owner?.c.auth.signOut();
  await member?.c.auth.signOut();
});

testWithSupabase('a member drafts an invoice; only the owner posts and voids it', async () => {
  const draft = await saveInvoice(member.c);
  expect(draft.error, draft.error?.message).toBeNull();
  const id = draft.data as string;

  const memberPost = await member.c.rpc('finance_post_invoice', { target_org: orgId, target_invoice: id });
  expect(memberPost.error?.code).toBe(SIGN_OFF);
  // The refused post took no number: the owner's is the first.
  const posted = await owner.c.rpc('finance_post_invoice', { target_org: orgId, target_invoice: id });
  expect(posted.error, posted.error?.message).toBeNull();
  expect(posted.data).toBe('INV-0001');

  const memberVoid = await member.c.from('finance_invoices').update({ status: 'void' }).eq('id', id);
  expect(memberVoid.error?.code).toBe(SIGN_OFF);
  // Recording the e-Invois status is not a sign-off.
  const einvoice = await member.c.from('finance_invoices').update({ einvoice_status: 'pending' }).eq('id', id);
  expect(einvoice.error, einvoice.error?.message).toBeNull();
  const ownerVoid = await owner.c.from('finance_invoices').update({ status: 'void' }).eq('id', id).select('status');
  expect(ownerVoid.error, ownerVoid.error?.message).toBeNull();
  expect(ownerVoid.data).toEqual([{ status: 'void' }]);
});

testWithSupabase('a member cannot record money in, and nothing is left behind', async () => {
  const draft = await saveInvoice(owner.c);
  const posted = await owner.c.rpc('finance_post_invoice', { target_org: orgId, target_invoice: draft.data });
  expect(posted.error, posted.error?.message).toBeNull();
  const payment = {
    target_org: orgId,
    payment: { account_id: bank, method: 'fpx' },
    allocations: [{ invoice_id: draft.data, amount: 125 }],
  };

  const before = await transactions();
  const refused = await member.c.rpc('finance_record_payment_in', payment);
  expect(refused.error?.code).toBe(SIGN_OFF);
  expect(await transactions()).toBe(before);

  const received = await owner.c.rpc('finance_record_payment_in', payment);
  expect(received.error, received.error?.message).toBeNull();
  const { data: row } = await owner.c
    .from('finance_transactions')
    .select('status, number, created_by, approved_by')
    .eq('id', received.data)
    .single();
  expect(row).toMatchObject({ status: 'posted', created_by: owner.userId, approved_by: null });
  expect(row!.number).toMatch(/^RC-\d{4}$/);

  const memberVoid = await member.c.from('finance_transactions').update({ status: 'void' }).eq('id', received.data);
  expect(memberVoid.error?.code).toBe(SIGN_OFF);
});

testWithSupabase('a member schedules a payment out; only the owner pays it', async () => {
  const draft = await saveBill(member.c);
  expect(draft.error, draft.error?.message).toBeNull();
  const memberPost = await member.c.rpc('finance_post_bill', { target_org: orgId, target_bill: draft.data });
  expect(memberPost.error?.code).toBe(SIGN_OFF);
  const posted = await owner.c.rpc('finance_post_bill', { target_org: orgId, target_bill: draft.data });
  expect(posted.error, posted.error?.message).toBeNull();

  const pay = (c: SupabaseClient, status: 'posted' | 'scheduled') =>
    c.rpc('finance_record_payment_out', {
      target_org: orgId,
      payment: { account_id: bank, method: 'bank_transfer', status },
      allocations: [{ bill_id: draft.data, amount: 50 }],
    });
  expect((await pay(member.c, 'posted')).error?.code).toBe(SIGN_OFF);
  const scheduled = await pay(member.c, 'scheduled');
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  const { data: row } = await owner.c
    .from('finance_transactions')
    .select('status, number, created_by')
    .eq('id', scheduled.data)
    .single();
  expect(row).toEqual({ status: 'scheduled', number: null, created_by: member.userId });

  const paid = { target_org: orgId, target_txn: scheduled.data, paid_on: daysFromToday(0) };
  expect((await member.c.rpc('finance_mark_payment_paid', paid)).error?.code).toBe(SIGN_OFF);
  const marked = await owner.c.rpc('finance_mark_payment_paid', paid);
  expect(marked.error, marked.error?.message).toBeNull();
  expect(marked.data).toMatch(/^PV-\d{4}$/);
});

testWithSupabase('a payment starts as a draft, and its number and approval are not columns anyone writes', async () => {
  const base = { org_id: orgId, direction: 'out', account_id: bank, amount: 10, method: 'cash' };

  // Even the owner. A status other than draft is refused by the insert guard; a closed column by its grant.
  const posted = await owner.c.from('finance_transactions').insert({ ...base, status: 'posted' });
  expect(posted.error?.code).toBe('FIN09');
  const numbered = await owner.c.from('finance_transactions').insert({ ...base, number: 'PV-9999' });
  expect(numbered.error?.code).toBe(DENIED);
  const approved = await owner.c.from('finance_transactions').insert({ ...base, approved_by: owner.userId });
  expect(approved.error?.code).toBe(DENIED);
  const borrowed = await member.c.from('finance_transactions').insert({ ...base, created_by: owner.userId });
  expect(borrowed.error?.code).toBe(DENIED);

  // A plain draft is still anyone's to write, and is recorded as theirs.
  const draft = await member.c.from('finance_transactions').insert(base).select('id, status, created_by').single();
  expect(draft.error, draft.error?.message).toBeNull();
  expect(draft.data).toMatchObject({ status: 'draft', created_by: member.userId });
  const id = draft.data!.id as string;

  for (const change of [
    { number: 'PV-9999' },
    { approved_by: owner.userId },
    { approved_at: new Date().toISOString() },
    { created_by: owner.userId },
  ]) {
    const { error } = await owner.c.from('finance_transactions').update(change).eq('id', id);
    expect(error?.code, JSON.stringify(change)).toBe(DENIED);
  }
  // With no way to give it a number, a direct update cannot post it: the table's own check refuses.
  const sneak = await owner.c.from('finance_transactions').update({ status: 'posted' }).eq('id', id);
  expect(sneak.error?.code).toBe('23514');

  const removed = await member.c.from('finance_transactions').delete().eq('id', id).select('id');
  expect(removed.error, removed.error?.message).toBeNull();
  expect(removed.data).toEqual([{ id }]);
});

/** One of the categories every workspace starts with. */
async function category(name: string): Promise<string> {
  const { data, error } = await owner.c
    .from('finance_categories')
    .select('id')
    .eq('org_id', orgId)
    .eq('name', name)
    .single();
  expect(error, error?.message).toBeNull();
  return data!.id as string;
}
const payment = async (id: unknown) => {
  const { data, error } = await owner.c
    .from('finance_transactions')
    .select('status, number, created_by, approved_by')
    .eq('id', id)
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
};

// The cash book functions (20261028100000) write a payment's number, so they run as the owner too.
testWithSupabase('a member saves a draft cash receipt; only the owner posts it', async () => {
  const sales = await category('Sales');
  const saved = await member.c.rpc('finance_save_cash_receipt', {
    target_org: orgId,
    receipt: { account_id: bank, method: 'cash', amount: 40, category_id: sales, party_name: 'Walk-in customer' },
    allocations: [],
  });
  expect(saved.error, saved.error?.message).toBeNull();
  expect(await payment(saved.data)).toEqual({
    status: 'draft',
    number: null,
    created_by: member.userId,
    approved_by: null,
  });

  const post = { target_org: orgId, target_txn: saved.data };
  expect((await member.c.rpc('finance_post_cash_receipt', post)).error?.code).toBe(SIGN_OFF);
  const posted = await owner.c.rpc('finance_post_cash_receipt', post);
  expect(posted.error, posted.error?.message).toBeNull();
  expect(posted.data).toMatch(/^RC-\d{4}$/);
});

testWithSupabase('a voucher that settles no document waits for approval from a member; the owner pays one', async () => {
  const rent = await category('Rent');
  const voucher = (c: SupabaseClient) =>
    c.rpc('finance_record_voucher', {
      target_org: orgId,
      voucher: {
        account_id: bank,
        method: 'bank_transfer',
        amount: 75,
        category_id: rent,
        party_name: 'Landlord',
        status: 'posted',
      },
      allocations: [],
    });

  const waiting = await voucher(member.c);
  expect(waiting.error, waiting.error?.message).toBeNull();
  expect(await payment(waiting.data)).toEqual({
    status: 'pending_approval',
    number: null,
    created_by: member.userId,
    approved_by: null,
  });
  // Approving it is an owner's or admin's, as it was before this migration.
  const memberApproves = await member.c
    .from('finance_transactions')
    .update({ status: 'scheduled' })
    .eq('id', waiting.data);
  expect(memberApproves.error?.code).toBe(SIGN_OFF);

  const paid = await voucher(owner.c);
  expect(paid.error, paid.error?.message).toBeNull();
  const row = await payment(paid.data);
  expect(row).toMatchObject({ status: 'posted', created_by: owner.userId, approved_by: owner.userId });
  expect(row.number).toMatch(/^PV-\d{4}$/);
});

testWithSupabase('a member schedules a voucher for an approved expense; paying it now is refused', async () => {
  const rent = await category('Rent');
  // Saved by the owner, so approved in the same call.
  const expense = await owner.c.rpc('finance_save_expense', {
    target_org: orgId,
    expense: { category_id: rent, vendor_name: 'Landlord', amount: 60 },
  });
  expect(expense.error, expense.error?.message).toBeNull();
  const voucher = (status: 'posted' | 'scheduled') =>
    member.c.rpc('finance_record_voucher', {
      target_org: orgId,
      voucher: { account_id: bank, method: 'bank_transfer', status },
      allocations: [{ expense_id: expense.data, amount: 60 }],
    });

  const before = await transactions();
  expect((await voucher('posted')).error?.code).toBe(SIGN_OFF);
  expect(await transactions()).toBe(before);
  const scheduled = await voucher('scheduled');
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  expect(await payment(scheduled.data)).toEqual({
    status: 'scheduled',
    number: null,
    created_by: member.userId,
    approved_by: null,
  });
});

// ---- stage 5b: the receipt form's writes, through the app's own data layer ----------------------
// Everything above calls the database functions directly. These two go through
// src/lib/finance/cash-receipts.ts with the payloads the receipt form sends, so what is pinned is the
// sentence a member and an owner read, and that the JSON the app sends is JSON the functions take.

const NEEDS_SIGN_OFF = 'Only an owner or admin can post, pay or void. Ask one of them to do this.';

/** The data layer's answer, or a failed test that says what it answered instead. */
function done<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`expected the write to go through, got: ${result.error}`);
  return result.data;
}
const receiptRow = async (id: string) => {
  const { data, error } = await owner.c
    .from('finance_cash_receipts')
    .select('kind, status, number, amount, party_name, category_name')
    .eq('transaction_id', id)
    .maybeSingle();
  expect(error, error?.message).toBeNull();
  return data;
};

testWithSupabase('a receipt for income: a member saves, changes and cannot post or void it; the owner posts and voids it', async () => {
  const asMember = { client: member.c, orgId };
  const asOwner = { client: owner.c, orgId };
  const salesCategory = (await listIncomeCategories(asMember)).find((c) => c.name === 'Sales');
  expect(salesCategory, 'the workspace has an income category called Sales').toBeDefined();
  const sales = salesCategory?.id as string;
  const details = { kind: 'income' as const, account_id: bank, txn_date: daysFromToday(0), method: 'cash' as const, category_id: sales };

  const { id } = done(await saveCashReceipt(asMember, { ...details, amount: 32.506, party_name: ' Walk-in ' }));
  expect(await receiptRow(id)).toEqual({
    kind: 'income', status: 'draft', number: null, amount: 32.51, party_name: 'Walk-in', category_name: 'Sales',
  });
  // Changed by the member: now from a contact, with no typed name.
  done(await saveCashReceipt(asMember, { ...details, id, amount: 40, contact_id: customer, party_name: '' }));
  expect(await receiptRow(id)).toMatchObject({ status: 'draft', amount: 40, party_name: 'Guarded Customer' });

  expect(await postCashReceipt(asMember, { id })).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
  expect(await receiptRow(id)).toMatchObject({ status: 'draft', number: null });
  const posted = done(await postCashReceipt(asOwner, { id }));
  expect(posted.number).toMatch(/^RC-\d{4}$/);

  // Posted is locked, for the member and for the owner.
  expect(await saveCashReceipt(asOwner, { ...details, id, amount: 1 })).toEqual({
    ok: false, error: 'This receipt has been posted or voided, so that can no longer be done.',
  });
  expect(await deleteCashReceipt(asMember, { id })).toEqual({
    ok: false, error: 'This receipt has been posted or voided, so it cannot be deleted.',
  });
  expect(await voidCashReceipt(asMember, { id })).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
  expect(await receiptRow(id)).toMatchObject({ status: 'posted', number: posted.number });

  done(await voidCashReceipt(asOwner, { id }));
  // A void receipt keeps its number.
  expect(await receiptRow(id)).toMatchObject({ status: 'void', number: posted.number });
  expect(await voidCashReceipt(asOwner, { id })).toEqual({
    ok: false, error: 'This receipt cannot be voided as it now stands: it has already been voided, or it is still a draft.',
  });
});

testWithSupabase('a receipt for invoices: a draft holds its part, is changed without counting its own hold, and a void gives the balance back', async () => {
  const asMember = { client: member.c, orgId };
  const asOwner = { client: owner.c, orgId };
  const draft = await saveInvoice(owner.c);
  const invoicePosted = await owner.c.rpc('finance_post_invoice', { target_org: orgId, target_invoice: draft.data });
  expect(invoicePosted.error, invoicePosted.error?.message).toBeNull();
  const invoice = draft.data as string; // RM 125.00
  const details = { kind: 'invoice' as const, account_id: bank, txn_date: daysFromToday(0), method: 'fpx' as const };
  const balance = async () => {
    const { data } = await owner.c.from('finance_invoice_totals').select('balance').eq('id', invoice).single();
    return data!.balance;
  };

  const { id } = done(await saveCashReceipt(asMember, { ...details, allocations: [{ invoice_id: invoice, amount: 100 }] }));
  expect(await receiptRow(id)).toMatchObject({ kind: 'invoice', status: 'draft', amount: 100, party_name: 'Guarded Customer' });
  // The draft holds RM 100 of the RM 125: a second receipt may take RM 25 and no more.
  expect(await saveCashReceipt(asMember, { ...details, allocations: [{ invoice_id: invoice, amount: 25.01 }] })).toEqual({
    ok: false,
    error: 'That is more than is still owed on an invoice, counting what other receipts not yet posted already hold.',
  });
  // Changing the draft itself replaces its hold: it can take the whole invoice.
  done(await saveCashReceipt(asMember, { ...details, id, allocations: [{ invoice_id: invoice, amount: 125 }] }));
  expect(await receiptRow(id)).toMatchObject({ status: 'draft', amount: 125 });
  // A draft moves no balance.
  expect(await balance()).toBe(125);

  // Deleted by the member, and made again.
  done(await deleteCashReceipt(asMember, { id }));
  expect(await receiptRow(id)).toBeNull();
  const again = done(await saveCashReceipt(asMember, { ...details, allocations: [{ invoice_id: invoice, amount: 125 }] }));

  expect(await postCashReceipt(asMember, { id: again.id })).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
  done(await postCashReceipt(asOwner, { id: again.id }));
  expect(await balance()).toBe(0);
  expect(await voidCashReceipt(asMember, { id: again.id })).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
  done(await voidCashReceipt(asOwner, { id: again.id }));
  expect(await balance()).toBe(125);
});

// ---- stage 5c: the expense form's writes, through the app's own data layer ----------------------
// src/lib/finance/expenses.ts with the payloads the expense form sends, as a member and as the owner: who
// ends up with what status, the sentence each refusal reads as, and that an amount of NaN is refused by the
// database itself (20261114100000_bendahara_expense_amounts).

const NEEDS_DECIDER = 'Only an owner or admin can approve or reject an expense. Ask one of them to do this.';

const expenseRow = async (id: string) => {
  const { data, error } = await owner.c
    .from('finance_expenses')
    .select('status, amount, sst_amount, vendor_name, created_by, approved_by')
    .eq('id', id)
    .maybeSingle();
  expect(error, error?.message).toBeNull();
  return data;
};

/** The expense as the screen shows it, read the way the screen reads it, and what a decision sends of it. */
const shown = async (id: string) => {
  const row = (await listExpenses({ client: owner.c, orgId })).find((e) => e.id === id);
  expect(row).toBeTruthy();
  return expenseDecisionPayload(row!);
};

testWithSupabase('an expense: a member saves, changes and cannot decide it; the owner approves, rejects, and approves by saving', async () => {
  const asMember = { client: member.c, orgId };
  const asOwner = { client: owner.c, orgId };
  const categories = await listExpenseCategories(asMember);
  const rent = categories.find((c) => c.name === 'Rent')?.id as string;
  expect(rent).toBeTruthy();
  const details = { expense_date: daysFromToday(0), category_id: rent, vendor_name: 'Kedai Ali', amount: 120, sst_amount: 6, notes: 'Paper' };

  // Saved by the member: it waits, in their name.
  const saved = done(await saveExpense(asMember, details));
  expect(saved.status).toBe('pending');
  expect(await expenseRow(saved.id)).toEqual({
    status: 'pending', amount: 120, sst_amount: 6, vendor_name: 'Kedai Ali', created_by: member.userId, approved_by: null,
  });
  // Changed by the member: still waiting.
  expect(done(await saveExpense(asMember, { ...details, id: saved.id, amount: 130 })).status).toBe('pending');
  expect(await approveExpense(asMember, await shown(saved.id))).toEqual({ ok: false, error: NEEDS_DECIDER });
  expect(await rejectExpense(asMember, await shown(saved.id))).toEqual({ ok: false, error: NEEDS_DECIDER });
  expect((await expenseRow(saved.id))?.status).toBe('pending');

  // Rejected by the owner; not approved as it stands; edited by the member, it waits again.
  done(await rejectExpense(asOwner, await shown(saved.id)));
  expect(await expenseRow(saved.id)).toMatchObject({ status: 'rejected', approved_by: owner.userId });
  expect((await approveExpense(asOwner, await shown(saved.id))).ok).toBe(false);
  expect(await rejectExpense(asOwner, await shown(saved.id))).toEqual({ ok: false, error: 'This expense has already been rejected.' });
  expect(done(await saveExpense(asMember, { ...details, id: saved.id, amount: 125 })).status).toBe('pending');
  expect(await expenseRow(saved.id)).toMatchObject({ status: 'pending', amount: 125, approved_by: null });

  // Approved by the owner, and then locked for everyone; rejected again while nothing is paid.
  done(await approveExpense(asOwner, await shown(saved.id)));
  expect(await expenseRow(saved.id)).toMatchObject({ status: 'approved', approved_by: owner.userId, created_by: member.userId });
  for (const ctx of [asMember, asOwner]) {
    expect((await saveExpense(ctx, { ...details, id: saved.id })).ok).toBe(false);
    expect((await deleteExpense(ctx, { id: saved.id })).ok).toBe(false);
  }
  expect((await expenseRow(saved.id))?.status).toBe('approved');
  done(await rejectExpense(asOwner, await shown(saved.id)));

  // The owner saves over the member's rejected expense: approved in the same call, still the member's.
  expect(done(await saveExpense(asOwner, { ...details, id: saved.id })).status).toBe('approved');
  expect(await expenseRow(saved.id)).toMatchObject({ status: 'approved', created_by: member.userId, approved_by: owner.userId });

  // A new one by the owner is approved at once; one by the member is deleted by the member.
  const own = done(await saveExpense(asOwner, { ...details, vendor_name: null, vendor_id: supplier }));
  expect(own.status).toBe('approved');
  // Decided through the screen's own read: a contact is matched by its id, with the table's vendor_name empty.
  done(await rejectExpense(asOwner, await shown(own.id)));
  expect((await expenseRow(own.id))?.status).toBe('rejected');
  const draft = done(await saveExpense(asMember, details));
  done(await deleteExpense(asMember, { id: draft.id }));
  expect(await expenseRow(draft.id)).toBeNull();
  expect(await deleteExpense(asMember, { id: draft.id })).toEqual({ ok: false, error: 'That expense no longer exists.' });
});

testWithSupabase('an approved expense with a payment against it cannot be rejected', async () => {
  const asOwner = { client: owner.c, orgId };
  const rent = await category('Rent');
  const saved = done(await saveExpense(asOwner, { expense_date: daysFromToday(0), category_id: rent, vendor_name: 'Landlord', amount: 60 }));
  const scheduled = await owner.c.rpc('finance_record_voucher', {
    target_org: orgId,
    voucher: { account_id: bank, method: 'bank_transfer', status: 'scheduled' },
    allocations: [{ expense_id: saved.id, amount: 20 }],
  });
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  expect(await rejectExpense(asOwner, await shown(saved.id))).toEqual({
    ok: false,
    error: 'This expense has a payment against it, paid or still to be paid, so it cannot be rejected.',
  });
  const totals = await owner.c.from('finance_expense_totals').select('display_status, paid, held').eq('id', saved.id).maybeSingle();
  expect(totals.data).toMatchObject({ display_status: 'approved', paid: 0, held: 20 });
});

testWithSupabase('an expense changed after the owner opened it is not approved or rejected as it now stands', async () => {
  const asMember = { client: member.c, orgId };
  const asOwner = { client: owner.c, orgId };
  const rent = await category('Rent');
  const saved = done(await saveExpense(asMember, { expense_date: daysFromToday(0), category_id: rent, vendor_name: 'Kedai Ali', amount: 120 }));
  // The owner's screen shows RM 120; then the member changes it.
  const opened = await shown(saved.id);
  done(await saveExpense(asMember, { id: saved.id, expense_date: daysFromToday(0), category_id: rent, vendor_name: 'Kedai Ali', amount: 9999 }));
  const changed = 'This expense was changed after you opened it. Check it again, then approve or reject it.';
  expect(await approveExpense(asOwner, opened)).toEqual({ ok: false, error: changed });
  expect(await rejectExpense(asOwner, opened)).toEqual({ ok: false, error: changed });
  expect(await expenseRow(saved.id)).toMatchObject({ status: 'pending', amount: 9999, approved_by: null });
  // Shown again, it is decided.
  done(await approveExpense(asOwner, await shown(saved.id)));
  expect((await expenseRow(saved.id))?.status).toBe('approved');
});

testWithSupabase('a direct update of a pending expense moves updated_at, and is not approved as it was shown', async () => {
  const asMember = { client: member.c, orgId };
  const asOwner = { client: owner.c, orgId };
  const rent = await category('Rent');
  const saved = done(await saveExpense(asMember, { expense_date: daysFromToday(0), category_id: rent, vendor_name: 'Kedai Ali', amount: 120 }));
  const opened = await shown(saved.id);
  // The member goes round the app: a plain update of the amount and nothing else. The database stamps it
  // (the trigger finance_expense_stamp), so updated_at moves all the same.
  const direct = await member.c.from('finance_expenses').update({ amount: 9999 }).eq('id', saved.id).select('id').maybeSingle();
  expect(direct.error, direct.error?.message).toBeNull();
  expect((await shown(saved.id)).updated_at).not.toBe(opened.updated_at);
  // Nor can they put the old value back with the change.
  const pinned = await member.c
    .from('finance_expenses')
    .update({ amount: 8888, updated_at: opened.updated_at })
    .eq('id', saved.id)
    .select('id')
    .maybeSingle();
  expect(pinned.error, pinned.error?.message).toBeNull();
  expect((await shown(saved.id)).updated_at).not.toBe(opened.updated_at);
  const changed = 'This expense was changed after you opened it. Check it again, then approve or reject it.';
  expect(await approveExpense(asOwner, opened)).toEqual({ ok: false, error: changed });
  expect(await rejectExpense(asOwner, opened)).toEqual({ ok: false, error: changed });
  expect(await expenseRow(saved.id)).toMatchObject({ status: 'pending', amount: 8888, approved_by: null });
});

testWithSupabase('an expense of NaN is refused by the database, whoever sends it', async () => {
  const rent = await category('Rent');
  for (const c of [member.c, owner.c]) {
    const refused = await c.rpc('finance_save_expense', {
      target_org: orgId,
      expense: { category_id: rent, vendor_name: 'X', amount: 'NaN', sst_amount: 0 },
    });
    expect(refused.error?.code).toBe('23514');
    expect(refused.error?.message).toContain('finance_expenses_amount_not_nan');
    const both = await c.rpc('finance_save_expense', {
      target_org: orgId,
      expense: { category_id: rent, vendor_name: 'X', amount: 'NaN', sst_amount: 'NaN' },
    });
    expect(both.error?.code).toBe('23514');
  }
  const { data } = await owner.c.from('finance_expenses').select('id').eq('org_id', orgId).eq('vendor_name', 'X');
  expect(data ?? []).toEqual([]);
});

// ---- stage 5c-2: marking an expense paid, and the rules of bendahara_expense_stamp_and_category_writers ----
// Marking paid goes through src/lib/finance/expense-payment.ts with what the Mark paid card sends: the row as
// the screen reads it, the accounts as the screen reads them, and the card's own form and payload functions.

/** The expense as the Expenses screen lists it. */
const listed = async (id: string) => {
  const row = (await listExpenses({ client: owner.c, orgId })).find((e) => e.id === id);
  expect(row).toBeTruthy();
  return row!;
};
/** What the Mark paid card sends for that row with this amount typed; with no amount, the card as it opens (all that is left). */
const cardPayment = async (id: string, amount?: string) => {
  const row = await listed(id);
  const form = newExpensePayForm(row, await listAccounts({ client: owner.c, orgId }), daysFromToday(0));
  return expensePayPayload(row, amount === undefined ? form : { ...form, amount });
};
const vouchersFor = async (party: string) => {
  const { data, error } = await owner.c
    .from('finance_payment_vouchers')
    .select('kind, status, number, amount, party_name, category_name, contact_id')
    .eq('org_id', orgId)
    .eq('party_name', party)
    // Earlier tests in this file leave a bill payment to the same supplier: this reads the expenses' vouchers only.
    .eq('kind', 'expense')
    .order('amount', { ascending: true });
  expect(error, error?.message).toBeNull();
  return data ?? [];
};

testWithSupabase('an approved expense is marked paid by the owner, in part and then in full; a member cannot', async () => {
  const asMember = { client: member.c, orgId };
  const asOwner = { client: owner.c, orgId };
  const rent = await category('Rent');
  const saved = done(await saveExpense(asOwner, { expense_date: daysFromToday(0), category_id: rent, vendor_name: 'Paid Landlord', amount: 100 }));
  expect((await cardPayment(saved.id)).amount).toBe(100);

  // A member is refused by the database, and nothing is left behind.
  const before = await transactions();
  expect(await markExpensePaid(asMember, await cardPayment(saved.id, '30'))).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
  expect(await transactions()).toBe(before);

  // The owner pays 30 of 100: a posted voucher with a number, and the expense is part paid.
  const part = done(await markExpensePaid(asOwner, await cardPayment(saved.id, '30')));
  expect(part.number).toMatch(/^PV-\d+$/);
  expect(await listed(saved.id)).toMatchObject({ display_status: 'approved', paid: 30, held: 0, method: 'bank_transfer' });
  // What is left is what the card now opens with, and more than that is refused by the database itself.
  expect((await cardPayment(saved.id)).amount).toBe(70);
  expect(await markExpensePaid(asOwner, await cardPayment(saved.id, '70.01'))).toEqual({
    ok: false,
    error: 'That is more than is still to pay on this expense.',
  });
  done(await markExpensePaid(asOwner, await cardPayment(saved.id)));
  expect(await listed(saved.id)).toMatchObject({ display_status: 'paid', paid: 100, held: 0 });
  expect(await markExpensePaid(asOwner, await cardPayment(saved.id, '0.01'))).toEqual({
    ok: false,
    error: 'That is more than is still to pay on this expense.',
  });

  // Both payments are on Payment Vouchers as expense vouchers, paid to the vendor the expense names.
  expect(await vouchersFor('Paid Landlord')).toMatchObject([
    { kind: 'expense', status: 'posted', amount: 30, party_name: 'Paid Landlord', category_name: 'Rent', contact_id: null },
    { kind: 'expense', status: 'posted', amount: 70, party_name: 'Paid Landlord', category_name: 'Rent', contact_id: null },
  ]);
  // A paid expense is not rejected.
  expect(await rejectExpense(asOwner, await shown(saved.id))).toEqual({
    ok: false,
    error: 'This expense has a payment against it, paid or still to be paid, so it cannot be rejected.',
  });
});

testWithSupabase('an expense is paid to its contact, and not as it was shown once it has been rejected or changed', async () => {
  const asMember = { client: member.c, orgId };
  const asOwner = { client: owner.c, orgId };
  const rent = await category('Rent');
  const details = { expense_date: daysFromToday(0), category_id: rent, vendor_id: supplier, vendor_name: null, amount: 80 };
  const saved = done(await saveExpense(asOwner, details));
  const opened = await cardPayment(saved.id);

  // Rejected while the card was open: not paid.
  done(await rejectExpense(asOwner, await shown(saved.id)));
  expect(await markExpensePaid(asOwner, opened)).toEqual({ ok: false, error: 'This expense is not approved any more, so it cannot be paid.' });
  // Changed by a member and approved again: it is approved, and it is not the expense the card showed.
  done(await saveExpense(asMember, { ...details, id: saved.id, amount: 800 }));
  done(await approveExpense(asOwner, await shown(saved.id)));
  expect(await markExpensePaid(asOwner, opened)).toEqual({
    ok: false,
    error: 'This expense was changed after you opened it. Check it again, then mark it paid.',
  });
  expect(await listed(saved.id)).toMatchObject({ display_status: 'approved', amount: 800, paid: 0, held: 0 });

  // Shown again, it is paid, to the contact.
  done(await markExpensePaid(asOwner, await cardPayment(saved.id)));
  expect(await listed(saved.id)).toMatchObject({ display_status: 'paid', paid: 800 });
  expect(await vouchersFor('Guarded Supplier')).toMatchObject([{ kind: 'expense', status: 'posted', amount: 800, contact_id: supplier }]);
  // An expense that is not there.
  expect(await markExpensePaid(asOwner, { ...opened, id: '00000000-0000-4000-8000-000000000000' })).toEqual({
    ok: false,
    error: 'That expense no longer exists.',
  });
});

testWithSupabase('categories are an owner\'s to change, a category has a name, and who entered an expense is not rewritten', async () => {
  const asMember = { client: member.c, orgId };
  const rent = await category('Rent');

  // A member reads categories and changes none of them.
  const added = await member.c.from('finance_categories').insert({ org_id: orgId, name: 'Member Fuel', kind: 'expense' });
  expect(added.error?.code).toBe(DENIED);
  const renamed = await member.c.from('finance_categories').update({ name: 'Member Rent' }).eq('id', rent).select('id');
  expect(renamed.error, renamed.error?.message).toBeNull();
  expect(renamed.data).toEqual([]);
  const archived = await member.c.from('finance_categories').update({ active: false }).eq('id', rent).select('id');
  expect(archived.data).toEqual([]);
  const removed = await member.c.from('finance_categories').delete().eq('org_id', orgId).eq('name', 'Travel').select('id');
  expect(removed.data).toEqual([]);
  expect((await listExpenseCategories(asMember)).map((c) => c.name)).toEqual(
    expect.arrayContaining(['Rent', 'Travel']),
  );

  // The owner adds, renames, archives and restores one; its name is checked by the database.
  const made = await owner.c.from('finance_categories').insert({ org_id: orgId, name: 'Live Fuel', kind: 'expense' }).select('id').single();
  expect(made.error, made.error?.message).toBeNull();
  const fuel = made.data!.id as string;
  for (const name of ['', '   ', 'Live Petrol ', 'n'.repeat(81)]) {
    const refused = await owner.c.from('finance_categories').update({ name }).eq('id', fuel);
    expect(refused.error?.code, JSON.stringify(name)).toBe('23514');
    expect(refused.error?.message).toContain('finance_categories_name_check');
  }
  const again = await owner.c.from('finance_categories').insert({ org_id: orgId, name: 'live fuel', kind: 'expense' });
  expect(again.error?.code).toBe('23505');
  for (const change of [{ name: 'Live Petrol' }, { active: false }, { active: true }]) {
    const changed = await owner.c.from('finance_categories').update(change).eq('id', fuel).select('id');
    expect(changed.error, changed.error?.message).toBeNull();
    expect(changed.data).toEqual([{ id: fuel }]);
  }
  // Its account in the books followed the new name.
  const account = await owner.c.from('finance_ledger_accounts').select('name, active').eq('org_id', orgId).eq('category_id', fuel).maybeSingle();
  expect(account.data).toEqual({ name: 'Live Petrol', active: true });
  const gone = await owner.c.from('finance_categories').delete().eq('id', fuel).select('id');
  expect(gone.data).toEqual([{ id: fuel }]);

  // Who entered an expense, and when, is the database's: neither a member nor the owner writes it.
  const saved = done(await saveExpense(asMember, { expense_date: daysFromToday(0), category_id: rent, vendor_name: 'Kedai Ali', amount: 15 }));
  for (const c of [member.c, owner.c]) {
    const who = await c.from('finance_expenses').update({ created_by: owner.userId }).eq('id', saved.id);
    expect(who.error?.code).toBe(DENIED);
    const when = await c.from('finance_expenses').update({ created_at: '2020-01-01T00:00:00Z' }).eq('id', saved.id);
    expect(when.error?.code).toBe(DENIED);
    const borrowed = await c
      .from('finance_expenses')
      .insert({ org_id: orgId, category_id: rent, vendor_name: 'Y', amount: 5, created_by: c === member.c ? owner.userId : member.userId });
    expect(borrowed.error?.code).toBe(DENIED);
  }
  expect(await expenseRow(saved.id)).toMatchObject({ status: 'pending', amount: 15, created_by: member.userId });
  // An insert by hand is the caller's own, and is stamped by the database whatever updated_at it sends.
  const byHand = await member.c
    .from('finance_expenses')
    .insert({ org_id: orgId, category_id: rent, vendor_name: 'By hand', amount: 5, updated_at: '2020-01-01T00:00:00Z' })
    .select('id, created_by, updated_at')
    .single();
  expect(byHand.error, byHand.error?.message).toBeNull();
  expect(byHand.data!.created_by).toBe(member.userId);
  expect(new Date(byHand.data!.updated_at as string).getFullYear()).toBeGreaterThan(2020);
  done(await deleteExpense(asMember, { id: byHand.data!.id as string }));
  done(await deleteExpense(asMember, { id: saved.id }));
});
