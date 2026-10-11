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
beforeAll(async () => { if (!hasSupabaseEnv) return; owner = await ownedOrg('Leads Writer Sdn Bhd'); other = await ownedOrg('Leads Other Sdn Bhd'); });
afterAll(async () => { await owner?.c.auth.signOut(); await other?.c.auth.signOut(); });

testWithSupabase('owner can insert, update (stage), and delete a lead', async () => {
  const ins = await owner.c.from('leads').insert({ org_id: owner.orgId, name: 'Aisyah Rahim', channel: 'whatsapp', stage: 'lead', source: 'Test' }).select('id,stage').single();
  expect(ins.error, ins.error?.message).toBeNull();
  const id = ins.data!.id;
  const upd = await owner.c.from('leads').update({ stage: 'qualified' }).eq('id', id).select('stage').single();
  expect(upd.error, upd.error?.message).toBeNull();
  expect(upd.data!.stage).toBe('qualified');
  const del = await owner.c.from('leads').delete().eq('id', id).select('id');
  expect(del.error, del.error?.message).toBeNull();
  expect(del.data).toHaveLength(1);
});

testWithSupabase('a different org cannot write the owner’s leads', async () => {
  const ins = await other.c.from('leads').insert({ org_id: owner.orgId, name: 'x', channel: 'facebook', stage: 'lead' });
  expect(ins.error?.code).toBe('42501');
  const mine = await owner.c.from('leads').insert({ org_id: owner.orgId, name: 'mine', channel: 'facebook', stage: 'lead' }).select('id').single();
  const upd = await other.c.from('leads').update({ name: 'hacked' }).eq('id', mine.data!.id).select('id');
  expect(upd.error).toBeNull(); expect(upd.data ?? []).toHaveLength(0);
  const after = await owner.c.from('leads').select('name').eq('id', mine.data!.id).single();
  expect(after.data!.name).toBe('mine');
  await owner.c.from('leads').delete().eq('id', mine.data!.id);
});

testWithSupabase('a viewer (demo member) cannot write leads', async () => {
  const v = client(); await signInAnon(v);
  const { data: demoId } = await joinDemo(v);
  expect(demoId).toBeTruthy();
  const { error } = await v.from('leads').insert({ org_id: demoId, name: 'nope', channel: 'whatsapp', stage: 'lead' });
  expect(error?.code).toBe('42501');
  await v.auth.signOut();
});
