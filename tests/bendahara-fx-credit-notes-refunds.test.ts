import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { createContact } from '@/lib/finance/contacts';
import { issueCreditNote, listCreditNotes, saveCreditNote } from '@/lib/finance/credit-notes';
import { emptyLine } from '@/lib/finance/document-form';
import { withRateProvider, withRateTyped } from '@/lib/finance/document-currency';
import { invoicePayload, newInvoiceForm, withCustomer } from '@/lib/finance/invoice-form';
import { getInvoice, postInvoice, saveInvoice } from '@/lib/finance/invoices';
import { NEEDS_SIGN_OFF } from '@/lib/finance/result';
import { listAccounts, recordPaymentIn } from '@/lib/finance/money';
import { REFUND_MESSAGES, listRefunds, recordRefund } from '@/lib/finance/refunds';

// Credit notes and refunds on invoices in another currency (stage 3c,
// 20261120120000_bendahara_fx_credit_notes_refunds) against the hosted database, through the app's own data
// layer with a real client. Run by the controller only, after the migration is applied. Every refusal and role
// cell is proved by supabase/tests/bendahara_fx_credit_notes_refunds_check.sql; this file adds what only the API
// shows: the forms' payloads (a credit note in the invoice's currency; the ringgit paid out as text) are taken by
// PostgREST, worked examples C1 and D post to the sen, and the ledger's balances read Receivable 0.00 and Realised
// Exchange Gain or Loss a net credit of 8.60 after D. It writes no rate (finance_fx_rates is shared): the
// invoice's rate is typed by hand, from Reuters.

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

testWithSupabase('worked example C1: a USD credit note at the invoice’s rate, no exchange difference', async () => {
  const ctx = await owner(`FX credit notes ${Date.now()}`);
  const id = await postedUsdInvoice(ctx);
  const saved = await saveCreditNote(ctx, { invoice_id: id, credit_date: today, reason: 'returns', amount: 108 });
  if (!saved.ok) throw new Error(saved.error);
  const issued = await issueCreditNote(ctx, { id: saved.data.id });
  expect(issued.ok, issued.ok ? '' : issued.error).toBe(true);
  const [note] = (await listCreditNotes(ctx)).filter((n) => n.id === saved.data.id);
  expect(note).toMatchObject({ currency: 'USD', fx_rate: 4.2, amount: 108, amount_myr: 453.6, status: 'issued' });
  expect(await getInvoice(ctx, id)).toMatchObject({ credited: 108, balance: 972, balance_myr: 4082.4 });
  // Receivable: 4,536.00 less 453.60; nothing on Realised.
  const balances = await balancesBySystemKey(ctx);
  expect(balances.get('receivable')).toBe(408240);
  expect(balances.get('fx_realised') ?? 0).toBe(0);
});

testWithSupabase('worked example D: paid in full, credited, the credit refunded in ringgit with a gain of 8.60', async () => {
  const ctx = await owner(`FX refunds ${Date.now()}`);
  const id = await postedUsdInvoice(ctx);
  const [bank] = (await listAccounts(ctx)).filter((a) => a.kind === 'bank');
  const paid = await recordPaymentIn(ctx, {
    account_id: bank.id, txn_date: today, method: 'bank_transfer', amount_myr: '4536.00', allocations: [{ invoice_id: id, amount: 1080 }],
  });
  expect(paid.ok, paid.ok ? '' : paid.error).toBe(true);
  const saved = await saveCreditNote(ctx, { invoice_id: id, credit_date: today, reason: 'returns', amount: 108 });
  if (!saved.ok) throw new Error(saved.error);
  expect((await issueCreditNote(ctx, { id: saved.data.id })).ok).toBe(true);
  // On a paid invoice the credit note takes the part at the rate: RM 453.60, and the customer is in credit.
  expect(await getInvoice(ctx, id)).toMatchObject({ balance: -108, balance_myr: -453.6 });

  // Asked as scheduled: refused (FIN47) in the refunds' own words.
  expect(
    await recordRefund(ctx, {
      credit_note_id: saved.data.id, account_id: bank.id, txn_date: today, method: 'bank_transfer', reason: 'damaged_goods',
      amount: 108, amount_myr: '445.00', scheduled: true,
    }),
  ).toEqual({ ok: false, error: REFUND_MESSAGES.payNow });

  const refunded = await recordRefund(ctx, {
    credit_note_id: saved.data.id, account_id: bank.id, txn_date: today, method: 'bank_transfer', reason: 'damaged_goods',
    amount: 108, amount_myr: '445.00',
  });
  expect(refunded.ok, refunded.ok ? '' : refunded.error).toBe(true);
  const [row] = (await listRefunds(ctx)).filter((r) => r.invoice_id === id);
  expect(row).toMatchObject({
    currency: 'USD', amount: 108, transaction_amount: 445, amount_myr: 445, carried_myr: 453.6, realised_myr: 8.6, status: 'posted',
  });
  expect(await getInvoice(ctx, id)).toMatchObject({ balance: 0, balance_myr: 0 });

  // Receivable back at 0.00; Realised Exchange Gain or Loss a net credit (gain) of 8.60.
  const balances = await balancesBySystemKey(ctx);
  expect(balances.get('receivable')).toBe(0);
  expect(balances.get('fx_realised')).toBe(-860);
});

testWithSupabase('a member recording a refund on a USD invoice hears the sign-off sentence', async () => {
  const ctx = await owner(`FX refunds member ${Date.now()}`);
  const id = await postedUsdInvoice(ctx);
  const [bank] = (await listAccounts(ctx)).filter((a) => a.kind === 'bank');
  expect(
    (await recordPaymentIn(ctx, {
      account_id: bank.id, txn_date: today, method: 'bank_transfer', amount_myr: '4536.00', allocations: [{ invoice_id: id, amount: 1080 }],
    })).ok,
  ).toBe(true);
  const saved = await saveCreditNote(ctx, { invoice_id: id, credit_date: today, reason: 'returns', amount: 108 });
  if (!saved.ok) throw new Error(saved.error);
  expect((await issueCreditNote(ctx, { id: saved.data.id })).ok).toBe(true);
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'fx-refund-member-pass-123');
  const invite = await ctx.client.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  expect(
    await recordRefund({ client: m, orgId: ctx.orgId }, {
      credit_note_id: saved.data.id, account_id: bank.id, txn_date: today, method: 'fpx', reason: 'damaged_goods',
      amount: 108, amount_myr: '445',
    }),
  ).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
});
