import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { listBills } from '@/lib/finance/bills';
import { listPaymentVouchers } from '@/lib/finance/cash-book';
import { listExpenseCategories } from '@/lib/finance/expenses';
import { listAccounts, listPaymentsOut } from '@/lib/finance/money';
import { hasBillVoucherWaiting, orderNotesByVoucher, voucherActions, voucherDecisionPayload } from '@/lib/finance/voucher-form';
import { VOUCHER_MESSAGES, approveVoucher, deleteVoucher, recordVoucher, rejectVoucher } from '@/lib/finance/vouchers';

// Payment vouchers against the hosted database, through the screen's own
// read and write functions with a real client. Run by the controller only.
// No migration goes with this stage, so it can run as soon as the code is
// merged. The smoke account is an owner, so a browser pass cannot show what a
// member is answered: this file does, with a member invited into a workspace.
// It also makes the one voucher no screen can make yet, a payment to a
// supplier that waits for approval, and proves that Approve reaches it and
// that the over-billing note finds its bills. Every workspace is made through
// tests/helpers/live-workspaces.ts, which deletes what it creates.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const M = VOUCHER_MESSAGES;

type Ctx = { client: SupabaseClient; orgId: string };
type Workspace = { owner: Ctx; member: Ctx; bank: string; category: string };

/** A new signed-up user and the workspace they own, a member invited into it, its first bank account and an expense category. */
async function ownerAndMember(orgName: string): Promise<Workspace> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  // A member needs an address to accept an invite sent to it; see finance-write-guards.rls.test.ts.
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'vouchers-member-pass-123');
  const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  const owner = { client: c, orgId: orgId as string };
  const accounts = await listAccounts(owner);
  const categories = await listExpenseCategories(owner);
  return {
    owner,
    member: { client: m, orgId: orgId as string },
    bank: accounts.find((a) => a.kind === 'bank')!.id,
    category: categories.find((x) => x.name === 'Utilities')!.id,
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** What the form sends for a voucher of RM `amount` to a typed payee. */
function typed(w: Workspace, amount: number) {
  return { account_id: w.bank, txn_date: today(), method: 'fpx' as const, category_id: w.category, amount, party_name: 'Tenaga Nasional', reference: '', notes: '' };
}

/** The voucher's row as the screen reads it. */
async function rowOf(ctx: Ctx, id: string) {
  const row = (await listPaymentVouchers(ctx)).find((v) => v.transaction_id === id);
  expect(row, `voucher ${id} is on the screen`).toBeDefined();
  return row!;
}

testWithSupabase('a member’s voucher waits; only an owner decides it, as it was shown, and once', async () => {
  const w = await ownerAndMember(`Vouchers approve ${Date.now()}`);

  const sent = await recordVoucher(w.member, typed(w, 300));
  expect(sent).toMatchObject({ ok: true, data: { status: 'pending_approval' } });
  if (!sent.ok) return;
  const row = await rowOf(w.owner, sent.data.id);
  expect(row).toMatchObject({ kind: 'other', status: 'pending_approval', amount: 300, party_name: 'Tenaga Nasional', number: null, approved_at: null });
  // The menu the screen builds from that row: a member deletes, an owner also decides.
  expect(voucherActions(row, false)).toEqual(['delete']);
  expect(voucherActions(row, true)).toEqual(['approve', 'reject', 'delete']);
  const seen = voucherDecisionPayload(row);

  // A member is told who decides, by the database, whatever the screen offered them.
  expect(await approveVoucher(w.member, seen)).toEqual({ ok: false, error: M.needsDecider });
  expect(await rejectVoucher(w.member, seen)).toEqual({ ok: false, error: M.needsDecider });

  // A decision on a voucher that is not what the row showed changes nothing.
  expect(await approveVoucher(w.owner, { ...seen, amount: 301 })).toEqual({ ok: false, error: M.changed });
  expect(await approveVoucher(w.owner, { ...seen, notes: 'not what it holds' })).toEqual({ ok: false, error: M.changed });
  expect((await rowOf(w.owner, sent.data.id)).status).toBe('pending_approval');

  expect(await approveVoucher(w.owner, seen)).toEqual({ ok: true, data: { id: sent.data.id } });
  const approved = await rowOf(w.owner, sent.data.id);
  expect(approved.status).toBe('scheduled');
  expect(approved.approved_at).not.toBeNull();
  expect(approved.number).toBeNull();

  // Decided once: the second person is told so, and nothing changes.
  expect(await rejectVoucher(w.owner, seen)).toEqual({ ok: false, error: M.alreadyApproved });
  expect(await approveVoucher(w.owner, seen)).toEqual({ ok: false, error: M.alreadyApproved });

  // A delete asked on the row as it was (waiting) does not take the approved voucher; asked on it as it is, it does.
  expect(await deleteVoucher(w.member, { id: sent.data.id, status: 'pending_approval' })).toEqual({ ok: false, error: M.movedOn });
  expect(await deleteVoucher(w.member, { id: sent.data.id, status: 'scheduled' })).toEqual({ ok: true, data: { id: sent.data.id } });
  expect(await deleteVoucher(w.member, { id: sent.data.id, status: 'scheduled' })).toEqual({ ok: false, error: M.gone });
  expect(await approveVoucher(w.owner, seen)).toEqual({ ok: false, error: M.gone });
});

testWithSupabase('an owner’s voucher is approved on saving; a rejected one is final and is deleted', async () => {
  const w = await ownerAndMember(`Vouchers reject ${Date.now()}`);

  const own = await recordVoucher(w.owner, typed(w, 120));
  expect(own).toMatchObject({ ok: true, data: { status: 'scheduled' } });
  if (!own.ok) return;
  const ownRow = await rowOf(w.owner, own.data.id);
  expect(ownRow.approved_at).not.toBeNull();
  // To be paid, and of a kind that belongs here: an owner or admin marks it paid (tests/bendahara-voucher-pay-void.test.ts).
  expect(voucherActions(ownRow, true)).toEqual(['markPaid', 'delete']);
  expect(voucherActions(ownRow, false)).toEqual(['delete']);

  // What the schema refuses never reaches the database; what the database refuses comes back as a sentence.
  const income = await w.owner.client.from('finance_categories').select('id').eq('org_id', w.owner.orgId).eq('kind', 'income').limit(1);
  expect(await recordVoucher(w.owner, { ...typed(w, 10), category_id: income.data![0].id as string })).toEqual({ ok: false, error: M.categoryGone });

  const sent = await recordVoucher(w.member, typed(w, 45.5));
  expect(sent).toMatchObject({ ok: true, data: { status: 'pending_approval' } });
  if (!sent.ok) return;
  const seen = voucherDecisionPayload(await rowOf(w.owner, sent.data.id));
  expect(await rejectVoucher(w.owner, seen)).toEqual({ ok: true, data: { id: sent.data.id } });
  const rejected = await rowOf(w.owner, sent.data.id);
  expect(rejected.status).toBe('rejected');
  expect(voucherActions(rejected, true)).toEqual(['delete']);
  expect(await approveVoucher(w.owner, seen)).toEqual({ ok: false, error: M.alreadyRejected });

  expect(await deleteVoucher(w.member, { id: sent.data.id, status: 'rejected' })).toMatchObject({ ok: true });
  expect(await deleteVoucher(w.owner, { id: own.data.id, status: 'scheduled' })).toMatchObject({ ok: true });
  const left = (await listPaymentVouchers(w.owner)).map((v) => v.transaction_id);
  expect(left).not.toContain(sent.data.id);
  expect(left).not.toContain(own.data.id);
});

testWithSupabase('a payment to a supplier that waits (made by hand) is approved here, and the over-billing note finds its bills', async () => {
  const w = await ownerAndMember(`Vouchers bills ${Date.now()}`);
  const { client: c, orgId } = w.owner;
  const supplier = await c.from('finance_contacts').insert({ org_id: orgId, name: 'Syarikat Maju', is_customer: false, is_supplier: true }).select('id').single();
  expect(supplier.error, supplier.error?.message).toBeNull();
  const bill = await c.rpc('finance_save_bill', {
    target_org: orgId,
    bill: { supplier_id: supplier.data!.id, bill_date: today(), due_date: today() },
    lines: [{ description: 'Design work', quantity: 10, unit_price: 12.5, sst_rate: 6 }], // RM 132.50
  });
  expect(bill.error, bill.error?.message).toBeNull();
  const posted = await c.rpc('finance_post_bill', { target_org: orgId, target_bill: bill.data });
  expect(posted.error, posted.error?.message).toBeNull();

  // No screen sends a supplier payment for approval yet. The database allows one: a draft, its split, then the status.
  const m = w.member.client;
  const draft = await m
    .from('finance_transactions')
    .insert({ org_id: orgId, direction: 'out', account_id: w.bank, amount: 100, method: 'fpx', contact_id: supplier.data!.id })
    .select('id')
    .single();
  expect(draft.error, draft.error?.message).toBeNull();
  const voucherId = draft.data!.id as string;
  const split = await m.from('finance_allocations').insert({ org_id: orgId, transaction_id: voucherId, bill_id: bill.data, amount: 100 });
  expect(split.error, split.error?.message).toBeNull();
  const submitted = await m.from('finance_transactions').update({ status: 'pending_approval', updated_at: new Date().toISOString() }).eq('id', voucherId).select('id');
  expect(submitted.error, submitted.error?.message).toBeNull();

  const rows = await listPaymentVouchers(w.owner);
  const row = rows.find((v) => v.transaction_id === voucherId)!;
  expect(row).toMatchObject({ kind: 'bill', status: 'pending_approval', amount: 100, party_name: 'Syarikat Maju', category_id: null });
  expect(hasBillVoucherWaiting(rows)).toBe(true);
  // Payments Out offers nothing on a payment that waits, so the decision and the delete are here.
  expect(voucherActions(row, true)).toEqual(['approve', 'reject', 'delete']);
  expect(voucherActions(row, false)).toEqual(['delete']);

  // The note's join, on real rows: Payments Out names the bills of the waiting voucher. The bill is raised against
  // no purchase order here (the figures of an order are #193's and are tested there), so one is stood in for it.
  const [payments, bills] = await Promise.all([listPaymentsOut(w.owner), listBills(w.owner)]);
  expect(orderNotesByVoucher(payments, bills, [])).toEqual({});
  const notes = orderNotesByVoucher(
    payments,
    bills.map((b) => ({ ...b, purchase_order_id: 'stand-in' })),
    [{ id: 'stand-in', po_no: 'PO-0001', total: 100, billed_total: 132.5, received_total: 100, over_billed: true, billed_over_received: false }],
  );
  expect(Object.keys(notes)).toEqual([voucherId]);
  expect(notes[voucherId][0]).toContain('against PO-0001, whose bills come to RM 132.50, over its total of RM 100.00.');

  // The decision payload of a supplier payment: a contact, no typed name, no category.
  const seen = voucherDecisionPayload(row);
  expect(seen).toMatchObject({ contact_id: supplier.data!.id, party_name: null, category_id: null });
  expect(await approveVoucher(w.member, seen)).toEqual({ ok: false, error: M.needsDecider });
  expect(await approveVoucher(w.owner, seen)).toEqual({ ok: true, data: { id: voucherId } });
  // Approved, it is a payment still to be paid on Payments Out, where it is marked paid or deleted.
  const after = (await listPaymentsOut(w.owner)).filter((p) => p.transaction_id === voucherId);
  expect(after.map((p) => p.status)).toEqual(['scheduled']);
  expect(voucherActions(await rowOf(w.owner, voucherId), true)).toEqual([]);
});
