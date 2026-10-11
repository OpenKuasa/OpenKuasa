import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);


function client(): SupabaseClient {
  return liveClient();
}

type Org = { c: SupabaseClient; orgId: string; bank: string; cash: string; supplier: string };

async function anonUserWithOrg(orgName: string): Promise<Org> {
  const c = client();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const { data: accounts } = await c.from('finance_accounts').select('id, name').eq('org_id', orgId);
  const bank = accounts?.find((a) => a.name === 'Main Bank')?.id as string;
  const cash = accounts?.find((a) => a.name === 'Cash in hand')?.id as string;
  const { data: supplier, error: supplierErr } = await c
    .from('finance_contacts')
    .insert({ org_id: orgId, name: `Supplier of ${orgName}`, is_supplier: true })
    .select('id')
    .single();
  expect(supplierErr, supplierErr?.message).toBeNull();
  return { c, orgId: orgId as string, bank, cash, supplier: supplier!.id as string };
}

function daysFromToday(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const GLOVES = { description: 'Gloves', quantity: 10, unit_price: 12.5, sst_rate: 6 }; // 125.00 + 7.50 SST = 132.50

async function saveBill(o: Org, lines: object[] = [GLOVES], extra: object = {}) {
  return o.c.rpc('finance_save_bill', {
    target_org: o.orgId,
    bill: { supplier_id: o.supplier, bill_date: daysFromToday(0), due_date: daysFromToday(30), ...extra },
    lines,
  });
}

/** A posted bill of RM 132.50. */
async function postedBill(o: Org) {
  const saved = await saveBill(o);
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_bill', { target_org: o.orgId, target_bill: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return { id: saved.data as string, billNo: posted.data as string };
}

function pay(o: Org, allocations: { bill_id: string; amount: number }[], status: 'posted' | 'scheduled' = 'posted') {
  return o.c.rpc('finance_record_payment_out', {
    target_org: o.orgId,
    payment: { account_id: o.bank, txn_date: daysFromToday(0), method: 'fpx', status },
    allocations,
  });
}

async function totals(c: SupabaseClient, billId: string) {
  const { data, error } = await c
    .from('supplier_bill_totals')
    .select('bill_no, total, paid, balance, display_status')
    .eq('id', billId)
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

let a: Org;
let b: Org;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  a = await anonUserWithOrg('Purchases A Sdn Bhd');
  b = await anonUserWithOrg('Purchases B Sdn Bhd');
});

testWithSupabase('a new workspace has a bank account and a cash account', () => {
  expect(a.bank).toBeTruthy();
  expect(a.cash).toBeTruthy();
});

testWithSupabase('a draft bill has no number, and saving it again replaces its lines', async () => {
  const saved = await saveBill(a);
  expect(saved.error, saved.error?.message).toBeNull();
  expect(await totals(a.c, saved.data)).toEqual({
    bill_no: null, total: 132.5, paid: 0, balance: 132.5, display_status: 'draft',
  });

  const again = await a.c.rpc('finance_save_bill', {
    target_org: a.orgId,
    bill: { id: saved.data, supplier_id: a.supplier, bill_date: daysFromToday(0), due_date: daysFromToday(14), notes: 'Changed' },
    lines: [{ description: 'Masks', quantity: 2, unit_price: 5 }],
  });
  expect(again.error, again.error?.message).toBeNull();
  expect(again.data).toBe(saved.data);
  expect(await totals(a.c, saved.data)).toMatchObject({ total: 10, display_status: 'draft' });
  const { data: lines } = await a.c.from('supplier_bill_lines').select('description').eq('bill_id', saved.data);
  expect(lines).toEqual([{ description: 'Masks' }]);

  const { error } = await a.c.from('supplier_bills').delete().eq('id', saved.data);
  expect(error, error?.message).toBeNull();
});

testWithSupabase('a bill needs a line before it can be saved or posted', async () => {
  const none = await saveBill(a, []);
  expect(none.error?.code).toBe('FIN10');
  const free = await saveBill(a, [{ description: 'Sample', quantity: 1, unit_price: 0 }]);
  expect(free.error, free.error?.message).toBeNull();
  const posted = await a.c.rpc('finance_post_bill', { target_org: a.orgId, target_bill: free.data });
  expect(posted.error?.code).toBe('FIN10');
});

testWithSupabase('posting gives the bill the next number and it becomes payable', async () => {
  const first = await postedBill(a);
  const second = await postedBill(a);
  expect(first.billNo).toBe('BILL-0001');
  expect(second.billNo).toBe('BILL-0002');
  expect(await totals(a.c, first.id)).toEqual({
    bill_no: 'BILL-0001', total: 132.5, paid: 0, balance: 132.5, display_status: 'pending',
  });
});

testWithSupabase('a posted bill cannot be edited, re-saved, given lines or deleted', async () => {
  const bill = await postedBill(a);
  const edit = await a.c.from('supplier_bills').update({ notes: 'Sneaky' }).eq('id', bill.id);
  expect(edit.error?.code).toBe('FIN01');
  const resave = await a.c.rpc('finance_save_bill', {
    target_org: a.orgId,
    bill: { id: bill.id, supplier_id: a.supplier, bill_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [GLOVES],
  });
  expect(resave.error?.code).toBe('FIN01');
  const line = await a.c
    .from('supplier_bill_lines')
    .insert({ org_id: a.orgId, bill_id: bill.id, description: 'Extra', quantity: 1, unit_price: 1 });
  expect(line.error?.code).toBe('FIN01');
  const remove = await a.c.from('supplier_bills').delete().eq('id', bill.id);
  expect(remove.error?.code).toBe('FIN01');
  const again = await a.c.rpc('finance_post_bill', { target_org: a.orgId, target_bill: bill.id });
  expect(again.error?.code).toBe('FIN01');
});

testWithSupabase('a paid payment reduces the balance; a scheduled one does not until it is marked paid', async () => {
  const bill = await postedBill(a);
  const paid = await pay(a, [{ bill_id: bill.id, amount: 100 }]);
  expect(paid.error, paid.error?.message).toBeNull();
  const scheduled = await pay(a, [{ bill_id: bill.id, amount: 32.5 }], 'scheduled');
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  expect(await totals(a.c, bill.id)).toMatchObject({ paid: 100, balance: 32.5, display_status: 'pending' });

  const { data: rows } = await a.c
    .from('finance_payments_out')
    .select('number, amount, status, bill_no, supplier_name, account_name')
    .eq('bill_id', bill.id)
    .order('amount', { ascending: false });
  expect(rows).toEqual([
    { number: expect.stringMatching(/^PV-\d{4}$/), amount: 100, status: 'posted', bill_no: bill.billNo, supplier_name: 'Supplier of Purchases A Sdn Bhd', account_name: 'Main Bank' },
    { number: null, amount: 32.5, status: 'scheduled', bill_no: bill.billNo, supplier_name: 'Supplier of Purchases A Sdn Bhd', account_name: 'Main Bank' },
  ]);

  const marked = await a.c.rpc('finance_mark_payment_paid', {
    target_org: a.orgId, target_txn: scheduled.data, paid_on: daysFromToday(0),
  });
  expect(marked.error, marked.error?.message).toBeNull();
  expect(marked.data).toMatch(/^PV-\d{4}$/);
  expect(await totals(a.c, bill.id)).toMatchObject({ paid: 132.5, balance: 0, display_status: 'paid' });
});

testWithSupabase('a payment cannot be more than is still owed, counting scheduled payments', async () => {
  const bill = await postedBill(a);
  const over = await pay(a, [{ bill_id: bill.id, amount: 132.51 }]);
  expect(over.error?.code).toBe('FIN05');
  const scheduled = await pay(a, [{ bill_id: bill.id, amount: 100 }], 'scheduled');
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  const second = await pay(a, [{ bill_id: bill.id, amount: 50 }]);
  expect(second.error?.code).toBe('FIN05');

  // Deleting the scheduled payment frees the amount.
  const removed = await a.c.from('finance_transactions').delete().eq('id', scheduled.data);
  expect(removed.error, removed.error?.message).toBeNull();
  const now = await pay(a, [{ bill_id: bill.id, amount: 50 }]);
  expect(now.error, now.error?.message).toBeNull();
});

testWithSupabase('two full payments at the same moment: only one goes through', async () => {
  const bill = await postedBill(a);
  const results = await Promise.all([
    pay(a, [{ bill_id: bill.id, amount: 132.5 }]),
    pay(a, [{ bill_id: bill.id, amount: 132.5 }]),
  ]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(results.find((r) => r.error)?.error?.code).toBe('FIN05');
  expect(await totals(a.c, bill.id)).toMatchObject({ paid: 132.5, balance: 0, display_status: 'paid' });
});

testWithSupabase('a payment cannot go against a draft bill', async () => {
  const draft = await saveBill(a);
  const result = await pay(a, [{ bill_id: draft.data, amount: 10 }]);
  expect(result.error?.code).toBe('FIN04');
});

testWithSupabase('a paid payment cannot be edited or deleted, only voided; voiding frees the bill', async () => {
  const bill = await postedBill(a);
  const paid = await pay(a, [{ bill_id: bill.id, amount: 132.5 }]);
  const edit = await a.c.from('finance_transactions').update({ amount: 1 }).eq('id', paid.data);
  expect(edit.error?.code).toBe('FIN09');
  const remove = await a.c.from('finance_transactions').delete().eq('id', paid.data);
  expect(remove.error?.code).toBe('FIN09');
  const split = await a.c.from('finance_allocations').update({ amount: 1 }).eq('transaction_id', paid.data);
  expect(split.error?.code).toBe('FIN09');

  // A bill with payments cannot be voided.
  const voidBill = await a.c.from('supplier_bills').update({ status: 'void' }).eq('id', bill.id);
  expect(voidBill.error?.code).toBe('FIN02');

  const voidPayment = await a.c.from('finance_transactions').update({ status: 'void' }).eq('id', paid.data);
  expect(voidPayment.error, voidPayment.error?.message).toBeNull();
  expect(await totals(a.c, bill.id)).toMatchObject({ paid: 0, balance: 132.5, display_status: 'pending' });

  const voidAgain = await a.c.from('supplier_bills').update({ status: 'void' }).eq('id', bill.id);
  expect(voidAgain.error, voidAgain.error?.message).toBeNull();
  expect(await totals(a.c, bill.id)).toMatchObject({ display_status: 'void' });
});

testWithSupabase('a scheduled payment is deleted, not voided', async () => {
  const bill = await postedBill(a);
  const scheduled = await pay(a, [{ bill_id: bill.id, amount: 10 }], 'scheduled');
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  const voided = await a.c.from('finance_transactions').update({ status: 'void' }).eq('id', scheduled.data);
  expect(voided.error?.code).toBe('FIN09');
  const removed = await a.c.from('finance_transactions').delete().eq('id', scheduled.data);
  expect(removed.error, removed.error?.message).toBeNull();
});

testWithSupabase('one payment can cover two bills from one supplier, but not two suppliers', async () => {
  const first = await postedBill(a);
  const second = await postedBill(a);
  const both = await pay(a, [{ bill_id: first.id, amount: 132.5 }, { bill_id: second.id, amount: 32.5 }]);
  expect(both.error, both.error?.message).toBeNull();
  const { data: txn } = await a.c.from('finance_transactions').select('amount, contact_id, direction').eq('id', both.data).single();
  expect(txn).toEqual({ amount: 165, contact_id: a.supplier, direction: 'out' });
  expect(await totals(a.c, second.id)).toMatchObject({ paid: 32.5, balance: 100 });

  const { data: other } = await a.c
    .from('finance_contacts')
    .insert({ org_id: a.orgId, name: 'Another supplier', is_supplier: true })
    .select('id')
    .single();
  const theirs = await saveBill({ ...a, supplier: other!.id });
  await a.c.rpc('finance_post_bill', { target_org: a.orgId, target_bill: theirs.data });
  const mixed = await pay(a, [{ bill_id: second.id, amount: 10 }, { bill_id: theirs.data, amount: 10 }]);
  expect(mixed.error?.code).toBe('FIN06');
});

testWithSupabase('a bill cannot be created already posted, or posted empty behind the function', async () => {
  const direct = await a.c.from('supplier_bills').insert({
    org_id: a.orgId, supplier_id: a.supplier, bill_no: 'BILL-SNEAKY', due_date: daysFromToday(30), status: 'posted',
  });
  expect(direct.error?.code).toBe('FIN01');

  const free = await saveBill(a, [{ description: 'Sample', quantity: 1, unit_price: 0 }]);
  const sneak = await a.c.from('supplier_bills').update({ status: 'posted', bill_no: 'BILL-SNEAKY' }).eq('id', free.data);
  expect(sneak.error?.code).toBe('FIN10');
});

testWithSupabase('a posted bill past its due date shows as overdue', async () => {
  const saved = await saveBill(a, [GLOVES], { bill_date: daysFromToday(-40), due_date: daysFromToday(-10) });
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await a.c.rpc('finance_post_bill', { target_org: a.orgId, target_bill: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  expect(await totals(a.c, saved.data)).toMatchObject({ balance: 132.5, display_status: 'overdue' });
});

testWithSupabase('another workspace cannot see or touch bills, payments or allocations', async () => {
  const bill = await postedBill(a);
  const paid = await pay(a, [{ bill_id: bill.id, amount: 10 }]);

  for (const table of ['supplier_bills', 'supplier_bill_lines', 'finance_transactions', 'finance_allocations', 'supplier_bill_totals', 'finance_payments_out']) {
    const { data } = await b.c.from(table).select('org_id').eq('org_id', a.orgId);
    expect(data ?? [], table).toEqual([]);
  }

  const save = await b.c.rpc('finance_save_bill', {
    target_org: a.orgId,
    bill: { supplier_id: a.supplier, bill_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [GLOVES],
  });
  expect(save.error?.code).toBe('42501');
  const post = await b.c.rpc('finance_post_bill', { target_org: a.orgId, target_bill: bill.id });
  expect(post.error).not.toBeNull();
  // B's own workspace, A's bill: the bill is not found there.
  const theirs = await pay(b, [{ bill_id: bill.id, amount: 10 }]);
  expect(theirs.error?.code).toBe('FIN06');
  const { data: changed } = await b.c.from('finance_transactions').update({ status: 'void' }).eq('id', paid.data).select('id');
  expect(changed ?? []).toEqual([]);
});

testWithSupabase('a supplier with bills cannot be deleted or stop being a supplier', async () => {
  await postedBill(a);
  const remove = await a.c.from('finance_contacts').delete().eq('id', a.supplier);
  expect(remove.error?.code).toBe('23503');
  const untick = await a.c.from('finance_contacts').update({ is_supplier: false, is_customer: true }).eq('id', a.supplier);
  expect(untick.error?.code).toBe('FIN07');
});

testWithSupabase('a demo viewer reads the seeded bills and payments but cannot write', async () => {
  const c = client();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await joinDemo(c);
  expect(error, error?.message).toBeNull();

  const { data: bills } = await c.from('supplier_bill_totals').select('id, supplier_id').eq('org_id', demoId);
  expect((bills ?? []).length).toBeGreaterThan(0);
  const { data: payments } = await c.from('finance_payments_out').select('number').eq('org_id', demoId);
  expect((payments ?? []).length).toBeGreaterThan(0);

  const write = await c.rpc('finance_save_bill', {
    target_org: demoId,
    bill: { supplier_id: bills![0].supplier_id, bill_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [GLOVES],
  });
  expect(write.error?.code).toBe('42501');
  const post = await c.rpc('finance_post_bill', { target_org: demoId, target_bill: bills![0].id });
  expect(post.error).not.toBeNull();
});
