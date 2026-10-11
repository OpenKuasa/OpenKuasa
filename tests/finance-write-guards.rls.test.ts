/**
 * Live test of who may sign a finance document off, against the real database.
 * It needs 20261030123000_finance_write_guards.sql applied; until then the
 * member's posts, payments and voids succeed and this file fails. Skipped
 * without Supabase env vars.
 *
 * One workspace with its owner and a member (role `member`, a writer). The
 * member writes drafts and schedules; posting, paying and voiding are refused
 * to them with FIN14 and work for the owner. The columns of a payment that
 * only the database writes are refused to both.
 *
 * Workspaces and users come from tests/helpers/live-workspaces.ts, which also
 * removes them.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInAnon } from './helpers/live-workspaces';

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
  const signedIn = await signInAnon(c);
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
      { org_id: orgId, name: 'Guarded Customer', is_customer: true },
      { org_id: orgId, name: 'Guarded Supplier', is_supplier: true },
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
