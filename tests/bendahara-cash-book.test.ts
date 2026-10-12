import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';

// Cash receipts, payment vouchers and expenses against the hosted database.
// Run by the controller only, after the cash book migration is applied. Every
// user here owns the workspace it makes, so each is an owner: what an editor
// and a viewer may not do is proved by supabase/tests/bendahara_cash_book_check.sql,
// which acts as each of them. The last test reads the demo seed.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Org = {
  c: SupabaseClient;
  userId: string;
  orgId: string;
  bank: string;
  till: string;
  customer: string;
  supplier: string;
  rent: string;
  sales: string;
};

async function anonUserWithOrg(orgName: string): Promise<Org> {
  const c = liveClient();
  const { data: auth, error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const { data: accounts } = await c.from('finance_accounts').select('id, kind').eq('org_id', orgId);
  const { data: categories } = await c.from('finance_categories').select('id, name, kind').eq('org_id', orgId);
  const { data: contacts, error: contactErr } = await c
    .from('finance_contacts')
    .insert([
      { org_id: orgId, name: `Customer of ${orgName}`, is_customer: true, is_supplier: false },
      { org_id: orgId, name: `Supplier of ${orgName}`, is_customer: false, is_supplier: true },
    ])
    .select('id, is_customer');
  expect(contactErr, contactErr?.message).toBeNull();
  return {
    c,
    userId: auth.user!.id,
    orgId: orgId as string,
    bank: accounts!.find((a) => a.kind === 'bank')!.id as string,
    till: accounts!.find((a) => a.kind === 'cash')!.id as string,
    customer: contacts!.find((x) => x.is_customer)!.id as string,
    supplier: contacts!.find((x) => !x.is_customer)!.id as string,
    rent: categories!.find((x) => x.kind === 'expense' && x.name === 'Rent')!.id as string,
    sales: categories!.find((x) => x.kind === 'income' && x.name === 'Sales')!.id as string,
  };
}

function daysFromToday(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DESIGN = { description: 'Design work', quantity: 10, unit_price: 12.5, sst_rate: 6 }; // 125.00 + 7.50 SST = 132.50

/** A posted invoice of RM 132.50. */
async function postedInvoice(o: Org) {
  const saved = await o.c.rpc('finance_save_invoice', {
    target_org: o.orgId,
    invoice: { customer_id: o.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_invoice', { target_org: o.orgId, target_invoice: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return saved.data as string;
}

/** A posted bill of RM 132.50. */
async function postedBill(o: Org) {
  const saved = await o.c.rpc('finance_save_bill', {
    target_org: o.orgId,
    bill: { supplier_id: o.supplier, bill_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_bill', { target_org: o.orgId, target_bill: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return saved.data as string;
}

function saveExpense(o: Org, amount: number, extra: object = {}) {
  return o.c.rpc('finance_save_expense', {
    target_org: o.orgId,
    expense: { expense_date: daysFromToday(0), category_id: o.rent, vendor_name: 'Landlord', amount, ...extra },
  });
}

function payExpense(o: Org, expenseId: string, amount: number, status: 'posted' | 'scheduled' = 'posted') {
  return o.c.rpc('finance_record_voucher', {
    target_org: o.orgId,
    voucher: { account_id: o.bank, txn_date: daysFromToday(0), method: 'fpx', party_name: 'Landlord', status },
    allocations: [{ expense_id: expenseId, amount }],
  });
}

function categoryVoucher(o: Org, amount: number, status: 'posted' | 'scheduled' = 'posted') {
  return o.c.rpc('finance_record_voucher', {
    target_org: o.orgId,
    voucher: {
      account_id: o.bank, txn_date: daysFromToday(0), method: 'fpx', party_name: 'Water board', category_id: o.rent, amount, status,
    },
    allocations: [],
  });
}

function saveReceipt(o: Org, receipt: object, allocations: object[] = []) {
  return o.c.rpc('finance_save_cash_receipt', {
    target_org: o.orgId,
    receipt: { account_id: o.bank, txn_date: daysFromToday(0), method: 'cash', ...receipt },
    allocations,
  });
}

async function expense(c: SupabaseClient, id: string) {
  const { data, error } = await c
    .from('finance_expense_totals')
    .select('status, display_status, amount, paid, held, approved_by, method')
    .eq('id', id)
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

async function txn(c: SupabaseClient, id: string) {
  const { data, error } = await c
    .from('finance_transactions')
    .select('direction, status, amount, number, approved_by, approved_at, category_id')
    .eq('id', id)
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

let a: Org;
let b: Org;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  a = await anonUserWithOrg('Cash Book A Sdn Bhd');
  b = await anonUserWithOrg('Cash Book B Sdn Bhd');
});

testWithSupabase('an expense saved by an owner is approved, locked, and reads Paid once a voucher covers it', async () => {
  const saved = await saveExpense(a, 100, { sst_amount: 6 });
  expect(saved.error, saved.error?.message).toBeNull();
  expect(await expense(a.c, saved.data)).toEqual({
    status: 'approved', display_status: 'approved', amount: 100, paid: 0, held: 0, approved_by: a.userId, method: null,
  });

  const direct = await a.c.from('finance_expenses').insert({
    org_id: a.orgId, category_id: a.rent, vendor_name: 'Sneaky', amount: 1, status: 'approved', approved_at: new Date().toISOString(),
  });
  expect(direct.error?.code).toBe('FIN01');
  const wrongKind = await saveExpense(a, 10, { category_id: a.sales });
  expect(wrongKind.error?.code).toBe('FIN15');
  const noVendor = await saveExpense(a, 10, { vendor_name: null });
  expect(noVendor.error?.code).toBe('23514');
  const edit = await a.c.from('finance_expenses').update({ amount: 1 }).eq('id', saved.data);
  expect(edit.error?.code).toBe('FIN01');
  const remove = await a.c.from('finance_expenses').delete().eq('id', saved.data);
  expect(remove.error?.code).toBe('FIN01');

  const part = await payExpense(a, saved.data, 40, 'scheduled');
  expect(part.error, part.error?.message).toBeNull();
  expect(await expense(a.c, saved.data)).toMatchObject({ paid: 0, held: 40, display_status: 'approved' });
  const tooMuch = await payExpense(a, saved.data, 60.01);
  expect(tooMuch.error?.code).toBe('FIN05');
  const rest = await payExpense(a, saved.data, 60);
  expect(rest.error, rest.error?.message).toBeNull();
  expect((await txn(a.c, rest.data)).number).toMatch(/^PV-\d{4}$/);
  const paid = await a.c.rpc('finance_mark_payment_paid', { target_org: a.orgId, target_txn: part.data, paid_on: daysFromToday(0) });
  expect(paid.error, paid.error?.message).toBeNull();
  expect(await expense(a.c, saved.data)).toMatchObject({ paid: 100, held: 0, display_status: 'paid', method: 'fpx' });

  // With payments standing it cannot be rejected; once they are voided it can, and is then edited back to pending.
  const reject = () => a.c.from('finance_expenses').update({ status: 'rejected' }).eq('id', saved.data);
  expect((await reject()).error?.code).toBe('FIN02');
  for (const id of [part.data, rest.data]) {
    expect((await a.c.from('finance_transactions').update({ status: 'void' }).eq('id', id)).error).toBeNull();
  }
  expect((await reject()).error).toBeNull();
  expect((await payExpense(a, saved.data, 10)).error?.code).toBe('FIN04');
});

testWithSupabase('two vouchers for the whole of one expense at the same moment: only one goes through', async () => {
  const saved = await saveExpense(a, 75);
  expect(saved.error, saved.error?.message).toBeNull();
  const results = await Promise.all([payExpense(a, saved.data, 75), payExpense(a, saved.data, 75)]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(results.find((r) => r.error)?.error?.code).toBe('FIN05');
  expect(await expense(a.c, saved.data)).toMatchObject({ paid: 75, display_status: 'paid' });
});

testWithSupabase('a voucher that settles no document is approved in the owner\'s name; a payment cannot be created past its draft', async () => {
  const paid = await categoryVoucher(a, 300);
  expect(paid.error, paid.error?.message).toBeNull();
  const row = await txn(a.c, paid.data);
  expect(row).toMatchObject({ direction: 'out', status: 'posted', amount: 300, approved_by: a.userId, category_id: a.rent });
  expect(row.number).toMatch(/^PV-\d{4}$/);
  expect(row.approved_at).not.toBeNull();

  const later = await categoryVoucher(a, 80, 'scheduled');
  expect(later.error, later.error?.message).toBeNull();
  expect(await txn(a.c, later.data)).toMatchObject({ status: 'scheduled', number: null, approved_by: a.userId });
  // Approved, it is paid as it was approved.
  const changed = await a.c.from('finance_transactions').update({ amount: 8000 }).eq('id', later.data);
  expect(changed.error?.code).toBe('FIN14');
  const marked = await a.c.rpc('finance_mark_payment_paid', { target_org: a.orgId, target_txn: later.data, paid_on: daysFromToday(0) });
  expect(marked.error, marked.error?.message).toBeNull();
  expect(await txn(a.c, later.data)).toMatchObject({ status: 'posted', amount: 80 });

  const direct = await a.c.from('finance_transactions').insert({
    org_id: a.orgId, direction: 'out', account_id: a.bank, amount: 5, method: 'cash', category_id: a.rent, status: 'posted', number: 'PV-SNEAKY',
  });
  expect(direct.error?.code).toBe('FIN09');
  const wrongKind = await a.c.rpc('finance_record_voucher', {
    target_org: a.orgId,
    voucher: { account_id: a.bank, method: 'fpx', party_name: 'X', category_id: a.sales, amount: 5 },
    allocations: [],
  });
  expect(wrongKind.error?.code).toBe('FIN15');

  // A rejected payment is final: it is deleted, never brought back.
  const { data: draft } = await a.c
    .from('finance_transactions')
    .insert({ org_id: a.orgId, direction: 'out', account_id: a.bank, amount: 5, method: 'cash', category_id: a.rent })
    .select('id')
    .single();
  expect((await a.c.from('finance_transactions').update({ status: 'pending_approval' }).eq('id', draft!.id)).error).toBeNull();
  expect((await a.c.from('finance_transactions').update({ status: 'rejected' }).eq('id', draft!.id)).error).toBeNull();
  const back = await a.c.from('finance_transactions').update({ status: 'scheduled' }).eq('id', draft!.id);
  expect(back.error?.code).toBe('FIN14');
  expect((await a.c.from('finance_transactions').delete().eq('id', draft!.id)).error).toBeNull();
});

// Every user this file can make owns its workspace (see the note at the top), so the member's own attempt is
// in the check script. What is proved here is the rule that stops a member: approved_at and approved_by are
// written by the database and by nobody's update, not even an owner's, so nobody approves by writing them.
testWithSupabase('nobody approves a payment or an expense by writing approved_at: the database records it, or refuses', async () => {
  const { data: draft } = await a.c
    .from('finance_transactions')
    .insert({ org_id: a.orgId, direction: 'out', account_id: a.bank, amount: 500, method: 'cash', category_id: a.rent })
    .select('id')
    .single();
  const now = new Date().toISOString();
  const byHand = await a.c.from('finance_transactions').update({ approved_at: now, approved_by: a.userId }).eq('id', draft!.id);
  expect(byHand.error?.code).toBe('FIN14');
  const timeOnly = await a.c.from('finance_transactions').update({ approved_at: now }).eq('id', draft!.id);
  expect(timeOnly.error?.code).toBe('FIN14');
  const withStatus = await a.c
    .from('finance_transactions')
    .update({ status: 'scheduled', approved_at: '2020-01-01T00:00:00Z' })
    .eq('id', draft!.id);
  expect(withStatus.error?.code).toBe('FIN14');
  expect(await txn(a.c, draft!.id)).toMatchObject({ status: 'draft', approved_by: null, approved_at: null });

  // Scheduled by its owner with nothing written by hand, the database names them and the time, and the two then stay as they are.
  expect((await a.c.from('finance_transactions').update({ status: 'scheduled' }).eq('id', draft!.id)).error).toBeNull();
  const approved = await txn(a.c, draft!.id);
  expect(approved).toMatchObject({ status: 'scheduled', approved_by: a.userId });
  expect(approved.approved_at).not.toBeNull();
  const blanked = await a.c.from('finance_transactions').update({ approved_by: null }).eq('id', draft!.id);
  expect(blanked.error?.code).toBe('FIN14');
  expect((await txn(a.c, draft!.id)).approved_by).toBe(a.userId);
  expect((await a.c.from('finance_transactions').delete().eq('id', draft!.id)).error).toBeNull();

  // The same for an expense: saved by its owner it is approved in their name, and that name is not blanked by hand.
  const saved = await saveExpense(a, 30);
  expect(saved.error, saved.error?.message).toBeNull();
  const erased = await a.c.from('finance_expenses').update({ approved_by: null }).eq('id', saved.data);
  expect(erased.error?.code).toBe('FIN01');
  expect((await expense(a.c, saved.data)).approved_by).toBe(a.userId);
  // Created pending with an approver written in, it is stored as nobody's decision.
  const { data: pending, error: pendingErr } = await a.c
    .from('finance_expenses')
    .insert({ org_id: a.orgId, category_id: a.rent, vendor_name: 'Sneaky', amount: 1, approved_by: a.userId, approved_at: now })
    .select('id, status, approved_by, approved_at')
    .single();
  expect(pendingErr, pendingErr?.message).toBeNull();
  expect(pending).toMatchObject({ status: 'pending', approved_by: null, approved_at: null });
  const written = await a.c.from('finance_expenses').update({ approved_at: now }).eq('id', pending!.id);
  expect(written.error?.code).toBe('FIN14');
  expect((await a.c.from('finance_expenses').delete().eq('id', pending!.id)).error).toBeNull();
});

testWithSupabase('a cash receipt is a draft until it is posted, and a draft holds what it is split across', async () => {
  const income = await saveReceipt(a, { party_name: 'Walk-in', category_id: a.sales, amount: 80, account_id: a.till });
  expect(income.error, income.error?.message).toBeNull();
  const { data: draft } = await a.c
    .from('finance_cash_receipts')
    .select('kind, status, number, amount, party_name, category_name, account_kind')
    .eq('transaction_id', income.data)
    .single();
  expect(draft).toEqual({
    kind: 'income', status: 'draft', number: null, amount: 80, party_name: 'Walk-in', category_name: 'Sales', account_kind: 'cash',
  });
  const neither = await saveReceipt(a, { party_name: 'Walk-in', amount: 80 });
  expect(neither.error?.code).toBe('FIN15');
  const expenseCategory = await saveReceipt(a, { party_name: 'Walk-in', category_id: a.rent, amount: 80 });
  expect(expenseCategory.error?.code).toBe('FIN15');

  const posted = await a.c.rpc('finance_post_cash_receipt', { target_org: a.orgId, target_txn: income.data });
  expect(posted.error, posted.error?.message).toBeNull();
  expect(posted.data).toMatch(/^RC-\d{4}$/);
  const again = await saveReceipt(a, { id: income.data, party_name: 'Walk-in', category_id: a.sales, amount: 1 });
  expect(again.error?.code).toBe('FIN09');

  // Against an invoice: the draft holds RM 100 of the RM 132.50, so only RM 32.50 more can be received.
  const invoice = await postedInvoice(a);
  const held = await saveReceipt(a, { method: 'fpx' }, [{ invoice_id: invoice, amount: 100 }]);
  expect(held.error, held.error?.message).toBeNull();
  const receive = (amount: number) =>
    a.c.rpc('finance_record_payment_in', {
      target_org: a.orgId,
      payment: { account_id: a.bank, txn_date: daysFromToday(0), method: 'fpx' },
      allocations: [{ invoice_id: invoice, amount }],
    });
  expect((await receive(32.51)).error?.code).toBe('FIN05');
  expect((await receive(32.5)).error).toBeNull();
  const post = await a.c.rpc('finance_post_cash_receipt', { target_org: a.orgId, target_txn: held.data });
  expect(post.error, post.error?.message).toBeNull();
  const { data: totals } = await a.c.from('finance_invoice_totals').select('paid, balance, display_status').eq('id', invoice).single();
  expect(totals).toEqual({ paid: 132.5, balance: 0, display_status: 'paid' });
  // The same money: one row per invoice on Payments In, one row on Cash Receipts.
  const { data: onPaymentsIn } = await a.c.from('finance_payments_in').select('allocation_id').eq('transaction_id', held.data);
  const { data: onCashReceipts } = await a.c.from('finance_cash_receipts').select('kind, documents').eq('transaction_id', held.data);
  expect(onPaymentsIn).toHaveLength(1);
  expect(onCashReceipts).toHaveLength(1);
  expect(onCashReceipts![0].kind).toBe('invoice');
  expect(onCashReceipts![0].documents).toMatch(/^INV-\d{4}$/);
});

testWithSupabase('one draft receipt posted twice at the same moment gets one number', async () => {
  const saved = await saveReceipt(a, { party_name: 'Walk-in', category_id: a.sales, amount: 12 });
  expect(saved.error, saved.error?.message).toBeNull();
  const post = () => a.c.rpc('finance_post_cash_receipt', { target_org: a.orgId, target_txn: saved.data });
  const results = await Promise.all([post(), post()]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(results.find((r) => r.error)?.error?.code).toBe('FIN09');
  expect((await txn(a.c, saved.data)).number).toBe(results.find((r) => r.error === null)!.data);
});

testWithSupabase('money in is never marked paid, and never takes a voucher number', async () => {
  const { data: draft } = await a.c
    .from('finance_transactions')
    .insert({ org_id: a.orgId, direction: 'in', account_id: a.bank, amount: 5, method: 'cash', category_id: a.sales })
    .select('id')
    .single();
  expect((await a.c.from('finance_transactions').update({ status: 'scheduled' }).eq('id', draft!.id)).error).toBeNull();
  const marked = await a.c.rpc('finance_mark_payment_paid', { target_org: a.orgId, target_txn: draft!.id, paid_on: daysFromToday(0) });
  expect(marked.error?.code).toBe('FIN09');
  expect(await txn(a.c, draft!.id)).toMatchObject({ status: 'scheduled', number: null });
  expect((await a.c.from('finance_transactions').delete().eq('id', draft!.id)).error).toBeNull();
});

testWithSupabase('every movement of money is one row on its cash book screen, whatever it pays', async () => {
  const first = await postedBill(a);
  const second = await postedBill(a);
  const paid = await a.c.rpc('finance_record_payment_out', {
    target_org: a.orgId,
    payment: { account_id: a.bank, txn_date: daysFromToday(0), method: 'fpx' },
    allocations: [{ bill_id: first, amount: 132.5 }, { bill_id: second, amount: 100 }],
  });
  expect(paid.error, paid.error?.message).toBeNull();
  const { data: onPaymentsOut } = await a.c.from('finance_payments_out').select('allocation_id').eq('transaction_id', paid.data);
  const { data: vouchers } = await a.c
    .from('finance_payment_vouchers')
    .select('kind, amount, status, documents, party_name')
    .eq('transaction_id', paid.data);
  expect(onPaymentsOut).toHaveLength(2);
  expect(vouchers).toHaveLength(1);
  expect(vouchers![0]).toMatchObject({ kind: 'bill', amount: 232.5, status: 'posted', party_name: 'Supplier of Cash Book A Sdn Bhd' });
  expect(vouchers![0].documents).toMatch(/^BILL-\d{4}, BILL-\d{4}$/);
  // A payment to a supplier recorded the old way is not held for approval and names nobody as approver.
  expect(await txn(a.c, paid.data)).toMatchObject({ status: 'posted', approved_by: null, approved_at: null });

  // One payment pays one kind of document.
  const saved = await saveExpense(a, 20);
  const { data: draft } = await a.c
    .from('finance_transactions')
    .insert({ org_id: a.orgId, direction: 'out', account_id: a.bank, amount: 30, method: 'cash' })
    .select('id')
    .single();
  const onBill = await a.c.from('finance_allocations').insert({ org_id: a.orgId, transaction_id: draft!.id, bill_id: second, amount: 10 });
  expect(onBill.error, onBill.error?.message).toBeNull();
  const onExpense = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: draft!.id, expense_id: saved.data, amount: 10 });
  expect(onExpense.error?.code).toBe('FIN06');
  expect((await a.c.from('finance_transactions').delete().eq('id', draft!.id)).error).toBeNull();

  // The two views are exactly the payments table, by direction.
  const { count: out } = await a.c
    .from('finance_transactions').select('id', { count: 'exact', head: true }).eq('org_id', a.orgId).eq('direction', 'out');
  const { count: listedOut } = await a.c
    .from('finance_payment_vouchers').select('transaction_id', { count: 'exact', head: true }).eq('org_id', a.orgId);
  const { count: moneyIn } = await a.c
    .from('finance_transactions').select('id', { count: 'exact', head: true }).eq('org_id', a.orgId).eq('direction', 'in');
  const { count: listedIn } = await a.c
    .from('finance_cash_receipts').select('transaction_id', { count: 'exact', head: true }).eq('org_id', a.orgId);
  expect(listedOut).toBe(out);
  expect(listedIn).toBe(moneyIn);
});

testWithSupabase('another workspace cannot see or touch expenses, vouchers or receipts', async () => {
  const saved = await saveExpense(a, 50);
  expect(saved.error, saved.error?.message).toBeNull();
  const receipt = await saveReceipt(a, { party_name: 'Walk-in', category_id: a.sales, amount: 9 });
  expect(receipt.error, receipt.error?.message).toBeNull();

  for (const table of ['finance_expenses', 'finance_expense_totals', 'finance_payment_vouchers', 'finance_cash_receipts']) {
    const { data } = await b.c.from(table).select('org_id').eq('org_id', a.orgId);
    expect(data ?? [], table).toEqual([]);
  }
  const save = await b.c.rpc('finance_save_expense', {
    target_org: a.orgId,
    expense: { category_id: a.rent, vendor_name: 'X', amount: 1 },
  });
  expect(save.error?.code).toBe('FIN15');
  const pay = await b.c.rpc('finance_record_voucher', {
    target_org: b.orgId,
    voucher: { account_id: b.bank, method: 'fpx', party_name: 'X' },
    allocations: [{ expense_id: saved.data, amount: 1 }],
  });
  expect(pay.error?.code).toBe('FIN06');
  const post = await b.c.rpc('finance_post_cash_receipt', { target_org: a.orgId, target_txn: receipt.data });
  expect(post.error?.code).toBe('FIN11');
  const { data: approved } = await b.c.from('finance_expenses').update({ status: 'rejected' }).eq('id', saved.data).select('id');
  expect(approved ?? []).toEqual([]);
  expect((await expense(a.c, saved.data)).status).toBe('approved');
});

testWithSupabase('a demo viewer reads the seeded cash book, and can write none of it', async () => {
  const c = liveClient();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await joinDemo(c);
  expect(error, error?.message).toBeNull();

  // Dates are relative to the day the seed ran: only what cannot drift is asserted.
  const { data: expenses } = await c.from('finance_expense_totals').select('id, display_status, amount, paid').eq('org_id', demoId);
  expect((expenses ?? []).length).toBe(23);
  expect((expenses ?? []).filter((e) => e.display_status === 'paid')).toHaveLength(19);
  expect((expenses ?? []).filter((e) => e.display_status === 'pending')).toHaveLength(2);
  expect((expenses ?? []).filter((e) => e.display_status === 'paid').every((e) => Number(e.paid) === Number(e.amount))).toBe(true);

  const { data: vouchers } = await c.from('finance_payment_vouchers').select('kind, status, number, amount').eq('org_id', demoId);
  const own = (vouchers ?? []).filter((v) => v.kind === 'expense' || v.kind === 'other');
  expect(own.filter((v) => v.kind === 'expense')).toHaveLength(19);
  expect(own.filter((v) => v.status === 'pending_approval').reduce((sum, v) => sum + Number(v.amount), 0)).toBe(4340);
  expect(own.every((v) => (v.status === 'posted') === /^PV-\d+$/.test(v.number ?? ''))).toBe(true);
  // The demo's payments to suppliers and refunds are vouchers too.
  expect((vouchers ?? []).some((v) => v.kind === 'bill')).toBe(true);
  expect((vouchers ?? []).some((v) => v.kind === 'refund')).toBe(true);

  const { data: receipts } = await c.from('finance_cash_receipts').select('kind, status, number, amount').eq('org_id', demoId);
  const income = (receipts ?? []).filter((r) => r.kind === 'income');
  expect(income).toHaveLength(7);
  expect(income.filter((r) => r.status === 'draft').every((r) => r.number === null)).toBe(true);
  expect(income.filter((r) => r.status === 'posted').reduce((sum, r) => sum + Number(r.amount), 0)).toBeCloseTo(4444.2, 2);
  expect((receipts ?? []).some((r) => r.kind === 'invoice')).toBe(true);

  const pending = (expenses ?? []).find((e) => e.display_status === 'pending')!;
  const save = await c.rpc('finance_save_expense', {
    target_org: demoId,
    expense: { category_id: crypto.randomUUID(), vendor_name: 'Viewer', amount: 1 },
  });
  expect(save.error?.code).toBe('FIN15');
  const { data: decided } = await c.from('finance_expenses').update({ status: 'approved' }).eq('id', pending.id).select('id');
  expect(decided ?? []).toEqual([]);
  const voucher = await c.rpc('finance_record_voucher', {
    target_org: demoId,
    voucher: { account_id: crypto.randomUUID(), method: 'fpx', party_name: 'Viewer' },
    allocations: [{ expense_id: pending.id, amount: 1 }],
  });
  expect(voucher.error?.code).toBe('42501');
  const receipt = await c.from('finance_transactions').insert({
    org_id: demoId, direction: 'in', account_id: crypto.randomUUID(), amount: 1, method: 'cash',
  });
  expect(receipt.error?.code).toBe('42501');
});
