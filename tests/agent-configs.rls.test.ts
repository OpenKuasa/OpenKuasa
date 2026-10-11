import { afterAll, beforeAll, expect, test } from 'vitest';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);
const client = liveClient;
async function ownedOrg(name: string) {
  const c = client();
  const e1 = await signInAnon(c); expect(e1.error, e1.error?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}
let owner: Awaited<ReturnType<typeof ownedOrg>>; let other: Awaited<ReturnType<typeof ownedOrg>>;
beforeAll(async () => { if (!hasSupabaseEnv) return; owner = await ownedOrg('Agent Owner Sdn Bhd'); other = await ownedOrg('Agent Other Sdn Bhd'); });
afterAll(async () => { await owner?.c.auth.signOut(); await other?.c.auth.signOut(); });

testWithSupabase('owner can insert, update and read their agent_configs row', async () => {
  let id: string | undefined;
  try {
    // Column-level UPDATE grant means ON CONFLICT upserts are denied by design; insert then update granted columns.
    const ins = await owner.c.from('agent_configs').insert({ org_id: owner.orgId, agent_key: 'weekly-studio' }).select('id').single();
    expect(ins.error, ins.error?.message).toBeNull();
    expect(ins.status).toBe(201);
    id = ins.data!.id;
    const up = await owner.c.from('agent_configs').update({ enabled: true, cadence: 'weekly' }).eq('id', id).select('id,enabled,cadence').single();
    expect(up.error, up.error?.message).toBeNull();
    expect(up.data!.enabled).toBe(true);
    const read = await owner.c.from('agent_configs').select('enabled,cadence').eq('id', id).single();
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toEqual({ enabled: true, cadence: 'weekly' });
  } finally {
    if (id) await owner.c.from('agent_configs').delete().eq('id', id);
  }
});

testWithSupabase('a different org cannot see or update the owner’s agent_configs row', async () => {
  let id: string | undefined;
  try {
    const ins = await owner.c.from('agent_configs').insert({ org_id: owner.orgId, agent_key: 'weekly-studio' }).select('id').single();
    expect(ins.error, ins.error?.message).toBeNull();
    id = ins.data!.id;
    const sel = await other.c.from('agent_configs').select('id').eq('id', id);
    expect(sel.error).toBeNull(); expect(sel.data ?? []).toHaveLength(0);
    const upd = await other.c.from('agent_configs').update({ enabled: true }).eq('id', id).select('id');
    expect(upd.error).toBeNull(); expect(upd.data ?? []).toHaveLength(0);
    const after = await owner.c.from('agent_configs').select('enabled').eq('id', id).single();
    expect(after.data!.enabled).toBe(false);
  } finally {
    if (id) await owner.c.from('agent_configs').delete().eq('id', id);
  }
});

testWithSupabase('a viewer (demo member) cannot write agent_configs', async () => {
  const v = client(); await signInAnon(v);
  try {
    const { data: demoId } = await joinDemo(v);
    expect(demoId).toBeTruthy();
    const { error } = await v.from('agent_configs').insert({ org_id: demoId, agent_key: 'weekly-studio' });
    expect(error?.code).toBe('42501');
  } finally {
    await v.auth.signOut();
  }
});

testWithSupabase('an authenticated user cannot insert into agent_runs (no grant)', async () => {
  const { error } = await owner.c.from('agent_runs').insert({ org_id: owner.orgId, agent_key: 'weekly-studio' });
  expect(error).not.toBeNull();
  expect(error?.code).toBe('42501');
});
