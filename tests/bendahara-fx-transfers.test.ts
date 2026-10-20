import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { createBankAccount } from '@/lib/finance/bank-accounts';
import { type BankAccountRow, listBankAccounts, listBankTransactions } from '@/lib/finance/banking';
import { bankDescription } from '@/lib/finance/banking-views';
import { newTransferForm, transferName, transferPayload, transferRateNote } from '@/lib/finance/transfer-form';
import { TRANSFER_MESSAGES, recordTransfer, voidTransfer } from '@/lib/finance/transfers';

// Transfers between a ringgit account and an account in another currency (stage 5c,
// 20261122120000_bendahara_fx_transfers) against the hosted database, through the app's own data layer and form
// rules with a real client. Run by the controller only, after the migration is applied. Every refusal and role cell
// is proved by supabase/tests/bendahara_fx_transfers_check.sql; this file adds what only the API shows: the form's
// two-amount payload is taken by PostgREST, worked examples C5.1 and C5.2 post to the sen (one ringgit figure on both
// lines, no gain or loss), Banking reads both sides in their own currencies and the USD account's book value, a
// void reverses exactly, two accounts in other currencies hear FIN52 in the screen's words, and a member is told
// who can. It writes no BNM rate: every rate is the two amounts'. The helper deletes the workspace it makes.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Ctx = { client: SupabaseClient; orgId: string };

const today = new Date().toISOString().slice(0, 10);

/** A new owner's workspace, and a member invited into it. */
async function workspace(orgName: string): Promise<{ owner: Ctx; member: Ctx }> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'fx-transfers-member-pass-123');
  const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  return { owner: { client: c, orgId: orgId as string }, member: { client: m, orgId: orgId as string } };
}

async function added(ctx: Ctx, input: Parameters<typeof createBankAccount>[1]): Promise<string> {
  const made = await createBankAccount(ctx, input);
  if (!made.ok) throw new Error(made.error);
  return made.data.id;
}

/** The ledger lines of one transfer (or, with ':void', its reversal), by account name, in sen. */
async function entry(ctx: Ctx, transferId: string, suffix = ''): Promise<string[]> {
  const lines = await ctx.client
    .from('finance_ledger_lines')
    .select('account_id, debit, credit')
    .eq('org_id', ctx.orgId)
    .eq('entry_key', `transfer:${transferId}${suffix}`);
  expect(lines.error, lines.error?.message).toBeNull();
  const names = await ctx.client.from('finance_ledger_accounts').select('id, name').eq('org_id', ctx.orgId);
  expect(names.error, names.error?.message).toBeNull();
  const name = new Map((names.data ?? []).map((a) => [a.id as string, a.name as string]));
  const sen = (v: unknown) => Math.round(Number(v) * 100);
  return (lines.data ?? []).map((l) => `${name.get(l.account_id as string)} ${sen(l.debit)}/${sen(l.credit)}`).sort();
}

const balanceOf = (rows: BankAccountRow[], id: string) => {
  const row = rows.find((a) => a.id === id)!;
  return `${row.currency} ${row.balance} / RM ${row.balance_myr}`;
};

testWithSupabase('C5.1 and C5.2: ringgit to USD and back, one ringgit figure, a void reverses it; FIN52; a member', async () => {
  const { owner, member } = await workspace(`FX transfers ${Date.now()}`);
  const bank = (await listBankAccounts(owner)).find((a) => a.kind === 'bank')!;
  const usd = await added(owner, { name: 'USD Account', kind: 'bank', bank_name: 'HSBC', account_no: null, currency: 'USD' });
  // A5's account: USD 10,000.00 opened at 4.4620, typed (RM 44,620.00).
  const reserve = await added(owner, {
    name: 'USD Reserve', kind: 'bank', bank_name: 'HSBC', account_no: null, currency: 'USD', opening_balance: 10000,
    opening_date: today, opening_rate: '4.4620', opening_rate_source: 'manual',
  });
  const sgd = await added(owner, { name: 'SGD Account', kind: 'bank', bank_name: 'DBS', account_no: null, currency: 'SGD' });
  const accounts = await listBankAccounts(owner);

  // C5.1: RM 4,462.00 out of the bank, USD 1,000.00 into the USD account, as the form sends it.
  const c51 = { ...newTransferForm(today), from: bank.id, to: usd, amount: '4462', toAmount: '1000', reference: 'C5.1' };
  expect(transferRateNote(c51, accounts)).toBe('RM 4.4620 per 1 USD');

  // A member is told who can, and nothing is written.
  expect(await recordTransfer(member, transferPayload(c51, accounts))).toEqual({ ok: false, error: TRANSFER_MESSAGES.needsSignOff });
  expect((await listBankTransactions(owner)).filter((r) => r.kind === 'transfer')).toEqual([]);

  const recorded = await recordTransfer(owner, transferPayload(c51, accounts));
  expect(recorded).toMatchObject({ ok: true, data: { number: 'TR-0001' } });
  if (!recorded.ok) return;
  const sides = (await listBankTransactions(owner)).filter((r) => r.transfer_id === recorded.data.transfer_id);
  expect(
    sides.map((r) => [r.direction, r.currency, r.amount, r.fx_rate_text, r.fx_rate_source, r.amount_myr, r.other_currency, r.other_amount].join('|')).sort(),
  ).toEqual(['in|USD|1000|4.4620000000|transfer|4462|MYR|4462', 'out|MYR|4462|1.0000000000||4462|USD|1000']);
  const out = sides.find((r) => r.direction === 'out')!;
  expect(bankDescription(out)).toBe('Transfer to USD Account (USD 1,000.00)');
  expect(transferName(out)).toBe(`TR-0001 of RM 4,462.00 from ${bank.name} to USD Account as USD 1,000.00`);
  expect(await entry(owner, recorded.data.transfer_id)).toEqual([`${bank.name} 0/446200`, 'USD Account 446200/0']);
  expect(balanceOf(await listBankAccounts(owner), usd)).toBe('USD 1000 / RM 4462');

  // The void reverses exactly, and the USD account is back at nothing in both.
  expect(await voidTransfer(owner, { transfer_id: recorded.data.transfer_id })).toEqual({ ok: true, data: { transfer_id: recorded.data.transfer_id } });
  expect(await entry(owner, recorded.data.transfer_id, ':void')).toEqual([`${bank.name} 446200/0`, 'USD Account 0/446200']);
  expect(balanceOf(await listBankAccounts(owner), usd)).toBe('USD 0 / RM 0');

  // C5.2: USD 1,000.00 sold for RM 4,380.00. The reserve keeps the RM 82.00 for stage 6: no gain or loss is posted.
  const c52 = { ...newTransferForm(today), from: reserve, to: bank.id, amount: '1000', toAmount: '4380' };
  const sold = await recordTransfer(owner, transferPayload(c52, accounts));
  expect(sold).toMatchObject({ ok: true });
  if (!sold.ok) return;
  expect(await entry(owner, sold.data.transfer_id)).toEqual([`${bank.name} 438000/0`, 'USD Reserve 0/438000']);
  expect(balanceOf(await listBankAccounts(owner), reserve)).toBe('USD 9000 / RM 40240');
  const transferLines = await owner.client.from('finance_ledger_lines').select('entry_key').eq('org_id', owner.orgId).eq('source', 'transfer');
  expect(transferLines.error, transferLines.error?.message).toBeNull();
  expect(transferLines.data!.length).toBe(6);

  // Two accounts in other currencies: the screen's sentence, nothing written. No to_amount with a foreign account: FIN16.
  const before = (await listBankTransactions(owner)).length;
  expect(
    await recordTransfer(owner, { from_account_id: reserve, to_account_id: sgd, amount: 100, to_amount: 134, txn_date: today }),
  ).toEqual({ ok: false, error: TRANSFER_MESSAGES.twoForeign });
  expect(await owner.client.rpc('finance_record_transfer', { target_org: owner.orgId, transfer: { from_account_id: bank.id, to_account_id: usd, amount: 100 } })).toMatchObject({
    error: { code: 'FIN16' },
  });
  expect((await listBankTransactions(owner)).length).toBe(before);
});
