import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);


function client(): SupabaseClient {
  return liveClient();
}

type Org = { c: SupabaseClient; orgId: string; bank: string; cash: string; customer: string; supplier: string };

async function anonUserWithOrg(orgName: string): Promise<Org> {
  const c = client();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const { data: accounts } = await c.from('finance_accounts').select('id, name').eq('org_id', orgId);
  const bank = accounts?.find((a) => a.name === 'Main Bank')?.id as string;
  const cash = accounts?.find((a) => a.name === 'Cash in hand')?.id as string;
  const { data: customer, error: customerErr } = await c
    .from('finance_contacts')
    .insert({ org_id: orgId, name: `Customer of ${orgName}`, is_customer: true })
    .select('id')
    .single();
  expect(customerErr, customerErr?.message).toBeNull();
  const { data: supplier, error: supplierErr } = await c
    .from('finance_contacts')
    .insert({ org_id: orgId, name: `Supplier of ${orgName}`, is_supplier: true })
    .select('id')
    .single();
  expect(supplierErr, supplierErr?.message).toBeNull();
  return { c, orgId: orgId as string, bank, cash, customer: customer!.id as string, supplier: supplier!.id as string };
}

function daysFromToday(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DESIGN = { description: 'Design work', quantity: 10, unit_price: 12.5, sst_rate: 6 }; // 125.00 + 7.50 SST = 132.50

async function saveInvoice(o: Org, lines: object[] = [DESIGN], extra: object = {}) {
  return o.c.rpc('finance_save_invoice', {
    target_org: o.orgId,
    invoice: { customer_id: o.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(30), ...extra },
    lines,
  });
}

/** A posted invoice of RM 132.50. */
async function postedInvoice(o: Org, extra: object = {}) {
  const saved = await saveInvoice(o, [DESIGN], extra);
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_invoice', { target_org: o.orgId, target_invoice: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return { id: saved.data as string, invoiceNo: posted.data as string };
}

function receive(o: Org, allocations: { invoice_id: string; amount: number }[], method = 'fpx') {
  return o.c.rpc('finance_record_payment_in', {
    target_org: o.orgId,
    payment: { account_id: o.bank, txn_date: daysFromToday(0), method },
    allocations,
  });
}

async function totals(c: SupabaseClient, invoiceId: string) {
  const { data, error } = await c
    .from('finance_invoice_totals')
    .select('invoice_no, subtotal, sst, total, paid, balance, display_status')
    .eq('id', invoiceId)
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

/** A posted bill of RM 132.50, to prove the bill side still works beside invoices. */
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

/** A draft movement of money written straight to the table, as no screen does. */
async function strayTransaction(o: Org, direction: 'in' | 'out', amount: number) {
  const { data, error } = await o.c
    .from('finance_transactions')
    .insert({ org_id: o.orgId, direction, account_id: o.bank, amount, method: 'cash' })
    .select('id')
    .single();
  expect(error, error?.message).toBeNull();
  return data!.id as string;
}

let a: Org;
let b: Org;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  a = await anonUserWithOrg('Sales A Sdn Bhd');
  b = await anonUserWithOrg('Sales B Sdn Bhd');
});

testWithSupabase('a draft invoice has no number, and saving it again replaces its lines in the order given', async () => {
  const saved = await saveInvoice(a);
  expect(saved.error, saved.error?.message).toBeNull();
  expect(await totals(a.c, saved.data)).toEqual({
    invoice_no: null, subtotal: 125, sst: 7.5, total: 132.5, paid: 0, balance: 132.5, display_status: 'draft',
  });

  const again = await a.c.rpc('finance_save_invoice', {
    target_org: a.orgId,
    invoice: { id: saved.data, customer_id: a.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(14), notes: 'Changed' },
    lines: [
      { description: 'Zebra crossing paint', quantity: 2, unit_price: 5 },
      { description: 'Apple crates', quantity: 1, unit_price: 5 },
      { description: 'Mango pulp', quantity: 1, unit_price: 5 },
    ],
  });
  expect(again.error, again.error?.message).toBeNull();
  expect(again.data).toBe(saved.data);
  expect(await totals(a.c, saved.data)).toMatchObject({ total: 20, display_status: 'draft' });
  const { data: lines } = await a.c
    .from('finance_invoice_lines')
    .select('description, position')
    .eq('invoice_id', saved.data)
    .order('position', { ascending: true });
  expect(lines).toEqual([
    { description: 'Zebra crossing paint', position: 1 },
    { description: 'Apple crates', position: 2 },
    { description: 'Mango pulp', position: 3 },
  ]);

  const { error } = await a.c.from('finance_invoices').delete().eq('id', saved.data);
  expect(error, error?.message).toBeNull();
  const { data: left } = await a.c.from('finance_invoice_lines').select('id').eq('invoice_id', saved.data);
  expect(left).toEqual([]);
});

testWithSupabase('an invoice needs a line before it can be saved, and an amount before it can be posted', async () => {
  const none = await saveInvoice(a, []);
  expect(none.error?.code).toBe('FIN10');
  const free = await saveInvoice(a, [{ description: 'Sample', quantity: 1, unit_price: 0 }]);
  expect(free.error, free.error?.message).toBeNull();
  const posted = await a.c.rpc('finance_post_invoice', { target_org: a.orgId, target_invoice: free.data });
  expect(posted.error?.code).toBe('FIN10');
  // Behind the function too: a plain update cannot post it either.
  const sneak = await a.c.from('finance_invoices').update({ status: 'posted', invoice_no: 'INV-SNEAKY' }).eq('id', free.data);
  expect(sneak.error?.code).toBe('FIN10');
});

testWithSupabase('posting gives the invoice the next number and it shows as sent', async () => {
  const first = await postedInvoice(a);
  const second = await postedInvoice(a);
  expect(first.invoiceNo).toMatch(/^INV-\d+$/);
  expect(second.invoiceNo).toMatch(/^INV-\d+$/);
  expect(Number(second.invoiceNo.slice(4))).toBe(Number(first.invoiceNo.slice(4)) + 1);
  expect(await totals(a.c, first.id)).toEqual({
    invoice_no: first.invoiceNo, subtotal: 125, sst: 7.5, total: 132.5, paid: 0, balance: 132.5, display_status: 'sent',
  });
});

testWithSupabase('an invoice cannot be created already posted, and a draft cannot be voided or carry an e-Invois status', async () => {
  const direct = await a.c.from('finance_invoices').insert({
    org_id: a.orgId, customer_id: a.customer, invoice_no: 'INV-SNEAKY', due_date: daysFromToday(30), status: 'posted',
  });
  expect(direct.error?.code).toBe('FIN01');

  const draft = await saveInvoice(a);
  const voided = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', draft.data);
  expect(voided.error?.code).toBe('FIN01');
  const stamped = await a.c.from('finance_invoices').update({ einvoice_status: 'validated' }).eq('id', draft.data);
  expect(stamped.error?.code).toBe('23514');
});

testWithSupabase('a posted invoice cannot be edited, re-saved, given lines, deleted or posted again', async () => {
  const invoice = await postedInvoice(a);
  const edit = await a.c.from('finance_invoices').update({ notes: 'Sneaky' }).eq('id', invoice.id);
  expect(edit.error?.code).toBe('FIN01');
  const due = await a.c.from('finance_invoices').update({ due_date: daysFromToday(90) }).eq('id', invoice.id);
  expect(due.error?.code).toBe('FIN01');
  const resave = await a.c.rpc('finance_save_invoice', {
    target_org: a.orgId,
    invoice: { id: invoice.id, customer_id: a.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(30), notes: 'Changed' },
    lines: [DESIGN],
  });
  expect(resave.error?.code).toBe('FIN01');
  const line = await a.c
    .from('finance_invoice_lines')
    .insert({ org_id: a.orgId, invoice_id: invoice.id, description: 'Extra', quantity: 1, unit_price: 1 });
  expect(line.error?.code).toBe('FIN01');
  const lineEdit = await a.c.from('finance_invoice_lines').update({ unit_price: 1 }).eq('invoice_id', invoice.id);
  expect(lineEdit.error?.code).toBe('FIN01');
  const remove = await a.c.from('finance_invoices').delete().eq('id', invoice.id);
  expect(remove.error?.code).toBe('FIN01');
  const again = await a.c.rpc('finance_post_invoice', { target_org: a.orgId, target_invoice: invoice.id });
  expect(again.error?.code).toBe('FIN01');
  const back = await a.c.from('finance_invoices').update({ status: 'draft' }).eq('id', invoice.id);
  expect(back.error?.code).toBe('FIN01');
  expect(await totals(a.c, invoice.id)).toMatchObject({ total: 132.5, display_status: 'sent' });
});

testWithSupabase('the e-Invois status and reference of a posted invoice can be set, and nothing else with them', async () => {
  const invoice = await postedInvoice(a);
  const set = await a.c
    .from('finance_invoices')
    .update({ einvoice_status: 'pending', einvoice_uuid: 'LHDN-TEST-1', updated_at: new Date().toISOString() })
    .eq('id', invoice.id)
    .select('einvoice_status, einvoice_uuid')
    .single();
  expect(set.error, set.error?.message).toBeNull();
  expect(set.data).toEqual({ einvoice_status: 'pending', einvoice_uuid: 'LHDN-TEST-1' });

  const withMore = await a.c.from('finance_invoices').update({ einvoice_status: 'validated', notes: 'Sneaky' }).eq('id', invoice.id);
  expect(withMore.error?.code).toBe('FIN01');
  const unknown = await a.c.from('finance_invoices').update({ einvoice_status: 'approved' }).eq('id', invoice.id);
  expect(unknown.error?.code).toBe('23514');
  const { data: row } = await a.c.from('finance_invoice_totals').select('einvoice_status').eq('id', invoice.id).single();
  expect(row).toEqual({ einvoice_status: 'pending' });
});

testWithSupabase('a posted invoice past its due date shows as overdue, until it is paid', async () => {
  const invoice = await postedInvoice(a, { invoice_date: daysFromToday(-40), due_date: daysFromToday(-10) });
  expect(await totals(a.c, invoice.id)).toMatchObject({ balance: 132.5, display_status: 'overdue' });
  const paid = await receive(a, [{ invoice_id: invoice.id, amount: 132.5 }]);
  expect(paid.error, paid.error?.message).toBeNull();
  expect(await totals(a.c, invoice.id)).toMatchObject({ balance: 0, display_status: 'paid' });
});

testWithSupabase('money received reduces the balance at once: part-paid stays sent, paid in full is paid', async () => {
  const invoice = await postedInvoice(a);
  const part = await receive(a, [{ invoice_id: invoice.id, amount: 100 }]);
  expect(part.error, part.error?.message).toBeNull();
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 100, balance: 32.5, display_status: 'sent' });

  const { data: txn } = await a.c
    .from('finance_transactions')
    .select('direction, status, amount, contact_id, account_id, number')
    .eq('id', part.data)
    .single();
  expect(txn).toEqual({
    direction: 'in', status: 'posted', amount: 100, contact_id: a.customer, account_id: a.bank,
    number: expect.stringMatching(/^RC-\d{4}$/),
  });

  const rest = await receive(a, [{ invoice_id: invoice.id, amount: 32.5 }], 'cash');
  expect(rest.error, rest.error?.message).toBeNull();
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 132.5, balance: 0, display_status: 'paid' });

  const { data: rows } = await a.c
    .from('finance_payments_in')
    .select('allocation_id, transaction_id, number, method, amount, transaction_amount, status, invoice_no, customer_name, account_name')
    .eq('invoice_id', invoice.id)
    .order('amount', { ascending: false });
  expect(rows).toEqual([
    {
      allocation_id: expect.any(String), transaction_id: part.data, number: expect.stringMatching(/^RC-\d{4}$/), method: 'fpx',
      amount: 100, transaction_amount: 100, status: 'posted', invoice_no: invoice.invoiceNo,
      customer_name: 'Customer of Sales A Sdn Bhd', account_name: 'Main Bank',
    },
    {
      allocation_id: expect.any(String), transaction_id: rest.data, number: expect.stringMatching(/^RC-\d{4}$/), method: 'cash',
      amount: 32.5, transaction_amount: 32.5, status: 'posted', invoice_no: invoice.invoiceNo,
      customer_name: 'Customer of Sales A Sdn Bhd', account_name: 'Main Bank',
    },
  ]);
  expect(rows![0].number).not.toBe(rows![1].number);
});

testWithSupabase('a payment in cannot be more than is still owed, to the sen', async () => {
  const invoice = await postedInvoice(a);
  const over = await receive(a, [{ invoice_id: invoice.id, amount: 132.51 }]);
  expect(over.error?.code).toBe('FIN05');
  const part = await receive(a, [{ invoice_id: invoice.id, amount: 100 }]);
  expect(part.error, part.error?.message).toBeNull();
  const second = await receive(a, [{ invoice_id: invoice.id, amount: 32.51 }]);
  expect(second.error?.code).toBe('FIN05');
  const exact = await receive(a, [{ invoice_id: invoice.id, amount: 32.5 }]);
  expect(exact.error, exact.error?.message).toBeNull();
  // A refused payment leaves nothing behind: no half-written movement of money.
  const { data: drafts } = await a.c.from('finance_transactions').select('id').eq('org_id', a.orgId).eq('status', 'draft');
  expect(drafts).toEqual([]);
});

testWithSupabase('two full payments in at the same moment: only one goes through', async () => {
  const invoice = await postedInvoice(a);
  const results = await Promise.all([
    receive(a, [{ invoice_id: invoice.id, amount: 132.5 }]),
    receive(a, [{ invoice_id: invoice.id, amount: 132.5 }]),
  ]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(results.find((r) => r.error)?.error?.code).toBe('FIN05');
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 132.5, balance: 0, display_status: 'paid' });
});

testWithSupabase('a payment in cannot go against a draft or a void invoice, or with no invoice at all', async () => {
  const draft = await saveInvoice(a);
  const onDraft = await receive(a, [{ invoice_id: draft.data, amount: 10 }]);
  expect(onDraft.error?.code).toBe('FIN04');

  const invoice = await postedInvoice(a);
  const voided = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice.id);
  expect(voided.error, voided.error?.message).toBeNull();
  const onVoid = await receive(a, [{ invoice_id: invoice.id, amount: 10 }]);
  expect(onVoid.error?.code).toBe('FIN04');

  const none = await receive(a, []);
  expect(none.error?.code).toBe('FIN06');
});

testWithSupabase('a payment in cannot be edited or deleted, only voided; an invoice with money on it cannot be voided', async () => {
  const invoice = await postedInvoice(a);
  const paid = await receive(a, [{ invoice_id: invoice.id, amount: 132.5 }]);
  const edit = await a.c.from('finance_transactions').update({ amount: 1 }).eq('id', paid.data);
  expect(edit.error?.code).toBe('FIN09');
  const remove = await a.c.from('finance_transactions').delete().eq('id', paid.data);
  expect(remove.error?.code).toBe('FIN09');
  const split = await a.c.from('finance_allocations').update({ amount: 1 }).eq('transaction_id', paid.data);
  expect(split.error?.code).toBe('FIN09');

  const voidInvoice = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice.id);
  expect(voidInvoice.error?.code).toBe('FIN02');

  const voidPayment = await a.c.from('finance_transactions').update({ status: 'void' }).eq('id', paid.data);
  expect(voidPayment.error, voidPayment.error?.message).toBeNull();
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 0, balance: 132.5, display_status: 'sent' });
  // The voided payment still shows on Payments In, as void.
  const { data: rows } = await a.c.from('finance_payments_in').select('status').eq('invoice_id', invoice.id);
  expect(rows).toEqual([{ status: 'void' }]);

  const voidAgain = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice.id);
  expect(voidAgain.error, voidAgain.error?.message).toBeNull();
  expect(await totals(a.c, invoice.id)).toMatchObject({ display_status: 'void' });
  const revive = await a.c.from('finance_invoices').update({ status: 'posted' }).eq('id', invoice.id);
  expect(revive.error?.code).toBe('FIN01');
});

testWithSupabase('one payment in can cover two invoices of one customer, but not two customers', async () => {
  const first = await postedInvoice(a);
  const second = await postedInvoice(a);
  const both = await receive(a, [{ invoice_id: first.id, amount: 132.5 }, { invoice_id: second.id, amount: 32.5 }]);
  expect(both.error, both.error?.message).toBeNull();
  const { data: txn } = await a.c.from('finance_transactions').select('amount, contact_id, direction').eq('id', both.data).single();
  expect(txn).toEqual({ amount: 165, contact_id: a.customer, direction: 'in' });
  expect(await totals(a.c, first.id)).toMatchObject({ paid: 132.5, balance: 0, display_status: 'paid' });
  expect(await totals(a.c, second.id)).toMatchObject({ paid: 32.5, balance: 100, display_status: 'sent' });

  // Two rows, one payment: the amounts add up to it, and each row has its own key.
  const { data: rows } = await a.c
    .from('finance_payments_in')
    .select('allocation_id, transaction_id, number, amount, transaction_amount')
    .eq('transaction_id', both.data);
  expect(rows).toHaveLength(2);
  expect(new Set(rows!.map((r) => r.allocation_id)).size).toBe(2);
  expect(new Set(rows!.map((r) => r.number)).size).toBe(1);
  expect(rows!.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(165);
  expect(rows!.every((r) => Number(r.transaction_amount) === 165)).toBe(true);

  const { data: other } = await a.c
    .from('finance_contacts')
    .insert({ org_id: a.orgId, name: 'Another customer', is_customer: true })
    .select('id')
    .single();
  const theirs = await postedInvoice({ ...a, customer: other!.id });
  const mixed = await receive(a, [{ invoice_id: second.id, amount: 10 }, { invoice_id: theirs.id, amount: 10 }]);
  expect(mixed.error?.code).toBe('FIN06');
});

testWithSupabase('an invoice takes only money in and a bill only money out; an allocation names exactly one of them', async () => {
  const invoice = await postedInvoice(a);
  const billId = await postedBill(a);

  const out = await strayTransaction(a, 'out', 20);
  const outOnInvoice = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: out, invoice_id: invoice.id, amount: 10 });
  expect(outOnInvoice.error?.code).toBe('FIN04');
  const both = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: out, bill_id: billId, invoice_id: invoice.id, amount: 10 });
  expect(both.error?.code).toBe('23514');
  const neither = await a.c.from('finance_allocations').insert({ org_id: a.orgId, transaction_id: out, amount: 10 });
  // With no invoice named it is read as a bill payment, and no bill is found.
  expect(neither.error?.code).toBe('FIN04');
  const tooMuch = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: out, bill_id: billId, amount: 20.01 });
  expect(tooMuch.error?.code).toBe('FIN03');

  const moneyIn = await strayTransaction(a, 'in', 20);
  const inOnBill = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: moneyIn, bill_id: billId, amount: 10 });
  expect(inOnBill.error?.code).toBe('FIN04');
  const tooMuchIn = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: moneyIn, invoice_id: invoice.id, amount: 20.01 });
  expect(tooMuchIn.error?.code).toBe('FIN03');
  // Money that was never received cannot be voided: it is deleted.
  const voided = await a.c.from('finance_transactions').update({ status: 'void' }).eq('id', moneyIn);
  expect(voided.error?.code).toBe('FIN09');

  for (const id of [out, moneyIn]) {
    const removed = await a.c.from('finance_transactions').delete().eq('id', id);
    expect(removed.error, removed.error?.message).toBeNull();
  }
});

testWithSupabase('a draft payment that is split cannot be made smaller than its split or change direction', async () => {
  const invoice = await postedInvoice(a);
  const billId = await postedBill(a);

  // Money in, split in full across a posted invoice, then shrunk or turned round before posting.
  const moneyIn = await strayTransaction(a, 'in', 100);
  const onInvoice = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: moneyIn, invoice_id: invoice.id, amount: 100 });
  expect(onInvoice.error, onInvoice.error?.message).toBeNull();
  const shrunk = await a.c.from('finance_transactions').update({ amount: 1 }).eq('id', moneyIn);
  expect(shrunk.error?.code).toBe('FIN03');
  const shrunkAndPosted = await a.c
    .from('finance_transactions')
    .update({ amount: 1, status: 'posted', number: 'RC-SNEAKY' })
    .eq('id', moneyIn);
  expect(shrunkAndPosted.error?.code).toBe('FIN03');
  const turned = await a.c.from('finance_transactions').update({ direction: 'out' }).eq('id', moneyIn);
  expect(turned.error?.code).toBe('FIN04');
  const turnedAndPosted = await a.c
    .from('finance_transactions')
    .update({ direction: 'out', status: 'posted', number: 'RC-SNEAKY' })
    .eq('id', moneyIn);
  expect(turnedAndPosted.error?.code).toBe('FIN04');
  // Making it larger is fine, and so is bringing it back down to exactly its split.
  const larger = await a.c.from('finance_transactions').update({ amount: 120 }).eq('id', moneyIn);
  expect(larger.error, larger.error?.message).toBeNull();
  const exact = await a.c.from('finance_transactions').update({ amount: 100 }).eq('id', moneyIn);
  expect(exact.error, exact.error?.message).toBeNull();
  const { data: txn } = await a.c.from('finance_transactions').select('amount, direction, status').eq('id', moneyIn).single();
  expect(txn).toEqual({ amount: 100, direction: 'in', status: 'draft' });
  // A draft is not money received: the invoice owes what it owed.
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 0, balance: 132.5, display_status: 'sent' });

  // The same for money out against a bill.
  const out = await strayTransaction(a, 'out', 100);
  const onBill = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: out, bill_id: billId, amount: 100 });
  expect(onBill.error, onBill.error?.message).toBeNull();
  const shrunkOut = await a.c.from('finance_transactions').update({ amount: 99.99 }).eq('id', out);
  expect(shrunkOut.error?.code).toBe('FIN03');
  const turnedOut = await a.c.from('finance_transactions').update({ direction: 'in' }).eq('id', out);
  expect(turnedOut.error?.code).toBe('FIN04');

  // Deleting a draft takes its split with it.
  for (const id of [moneyIn, out]) {
    const removed = await a.c.from('finance_transactions').delete().eq('id', id);
    expect(removed.error, removed.error?.message).toBeNull();
  }
  const { data: left } = await a.c.from('finance_allocations').select('id').in('transaction_id', [moneyIn, out]);
  expect(left).toEqual([]);
});

testWithSupabase('a bill is still paid, held, over-paid and voided as before, beside an invoice that is not touched', async () => {
  const invoice = await postedInvoice(a);
  const billId = await postedBill(a);
  const pay = (amount: number, status: 'posted' | 'scheduled' = 'posted') =>
    a.c.rpc('finance_record_payment_out', {
      target_org: a.orgId,
      payment: { account_id: a.bank, txn_date: daysFromToday(0), method: 'fpx', status },
      allocations: [{ bill_id: billId, amount }],
    });
  const bill = async () => {
    const { data } = await a.c.from('supplier_bill_totals').select('paid, balance, display_status').eq('id', billId).single();
    return data;
  };

  const scheduled = await pay(100, 'scheduled');
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  expect((await pay(32.51)).error?.code).toBe('FIN05');
  const paid = await pay(32.5);
  expect(paid.error, paid.error?.message).toBeNull();
  expect(await bill()).toEqual({ paid: 32.5, balance: 100, display_status: 'pending' });

  const voidBill = await a.c.from('supplier_bills').update({ status: 'void' }).eq('id', billId);
  expect(voidBill.error?.code).toBe('FIN02');

  // The two views stay apart: a payment out is not a payment in, and the invoice owes what it owed.
  const { data: outRows } = await a.c.from('finance_payments_out').select('bill_id').eq('bill_id', billId);
  expect(outRows).toHaveLength(2);
  const { data: inRows } = await a.c
    .from('finance_payments_in')
    .select('allocation_id')
    .in('transaction_id', [scheduled.data, paid.data]);
  expect(inRows).toEqual([]);
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 0, balance: 132.5, display_status: 'sent' });
});

testWithSupabase('another workspace cannot see or touch invoices, their lines or payments in', async () => {
  const invoice = await postedInvoice(a);
  const paid = await receive(a, [{ invoice_id: invoice.id, amount: 10 }]);

  for (const table of ['finance_invoices', 'finance_invoice_lines', 'finance_invoice_totals', 'finance_payments_in']) {
    const { data } = await b.c.from(table).select('org_id').eq('org_id', a.orgId);
    expect(data ?? [], table).toEqual([]);
  }

  const save = await b.c.rpc('finance_save_invoice', {
    target_org: a.orgId,
    invoice: { customer_id: a.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(save.error?.code).toBe('42501');
  const post = await b.c.rpc('finance_post_invoice', { target_org: a.orgId, target_invoice: invoice.id });
  // The invoice is not there for them to lock.
  expect(post.error?.code).toBe('FIN11');
  // B's own workspace, A's invoice: the invoice is not found there.
  const theirs = await receive(b, [{ invoice_id: invoice.id, amount: 10 }]);
  expect(theirs.error?.code).toBe('FIN06');
  const { data: changed } = await b.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice.id).select('id');
  expect(changed ?? []).toEqual([]);
  const { data: voided } = await b.c.from('finance_transactions').update({ status: 'void' }).eq('id', paid.data).select('id');
  expect(voided ?? []).toEqual([]);
});

testWithSupabase('a customer with invoices cannot be deleted or stop being a customer', async () => {
  await postedInvoice(a);
  const remove = await a.c.from('finance_contacts').delete().eq('id', a.customer);
  expect(remove.error?.code).toBe('23503');
  const untick = await a.c.from('finance_contacts').update({ is_customer: false, is_supplier: true }).eq('id', a.customer);
  expect(untick.error?.code).toBe('FIN08');
  // Becoming a supplier as well is fine.
  const both = await a.c.from('finance_contacts').update({ is_supplier: true }).eq('id', a.customer);
  expect(both.error, both.error?.message).toBeNull();
});

testWithSupabase('a demo viewer cannot write an invoice, its lines or a payment in', async () => {
  const c = client();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await joinDemo(c);
  expect(error, error?.message).toBeNull();
  const { data: contacts } = await c.from('finance_contacts').select('id').eq('org_id', demoId).limit(1);
  const anyContact = contacts![0].id as string;

  const direct = await c
    .from('finance_invoices')
    .insert({ org_id: demoId, customer_id: anyContact, due_date: daysFromToday(30) });
  expect(direct.error?.code).toBe('42501');
  const save = await c.rpc('finance_save_invoice', {
    target_org: demoId,
    invoice: { customer_id: anyContact, invoice_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(save.error?.code).toBe('42501');
  const line = await c
    .from('finance_invoice_lines')
    .insert({ org_id: demoId, invoice_id: crypto.randomUUID(), description: 'Viewer', quantity: 1, unit_price: 1 });
  expect(line.error?.code).toBe('42501');
});

// Needs 20261014100100_bendahara_invoices_seed.sql: until the controller has applied it, this one test fails.
testWithSupabase('a demo viewer reads the seeded invoices and payments in', async () => {
  const c = client();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await joinDemo(c);
  expect(error, error?.message).toBeNull();

  const { data: invoices } = await c
    .from('finance_invoice_totals')
    .select('id, invoice_no, customer_id, display_status, balance')
    .eq('org_id', demoId);
  // The seed's dates are relative to the day it ran, so Sent turns into Overdue as time passes: only what cannot drift is asserted.
  const statuses = new Set((invoices ?? []).map((i) => i.display_status));
  for (const status of ['draft', 'paid']) expect(statuses.has(status), status).toBe(true);
  expect((invoices ?? []).filter((i) => i.display_status === 'draft').every((i) => i.invoice_no === null)).toBe(true);
  expect((invoices ?? []).filter((i) => i.display_status !== 'draft').every((i) => /^INV-\d+$/.test(i.invoice_no))).toBe(true);

  const { data: payments } = await c.from('finance_payments_in').select('number, status, invoice_no').eq('org_id', demoId);
  expect((payments ?? []).length).toBeGreaterThan(0);
  expect((payments ?? []).every((p) => p.status !== 'posted' || /^RC-\d+$/.test(p.number))).toBe(true);

  const open = (invoices ?? []).find((i) => i.display_status === 'sent' || i.display_status === 'overdue')!;
  expect(open, 'an invoice that is still owed').toBeTruthy();
  expect(Number(open.balance)).toBeGreaterThan(0);
  const post = await c.rpc('finance_post_invoice', { target_org: demoId, target_invoice: open.id });
  // The function locks the invoice for update, which a viewer may not do, so to them it is not there.
  expect(post.error?.code).toBe('FIN11');
  const pay = await c.rpc('finance_record_payment_in', {
    target_org: demoId,
    payment: { account_id: crypto.randomUUID(), txn_date: daysFromToday(0), method: 'fpx' },
    allocations: [{ invoice_id: open.id, amount: 1 }],
  });
  expect(pay.error?.code).toBe('42501');
  const { data: voided } = await c.from('finance_invoices').update({ status: 'void' }).eq('id', open.id).select('id');
  expect(voided ?? []).toEqual([]);
});
