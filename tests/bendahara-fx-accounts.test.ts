import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { BANK_ACCOUNT_MESSAGES, createBankAccount, updateBankAccount } from '@/lib/finance/bank-accounts';
import { listBankAccounts } from '@/lib/finance/banking';
import { createContact } from '@/lib/finance/contacts';
import { emptyLine } from '@/lib/finance/document-form';
import { invoicePayload, newInvoiceForm, withCustomer } from '@/lib/finance/invoice-form';
import { postInvoice, saveInvoice } from '@/lib/finance/invoices';
import { MONEY_MESSAGES, listAccounts, recordPaymentIn } from '@/lib/finance/money';

// Bank and cash accounts in another currency (stage 5a, 20261122100000_bendahara_account_currency) against the
// hosted database, through the app's own data layer with a real client. Run by the controller only, after the
// migration is applied. Every role cell and every refusal is proved by
// supabase/tests/bendahara_account_currency_check.sql; this file adds what only the API shows: the form's payload is
// taken by PostgREST with the new column grants, the opening balance posts its ringgit (worked example A5), a
// viewer still reads Banking and the account list through the new columns (the 20261031090300 column-grant
// incident), each refusal arrives as the screen's sentence, and a ringgit account reads as it always did. It writes
// no rate (finance_fx_rates is shared): the opening rate is typed by hand.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Ctx = { client: SupabaseClient; orgId: string };

const today = new Date().toISOString().slice(0, 10);

/** A new signed-up owner and their workspace, with a member and a viewer invited into it. */
async function workspace(orgName: string): Promise<{ owner: Ctx; member: Ctx; viewer: Ctx }> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const invited = async (role: 'member' | 'viewer'): Promise<Ctx> => {
    const client = liveClient();
    const signUp = await createConfirmedTestUser(client, `fx-accounts-${role}-pass-123`);
    const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: role });
    expect(invite.error, invite.error?.message).toBeNull();
    const accepted = await client.rpc('accept_invite', { p_token: invite.data });
    expect(accepted.error, accepted.error?.message).toBeNull();
    return { client, orgId: orgId as string };
  };
  return { owner: { client: c, orgId: orgId as string }, member: await invited('member'), viewer: await invited('viewer') };
}

/** Each ledger line of an account's opening entry, as "system key or 'the account' debit/credit", in sen. */
async function openingEntry(ctx: Ctx, accountId: string): Promise<string[]> {
  const { data: lines, error } = await ctx.client
    .from('finance_ledger_lines')
    .select('account_id, debit, credit')
    .eq('org_id', ctx.orgId)
    .eq('source', 'opening')
    .eq('source_id', accountId);
  expect(error, error?.message).toBeNull();
  const { data: accounts, error: accountsError } = await ctx.client
    .from('finance_ledger_accounts')
    .select('id, system_key, bank_account_id')
    .eq('org_id', ctx.orgId);
  expect(accountsError, accountsError?.message).toBeNull();
  const named = new Map(
    ((accounts ?? []) as { id: string; system_key: string | null; bank_account_id: string | null }[]).map((a) => [
      a.id,
      a.bank_account_id === accountId ? 'the account' : (a.system_key ?? '?'),
    ]),
  );
  const sen = (v: string | number) => Math.round(Number(v) * 100);
  return ((lines ?? []) as { account_id: string; debit: string; credit: string }[])
    .map((l) => `${named.get(l.account_id)} ${sen(l.debit)}/${sen(l.credit)}`)
    .sort();
}

testWithSupabase('worked example A5: a USD account opened at a typed rate posts its ringgit; Banking reads it for everyone', async () => {
  const { owner, member, viewer } = await workspace(`FX accounts ${Date.now()}`);

  // USD 10,000.00 at 4.4620, typed by hand: RM 44,620.00.
  const usd = await createBankAccount(owner, {
    name: 'USD Current', kind: 'bank', bank_name: 'Maybank', account_no: null, currency: 'USD', opening_balance: 10000,
    opening_date: today, opening_rate: '4.4620', opening_rate_source: 'manual',
  });
  expect(usd, usd.ok ? '' : usd.error).toMatchObject({ ok: true, data: { name: 'USD Current' } });
  if (!usd.ok) return;
  expect(await openingEntry(owner, usd.data.id)).toEqual(['opening_equity 0/4462000', 'the account 4462000/0']);

  // Everyone in the workspace reads Banking and the account list through the new columns.
  for (const who of [owner, member, viewer]) {
    const row = (await listBankAccounts(who)).find((a) => a.id === usd.data.id);
    expect(row).toMatchObject({
      currency: 'USD', balance: 10000, balance_myr: 44620, opening_balance_myr: 44620, opening_rate_text: '4.4620000000',
      opening_rate_source: 'manual', opening_rate_date: null,
    });
    const listed = (await listAccounts(who)).find((a) => a.id === usd.data.id);
    expect(listed).toMatchObject({ currency: 'USD' });
  }

  // A ringgit account reads its ringgit as its own figures.
  for (const row of (await listBankAccounts(owner)).filter((a) => a.currency === 'MYR')) {
    expect(row.balance_myr, row.name).toBe(row.balance);
    expect(row.opening_balance_myr, row.name).toBe(row.opening_balance);
    expect(row.opening_rate_text, row.name).toBe('1.0000000000');
  }

  // A member adds a USD account with no balance, and cannot give one a balance or change the owner's rate (FIN14).
  const empty = await createBankAccount(member, { name: 'USD Empty', kind: 'bank', bank_name: null, account_no: null, currency: 'USD' });
  expect(empty, empty.ok ? '' : empty.error).toMatchObject({ ok: true });
  expect(
    await createBankAccount(member, {
      name: 'Member USD', kind: 'bank', bank_name: null, account_no: null, currency: 'USD', opening_balance: 100, opening_rate: '4.5',
      opening_rate_source: 'manual',
    }),
  ).toEqual({ ok: false, error: BANK_ACCOUNT_MESSAGES.needsSignOff });
  expect(
    await updateBankAccount(member, { id: usd.data.id, name: 'USD Current', bank_name: 'Maybank', account_no: null, opening_rate: '4.5', opening_rate_source: 'manual' }),
  ).toEqual({ ok: false, error: BANK_ACCOUNT_MESSAGES.needsSignOff });
  // The schema asks for the rate first, so FIN38 is met from a payload that names none: the owner gives a balance by
  // hand without one.
  if (empty.ok) {
    const { error } = await owner.client.from('finance_accounts').update({ opening_balance: 100 }).eq('id', empty.data.id);
    expect(error?.code).toBe('FIN38');
    // The currency is chosen when the account is added: no one may change it (42501).
    const changed = await owner.client.from('finance_accounts').update({ currency: 'EUR' }).eq('id', empty.data.id);
    expect(changed.error?.code).toBe('42501');
  }
});

// 20261122110000 (stage 5b) opens money on an account in another currency, recorded with its rate: a payment in that
// names one with no rate now hears FIN38 (the rate is asked for before anything is written), not 5a's FIN50.
testWithSupabase('a payment in naming an account in another currency with no rate hears FIN38 in the screen\'s words, and writes nothing', async () => {
  const { owner } = await workspace(`FX accounts money ${Date.now()}`);
  const usd = await createBankAccount(owner, { name: 'USD Current', kind: 'bank', bank_name: null, account_no: null, currency: 'USD' });
  if (!usd.ok) throw new Error(usd.error);

  const acme = await createContact(owner, { name: 'Kedai Runcit Sdn Bhd', is_customer: true, is_supplier: false });
  if (!acme.ok) throw new Error(acme.error);
  let form = withCustomer(newInvoiceForm(today, 'k1'), { id: acme.data.id, payment_terms_days: 30, default_currency: null });
  form = { ...form, lines: [{ ...emptyLine('k1'), description: 'Goods', quantity: '1', unit_price: '100', sst_rate: '0' }] };
  const saved = await saveInvoice(owner, invoicePayload(form));
  if (!saved.ok) throw new Error(saved.error);
  expect((await postInvoice(owner, { id: saved.data.id })).ok).toBe(true);

  expect(
    await recordPaymentIn(owner, { account_id: usd.data.id, txn_date: today, method: 'bank_transfer', allocations: [{ invoice_id: saved.data.id, amount: 100 }] }),
  ).toEqual({ ok: false, error: MONEY_MESSAGES.rate });
  const { count, error } = await owner.client
    .from('finance_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', owner.orgId)
    .eq('account_id', usd.data.id);
  expect(error, error?.message).toBeNull();
  expect(count).toBe(0);

  // The same payment on the ringgit bank account goes through, at rate 1 with its ringgit null on the movement.
  const [bank] = (await listAccounts(owner)).filter((a) => a.kind === 'bank' && a.currency === 'MYR');
  const paid = await recordPaymentIn(owner, {
    account_id: bank.id, txn_date: today, method: 'bank_transfer', allocations: [{ invoice_id: saved.data.id, amount: 100 }],
  });
  expect(paid.ok, paid.ok ? '' : paid.error).toBe(true);
  if (!paid.ok) return;
  const { data: movement } = await owner.client
    .from('finance_transactions')
    .select('currency, fx_rate_text:fx_rate::text, fx_rate_source, amount_myr')
    .eq('id', paid.data.id)
    .maybeSingle();
  expect(movement).toEqual({ currency: 'MYR', fx_rate_text: '1.0000000000', fx_rate_source: null, amount_myr: null });
});
