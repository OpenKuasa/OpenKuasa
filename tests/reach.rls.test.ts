import { afterAll, beforeAll, expect } from 'vitest';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient, signInOwner } from './helpers/live-workspaces';
import { test } from 'vitest';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

// The owner is a signed-up account (only those may create a workspace); everyone
// else is an anonymous sign-in.
async function anonUser(signIn: typeof signInAnon | typeof signInOwner = signInAnon) {
  const c = client();
  const { data, error } = await signIn(c);
  expect(error, error?.message).toBeNull();
  return { c, uid: data.user!.id };
}

let owner: Awaited<ReturnType<typeof anonUser>> & { orgId: string };

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const o = await anonUser(signInOwner);
  const { data: orgId, error } = await createOrg(o.c, 'Reach Test Sdn Bhd');
  expect(error, error?.message).toBeNull();
  owner = { ...o, orgId: orgId as string };
});

afterAll(async () => {
  await owner?.c.auth.signOut();
});

testWithSupabase('a fresh org sees no reach rows', async () => {
  for (const t of ['campaigns', 'leads', 'appointments']) {
    const { data, error } = await owner.c.from(t).select('id');
    expect(error, `${t}: ${error?.message}`).toBeNull();
    expect(data ?? []).toHaveLength(0);
  }
});

testWithSupabase('an owner can now insert a campaign (writes enabled in slice 2)', async () => {
  const { data, error } = await owner.c
    .from('campaigns')
    .insert({ org_id: owner.orgId, name: 'slice2 smoke', channel: 'whatsapp' })
    .select('id');
  expect(error, error?.message).toBeNull();
  expect(data ?? []).toHaveLength(1);
  await owner.c.from('campaigns').delete().eq('id', data![0].id);
});

testWithSupabase('the demo org is seeded and a demo viewer can read it', async () => {
  const d = await anonUser();
  const { data: demoId, error } = await joinDemo(d.c);
  expect(error, error?.message).toBeNull();

  const campaigns = await d.c.from('campaigns').select('id').eq('org_id', demoId);
  expect(campaigns.data ?? []).toHaveLength(5);
  const leads = await d.c.from('leads').select('id', { count: 'exact', head: true }).eq('org_id', demoId);
  expect(leads.count).toBe(342);
  const appts = await d.c.from('appointments').select('contact_name,scheduled_at').eq('org_id', demoId);
  expect(appts.data ?? []).toHaveLength(3);
  // The hourly reseed keeps appointments >=4h in the future.
  expect((appts.data ?? []).map((a) => a.contact_name).sort()).toEqual(
    ['Aisyah Rahim', 'Faiz Hakim', 'Nurul Huda'],
  );
  for (const a of appts.data ?? []) {
    expect(new Date(a.scheduled_at) > new Date()).toBe(true);
  }

  // Isolation: the fresh owner (not a demo member) sees none of the demo rows.
  const ownerSees = await owner.c.from('campaigns').select('id');
  expect(ownerSees.data ?? []).toHaveLength(0);

  await d.c.auth.signOut();
});

testWithSupabase('demo leads honor the exact channel and stage marginals', async () => {
  const d = await anonUser();
  const { data: demoId, error } = await joinDemo(d.c);
  expect(error, error?.message).toBeNull();

  const { data, error: leadsError } = await d.c
    .from('leads')
    .select('channel, stage')
    .eq('org_id', demoId)
    .limit(1000);
  expect(leadsError, leadsError?.message).toBeNull();
  expect(data ?? []).toHaveLength(342);

  const tally = (key: 'channel' | 'stage') => {
    const counts: Record<string, number> = {};
    for (const row of data ?? []) counts[row[key]] = (counts[row[key]] ?? 0) + 1;
    return counts;
  };
  expect(tally('channel')).toEqual({ whatsapp: 142, facebook: 96, instagram: 68, tiktok: 36 });
  expect(tally('stage')).toEqual({ lead: 78, contacted: 106, qualified: 62, booked: 48, won: 48 });

  await d.c.auth.signOut();
});
