import { afterAll, beforeAll, expect, test } from 'vitest';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);
const client = liveClient;
async function ownedOrg(name: string) {
  const c = client();
  const e1 = await signInOwner(c); expect(e1.error, e1.error?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}
const appt = (orgId: string, over: Record<string, unknown> = {}) => ({
  org_id: orgId,
  contact_name: 'Aisyah Rahim',
  kind: 'Discovery call',
  scheduled_at: new Date().toISOString(),
  via: 'WhatsApp',
  status: 'scheduled',
  ...over,
});
let owner: Awaited<ReturnType<typeof ownedOrg>>; let other: Awaited<ReturnType<typeof ownedOrg>>;
beforeAll(async () => { if (!hasSupabaseEnv) return; owner = await ownedOrg('Appts Writer Sdn Bhd'); other = await ownedOrg('Appts Other Sdn Bhd'); });
afterAll(async () => { await owner?.c.auth.signOut(); await other?.c.auth.signOut(); });

testWithSupabase('owner can insert, update (status), and delete an appointment', async () => {
  const ins = await owner.c.from('appointments').insert(appt(owner.orgId)).select('id,status').single();
  expect(ins.error, ins.error?.message).toBeNull();
  expect(ins.data!.status).toBe('scheduled');
  const id = ins.data!.id;
  try {
    const upd = await owner.c.from('appointments').update({ status: 'completed' }).eq('id', id).select('status').single();
    expect(upd.error, upd.error?.message).toBeNull();
    expect(upd.data!.status).toBe('completed');
    const bad = await owner.c.from('appointments').update({ status: 'bogus' }).eq('id', id);
    expect(bad.error).not.toBeNull();
  } finally {
    const del = await owner.c.from('appointments').delete().eq('id', id).select('id');
    expect(del.error, del.error?.message).toBeNull();
    expect(del.data).toHaveLength(1);
  }
});

testWithSupabase('a different org cannot see or write the owner’s appointments', async () => {
  const ins = await other.c.from('appointments').insert(appt(owner.orgId));
  expect(ins.error?.code).toBe('42501');
  const mine = await owner.c.from('appointments').insert(appt(owner.orgId, { contact_name: 'mine' })).select('id').single();
  expect(mine.error, mine.error?.message).toBeNull();
  const id = mine.data!.id;
  try {
    const sel = await other.c.from('appointments').select('id').eq('id', id);
    expect(sel.error).toBeNull(); expect(sel.data ?? []).toHaveLength(0);
    const upd = await other.c.from('appointments').update({ contact_name: 'hacked' }).eq('id', id).select('id');
    expect(upd.error).toBeNull(); expect(upd.data ?? []).toHaveLength(0);
    const del = await other.c.from('appointments').delete().eq('id', id).select('id');
    expect(del.error).toBeNull(); expect(del.data ?? []).toHaveLength(0);
    const after = await owner.c.from('appointments').select('contact_name').eq('id', id).single();
    expect(after.data!.contact_name).toBe('mine');
  } finally {
    await owner.c.from('appointments').delete().eq('id', id);
  }
});

testWithSupabase('a viewer (demo member) cannot write appointments', async () => {
  const v = client(); await signInAnon(v);
  const { data: demoId } = await joinDemo(v);
  expect(demoId).toBeTruthy();
  const { error } = await v.from('appointments').insert(appt(demoId as string, { contact_name: 'nope' }));
  expect(error?.code).toBe('42501');
  await v.auth.signOut();
});
