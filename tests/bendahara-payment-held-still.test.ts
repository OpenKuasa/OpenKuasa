import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { deleteScheduledPayment, listAccounts, listPaymentsOut, markPaymentPaid, recordPaymentOut } from '@/lib/finance/money';
import { NEEDS_SIGN_OFF } from '@/lib/finance/result';

// A payment that is to be paid, against the hosted database. Run by the controller only, after
// 20261117090000_bendahara_payment_held_still is applied: until then the database takes every direct edit below
// and most of this file fails. What each role is answered for every column and every status, and the order the
// triggers answer in, are proved by supabase/tests/bendahara_payment_held_still_check.sql. This file adds what
// only the API shows: that FIN28 arrives through PostgREST for a member's and an owner's direct call, on the payment
// and on its split, and that everything Payments Out offers (schedule, mark paid on another day, delete) goes on
// working through the screen's own functions. The smoke account is an owner, so a browser pass cannot show what a
// member is answered: a member is invited here. The helper deletes the workspace it makes.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const HELD = 'FIN28';

type Ctx = { client: SupabaseClient; orgId: string };

function daysFromToday(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A posted bill of RM 132.50 from the supplier. */
async function postedBill(owner: Ctx, supplierId: string): Promise<string> {
  const bill = await owner.client.rpc('finance_save_bill', {
    target_org: owner.orgId,
    bill: { supplier_id: supplierId, bill_date: daysFromToday(0), due_date: daysFromToday(0) },
    lines: [{ description: 'Design work', quantity: 10, unit_price: 12.5, sst_rate: 6 }],
  });
  expect(bill.error, bill.error?.message).toBeNull();
  const posted = await owner.client.rpc('finance_post_bill', { target_org: owner.orgId, target_bill: bill.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return bill.data as string;
}

/** The payment's one row on Payments Out, as the screen reads it. */
async function rowOf(ctx: Ctx, id: string) {
  const rows = (await listPaymentsOut(ctx)).filter((p) => p.transaction_id === id);
  expect(rows, `payment ${id} is one row on Payments Out`).toHaveLength(1);
  return rows[0];
}

testWithSupabase('a payment a member scheduled stays as it was scheduled, for the member and for the owner, until it is paid or deleted', async () => {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, `Held still ${Date.now()}`);
  expect(error, error?.message).toBeNull();
  // A member needs an address to accept an invite sent to it; see finance-write-guards.rls.test.ts.
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'held-still-member-pass-123');
  const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  const owner: Ctx = { client: c, orgId: orgId as string };
  const member: Ctx = { client: m, orgId: orgId as string };
  const accounts = await listAccounts(owner);
  const bank = accounts.find((a) => a.kind === 'bank')!.id;
  const cash = accounts.find((a) => a.kind === 'cash')!.id;

  const one = await c.from('finance_contacts').insert({ org_id: orgId, name: 'Syarikat Maju', is_customer: false, is_supplier: true }).select('id').single();
  expect(one.error, one.error?.message).toBeNull();
  const two = await c.from('finance_contacts').insert({ org_id: orgId, name: 'Kedai Lain', is_customer: false, is_supplier: true }).select('id').single();
  expect(two.error, two.error?.message).toBeNull();
  const bill = await postedBill(owner, one.data!.id as string);
  const otherBill = await postedBill(owner, two.data!.id as string);

  // The member schedules RM 100 against the first supplier's bill, as Payments Out does.
  const payment = { account_id: bank, txn_date: daysFromToday(0), method: 'fpx' as const, reference: 'REF-1', notes: null, scheduled: true };
  const scheduled = await recordPaymentOut(member, { ...payment, allocations: [{ bill_id: bill, amount: 100 }] });
  expect(scheduled).toMatchObject({ ok: true });
  if (!scheduled.ok) return;
  const id = scheduled.data.id;
  const shown = await rowOf(owner, id);
  expect(shown).toMatchObject({ status: 'scheduled', transaction_amount: 100, amount: 100, account_id: bank, bill_id: bill, reference: 'REF-1', number: null, txn_date: daysFromToday(0) });

  // By a direct call, as the member and as the owner: back to draft, with an edit or as it stands, and every edit where it stands.
  for (const who of [m, c]) {
    for (const change of [
      { account_id: cash },
      { txn_date: daysFromToday(9) },
      { reference: 'OTHER' },
      { notes: 'changed' },
      { method: 'cash' },
      { contact_id: two.data!.id },
      { status: 'draft', reference: 'OTHER' },
      { status: 'draft' },
    ]) {
      const edit = await who.from('finance_transactions').update(change).eq('id', id).select('id');
      expect(edit.error?.code, JSON.stringify(change)).toBe(HELD);
    }
    const repoint = await who.from('finance_allocations').update({ bill_id: otherBill }).eq('transaction_id', id).select('id');
    expect(repoint.error?.code).toBe(HELD);
  }
  // A change of nothing but the time is not an edit.
  const touched = await m.from('finance_transactions').update({ updated_at: new Date().toISOString() }).eq('id', id).select('id');
  expect(touched.error, touched.error?.message).toBeNull();
  expect(touched.data).toEqual([{ id }]);
  // What the owner was shown is what is there.
  expect(await rowOf(owner, id)).toEqual(shown);

  // Marking it paid is an owner's or admin's, on the day they say; the rest of it is as it was scheduled.
  expect(await markPaymentPaid(member, { id, paid_on: daysFromToday(0) })).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
  const paid = await markPaymentPaid(owner, { id, paid_on: daysFromToday(-1) });
  expect(paid).toMatchObject({ ok: true });
  const after = await rowOf(owner, id);
  expect(after).toMatchObject({ status: 'posted', transaction_amount: 100, account_id: bank, bill_id: bill, reference: 'REF-1', txn_date: daysFromToday(-1) });
  expect(after.number).toMatch(/^PV-\d{4}$/);

  // A member still deletes a payment that is to be paid, and its split goes with it.
  const second = await recordPaymentOut(member, { ...payment, allocations: [{ bill_id: otherBill, amount: 20 }] });
  expect(second).toMatchObject({ ok: true });
  if (!second.ok) return;
  expect(await deleteScheduledPayment(member, { id: second.data.id })).toEqual({ ok: true, data: { id: second.data.id } });
  const left = await c.from('finance_allocations').select('id').eq('transaction_id', second.data.id);
  expect(left.error, left.error?.message).toBeNull();
  expect(left.data).toEqual([]);

  // An owner does not send one back to draft either, with the time of the change sent along as the app would send it.
  const third = await recordPaymentOut(member, { ...payment, allocations: [{ bill_id: otherBill, amount: 20 }] });
  expect(third).toMatchObject({ ok: true });
  if (!third.ok) return;
  const reopened = await c.from('finance_transactions').update({ status: 'draft', updated_at: new Date().toISOString() }).eq('id', third.data.id).select('id');
  expect(reopened.error?.code).toBe(HELD);
  expect((await rowOf(owner, third.data.id)).status).toBe('scheduled');
  expect(await deleteScheduledPayment(member, { id: third.data.id })).toEqual({ ok: true, data: { id: third.data.id } });
});
