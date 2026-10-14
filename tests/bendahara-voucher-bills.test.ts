import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { listBills } from '@/lib/finance/bills';
import { listPaymentVouchers } from '@/lib/finance/cash-book';
import { listExpenseCategories } from '@/lib/finance/expenses';
import { listAccounts, listPaymentsOut } from '@/lib/finance/money';
import { listPurchaseOrders } from '@/lib/finance/purchase-orders';
import { orderNotesForBills } from '@/lib/finance/purchase-views';
import {
  chooseVoucherKind,
  chooseVoucherSupplier,
  draftVoucherForm,
  hasBillVoucherWaiting,
  newVoucherForm,
  orderNotesByVoucher,
  voucherActions,
  voucherDecisionPayload,
  voucherFormError,
  voucherKindLink,
  voucherPayableBills,
  voucherQuestion,
  voucherSavePayload,
} from '@/lib/finance/voucher-form';
import { VOUCHER_MESSAGES, approveVoucher, deleteVoucher, rejectVoucher, saveVoucher, submitVoucher } from '@/lib/finance/vouchers';

// A voucher for a supplier's bills against the hosted database, through the
// screen's own read and write functions with a real client. Run by the
// controller only, after 20261117100000_bendahara_save_voucher is applied:
// until then every test here fails on finance_save_voucher. The first test is
// the measure of this stage, end to end: a purchase order billed over its
// total, a member's voucher for that bill sent for approval, the owner's
// Approve question carrying the over-billing note, and the approved voucher
// "To be paid" exactly as it was sent. The smoke account is an owner, so a
// browser pass cannot show the member's half: this file does. Every workspace
// is made through tests/helpers/live-workspaces.ts, which deletes what it
// creates.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const M = VOUCHER_MESSAGES;

type Ctx = { client: SupabaseClient; orgId: string };
type Workspace = { owner: Ctx; member: Ctx; supplier: string; order: string; bill: string };

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A workspace with an owner and a member, a supplier, a purchase order of RM 132.50 the owner approved, and one
 * posted bill of RM 300.00 raised against it: the order is billed over its total.
 */
async function overBilledWorkspace(orgName: string): Promise<Workspace> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'voucher-bills-member-pass-123');
  const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();

  const supplier = await c.from('finance_contacts').insert({ org_id: orgId, name: 'Syarikat Maju', is_customer: false, is_supplier: true }).select('id').single();
  expect(supplier.error, supplier.error?.message).toBeNull();
  const order = await c.rpc('finance_save_purchase_order', {
    target_org: orgId,
    purchase_order: { supplier_id: supplier.data!.id, po_date: today() },
    lines: [{ description: 'A4 paper', quantity: 10, unit_price: 12.5, sst_rate: 6 }], // RM 132.50
  });
  expect(order.error, order.error?.message).toBeNull();
  expect((await c.rpc('finance_submit_purchase_order', { target_org: orgId, target_po: order.data })).error).toBeNull();
  const approved = await c.rpc('finance_decide_purchase_order', { target_org: orgId, target_po: order.data, approve: true, reason: null });
  expect(approved.error, approved.error?.message).toBeNull();
  const bill = await c.rpc('finance_save_bill', {
    target_org: orgId,
    bill: { supplier_id: supplier.data!.id, bill_date: today(), due_date: today(), purchase_order_id: order.data },
    lines: [{ description: 'A4 paper, and more', quantity: 10, unit_price: 30, sst_rate: 0 }], // RM 300.00
  });
  expect(bill.error, bill.error?.message).toBeNull();
  const posted = await c.rpc('finance_post_bill', { target_org: orgId, target_bill: bill.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return {
    owner: { client: c, orgId: orgId as string },
    member: { client: m, orgId: orgId as string },
    supplier: supplier.data!.id as string,
    order: order.data as string,
    bill: bill.data as string,
  };
}

/** What the screen's loader reads for someone who may write. */
async function screen(ctx: Ctx) {
  const [rows, accounts, categories, payments, bills, orders] = await Promise.all([
    listPaymentVouchers(ctx),
    listAccounts(ctx),
    listExpenseCategories(ctx),
    listPaymentsOut(ctx),
    listBills(ctx),
    listPurchaseOrders(ctx),
  ]);
  return { rows, accounts, categories, payments, bills, orders: orders.filter((o) => o.status === 'approved' || o.status === 'closed') };
}

/** The form a person fills in for RM `amount` of the workspace's one bill, as the card holds it. */
function billForm(w: Workspace, s: Awaited<ReturnType<typeof screen>>, amount: string) {
  const fresh = chooseVoucherSupplier(chooseVoucherKind(newVoucherForm(s.accounts, s.categories, today()), 'bills'), w.supplier);
  return { ...fresh, amounts: { [w.bill]: amount }, method: 'fpx' as const };
}

testWithSupabase('a member sends a voucher for an over-billed order’s bill; the owner’s Approve carries the note and leaves it To be paid as sent', async () => {
  const w = await overBilledWorkspace(`Voucher bills approve ${Date.now()}`);

  // The member's form: the bill is offered for all of it, and the note is under the ticked bill before anything is sent.
  const mine = await screen(w.member);
  const payable = voucherPayableBills(mine.bills, mine.payments, null);
  expect(payable.map((b) => [b.id, b.payable])).toEqual([[w.bill, 300]]);
  const form = billForm(w, mine, '100');
  expect(voucherFormError(form, payable)).toBeNull();
  const formNote = orderNotesForBills(payable.filter((b) => b.id in form.amounts), mine.orders);
  expect(formNote).toHaveLength(1);
  expect(formNote[0]).toContain('whose bills come to RM 300.00, over its total of RM 132.50.');

  const sent = await saveVoucher(w.member, voucherSavePayload(form, true));
  expect(sent).toMatchObject({ ok: true, data: { status: 'pending_approval' } });
  if (!sent.ok) return;
  const id = sent.data.id;

  // The owner's screen: the voucher waits, of kind bill, paid to the bill's supplier for exactly its split.
  const theirs = await screen(w.owner);
  const row = theirs.rows.find((v) => v.transaction_id === id)!;
  expect(row).toMatchObject({ kind: 'bill', status: 'pending_approval', amount: 100, party_name: 'Syarikat Maju', contact_id: w.supplier, category_id: null, approved_at: null });
  expect(voucherActions(row, true)).toEqual(['approve', 'reject', 'delete']);
  expect(voucherActions(row, false)).toEqual(['delete']);
  expect(voucherKindLink(row)?.title).toBeNull();
  // The Approve question's data, as the loader works it out for someone who may decide: the same sentence as the form's.
  expect(hasBillVoucherWaiting(theirs.rows)).toBe(true);
  const notes = orderNotesByVoucher(theirs.payments, theirs.bills, theirs.orders);
  expect(notes[id]).toEqual(formNote);
  expect(voucherQuestion('approve', row).map((p) => p.text).join('')).toContain(`for ${row.documents}, dated`);

  // While it waits it cannot be changed, by the form or by its row, and only an owner or admin decides it.
  expect(await saveVoucher(w.member, { ...voucherSavePayload(form, false), id })).toEqual({ ok: false, error: M.notDraft });
  const seen = voucherDecisionPayload(row);
  expect(await approveVoucher(w.member, seen)).toEqual({ ok: false, error: M.needsDecider });
  expect(await approveVoucher(w.owner, { ...seen, amount: 101 })).toEqual({ ok: false, error: M.changed });
  expect(await approveVoucher(w.owner, seen)).toEqual({ ok: true, data: { id } });

  // Approved: To be paid, exactly as sent, and from here a payment on Payments Out, where it is marked paid or deleted.
  const after = await screen(w.owner);
  const approved = after.rows.find((v) => v.transaction_id === id)!;
  expect(approved).toMatchObject({ status: 'scheduled', amount: 100, contact_id: w.supplier, number: null });
  expect(approved.approved_at).not.toBeNull();
  expect(after.payments.filter((p) => p.transaction_id === id).map((p) => [p.bill_id, p.amount, p.status])).toEqual([[w.bill, 100, 'scheduled']]);
  expect(voucherActions(approved, true)).toEqual([]);
  expect(voucherKindLink(approved)).toEqual({ label: 'Payments Out', href: '/finance/payments-out', title: 'Managed on Payments Out' });
  expect(orderNotesByVoucher(after.payments, after.bills, after.orders)).toEqual({});
  expect(await approveVoucher(w.owner, seen)).toEqual({ ok: false, error: M.alreadyApproved });
});

testWithSupabase('a draft for a bill is saved, edited, holds its part of the bill, is sent from its row as shown, and deleted', async () => {
  const w = await overBilledWorkspace(`Voucher bills draft ${Date.now()}`);
  const first = await screen(w.member);
  const saved = await saveVoucher(w.member, voucherSavePayload(billForm(w, first, '50'), false));
  expect(saved).toMatchObject({ ok: true, data: { status: 'draft' } });
  if (!saved.ok) return;
  const id = saved.data.id;

  // The draft's row and the form it opens: the owner edits what the member saved.
  const s = await screen(w.owner);
  const draft = s.rows.find((v) => v.transaction_id === id)!;
  expect(draft).toMatchObject({ kind: 'bill', status: 'draft', amount: 50 });
  expect(voucherActions(draft, false)).toEqual(['edit', 'submit', 'delete']);
  // It holds RM 50 of the bill for anyone else, and may take its own part again.
  expect(voucherPayableBills(s.bills, s.payments, null)[0].payable).toBe(250);
  expect(voucherPayableBills(s.bills, s.payments, id)[0].payable).toBe(300);
  expect(await saveVoucher(w.member, voucherSavePayload(billForm(w, s, '250.01'), false))).toEqual({ ok: false, error: M.tooMuch });
  const editing = draftVoucherForm(draft, s.payments, s.bills, s.accounts);
  expect(editing).toMatchObject({ id, kind: 'bills', supplierId: w.supplier, amounts: { [w.bill]: '50.00' } });
  const edited = await saveVoucher(w.owner, voucherSavePayload({ ...editing, amounts: { [w.bill]: '60' }, notes: 'Part payment' }, false));
  expect(edited).toEqual({ ok: true, data: { id, status: 'draft' } });

  // Sent from its row: only as the row shows it now.
  expect(await submitVoucher(w.member, voucherDecisionPayload(draft))).toEqual({ ok: false, error: M.draftChanged });
  const now = (await listPaymentVouchers(w.member)).find((v) => v.transaction_id === id)!;
  expect(now).toMatchObject({ amount: 60, notes: 'Part payment', status: 'draft' });
  expect(await submitVoucher(w.member, voucherDecisionPayload(now))).toEqual({ ok: true, data: { id } });
  expect(await submitVoucher(w.member, voucherDecisionPayload(now))).toEqual({ ok: false, error: M.notDraftSend });
  // The owner rejects it; a rejected voucher holds nothing and is only deleted.
  expect(await rejectVoucher(w.owner, voucherDecisionPayload(now))).toEqual({ ok: true, data: { id } });
  const end = await screen(w.member);
  expect(voucherPayableBills(end.bills, end.payments, null)[0].payable).toBe(300);
  expect(await deleteVoucher(w.member, { id, status: 'rejected' })).toMatchObject({ ok: true });
  expect((await listPaymentVouchers(w.owner)).map((v) => v.transaction_id)).not.toContain(id);
});
