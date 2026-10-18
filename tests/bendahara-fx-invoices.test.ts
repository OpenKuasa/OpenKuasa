import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { createContact } from '@/lib/finance/contacts';
import { emptyLine } from '@/lib/finance/document-form';
import { withRateProvider, withRateTyped } from '@/lib/finance/document-currency';
import { invoicePayload, newInvoiceForm, withCustomer } from '@/lib/finance/invoice-form';
import { getInvoice, listInvoices, postInvoice, saveInvoice, voidInvoice } from '@/lib/finance/invoices';
import { NEEDS_SIGN_OFF } from '@/lib/finance/result';
import { RECEIPT_MESSAGES, listAccounts, recordPaymentIn } from '@/lib/finance/money';

// Invoices in another currency (stage 3a, 20261120100000_bendahara_invoice_currency) against the hosted
// database, through the app's own data layer with a real client. Run by the controller only, after the
// migration is applied. Every role cell and every refusal is proved by
// supabase/tests/bendahara_invoice_currency_check.sql; this file adds what only the API shows: the form's
// payload is taken by PostgREST, the ringgit figures and the exact rate text come back, the ledger posts
// ringgit (worked example A), and each refusal arrives as the screen's sentence. It writes no rate
// (finance_fx_rates is shared): the invoice's rate is typed by hand, from Reuters.

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

/** USD 1,000.00 with 8% SST (USD 1,080.00), typed at 4.2000 from Reuters, as the form sends it. */
async function usdDraft(ctx: Ctx) {
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
  return saved.data.id;
}

testWithSupabase('a USD invoice at a typed rate posts its ringgit, and a payment without the ringgit received is refused', async () => {
  const ctx = await owner(`Invoice USD ${Date.now()}`);
  const id = await usdDraft(ctx);
  expect(await getInvoice(ctx, id)).toMatchObject({
    currency: 'USD', fx_rate: 4.2, fx_rate_text: '4.2000000000', fx_rate_source: 'manual', fx_rate_provider: 'reuters',
    total: 1080, total_myr: 4536, sst_myr: 336, balance_myr: 4536,
  });

  const posted = await postInvoice(ctx, { id });
  expect(posted.ok).toBe(true);

  // Worked example A: Dr Receivable 4,536.00; Cr Sales 4,200.00; Cr SST Payable 336.00.
  // The view has no foreign key to embed through: the accounts are read on their own.
  const { data: ledger, error } = await ctx.client
    .from('finance_ledger_lines')
    .select('account_id, debit, credit')
    .eq('org_id', ctx.orgId)
    .eq('source', 'invoice')
    .eq('source_id', id);
  expect(error, error?.message).toBeNull();
  const { data: accounts, error: accountsError } = await ctx.client
    .from('finance_ledger_accounts')
    .select('id, system_key')
    .eq('org_id', ctx.orgId);
  expect(accountsError, accountsError?.message).toBeNull();
  const keyOf = new Map(((accounts ?? []) as { id: string; system_key: string | null }[]).map((a) => [a.id, a.system_key]));
  const rows = (ledger ?? []) as { account_id: string; debit: string; credit: string }[];
  // In sen, so the sums are exact.
  const on = (key: string | null, side: 'debit' | 'credit') =>
    rows.filter((r) => (keyOf.get(r.account_id) ?? null) === key).reduce((n, r) => n + Math.round(Number(r[side]) * 100), 0) / 100;
  expect(on('receivable', 'debit')).toBe(4536);
  expect(on(null, 'credit')).toBe(4200);
  expect(on('sst_payable', 'credit')).toBe(336);

  // A payment against it with no ringgit received is refused with the payment form's sentence (FIN46, stage 3b;
  // tests/bendahara-fx-payments-in.test.ts records one).
  const [bank] = (await listAccounts(ctx)).filter((a) => a.kind === 'bank');
  const paid = await recordPaymentIn(ctx, {
    account_id: bank.id, txn_date: today, method: 'fpx', allocations: [{ invoice_id: id, amount: 100 }],
  });
  expect(paid).toEqual({ ok: false, error: RECEIPT_MESSAGES.ringgitReceived });

  // Voided: the reversal swaps the same ringgit figures, so the invoice nets to nothing in the books.
  expect((await voidInvoice(ctx, { id })).ok).toBe(true);
  const { data: after, error: afterError } = await ctx.client
    .from('finance_ledger_lines')
    .select('entry_key, account_id, debit, credit')
    .eq('org_id', ctx.orgId)
    .eq('source', 'invoice')
    .eq('source_id', id);
  expect(afterError, afterError?.message).toBeNull();
  const reversal = ((after ?? []) as { entry_key: string; account_id: string; debit: string; credit: string }[]).filter((r) =>
    r.entry_key.endsWith(':void'),
  );
  const swapped = (key: string | null, side: 'debit' | 'credit') =>
    reversal.filter((r) => (keyOf.get(r.account_id) ?? null) === key).reduce((n, r) => n + Math.round(Number(r[side]) * 100), 0) / 100;
  expect(swapped('receivable', 'credit')).toBe(4536);
  expect(swapped(null, 'debit')).toBe(4200);
  expect(swapped('sst_payable', 'debit')).toBe(336);
});

testWithSupabase('a ringgit invoice in the same workspace reads exactly as before', async () => {
  const ctx = await owner(`Invoice MYR ${Date.now()}`);
  const kedai = await createContact(ctx, { name: 'Kedai Runcit', is_customer: true, is_supplier: false });
  if (!kedai.ok) throw new Error(kedai.error);
  // As the finance assistant saves one: no currency at all.
  const saved = await saveInvoice(ctx, {
    customer_id: kedai.data.id, invoice_date: today, due_date: today,
    lines: [{ description: 'Design work', quantity: 3, unit_price: 0.33, sst_rate: 8 }],
  });
  expect(saved.ok).toBe(true);
  await usdDraft(ctx);
  const ringgit = (await listInvoices(ctx)).find((i) => i.currency === 'MYR');
  expect(ringgit).toMatchObject({ fx_rate: 1, fx_rate_source: null, total: 1.07, total_myr: 1.07, balance_myr: ringgit?.balance });
});

testWithSupabase('a member cannot post a foreign invoice: the sign-off sentence, not the rate one', async () => {
  const ctx = await owner(`Invoice member ${Date.now()}`);
  const id = await usdDraft(ctx);
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'fx-invoice-member-pass-123');
  const invite = await ctx.client.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  expect(await postInvoice({ client: m, orgId: ctx.orgId }, { id })).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
});
