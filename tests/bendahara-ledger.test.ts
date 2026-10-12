import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

// Bendahara's chart of accounts, ledger, manual journals and bill category
// (20261108090000 to 20261108094500), and the reversing entry of a void and the
// Accrued Expenses account (20261111090000), against the live project. Each test
// makes its own workspace; the helper deletes what it made when the file
// finishes. Run by the controller only, after the migrations are applied.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Who = {
  c: SupabaseClient;
  orgId: string;
  userId: string;
  bank: string;
  till: string;
  customer: string;
  supplier: string;
  /** Category ids. */
  rent: string;
  sales: string;
  purchases: string;
};

async function ownerWithOrg(orgName: string): Promise<Who> {
  const c = liveClient();
  const { error: authErr, userId } = await signInOwner(c);
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
  const category = (kind: string, name: string) =>
    categories!.find((x) => x.kind === kind && x.name === name)!.id as string;
  return {
    c,
    orgId: orgId as string,
    userId,
    bank: accounts!.find((a) => a.kind === 'bank')!.id as string,
    till: accounts!.find((a) => a.kind === 'cash')!.id as string,
    customer: contacts!.find((x) => x.is_customer)!.id as string,
    supplier: contacts!.find((x) => !x.is_customer)!.id as string,
    rent: category('expense', 'Rent'),
    sales: category('income', 'Sales'),
    purchases: category('expense', 'Purchases'),
  };
}

/** A second person in the owner's workspace, with the given role. */
async function join(o: Who, role: 'admin' | 'member'): Promise<Who> {
  const c = liveClient();
  const signUp = await createConfirmedTestUser(c, `ledger-${role}-pass-123`);
  const invite = await o.c.rpc('create_invite', { p_email: signUp.email, p_role: role });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await c.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  return { ...o, c, userId: signUp.userId as string };
}

function today(offset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** An amount in sen, so sums are compared as whole numbers. */
const sen = (n: unknown) => Math.round(Number(n) * 100);

const PAPER = { description: 'A4 paper', quantity: 10, unit_price: 12.5, sst_rate: 6 }; // 125.00 + 7.50 = 132.50
const TONER = { description: 'Toner', quantity: 2, unit_price: 100, sst_rate: 0 }; // 200.00

// ---- the chart and the ledger ------------------------------------------------

type Account = {
  id: string;
  code: string;
  name: string;
  type: string;
  system_key: string | null;
  bank_account_id: string | null;
  category_id: string | null;
  default_for: string | null;
  active: boolean;
};

async function chart(w: Who) {
  const { data, error } = await w.c
    .from('finance_ledger_accounts')
    .select('id, code, name, type, system_key, bank_account_id, category_id, default_for, active')
    .eq('org_id', w.orgId);
  expect(error, error?.message).toBeNull();
  const rows = (data ?? []) as Account[];
  const one = (pick: (a: Account) => boolean, what: string) => {
    const found = rows.filter(pick);
    expect(found, what).toHaveLength(1);
    return found[0];
  };
  return {
    rows,
    system: (key: string) => one((a) => a.system_key === key, `system account ${key}`),
    ofBank: (id: string) => one((a) => a.bank_account_id === id, `account of bank account ${id}`),
    ofCategory: (id: string) => one((a) => a.category_id === id, `account of category ${id}`),
  };
}

type Line = {
  entry_key: string;
  entry_date: string;
  source: string;
  source_id: string;
  source_no: string | null;
  description: string;
  account_id: string | null;
  debit: number;
  credit: number;
};

/** Every line of the workspace's ledger, having checked that each entry, and the whole, balances. */
async function books(w: Who): Promise<Line[]> {
  const { data, error } = await w.c.from('finance_ledger_lines').select('*').eq('org_id', w.orgId);
  expect(error, error?.message).toBeNull();
  const lines = (data ?? []) as Line[];
  const byEntry = new Map<string, number>();
  for (const l of lines) {
    expect(l.account_id, `${l.entry_key} has a line with no account`).not.toBeNull();
    // One side per line.
    expect(sen(l.debit) > 0 !== sen(l.credit) > 0, `${l.entry_key}: one side per line`).toBe(true);
    byEntry.set(l.entry_key, (byEntry.get(l.entry_key) ?? 0) + sen(l.debit) - sen(l.credit));
  }
  for (const [key, difference] of byEntry) expect(difference, `${key} does not balance`).toBe(0);
  return lines;
}

/** The lines of one entry are exactly these: [account id, debit, credit]. */
async function expectEntry(w: Who, key: string, want: [string, number, number][]) {
  const lines = (await books(w)).filter((l) => l.entry_key === key);
  const show = (account: string | null, debit: unknown, credit: unknown) => `${account} ${sen(debit)} ${sen(credit)}`;
  expect(lines.map((l) => show(l.account_id, l.debit, l.credit)).sort(), key).toEqual(
    want.map(([account, debit, credit]) => show(account, debit, credit)).sort(),
  );
  return lines;
}

async function expectNoEntry(w: Who, key: string) {
  expect((await books(w)).filter((l) => l.entry_key === key), key).toEqual([]);
}

/**
 * A voided document: the entry `key` is still these lines, and `key:void` is the same lines with the sides
 * swapped, dated today (UTC), described as "Voided: " and the original's description, and pointing at the
 * same document. Returns the original's lines.
 */
async function expectVoided(w: Who, key: string, want: [string, number, number][]) {
  const original = await expectEntry(w, key, want);
  const reversal = await expectEntry(
    w,
    `${key}:void`,
    want.map(([account, debit, credit]) => [account, credit, debit]),
  );
  for (const line of reversal) {
    expect(line.entry_date, `${key}:void`).toBe(today());
    expect(line.description, `${key}:void`).toBe(`Voided: ${original[0].description}`);
    expect(line).toMatchObject({
      source: original[0].source,
      source_id: original[0].source_id,
      source_no: original[0].source_no,
    });
  }
  return original;
}

/** Nothing in the ledger points at this document: no entry, and no reversal. */
async function expectNothingFor(w: Who, sourceId: string) {
  expect((await books(w)).filter((l) => l.source_id === sourceId || l.entry_key.includes(sourceId)), sourceId).toEqual([]);
}

/** Each account's balance in sen, by account id. */
async function balances(w: Who): Promise<Record<string, number>> {
  const { data, error } = await w.c.from('finance_ledger_balances').select('account_id, balance').eq('org_id', w.orgId);
  expect(error, error?.message).toBeNull();
  return Object.fromEntries((data ?? []).map((b) => [b.account_id as string, sen(b.balance)]));
}

/** The ledger and Banking agree on what is in every bank and cash account. Returns the ledger's balances. */
async function expectBanksAgree(w: Who) {
  const ch = await chart(w);
  const ledger = await balances(w);
  const { data: banking, error } = await w.c.from('finance_account_balances').select('id, balance').eq('org_id', w.orgId);
  expect(error, error?.message).toBeNull();
  expect(banking!.length).toBeGreaterThan(0);
  for (const account of banking!) expect(ledger[ch.ofBank(account.id).id], account.id).toBe(sen(account.balance));
  return ledger;
}

/** What is still owed on posted supplier bills, in sen: what Accounts Payable must read. */
async function owedOnBills(w: Who) {
  const { data, error } = await w.c.from('supplier_bill_totals').select('balance').eq('org_id', w.orgId).eq('status', 'posted');
  expect(error, error?.message).toBeNull();
  return (data ?? []).reduce((sum, b) => sum + sen(b.balance), 0);
}

/** What is still to pay on approved expenses, in sen: what Accrued Expenses must read. */
async function owedOnExpenses(w: Who) {
  const { data, error } = await w.c.from('finance_expense_totals').select('amount, paid').eq('org_id', w.orgId).eq('status', 'approved');
  expect(error, error?.message).toBeNull();
  return (data ?? []).reduce((sum, e) => sum + sen(e.amount) - sen(e.paid), 0);
}

/** What posted invoices are still owed, in sen: what Accounts Receivable must read. */
async function owedOnInvoices(w: Who) {
  const { data, error } = await w.c.from('finance_invoice_totals').select('balance').eq('org_id', w.orgId).eq('status', 'posted');
  expect(error, error?.message).toBeNull();
  return (data ?? []).reduce((sum, i) => sum + sen(i.balance), 0);
}

// ---- documents ----------------------------------------------------------------

async function postedInvoice(o: Who, lines: object[] = [PAPER]) {
  const saved = await o.c.rpc('finance_save_invoice', {
    target_org: o.orgId,
    invoice: { customer_id: o.customer, invoice_date: today(), due_date: today(30) },
    lines,
  });
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_invoice', { target_org: o.orgId, target_invoice: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return saved.data as string;
}

function saveBill(w: Who, extra: object = {}, lines: object[] = [PAPER]) {
  return w.c.rpc('finance_save_bill', {
    target_org: w.orgId,
    bill: { supplier_id: w.supplier, bill_date: today(), due_date: today(30), ...extra },
    lines,
  });
}

async function postedBill(o: Who, extra: object = {}, lines: object[] = [PAPER]) {
  const saved = await saveBill(o, extra, lines);
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_bill', { target_org: o.orgId, target_bill: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return saved.data as string;
}

function payBills(o: Who, allocations: { bill_id: string; amount: number }[], status: 'posted' | 'scheduled' = 'posted') {
  return o.c.rpc('finance_record_payment_out', {
    target_org: o.orgId,
    payment: { account_id: o.bank, txn_date: today(), method: 'fpx', status },
    allocations,
  });
}

/** An expense in Rent; saved by an owner, it is approved as it is saved. */
function saveExpense(w: Who, amount: number) {
  return w.c.rpc('finance_save_expense', {
    target_org: w.orgId,
    expense: { expense_date: today(), category_id: w.rent, vendor_name: 'Landlord', amount },
  });
}

function payExpenses(o: Who, allocations: { expense_id: string; amount: number }[]) {
  return o.c.rpc('finance_record_voucher', {
    target_org: o.orgId,
    voucher: { account_id: o.bank, txn_date: today(), method: 'fpx', party_name: 'Landlord', status: 'posted' },
    allocations,
  });
}

/** Voids a row the way the app does: a plain update of status. Returns the row's voided_at. */
async function voidRow(o: Who, table: 'finance_invoices' | 'supplier_bills' | 'finance_credit_notes' | 'finance_transactions', id: string) {
  const { data, error } = await o.c.from(table).update({ status: 'void' }).eq('id', id).select('status, voided_at');
  expect(error, error?.message).toBeNull();
  expect(data, `${table} ${id}`).toHaveLength(1);
  expect(data![0].status).toBe('void');
  return data![0].voided_at as string | null;
}

function saveJournal(w: Who, lines: object[], extra: object = {}) {
  return w.c.rpc('finance_save_journal', {
    target_org: w.orgId,
    journal: { journal_date: today(), description: 'Bought equipment', ...extra },
    lines,
  });
}

const postJournal = (w: Who, id: string) =>
  w.c.rpc('finance_post_journal', { target_org: w.orgId, target_journal: id });
const reverseJournal = (w: Who, id: string) =>
  w.c.rpc('finance_reverse_journal', { target_org: w.orgId, target_journal: id, reversal_date: today() });

/** An account of the workspace's own, added by hand. */
async function ownAccount(o: Who, code: string, name: string, type = 'asset') {
  const { data, error } = await o.c
    .from('finance_ledger_accounts')
    .insert({ org_id: o.orgId, code, name, type })
    .select('id')
    .single();
  expect(error, error?.message).toBeNull();
  return data!.id as string;
}

// ---- 1 ------------------------------------------------------------------------

testWithSupabase('a new workspace has its chart, and bank accounts and categories keep it in step', async () => {
  const o = await ownerWithOrg(`Ledger chart ${Date.now()}`);
  let ch = await chart(o);

  // The seven system accounts, at the codes of the design.
  const system = { receivable: ['1200', 'asset'], payable: ['2000', 'liability'], accrued_expenses: ['2050', 'liability'], sst_payable: ['2100', 'liability'], owner_equity: ['3000', 'equity'], retained_earnings: ['3100', 'equity'], opening_equity: ['3900', 'equity'] };
  for (const [key, [code, type]] of Object.entries(system)) {
    expect(ch.system(key), key).toMatchObject({ code, type, active: true, bank_account_id: null, category_id: null });
  }

  // One account per seeded bank and cash account, and per category, Purchases included.
  expect(ch.ofBank(o.till)).toMatchObject({ code: '1000', name: 'Cash in hand', type: 'asset' });
  expect(ch.ofBank(o.bank)).toMatchObject({ code: '1100', name: 'Main Bank', type: 'asset' });
  const { data: categories } = await o.c.from('finance_categories').select('id, name, kind').eq('org_id', o.orgId);
  expect(categories!.map((x) => x.name)).toContain('Purchases');
  for (const category of categories!) {
    expect(ch.ofCategory(category.id), category.name).toMatchObject({ name: category.name, type: category.kind });
  }
  expect(ch.ofCategory(o.purchases)).toMatchObject({ code: '5000', default_for: 'purchases' });
  expect(ch.ofCategory(o.sales)).toMatchObject({ code: '4000', default_for: 'sales' });
  expect(ch.ofCategory(o.rent).code).toMatch(/^6\d{3}$/);
  expect(ch.system('accrued_expenses').name).toBe('Accrued Expenses');
  expect(ch.rows).toHaveLength(7 + 2 + categories!.length);
  expect(new Set(ch.rows.map((a) => a.code)).size).toBe(ch.rows.length);
  // Nothing has been posted: every account is there, at zero.
  const zero = await balances(o);
  expect(Object.keys(zero)).toHaveLength(ch.rows.length);
  expect(Object.values(zero).every((b) => b === 0)).toBe(true);

  // A new bank account and a new category each get one. A member adds the category: the account is the
  // database's to make, though a member may not write the chart.
  const member = await join(o, 'member');
  const savings = await o.c.from('finance_accounts').insert({ org_id: o.orgId, name: 'Savings', kind: 'bank' }).select('id').single();
  expect(savings.error, savings.error?.message).toBeNull();
  const freight = await member.c.from('finance_categories').insert({ org_id: o.orgId, name: 'Freight', kind: 'expense' }).select('id').single();
  expect(freight.error, freight.error?.message).toBeNull();
  ch = await chart(o);
  expect(ch.ofBank(savings.data!.id)).toMatchObject({ code: '1110', name: 'Savings', type: 'asset', active: true });
  const freightAccount = ch.ofCategory(freight.data!.id);
  expect(freightAccount).toMatchObject({ name: 'Freight', type: 'expense', default_for: null, active: true });
  expect(freightAccount.code).toMatch(/^6\d{3}$/);

  // Renaming the category renames the account...
  expect((await o.c.from('finance_categories').update({ name: 'Freight and courier' }).eq('id', freight.data!.id).select('id')).error).toBeNull();
  expect((await chart(o)).ofCategory(freight.data!.id).name).toBe('Freight and courier');
  // ...until the account is renamed by hand; then it is left alone.
  expect((await o.c.from('finance_ledger_accounts').update({ name: 'Delivery costs' }).eq('id', freightAccount.id).select('id')).error).toBeNull();
  expect((await o.c.from('finance_categories').update({ name: 'Courier' }).eq('id', freight.data!.id).select('id')).error).toBeNull();
  expect((await chart(o)).ofCategory(freight.data!.id).name).toBe('Delivery costs');

  // Archiving follows, both ways.
  expect((await o.c.from('finance_categories').update({ active: false }).eq('id', freight.data!.id).select('id')).error).toBeNull();
  expect((await o.c.from('finance_accounts').update({ active: false }).eq('id', savings.data!.id).select('id')).error).toBeNull();
  ch = await chart(o);
  expect(ch.ofCategory(freight.data!.id).active).toBe(false);
  expect(ch.ofBank(savings.data!.id).active).toBe(false);
  expect((await o.c.from('finance_accounts').update({ active: true }).eq('id', savings.data!.id).select('id')).error).toBeNull();
  expect((await chart(o)).ofBank(savings.data!.id).active).toBe(true);
});

// ---- 2 ------------------------------------------------------------------------

testWithSupabase('sales side: an invoice, part payment, a credit note and a refund each post one balanced entry; a void reverses one', async () => {
  const o = await ownerWithOrg(`Ledger sales ${Date.now()}`);
  const ch = await chart(o);
  const receivable = ch.system('receivable').id;
  const sst = ch.system('sst_payable').id;
  const sales = ch.ofCategory(o.sales).id;
  const bank = ch.ofBank(o.bank).id;

  // Invoice 132.50, of which 7.50 SST.
  const invoice = await postedInvoice(o);
  const invoiceLines = await expectEntry(o, `invoice:${invoice}`, [
    [receivable, 132.5, 0],
    [sales, 0, 125],
    [sst, 0, 7.5],
  ]);
  expect(invoiceLines[0]).toMatchObject({ source: 'invoice', source_id: invoice, source_no: 'INV-0001', entry_date: today() });
  expect(invoiceLines[0].description).toContain('INV-0001');

  // 100.00 received.
  const received = await o.c.rpc('finance_record_payment_in', {
    target_org: o.orgId,
    payment: { account_id: o.bank, txn_date: today(), method: 'fpx' },
    allocations: [{ invoice_id: invoice, amount: 100 }],
  });
  expect(received.error, received.error?.message).toBeNull();
  await expectEntry(o, `payment_in:${received.data}`, [
    [bank, 100, 0],
    [receivable, 0, 100],
  ]);

  // A credit note of 33.33. Its SST share is 33.33 x 7.50 / 132.50 = 1.8866..., which rounds to 1.89, and
  // the Sales line is the rest, 31.44: the two still add to 33.33.
  const note = await o.c.rpc('finance_save_credit_note', {
    target_org: o.orgId,
    note: { invoice_id: invoice, credit_date: today(), reason: 'returns', amount: 33.33 },
  });
  expect(note.error, note.error?.message).toBeNull();
  await expectNoEntry(o, `credit_note:${note.data}`);
  const issued = await o.c.rpc('finance_issue_credit_note', { target_org: o.orgId, target_note: note.data });
  expect(issued.error, issued.error?.message).toBeNull();
  await expectEntry(o, `credit_note:${note.data}`, [
    [sales, 31.44, 0],
    [sst, 1.89, 0],
    [receivable, 0, 33.33],
  ]);

  // The customer is now 0.83 in credit, and is refunded it.
  const refunded = await o.c.rpc('finance_record_refund', {
    target_org: o.orgId,
    refund: { credit_note_id: note.data, account_id: o.bank, txn_date: today(), method: 'fpx', reason: 'other', amount: 0.83 },
  });
  expect(refunded.error, refunded.error?.message).toBeNull();
  await expectEntry(o, `refund:${refunded.data}`, [
    [receivable, 0.83, 0],
    [bank, 0, 0.83],
  ]);
  let now = await balances(o);
  expect(now[receivable]).toBe(0);
  expect(now[bank]).toBe(sen(99.17));
  expect(now[sales]).toBe(sen(93.56));
  expect(now[sst]).toBe(sen(5.61));

  // The payment is voided: its entry stays and is reversed, the others stay, and the books still balance.
  expect(await voidRow(o, 'finance_transactions', received.data)).not.toBeNull();
  await expectVoided(o, `payment_in:${received.data}`, [
    [bank, 100, 0],
    [receivable, 0, 100],
  ]);
  const left = await books(o);
  expect(new Set(left.map((l) => l.entry_key))).toEqual(
    new Set([
      `invoice:${invoice}`,
      `credit_note:${note.data}`,
      `refund:${refunded.data}`,
      `payment_in:${received.data}`,
      `payment_in:${received.data}:void`,
    ]),
  );
  now = await balances(o);
  expect(now[receivable]).toBe(sen(100));
  expect(now[bank]).toBe(sen(-0.83));
});

// ---- 3 ------------------------------------------------------------------------

testWithSupabase('purchases side: bills by category, one payment for two bills, an expense and its payment, a voucher; nothing for what is not posted', async () => {
  const o = await ownerWithOrg(`Ledger purchases ${Date.now()}`);
  const ch = await chart(o);
  const payable = ch.system('payable').id;
  const accrued = ch.system('accrued_expenses').id;
  const rent = ch.ofCategory(o.rent).id;
  const purchases = ch.ofCategory(o.purchases).id;
  const bank = ch.ofBank(o.bank).id;

  // A bill with SST in a category of its own: the SST is part of the cost.
  const draft = await saveBill(o, { category_id: o.rent });
  expect(draft.error, draft.error?.message).toBeNull();
  await expectNoEntry(o, `bill:${draft.data}`);
  expect((await o.c.rpc('finance_post_bill', { target_org: o.orgId, target_bill: draft.data })).error).toBeNull();
  const billLines = await expectEntry(o, `bill:${draft.data}`, [
    [rent, 132.5, 0],
    [payable, 0, 132.5],
  ]);
  expect(billLines[0]).toMatchObject({ source: 'bill', source_no: 'BILL-0001' });
  // A second bill with no category given: Purchases.
  const second = await postedBill(o, {}, [TONER]);
  await expectEntry(o, `bill:${second}`, [
    [purchases, 200, 0],
    [payable, 0, 200],
  ]);

  // Both paid in one payment: one entry, one line each side.
  const paid = await payBills(o, [
    { bill_id: draft.data, amount: 132.5 },
    { bill_id: second, amount: 200 },
  ]);
  expect(paid.error, paid.error?.message).toBeNull();
  await expectEntry(o, `payment_out:${paid.data}`, [
    [payable, 332.5, 0],
    [bank, 0, 332.5],
  ]);
  expect((await balances(o))[payable]).toBe(0);

  // An expense, approved as the owner saves it, and its payment: owed on Accrued Expenses, not Accounts Payable.
  const expense = await o.c.rpc('finance_save_expense', {
    target_org: o.orgId,
    expense: { expense_date: today(), category_id: o.rent, vendor_name: 'Landlord', amount: 53, sst_amount: 3 },
  });
  expect(expense.error, expense.error?.message).toBeNull();
  await expectEntry(o, `expense:${expense.data}`, [
    [rent, 53, 0],
    [accrued, 0, 53],
  ]);
  const expensePaid = await o.c.rpc('finance_record_voucher', {
    target_org: o.orgId,
    voucher: { account_id: o.bank, txn_date: today(), method: 'fpx', party_name: 'Landlord', status: 'posted' },
    allocations: [{ expense_id: expense.data, amount: 53 }],
  });
  expect(expensePaid.error, expensePaid.error?.message).toBeNull();
  await expectEntry(o, `payment_out:${expensePaid.data}`, [
    [accrued, 53, 0],
    [bank, 0, 53],
  ]);

  // A payment voucher for a category: straight to the category.
  const voucher = await o.c.rpc('finance_record_voucher', {
    target_org: o.orgId,
    voucher: { account_id: o.bank, txn_date: today(), method: 'fpx', party_name: 'Water board', category_id: o.rent, amount: 40, status: 'posted' },
    allocations: [],
  });
  expect(voucher.error, voucher.error?.message).toBeNull();
  await expectEntry(o, `payment_out:${voucher.data}`, [
    [rent, 40, 0],
    [bank, 0, 40],
  ]);

  // A rejected expense and a scheduled payment produce nothing.
  const refused = await o.c.rpc('finance_save_expense', {
    target_org: o.orgId,
    expense: { expense_date: today(), category_id: o.rent, vendor_name: 'Landlord', amount: 77 },
  });
  expect(refused.error, refused.error?.message).toBeNull();
  expect((await o.c.from('finance_expenses').update({ status: 'rejected' }).eq('id', refused.data).select('id')).error).toBeNull();
  await expectNoEntry(o, `expense:${refused.data}`);
  const third = await postedBill(o);
  const scheduled = await payBills(o, [{ bill_id: third, amount: 132.5 }], 'scheduled');
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  await expectNothingFor(o, scheduled.data);

  let now = await balances(o);
  expect(now[payable]).toBe(sen(132.5));
  expect(now[accrued]).toBe(0);
  expect(now[rent]).toBe(sen(132.5 + 53 + 40));
  expect(now[purchases]).toBe(sen(200 + 132.5));
  expect(now[bank]).toBe(sen(-(332.5 + 53 + 40)));

  // A voided payment on posted bills: the bills stay in the books, and the payment is reversed.
  expect(await voidRow(o, 'finance_transactions', paid.data)).not.toBeNull();
  await expectVoided(o, `payment_out:${paid.data}`, [
    [payable, 332.5, 0],
    [bank, 0, 332.5],
  ]);
  await expectEntry(o, `bill:${second}`, [
    [purchases, 200, 0],
    [payable, 0, 200],
  ]);
  now = await balances(o);
  expect(now[payable]).toBe(sen(132.5 + 332.5));
  expect(now[bank]).toBe(sen(-(53 + 40)));
});

// ---- 4 ------------------------------------------------------------------------

testWithSupabase('cash, bank and opening balances: both signs of an opening balance, income into the till, a transfer as one entry', async () => {
  const o = await ownerWithOrg(`Ledger banking ${Date.now()}`);
  const overdraft = await o.c
    .from('finance_accounts')
    .insert({ org_id: o.orgId, name: 'Overdraft', kind: 'bank', opening_balance: -250.5, opening_date: today(-30) })
    .select('id')
    .single();
  expect(overdraft.error, overdraft.error?.message).toBeNull();
  expect((await o.c.from('finance_accounts').update({ opening_balance: 1000, opening_date: today(-30) }).eq('id', o.bank).select('id')).error).toBeNull();

  const ch = await chart(o);
  const opening = ch.system('opening_equity').id;
  const bank = ch.ofBank(o.bank).id;
  const till = ch.ofBank(o.till).id;
  const od = ch.ofBank(overdraft.data!.id).id;
  const sales = ch.ofCategory(o.sales).id;

  const positive = await expectEntry(o, `opening:${o.bank}`, [
    [bank, 1000, 0],
    [opening, 0, 1000],
  ]);
  expect(positive[0]).toMatchObject({ source: 'opening', entry_date: today(-30), source_id: o.bank });
  await expectEntry(o, `opening:${overdraft.data!.id}`, [
    [opening, 250.5, 0],
    [od, 0, 250.5],
  ]);
  // The till opened at zero: no entry.
  await expectNoEntry(o, `opening:${o.till}`);

  // Cash taken for income, with a category and no invoice.
  const receipt = await o.c.rpc('finance_save_cash_receipt', {
    target_org: o.orgId,
    receipt: { account_id: o.till, txn_date: today(), method: 'cash', amount: 75, party_name: 'Walk-in', category_id: o.sales },
    allocations: [],
  });
  expect(receipt.error, receipt.error?.message).toBeNull();
  await expectNoEntry(o, `payment_in:${receipt.data}`);
  expect((await o.c.rpc('finance_post_cash_receipt', { target_org: o.orgId, target_txn: receipt.data })).error).toBeNull();
  await expectEntry(o, `payment_in:${receipt.data}`, [
    [till, 75, 0],
    [sales, 0, 75],
  ]);

  // A transfer is one entry of two lines, and neither of its sides is a payment.
  const moved = await o.c.rpc('finance_record_transfer', {
    target_org: o.orgId,
    transfer: { from_account_id: o.bank, to_account_id: o.till, amount: 120, txn_date: today() },
  });
  expect(moved.error, moved.error?.message).toBeNull();
  const transferLines = await expectEntry(o, `transfer:${moved.data}`, [
    [till, 120, 0],
    [bank, 0, 120],
  ]);
  expect(transferLines[0]).toMatchObject({ source: 'transfer', source_id: moved.data, source_no: 'TR-0001' });
  const all = await books(o);
  expect(all.filter((l) => l.source === 'payment_in' || l.source === 'payment_out' || l.source === 'refund').map((l) => l.entry_key).sort()).toEqual(
    [`payment_in:${receipt.data}`, `payment_in:${receipt.data}`],
  );

  // The ledger and Banking agree on what is in each account.
  const ledger = await balances(o);
  const { data: banking } = await o.c.from('finance_account_balances').select('id, balance').eq('org_id', o.orgId);
  expect(banking).toHaveLength(3);
  for (const account of banking!) expect(ledger[ch.ofBank(account.id).id], account.id).toBe(sen(account.balance));
  expect(ledger[bank]).toBe(sen(880));
  expect(ledger[till]).toBe(sen(195));
  expect(ledger[od]).toBe(sen(-250.5));
  expect(ledger[opening]).toBe(sen(749.5));

  // Voided, the transfer stays in the books and is reversed.
  expect((await o.c.rpc('finance_void_transfer', { target_org: o.orgId, target_transfer: moved.data })).error).toBeNull();
  await expectVoided(o, `transfer:${moved.data}`, [
    [till, 120, 0],
    [bank, 0, 120],
  ]);
  const after = await expectBanksAgree(o);
  expect(after[bank]).toBe(sen(1000));
  expect(after[till]).toBe(sen(75));
});

// ---- 5 ------------------------------------------------------------------------

testWithSupabase('manual journals: must balance, owner or admin only, locked once posted, reversed once, logged', async () => {
  const o = await ownerWithOrg(`Ledger journals ${Date.now()}`);
  const other = await ownerWithOrg(`Ledger journals other ${Date.now()}`);
  const member = await join(o, 'member');
  const equipment = await ownAccount(o, '1500', 'Equipment');
  const equity = (await chart(o)).system('owner_equity').id;
  const balanced = [
    { account_id: equipment, debit: 500, note: 'Laptop' },
    { account_id: equity, credit: 500 },
  ];

  // A draft may be out of balance or unfinished; posting it is refused.
  const lopsided = await saveJournal(o, [{ account_id: equipment, debit: 500 }, { account_id: equity, credit: 400 }]);
  expect(lopsided.error, lopsided.error?.message).toBeNull();
  const id = lopsided.data as string;
  expect((await postJournal(o, id)).error?.code).toBe('FIN23');
  expect((await saveJournal(o, [{ account_id: equipment, debit: 500 }], { id })).error).toBeNull();
  expect((await postJournal(o, id)).error?.code).toBe('FIN24');
  // Posting by hand is held to the same: a number is needed, and the same checks follow.
  expect((await o.c.from('finance_journals').update({ status: 'posted' }).eq('id', id).select('id')).error?.code).toBe('FIN01');
  expect((await o.c.from('finance_journals').update({ status: 'posted', journal_no: 'JV-9999' }).eq('id', id).select('id')).error?.code).toBe('FIN24');
  // A line with both sides, or neither, is no line.
  expect((await saveJournal(o, [{ account_id: equipment, debit: 5, credit: 5 }, { account_id: equity }], { id })).error?.code).toBe('23514');

  // Another workspace's account, and an archived one, take no lines.
  const theirs = (await chart(other)).system('owner_equity').id;
  expect(['FIN24', '23503']).toContain((await saveJournal(o, [{ account_id: equipment, debit: 1 }, { account_id: theirs, credit: 1 }])).error?.code);
  const old = await ownAccount(o, '1510', 'Old machine');
  expect((await o.c.from('finance_ledger_accounts').update({ active: false }).eq('id', old).select('id')).error).toBeNull();
  expect((await saveJournal(o, [{ account_id: old, debit: 1 }, { account_id: equity, credit: 1 }])).error?.code).toBe('FIN24');

  // A member neither writes nor posts, and does not see a draft.
  expect((await saveJournal(member, balanced)).error?.code).toBe('FIN14');
  expect((await postJournal(member, id)).error?.code).toBe('FIN14');
  expect((await reverseJournal(member, id)).error?.code).toBe('FIN14');
  const byHand = await member.c.from('finance_journals').insert({ org_id: o.orgId, description: 'By hand' }).select('id');
  expect(byHand.error?.code).toBe('42501');
  expect((await member.c.from('finance_journals').select('id').eq('id', id)).data).toEqual([]);
  expect((await member.c.from('finance_journal_lines').select('id').eq('journal_id', id)).data).toEqual([]);
  expect((await o.c.from('finance_journals').select('id').eq('id', id)).data).toHaveLength(1);
  // A draft is not in the books, and cannot be reversed.
  await expectNoEntry(o, `journal:${id}`);
  expect((await reverseJournal(o, id)).error?.code).toBe('FIN01');

  // Put right, it posts and takes its number.
  expect((await saveJournal(o, balanced, { id })).error).toBeNull();
  const posted = await postJournal(o, id);
  expect(posted.error, posted.error?.message).toBeNull();
  expect(posted.data).toBe('JV-0001');
  const stored = await o.c.from('finance_journals').select('status, journal_no, posted_by, created_by').eq('id', id).single();
  expect(stored.data).toMatchObject({ status: 'posted', journal_no: 'JV-0001', posted_by: o.userId, created_by: o.userId });
  const lines = await expectEntry(o, `journal:${id}`, [
    [equipment, 500, 0],
    [equity, 0, 500],
  ]);
  expect(lines[0]).toMatchObject({ source: 'journal', source_no: 'JV-0001', description: 'Bought equipment' });
  // The member reads it now, in the table and in the ledger.
  expect((await member.c.from('finance_journals').select('id').eq('id', id)).data).toHaveLength(1);
  expect((await member.c.from('finance_journal_lines').select('id').eq('journal_id', id)).data).toHaveLength(2);
  expect((await books(member)).filter((l) => l.entry_key === `journal:${id}`)).toHaveLength(2);

  // Posted: locked, lines included, and not deleted.
  expect((await postJournal(o, id)).error?.code).toBe('FIN01');
  expect((await saveJournal(o, balanced, { id })).error?.code).toBe('FIN01');
  expect((await o.c.from('finance_journals').update({ description: 'Changed' }).eq('id', id).select('id')).error?.code).toBe('FIN01');
  expect((await o.c.from('finance_journal_lines').update({ note: 'Changed' }).eq('journal_id', id).select('id')).error?.code).toBe('FIN01');
  expect((await o.c.from('finance_journal_lines').delete().eq('journal_id', id).select('id')).error?.code).toBe('FIN01');
  const extra = await o.c.from('finance_journal_lines').insert({ org_id: o.orgId, journal_id: id, account_id: equipment, debit: 1 }).select('id');
  expect(extra.error?.code).toBe('FIN01');
  expect((await o.c.from('finance_journals').delete().eq('id', id).select('id')).error?.code).toBe('FIN01');

  // Reversed: a draft with the sides swapped, once.
  const reversal = await reverseJournal(o, id);
  expect(reversal.error, reversal.error?.message).toBeNull();
  const draft = await o.c.from('finance_journals').select('status, reverses_journal_id, description, journal_no').eq('id', reversal.data).single();
  expect(draft.data).toEqual({ status: 'draft', reverses_journal_id: id, description: 'Reversal of JV-0001: Bought equipment', journal_no: null });
  expect((await reverseJournal(o, id)).error?.code).toBe('FIN27');
  const second = await o.c.from('finance_journals').insert({ org_id: o.orgId, description: 'Second reversal', reverses_journal_id: id }).select('id');
  expect(second.error?.code).toBe('23505');
  expect((await postJournal(o, reversal.data)).data).toBe('JV-0002');
  await expectEntry(o, `journal:${reversal.data}`, [
    [equipment, 0, 500],
    [equity, 500, 0],
  ]);
  const now = await balances(o);
  expect(now[equipment]).toBe(0);
  expect(now[equity]).toBe(0);
  expect((await reverseJournal(o, id)).error?.code).toBe('FIN27');

  // Both are in the activity log, by the database.
  const { data: log, error: logErr } = await member.c
    .from('activity_log')
    .select('action, target, actor_id')
    .eq('org_id', o.orgId)
    .like('action', '%journal%')
    .order('created_at', { ascending: true });
  expect(logErr, logErr?.message).toBeNull();
  expect(log!.map((e) => `${e.action} | ${e.target}`)).toEqual([
    'Posted a journal | JV-0001',
    'Reversed a journal | JV-0001, with JV-0002',
  ]);
  expect(log![0].actor_id).toBe(o.userId);
});

// ---- 6 ------------------------------------------------------------------------

testWithSupabase('the chart: an owner adds, renames and recodes; what an account stands for is fixed; a used account stays', async () => {
  const o = await ownerWithOrg(`Ledger accounts ${Date.now()}`);
  const member = await join(o, 'member');
  const ch = await chart(o);

  const refused = await member.c.from('finance_ledger_accounts').insert({ org_id: o.orgId, code: '1500', name: 'Equipment', type: 'asset' }).select('id');
  expect(refused.error?.code).toBe('42501');
  const equipment = await ownAccount(o, '1500', 'Equipment');
  const renamed = await o.c.from('finance_ledger_accounts').update({ name: 'Plant and equipment', code: '1550' }).eq('id', equipment).select('code, name').single();
  expect(renamed.data).toEqual({ code: '1550', name: 'Plant and equipment' });
  // A member reads the chart and changes nothing in it.
  expect((await member.c.from('finance_ledger_accounts').select('id').eq('id', equipment)).data).toHaveLength(1);
  expect((await member.c.from('finance_ledger_accounts').update({ name: 'Mine' }).eq('id', equipment).select('id')).data).toEqual([]);

  // A code and a name are each used once.
  const sameCode = await o.c.from('finance_ledger_accounts').insert({ org_id: o.orgId, code: '1200', name: 'Deposits', type: 'asset' }).select('id');
  expect(sameCode.error?.code).toBe('23505');
  const sameName = await o.c.from('finance_ledger_accounts').insert({ org_id: o.orgId, code: '1560', name: 'accounts receivable', type: 'asset' }).select('id');
  expect(sameName.error?.code).toBe('23505');
  expect((await o.c.from('finance_ledger_accounts').insert({ org_id: o.orgId, code: '12345678901', name: 'Long code', type: 'asset' }).select('id')).error?.code).toBe('23514');

  // What an account stands for, and its type, do not change; nor is a linked account made by hand.
  expect((await o.c.from('finance_ledger_accounts').update({ type: 'expense' }).eq('id', equipment).select('id')).error?.code).toBe('FIN25');
  expect((await o.c.from('finance_ledger_accounts').update({ category_id: o.rent, type: 'expense' }).eq('id', equipment).select('id')).error?.code).toBe('FIN25');
  expect((await o.c.from('finance_ledger_accounts').update({ default_for: null }).eq('id', ch.ofCategory(o.sales).id).select('id')).error?.code).toBe('FIN25');
  const forged = await o.c.from('finance_ledger_accounts').insert({ org_id: o.orgId, code: '1570', name: 'Second receivable', type: 'asset', system_key: 'receivable' }).select('id');
  expect(forged.error?.code).toBe('FIN25');
  // A system account is renamed and recoded like any other.
  expect((await o.c.from('finance_ledger_accounts').update({ name: 'Trade debtors', code: '1210' }).eq('id', ch.system('receivable').id).select('id')).error).toBeNull();

  // A system, bank or category account is not deleted.
  for (const account of [ch.system('receivable'), ch.ofBank(o.bank), ch.ofCategory(o.rent)]) {
    expect((await o.c.from('finance_ledger_accounts').delete().eq('id', account.id).select('id')).error?.code, account.name).toBe('FIN25');
  }
  // The category invoices post to is kept; another unused category goes, and takes its account with it.
  expect((await o.c.from('finance_categories').delete().eq('id', o.sales).select('id')).error?.code).toBe('FIN25');
  const { data: travel } = await o.c.from('finance_categories').select('id').eq('org_id', o.orgId).eq('name', 'Travel').single();
  const gone = await o.c.from('finance_categories').delete().eq('id', travel!.id).select('id');
  expect(gone.error, gone.error?.message).toBeNull();
  expect((await chart(o)).rows.filter((a) => a.category_id === travel!.id)).toEqual([]);
  // A category keeps its kind.
  expect((await o.c.from('finance_categories').update({ kind: 'income' }).eq('id', o.rent).select('id')).error?.code).toBe('FIN25');

  // An account of the workspace's own: deleted while unused, kept once a journal line uses it, draft or posted.
  const spare = await ownAccount(o, '1600', 'Spare');
  const journal = await saveJournal(o, [
    { account_id: equipment, debit: 10 },
    { account_id: ch.system('owner_equity').id, credit: 10 },
  ]);
  expect(journal.error, journal.error?.message).toBeNull();
  expect((await o.c.from('finance_ledger_accounts').delete().eq('id', equipment).select('id')).error?.code).toBe('FIN25');
  expect((await postJournal(o, journal.data)).error).toBeNull();
  expect((await o.c.from('finance_ledger_accounts').delete().eq('id', equipment).select('id')).error?.code).toBe('FIN25');
  // Archived instead, it keeps its lines.
  expect((await o.c.from('finance_ledger_accounts').update({ active: false }).eq('id', equipment).select('id')).error).toBeNull();
  expect((await books(o)).filter((l) => l.account_id === equipment)).toHaveLength(1);
  const deleted = await o.c.from('finance_ledger_accounts').delete().eq('id', spare).select('id');
  expect(deleted.error, deleted.error?.message).toBeNull();
  expect(deleted.data).toHaveLength(1);
});

// ---- 7 ------------------------------------------------------------------------

testWithSupabase('a bill has a category: Purchases unless one is given, an expense category only, kept by a save that does not send it, locked once posted', async () => {
  const o = await ownerWithOrg(`Ledger bill category ${Date.now()}`);
  const categoryOf = async (id: string) =>
    (await o.c.from('supplier_bills').select('category_id').eq('id', id).single()).data?.category_id as string;

  const plain = await saveBill(o);
  expect(plain.error, plain.error?.message).toBeNull();
  expect(await categoryOf(plain.data)).toBe(o.purchases);
  // An empty value is no category given.
  const empty = await saveBill(o, { category_id: '' });
  expect(await categoryOf(empty.data)).toBe(o.purchases);
  // So does a bill inserted by hand.
  const byHand = await o.c
    .from('supplier_bills')
    .insert({ org_id: o.orgId, supplier_id: o.supplier, bill_date: today(), due_date: today(30) })
    .select('category_id')
    .single();
  expect(byHand.error, byHand.error?.message).toBeNull();
  expect(byHand.data?.category_id).toBe(o.purchases);

  // An income category is refused, on a new bill and on a draft.
  expect((await saveBill(o, { category_id: o.sales })).error?.code).toBe('FIN26');
  expect((await saveBill(o, { id: plain.data, category_id: o.sales })).error?.code).toBe('FIN26');
  expect((await o.c.from('supplier_bills').update({ category_id: o.sales }).eq('id', plain.data).select('id')).error?.code).toBe('FIN26');
  // One that does not exist is the foreign key's to refuse.
  expect((await saveBill(o, { category_id: crypto.randomUUID() })).error?.code).toBe('23503');

  // A category given is kept by a save that does not send the key.
  expect((await saveBill(o, { id: plain.data, category_id: o.rent })).error).toBeNull();
  expect(await categoryOf(plain.data)).toBe(o.rent);
  expect((await saveBill(o, { id: plain.data }, [TONER])).error).toBeNull();
  expect(await categoryOf(plain.data)).toBe(o.rent);

  // Posted: the category is locked with everything else.
  expect((await o.c.rpc('finance_post_bill', { target_org: o.orgId, target_bill: plain.data })).error).toBeNull();
  expect((await saveBill(o, { id: plain.data, category_id: o.purchases })).error?.code).toBe('FIN01');
  expect((await o.c.from('supplier_bills').update({ category_id: o.purchases }).eq('id', plain.data).select('id')).error?.code).toBe('FIN01');
  expect((await o.c.from('supplier_bills').update({ status: 'void', category_id: o.purchases }).eq('id', plain.data).select('id')).error?.code).toBe('FIN01');
  expect(await categoryOf(plain.data)).toBe(o.rent);

  // A bill made from a purchase order starts as Purchases.
  const order = await o.c.rpc('finance_save_purchase_order', {
    target_org: o.orgId,
    purchase_order: { supplier_id: o.supplier, po_date: today() },
    lines: [PAPER],
  });
  expect(order.error, order.error?.message).toBeNull();
  expect((await o.c.rpc('finance_submit_purchase_order', { target_org: o.orgId, target_po: order.data })).error).toBeNull();
  const approved = await o.c.rpc('finance_decide_purchase_order', { target_org: o.orgId, target_po: order.data, approve: true, reason: null });
  expect(approved.error, approved.error?.message).toBeNull();
  const fromOrder = await saveBill(o, { purchase_order_id: order.data });
  expect(fromOrder.error, fromOrder.error?.message).toBeNull();
  expect(await categoryOf(fromOrder.data)).toBe(o.purchases);
});

// ---- 8 ------------------------------------------------------------------------

testWithSupabase('two workspaces: neither reads the other’s accounts, ledger or journals, nor points at them', async () => {
  const a = await ownerWithOrg(`Ledger tenant A ${Date.now()}`);
  const b = await ownerWithOrg(`Ledger tenant B ${Date.now()}`);
  const aChart = await chart(a);
  const bChart = await chart(b);
  await postedInvoice(a);
  const aJournal = await saveJournal(a, [
    { account_id: aChart.ofBank(a.bank).id, debit: 900 },
    { account_id: aChart.system('owner_equity').id, credit: 900 },
  ]);
  expect((await postJournal(a, aJournal.data)).error).toBeNull();
  expect((await books(a)).length).toBeGreaterThan(0);

  for (const table of ['finance_ledger_accounts', 'finance_ledger_lines', 'finance_ledger_balances', 'finance_journals', 'finance_journal_lines']) {
    const seen = await b.c.from(table).select('org_id').eq('org_id', a.orgId);
    expect(seen.data, table).toEqual([]);
  }
  // B's own ledger has nothing of A's in it.
  expect(await books(b)).toEqual([]);

  // B cannot act in A's workspace.
  expect((await saveJournal({ ...b, orgId: a.orgId }, [])).error?.code).toBe('FIN14');
  expect((await b.c.rpc('finance_post_journal', { target_org: a.orgId, target_journal: aJournal.data })).error?.code).toBe('FIN14');
  expect((await b.c.rpc('finance_reverse_journal', { target_org: a.orgId, target_journal: aJournal.data, reversal_date: today() })).error?.code).toBe('FIN14');
  // ...nor reverse A's journal as one of its own.
  expect((await reverseJournal(b, aJournal.data)).error?.code).toBe('FIN11');
  const intoA = await b.c.from('finance_ledger_accounts').insert({ org_id: a.orgId, code: '1500', name: 'Planted', type: 'asset' }).select('id');
  expect(intoA.error?.code).toBe('42501');
  expect((await b.c.from('finance_ledger_accounts').update({ name: 'Taken' }).eq('org_id', a.orgId).select('id')).data).toEqual([]);

  // B's own records cannot point at A's: a journal line on A's account, a bill in A's category.
  const crossLine = await saveJournal(b, [
    { account_id: aChart.system('owner_equity').id, debit: 1 },
    { account_id: bChart.system('owner_equity').id, credit: 1 },
  ]);
  expect(['FIN24', '23503']).toContain(crossLine.error?.code);
  const crossBill = await saveBill(b, { category_id: a.rent });
  expect(['FIN26', '23503']).toContain(crossBill.error?.code);
});

// ---- 9 ------------------------------------------------------------------------

testWithSupabase('accrued expenses: an approved expense is owed on its own account, and Accounts Payable is what is owed on bills', async () => {
  const o = await ownerWithOrg(`Ledger accruals ${Date.now()}`);
  const ch = await chart(o);
  const payable = ch.system('payable').id;
  const accrued = ch.system('accrued_expenses').id;
  expect(ch.system('accrued_expenses')).toMatchObject({ code: '2050', name: 'Accrued Expenses', type: 'liability' });
  const rent = ch.ofCategory(o.rent).id;
  const purchases = ch.ofCategory(o.purchases).id;
  const bank = ch.ofBank(o.bank).id;

  // Approved: its category is debited, Accrued Expenses is credited, and Accounts Payable is not touched.
  const expense = await saveExpense(o, 53);
  expect(expense.error, expense.error?.message).toBeNull();
  await expectEntry(o, `expense:${expense.data}`, [
    [rent, 53, 0],
    [accrued, 0, 53],
  ]);
  let now = await balances(o);
  expect(now[accrued]).toBe(sen(53));
  expect(now[payable]).toBe(0);
  expect((await books(o)).filter((l) => l.account_id === payable)).toEqual([]);

  // A bill in the same workspace: each account reads what is owed on its own kind of document.
  const bill = await postedBill(o);
  await expectEntry(o, `bill:${bill}`, [
    [purchases, 132.5, 0],
    [payable, 0, 132.5],
  ]);
  now = await balances(o);
  expect(now[payable]).toBe(sen(132.5));
  expect(now[payable]).toBe(await owedOnBills(o));
  expect(now[accrued]).toBe(sen(53));
  expect(now[accrued]).toBe(await owedOnExpenses(o));

  // Part of the expense is paid: off Accrued Expenses, out of the bank.
  const part = await payExpenses(o, [{ expense_id: expense.data, amount: 20 }]);
  expect(part.error, part.error?.message).toBeNull();
  await expectEntry(o, `payment_out:${part.data}`, [
    [accrued, 20, 0],
    [bank, 0, 20],
  ]);
  now = await balances(o);
  expect(now[accrued]).toBe(sen(33));
  expect(now[accrued]).toBe(await owedOnExpenses(o));
  expect(now[payable]).toBe(sen(132.5));

  // Part of the bill is paid: off Accounts Payable, and Accrued Expenses is not touched.
  const billPart = await payBills(o, [{ bill_id: bill, amount: 32.5 }]);
  expect(billPart.error, billPart.error?.message).toBeNull();
  await expectEntry(o, `payment_out:${billPart.data}`, [
    [payable, 32.5, 0],
    [bank, 0, 32.5],
  ]);
  now = await balances(o);
  expect(now[payable]).toBe(sen(100));
  expect(now[payable]).toBe(await owedOnBills(o));
  expect(now[accrued]).toBe(sen(33));

  // The rest of the expense is paid: Accrued Expenses is back to zero, and the bill is still owed.
  const rest = await payExpenses(o, [{ expense_id: expense.data, amount: 33 }]);
  expect(rest.error, rest.error?.message).toBeNull();
  await expectEntry(o, `payment_out:${rest.data}`, [
    [accrued, 33, 0],
    [bank, 0, 33],
  ]);
  now = await expectBanksAgree(o);
  expect(now[accrued]).toBe(0);
  expect(await owedOnExpenses(o)).toBe(0);
  expect(now[payable]).toBe(sen(100));
  expect(now[payable]).toBe(await owedOnBills(o));
  expect(now[rent]).toBe(sen(53));
  expect(now[bank]).toBe(sen(-(20 + 32.5 + 33)));

  // A voided payment of an expense is reversed on Accrued Expenses, and the expense is owed again.
  expect(await voidRow(o, 'finance_transactions', rest.data)).not.toBeNull();
  await expectVoided(o, `payment_out:${rest.data}`, [
    [accrued, 33, 0],
    [bank, 0, 33],
  ]);
  now = await expectBanksAgree(o);
  expect(now[accrued]).toBe(sen(33));
  expect(now[accrued]).toBe(await owedOnExpenses(o));
  expect(now[payable]).toBe(sen(100));
});

// ---- 10 -----------------------------------------------------------------------

testWithSupabase('a voided bill keeps its entry and gains a reversal dated the day it was voided; voided_at is the database’s to write', async () => {
  const o = await ownerWithOrg(`Ledger void bill ${Date.now()}`);
  const ch = await chart(o);
  const payable = ch.system('payable').id;
  const rent = ch.ofCategory(o.rent).id;
  const voidedAt = async (id: string) =>
    (await o.c.from('supplier_bills').select('voided_at').eq('id', id).single()).data?.voided_at as string | null;
  const stamp = new Date().toISOString();

  // A draft: voided_at is not a column a person sets. Sent on an insert or an update, it is left empty.
  const byHand = await o.c
    .from('supplier_bills')
    .insert({ org_id: o.orgId, supplier_id: o.supplier, bill_date: today(), due_date: today(30), voided_at: stamp })
    .select('id, voided_at')
    .single();
  expect(byHand.error, byHand.error?.message).toBeNull();
  expect(byHand.data?.voided_at).toBeNull();
  const edited = await o.c.from('supplier_bills').update({ voided_at: stamp }).eq('id', byHand.data!.id).select('voided_at');
  expect(edited.error, edited.error?.message).toBeNull();
  expect(edited.data).toEqual([{ voided_at: null }]);

  // Posted three days ago: one entry, on the bill's own date.
  const bill = await postedBill(o, { category_id: o.rent, bill_date: today(-3) });
  const want: [string, number, number][] = [
    [rent, 132.5, 0],
    [payable, 0, 132.5],
  ];
  const before = await expectEntry(o, `bill:${bill}`, want);
  expect(before.every((l) => l.entry_date === today(-3))).toBe(true);
  await expectNoEntry(o, `bill:${bill}:void`);
  expect((await books(o)).map((l) => l.entry_key).sort()).toEqual([`bill:${bill}`, `bill:${bill}`]);
  expect(await voidedAt(bill)).toBeNull();

  // Posted: the guard refuses voided_at by hand like any other change, alone or along with a void.
  expect((await o.c.from('supplier_bills').update({ voided_at: stamp }).eq('id', bill).select('id')).error?.code).toBe('FIN01');
  expect((await o.c.from('supplier_bills').update({ status: 'void', voided_at: stamp }).eq('id', bill).select('id')).error?.code).toBe('FIN01');
  expect(await voidedAt(bill)).toBeNull();
  await expectNoEntry(o, `bill:${bill}:void`);

  // Voided: the database says when.
  const startedAt = Date.now();
  const stamped = await voidRow(o, 'supplier_bills', bill);
  expect(stamped).not.toBeNull();
  expect(Math.abs(new Date(stamped!).getTime() - startedAt)).toBeLessThan(5 * 60 * 1000);

  // The original entry is as it was, on its own date; the reversal is the same lines the other way round, today.
  const original = await expectVoided(o, `bill:${bill}`, want);
  expect(original.every((l) => l.entry_date === today(-3))).toBe(true);
  expect(original[0]).toMatchObject({ source: 'bill', source_id: bill, source_no: 'BILL-0001' });
  const all = await books(o);
  expect(all.map((l) => l.entry_key).sort()).toEqual([`bill:${bill}`, `bill:${bill}`, `bill:${bill}:void`, `bill:${bill}:void`]);
  const reversal = all.filter((l) => l.entry_key === `bill:${bill}:void`);
  expect(reversal.every((l) => l.description.startsWith('Voided: Bill BILL-0001'))).toBe(true);
  expect(reversal.find((l) => l.account_id === payable)).toMatchObject({ entry_date: today(), source: 'bill', source_id: bill });
  expect(sen(reversal.find((l) => l.account_id === payable)!.debit)).toBe(sen(132.5));
  expect(sen(reversal.find((l) => l.account_id === rent)!.credit)).toBe(sen(132.5));

  // Both accounts are back to nothing, and nothing is owed.
  const now = await balances(o);
  expect(now[payable]).toBe(0);
  expect(now[rent]).toBe(0);
  expect(await owedOnBills(o)).toBe(0);

  // Once void, voided_at is not cleared or moved.
  expect((await o.c.from('supplier_bills').update({ voided_at: null }).eq('id', bill).select('id')).error?.code).toBe('FIN01');
  expect((await o.c.from('supplier_bills').update({ voided_at: stamp }).eq('id', bill).select('id')).error?.code).toBe('FIN01');
  expect(await voidedAt(bill)).toBe(stamped);
});

// ---- 11 -----------------------------------------------------------------------

testWithSupabase('a voided payment is reversed and its bill is owed again; a scheduled payment that is deleted leaves nothing', async () => {
  const o = await ownerWithOrg(`Ledger void payment ${Date.now()}`);
  const ch = await chart(o);
  const payable = ch.system('payable').id;
  const bank = ch.ofBank(o.bank).id;

  const bill = await postedBill(o);
  const paid = await payBills(o, [{ bill_id: bill, amount: 132.5 }]);
  expect(paid.error, paid.error?.message).toBeNull();
  let now = await expectBanksAgree(o);
  expect(now[payable]).toBe(0);
  expect(await owedOnBills(o)).toBe(0);
  expect(now[bank]).toBe(sen(-132.5));

  // On a payment nobody signed in may even name the column.
  expect((await o.c.from('finance_transactions').update({ voided_at: new Date().toISOString() }).eq('id', paid.data).select('id')).error?.code).toBe('42501');

  // Voided: the payment's entry stays, a reversal joins it, and the bill is owed again.
  expect(await voidRow(o, 'finance_transactions', paid.data)).not.toBeNull();
  const original = await expectVoided(o, `payment_out:${paid.data}`, [
    [payable, 132.5, 0],
    [bank, 0, 132.5],
  ]);
  expect(original[0]).toMatchObject({ source: 'payment_out', source_id: paid.data, source_no: 'PV-0001' });
  now = await expectBanksAgree(o);
  expect(now[payable]).toBe(sen(132.5));
  expect(now[payable]).toBe(await owedOnBills(o));
  expect(now[bank]).toBe(0);

  // A scheduled payment is not in the books. It cannot be voided, only deleted, and then it leaves no
  // entry and no reversal.
  const scheduled = await payBills(o, [{ bill_id: bill, amount: 132.5 }], 'scheduled');
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  await expectNothingFor(o, scheduled.data);
  expect((await o.c.from('finance_transactions').update({ status: 'void' }).eq('id', scheduled.data).select('id')).error?.code).toBe('FIN09');
  await expectNothingFor(o, scheduled.data);
  const deleted = await o.c.from('finance_transactions').delete().eq('id', scheduled.data).select('id');
  expect(deleted.error, deleted.error?.message).toBeNull();
  expect(deleted.data).toHaveLength(1);
  await expectNothingFor(o, scheduled.data);
  expect(new Set((await books(o)).map((l) => l.entry_key))).toEqual(
    new Set([`bill:${bill}`, `payment_out:${paid.data}`, `payment_out:${paid.data}:void`]),
  );
  now = await expectBanksAgree(o);
  expect(now[payable]).toBe(await owedOnBills(o));
});

// ---- 12 -----------------------------------------------------------------------

testWithSupabase('a voided credit note and a voided invoice are each reversed, and Accounts Receivable ends at nothing', async () => {
  const o = await ownerWithOrg(`Ledger void sales ${Date.now()}`);
  const ch = await chart(o);
  const receivable = ch.system('receivable').id;
  const sst = ch.system('sst_payable').id;
  const sales = ch.ofCategory(o.sales).id;

  // Invoice 132.50, of which 7.50 SST, and a credit note of 32.50 on it: its SST share is
  // 32.50 x 7.50 / 132.50 = 1.8396..., which rounds to 1.84, and Sales takes the rest, 30.66.
  const invoice = await postedInvoice(o);
  const note = await o.c.rpc('finance_save_credit_note', {
    target_org: o.orgId,
    note: { invoice_id: invoice, credit_date: today(), reason: 'returns', amount: 32.5 },
  });
  expect(note.error, note.error?.message).toBeNull();
  expect((await o.c.rpc('finance_issue_credit_note', { target_org: o.orgId, target_note: note.data })).error).toBeNull();
  const invoiceLines: [string, number, number][] = [
    [receivable, 132.5, 0],
    [sales, 0, 125],
    [sst, 0, 7.5],
  ];
  const noteLines: [string, number, number][] = [
    [sales, 30.66, 0],
    [sst, 1.84, 0],
    [receivable, 0, 32.5],
  ];
  await expectEntry(o, `invoice:${invoice}`, invoiceLines);
  await expectEntry(o, `credit_note:${note.data}`, noteLines);
  let now = await balances(o);
  expect(now[receivable]).toBe(sen(100));
  expect(now[receivable]).toBe(await owedOnInvoices(o));

  // The invoice is not voided while its credit note stands: the credit note goes first.
  expect((await o.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice).select('id')).error?.code).toBe('FIN12');
  await expectNoEntry(o, `invoice:${invoice}:void`);

  expect(await voidRow(o, 'finance_credit_notes', note.data)).not.toBeNull();
  await expectVoided(o, `credit_note:${note.data}`, noteLines);
  now = await balances(o);
  expect(now[receivable]).toBe(sen(132.5));
  expect(now[receivable]).toBe(await owedOnInvoices(o));
  expect(now[sales]).toBe(sen(125));
  expect(now[sst]).toBe(sen(7.5));

  expect(await voidRow(o, 'finance_invoices', invoice)).not.toBeNull();
  const original = await expectVoided(o, `invoice:${invoice}`, invoiceLines);
  expect(original[0]).toMatchObject({ source: 'invoice', source_id: invoice, source_no: 'INV-0001' });
  // The voided credit note's two entries are still the same numbers now that its invoice is void too.
  await expectVoided(o, `credit_note:${note.data}`, noteLines);
  expect(new Set((await books(o)).map((l) => l.entry_key))).toEqual(
    new Set([`invoice:${invoice}`, `invoice:${invoice}:void`, `credit_note:${note.data}`, `credit_note:${note.data}:void`]),
  );
  now = await balances(o);
  expect(now[receivable]).toBe(0);
  expect(await owedOnInvoices(o)).toBe(0);
  expect(now[sales]).toBe(0);
  expect(now[sst]).toBe(0);
});

// ---- 13 -----------------------------------------------------------------------

testWithSupabase('a voided transfer is one entry and one reversal, and both accounts agree with Banking', async () => {
  const o = await ownerWithOrg(`Ledger void transfer ${Date.now()}`);
  const ch = await chart(o);
  const bank = ch.ofBank(o.bank).id;
  const till = ch.ofBank(o.till).id;

  const moved = await o.c.rpc('finance_record_transfer', {
    target_org: o.orgId,
    transfer: { from_account_id: o.bank, to_account_id: o.till, amount: 120, txn_date: today(-2) },
  });
  expect(moved.error, moved.error?.message).toBeNull();
  const want: [string, number, number][] = [
    [till, 120, 0],
    [bank, 0, 120],
  ];
  await expectEntry(o, `transfer:${moved.data}`, want);
  let now = await expectBanksAgree(o);
  expect(now[bank]).toBe(sen(-120));
  expect(now[till]).toBe(sen(120));

  expect((await o.c.rpc('finance_void_transfer', { target_org: o.orgId, target_transfer: moved.data })).error).toBeNull();
  // Both sides were voided by one statement, so they carry one time.
  const { data: sides } = await o.c.from('finance_transactions').select('status, voided_at').eq('transfer_id', moved.data);
  expect(sides).toHaveLength(2);
  expect(sides!.every((x) => x.status === 'void' && x.voided_at !== null)).toBe(true);
  expect(sides![0].voided_at).toBe(sides![1].voided_at);

  // One original entry of two lines on the transfer's own date, and one reversal of two lines today.
  const original = await expectVoided(o, `transfer:${moved.data}`, want);
  expect(original.every((l) => l.entry_date === today(-2))).toBe(true);
  expect(original[0]).toMatchObject({ source: 'transfer', source_id: moved.data, source_no: 'TR-0001' });
  const all = await books(o);
  expect(all.map((l) => l.entry_key).sort()).toEqual([
    `transfer:${moved.data}`,
    `transfer:${moved.data}`,
    `transfer:${moved.data}:void`,
    `transfer:${moved.data}:void`,
  ]);
  // Neither side of a transfer, voided or not, is a payment.
  expect(all.filter((l) => l.source !== 'transfer')).toEqual([]);
  now = await expectBanksAgree(o);
  expect(now[bank]).toBe(0);
  expect(now[till]).toBe(0);
});
