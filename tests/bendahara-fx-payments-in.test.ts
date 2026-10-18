import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { createContact } from '@/lib/finance/contacts';
import { emptyLine } from '@/lib/finance/document-form';
import { withRateProvider, withRateTyped } from '@/lib/finance/document-currency';
import { invoicePayload, newInvoiceForm, withCustomer } from '@/lib/finance/invoice-form';
import { getInvoice, postInvoice, saveInvoice } from '@/lib/finance/invoices';
import { NEEDS_SIGN_OFF } from '@/lib/finance/result';
import { listAccounts, listPaymentsIn, recordPaymentIn } from '@/lib/finance/money';

// Payments in on invoices in another currency (stage 3b, 20261120110000_bendahara_fx_payments_in) against the
// hosted database, through the app's own data layer with a real client. Run by the controller only, after the
// migration is applied. Every refusal and role cell is proved by supabase/tests/bendahara_fx_payments_in_check.sql;
// this file adds what only the API shows: the payment form's payload (the ringgit received as text) is taken by
// PostgREST, worked example B posts to the sen, and the ledger's balances read Receivable 0.00 and Realised
// Exchange Gain or Loss a net credit of 5.50. It writes no rate (finance_fx_rates is shared): the invoice's
// rate is typed by hand, from Reuters.

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

/** USD 1,000.00 with 8% SST (USD 1,080.00, RM 4,536.00), typed at 4.2000 from Reuters, posted. */
async function postedUsdInvoice(ctx: Ctx) {
  const acme = await createContact(ctx, { name: 'Acme Pte Ltd', is_customer: true, is_supplier: false, default_currency: 'USD' });
  if (!acme.ok) throw new Error(acme.error);
  let form = withCustomer(newInvoiceForm(today, 'k1'), { id: acme.data.id, payment_terms_days: 30, default_currency: 'USD' });
  form = {
    ...form,
    lines: [{ ...emptyLine('k1'), description: 'Consulting', quantity: '1', unit_price: '1000', sst_rate: '8' }],
    fx: withRateProvider(withRateTyped(form.fx, '4.2000'), 'reuters'),
  };
  const saved = await saveInvoice(ctx, invoicePayload(form));
  if (!saved.ok) throw new Error(saved.error);
  const posted = await postInvoice(ctx, { id: saved.data.id });
  expect(posted.ok).toBe(true);
  return saved.data.id;
}

/** Each system account's balance (debit less credit), in sen so the figures are exact. */
async function balancesBySystemKey(ctx: Ctx): Promise<Map<string, number>> {
  const { data: accounts, error: accountsError } = await ctx.client
    .from('finance_ledger_accounts')
    .select('id, system_key')
    .eq('org_id', ctx.orgId);
  expect(accountsError, accountsError?.message).toBeNull();
  const { data, error } = await ctx.client
    .from('finance_ledger_balances')
    .select('account_id, debit_total, credit_total')
    .eq('org_id', ctx.orgId);
  expect(error, error?.message).toBeNull();
  const keyOf = new Map(((accounts ?? []) as { id: string; system_key: string | null }[]).map((a) => [a.id, a.system_key]));
  const out = new Map<string, number>();
  for (const row of (data ?? []) as { account_id: string; debit_total: string; credit_total: string }[]) {
    const key = keyOf.get(row.account_id);
    if (key) out.set(key, Math.round(Number(row.debit_total) * 100) - Math.round(Number(row.credit_total) * 100));
  }
  return out;
}

testWithSupabase('worked example B: a USD invoice paid in two parts, in ringgit, with its realised gain and loss', async () => {
  const ctx = await owner(`FX payments ${Date.now()}`);
  const id = await postedUsdInvoice(ctx);
  const [bank] = (await listAccounts(ctx)).filter((a) => a.kind === 'bank');

  // Payment 1: USD 400.00 settled, RM 1,658.00 arrived; carried RM 1,680.00, a loss of RM 22.00.
  const first = await recordPaymentIn(ctx, {
    account_id: bank.id, txn_date: today, method: 'bank_transfer', amount_myr: '1658.00', allocations: [{ invoice_id: id, amount: 400 }],
  });
  expect(first.ok, first.ok ? '' : first.error).toBe(true);
  expect(await getInvoice(ctx, id)).toMatchObject({ balance: 680, balance_myr: 2856, paid_myr: 1680 });

  // Payment 2: USD 680.00 settled, RM 2,883.50 arrived; it closes the invoice, carried RM 2,856.00, a gain of 27.50.
  const second = await recordPaymentIn(ctx, {
    account_id: bank.id, txn_date: today, method: 'bank_transfer', amount_myr: '2883.50', allocations: [{ invoice_id: id, amount: 680 }],
  });
  expect(second.ok, second.ok ? '' : second.error).toBe(true);
  expect(await getInvoice(ctx, id)).toMatchObject({ balance: 0, balance_myr: 0, paid_myr: 4536, display_status: 'paid' });

  const rows = (await listPaymentsIn(ctx)).filter((p) => p.invoice_id === id).sort((a, b) => a.amount - b.amount);
  expect(rows.map((p) => [p.currency, p.amount, p.transaction_amount, p.amount_myr, p.carried_myr, p.realised_myr])).toEqual([
    ['USD', 400, 1658, 1658, 1680, -22],
    ['USD', 680, 2883.5, 2883.5, 2856, 27.5],
  ]);

  // Receivable back at 0.00; Realised Exchange Gain or Loss a net credit (gain) of 5.50.
  const balances = await balancesBySystemKey(ctx);
  expect(balances.get('receivable')).toBe(0);
  expect(balances.get('fx_realised')).toBe(-550);
});

testWithSupabase('a payment of a ringgit invoice is what it always was', async () => {
  const ctx = await owner(`FX payments MYR ${Date.now()}`);
  const kedai = await createContact(ctx, { name: 'Kedai Runcit', is_customer: true, is_supplier: false });
  if (!kedai.ok) throw new Error(kedai.error);
  const saved = await saveInvoice(ctx, {
    customer_id: kedai.data.id, invoice_date: today, due_date: today,
    lines: [{ description: 'Parts', quantity: 10, unit_price: 12.5, sst_rate: 6 }],
  });
  if (!saved.ok) throw new Error(saved.error);
  expect((await postInvoice(ctx, { id: saved.data.id })).ok).toBe(true);
  const [bank] = (await listAccounts(ctx)).filter((a) => a.kind === 'bank');
  const paid = await recordPaymentIn(ctx, {
    account_id: bank.id, txn_date: today, method: 'fpx', allocations: [{ invoice_id: saved.data.id, amount: 132.5 }],
  });
  expect(paid.ok).toBe(true);
  const [row] = (await listPaymentsIn(ctx)).filter((p) => p.invoice_id === saved.data.id);
  expect(row).toMatchObject({ currency: 'MYR', amount: 132.5, transaction_amount: 132.5, amount_myr: 132.5, carried_myr: 132.5, realised_myr: 0 });
  const balances = await balancesBySystemKey(ctx);
  expect(balances.get('receivable')).toBe(0);
  expect(balances.get('fx_realised') ?? 0).toBe(0);
});

testWithSupabase('a member recording a payment on a USD invoice hears the sign-off sentence', async () => {
  const ctx = await owner(`FX payments member ${Date.now()}`);
  const id = await postedUsdInvoice(ctx);
  const [bank] = (await listAccounts(ctx)).filter((a) => a.kind === 'bank');
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'fx-payment-member-pass-123');
  const invite = await ctx.client.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  expect(
    await recordPaymentIn({ client: m, orgId: ctx.orgId }, {
      account_id: bank.id, txn_date: today, method: 'fpx', amount_myr: '400', allocations: [{ invoice_id: id, amount: 100 }],
    }),
  ).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
});
