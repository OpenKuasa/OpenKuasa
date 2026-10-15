import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { CONTRA_MESSAGES as M, deleteContra, listContras, postContra, saveContra, voidContra } from '@/lib/finance/contras';
import { listLedgerAccounts, listLedgerLines } from '@/lib/finance/ledger';
import { cashMovements } from '@/lib/finance/reports';
import type { FinanceWriteContext } from '@/lib/finance/result';

// Contra entries (20261119100000) against the live project: a contra settles an invoice and a bill without
// moving a bank balance, Banking or the Cash Flow; its void is reversed in the books on the day it was voided.
// Every contra is written through src/lib/finance/contras.ts, the screen's own data layer. Each test makes its
// own workspace; the helper deletes what it made when the file finishes. Run by the controller only, after the
// migration is applied.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Who = { c: SupabaseClient; ctx: FinanceWriteContext; orgId: string; bank: string; both: string; customerOnly: string };

async function ownerWithOrg(orgName: string): Promise<Who> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const { data: accounts } = await c.from('finance_accounts').select('id, kind').eq('org_id', orgId);
  const { data: contacts, error: contactErr } = await c
    .from('finance_contacts')
    .insert([
      { org_id: orgId, name: `Both of ${orgName}`, is_customer: true, is_supplier: true },
      { org_id: orgId, name: `Customer of ${orgName}`, is_customer: true, is_supplier: false },
    ])
    .select('id, is_supplier');
  expect(contactErr, contactErr?.message).toBeNull();
  return {
    c,
    ctx: { client: c, orgId: orgId as string },
    orgId: orgId as string,
    bank: accounts!.find((a) => a.kind === 'bank')!.id as string,
    both: contacts!.find((x) => x.is_supplier)!.id as string,
    customerOnly: contacts!.find((x) => !x.is_supplier)!.id as string,
  };
}

async function join(o: Who, role: 'admin' | 'member'): Promise<Who> {
  const c = liveClient();
  const signUp = await createConfirmedTestUser(c, `contra-${role}-pass-123`);
  const invite = await o.c.rpc('create_invite', { p_email: signUp.email, p_role: role });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await c.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  return { ...o, c, ctx: { client: c, orgId: o.orgId } };
}

function today(offset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const sen = (n: unknown) => Math.round(Number(n) * 100);
const PAPER = { description: 'A4 paper', quantity: 10, unit_price: 12.5, sst_rate: 6 }; // 132.50
const TONER = { description: 'Toner', quantity: 2, unit_price: 100, sst_rate: 0 }; // 200.00

async function postedInvoice(o: Who, customer = o.both, lines: object[] = [PAPER]) {
  const saved = await o.c.rpc('finance_save_invoice', {
    target_org: o.orgId,
    invoice: { customer_id: customer, invoice_date: today(), due_date: today(30) },
    lines,
  });
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_invoice', { target_org: o.orgId, target_invoice: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return saved.data as string;
}

async function postedBill(o: Who, lines: object[] = [TONER]) {
  const saved = await o.c.rpc('finance_save_bill', {
    target_org: o.orgId,
    bill: { supplier_id: o.both, bill_date: today(), due_date: today(30) },
    lines,
  });
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_bill', { target_org: o.orgId, target_bill: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return saved.data as string;
}

async function invoiceRow(o: Who, id: string) {
  const { data, error } = await o.c.from('finance_invoice_totals').select('paid, balance, set_off, display_status').eq('id', id).single();
  expect(error, error?.message).toBeNull();
  return { paid: sen(data!.paid), balance: sen(data!.balance), set_off: sen(data!.set_off), status: data!.display_status as string };
}

async function billRow(o: Who, id: string) {
  const { data, error } = await o.c.from('supplier_bill_totals').select('paid, balance, set_off, display_status').eq('id', id).single();
  expect(error, error?.message).toBeNull();
  return { paid: sen(data!.paid), balance: sen(data!.balance), set_off: sen(data!.set_off), status: data!.display_status as string };
}

/**
 * Everything a bank balance, Banking and the Cash Flow are made of, as JSON: every row of
 * finance_account_balances and finance_bank_transactions, every ledger line on an account that stands for a
 * bank or cash account, and the Cash Flow's movements. Equal strings mean nothing moved.
 */
async function bankSide(o: Who): Promise<string> {
  const balances = await o.c.from('finance_account_balances').select('*').eq('org_id', o.orgId).order('id');
  expect(balances.error, balances.error?.message).toBeNull();
  const bankTxns = await o.c.from('finance_bank_transactions').select('*').eq('org_id', o.orgId);
  expect(bankTxns.error, bankTxns.error?.message).toBeNull();
  const accounts = await listLedgerAccounts(o.ctx);
  const lines = await listLedgerLines(o.ctx);
  const bankIds = new Set(accounts.filter((a) => a.stands_for === 'bank').map((a) => a.id));
  const onBank = lines.filter((l) => l.account_id && bankIds.has(l.account_id)).sort((a, b) => a.entry_key.localeCompare(b.entry_key));
  const sortRows = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({
    balances: balances.data,
    bankTxns: sortRows((bankTxns.data ?? []) as Record<string, unknown>[]),
    onBank,
    cash: cashMovements(lines, accounts),
  });
}

/** The balance (debit less credit, in sen) of a system account in the ledger. */
async function systemBalance(o: Who, key: 'receivable' | 'payable'): Promise<number> {
  const account = (await listLedgerAccounts(o.ctx)).find((a) => a.system_key === key)!;
  return sen(account.debit_total) - sen(account.credit_total);
}

testWithSupabase('a contra settles an invoice and a bill and moves no bank, Banking or Cash Flow figure', async () => {
  const o = await ownerWithOrg('Contra Flow Sdn Bhd');
  const invoice = await postedInvoice(o); // 132.50
  const bill = await postedBill(o); // 200.00
  const before = await bankSide(o);
  const ar0 = await systemBalance(o, 'receivable');
  const ap0 = await systemBalance(o, 'payable');

  // A draft holds nothing and moves nothing.
  const saved = await saveContra(o.ctx, {
    contact_id: o.both,
    contra_date: today(),
    amount: 100,
    reference: 'Their letter 7',
    notes: null,
    invoices: [{ invoice_id: invoice, amount: 100 }],
    bills: [{ bill_id: bill, amount: 100 }],
  });
  expect(saved).toMatchObject({ ok: true });
  const id = saved.ok ? saved.data.id : '';
  expect(await invoiceRow(o, invoice)).toMatchObject({ balance: 13250, set_off: 0 });
  expect(await bankSide(o)).toBe(before);

  // Posted: each side is 100 lower, paid is untouched, the ledger moves AR and AP only.
  const posted = await postContra(o.ctx, { id });
  expect(posted).toMatchObject({ ok: true });
  expect(posted.ok && posted.data.contra_no).toMatch(/^CT-\d+$/);
  expect(await invoiceRow(o, invoice)).toEqual({ paid: 0, balance: 3250, set_off: 10000, status: 'sent' });
  expect(await billRow(o, bill)).toEqual({ paid: 0, balance: 10000, set_off: 10000, status: 'pending' });
  expect(await systemBalance(o, 'receivable')).toBe(ar0 - 10000);
  expect(await systemBalance(o, 'payable')).toBe(ap0 + 10000);
  const entry = (await listLedgerLines(o.ctx)).filter((l) => l.entry_key === `contra:${id}`);
  expect(entry.map((l) => [sen(l.debit), sen(l.credit)]).sort()).toEqual([
    [0, 10000],
    [10000, 0],
  ]);
  expect(entry.every((l) => l.source === 'contra' && l.entry_date === today())).toBe(true);
  expect(await bankSide(o)).toBe(before);

  // It is listed, with its lines.
  const listed = (await listContras(o.ctx)).find((k) => k.id === id)!;
  expect(listed).toMatchObject({ status: 'posted', amount: 100, reference: 'Their letter 7' });
  expect(listed.invoices).toHaveLength(1);
  expect(listed.bills).toHaveLength(1);

  // Posted is locked: no save, no delete, and the invoice and the bill cannot be voided under it.
  expect(await saveContra(o.ctx, { id, contact_id: o.both, contra_date: today(), amount: 50, reference: null, notes: null, invoices: [], bills: [] })).toEqual({
    ok: false,
    error: M.locked,
  });
  expect((await deleteContra(o.ctx, { id })).ok).toBe(false);
  expect((await o.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice)).error?.code).toBe('FIN32');
  expect((await o.c.from('supplier_bills').update({ status: 'void' }).eq('id', bill)).error?.code).toBe('FIN32');

  // Voided: both documents owe again, the books reverse it today (UTC), the bank side never moved.
  expect(await voidContra(o.ctx, { id })).toEqual({ ok: true, data: { id } });
  expect(await invoiceRow(o, invoice)).toMatchObject({ balance: 13250, set_off: 0 });
  expect(await billRow(o, bill)).toMatchObject({ balance: 20000, set_off: 0 });
  expect(await systemBalance(o, 'receivable')).toBe(ar0);
  expect(await systemBalance(o, 'payable')).toBe(ap0);
  const reversal = (await listLedgerLines(o.ctx)).filter((l) => l.entry_key === `contra:${id}:void`);
  expect(reversal).toHaveLength(2);
  expect(reversal.every((l) => l.entry_date === today())).toBe(true);
  expect(await bankSide(o)).toBe(before);
  expect((await voidContra(o.ctx, { id })).ok).toBe(false);
});

testWithSupabase('payments and contras share what a document owes', async () => {
  const o = await ownerWithOrg('Contra Caps Sdn Bhd');
  const invoice = await postedInvoice(o); // 132.50
  const bill = await postedBill(o); // 200.00

  // A scheduled payment of 150 holds its part of the bill: a contra of 60 is more than the 50 left.
  const scheduled = await o.c.rpc('finance_record_payment_out', {
    target_org: o.orgId,
    payment: { account_id: o.bank, txn_date: today(), method: 'fpx', status: 'scheduled' },
    allocations: [{ bill_id: bill, amount: 150 }],
  });
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  const tooMuch = await saveContra(o.ctx, {
    contact_id: o.both,
    contra_date: today(),
    amount: 60,
    reference: null,
    notes: null,
    invoices: [{ invoice_id: invoice, amount: 60 }],
    bills: [{ bill_id: bill, amount: 60 }],
  });
  expect(tooMuch.ok).toBe(true);
  const draftId = tooMuch.ok ? tooMuch.data.id : '';
  expect(await postContra(o.ctx, { id: draftId })).toEqual({ ok: false, error: M.tooMuch });

  // 50 fits; then the bill is full, and a payment of 0.01 more is refused by the new cap.
  const fits = await saveContra(o.ctx, {
    id: draftId,
    contact_id: o.both,
    contra_date: today(),
    amount: 50,
    reference: null,
    notes: null,
    invoices: [{ invoice_id: invoice, amount: 50 }],
    bills: [{ bill_id: bill, amount: 50 }],
  });
  expect(fits).toEqual({ ok: true, data: { id: draftId } });
  expect((await postContra(o.ctx, { id: draftId })).ok).toBe(true);
  const over = await o.c.rpc('finance_record_payment_out', {
    target_org: o.orgId,
    payment: { account_id: o.bank, txn_date: today(), method: 'fpx', status: 'scheduled' },
    allocations: [{ bill_id: bill, amount: 0.01 }],
  });
  expect(over.error?.code).toBe('FIN05');

  // The invoice owes 82.50 after the set-off: money in of 82.51 is refused, 82.50 is taken.
  const pay = (amount: number) =>
    o.c.rpc('finance_record_payment_in', {
      target_org: o.orgId,
      payment: { account_id: o.bank, txn_date: today(), method: 'fpx' },
      allocations: [{ invoice_id: invoice, amount }],
    });
  expect((await pay(82.51)).error?.code).toBe('FIN05');
  expect((await pay(82.5)).error).toBeNull();
  expect(await invoiceRow(o, invoice)).toEqual({ paid: 8250, balance: 0, set_off: 5000, status: 'paid' });
});

testWithSupabase('who may write, and whose documents', async () => {
  const o = await ownerWithOrg('Contra Rules Sdn Bhd');
  const invoice = await postedInvoice(o);
  const otherInvoice = await postedInvoice(o, o.customerOnly);
  const bill = await postedBill(o);
  const draft = (over: object = {}) => ({
    contact_id: o.both,
    contra_date: today(),
    amount: 10,
    reference: null,
    notes: null,
    invoices: [{ invoice_id: invoice, amount: 10 }],
    bills: [{ bill_id: bill, amount: 10 }],
    ...over,
  });

  // A contact who is only a customer cannot have one; nor can a contra name another contact's invoice.
  expect(await saveContra(o.ctx, draft({ contact_id: o.customerOnly, invoices: [{ invoice_id: otherInvoice, amount: 10 }], bills: [] }))).toEqual({
    ok: false,
    error: M.wrongContact,
  });
  expect(await saveContra(o.ctx, draft({ invoices: [{ invoice_id: otherInvoice, amount: 10 }] }))).toEqual({ ok: false, error: M.wrongContact });

  // Sides that do not add up are saved as a draft and refused at posting.
  const uneven = await saveContra(o.ctx, draft({ bills: [{ bill_id: bill, amount: 9 }] }));
  expect(uneven.ok).toBe(true);
  expect(await postContra(o.ctx, { id: uneven.ok ? uneven.data.id : '' })).toEqual({ ok: false, error: M.unbalanced });

  // A member reads, and writes nothing; an admin writes.
  const member = await join(o, 'member');
  expect(await saveContra(member.ctx, draft())).toEqual({ ok: false, error: M.needsSignOff });
  expect((await listContras(member.ctx)).length).toBe(1);
  expect(await postContra(member.ctx, { id: uneven.ok ? uneven.data.id : '' })).toEqual({ ok: false, error: M.needsSignOff });
  expect((await deleteContra(member.ctx, { id: uneven.ok ? uneven.data.id : '' })).ok).toBe(false);
  const admin = await join(o, 'admin');
  const byAdmin = await saveContra(admin.ctx, draft());
  expect(byAdmin.ok).toBe(true);

  // A draft is deleted with its lines.
  expect(await deleteContra(o.ctx, { id: byAdmin.ok ? byAdmin.data.id : '' })).toMatchObject({ ok: true });
  const { count } = await o.c.from('finance_contra_lines').select('id', { count: 'exact', head: true }).eq('org_id', o.orgId);
  expect(count).toBe(2); // the uneven draft's two lines are all that is left
});

testWithSupabase('a contra that a refund depends on is not voided', async () => {
  const o = await ownerWithOrg('Contra Refund Sdn Bhd');
  const invoice = await postedInvoice(o); // 132.50
  const bill = await postedBill(o); // 200.00
  const saved = await saveContra(o.ctx, {
    contact_id: o.both,
    contra_date: today(),
    amount: 132.5,
    reference: null,
    notes: null,
    invoices: [{ invoice_id: invoice, amount: 132.5 }],
    bills: [{ bill_id: bill, amount: 132.5 }],
  });
  const id = saved.ok ? saved.data.id : '';
  expect((await postContra(o.ctx, { id })).ok).toBe(true);
  // A credit note of 30 puts the customer 30 in credit, and 30 is refunded.
  const note = await o.c.rpc('finance_save_credit_note', {
    target_org: o.orgId,
    note: { invoice_id: invoice, credit_date: today(), reason: 'returns', amount: 30 },
  });
  expect(note.error, note.error?.message).toBeNull();
  expect((await o.c.rpc('finance_issue_credit_note', { target_org: o.orgId, target_note: note.data })).error).toBeNull();
  const refund = await o.c.rpc('finance_record_refund', {
    target_org: o.orgId,
    refund: { invoice_id: invoice, account_id: o.bank, txn_date: today(), method: 'fpx', reason: 'other', amount: 30 },
  });
  expect(refund.error, refund.error?.message).toBeNull();
  // Without the contra the customer would owe 132.50 - 30 + 30: the refund depends on it.
  expect(await voidContra(o.ctx, { id })).toEqual({ ok: false, error: M.refundsDepend });
});

testWithSupabase('a second contra takes only what the first left of a bill or an invoice', async () => {
  const o = await ownerWithOrg('Contra Twice Sdn Bhd');
  const invoiceA = await postedInvoice(o); // 132.50
  const invoiceB = await postedInvoice(o);
  const billA = await postedBill(o, [PAPER]); // 132.50
  const billB = await postedBill(o, [PAPER]);
  const draft = async (invoice: string, bill: string, amount: number) => {
    const saved = await saveContra(o.ctx, {
      contact_id: o.both,
      contra_date: today(),
      amount,
      reference: null,
      notes: null,
      invoices: [{ invoice_id: invoice, amount }],
      bills: [{ bill_id: bill, amount }],
    });
    expect(saved).toMatchObject({ ok: true });
    return saved.ok ? saved.data.id : '';
  };

  // The first takes 100 of invoice A and bill A.
  expect(await postContra(o.ctx, { id: await draft(invoiceA, billA, 100) })).toMatchObject({ ok: true });

  // A second one for the same bill: 100 is too much, one sen over what is left is too much, what is left is not.
  expect(await postContra(o.ctx, { id: await draft(invoiceB, billA, 100) })).toEqual({ ok: false, error: M.tooMuch });
  expect(await postContra(o.ctx, { id: await draft(invoiceB, billA, 32.51) })).toEqual({ ok: false, error: M.tooMuch });
  expect(await postContra(o.ctx, { id: await draft(invoiceB, billA, 32.5) })).toMatchObject({ ok: true });
  expect(await billRow(o, billA)).toMatchObject({ balance: 0, set_off: 13250 });

  // The same for an invoice: invoice A has 32.50 left.
  expect(await postContra(o.ctx, { id: await draft(invoiceA, billB, 100) })).toEqual({ ok: false, error: M.tooMuch });
  expect(await postContra(o.ctx, { id: await draft(invoiceA, billB, 32.5) })).toMatchObject({ ok: true });
  expect(await invoiceRow(o, invoiceA)).toMatchObject({ balance: 0, set_off: 13250 });
});
