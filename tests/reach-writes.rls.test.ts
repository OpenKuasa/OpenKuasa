import { afterAll, beforeAll, expect, test } from 'vitest';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

async function ownedOrg(name: string) {
  const c = client();
  const { error: e1 } = await signInAnon(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

let owner: Awaited<ReturnType<typeof ownedOrg>>;
let other: Awaited<ReturnType<typeof ownedOrg>>;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  owner = await ownedOrg('Ads Writer Sdn Bhd');
  other = await ownedOrg('Ads Other Sdn Bhd');
});
afterAll(async () => {
  await owner?.c.auth.signOut();
  await other?.c.auth.signOut();
});

testWithSupabase('owner can insert, update and delete a campaign; CPL is generated', async () => {
  const ins = await owner.c
    .from('campaigns')
    .insert({ org_id: owner.orgId, name: 'Promo', channel: 'facebook', status: 'active', spend_cents: 10000, leads_count: 8 })
    .select('id, cpl_cents')
    .single();
  expect(ins.error, ins.error?.message).toBeNull();
  expect(ins.data!.cpl_cents).toBe(1250); // 10000 / 8

  const id = ins.data!.id;
  const upd = await owner.c.from('campaigns').update({ leads_count: 0 }).eq('id', id).select('cpl_cents').single();
  expect(upd.error, upd.error?.message).toBeNull();
  expect(upd.data!.cpl_cents).toBeNull(); // zero leads → null CPL

  const del = await owner.c.from('campaigns').delete().eq('id', id).select('id');
  expect(del.error, del.error?.message).toBeNull();
  expect(del.data).toHaveLength(1);
});

testWithSupabase('cpl_cents cannot be written directly (generated column)', async () => {
  const { error } = await owner.c
    .from('campaigns')
    .insert({ org_id: owner.orgId, name: 'x', channel: 'whatsapp', spend_cents: 1, leads_count: 1, cpl_cents: 999999 });
  expect(error, 'writing a generated column must be rejected').not.toBeNull();
});

testWithSupabase('a different org cannot write to the owner’s campaigns', async () => {
  // insert into owner's org → RLS check fails
  const ins = await other.c
    .from('campaigns')
    .insert({ org_id: owner.orgId, name: 'intrusion', channel: 'tiktok' });
  expect(ins.error?.code).toBe('42501');
  // seed a row in owner, then other tries to update/delete it → zero rows, no error
  const mine = await owner.c
    .from('campaigns')
    .insert({ org_id: owner.orgId, name: 'mine', channel: 'facebook' })
    .select('id')
    .single();
  expect(mine.error, mine.error?.message).toBeNull();
  expect(mine.data?.id).toBeTruthy();
  const upd = await other.c.from('campaigns').update({ name: 'hacked' }).eq('id', mine.data!.id).select('id');
  expect(upd.error).toBeNull();
  expect(upd.data ?? []).toHaveLength(0);
  const del = await other.c.from('campaigns').delete().eq('id', mine.data!.id).select('id');
  expect(del.error).toBeNull();
  expect(del.data ?? []).toHaveLength(0);
  const still = await owner.c.from('campaigns').select('name').eq('id', mine.data!.id).single();
  expect(still.error, still.error?.message).toBeNull();
  expect(still.data!.name).toBe('mine'); // the intrusion changed nothing
  await owner.c.from('campaigns').delete().eq('id', mine.data!.id);
});

testWithSupabase('a viewer (demo member) cannot write', async () => {
  const v = client();
  await signInAnon(v);
  const { data: demoId, error: joinError } = await joinDemo(v);
  expect(joinError, joinError?.message).toBeNull();
  expect(demoId).toBeTruthy();
  const { error } = await v.from('campaigns').insert({ org_id: demoId, name: 'nope', channel: 'whatsapp' });
  expect(error?.code).toBe('42501'); // is_org_writer false for a viewer
  await v.auth.signOut();
});

testWithSupabase('deleting a campaign unlinks its creatives (on delete set null)', async () => {
  const camp = await owner.c
    .from('campaigns')
    .insert({ org_id: owner.orgId, name: 'LinkedCamp', channel: 'facebook' })
    .select('id')
    .single();
  expect(camp.error, camp.error?.message).toBeNull();
  const cr = await owner.c
    .from('creatives')
    .insert({ org_id: owner.orgId, campaign_id: camp.data!.id, name: 'linked', type: 'image', channel: 'facebook' })
    .select('id')
    .single();
  expect(cr.error, cr.error?.message).toBeNull();
  const del = await owner.c.from('campaigns').delete().eq('id', camp.data!.id).select('id');
  expect(del.error, del.error?.message).toBeNull();
  expect(del.data).toHaveLength(1);
  const after = await owner.c.from('creatives').select('campaign_id').eq('id', cr.data!.id).single();
  expect(after.error, after.error?.message).toBeNull();
  expect(after.data!.campaign_id).toBeNull(); // survived, unlinked
  await owner.c.from('creatives').delete().eq('id', cr.data!.id);
});

testWithSupabase('a different org cannot create a creative in the owner org', async () => {
  const { error } = await other.c
    .from('creatives')
    .insert({ org_id: owner.orgId, name: 'x', type: 'copy', channel: 'whatsapp' });
  expect(error?.code).toBe('42501');
});

testWithSupabase('owner can save ad settings twice (insert then update); a different org cannot', async () => {
  const cols = 'currency,daily_cap_cents';
  const first = await owner.c
    .from('ad_settings')
    .insert({ org_id: owner.orgId, currency: 'MYR', daily_cap_cents: 5000 })
    .select(cols)
    .single();
  expect(first.error, first.error?.message).toBeNull();
  expect(first.data!.currency).toBe('MYR');
  const second = await owner.c
    .from('ad_settings')
    .update({ currency: 'SGD', daily_cap_cents: 9000, updated_at: new Date().toISOString() })
    .eq('org_id', owner.orgId)
    .select(cols)
    .maybeSingle();
  expect(second.error, second.error?.message).toBeNull();
  expect(second.data).toEqual({ currency: 'SGD', daily_cap_cents: 9000 });

  const intrusion = await other.c.from('ad_settings').insert({ org_id: owner.orgId, currency: 'USD' });
  expect(intrusion.error?.code).toBe('42501');
  const hijack = await other.c
    .from('ad_settings')
    .update({ currency: 'USD' })
    .eq('org_id', owner.orgId)
    .select('currency');
  expect(hijack.data ?? []).toHaveLength(0);
  // No delete grant on ad_settings; the throwaway org's row is left in place.
});
