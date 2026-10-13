import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { setBankAccountActive } from '@/lib/finance/bank-accounts';
import { listBankAccounts, listBankTransactions } from '@/lib/finance/banking';
import { withRunningBalance } from '@/lib/finance/banking-views';
import { bankRowActions, transferName } from '@/lib/finance/transfer-form';
import { NOT_ALLOWED } from '@/lib/finance/result';
import { TRANSFER_MESSAGES, recordTransfer, voidTransfer } from '@/lib/finance/transfers';

// Transfers between accounts against the hosted database, through the app's own data layer with a real client.
// Run by the controller only. It needs no migration of its own: finance_record_transfer and
// finance_void_transfer are used as they are on main (supabase/tests/bendahara_banking_check.sql proves them as
// each role). This file adds what only the API shows: that the payload the form sends is taken by PostgREST,
// that the number is read back, that both sides arrive in the rows the Transactions table is built from, and
// that each refusal arrives as the sentence the screen shows, for an owner, a member and a viewer. The browser smoke
// test runs as an owner, so the member and viewer answers are covered here and nowhere else. The helper deletes the
// workspace it makes.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Ctx = { client: SupabaseClient; orgId: string };

/** A new signed-up user and the workspace they own, and a member and a viewer invited into it. */
async function ownerAndMember(orgName: string): Promise<{ owner: Ctx; member: Ctx; viewer: Ctx }> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'transfers-member-pass-123');
  const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  const v = liveClient();
  const viewerSignUp = await createConfirmedTestUser(v, 'transfers-viewer-pass-123');
  const viewerInvite = await c.rpc('create_invite', { p_email: viewerSignUp.email, p_role: 'viewer' });
  expect(viewerInvite.error, viewerInvite.error?.message).toBeNull();
  const viewerAccepted = await v.rpc('accept_invite', { p_token: viewerInvite.data });
  expect(viewerAccepted.error, viewerAccepted.error?.message).toBeNull();
  return {
    owner: { client: c, orgId: orgId as string },
    member: { client: m, orgId: orgId as string },
    viewer: { client: v, orgId: orgId as string },
  };
}

testWithSupabase('an owner records a transfer and voids it; a member is told who can; refusals read as sentences', async () => {
  const { owner, member, viewer } = await ownerAndMember(`Transfers ${Date.now()}`);
  // A new workspace is seeded with a bank account and cash.
  const accounts = await listBankAccounts(owner);
  const bank = accounts.find((a) => a.kind === 'bank')!;
  const cash = accounts.find((a) => a.kind === 'cash')!;
  expect(bank && cash).toBeTruthy();
  const transfer = { from_account_id: bank.id, to_account_id: cash.id, amount: 120.5, txn_date: '2026-10-05', reference: 'TT-9', notes: '' };

  // A member: told who can, by the database (the action says the same before it gets this far). Nothing is written.
  expect(await recordTransfer(member, transfer)).toEqual({ ok: false, error: TRANSFER_MESSAGES.needsSignOff });
  expect((await listBankTransactions(owner)).filter((r) => r.kind === 'transfer')).toEqual([]);
  // A viewer: not allowed to write at all (42501). Nothing is written.
  expect(await recordTransfer(viewer, transfer)).toEqual({ ok: false, error: NOT_ALLOWED });
  expect((await listBankTransactions(owner)).filter((r) => r.kind === 'transfer')).toEqual([]);

  // The owner: recorded whole, numbered, and both sides are in the rows the table is built from.
  const recorded = await recordTransfer(owner, transfer);
  expect(recorded).toMatchObject({ ok: true, data: { number: 'TR-0001' } });
  if (!recorded.ok) return;
  const rows = await listBankTransactions(owner);
  const sides = rows.filter((r) => r.transfer_id === recorded.data.transfer_id);
  expect(sides.map((r) => [r.direction, r.account_name, r.other_account_name, r.amount, r.status, r.number, r.txn_date, r.method, r.reference].join('|')).sort()).toEqual([
    `in|${cash.name}|${bank.name}|120.5|posted|TR-0001|2026-10-05|cash|TT-9`,
    `out|${bank.name}|${cash.name}|120.5|posted|TR-0001|2026-10-05|cash|TT-9`,
  ]);
  expect(sides.every((r) => r.kind === 'transfer' && r.notes === null && r.party_name === null)).toBe(true);
  expect(transferName(sides[0])).toBe(`TR-0001 of RM 120.50 from ${bank.name} to ${cash.name}`);
  expect(sides.map((r) => bankRowActions(r, true))).toEqual([['void-transfer'], ['void-transfer']]);
  // Both balances moved, an overdraft included: nothing in the database refuses one.
  const after = await listBankAccounts(owner);
  expect(after.find((a) => a.id === bank.id)!.balance).toBe(-120.5);
  expect(after.find((a) => a.id === cash.id)!.balance).toBe(120.5);
  expect(withRunningBalance(after, rows).filter((r) => r.transfer_id === recorded.data.transfer_id).map((r) => r.balance).sort()).toEqual([-120.5, 120.5]);
  // It is in neither cash book view.
  for (const view of ['finance_cash_receipts', 'finance_payment_vouchers']) {
    const listed = await owner.client.from(view).select('transaction_id').eq('org_id', owner.orgId);
    expect(listed.error, listed.error?.message).toBeNull();
    expect(listed.data).toEqual([]);
  }
  // In the books it is one entry of two lines.
  const lines = await owner.client.from('finance_ledger_lines').select('source_no, debit, credit').eq('org_id', owner.orgId).eq('source', 'transfer');
  expect(lines.error, lines.error?.message).toBeNull();
  expect(lines.data!.map((l) => `${l.source_no}|${Number(l.debit)}|${Number(l.credit)}`).sort()).toEqual(['TR-0001|0|120.5', 'TR-0001|120.5|0']);

  // What the schema would have refused arrives as one sentence when it is sent anyway.
  expect(await owner.client.rpc('finance_record_transfer', { target_org: owner.orgId, transfer: { ...transfer, to_account_id: bank.id } })).toMatchObject({
    error: { code: 'FIN16' },
  });
  // An archived account: the function's own answer, as a sentence.
  expect(await setBankAccountActive(owner, { id: cash.id, active: false })).toMatchObject({ ok: true });
  expect(await recordTransfer(owner, transfer)).toEqual({ ok: false, error: TRANSFER_MESSAGES.accounts });

  // Voiding: a member is told who can; the owner voids both sides, with one account archived.
  expect(await voidTransfer(member, { transfer_id: recorded.data.transfer_id })).toEqual({ ok: false, error: TRANSFER_MESSAGES.needsSignOff });
  // A viewer cannot see the rows to lock (FIN11): the transfer is "no longer there" to them, and stays posted.
  expect(await voidTransfer(viewer, { transfer_id: recorded.data.transfer_id })).toEqual({ ok: false, error: TRANSFER_MESSAGES.gone });
  expect((await listBankTransactions(owner)).filter((r) => r.transfer_id === recorded.data.transfer_id).map((r) => r.status)).toEqual(['posted', 'posted']);
  expect(await voidTransfer(owner, { transfer_id: recorded.data.transfer_id })).toEqual({ ok: true, data: { transfer_id: recorded.data.transfer_id } });
  expect(await voidTransfer(owner, { transfer_id: recorded.data.transfer_id })).toEqual({ ok: false, error: TRANSFER_MESSAGES.alreadyVoid });
  expect(await voidTransfer(owner, { transfer_id: '00000000-0000-4000-8000-000000000000' })).toEqual({ ok: false, error: TRANSFER_MESSAGES.gone });
  const voided = (await listBankTransactions(owner)).filter((r) => r.transfer_id === recorded.data.transfer_id);
  expect(voided.map((r) => r.status)).toEqual(['void', 'void']);
  expect(voided.every((r) => r.number === 'TR-0001')).toBe(true);
  const back = await listBankAccounts(owner);
  expect(back.find((a) => a.id === bank.id)!.balance).toBe(0);
  expect(back.find((a) => a.id === cash.id)!.balance).toBe(0);
  // The next transfer takes the next number: a void keeps its own.
  expect(await setBankAccountActive(owner, { id: cash.id, active: true })).toMatchObject({ ok: true });
  expect(await recordTransfer(owner, { ...transfer, amount: 1 })).toMatchObject({ ok: true, data: { number: 'TR-0002' } });
});
