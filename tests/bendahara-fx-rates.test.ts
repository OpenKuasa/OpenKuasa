import { expect, test } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { listLatestFxRates } from '@/lib/finance/fx-rates';

// The exchange-rate tables against the hosted database. Run by the controller
// only, after 20261119150000_bendahara_fx_rates is applied. Nothing here
// writes a rate: the table is shared by every workspace and service_role
// cannot delete, so a test row could never be taken out again. What each
// role may write is proved by supabase/tests/bendahara_fx_rates_check.sql,
// inside a transaction that is rolled back. This file adds what only the API
// shows: who can read, and that every write from the API is refused.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const XTS = {
  currency: 'XTS',
  rate_date: '2026-10-15',
  session: '1700',
  unit: 1,
  middle_rate: 1,
  rate: 1,
};

testWithSupabase('a signed-in person reads the rates, and cannot write, change or delete one', async () => {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { error } = await createOrg(c, `FX rates ${Date.now()}`);
  expect(error, error?.message).toBeNull();

  // Through the screen's own read. Empty until the route has run once; either way it is readable.
  const rates = await listLatestFxRates(c);
  expect(Array.isArray(rates)).toBe(true);
  for (const r of rates) {
    expect(r.currency).toMatch(/^[A-Z]{3}$/);
    expect(r.rate).toBeGreaterThan(0);
  }

  const inserted = await c.from('finance_fx_rates').insert(XTS).select('currency');
  expect(inserted.error?.code).toBe('42501');
  const updated = await c.from('finance_fx_rates').update({ rate: 9 }).eq('currency', 'USD').select('currency');
  expect(updated.error?.code).toBe('42501');
  const deleted = await c.from('finance_fx_rates').delete().eq('currency', 'USD').select('currency');
  expect(deleted.error?.code).toBe('42501');
  const state = await c.from('finance_fx_fetch_state').select('id');
  expect(state.error?.code).toBe('42501');
});

testWithSupabase('nobody signed in reads anything', async () => {
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  expect((await anon.from('finance_fx_rates').select('currency').limit(1)).error?.code).toBe('42501');
  expect((await anon.from('finance_fx_latest_rates').select('currency').limit(1)).error?.code).toBe('42501');
});

testWithSupabase('service_role reads the rates and the state, and cannot change or delete a rate', async () => {
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  expect((await svc.from('finance_fx_latest_rates').select('currency, rate_date')).error).toBeNull();
  expect((await svc.from('finance_fx_fetch_state').select('last_attempt_at, backfill')).error).toBeNull();
  // A filter that matches nothing: if the grant were there, nothing would change either way.
  const updated = await svc.from('finance_fx_rates').update({ rate: 9 }).eq('currency', 'XTS').select('currency');
  expect(updated.error?.code).toBe('42501');
  const deleted = await svc.from('finance_fx_rates').delete().eq('currency', 'XTS').select('currency');
  expect(deleted.error?.code).toBe('42501');
});
