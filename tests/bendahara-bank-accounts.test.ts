import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { BANK_ACCOUNT_MESSAGES, createBankAccount, listBankAccountNumbers, setBankAccountActive, updateBankAccount } from '@/lib/finance/bank-accounts';
import { listBankAccounts } from '@/lib/finance/banking';
import { listAccounts } from '@/lib/finance/money';

// Bank and cash accounts against the hosted database, through the app's own
// data layer with a real client. Run by the controller only, after
// 20261114110000_bendahara_bank_account_rules is applied: until then a member's
// opening balance is taken and most of this file fails. What each role may
// and may not do, at length, is proved by
// supabase/tests/bendahara_bank_accounts_check.sql, which acts as each of them.
// This file adds what only the API shows: that the payloads the forms send
// are taken by PostgREST with the columns that are now closed, and that each
// refusal arrives as the sentence the screen shows.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Ctx = { client: SupabaseClient; orgId: string };

/** A new signed-up user and the workspace they own, and a member invited into it. */
async function ownerAndMember(orgName: string): Promise<{ owner: Ctx; member: Ctx; utilities: string }> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  // A member needs an address to accept an invite sent to it; see finance-write-guards.rls.test.ts.
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'accounts-member-pass-123');
  const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  const { data: categories } = await c.from('finance_categories').select('id, name, kind').eq('org_id', orgId);
  return {
    owner: { client: c, orgId: orgId as string },
    member: { client: m, orgId: orgId as string },
    utilities: categories!.find((x) => x.kind === 'expense' && x.name === 'Utilities')!.id as string,
  };
}

testWithSupabase('an owner adds an account with an opening balance and a number; a member adds one without, and cannot give it one', async () => {
  const { owner, member } = await ownerAndMember(`Accounts forms ${Date.now()}`);

  const savings = await createBankAccount(owner, {
    name: 'Savings',
    kind: 'bank',
    bank_name: 'Check Bank',
    account_no: '8001234567',
    opening_balance: 1500,
    opening_date: '2026-09-30',
  });
  expect(savings).toMatchObject({ ok: true, data: { name: 'Savings', active: true } });
  if (!savings.ok) return;

  // Both read the number through the function; the balances view carries the opening balance and no number.
  for (const who of [owner, member]) {
    expect(await listBankAccountNumbers(who)).toEqual({ [savings.data.id]: '8001234567' });
    const listed = (await listBankAccounts(who)).find((a) => a.id === savings.data.id);
    expect(listed).toMatchObject({ opening_balance: 1500, opening_date: '2026-09-30', balance: 1500, bank_name: 'Check Bank' });
  }

  expect(await createBankAccount(owner, { name: 'savings', kind: 'cash' })).toEqual({ ok: false, error: BANK_ACCOUNT_MESSAGES.nameTaken });

  const tin = await createBankAccount(member, { name: 'Petty cash tin', kind: 'cash' });
  expect(tin).toMatchObject({ ok: true, data: { name: 'Petty cash tin' } });
  expect(await createBankAccount(member, { name: 'Member money', kind: 'bank', opening_balance: 10 })).toEqual({
    ok: false,
    error: BANK_ACCOUNT_MESSAGES.needsSignOff,
  });
  // A member edits the name and bank details of the owner's account, and not its opening balance or date.
  expect(await updateBankAccount(member, { id: savings.data.id, name: 'Savings account', bank_name: 'Other Bank', account_no: '8009999999' })).toMatchObject({
    ok: true,
    data: { name: 'Savings account' },
  });
  expect(await updateBankAccount(member, { id: savings.data.id, name: 'Savings account', opening_balance: 0 })).toEqual({
    ok: false,
    error: BANK_ACCOUNT_MESSAGES.needsSignOff,
  });
  expect(await updateBankAccount(member, { id: savings.data.id, name: 'Savings account', opening_date: '2020-01-01' })).toEqual({
    ok: false,
    error: BANK_ACCOUNT_MESSAGES.needsSignOff,
  });
  expect(await updateBankAccount(owner, { id: savings.data.id, name: 'Savings account', bank_name: 'Other Bank', account_no: '8009999999', opening_balance: -20.5, opening_date: '2026-10-01' })).toMatchObject({ ok: true });
  const after = (await listBankAccounts(owner)).find((a) => a.id === savings.data.id);
  expect(after).toMatchObject({ name: 'Savings account', bank_name: 'Other Bank', opening_balance: -20.5, opening_date: '2026-10-01' });
  expect((await listBankAccountNumbers(owner))[savings.data.id]).toBe('8009999999');

  // What nobody signed in writes, sent straight to the API.
  const kind = await owner.client.from('finance_accounts').update({ kind: 'cash' }).eq('id', savings.data.id).select('id');
  expect(kind.error?.code).toBe('42501');
  const nan = await owner.client.from('finance_accounts').update({ opening_balance: 'NaN' }).eq('id', savings.data.id).select('id');
  expect(nan.error?.code).toBe('23514');
  expect(await updateBankAccount(owner, { id: crypto.randomUUID(), name: 'Nobody' })).toEqual({ ok: false, error: BANK_ACCOUNT_MESSAGES.gone });
});

testWithSupabase('an archived account leaves the pickers and comes back; one with money still to be paid is not archived', async () => {
  const { owner, member, utilities } = await ownerAndMember(`Accounts archive ${Date.now()}`);
  const made = await createBankAccount(owner, { name: 'Operating', kind: 'bank' });
  expect(made.ok).toBe(true);
  if (!made.ok) return;
  const id = made.data.id;

  expect(await setBankAccountActive(member, { id, active: false })).toMatchObject({ ok: true, data: { active: false } });
  expect((await listAccounts(owner)).map((a) => a.id)).not.toContain(id);
  expect((await listBankAccounts(owner)).find((a) => a.id === id)).toMatchObject({ active: false });
  expect(await setBankAccountActive(member, { id, active: true })).toMatchObject({ ok: true, data: { active: true } });
  expect((await listAccounts(owner)).map((a) => a.id)).toContain(id);

  // A member's voucher for an expense category waits for approval: the account cannot be put away under it.
  const voucher = await member.client.rpc('finance_record_voucher', {
    target_org: member.orgId,
    voucher: { account_id: id, method: 'bank_transfer', amount: 25, party_name: 'Check Bank', category_id: utilities },
    allocations: [],
  });
  expect(voucher.error, voucher.error?.message).toBeNull();
  for (const who of [member, owner]) {
    expect(await setBankAccountActive(who, { id, active: false })).toEqual({ ok: false, error: BANK_ACCOUNT_MESSAGES.inUse });
  }
  // Rejected, it holds the account no longer.
  const rejected = await owner.client
    .from('finance_transactions')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', voucher.data)
    .select('id');
  expect(rejected.error, rejected.error?.message).toBeNull();
  expect(await setBankAccountActive(owner, { id, active: false })).toMatchObject({ ok: true, data: { active: false } });
});

testWithSupabase('who made a statement import is not the caller’s to say', async () => {
  const { owner, member } = await ownerAndMember(`Accounts imports ${Date.now()}`);
  const { data: accounts } = await owner.client.from('finance_accounts').select('id, kind').eq('org_id', owner.orgId);
  const bank = accounts!.find((a) => a.kind === 'bank')!.id as string;
  const { data: me } = await owner.client.auth.getUser();

  const forged = await member.client
    .from('finance_statement_imports')
    .insert({ org_id: member.orgId, account_id: bank, file_name: 'x.csv', created_by: me.user!.id })
    .select('id');
  expect(forged.error?.code).toBe('42501');

  const imported = await member.client.rpc('finance_import_statement', {
    target_org: member.orgId,
    target_account: bank,
    file_name: 'member.csv',
    lines: [{ line_date: '2026-10-01', description: 'FPX', money_out: 7 }],
  });
  expect(imported.error, imported.error?.message).toBeNull();
  const { data: mine } = await member.client.auth.getUser();
  const { data: row } = await member.client.from('finance_statement_imports').select('created_by').eq('id', imported.data).single();
  expect(row!.created_by).toBe(mine.user!.id);
  const moved = await member.client
    .from('finance_statement_imports')
    .update({ created_at: '2036-01-01T00:00:00Z' })
    .eq('id', imported.data)
    .select('id');
  expect(moved.error?.code).toBe('42501');
});
