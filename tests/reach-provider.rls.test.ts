import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';
import { createSupabaseReachData } from '@/lib/reach/supabase';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

let c: SupabaseClient;
let demoId: string;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  c = liveClient();
  await signInAnon(c);
  const { data } = await joinDemo(c);
  demoId = data as string;
});
afterAll(async () => { await c?.auth.signOut(); });

testWithSupabase('reads the demo org via the ReachData seam', async () => {
  const data = createSupabaseReachData(c, demoId);
  const campaigns = await data.listCampaigns();
  expect(campaigns).toHaveLength(5);
  expect(campaigns[0]).toHaveProperty('spend_cents');
  expect(campaigns[0]).toHaveProperty('cpl_cents');
  expect(await data.listLeads()).toHaveLength(342);
  expect(await data.listAppointments()).toHaveLength(3);
  // Tables that arrive in later slices resolve empty, not error. (Forms have a
  // table as of 20261011120000_reach_forms.sql; tests/reach-forms.rls.test.ts
  // covers them and skips until that migration has been applied.)
  expect(await data.listBroadcasts()).toEqual([]);
  expect(await data.listAutomations()).toEqual([]);
});
