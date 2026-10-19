import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { BILL_MESSAGES, getBill, saveBill } from '@/lib/finance/bills';
import { createContact } from '@/lib/finance/contacts';
import { emptyLine } from '@/lib/finance/document-form';
import { withCurrency, withRateTyped } from '@/lib/finance/document-currency';
import { newPurchaseOrderForm, purchaseOrderPayload, withOrderSupplier } from '@/lib/finance/purchase-order-form';
import {
  PURCHASE_ORDER_MESSAGES,
  billFromPurchaseOrder,
  decidePurchaseOrder,
  getPurchaseOrder,
  savePurchaseOrder,
  submitPurchaseOrder,
} from '@/lib/finance/purchase-orders';
import { convertRfq, getRfq, quoteRfq, saveRfq, sendRfq } from '@/lib/finance/rfqs';

// RFQs and purchase orders in another currency (stage 4p, 20261121120000_bendahara_purchase_order_currency)
// against the hosted database, through the app's own data layer with a real client. Run by the controller only,
// after the migration is applied. Every refusal and every role is proved by
// supabase/tests/bendahara_purchase_order_currency_check.sql; this file adds what only the API shows: the form's
// payload is taken by PostgREST, the ringgit total and the exact rate text come back, and each refusal arrives as
// the screen's sentence. It writes no rate (finance_fx_rates is shared): the order's rate is typed by hand, and a
// bill made from it takes whatever Bank Negara rate the hosted table holds for today (or none).

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Ctx = { client: SupabaseClient; orgId: string };

async function owner(orgName: string): Promise<Ctx> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  return { client: c, orgId: orgId as string };
}

const today = new Date().toISOString().slice(0, 10);

/** Worked example P: 10 x USD 33.33 and 1 x USD 666.70, USD 1,000.00, as the form sends it at a rate typed as 4.083. */
async function exampleP(ctx: Ctx, rate: string | null) {
  const pacific = await createContact(ctx, { name: 'Pacific Tools Inc', is_customer: false, is_supplier: true, default_currency: 'USD' });
  if (!pacific.ok) throw new Error(pacific.error);
  let form = withOrderSupplier(newPurchaseOrderForm(today, 'k1'), { id: pacific.data.id, payment_terms_days: 30, default_currency: 'USD' });
  form = {
    ...form,
    lines: [
      { ...emptyLine('k1'), description: 'Bolts', quantity: '10', unit_price: '33.33' },
      { ...emptyLine('k2'), description: 'Press', quantity: '1', unit_price: '666.70' },
    ],
    fx: rate === null ? withCurrency(form.fx, 'USD', true) : withRateTyped(form.fx, rate),
  };
  const saved = await savePurchaseOrder(ctx, purchaseOrderPayload(form));
  if (!saved.ok) throw new Error(saved.error);
  return { id: saved.data.id, supplierId: pacific.data.id };
}

testWithSupabase('worked example P: a USD order reads its ringgit, and its bill is in USD', async () => {
  const ctx = await owner(`PO USD ${Date.now()}`);
  const { id, supplierId } = await exampleP(ctx, '4.083');
  expect(await getPurchaseOrder(ctx, id)).toMatchObject({
    currency: 'USD', fx_rate: 4.083, fx_rate_text: '4.0830000000', fx_rate_source: 'manual', fx_rate_date: null,
    total: 1000, total_myr: 4083,
  });

  expect((await submitPurchaseOrder(ctx, { id })).ok).toBe(true);
  // The smoke owner owns the workspace, so they may approve their own order.
  expect((await decidePurchaseOrder(ctx, { id, approve: true })).ok).toBe(true);

  const made = await billFromPurchaseOrder(ctx, { id, bill_date: today });
  expect(made.ok, made.ok ? '' : made.error).toBe(true);
  if (!made.ok) return;
  const bill = await getBill(ctx, made.data.bill_id);
  expect(bill?.currency).toBe('USD');
  expect(bill?.purchase_order_id).toBe(id);
  // The rule's rate for today when the hosted table has one (marked BNM's), else none for the form to ask.
  expect(bill?.fx_rate_source === 'bnm' || bill?.fx_rate === null).toBe(true);

  // A ringgit bill raised against the USD order is refused in the bill form's words (FIN49).
  const ringgit = await saveBill(ctx, {
    supplier_id: supplierId, bill_date: today, due_date: today, purchase_order_id: id,
    lines: [{ description: 'Press', quantity: 1, unit_price: 666.7 }],
  });
  expect(ringgit).toEqual({ ok: false, error: BILL_MESSAGES.orderCurrency });
});

testWithSupabase('a USD order with no rate is not submitted: the rate sentence', async () => {
  const ctx = await owner(`PO no rate ${Date.now()}`);
  const { id } = await exampleP(ctx, null);
  expect(await getPurchaseOrder(ctx, id)).toMatchObject({ currency: 'USD', fx_rate: null, total: 1000, total_myr: null });
  expect(await submitPurchaseOrder(ctx, { id })).toEqual({ ok: false, error: PURCHASE_ORDER_MESSAGES.rateBeforeSubmitting });
});

testWithSupabase('a USD RFQ with no rate is sent and quoted, and becomes a USD order', async () => {
  const ctx = await owner(`RFQ USD ${Date.now()}`);
  const pacific = await createContact(ctx, { name: 'Pacific Tools Inc', is_customer: false, is_supplier: true });
  if (!pacific.ok) throw new Error(pacific.error);
  const saved = await saveRfq(ctx, {
    supplier_id: pacific.data.id, rfq_date: today, currency: 'USD', fx_rate: null,
    lines: [{ description: 'Press', quantity: 1 }],
  });
  if (!saved.ok) throw new Error(saved.error);
  const id = saved.data.id;
  expect((await sendRfq(ctx, { id })).ok).toBe(true);
  const sent = await getRfq(ctx, id);
  expect((await quoteRfq(ctx, { id, prices: [{ line_id: sent!.lines[0].id, unit_price: 666.7 }] })).ok).toBe(true);
  expect(await getRfq(ctx, id)).toMatchObject({ status: 'quoted', currency: 'USD', total: 666.7, total_myr: null });

  const converted = await convertRfq(ctx, { id });
  expect(converted.ok).toBe(true);
  if (!converted.ok) return;
  const order = await getPurchaseOrder(ctx, converted.data.purchase_order_id);
  expect(order?.currency).toBe('USD');
  expect(order?.fx_rate_source === 'bnm' || order?.fx_rate === null).toBe(true);
});

testWithSupabase('a member may save a USD order but not submit it without a rate', async () => {
  const ctx = await owner(`PO member ${Date.now()}`);
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'fx-po-member-pass-123');
  const invite = await ctx.client.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  const mctx = { client: m, orgId: ctx.orgId };
  const { id } = await exampleP(mctx, null);
  expect(await submitPurchaseOrder(mctx, { id })).toEqual({ ok: false, error: PURCHASE_ORDER_MESSAGES.rateBeforeSubmitting });
});
