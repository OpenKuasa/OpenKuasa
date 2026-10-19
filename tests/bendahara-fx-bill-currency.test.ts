import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { billPayload, newBillForm, withSupplier } from '@/lib/finance/bill-form';
import { BILL_MESSAGES, getBill, listBills, postBill, saveBill, saveBillInRinggit } from '@/lib/finance/bills';
import { createContact, listBillBalances } from '@/lib/finance/contacts';
import { emptyLine } from '@/lib/finance/document-form';
import { withRateProvider, withRateReference, withRateTyped } from '@/lib/finance/document-currency';
import { MONEY_MESSAGES, listAccounts, recordPaymentOut } from '@/lib/finance/money';
import { NEEDS_SIGN_OFF } from '@/lib/finance/result';

// Supplier bills in another currency (stage 4a, 20261121100000_bendahara_bill_currency) against the hosted
// database, through the app's own data layer with a real client. Run by the controller only, after the
// migration is applied. Every role cell and every refusal is proved by
// supabase/tests/bendahara_bill_currency_check.sql; this file adds what only the API shows: the form's payload
// is taken by PostgREST, the ringgit figures and the exact rate text come back, the ledger posts ringgit
// (worked example A4), and each refusal arrives as the screen's sentence. It writes no rate (finance_fx_rates is
// shared): the bill's rate is typed by hand, from a bank in Malaysia (Maybank).

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

/** Worked example A4: USD 1,000.00 with 8% SST (USD 1,080.00), typed at 4.2000 from Maybank, as the form sends it. */
async function usdDraft(ctx: Ctx) {
  const acme = await createContact(ctx, { name: 'Acme Supplies Pte Ltd', is_customer: false, is_supplier: true, default_currency: 'USD' });
  if (!acme.ok) throw new Error(acme.error);
  let form = withSupplier(newBillForm(today, 'k1'), { id: acme.data.id, payment_terms_days: 30, default_currency: 'USD' });
  form = {
    ...form,
    lines: [{ ...emptyLine('k1'), description: 'Machine', quantity: '1', unit_price: '1000', sst_rate: '8' }],
    fx: withRateReference(withRateProvider(withRateTyped(form.fx, '4.2000'), 'malaysian_bank'), 'Maybank'),
  };
  const saved = await saveBill(ctx, billPayload(form));
  if (!saved.ok) throw new Error(saved.error);
  return { id: saved.data.id, supplierId: acme.data.id };
}

testWithSupabase('a USD bill at a typed rate posts its ringgit, and a payment of it needs the ringgit paid out', async () => {
  const ctx = await owner(`Bill USD ${Date.now()}`);
  const { id } = await usdDraft(ctx);
  expect(await getBill(ctx, id)).toMatchObject({
    currency: 'USD', fx_rate: 4.2, fx_rate_text: '4.2000000000', fx_rate_source: 'manual', fx_rate_provider: 'malaysian_bank',
    fx_rate_reference: 'Maybank', total: 1080, subtotal_myr: 4200, sst_myr: 336, total_myr: 4536, balance_myr: 4536,
  });

  const posted = await postBill(ctx, { id });
  expect(posted.ok).toBe(true);

  // Worked example A4: Dr the bill's category 4,536.00; Cr Accounts Payable 4,536.00.
  const { data: ledger, error } = await ctx.client
    .from('finance_ledger_lines')
    .select('account_id, debit, credit')
    .eq('org_id', ctx.orgId)
    .eq('source', 'bill')
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
  const on = (payable: boolean, side: 'debit' | 'credit') =>
    rows
      .filter((r) => (keyOf.get(r.account_id) === 'payable') === payable)
      .reduce((n, r) => n + Math.round(Number(r[side]) * 100), 0) / 100;
  expect(on(true, 'credit')).toBe(4536);
  expect(on(false, 'debit')).toBe(4536);

  // The payable figures are ringgit.
  const balances = await listBillBalances(ctx);
  expect(balances.find((b) => b.balance === 4536)).toBeTruthy();

  // A payment of it with no ringgit paid out is refused with the payment form's sentence (FIN46; stage 4b pays it,
  // tests/bendahara-fx-payments-out.test.ts).
  const [bank] = (await listAccounts(ctx)).filter((a) => a.kind === 'bank');
  const paid = await recordPaymentOut(ctx, {
    account_id: bank.id, txn_date: today, method: 'bank_transfer', allocations: [{ bill_id: id, amount: 100 }],
  });
  expect(paid).toEqual({ ok: false, error: MONEY_MESSAGES.ringgitPaidOut });
});

testWithSupabase('the assistant does not edit a foreign draft; a ringgit bill in the same workspace reads as before', async () => {
  const ctx = await owner(`Bill MYR ${Date.now()}`);
  const { id, supplierId } = await usdDraft(ctx);
  expect(
    await saveBillInRinggit(ctx, {
      id, supplier_id: supplierId, bill_date: today, due_date: today, lines: [{ description: 'Machine', quantity: 1, unit_price: 1000 }],
    }),
  ).toEqual({ ok: false, error: BILL_MESSAGES.foreignDraftByAssistant });

  const kedai = await createContact(ctx, { name: 'Kedai Hardware', is_customer: false, is_supplier: true });
  if (!kedai.ok) throw new Error(kedai.error);
  // As the finance assistant saves one: no currency at all.
  const saved = await saveBillInRinggit(ctx, {
    supplier_id: kedai.data.id, bill_date: today, due_date: today,
    lines: [{ description: 'Gloves', quantity: 3, unit_price: 0.33, sst_rate: 8 }],
  });
  expect(saved.ok).toBe(true);
  const ringgit = (await listBills(ctx)).find((b) => b.currency === 'MYR');
  expect(ringgit).toMatchObject({ fx_rate: 1, fx_rate_source: null, total: 1.07, total_myr: 1.07, balance_myr: ringgit?.balance });
});

testWithSupabase('a member cannot post a foreign bill: the sign-off sentence, not the rate one', async () => {
  const ctx = await owner(`Bill member ${Date.now()}`);
  const { id } = await usdDraft(ctx);
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'fx-bill-member-pass-123');
  const invite = await ctx.client.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  expect(await postBill({ client: m, orgId: ctx.orgId }, { id })).toEqual({ ok: false, error: NEEDS_SIGN_OFF });
});
