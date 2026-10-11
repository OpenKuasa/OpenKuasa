import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';
const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

testWithSupabase('demo org has creatives and an ad_settings row; campaign CPL is generated', async () => {
  const c: SupabaseClient = liveClient();
  await signInAnon(c);
  const { data: demoId } = await joinDemo(c);
  const creatives = await c.from('creatives').select('id, campaign_id').eq('org_id', demoId);
  expect((creatives.data ?? []).length).toBeGreaterThanOrEqual(8);
  const settings = await c.from('ad_settings').select('currency').eq('org_id', demoId).single();
  expect(settings.data!.currency).toBe('MYR');
  const camp = await c.from('campaigns').select('leads_count, spend_cents, cpl_cents').eq('org_id', demoId).eq('name', 'Ramadan–Raya Promo').single();
  expect(camp.data!.cpl_cents).toBe(Math.floor(camp.data!.spend_cents / camp.data!.leads_count));
  await c.auth.signOut();
});
