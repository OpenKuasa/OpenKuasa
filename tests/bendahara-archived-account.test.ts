import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { createBankAccount, setBankAccountActive } from '@/lib/finance/bank-accounts';
import { listBankAccounts } from '@/lib/finance/banking';
import { postCashReceipt, saveCashReceipt, voidCashReceipt } from '@/lib/finance/cash-receipts';
import { ACCOUNT_ARCHIVED } from '@/lib/finance/result';

// Money on an archived account against the hosted database, through the app's own data layer with a real
// client. Run by the controller only, after 20261116110000_bendahara_archived_account_rule is applied: until
// then the database takes every write below and most of this file fails. What each role is answered, every
// status and the order the triggers answer in are proved by supabase/tests/bendahara_archived_account_check.sql.
// This file adds what only the API shows: that FIN37 arrives through PostgREST as the sentence the screens show,
// from a function that runs as the caller and from one that runs as its owner, and that nothing else changed
// for a draft that stays where it is. The helper deletes the workspace it makes.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Ctx = { client: SupabaseClient; orgId: string };
const REFUSED = { ok: false, error: ACCOUNT_ARCHIVED };

testWithSupabase('a draft on an account that is archived afterwards is edited but not posted; restored, it is posted and voided', async () => {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, `Archived account ${Date.now()}`);
  expect(error, error?.message).toBeNull();
  const owner: Ctx = { client: c, orgId: orgId as string };
  const { data: categories } = await c.from('finance_categories').select('id, kind').eq('org_id', orgId).eq('kind', 'income').limit(1);
  const income = categories![0].id as string;

  const old = await createBankAccount(owner, { name: 'Old account', kind: 'bank', bank_name: null, account_no: null });
  expect(old).toMatchObject({ ok: true });
  if (!old.ok) return;
  const receipt = { kind: 'income' as const, account_id: old.data.id, txn_date: '2026-10-05', method: 'cash' as const, category_id: income, amount: 50, party_name: 'Walk-in' };
  const draft = await saveCashReceipt(owner, receipt);
  expect(draft).toMatchObject({ ok: true });
  if (!draft.ok) return;

  // A draft promises nothing, so the account is archived with it on it.
  expect(await setBankAccountActive(owner, { id: old.data.id, active: false })).toMatchObject({ ok: true, data: { active: false } });

  // The draft is still edited where it is (a function that runs as the caller) ...
  expect(await saveCashReceipt(owner, { ...receipt, id: draft.data.id, amount: 60 })).toMatchObject({ ok: true });
  // ... but not posted there (a function that runs as its owner), and no new one is started there.
  expect(await postCashReceipt(owner, { id: draft.data.id })).toEqual(REFUSED);
  expect(await saveCashReceipt(owner, receipt)).toEqual(REFUSED);
  const before = (await listBankAccounts(owner)).find((a) => a.id === old.data.id);
  expect(before).toMatchObject({ active: false, balance: 0 });

  // Restored, the account takes the money, and the receipt is voided afterwards as any other.
  expect(await setBankAccountActive(owner, { id: old.data.id, active: true })).toMatchObject({ ok: true, data: { active: true } });
  const posted = await postCashReceipt(owner, { id: draft.data.id });
  expect(posted).toMatchObject({ ok: true });
  expect((await listBankAccounts(owner)).find((a) => a.id === old.data.id)).toMatchObject({ balance: 60 });

  // Archived again with a posted receipt on it: voiding still works there.
  expect(await setBankAccountActive(owner, { id: old.data.id, active: false })).toMatchObject({ ok: true });
  expect(await voidCashReceipt(owner, { id: draft.data.id })).toMatchObject({ ok: true });
  expect((await listBankAccounts(owner)).find((a) => a.id === old.data.id)).toMatchObject({ active: false, balance: 0 });
});
