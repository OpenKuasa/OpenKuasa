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
beforeAll(async () => { if (!hasSupabaseEnv) return; owner = await ownedOrg('Schedule Owner Sdn Bhd'); other = await ownedOrg('Schedule Other Sdn Bhd'); });
afterAll(async () => { await owner?.c.auth.signOut(); await other?.c.auth.signOut(); });

const newSchedule = (orgId: string) => ({
  org_id: orgId,
  agent_key: 'weekly-studio',
  interval_seconds: 3600,
  next_run_at: new Date(Date.now() + 3600_000).toISOString(),
});

testWithSupabase('owner can insert, update and read their agent_schedules row', async () => {
  let id: string | undefined;
  try {
    const ins = await owner.c.from('agent_schedules').insert(newSchedule(owner.orgId)).select('id').single();
    expect(ins.error, ins.error?.message).toBeNull();
    id = ins.data!.id;
    const up = await owner.c.from('agent_schedules').update({ interval_seconds: 7200 }).eq('id', id).select('id,interval_seconds').single();
    expect(up.error, up.error?.message).toBeNull();
    expect(up.data!.interval_seconds).toBe(7200);
    const read = await owner.c.from('agent_schedules').select('interval_seconds,status,runs_used,spent_cents').eq('id', id).single();
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toEqual({ interval_seconds: 7200, status: 'active', runs_used: 0, spent_cents: 0 });
  } finally {
    if (id) await owner.c.from('agent_schedules').delete().eq('id', id);
  }
});

testWithSupabase('a different org cannot see or update the owner’s agent_schedules row', async () => {
  let id: string | undefined;
  try {
    const ins = await owner.c.from('agent_schedules').insert(newSchedule(owner.orgId)).select('id').single();
    expect(ins.error, ins.error?.message).toBeNull();
    id = ins.data!.id;
    const sel = await other.c.from('agent_schedules').select('id').eq('id', id);
    expect(sel.error).toBeNull(); expect(sel.data ?? []).toHaveLength(0);
    const upd = await other.c.from('agent_schedules').update({ interval_seconds: 600 }).eq('id', id).select('id');
    expect(upd.error).toBeNull(); expect(upd.data ?? []).toHaveLength(0);
    const after = await owner.c.from('agent_schedules').select('interval_seconds').eq('id', id).single();
    expect(after.data!.interval_seconds).toBe(3600);
  } finally {
    if (id) await owner.c.from('agent_schedules').delete().eq('id', id);
  }
});

testWithSupabase('a viewer (demo member) cannot insert agent_schedules', async () => {
  const v = client(); await signInAnon(v);
  try {
    const { data: demoId } = await joinDemo(v);
    expect(demoId).toBeTruthy();
    const { error } = await v.from('agent_schedules').insert(newSchedule(demoId as string));
    expect(error?.code).toBe('42501');
  } finally {
    await v.auth.signOut();
  }
});

testWithSupabase('an authenticated session cannot update spent_cents or runs_used (no column grant)', async () => {
  let id: string | undefined;
  try {
    const ins = await owner.c.from('agent_schedules').insert(newSchedule(owner.orgId)).select('id').single();
    expect(ins.error, ins.error?.message).toBeNull();
    id = ins.data!.id;
    const spent = await owner.c.from('agent_schedules').update({ spent_cents: 1 }).eq('id', id);
    expect(spent.error?.code).toBe('42501');
    const runs = await owner.c.from('agent_schedules').update({ runs_used: 1 }).eq('id', id);
    expect(runs.error?.code).toBe('42501');
    const after = await owner.c.from('agent_schedules').select('spent_cents,runs_used').eq('id', id).single();
    expect(after.data).toEqual({ spent_cents: 0, runs_used: 0 });
  } finally {
    if (id) await owner.c.from('agent_schedules').delete().eq('id', id);
  }
});

testWithSupabase('an authenticated session cannot seed spent_cents or runs_used on insert (no column grant)', async () => {
  const spent = await owner.c.from('agent_schedules').insert({ ...newSchedule(owner.orgId), spent_cents: -1 });
  expect(spent.error?.code).toBe('42501');
  const runs = await owner.c.from('agent_schedules').insert({ ...newSchedule(owner.orgId), runs_used: -1 });
  expect(runs.error?.code).toBe('42501');
});
