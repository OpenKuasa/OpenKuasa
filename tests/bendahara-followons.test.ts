import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

function client(): SupabaseClient {
  return liveClient();
}

type Org = { c: SupabaseClient; orgId: string; bank: string; customer: string };

async function anonUserWithOrg(orgName: string): Promise<Org> {
  const c = client();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const { data: accounts } = await c.from('finance_accounts').select('id, name').eq('org_id', orgId);
  const bank = accounts?.find((a) => a.name === 'Main Bank')?.id as string;
  const { data: customer, error: customerErr } = await c
    .from('finance_contacts')
    .insert({ org_id: orgId, name: `Customer of ${orgName}`, is_customer: true, payment_terms_days: 14 })
    .select('id')
    .single();
  expect(customerErr, customerErr?.message).toBeNull();
  return { c, orgId: orgId as string, bank, customer: customer!.id as string };
}

function daysFromToday(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The YYYY-MM-DD date `days` after another. */
function daysAfter(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
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

function receive(o: Org, invoiceId: string, amount: number) {
  return o.c.rpc('finance_record_payment_in', {
    target_org: o.orgId,
    payment: { account_id: o.bank, txn_date: daysFromToday(0), method: 'fpx' },
    allocations: [{ invoice_id: invoiceId, amount }],
  });
}

function saveQuotation(o: Org, lines: object[] = [DESIGN], extra: object = {}) {
  return o.c.rpc('finance_save_quotation', {
    target_org: o.orgId,
    quotation: { customer_id: o.customer, quote_date: daysFromToday(0), valid_until: daysFromToday(30), ...extra },
    lines,
  });
}

/** A sent quotation of RM 132.50. */
async function sentQuotation(o: Org, extra: object = {}) {
  const saved = await saveQuotation(o, [DESIGN], extra);
  expect(saved.error, saved.error?.message).toBeNull();
  const sent = await o.c.rpc('finance_send_quotation', { target_org: o.orgId, target_quotation: saved.data });
  expect(sent.error, sent.error?.message).toBeNull();
  return { id: saved.data as string, quotationNo: sent.data as string };
}

function answer(o: Org, id: string, status: 'accepted' | 'declined') {
  const now = new Date().toISOString();
  return o.c
    .from('finance_quotations')
    .update({ status, accepted_at: status === 'accepted' ? now : null, updated_at: now })
    .eq('id', id)
    .select('id');
}

function saveCreditNote(o: Org, invoiceId: string, amount: number, extra: object = {}) {
  return o.c.rpc('finance_save_credit_note', {
    target_org: o.orgId,
    note: { invoice_id: invoiceId, credit_date: daysFromToday(0), reason: 'returns', amount, ...extra },
  });
}

/** An issued credit note. */
async function issuedCreditNote(o: Org, invoiceId: string, amount: number) {
  const saved = await saveCreditNote(o, invoiceId, amount);
  expect(saved.error, saved.error?.message).toBeNull();
  const issued = await o.c.rpc('finance_issue_credit_note', { target_org: o.orgId, target_note: saved.data });
  expect(issued.error, issued.error?.message).toBeNull();
  return { id: saved.data as string, creditNoteNo: issued.data as string };
}

function refund(o: Org, against: { invoice_id?: string; credit_note_id?: string }, amount: number, status: 'posted' | 'scheduled' = 'posted') {
  return o.c.rpc('finance_record_refund', {
    target_org: o.orgId,
    refund: { ...against, account_id: o.bank, txn_date: daysFromToday(0), method: 'fpx', reason: 'damaged_goods', amount, status },
  });
}

async function totals(c: SupabaseClient, invoiceId: string) {
  const { data, error } = await c
    .from('finance_invoice_totals')
    .select('total, paid, credited, refunded, balance, display_status')
    .eq('id', invoiceId)
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

let a: Org;
let b: Org;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  a = await anonUserWithOrg('Follow-ons A Sdn Bhd');
  b = await anonUserWithOrg('Follow-ons B Sdn Bhd');
});

testWithSupabase('a draft quotation has no number; sending gives it the next one and locks it', async () => {
  const saved = await saveQuotation(a);
  expect(saved.error, saved.error?.message).toBeNull();
  const { data: draft } = await a.c
    .from('finance_quotation_totals')
    .select('quotation_no, total, display_status, invoice_id')
    .eq('id', saved.data)
    .single();
  expect(draft).toEqual({ quotation_no: null, total: 132.5, display_status: 'draft', invoice_id: null });

  const none = await saveQuotation(a, []);
  expect(none.error?.code).toBe('FIN10');
  const direct = await a.c.from('finance_quotations').insert({
    org_id: a.orgId, customer_id: a.customer, quotation_no: 'QT-SNEAKY', valid_until: daysFromToday(30), status: 'sent',
    sent_at: new Date().toISOString(),
  });
  expect(direct.error?.code).toBe('FIN01');
  expect((await answer(a, saved.data, 'accepted')).error?.code).toBe('FIN01');

  const sent = await a.c.rpc('finance_send_quotation', { target_org: a.orgId, target_quotation: saved.data });
  expect(sent.error, sent.error?.message).toBeNull();
  expect(sent.data).toMatch(/^QT-\d{4}$/);

  const edit = await a.c.from('finance_quotations').update({ notes: 'Sneaky' }).eq('id', saved.data);
  expect(edit.error?.code).toBe('FIN01');
  const line = await a.c
    .from('finance_quotation_lines')
    .insert({ org_id: a.orgId, quotation_id: saved.data, description: 'Extra', quantity: 1, unit_price: 1 });
  expect(line.error?.code).toBe('FIN01');
  const remove = await a.c.from('finance_quotations').delete().eq('id', saved.data);
  expect(remove.error?.code).toBe('FIN01');
  const again = await a.c.rpc('finance_send_quotation', { target_org: a.orgId, target_quotation: saved.data });
  expect(again.error?.code).toBe('FIN01');
});

testWithSupabase('a sent quotation past its date shows as expired, and can still be accepted', async () => {
  const quotation = await sentQuotation(a, { quote_date: daysFromToday(-40), valid_until: daysFromToday(-10) });
  const status = async () =>
    (await a.c.from('finance_quotation_totals').select('display_status').eq('id', quotation.id).single()).data?.display_status;
  expect(await status()).toBe('expired');
  const noDate = await a.c.from('finance_quotations').update({ status: 'accepted' }).eq('id', quotation.id);
  expect(noDate.error?.code).toBe('23514');
  expect((await answer(a, quotation.id, 'accepted')).error).toBeNull();
  expect(await status()).toBe('accepted');
  expect((await answer(a, quotation.id, 'declined')).error).toBeNull();
  expect(await status()).toBe('declined');
});

testWithSupabase('an accepted quotation becomes one draft invoice with the same lines, and only one', async () => {
  const quotation = await sentQuotation(a);
  const early = await a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(early.error?.code).toBe('FIN04');
  expect((await answer(a, quotation.id, 'accepted')).error).toBeNull();

  // The app sends the date on the person's own calendar, which is not always the database's: three days
  // ago here, so the test cannot pass by the database using its own date.
  const given = daysFromToday(-3);
  const converted = await a.c.rpc('finance_convert_quotation', {
    target_org: a.orgId,
    target_quotation: quotation.id,
    invoice_date: given,
  });
  expect(converted.error, converted.error?.message).toBeNull();
  const { data: invoice } = await a.c
    .from('finance_invoices')
    .select('status, customer_id, quotation_id, invoice_no, invoice_date, due_date')
    .eq('id', converted.data)
    .single();
  // The invoice carries the date it was given. The customer's payment terms are 14 days, counted from that date.
  expect(invoice).toEqual({
    status: 'draft', customer_id: a.customer, quotation_id: quotation.id, invoice_no: null,
    invoice_date: given, due_date: daysAfter(given, 14),
  });
  const { data: lines } = await a.c.from('finance_invoice_lines').select('description, amount, sst_amount').eq('invoice_id', converted.data);
  expect(lines).toEqual([{ description: 'Design work', amount: 125, sst_amount: 7.5 }]);
  const { data: linked } = await a.c.from('finance_quotation_totals').select('invoice_id, invoice_no').eq('id', quotation.id).single();
  expect(linked).toEqual({ invoice_id: converted.data, invoice_no: null });

  const twice = await a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(twice.error?.code).toBe('FIN13');
  expect((await answer(a, quotation.id, 'declined')).error?.code).toBe('FIN13');
  const byHand = await a.c
    .from('finance_invoices')
    .insert({ org_id: a.orgId, customer_id: a.customer, due_date: daysFromToday(30), quotation_id: quotation.id });
  expect(byHand.error?.code).toBe('23505');

  // Deleting the draft invoice frees the quotation.
  const removed = await a.c.from('finance_invoices').delete().eq('id', converted.data);
  expect(removed.error, removed.error?.message).toBeNull();
  // With no date, as the code deployed before the date was added calls it: the one function still answers,
  // and dates the invoice with the database's UTC date. Across midnight UTC that is one of the two days this
  // machine saw either side of the call, so neither is assumed.
  const dayBefore = daysFromToday(0);
  const again = await a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(again.error, again.error?.message).toBeNull();
  const dayAfter = daysFromToday(0);
  const { data: undated } = await a.c.from('finance_invoices').select('invoice_date, due_date').eq('id', again.data).single();
  expect([dayBefore, dayAfter]).toContain(undated!.invoice_date);
  expect(undated!.due_date).toBe(daysAfter(undated!.invoice_date, 14));
});

testWithSupabase('changing the customer of an invoice made from a quotation unties it, and the quotation converts again', async () => {
  const quotation = await sentQuotation(a);
  expect((await answer(a, quotation.id, 'accepted')).error).toBeNull();
  const converted = await a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(converted.error, converted.error?.message).toBeNull();
  const { data: other, error: otherErr } = await a.c
    .from('finance_contacts')
    .insert({ org_id: a.orgId, name: 'Another customer of Follow-ons A', is_customer: true })
    .select('id')
    .single();
  expect(otherErr, otherErr?.message).toBeNull();

  // Saved again for the same customer, the invoice keeps its quotation.
  const same = await a.c.rpc('finance_save_invoice', {
    target_org: a.orgId,
    invoice: { id: converted.data, customer_id: a.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(14) },
    lines: [DESIGN],
  });
  expect(same.error, same.error?.message).toBeNull();
  const tie = async () =>
    (await a.c.from('finance_invoices').select('customer_id, quotation_id').eq('id', converted.data).single()).data;
  expect(await tie()).toEqual({ customer_id: a.customer, quotation_id: quotation.id });

  // Saved for another customer, it lets go of the quotation, which is free again.
  const moved = await a.c.rpc('finance_save_invoice', {
    target_org: a.orgId,
    invoice: { id: converted.data, customer_id: other!.id, invoice_date: daysFromToday(0), due_date: daysFromToday(14) },
    lines: [DESIGN],
  });
  expect(moved.error, moved.error?.message).toBeNull();
  expect(await tie()).toEqual({ customer_id: other!.id, quotation_id: null });
  const { data: linked } = await a.c.from('finance_quotation_totals').select('invoice_id, invoice_no').eq('id', quotation.id).single();
  expect(linked).toEqual({ invoice_id: null, invoice_no: null });

  const again = await a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(again.error, again.error?.message).toBeNull();
  expect(again.data).not.toBe(converted.data);
  const { data: second } = await a.c.from('finance_invoices').select('customer_id, quotation_id').eq('id', again.data).single();
  expect(second).toEqual({ customer_id: a.customer, quotation_id: quotation.id });
});

testWithSupabase('two conversions of one quotation at the same moment: only one invoice is made', async () => {
  const quotation = await sentQuotation(a);
  expect((await answer(a, quotation.id, 'accepted')).error).toBeNull();
  const convert = () => a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  const results = await Promise.all([convert(), convert()]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(['FIN13', '23505']).toContain(results.find((r) => r.error)?.error?.code);
  const { data: invoices } = await a.c.from('finance_invoices').select('id').eq('quotation_id', quotation.id);
  expect(invoices).toHaveLength(1);
});

testWithSupabase('an issued credit note lowers what the invoice owes; a draft does not', async () => {
  const invoice = await postedInvoice(a);
  const saved = await saveCreditNote(a, invoice, 30);
  expect(saved.error, saved.error?.message).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ credited: 0, balance: 132.5, display_status: 'sent' });
  const tooMuch = await saveCreditNote(a, invoice, 132.51);
  expect(tooMuch.error?.code).toBe('FIN05');
  const direct = await a.c.from('finance_credit_notes').insert({
    org_id: a.orgId, invoice_id: invoice, credit_note_no: 'CN-SNEAKY', amount: 1, status: 'issued', issued_at: new Date().toISOString(),
  });
  expect(direct.error?.code).toBe('FIN01');

  const issued = await a.c.rpc('finance_issue_credit_note', { target_org: a.orgId, target_note: saved.data });
  expect(issued.error, issued.error?.message).toBeNull();
  expect(issued.data).toMatch(/^CN-\d{4}$/);
  expect(await totals(a.c, invoice)).toEqual({ total: 132.5, paid: 0, credited: 30, refunded: 0, balance: 102.5, display_status: 'sent' });

  const edit = await a.c.from('finance_credit_notes').update({ amount: 1 }).eq('id', saved.data);
  expect(edit.error?.code).toBe('FIN01');
  const remove = await a.c.from('finance_credit_notes').delete().eq('id', saved.data);
  expect(remove.error?.code).toBe('FIN01');

  // What a payment in may take is what the screen shows as owed: a sen more is refused.
  expect((await receive(a, invoice, 102.51)).error?.code).toBe('FIN05');
  expect((await receive(a, invoice, 102.5)).error).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ paid: 102.5, balance: 0, display_status: 'paid' });

  // An invoice with a credit note cannot be voided, whatever else is on it.
  const voidInvoice = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice);
  expect(['FIN02', 'FIN12']).toContain(voidInvoice.error?.code);
});

testWithSupabase('an invoice with a credit note, and no money on it, cannot be voided until the note is', async () => {
  const invoice = await postedInvoice(a);
  const note = await issuedCreditNote(a, invoice, 32.5);
  const held = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice);
  expect(held.error?.code).toBe('FIN12');
  const voided = await a.c.from('finance_credit_notes').update({ status: 'void', updated_at: new Date().toISOString() }).eq('id', note.id);
  expect(voided.error, voided.error?.message).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ credited: 0, balance: 132.5 });
  const free = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice);
  expect(free.error, free.error?.message).toBeNull();
});

testWithSupabase('a refund pays out a customer’s credit, to the sen, and a pending refund holds it', async () => {
  const invoice = await postedInvoice(a);
  expect((await receive(a, invoice, 132.5)).error).toBeNull();
  // Paid in full and owed nothing: there is nothing to refund yet.
  expect((await refund(a, { invoice_id: invoice }, 1)).error?.code).toBe('FIN04');

  const note = await issuedCreditNote(a, invoice, 30);
  expect(await totals(a.c, invoice)).toEqual({ total: 132.5, paid: 132.5, credited: 30, refunded: 0, balance: -30, display_status: 'paid' });
  expect((await receive(a, invoice, 0.01)).error?.code).toBe('FIN05');
  expect((await refund(a, { invoice_id: invoice }, 30.01)).error?.code).toBe('FIN05');

  const pending = await refund(a, { credit_note_id: note.id }, 20, 'scheduled');
  expect(pending.error, pending.error?.message).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ refunded: 0, balance: -30 });
  expect((await refund(a, { invoice_id: invoice }, 10.01)).error?.code).toBe('FIN05');
  const now = await refund(a, { invoice_id: invoice }, 10);
  expect(now.error, now.error?.message).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ refunded: 10, balance: -20 });

  const { data: rows } = await a.c
    .from('finance_refunds')
    .select('transaction_id, number, amount, status, reason, invoice_id, credit_note_no, customer_name')
    .eq('invoice_id', invoice)
    .order('amount', { ascending: false });
  expect(rows).toEqual([
    {
      transaction_id: pending.data, number: null, amount: 20, status: 'scheduled', reason: 'damaged_goods',
      invoice_id: invoice, credit_note_no: note.creditNoteNo, customer_name: 'Customer of Follow-ons A Sdn Bhd',
    },
    {
      transaction_id: now.data, number: expect.stringMatching(/^PV-\d{4}$/), amount: 10, status: 'posted', reason: 'damaged_goods',
      invoice_id: invoice, credit_note_no: null, customer_name: 'Customer of Follow-ons A Sdn Bhd',
    },
  ]);

  // Nothing a refund leans on can be voided.
  const voidNote = await a.c.from('finance_credit_notes').update({ status: 'void' }).eq('id', note.id);
  expect(voidNote.error?.code).toBe('FIN02');
  const voidInvoice = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice);
  expect(voidInvoice.error?.code).toBe('FIN02');

  const paid = await a.c.rpc('finance_mark_payment_paid', { target_org: a.orgId, target_txn: pending.data, paid_on: daysFromToday(0) });
  expect(paid.error, paid.error?.message).toBeNull();
  expect(paid.data).toMatch(/^PV-\d{4}$/);
  expect(await totals(a.c, invoice)).toEqual({ total: 132.5, paid: 132.5, credited: 30, refunded: 30, balance: 0, display_status: 'paid' });

  // A refund is not a payment to a supplier and not a payment in.
  const { data: out } = await a.c.from('finance_payments_out').select('allocation_id').in('transaction_id', [pending.data, now.data]);
  expect(out).toEqual([]);
  const { data: moneyIn } = await a.c.from('finance_payments_in').select('allocation_id').in('transaction_id', [pending.data, now.data]);
  expect(moneyIn).toEqual([]);

  // Paid out, it can only be voided, which puts the credit back.
  const remove = await a.c.from('finance_transactions').delete().eq('id', now.data);
  expect(remove.error?.code).toBe('FIN09');
  const voided = await a.c.from('finance_transactions').update({ status: 'void' }).eq('id', now.data);
  expect(voided.error, voided.error?.message).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ refunded: 20, balance: -10 });
});

testWithSupabase('a refund against a credit note needs the customer to be in credit, and is never more than the note', async () => {
  const unpaid = await postedInvoice(a);
  const onUnpaid = await issuedCreditNote(a, unpaid, 30);
  // The invoice still owes RM 102.50: a credit note alone is not money to give back.
  expect((await refund(a, { credit_note_id: onUnpaid.id }, 30)).error?.code).toBe('FIN04');

  const paid = await postedInvoice(a);
  expect((await receive(a, paid, 132.5)).error).toBeNull();
  const small = await issuedCreditNote(a, paid, 20);
  await issuedCreditNote(a, paid, 50);
  // RM 70 in credit, but the small note is RM 20.
  expect((await refund(a, { credit_note_id: small.id }, 20.01)).error?.code).toBe('FIN05');
  expect((await refund(a, { credit_note_id: small.id }, 20)).error).toBeNull();
  expect((await refund(a, { credit_note_id: small.id }, 0.01)).error?.code).toBe('FIN05');
  expect(await totals(a.c, paid)).toMatchObject({ credited: 70, refunded: 20, balance: -50 });
});

testWithSupabase('two refunds of the whole credit at the same moment: only one goes through', async () => {
  const invoice = await postedInvoice(a);
  expect((await receive(a, invoice, 132.5)).error).toBeNull();
  await issuedCreditNote(a, invoice, 30);
  const results = await Promise.all([refund(a, { invoice_id: invoice }, 30), refund(a, { invoice_id: invoice }, 30)]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(['FIN04', 'FIN05']).toContain(results.find((r) => r.error)?.error?.code);
  expect(await totals(a.c, invoice)).toMatchObject({ refunded: 30, balance: 0 });
});

testWithSupabase('two credit notes for the whole invoice at the same moment: only one is issued', async () => {
  const invoice = await postedInvoice(a);
  const first = await saveCreditNote(a, invoice, 132.5);
  const second = await saveCreditNote(a, invoice, 132.5);
  expect(first.error ?? second.error).toBeNull();
  const issue = (id: string) => a.c.rpc('finance_issue_credit_note', { target_org: a.orgId, target_note: id });
  const results = await Promise.all([issue(first.data), issue(second.data)]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(results.find((r) => r.error)?.error?.code).toBe('FIN05');
  expect(await totals(a.c, invoice)).toMatchObject({ credited: 132.5, balance: 0, display_status: 'paid' });
});

testWithSupabase('another workspace cannot see or touch quotations, credit notes or refunds', async () => {
  const quotation = await sentQuotation(a);
  const invoice = await postedInvoice(a);
  expect((await receive(a, invoice, 132.5)).error).toBeNull();
  const note = await issuedCreditNote(a, invoice, 30);
  expect((await refund(a, { credit_note_id: note.id }, 10)).error).toBeNull();

  for (const table of [
    'finance_quotations', 'finance_quotation_lines', 'finance_quotation_totals',
    'finance_credit_notes', 'finance_credit_note_totals', 'finance_refunds',
  ]) {
    const { data } = await b.c.from(table).select('org_id').eq('org_id', a.orgId);
    expect(data ?? [], table).toEqual([]);
  }

  const save = await b.c.rpc('finance_save_quotation', {
    target_org: a.orgId,
    quotation: { customer_id: a.customer, quote_date: daysFromToday(0), valid_until: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(save.error?.code).toBe('42501');
  const convert = await b.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(convert.error?.code).toBe('FIN11');
  // B's own workspace, A's invoice: the invoice is not found there.
  expect((await saveCreditNote(b, invoice, 1)).error?.code).toBe('23503');
  expect((await refund(b, { invoice_id: invoice }, 1)).error?.code).toBe('FIN06');
  const { data: voided } = await b.c.from('finance_credit_notes').update({ status: 'void' }).eq('id', note.id).select('id');
  expect(voided ?? []).toEqual([]);
  const { data: answered } = await answer(b, quotation.id, 'accepted');
  expect(answered ?? []).toEqual([]);
});

testWithSupabase('a customer with quotations cannot stop being a customer', async () => {
  const { data: prospect } = await a.c
    .from('finance_contacts')
    .insert({ org_id: a.orgId, name: 'Prospect with a quotation', is_customer: true })
    .select('id')
    .single();
  const saved = await saveQuotation({ ...a, customer: prospect!.id });
  expect(saved.error, saved.error?.message).toBeNull();
  const untick = await a.c.from('finance_contacts').update({ is_customer: false, is_supplier: true }).eq('id', prospect!.id);
  expect(untick.error?.code).toBe('FIN08');
});

// Needs 20261022100100_bendahara_sales_followons_seed.sql: until the controller has applied it, this one test fails.
testWithSupabase('a demo viewer reads the seeded quotations, credit notes and refunds, and can write none', async () => {
  const c = client();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await joinDemo(c);
  expect(error, error?.message).toBeNull();

  const { data: quotations } = await c.from('finance_quotation_totals').select('id, quotation_no, display_status').eq('org_id', demoId);
  // Dates are relative to the day the seed ran, so Sent turns into Expired as time passes: only what cannot drift is asserted.
  expect((quotations ?? []).length).toBe(15);
  expect((quotations ?? []).filter((q) => q.display_status === 'accepted')).toHaveLength(6);
  expect((quotations ?? []).filter((q) => q.display_status === 'draft').every((q) => q.quotation_no === null)).toBe(true);

  const { data: notes } = await c.from('finance_credit_note_totals').select('id, credit_note_no, status, amount').eq('org_id', demoId);
  expect((notes ?? []).filter((n) => n.status === 'issued')).toHaveLength(8);
  expect((notes ?? []).filter((n) => n.status === 'issued').reduce((sum, n) => sum + Number(n.amount), 0)).toBe(3890);

  const { data: refunds } = await c.from('finance_refunds').select('status, amount, number').eq('org_id', demoId);
  expect((refunds ?? []).filter((r) => r.status === 'posted').reduce((sum, r) => sum + Number(r.amount), 0)).toBe(1770);
  expect((refunds ?? []).filter((r) => r.status === 'scheduled').reduce((sum, r) => sum + Number(r.amount), 0)).toBe(1000);
  expect((refunds ?? []).every((r) => (r.status === 'posted') === /^PV-\d+$/.test(r.number ?? ''))).toBe(true);

  // No seeded customer is refunded beyond their credit, and three invoices are still in credit.
  const { data: invoices } = await c.from('finance_invoice_totals').select('balance, status').eq('org_id', demoId).lt('balance', 0);
  expect((invoices ?? []).reduce((sum, i) => sum - Number(i.balance), 0)).toBe(1600);

  const sent = (quotations ?? []).find((q) => q.display_status !== 'draft')!;
  const save = await c.rpc('finance_save_quotation', {
    target_org: demoId,
    quotation: { customer_id: crypto.randomUUID(), quote_date: daysFromToday(0), valid_until: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(save.error?.code).toBe('42501');
  const convert = await c.rpc('finance_convert_quotation', { target_org: demoId, target_quotation: sent.id });
  expect(convert.error?.code).toBe('FIN11');
  const pay = await c.rpc('finance_record_refund', {
    target_org: demoId,
    refund: { credit_note_id: notes![0].id, account_id: crypto.randomUUID(), method: 'fpx', amount: 1 },
  });
  expect(pay.error?.code).toBe('42501');
  const { data: voided } = await c.from('finance_credit_notes').update({ status: 'void' }).eq('id', notes![0].id).select('id');
  expect(voided ?? []).toEqual([]);
});
