import { expect, test } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

// SST return marks (finance_sst_returns, 20261124140000) against the hosted
// database. Workspaces are made through tests/helpers/live-workspaces.ts, which
// deletes what it creates.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

async function marks(c: SupabaseClient, orgId: string) {
  const { data, error } = await c
    .from('finance_sst_returns')
    .select('tax_type, period_start, filed_on, marked_by')
    .eq('org_id', orgId);
  expect(error, error?.message).toBeNull();
  return data as { tax_type: string; period_start: string; filed_on: string; marked_by: string }[];
}

testWithSupabase('returns: an owner marks and unmarks; a member reads but cannot insert', async () => {
  const o = liveClient();
  const { error: authErr } = await signInOwner(o);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(o, 'SST Returns A Sdn Bhd');
  expect(error, error?.message).toBeNull();
  const org = orgId as string;
  const ownerId = (await o.auth.getUser()).data.user!.id;

  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'sst-returns-member-pass-123');
  const invite = await o.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();

  // The member cannot mark a return.
  const early = await m
    .from('finance_sst_returns')
    .insert({ org_id: org, tax_type: 'service', period_start: '2026-09-01', filed_on: '2026-10-20' })
    .select('org_id');
  expect(early.error?.code).toBe('42501');
  expect(await marks(o, org)).toEqual([]);

  // The owner marks one; marked_by is the owner whatever was sent.
  const marked = await o
    .from('finance_sst_returns')
    .insert({ org_id: org, tax_type: 'service', period_start: '2026-09-01', filed_on: '2026-10-20', marked_by: signUp.userId })
    .select('org_id');
  expect(marked.error, marked.error?.message).toBeNull();
  const saved = [{ tax_type: 'service', period_start: '2026-09-01', filed_on: '2026-10-20', marked_by: ownerId }];
  expect(await marks(o, org)).toEqual(saved);

  // The member reads it, and cannot update or delete it.
  expect(await marks(m, org)).toEqual(saved);
  const update = await m.from('finance_sst_returns').update({ filed_on: '2026-10-25' }).eq('org_id', org).select('org_id');
  expect(update.data ?? []).toEqual([]);
  const del = await m.from('finance_sst_returns').delete().eq('org_id', org).select('org_id');
  expect(del.data ?? []).toEqual([]);
  expect(await marks(o, org)).toEqual(saved);

  // Bad values are refused.
  for (const row of [
    { tax_type: 'none', period_start: '2026-09-01' },
    { tax_type: 'sales', period_start: '2026-09-02' },
  ]) {
    const res = await o.from('finance_sst_returns').insert({ org_id: org, filed_on: '2026-10-20', ...row }).select('org_id');
    expect(res.error, JSON.stringify(row)).not.toBeNull();
  }

  // The owner unmarks.
  const gone = await o.from('finance_sst_returns').delete().eq('org_id', org).select('org_id');
  expect(gone.error, gone.error?.message).toBeNull();
  expect(gone.data).toHaveLength(1);
  expect(await marks(o, org)).toEqual([]);
});
