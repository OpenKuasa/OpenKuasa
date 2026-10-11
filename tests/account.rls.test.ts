import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

// Account settings: a profile is private to its owner and their org-mates, and
// company details are writable by owners/admins only. Identities are anonymous
// sign-ins, as in tenancy.rls.test.ts.


function client(): SupabaseClient {
  return liveClient();
}

async function anonUser() {
  const c = client();
  const { data, error } = await signInAnon(c);
  expect(error, error?.message).toBeNull();
  return { c, uid: data.user!.id };
}

let owner: Awaited<ReturnType<typeof anonUser>> & { orgId: string };
let stranger: Awaited<ReturnType<typeof anonUser>>;
let demo: Awaited<ReturnType<typeof anonUser>> & { orgId: string };

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const o = await anonUser();
  const { data: orgId, error } = await createOrg(o.c, 'Account Test Sdn Bhd');
  expect(error, error?.message).toBeNull();
  owner = { ...o, orgId: orgId as string };

  stranger = await anonUser();

  const d = await anonUser();
  const { data: demoId, error: demoErr } = await joinDemo(d.c);
  expect(demoErr, demoErr?.message).toBeNull();
  demo = { ...d, orgId: demoId as string };
});

afterAll(async () => {
  await owner?.c.auth.signOut();
  await stranger?.c.auth.signOut();
  await demo?.c.auth.signOut();
});

testWithSupabase('a profile row is created on sign-up and its owner can edit it', async () => {
  const { data, error } = await owner.c
    .from('profiles')
    .update({ full_name: 'Siti Aminah', job_title: 'Founder' })
    .eq('user_id', owner.uid)
    .select('full_name, job_title, timezone, language');
  expect(error, error?.message).toBeNull();
  expect(data).toEqual([
    {
      full_name: 'Siti Aminah',
      job_title: 'Founder',
      timezone: 'Asia/Kuala_Lumpur',
      language: 'en',
    },
  ]);
});

testWithSupabase('a user cannot rewrite the email mirrored from auth', async () => {
  const { error } = await owner.c
    .from('profiles')
    .update({ email: 'spoof@example.com' })
    .eq('user_id', owner.uid);
  expect(error).not.toBeNull();
});

testWithSupabase('a stranger can neither read nor edit another profile', async () => {
  const { data, error } = await stranger.c
    .from('profiles')
    .select('user_id')
    .eq('user_id', owner.uid);
  expect(error, error?.message).toBeNull();
  expect(data ?? []).toHaveLength(0);

  const { data: updated } = await stranger.c
    .from('profiles')
    .update({ full_name: 'hacked' })
    .eq('user_id', owner.uid)
    .select('user_id');
  expect(updated ?? []).toHaveLength(0);
});

testWithSupabase('an owner can save company details but not the slug', async () => {
  const { data, error } = await owner.c
    .from('orgs')
    .update({ sst_no: 'W10-0000-00000000', city: 'Melaka' })
    .eq('id', owner.orgId)
    .select('sst_no, city');
  expect(error, error?.message).toBeNull();
  expect(data).toEqual([{ sst_no: 'W10-0000-00000000', city: 'Melaka' }]);

  const { error: slugErr } = await owner.c
    .from('orgs')
    .update({ slug: 'taken-over' })
    .eq('id', owner.orgId);
  expect(slugErr).not.toBeNull();
});

testWithSupabase('a demo viewer cannot edit the demo company details', async () => {
  const { data } = await demo.c
    .from('orgs')
    .update({ city: 'hacked' })
    .eq('id', demo.orgId)
    .select('id');
  expect(data ?? []).toHaveLength(0);
});
