import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { getPrintablePurchaseOrder } from '@/lib/finance/purchase-orders';

// Bendahara RFQs and purchase orders (20261103090000 to 20261103100000, and 20261106090000),
// against the live project. Each test makes its own workspace; the helper
// deletes what it made when the file finishes.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Who = { c: SupabaseClient; orgId: string; supplier: string; userId?: string };

async function ownerWithOrg(orgName: string): Promise<Who> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const { data: supplier, error: supplierErr } = await c
    .from('finance_contacts')
    .insert({ org_id: orgId, name: `Supplier of ${orgName}`, is_supplier: true })
    .select('id')
    .single();
  expect(supplierErr, supplierErr?.message).toBeNull();
  return { c, orgId: orgId as string, supplier: supplier!.id as string };
}

/** A second person in the owner's workspace, with the given role. */
async function join(o: Who, role: 'admin' | 'member'): Promise<Who> {
  const c = liveClient();
  const signUp = await createConfirmedTestUser(c, `po-${role}-pass-123`);
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

const PAPER = { description: 'A4 paper', quantity: 10, unit_price: 12.5, sst_rate: 6 }; // 125.00 + 7.50 = 132.50
const TONER = { description: 'Toner', quantity: 2, unit_price: 100, sst_rate: 0 }; // 200.00

function savePo(w: Who, lines: object[] = [PAPER, TONER], extra: object = {}) {
  return w.c.rpc('finance_save_purchase_order', {
    target_org: w.orgId,
    purchase_order: { supplier_id: w.supplier, po_date: today(), ...extra },
    lines,
  });
}

const submit = (w: Who, id: string) =>
  w.c.rpc('finance_submit_purchase_order', { target_org: w.orgId, target_po: id });
const decide = (w: Who, id: string, approve: boolean, reason: string | null = null) =>
  w.c.rpc('finance_decide_purchase_order', { target_org: w.orgId, target_po: id, approve, reason });

async function po(w: Who, id: string) {
  const { data, error } = await w.c.from('finance_purchase_order_totals').select('*').eq('id', id).single();
  expect(error, error?.message).toBeNull();
  return data!;
}

/** An order raised by `raiser` and approved by `approver`. */
async function approvedPo(raiser: Who, approver: Who) {
  const saved = await savePo(raiser);
  expect(saved.error, saved.error?.message).toBeNull();
  expect((await submit(raiser, saved.data)).error).toBeNull();
  const ok = await decide(approver, saved.data, true);
  expect(ok.error, ok.error?.message).toBeNull();
  return saved.data as string;
}

function saveBill(w: Who, extra: object, lines: object[] = [PAPER]) {
  return w.c.rpc('finance_save_bill', {
    target_org: w.orgId,
    bill: { supplier_id: w.supplier, bill_date: today(), due_date: today(30), ...extra },
    lines,
  });
}

testWithSupabase('an RFQ is sent, priced, turned into an order once, and closed', async () => {
  const o = await ownerWithOrg(`RFQ flow ${Date.now()}`);
  const save = (lines: object[]) =>
    o.c.rpc('finance_save_rfq', {
      target_org: o.orgId,
      rfq: { supplier_id: o.supplier, rfq_date: today(), reply_by: today(7) },
      lines,
    });

  expect((await save([])).error?.code).toBe('FIN10');
  const saved = await save([{ description: 'A4 paper', quantity: 10 }, { description: 'Toner', quantity: 2 }]);
  expect(saved.error, saved.error?.message).toBeNull();
  const id = saved.data as string;

  const sent = await o.c.rpc('finance_send_rfq', { target_org: o.orgId, target_rfq: id });
  expect(sent.data).toBe('RFQ-0001');
  expect((await o.c.rpc('finance_send_rfq', { target_org: o.orgId, target_rfq: id })).error?.code).toBe('FIN01');
  // Sent: the items are locked, and it cannot be deleted.
  const locked = await o.c.from('finance_rfq_lines').update({ quantity: 99 }).eq('rfq_id', id).select('id');
  expect(locked.error?.code).toBe('FIN01');
  expect((await o.c.from('finance_rfqs').delete().eq('id', id).select('id')).error?.code).toBe('FIN01');

  const { data: lines } = await o.c.from('finance_rfq_lines').select('id, description').eq('rfq_id', id).order('position');
  const quote = (prices: object[]) =>
    o.c.rpc('finance_quote_rfq', { target_org: o.orgId, target_rfq: id, prices, supplier_reference: ' SQ-77 ' });
  // One line left without a price.
  expect((await quote([{ line_id: lines![0].id, unit_price: 12.5, sst_rate: 6 }])).error?.code).toBe('FIN19');
  const quoted = await quote([
    { line_id: lines![0].id, unit_price: 12.5, sst_rate: 6 },
    { line_id: lines![1].id, unit_price: 100 },
  ]);
  expect(quoted.error, quoted.error?.message).toBeNull();

  const row = await o.c.from('finance_rfq_totals').select('*').eq('id', id).single();
  expect(row.data).toMatchObject({ status: 'quoted', supplier_ref: 'SQ-77', fully_priced: true, total: 332.5 });

  const converted = await o.c.rpc('finance_convert_rfq', { target_org: o.orgId, target_rfq: id });
  expect(converted.error, converted.error?.message).toBeNull();
  expect(await po(o, converted.data)).toMatchObject({ status: 'draft', rfq_no: 'RFQ-0001', total: 332.5, po_no: null });
  expect((await o.c.rpc('finance_convert_rfq', { target_org: o.orgId, target_rfq: id })).error?.code).toBe('FIN22');
  // ...and a second order cannot be attached to the RFQ by hand.
  const second = await o.c.from('finance_purchase_orders').insert({ org_id: o.orgId, supplier_id: o.supplier, rfq_id: id }).select('id');
  expect(second.error?.code).toBe('23505');
  // A cancelled order frees the RFQ.
  expect((await o.c.rpc('finance_cancel_purchase_order', { target_org: o.orgId, target_po: converted.data })).error).toBeNull();
  expect((await o.c.rpc('finance_convert_rfq', { target_org: o.orgId, target_rfq: id })).error).toBeNull();

  expect((await o.c.rpc('finance_close_rfq', { target_org: o.orgId, target_rfq: id })).error).toBeNull();
  expect((await quote([])).error?.code).toBe('FIN01');
});

testWithSupabase('who may approve: not a member, not the admin who raised it, another admin, and the owner their own', async () => {
  const o = await ownerWithOrg(`PO approval ${Date.now()}`);
  const admin = await join(o, 'admin');
  const member = await join(o, 'member');

  // A member raises and submits; cannot approve.
  const byMember = await savePo(member);
  expect(byMember.error, byMember.error?.message).toBeNull();
  expect((await submit(member, byMember.data)).data).toBe('PO-0001');
  expect((await decide(member, byMember.data, true)).error?.code).toBe('FIN14');
  expect((await decide(member, byMember.data, false, 'no')).error?.code).toBe('FIN14');
  // ...not by hand either.
  const byHand = await member.c.from('finance_purchase_orders').update({ status: 'approved' }).eq('id', byMember.data).select('id');
  expect(byHand.error?.code).toBe('FIN14');
  // An admin approves someone else's.
  expect((await decide(admin, byMember.data, true)).error).toBeNull();
  expect(await po(o, byMember.data)).toMatchObject({ status: 'approved', approved_by: admin.userId });

  // An admin cannot approve their own, through the function or by hand.
  const byAdmin = await savePo(admin);
  expect((await submit(admin, byAdmin.data)).error).toBeNull();
  expect((await decide(admin, byAdmin.data, true)).error?.code).toBe('FIN18');
  const adminByHand = await admin.c.from('finance_purchase_orders').update({ status: 'approved' }).eq('id', byAdmin.data).select('id');
  expect(adminByHand.error?.code).toBe('FIN18');
  // The raiser cannot be rewritten to get round it.
  const rewrite = await admin.c.from('finance_purchase_orders').update({ created_by: null }).eq('id', byAdmin.data).select('id');
  expect(rewrite.error?.code).toBe('FIN01');
  expect((await decide(o, byAdmin.data, true)).error).toBeNull();

  // An admin who rewrites a member's draft and submits it has made it theirs: they cannot approve it.
  const started = await savePo(member);
  expect((await savePo(admin, [TONER], { id: started.data })).error).toBeNull();
  expect((await submit(admin, started.data)).error).toBeNull();
  expect(await po(o, started.data)).toMatchObject({ created_by: member.userId, submitted_by: admin.userId });
  expect((await decide(admin, started.data, true)).error?.code).toBe('FIN18');
  // The same after a withdrawal: the member's pending order, taken back, changed and sent again by the admin.
  const pendingByMember = await savePo(member);
  expect((await submit(member, pendingByMember.data)).error).toBeNull();
  expect((await admin.c.rpc('finance_withdraw_purchase_order', { target_org: o.orgId, target_po: pendingByMember.data })).error).toBeNull();
  expect((await savePo(admin, [TONER], { id: pendingByMember.data })).error).toBeNull();
  expect((await submit(admin, pendingByMember.data)).error).toBeNull();
  expect((await decide(admin, pendingByMember.data, true)).error?.code).toBe('FIN18');
  expect((await decide(o, pendingByMember.data, true)).error).toBeNull();
  // Who submitted cannot be rewritten either.
  const resubmitter = await admin.c.from('finance_purchase_orders').update({ submitted_by: null }).eq('id', started.data).select('id');
  expect(resubmitter.error?.code).toBe('FIN01');

  // The owner approves their own.
  const byOwner = await savePo(o);
  expect((await submit(o, byOwner.data)).error).toBeNull();
  expect((await decide(o, byOwner.data, true)).error).toBeNull();

  // A new order cannot be inserted already approved, or under someone else's name.
  const forged = await member.c
    .from('finance_purchase_orders')
    .insert({ org_id: o.orgId, supplier_id: o.supplier, status: 'approved' })
    .select('id');
  expect(forged.error?.code).toBe('FIN01');
  const named = await admin.c
    .from('finance_purchase_orders')
    .insert({ org_id: o.orgId, supplier_id: o.supplier, created_by: member.userId })
    .select('created_by')
    .single();
  expect(named.data?.created_by).toBe(admin.userId);
});

testWithSupabase('rejected, corrected and resubmitted: same number, reason cleared; withdraw and cancel', async () => {
  const o = await ownerWithOrg(`PO reject ${Date.now()}`);
  const member = await join(o, 'member');

  const saved = await savePo(member, []);
  expect(saved.error?.code).toBe('FIN10');
  const zero = await savePo(member, [{ description: 'Free sample', quantity: 1, unit_price: 0 }]);
  expect((await submit(member, zero.data)).error?.code).toBe('FIN10');

  const made = await savePo(member);
  const id = made.data as string;
  expect((await submit(member, id)).data).toBe('PO-0001');
  // Waiting for approval: locked.
  expect((await savePo(member, [PAPER], { id })).error?.code).toBe('FIN01');
  expect((await decide(o, id, false, '  ')).error?.code).toBe('FIN10');
  expect((await decide(o, id, false, 'Too many reams')).error).toBeNull();
  expect(await po(o, id)).toMatchObject({ status: 'draft', po_no: 'PO-0001', rejection_reason: 'Too many reams' });

  // Corrected and sent again: the number is kept, the reason goes.
  expect((await savePo(member, [PAPER], { id })).error).toBeNull();
  expect((await submit(member, id)).data).toBe('PO-0001');
  expect(await po(o, id)).toMatchObject({ status: 'pending_approval', rejection_reason: null, rejected_at: null, total: 132.5 });
  const next = await savePo(member);
  expect((await submit(member, next.data)).data).toBe('PO-0002');

  // The raiser withdraws; a numbered draft is cancelled, not deleted.
  const withdrawn = await member.c.rpc('finance_withdraw_purchase_order', { target_org: o.orgId, target_po: id });
  expect(withdrawn.error, withdrawn.error?.message).toBeNull();
  expect((await po(o, id)).rejection_reason).toBeNull();
  expect((await member.c.from('finance_purchase_orders').delete().eq('id', id).select('id')).error?.code).toBe('FIN01');
  expect((await member.c.rpc('finance_cancel_purchase_order', { target_org: o.orgId, target_po: id })).error).toBeNull();
  expect((await submit(member, id)).error?.code).toBe('FIN01');

  // A draft that never had a number is simply deleted.
  const scrap = await savePo(member);
  const gone = await member.c.from('finance_purchase_orders').delete().eq('id', scrap.data).select('id');
  expect(gone.error).toBeNull();
  expect(gone.data).toHaveLength(1);

  // Approved: a member can neither close nor cancel it.
  const approved = await approvedPo(member, o);
  expect((await member.c.rpc('finance_close_purchase_order', { target_org: o.orgId, target_po: approved })).error?.code).toBe('FIN14');
  expect((await member.c.rpc('finance_cancel_purchase_order', { target_org: o.orgId, target_po: approved })).error?.code).toBe('FIN14');
});

testWithSupabase('delivery: only what has arrived changes on an approved order', async () => {
  const o = await ownerWithOrg(`PO delivery ${Date.now()}`);
  const member = await join(o, 'member');
  const receive = (w: Who, id: string, receipts: object[]) =>
    w.c.rpc('finance_receive_purchase_order', { target_org: o.orgId, target_po: id, receipts });

  const draft = await savePo(member);
  const { data: draftLines } = await o.c.from('finance_purchase_order_lines').select('id').eq('purchase_order_id', draft.data);
  expect((await receive(member, draft.data, [{ line_id: draftLines![0].id, received_quantity: 1 }])).error?.code).toBe('FIN01');

  const id = await approvedPo(member, o);
  const { data: lines } = await o.c
    .from('finance_purchase_order_lines')
    .select('id, quantity')
    .eq('purchase_order_id', id)
    .order('position');
  expect((await po(o, id)).delivery).toBe('pending');

  const some = await receive(member, id, [{ line_id: lines![0].id, received_quantity: 4 }]);
  expect(some.error, some.error?.message).toBeNull();
  expect((await po(o, id)).delivery).toBe('partial');

  // Over-delivery on one line is allowed; the other line is still short.
  expect((await receive(member, id, [{ line_id: lines![0].id, received_quantity: 12 }])).error).toBeNull();
  expect((await po(o, id)).delivery).toBe('partial');
  expect((await receive(member, id, [{ line_id: lines![1].id, received_quantity: 2 }])).error).toBeNull();
  expect(await po(o, id)).toMatchObject({ delivery: 'delivered', total: 332.5 });

  // Nothing else about a line changes, and no line is added or removed.
  expect((await o.c.from('finance_purchase_order_lines').update({ unit_price: 1 }).eq('id', lines![0].id).select('id')).error?.code).toBe('FIN01');
  expect((await o.c.from('finance_purchase_order_lines').delete().eq('id', lines![0].id).select('id')).error?.code).toBe('FIN01');
  const added = await o.c
    .from('finance_purchase_order_lines')
    .insert({ org_id: o.orgId, purchase_order_id: id, description: 'Extra', quantity: 1, unit_price: 1 })
    .select('id');
  expect(added.error?.code).toBe('FIN01');
  expect((await receive(member, id, [{ line_id: crypto.randomUUID(), received_quantity: 1 }])).error?.code).toBe('FIN11');
  expect((await receive(member, id, [{ line_id: lines![0].id, received_quantity: -1 }])).error?.code).toBe('23514');

  // Closed: no more deliveries.
  expect((await o.c.rpc('finance_close_purchase_order', { target_org: o.orgId, target_po: id })).error).toBeNull();
  expect((await receive(member, id, [{ line_id: lines![0].id, received_quantity: 10 }])).error?.code).toBe('FIN01');
});

testWithSupabase('a bill is raised against an approved order of the same supplier', async () => {
  const o = await ownerWithOrg(`PO bills ${Date.now()}`);
  const { data: other } = await o.c
    .from('finance_contacts')
    .insert({ org_id: o.orgId, name: 'Another supplier', is_supplier: true })
    .select('id')
    .single();

  const pending = await savePo(o);
  expect((await submit(o, pending.data)).error).toBeNull();
  expect((await saveBill(o, { purchase_order_id: pending.data })).error?.code).toBe('FIN21');

  const id = await approvedPo(o, o);
  expect((await saveBill(o, { purchase_order_id: id, supplier_id: other!.id })).error?.code).toBe('FIN21');

  const bill = await saveBill(o, { purchase_order_id: id });
  expect(bill.error, bill.error?.message).toBeNull();
  expect(await po(o, id)).toMatchObject({ billed_total: 132.5, over_billed: false });

  // A save without the key keeps the link; an empty value removes it.
  expect((await saveBill(o, { id: bill.data })).error).toBeNull();
  const kept = await o.c.from('supplier_bills').select('purchase_order_id').eq('id', bill.data).single();
  expect(kept.data?.purchase_order_id).toBe(id);
  // A linked bill cannot move to another supplier.
  expect((await saveBill(o, { id: bill.data, supplier_id: other!.id })).error?.code).toBe('FIN21');

  // A second bill takes the order over its total: allowed, and flagged.
  const second = await saveBill(o, { purchase_order_id: id }, [{ description: 'Everything again', quantity: 1, unit_price: 300 }]);
  expect(second.error, second.error?.message).toBeNull();
  expect(await po(o, id)).toMatchObject({ billed_total: 432.5, over_billed: true });

  // With bills, the order cannot be cancelled.
  expect((await o.c.rpc('finance_cancel_purchase_order', { target_org: o.orgId, target_po: id })).error?.code).toBe('FIN20');

  // A voided bill no longer counts; unlinking the other frees the order.
  expect((await o.c.rpc('finance_post_bill', { target_org: o.orgId, target_bill: second.data })).error).toBeNull();
  expect((await o.c.from('supplier_bills').update({ status: 'void' }).eq('id', second.data).select('id')).error).toBeNull();
  expect((await po(o, id)).billed_total).toBe(132.5);
  expect((await saveBill(o, { id: bill.data, purchase_order_id: '' })).error).toBeNull();
  expect((await po(o, id)).billed_total).toBe(0);

  // Closed: bills already linked stay, new ones are refused.
  const linked = await saveBill(o, { purchase_order_id: id });
  expect((await o.c.rpc('finance_close_purchase_order', { target_org: o.orgId, target_po: id })).error).toBeNull();
  expect((await saveBill(o, { purchase_order_id: id })).error?.code).toBe('FIN21');
  expect((await saveBill(o, { id: linked.data })).error).toBeNull();
});

testWithSupabase('two workspaces: neither reads, writes or links to the other', async () => {
  const a = await ownerWithOrg(`PO tenant A ${Date.now()}`);
  const b = await ownerWithOrg(`PO tenant B ${Date.now()}`);
  const aPo = await approvedPo(a, a);
  const aRfq = await a.c.rpc('finance_save_rfq', {
    target_org: a.orgId,
    rfq: { supplier_id: a.supplier, rfq_date: today() },
    lines: [{ description: 'A4 paper', quantity: 1 }],
  });
  expect(aRfq.error, aRfq.error?.message).toBeNull();

  for (const table of ['finance_purchase_orders', 'finance_purchase_order_lines', 'finance_purchase_order_totals', 'finance_rfqs', 'finance_rfq_lines', 'finance_rfq_totals']) {
    const seen = await b.c.from(table).select('id').eq('org_id', a.orgId);
    expect(seen.data, table).toEqual([]);
  }

  // B cannot act on A's documents.
  expect((await decide(b, aPo, true)).error?.code).toBe('FIN11');
  expect((await b.c.rpc('finance_cancel_purchase_order', { target_org: a.orgId, target_po: aPo })).error?.code).toBe('FIN11');
  expect((await b.c.rpc('finance_send_rfq', { target_org: a.orgId, target_rfq: aRfq.data })).error?.code).toBe('FIN11');
  const intoA = await b.c.rpc('finance_save_purchase_order', {
    target_org: a.orgId,
    purchase_order: { supplier_id: a.supplier, po_date: today() },
    lines: [PAPER],
  });
  expect(intoA.error?.code).toBe('42501');

  // B's own records cannot point at A's: order against A's supplier, bill against A's order.
  const crossSupplier = await b.c.rpc('finance_save_purchase_order', {
    target_org: b.orgId,
    purchase_order: { supplier_id: a.supplier, po_date: today() },
    lines: [PAPER],
  });
  expect(crossSupplier.error?.code).toBe('23503');
  const crossBill = await saveBill(b, { purchase_order_id: aPo });
  expect(['FIN21', '23503']).toContain(crossBill.error?.code);
});

testWithSupabase('an order carries its own terms and address, values what has arrived, and its decisions are logged', async () => {
  const o = await ownerWithOrg(`PO terms ${Date.now()}`);
  const member = await join(o, 'member');
  expect((await o.c.from('finance_contacts').update({ payment_terms_days: 45 }).eq('id', o.supplier).select('id')).error).toBeNull();

  // A new order with no terms given takes the supplier's; given terms and an address are kept.
  const plain = await savePo(member);
  expect(await po(o, plain.data)).toMatchObject({ payment_terms_days: 45, delivery_address: null });
  const cod = await savePo(member, [PAPER, TONER], { payment_terms_days: 0, delivery_address: '  Lot 5, Jalan Contoh  ' });
  expect(await po(o, cod.data)).toMatchObject({ payment_terms_days: 0, delivery_address: 'Lot 5, Jalan Contoh' });
  // Changing a draft without sending them keeps them; sending them changes them.
  expect((await savePo(member, [PAPER, TONER], { id: cod.data })).error).toBeNull();
  expect(await po(o, cod.data)).toMatchObject({ payment_terms_days: 0, delivery_address: 'Lot 5, Jalan Contoh' });
  expect((await savePo(member, [PAPER, TONER], { id: cod.data, payment_terms_days: 14, delivery_address: '' })).error).toBeNull();
  expect(await po(o, cod.data)).toMatchObject({ payment_terms_days: 14, delivery_address: null });
  expect((await savePo(member, [PAPER], { payment_terms_days: -1 })).error?.code).toBe('23514');

  // An order made from an RFQ starts with the supplier's terms.
  const rfq = await o.c.rpc('finance_save_rfq', {
    target_org: o.orgId,
    rfq: { supplier_id: o.supplier, rfq_date: today() },
    lines: [{ description: 'A4 paper', quantity: 1, unit_price: 5 }],
  });
  expect((await o.c.rpc('finance_send_rfq', { target_org: o.orgId, target_rfq: rfq.data })).error).toBeNull();
  const { data: rfqLines } = await o.c.from('finance_rfq_lines').select('id').eq('rfq_id', rfq.data);
  expect(
    (await o.c.rpc('finance_quote_rfq', {
      target_org: o.orgId, target_rfq: rfq.data, prices: [{ line_id: rfqLines![0].id, unit_price: 5 }], supplier_reference: null,
    })).error,
  ).toBeNull();
  const converted = await o.c.rpc('finance_convert_rfq', { target_org: o.orgId, target_rfq: rfq.data });
  expect(await po(o, converted.data)).toMatchObject({ payment_terms_days: 45, total: 5 });

  // Rejected with a reason, sent again, approved: the reason leaves the order but stays in the log.
  const id = cod.data as string;
  const number = (await submit(member, id)).data as string;
  expect((await decide(o, id, false, 'Wrong supplier')).error).toBeNull();
  expect((await submit(member, id)).error).toBeNull();
  expect((await po(o, id)).rejection_reason).toBeNull();
  expect((await decide(o, id, true)).error).toBeNull();

  // What has arrived, at the order's prices: 4 of 10 paper at 12.50 plus 6% SST, and no toner.
  const { data: lines } = await o.c.from('finance_purchase_order_lines').select('id').eq('purchase_order_id', id).order('position');
  expect(await po(o, id)).toMatchObject({ received_total: 0, billed_over_received: false });
  const received = await member.c.rpc('finance_receive_purchase_order', {
    target_org: o.orgId, target_po: id, receipts: [{ line_id: lines![0].id, received_quantity: 4 }],
  });
  expect(received.error, received.error?.message).toBeNull();
  expect((await po(o, id)).received_total).toBe(53);
  // A bill for the whole order is within the order, and more than has arrived.
  const bill = await saveBill(o, { purchase_order_id: id }, [PAPER, TONER]);
  expect(bill.error, bill.error?.message).toBeNull();
  expect(await po(o, id)).toMatchObject({ billed_total: 332.5, over_billed: false, billed_over_received: true });
  const link = await o.c.from('finance_bill_purchase_orders').select('*').eq('bill_id', bill.data).single();
  expect(link.data).toMatchObject({ purchase_order_id: id, po_no: number, purchase_order_status: 'approved' });

  expect((await o.c.rpc('finance_close_purchase_order', { target_org: o.orgId, target_po: id })).error).toBeNull();
  const { data: log, error: logErr } = await member.c
    .from('activity_log')
    .select('action, target, actor_id')
    .eq('org_id', o.orgId)
    .like('action', '%purchase order%')
    .order('created_at', { ascending: true });
  expect(logErr, logErr?.message).toBeNull();
  expect(log!.map((e) => `${e.action} | ${e.target}`)).toEqual([
    `Submitted a purchase order for approval | ${number}`,
    `Rejected a purchase order | ${number}: Wrong supplier`,
    `Submitted a purchase order for approval | ${number}`,
    `Approved a purchase order | ${number}`,
    `Closed a purchase order | ${number}`,
  ]);
  expect(log![0].actor_id).toBe(member.userId);
  // Nobody writes the log by hand.
  const forged = await member.c
    .from('activity_log')
    .insert({ org_id: o.orgId, actor_name: 'x', action: 'Approved a purchase order', category: 'data' })
    .select('id');
  expect(forged.error).not.toBeNull();
});

testWithSupabase("a member reads an approved order for printing, with the supplier's details and the preparer's and approver's names, titles and roles", async () => {
  const o = await ownerWithOrg(`PO print ${Date.now()}`);
  const ownerId = (await o.c.auth.getUser()).data.user!.id;
  const member = await join(o, 'member');
  const named = await member.c.from('profiles').update({ full_name: 'Aisyah Rahman', job_title: 'Purchasing Executive' }).eq('user_id', member.userId!);
  expect(named.error, named.error?.message).toBeNull();
  const contact = await o.c.from('finance_contacts').update({ ssm_no: '201901000123', phone: '03-1234 5678' }).eq('id', o.supplier);
  expect(contact.error, contact.error?.message).toBeNull();
  const id = await approvedPo(member, o);

  const printable = await getPrintablePurchaseOrder({ client: member.c, orgId: o.orgId }, id);
  expect(printable?.status).toBe('approved');
  expect(printable?.submitted_by).toBe(member.userId);
  expect(printable?.submitted_at).not.toBeNull();
  expect(printable?.approved_by).toBe(ownerId);
  expect(printable?.approved_at).not.toBeNull();
  expect(printable?.supplier).toMatchObject({ ssm_no: '201901000123', phone: '03-1234 5678' });
  expect(printable?.people[member.userId!]).toMatchObject({ full_name: 'Aisyah Rahman', job_title: 'Purchasing Executive', role: 'member' });
  expect(printable?.people[ownerId]).toMatchObject({ role: 'owner' });
  expect(printable?.lines).toHaveLength(2);
});
