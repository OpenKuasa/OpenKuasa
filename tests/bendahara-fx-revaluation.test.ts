import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { billPayload, newBillForm, withSupplier } from '@/lib/finance/bill-form';
import { postBill, saveBill } from '@/lib/finance/bills';
import { createContact } from '@/lib/finance/contacts';
import { withRateProvider, withRateReference, withRateTyped } from '@/lib/finance/document-currency';
import { emptyLine } from '@/lib/finance/document-form';
import {
  FX_REVALUATION_MESSAGES as M,
  expectedOf,
  listFxRevaluations,
  postFxRevaluation,
  postFxRevaluationInput,
  previewFxRevaluation,
  previewFxRevaluationInput,
} from '@/lib/finance/fx-revaluation';
import { invoicePayload, newInvoiceForm, withCustomer } from '@/lib/finance/invoice-form';
import { postInvoice, saveInvoice } from '@/lib/finance/invoices';
import { listLedgerLines } from '@/lib/finance/ledger';
import { listAccounts, recordPaymentIn } from '@/lib/finance/money';

// Month-end FX revaluation (stage 6a, 20261123100000_bendahara_fx_revaluation) against the hosted database, through
// the app's own data layer with a real client. Run by the controller only, after the migration is applied. Every
// refusal and role cell is proved by supabase/tests/bendahara_fx_revaluation_check.sql; this file adds what only the
// API shows: the schemas' payload (rates per one unit as text, the expected figures) is taken by PostgREST, worked
// examples R1 and R2 preview and post to the sen, the ledger has the entry on the month end and its reversal the
// next day, Unrealised reads 0.00 today, and the refusals come back in the screen's words. It writes no BNM rate
// (finance_fx_rates is shared): every rate is typed. The month end is the last one before today, so the reversal
// is already in the books. The helper deletes the workspaces it makes.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Ctx = { client: SupabaseClient; orgId: string };

/** The last month end before today (UTC; a day either side of Malaysia's midnight never reaches the 1st's month). */
const now = new Date();
const E = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
const dayOf = (d: number) => `${E.slice(0, 8)}${String(d).padStart(2, '0')}`;
const nextDay = new Date(Date.parse(`${E}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const USD_448 = { USD: { rate: '4.48', source: 'manual' as const } };

/** A new owner's workspace, with a member and a viewer invited into it. */
async function workspace(orgName: string): Promise<{ owner: Ctx; member: Ctx; viewer: Ctx }> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const join = async (role: 'member' | 'viewer') => {
    const m = liveClient();
    const signUp = await createConfirmedTestUser(m, `fx-revaluation-${role}-pass-123`);
    const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: role });
    expect(invite.error, invite.error?.message).toBeNull();
    const accepted = await m.rpc('accept_invite', { p_token: invite.data });
    expect(accepted.error, accepted.error?.message).toBeNull();
    return { client: m, orgId: orgId as string };
  };
  return { owner: { client: c, orgId: orgId as string }, member: await join('member'), viewer: await join('viewer') };
}

const typedFromMaybank = <F extends { fx: Parameters<typeof withRateTyped>[0] }>(form: F): F => ({
  ...form,
  fx: withRateReference(withRateProvider(withRateTyped(form.fx, '4.2000'), 'malaysian_bank'), 'Maybank'),
});

testWithSupabase('R1 and R2: a USD invoice and bill revalued at a month end, posted, reversed the next day', async () => {
  const { owner, member, viewer } = await workspace(`FX revaluation ${Date.now()}`);
  const acme = await createContact(owner, { name: 'Acme Pte Ltd', is_customer: true, is_supplier: true, default_currency: 'USD' });
  if (!acme.ok) throw new Error(acme.error);
  const [bank] = (await listAccounts(owner)).filter((a) => a.kind === 'bank');

  // R1: invoice A, USD 1,000.00 at a typed 4.2000 (RM 4,200.00); P1: USD 400.00 received as RM 1,660.00 (carried 1,680.00).
  let inv = withCustomer(newInvoiceForm(dayOf(5), 'k1'), { id: acme.data.id, payment_terms_days: 30, default_currency: 'USD' });
  inv = typedFromMaybank({ ...inv, lines: [{ ...emptyLine('k1'), description: 'Consulting', quantity: '1', unit_price: '1000', sst_rate: '0' }] });
  const savedInvoice = await saveInvoice(owner, invoicePayload(inv));
  if (!savedInvoice.ok) throw new Error(savedInvoice.error);
  expect((await postInvoice(owner, { id: savedInvoice.data.id })).ok).toBe(true);
  const p1 = await recordPaymentIn(owner, {
    account_id: bank.id, txn_date: dayOf(20), method: 'bank_transfer', amount_myr: '1660.00',
    allocations: [{ invoice_id: savedInvoice.data.id, amount: 400 }],
  });
  expect(p1.ok, p1.ok ? '' : p1.error).toBe(true);

  // R2: bill B, USD 1,000.00 with 8% SST (USD 1,080.00) at a typed 4.2000 (RM 4,536.00).
  let bill = withSupplier(newBillForm(dayOf(12), 'k1'), { id: acme.data.id, payment_terms_days: 30, default_currency: 'USD' });
  bill = typedFromMaybank({ ...bill, lines: [{ ...emptyLine('k1'), description: 'Machine', quantity: '1', unit_price: '1000', sst_rate: '8' }] });
  const savedBill = await saveBill(owner, billPayload(bill));
  if (!savedBill.ok) throw new Error(savedBill.error);
  expect((await postBill(owner, { id: savedBill.data.id })).ok).toBe(true);

  // The preview at USD 4.4800, typed: A +168.00, B -302.40 (owing more).
  const preview = await previewFxRevaluation(owner, previewFxRevaluationInput.parse({ period_end: E, rates: USD_448 }));
  expect(preview.map((p) => [p.kind, p.reference, p.foreign_balance, p.carried_myr, p.rate_text, p.rate_source, p.revalued_myr, p.gain])).toEqual([
    ['bill', expect.any(String), 1080, 4536, '4.4800000000', 'manual', 4838.4, -302.4],
    ['invoice', expect.any(String), 600, 2520, '4.4800000000', 'manual', 2688, 168],
  ]);
  const expected = expectedOf(preview);
  expect(expected).toEqual({ lines: 2, net_gain: '-134.40', digest: expect.stringMatching(/^[0-9a-f]{32}$/) });

  // A viewer previews too; a member may not post (FIN14, in the screen's words), and nothing is written.
  expect(await previewFxRevaluation(viewer, previewFxRevaluationInput.parse({ period_end: E, rates: USD_448 }))).toHaveLength(2);
  const run = postFxRevaluationInput.parse({ period_end: E, rates: USD_448, expected });
  expect(await postFxRevaluation(member, run)).toEqual({ ok: false, error: M.needsSignOff });
  expect(await listFxRevaluations(owner)).toEqual([]);

  // Posted: FX-0001.
  const posted = await postFxRevaluation(owner, run);
  expect(posted).toMatchObject({ ok: true, data: { revaluation_no: 'FX-0001' } });
  if (!posted.ok) return;
  const [stored] = await listFxRevaluations(owner);
  expect(stored).toMatchObject({ revaluation_no: 'FX-0001', period_end: E, net_gain: -134.4 });
  expect(stored.rates).toEqual([{ currency: 'USD', rate_text: '4.4800000000', rate_source: 'manual', rate_date: null }]);
  expect(stored.lines.map((l) => [l.kind, l.posted_myr, l.gain]).sort()).toEqual([
    ['bill', 302.4, -302.4],
    ['invoice', 168, 168],
  ]);

  // The ledger: on E, Dr Receivable 168.00, Dr Unrealised 134.40, Cr Payable 302.40; the same swapped the next day.
  const accounts = await owner.client.from('finance_ledger_accounts').select('id, system_key').eq('org_id', owner.orgId);
  expect(accounts.error, accounts.error?.message).toBeNull();
  const keyOf = new Map((accounts.data ?? []).map((a) => [a.id as string, a.system_key as string | null]));
  const lines = (await listLedgerLines(owner)).filter((l) => l.source === 'fx_revaluation');
  const sen = (n: number) => Math.round(n * 100);
  const read = (key: string) =>
    lines
      .filter((l) => l.entry_key === key)
      .map((l) => `${l.entry_date} ${keyOf.get(l.account_id ?? '')} ${sen(l.debit)}/${sen(l.credit)}`)
      .sort();
  expect(read(`fx_revaluation:${posted.data.id}`)).toEqual([
    `${E} fx_unrealised 13440/0`,
    `${E} payable 0/30240`,
    `${E} receivable 16800/0`,
  ]);
  expect(read(`fx_revaluation:${posted.data.id}:reverse`)).toEqual([
    `${nextDay} fx_unrealised 0/13440`,
    `${nextDay} payable 30240/0`,
    `${nextDay} receivable 0/16800`,
  ]);

  // Unrealised reads 0.00 today: the reversal is in.
  const unrealised = [...keyOf].find(([, key]) => key === 'fx_unrealised')![0];
  const balance = await owner.client.from('finance_ledger_balances').select('balance').eq('account_id', unrealised).single();
  expect(balance.error, balance.error?.message).toBeNull();
  expect(Number(balance.data!.balance)).toBe(0);

  // A second post for the same month end has nothing to post (FIN56), in the screen's words.
  const again = await previewFxRevaluation(owner, previewFxRevaluationInput.parse({ period_end: E, rates: USD_448 }));
  expect(again.map((p) => p.posted_myr)).toEqual([0, 0]);
  expect(await postFxRevaluation(owner, postFxRevaluationInput.parse({ period_end: E, rates: USD_448, expected: expectedOf(again) }))).toEqual({
    ok: false,
    error: M.nothing(E),
  });
});

testWithSupabase('E6: a ringgit workspace has nothing to revalue', async () => {
  const { owner } = await workspace(`FX revaluation ringgit ${Date.now()}`);
  expect(await previewFxRevaluation(owner, previewFxRevaluationInput.parse({ period_end: E }))).toEqual([]);
  // Unrealised Exchange Gain or Loss is on its chart at 4910, with nothing on it.
  const account = await owner.client
    .from('finance_ledger_accounts')
    .select('code, name, type')
    .eq('org_id', owner.orgId)
    .eq('system_key', 'fx_unrealised')
    .single();
  expect(account.error, account.error?.message).toBeNull();
  expect(account.data).toEqual({ code: '4910', name: 'Unrealised Exchange Gain or Loss', type: 'income' });
});
