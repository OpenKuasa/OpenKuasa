import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { billPayload, newBillForm, withSupplier } from '@/lib/finance/bill-form';
import { listBills, postBill, saveBill } from '@/lib/finance/bills';
import { createContact } from '@/lib/finance/contacts';
import { withRateProvider, withRateReference, withRateTyped } from '@/lib/finance/document-currency';
import { emptyLine } from '@/lib/finance/document-form';
import {
  MONEY_MESSAGES,
  listAccounts,
  listPaymentsOut,
  recordPaymentOut,
  recordPaymentOutInRinggit,
} from '@/lib/finance/money';
import { newPaymentForm, payableBills, paymentPayload, paymentPreview, toggleBill, withRinggit } from '@/lib/finance/payment-form';

// Payments out of supplier bills in another currency (stage 4b, 20261121111000_bendahara_fx_payments_out) against
// the hosted database, through the app's own data layer and the payment form's own rules with a real client. Run
// by the controller only, after the migration is applied. Every role cell and every refusal is proved by
// supabase/tests/bendahara_fx_payments_out_check.sql; this file adds what only the API shows: the form's payload is
// taken by PostgREST, worked example B4 posts to the ledger as the plan works it (Accounts Payable 0.00, Realised
// Exchange Gain or Loss a net credit of RM 36.00), and each refusal arrives as the screen's or the assistant's
// sentence. It writes no rate (finance_fx_rates is shared): the bill's rate is typed by hand, from Maybank.

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

/** Worked example A4, posted: USD 1,000.00 with 8% SST (USD 1,080.00), typed at 4.2000 from Maybank (RM 4,536.00). */
async function postedUsdBill(ctx: Ctx, supplierId?: string) {
  let sup = supplierId;
  if (!sup) {
    const acme = await createContact(ctx, { name: 'Acme Supplies Pte Ltd', is_customer: false, is_supplier: true, default_currency: 'USD' });
    if (!acme.ok) throw new Error(acme.error);
    sup = acme.data.id;
  }
  let form = withSupplier(newBillForm(today, 'k1'), { id: sup, payment_terms_days: 30, default_currency: 'USD' });
  form = {
    ...form,
    lines: [{ ...emptyLine('k1'), description: 'Machine', quantity: '1', unit_price: '1000', sst_rate: '8' }],
    fx: withRateReference(withRateProvider(withRateTyped(form.fx, '4.2000'), 'malaysian_bank'), 'Maybank'),
  };
  const saved = await saveBill(ctx, billPayload(form));
  if (!saved.ok) throw new Error(saved.error);
  const posted = await postBill(ctx, { id: saved.data.id });
  if (!posted.ok) throw new Error(posted.error);
  return { id: saved.data.id, supplierId: sup };
}

/** A payment of `part` (in the bill's currency) with `ringgit` paid out, as the Payments Out form sends it. */
async function payThroughForm(ctx: Ctx, billId: string, supplierId: string, part: string, ringgit: string) {
  const payable = payableBills(await listBills(ctx), await listPaymentsOut(ctx));
  const accounts = await listAccounts(ctx);
  const bill = payable.find((b) => b.id === billId);
  if (!bill) throw new Error('the bill is not offered on Payments Out');
  const ticked = toggleBill({ ...newPaymentForm(payable, accounts, today), supplierId }, bill, true);
  const form = withRinggit({ ...ticked, amounts: { [billId]: part } }, ringgit);
  return { result: await recordPaymentOut(ctx, paymentPayload(form)), preview: paymentPreview(form, payable) };
}

/** A workspace's balance on one system ledger account (finance_ledger_balances: credit less debit for a liability or income). */
async function balanceOf(ctx: Ctx, systemKey: string): Promise<number> {
  const { data: accounts, error } = await ctx.client
    .from('finance_ledger_accounts')
    .select('id')
    .eq('org_id', ctx.orgId)
    .eq('system_key', systemKey);
  expect(error, error?.message).toBeNull();
  const ids = ((accounts ?? []) as { id: string }[]).map((a) => a.id);
  const { data, error: balErr } = await ctx.client
    .from('finance_ledger_balances')
    .select('balance')
    .eq('org_id', ctx.orgId)
    .in('account_id', ids);
  expect(balErr, balErr?.message).toBeNull();
  // In sen, so the sum is exact.
  return ((data ?? []) as { balance: string }[]).reduce((n, r) => n + Math.round(Number(r.balance) * 100), 0) / 100;
}

testWithSupabase('worked example B4: a USD bill paid in two parts leaves Payable at 0.00 and a realised gain of RM 36.00', async () => {
  const ctx = await owner(`Pay USD ${Date.now()}`);
  const { id, supplierId } = await postedUsdBill(ctx);

  // Payment 1: USD 400.00 with RM 1,700.00. Carried 1,680.00; a loss of 20.00.
  const first = await payThroughForm(ctx, id, supplierId, '400', '1700');
  expect(first.preview).toEqual(['The bill carries about RM 1,680.00 for what is paid.', 'Realised exchange loss of about RM 20.00.']);
  expect(first.result.ok, first.result.ok ? '' : first.result.error).toBe(true);
  // Payment 2: the last USD 680.00 with RM 2,800.00. Carried the 2,856.00 still open; a gain of 56.00.
  const second = await payThroughForm(ctx, id, supplierId, '680', '2800');
  expect(second.preview).toEqual(['The bill carries about RM 2,856.00 for what is paid.', 'Realised exchange gain of about RM 56.00.']);
  expect(second.result.ok, second.result.ok ? '' : second.result.error).toBe(true);

  const rows = (await listPaymentsOut(ctx)).filter((p) => p.bill_id === id).sort((a, b) => a.amount - b.amount);
  expect(rows.map((p) => [p.status, p.currency, p.amount, p.transaction_amount, p.amount_myr, p.carried_myr, p.realised_myr])).toEqual([
    ['posted', 'USD', 400, 1700, 1700, 1680, -20],
    ['posted', 'USD', 680, 2800, 2800, 2856, 56],
  ]);
  const bill = (await listBills(ctx)).find((b) => b.id === id);
  expect(bill).toMatchObject({ display_status: 'paid', balance: 0, balance_myr: 0 });

  // The ledger: the bill credited Payable 4,536.00; the payments debited 1,680.00 + 2,856.00.
  expect(await balanceOf(ctx, 'payable')).toBe(0);
  expect(await balanceOf(ctx, 'fx_realised')).toBe(36);
});

testWithSupabase('a USD bill is paid now: asked as scheduled, or with no ringgit, it is refused in the form’s words', async () => {
  const ctx = await owner(`Pay USD later ${Date.now()}`);
  const { id } = await postedUsdBill(ctx);
  const [bank] = (await listAccounts(ctx)).filter((a) => a.kind === 'bank');
  const payment = { account_id: bank.id, txn_date: today, method: 'bank_transfer' as const, allocations: [{ bill_id: id, amount: 100 }] };
  expect(await recordPaymentOut(ctx, { ...payment, scheduled: true, amount_myr: '420' })).toEqual({ ok: false, error: MONEY_MESSAGES.payNow });
  expect(await recordPaymentOut(ctx, payment)).toEqual({ ok: false, error: MONEY_MESSAGES.ringgitPaidOut });
  expect((await listPaymentsOut(ctx)).filter((p) => p.bill_id === id)).toEqual([]);
});

testWithSupabase('the assistant does not pay a USD bill; a ringgit bill paid by a ringgit payment reads as before', async () => {
  const ctx = await owner(`Pay MYR ${Date.now()}`);
  const { id } = await postedUsdBill(ctx);
  const [bank] = (await listAccounts(ctx)).filter((a) => a.kind === 'bank');
  const base = { account_id: bank.id, txn_date: today, method: 'bank_transfer' as const };
  expect(await recordPaymentOutInRinggit(ctx, { ...base, allocations: [{ bill_id: id, amount: 100 }] })).toEqual({
    ok: false,
    error: MONEY_MESSAGES.foreignBillByAssistant,
  });

  const kedai = await createContact(ctx, { name: 'Kedai Hardware', is_customer: false, is_supplier: true });
  if (!kedai.ok) throw new Error(kedai.error);
  const saved = await saveBill(ctx, {
    supplier_id: kedai.data.id, bill_date: today, due_date: today,
    lines: [{ description: 'Gloves', quantity: 10, unit_price: 12.5, sst_rate: 6 }],
  });
  if (!saved.ok) throw new Error(saved.error);
  expect((await postBill(ctx, { id: saved.data.id })).ok).toBe(true);
  // As the assistant records it: ringgit, no ringgit-paid-out figure.
  const paid = await recordPaymentOutInRinggit(ctx, { ...base, allocations: [{ bill_id: saved.data.id, amount: 50 }] });
  expect(paid.ok, paid.ok ? '' : paid.error).toBe(true);
  const [row] = (await listPaymentsOut(ctx)).filter((p) => p.bill_id === saved.data.id);
  expect(row).toMatchObject({ status: 'posted', currency: 'MYR', amount: 50, transaction_amount: 50, amount_myr: 50, carried_myr: 50, realised_myr: 0 });
  expect(await balanceOf(ctx, 'fx_realised')).toBe(0);
});
