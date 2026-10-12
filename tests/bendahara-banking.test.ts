import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, joinDemo, signInAnon, liveClient, signInOwner } from './helpers/live-workspaces';

// Banking against the hosted database: transfers between accounts, balances,
// statement lines and their matches. Run by the controller only, after the
// banking migrations are applied, 20261031090300_bendahara_banking_write_guards_fit
// included: until then the balances view cannot be read and no transfer can
// be recorded, and most of this file fails. Every workspace here is made by
// a signed-up user, who is its owner (a demo guest may not make one). One
// test invites a member (a writer who is not an owner or admin), the way
// finance-write-guards.rls.test.ts does. What an admin, an editor and a
// viewer may and may not do, at length, is proved by
// supabase/tests/bendahara_banking_check.sql, which acts as each of them.
// This file adds what only the API and real concurrent sessions can show.
// The last test reads the demo seed.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Org = { c: SupabaseClient; userId: string; orgId: string; bank: string; till: string; savings: string; sales: string };

/** A new signed-up user and the workspace they own, with a second bank account. */
async function ownerWithOrg(orgName: string): Promise<Org> {
  const c = liveClient();
  const { data: auth, error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const { data: accounts } = await c.from('finance_accounts').select('id, kind').eq('org_id', orgId);
  const { data: categories } = await c.from('finance_categories').select('id, name, kind').eq('org_id', orgId);
  const { data: savings, error: savingsErr } = await c
    .from('finance_accounts')
    .insert({ org_id: orgId, name: 'Savings', kind: 'bank' })
    .select('id')
    .single();
  expect(savingsErr, savingsErr?.message).toBeNull();
  return {
    c,
    userId: auth.user!.id,
    orgId: orgId as string,
    bank: accounts!.find((a) => a.kind === 'bank')!.id as string,
    till: accounts!.find((a) => a.kind === 'cash')!.id as string,
    savings: savings!.id as string,
    sales: categories!.find((x) => x.kind === 'income' && x.name === 'Sales')!.id as string,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

async function transfer(o: Org, from: string, to: string, amount: number) {
  return o.c.rpc('finance_record_transfer', {
    target_org: o.orgId,
    transfer: { from_account_id: from, to_account_id: to, amount, txn_date: today() },
  });
}

/** A posted receipt for income of the given amount into the bank; returns its id. */
async function income(o: Org, amount: number): Promise<string> {
  const saved = await o.c.rpc('finance_save_cash_receipt', {
    target_org: o.orgId,
    receipt: { account_id: o.bank, method: 'fpx', amount, party_name: 'Walk-in', category_id: o.sales },
    allocations: [],
  });
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_cash_receipt', { target_org: o.orgId, target_txn: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return saved.data as string;
}

async function balances(o: Org): Promise<Record<string, number>> {
  const { data, error } = await o.c.from('finance_account_balances').select('id, balance').eq('org_id', o.orgId);
  expect(error, error?.message).toBeNull();
  return Object.fromEntries((data ?? []).map((a) => [a.id as string, Number(a.balance)]));
}

testWithSupabase('a transfer is two posted sides with one TR- number, and is in neither cash book view', async () => {
  const o = await ownerWithOrg(`Banking transfer ${Date.now()}`);
  const made = await transfer(o, o.bank, o.savings, 250.5);
  expect(made.error, made.error?.message).toBeNull();

  const { data: sides } = await o.c
    .from('finance_bank_transactions')
    .select('transaction_id, direction, account_id, amount, status, number, kind, other_account_name, reconciled')
    .eq('org_id', o.orgId)
    .eq('transfer_id', made.data);
  expect(sides).toHaveLength(2);
  expect(new Set(sides!.map((s) => s.number))).toEqual(new Set(['TR-0001']));
  expect(sides!.every((s) => s.status === 'posted' && s.kind === 'transfer' && Number(s.amount) === 250.5 && !s.reconciled)).toBe(true);
  expect(sides!.find((s) => s.direction === 'out')).toMatchObject({ account_id: o.bank, other_account_name: 'Savings' });
  expect(sides!.find((s) => s.direction === 'in')).toMatchObject({ account_id: o.savings, other_account_name: 'Main Bank' });

  const ids = sides!.map((s) => s.transaction_id as string);
  // The function runs as its owner, and the rows still name the person signed in: both sides are theirs, and
  // the guard on payments wrote them down as approving the money out.
  const { data: stored } = await o.c.from('finance_transactions').select('direction, created_by, approved_by').in('id', ids);
  expect(stored!.find((s) => s.direction === 'out')).toMatchObject({ created_by: o.userId, approved_by: o.userId });
  expect(stored!.find((s) => s.direction === 'in')).toMatchObject({ created_by: o.userId, approved_by: null });
  const { data: receipts } = await o.c.from('finance_cash_receipts').select('transaction_id').in('transaction_id', ids);
  const { data: vouchers } = await o.c.from('finance_payment_vouchers').select('transaction_id').in('transaction_id', ids);
  expect([...(receipts ?? []), ...(vouchers ?? [])]).toEqual([]);

  expect(await balances(o)).toMatchObject({ [o.bank]: -250.5, [o.savings]: 250.5, [o.till]: 0 });

  // What a transfer refuses.
  expect((await transfer(o, o.bank, o.bank, 10)).error?.code).toBe('FIN16');
  expect((await transfer(o, o.bank, o.savings, 0)).error?.code).toBe('FIN16');
  expect((await transfer(o, o.bank, crypto.randomUUID(), 10)).error?.code).toBe('FIN16');
});

testWithSupabase('the balances view is read by a member and has no account number; a member cannot record or void a transfer', async () => {
  const o = await ownerWithOrg(`Banking member ${Date.now()}`);
  const numbered = await o.c
    .from('finance_accounts')
    .update({ bank_name: 'Check Bank', account_no: '8001234567' })
    .eq('id', o.savings)
    .select('id');
  expect(numbered.error, numbered.error?.message).toBeNull();

  // A member needs an address to accept an invite sent to it; see finance-write-guards.rls.test.ts.
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'banking-member-pass-123');
  const invite = await o.c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  const member: Org = { ...o, c: m, userId: signUp.userId as string };

  const made = await transfer(o, o.bank, o.savings, 60);
  expect(made.error, made.error?.message).toBeNull();

  // Both read the view. It has the bank's name and no account number, which is asked for by name, by a writer.
  for (const who of [o, member]) {
    const { data, error } = await who.c
      .from('finance_account_balances')
      .select('id, name, bank_name, balance')
      .eq('org_id', o.orgId)
      .eq('id', o.savings);
    expect(error, error?.message).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ id: o.savings, name: 'Savings', bank_name: 'Check Bank' });
    expect(Number(data![0].balance)).toBe(60);
    // 42703: the view has no such column.
    expect((await who.c.from('finance_account_balances').select('account_no').eq('org_id', o.orgId)).error?.code).toBe('42703');
    const numbers = await who.c.rpc('finance_account_numbers', { target_org: o.orgId });
    expect(numbers.error, numbers.error?.message).toBeNull();
    expect(numbers.data).toContainEqual({ account_id: o.savings, account_no: '8001234567' });
  }

  // FIN14 from the function's own rule: moving money between accounts needs an owner or admin.
  expect((await transfer(member, o.bank, o.savings, 5)).error?.code).toBe('FIN14');
  // FIN16 first, as for an owner: what is wrong with the transfer is answered before who is asking.
  expect((await transfer(member, o.bank, o.bank, 5)).error?.code).toBe('FIN16');
  // FIN14 from the sign-off trigger (20261030123000): voiding is an owner's or admin's, through the function or by hand.
  const memberVoid = await m.rpc('finance_void_transfer', { target_org: o.orgId, target_transfer: made.data });
  expect(memberVoid.error?.code).toBe('FIN14');
  const byHand = await m.from('finance_transactions').update({ status: 'void' }).eq('org_id', o.orgId).eq('transfer_id', made.data);
  expect(byHand.error?.code).toBe('FIN14');
  const { data: still } = await o.c.from('finance_transactions').select('status, number').eq('org_id', o.orgId);
  expect(still).toHaveLength(2);
  expect(still!.every((s) => s.status === 'posted' && s.number === 'TR-0001')).toBe(true);

  const voided = await o.c.rpc('finance_void_transfer', { target_org: o.orgId, target_transfer: made.data });
  expect(voided.error, voided.error?.message).toBeNull();
  // The refused tries took no number: the owner's next transfer is the second.
  const next = await transfer(o, o.savings, o.bank, 1);
  expect(next.error, next.error?.message).toBeNull();
  const { data: numbers } = await o.c.from('finance_transactions').select('number').eq('org_id', o.orgId).eq('transfer_id', next.data);
  expect(new Set(numbers!.map((n) => n.number))).toEqual(new Set(['TR-0002']));
  await m.auth.signOut();
});

testWithSupabase('half a transfer cannot be posted or voided through the API; the whole of it can be voided', async () => {
  const o = await ownerWithOrg(`Banking half ${Date.now()}`);
  const made = await transfer(o, o.bank, o.till, 80);
  expect(made.error, made.error?.message).toBeNull();

  const oneSide = await o.c
    .from('finance_transactions')
    .update({ status: 'void' })
    .eq('org_id', o.orgId)
    .eq('transfer_id', made.data)
    .eq('direction', 'in');
  expect(oneSide.error?.code).toBe('FIN16');

  const lone = crypto.randomUUID();
  const drafted = await o.c
    .from('finance_transactions')
    .insert({ org_id: o.orgId, direction: 'in', account_id: o.bank, amount: 999, method: 'bank_transfer', transfer_id: lone });
  expect(drafted.error, drafted.error?.message).toBeNull();
  const posted = await o.c
    .from('finance_transactions')
    .update({ status: 'posted', number: 'TR-9999' })
    .eq('org_id', o.orgId)
    .eq('transfer_id', lone);
  // 42501: a payment's number is a column nobody signed in writes (20261030123000), asked before any trigger.
  expect(posted.error?.code).toBe('42501');
  const unnumbered = await o.c.from('finance_transactions').update({ status: 'posted' }).eq('org_id', o.orgId).eq('transfer_id', lone);
  // 23514: and a payment is not posted without one (the table's own check), so nothing is posted by hand.
  expect(unnumbered.error?.code).toBe('23514');
  const leaves = await o.c.from('finance_transactions').update({ transfer_id: null }).eq('org_id', o.orgId).eq('transfer_id', lone);
  expect(leaves.error?.code).toBe('FIN16');
  expect((await balances(o))[o.bank]).toBe(-80);

  const voided = await o.c.rpc('finance_void_transfer', { target_org: o.orgId, target_transfer: made.data });
  expect(voided.error, voided.error?.message).toBeNull();
  expect(await balances(o)).toMatchObject({ [o.bank]: 0, [o.till]: 0 });
  const again = await o.c.rpc('finance_void_transfer', { target_org: o.orgId, target_transfer: made.data });
  expect(again.error?.code).toBe('FIN09');
});

testWithSupabase('two transfers at the same moment take two numbers', async () => {
  const o = await ownerWithOrg(`Banking numbers ${Date.now()}`);
  const [a, b] = await Promise.all([transfer(o, o.bank, o.savings, 10), transfer(o, o.bank, o.till, 20)]);
  expect(a.error, a.error?.message).toBeNull();
  expect(b.error, b.error?.message).toBeNull();
  const { data } = await o.c.from('finance_transactions').select('number, transfer_id').eq('org_id', o.orgId).not('transfer_id', 'is', null);
  expect(data).toHaveLength(4);
  expect(new Set(data!.map((t) => t.number))).toEqual(new Set(['TR-0001', 'TR-0002']));
});

testWithSupabase('a statement line is matched to one posted payment of its account and amount, and a void unmatches it', async () => {
  const o = await ownerWithOrg(`Banking statement ${Date.now()}`);
  const receipt = await income(o, 120);
  const imported = await o.c.rpc('finance_import_statement', {
    target_org: o.orgId,
    target_account: o.bank,
    file_name: 'statement.csv',
    lines: [
      { line_date: today(), description: 'FPX WALK-IN', money_in: 120 },
      { line_date: today(), description: 'FPX WALK-IN AGAIN', money_in: 120 },
      { line_date: today(), description: 'SERVICE CHARGE', money_out: 25 },
    ],
  });
  expect(imported.error, imported.error?.message).toBeNull();
  const { data: lines } = await o.c
    .from('finance_statement_lines')
    .select('id, position, transaction_id')
    .eq('import_id', imported.data)
    .order('position');
  expect(lines!.map((l) => l.transaction_id)).toEqual([null, null, null]);

  // Two people confirm two lines against the one payment at the same moment: one match stands.
  const tries = await Promise.all(
    [lines![0].id, lines![1].id].map((id) => o.c.from('finance_statement_lines').update({ transaction_id: receipt }).eq('id', id).select('id')),
  );
  expect(tries.filter((t) => !t.error)).toHaveLength(1);
  expect(tries.find((t) => t.error)!.error!.code).toBe('23505');

  const wrong = await o.c.from('finance_statement_lines').update({ transaction_id: receipt }).eq('id', lines![2].id);
  expect(wrong.error?.code).toBe('FIN17');
  const edited = await o.c.from('finance_statement_lines').update({ money_out: 1 }).eq('id', lines![2].id);
  expect(edited.error?.code).toBe('FIN17');

  const { data: row } = await o.c.from('finance_bank_transactions').select('reconciled').eq('transaction_id', receipt).single();
  expect(row!.reconciled).toBe(true);
  const { data: account } = await o.c.from('finance_account_balances').select('unmatched_lines, last_import_at').eq('id', o.bank).single();
  expect(account!.unmatched_lines).toBe(2);
  expect(account!.last_import_at).not.toBeNull();

  const voided = await o.c.from('finance_transactions').update({ status: 'void' }).eq('id', receipt).select('id');
  expect(voided.error, voided.error?.message).toBeNull();
  const { data: after } = await o.c.from('finance_statement_lines').select('transaction_id').eq('import_id', imported.data);
  expect(after!.every((l) => l.transaction_id === null)).toBe(true);

  const tooMany = await o.c.rpc('finance_import_statement', {
    target_org: o.orgId,
    target_account: o.bank,
    file_name: 'big.csv',
    lines: Array.from({ length: 1001 }, () => ({ line_date: today(), description: 'x', money_in: 1 })),
  });
  expect(tooMany.error?.code).toBe('FIN17');
});

testWithSupabase('a match and a void of the same payment at the same moment never leave a line matched to a void payment', async () => {
  const o = await ownerWithOrg(`Banking race ${Date.now()}`);
  const receipt = await income(o, 75);
  const imported = await o.c.rpc('finance_import_statement', {
    target_org: o.orgId, target_account: o.bank, file_name: 'race.csv', lines: [{ line_date: today(), money_in: 75 }],
  });
  expect(imported.error, imported.error?.message).toBeNull();
  const { data: line } = await o.c.from('finance_statement_lines').select('id').eq('import_id', imported.data).single();

  const [matched, voided] = await Promise.all([
    o.c.from('finance_statement_lines').update({ transaction_id: receipt }).eq('id', line!.id).select('id'),
    o.c.from('finance_transactions').update({ status: 'void' }).eq('id', receipt).select('id'),
  ]);
  // The void always goes through. The match either came first and was undone by it, or came second and was refused.
  expect(voided.error, voided.error?.message).toBeNull();
  if (matched.error) expect(matched.error.code).toBe('FIN17');
  const { data: after } = await o.c.from('finance_statement_lines').select('transaction_id').eq('id', line!.id).single();
  expect(after!.transaction_id).toBeNull();
});

testWithSupabase('an amount that is not a number is refused everywhere, and a draft side cannot hold a number', async () => {
  const o = await ownerWithOrg(`Banking nan ${Date.now()}`);
  const nan = await o.c.rpc('finance_record_transfer', {
    target_org: o.orgId,
    transfer: { from_account_id: o.bank, to_account_id: o.savings, amount: 'NaN' },
  });
  expect(nan.error?.code).toBe('FIN16');
  const receipt = await o.c.rpc('finance_save_cash_receipt', {
    target_org: o.orgId,
    receipt: { account_id: o.bank, method: 'fpx', amount: 'NaN', party_name: 'n', category_id: o.sales },
    allocations: [],
  });
  expect(receipt.error?.code).toBe('23514');
  const line = await o.c.rpc('finance_import_statement', {
    target_org: o.orgId, target_account: o.bank, file_name: 'nan.csv', lines: [{ line_date: today(), money_in: 'NaN' }],
  });
  expect(line.error?.code).toBe('FIN17');
  const parked = await o.c.from('finance_transactions').insert({
    org_id: o.orgId, direction: 'out', account_id: o.bank, amount: 1, method: 'bank_transfer',
    transfer_id: crypto.randomUUID(), number: 'TR-0001',
  });
  // 42501: the number column is closed to every signed-in person, so the table's own rule (23514) is never reached.
  expect(parked.error?.code).toBe('42501');
  const first = await transfer(o, o.bank, o.savings, 5);
  expect(first.error, first.error?.message).toBeNull();
});

testWithSupabase('another workspace cannot see or touch accounts, transfers or statement lines', async () => {
  const a = await ownerWithOrg(`Banking mine ${Date.now()}`);
  const b = await ownerWithOrg(`Banking theirs ${Date.now()}`);
  const made = await transfer(a, a.bank, a.savings, 40);
  expect(made.error, made.error?.message).toBeNull();
  const imported = await a.c.rpc('finance_import_statement', {
    target_org: a.orgId, target_account: a.bank, file_name: 's.csv', lines: [{ line_date: today(), money_out: 40 }],
  });
  expect(imported.error, imported.error?.message).toBeNull();

  for (const view of ['finance_account_balances', 'finance_bank_transactions', 'finance_statement_lines', 'finance_statement_imports']) {
    const { data } = await b.c.from(view).select('org_id').eq('org_id', a.orgId);
    expect(data ?? [], view).toEqual([]);
  }
  expect((await b.c.rpc('finance_void_transfer', { target_org: a.orgId, target_transfer: made.data })).error?.code).toBe('FIN11');
  const theirs = await b.c.rpc('finance_import_statement', {
    target_org: a.orgId, target_account: a.bank, file_name: 's.csv', lines: [{ line_date: today(), money_in: 1 }],
  });
  expect(theirs.error?.code).toBe('42501');
  // 42501 from the function's own test of the caller: it runs as its owner and would otherwise find a's accounts.
  const moved = await b.c.rpc('finance_record_transfer', {
    target_org: a.orgId,
    transfer: { from_account_id: a.bank, to_account_id: a.savings, amount: 1 },
  });
  expect(moved.error?.code).toBe('42501');
  expect(await balances(a)).toMatchObject({ [a.bank]: -40, [a.savings]: 40 });
});

testWithSupabase('a demo viewer reads the seeded banking, and can write none of it', async () => {
  const c = liveClient();
  await signInAnon(c);
  const { data: demoId, error } = await joinDemo(c);
  expect(error, error?.message).toBeNull();

  const { data: accounts } = await c.from('finance_account_balances').select('name, kind, balance, last_import_at').eq('org_id', demoId);
  expect(accounts).toHaveLength(3);
  expect(accounts!.reduce((sum, a) => sum + Number(a.balance), 0)).toBeCloseTo(92300, 2);
  expect(accounts!.filter((a) => a.last_import_at !== null).map((a) => a.name)).toEqual(['Main Bank']);

  const { data: rows } = await c.from('finance_bank_transactions').select('kind, status, number, reconciled').eq('org_id', demoId);
  const transfers = (rows ?? []).filter((r) => r.kind === 'transfer');
  expect(transfers).toHaveLength(8);
  expect(transfers.every((r) => r.status === 'posted' && /^TR-\d+$/.test(r.number ?? ''))).toBe(true);
  expect((rows ?? []).some((r) => r.reconciled)).toBe(true);

  const { data: lines } = await c.from('finance_statement_lines').select('description, transaction_id').eq('org_id', demoId);
  expect((lines ?? []).filter((l) => l.description === 'SERVICE CHARGE' || l.description === 'PROFIT PAID').every((l) => l.transaction_id === null)).toBe(true);

  const moved = await c.rpc('finance_record_transfer', {
    target_org: demoId,
    transfer: { from_account_id: crypto.randomUUID(), to_account_id: crypto.randomUUID(), amount: 1 },
  });
  // 42501: a viewer may not write in the workspace, and the function asks that before anything else.
  expect(moved.error?.code).toBe('42501');
  const { data: unmatched } = await c.from('finance_statement_lines').update({ transaction_id: null }).eq('org_id', demoId).select('id');
  expect(unmatched ?? []).toEqual([]);
});
