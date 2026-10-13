import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hashRecoveryCode } from '@/lib/auth/mfa';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

// Recovery codes live behind SECURITY DEFINER functions only. A session that
// has not passed a second factor (every anonymous test identity) must not be
// able to mint codes, read them, or guess them without being locked out.


let c: SupabaseClient;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  c = liveClient();
  const { error } = await signInAnon(c);
  expect(error, error?.message).toBeNull();
});

afterAll(async () => {
  await c?.auth.signOut();
});

testWithSupabase('codes cannot be minted without passing a second factor', async () => {
  const { error } = await c.rpc('replace_recovery_codes', {
    p_hashes: [hashRecoveryCode('K7QMX-2HVBD')],
  });
  expect(error?.message).toContain('second factor required');

  const { data: remaining } = await c.rpc('recovery_codes_remaining');
  expect(remaining).toBe(0);
});

testWithSupabase('the code tables are not readable or writable by clients', async () => {
  const read = await c.from('mfa_recovery_codes').select('id');
  expect(read.error).not.toBeNull();
  const write = await c
    .from('mfa_recovery_codes')
    .insert({ code_hash: hashRecoveryCode('K7QMX-2HVBD') });
  expect(write.error).not.toBeNull();
  const attempts = await c.from('mfa_recovery_attempts').select('id');
  expect(attempts.error).not.toBeNull();
});

testWithSupabase('wrong codes are refused and then locked out', async () => {
  for (let i = 0; i < 5; i++) {
    const { data, error } = await c.rpc('redeem_recovery_code', {
      p_hash: hashRecoveryCode(`AAAAA-AAAA${'BCDEF'[i]}`),
    });
    expect(error, error?.message).toBeNull();
    expect(data).toBe(false);
  }
  const { error: locked } = await c.rpc('redeem_recovery_code', {
    p_hash: hashRecoveryCode('AAAAA-AAAAG'),
  });
  expect(locked?.message).toContain('too many attempts');
});

testWithSupabase('clearing codes is harmless when no factor is enrolled', async () => {
  const { error } = await c.rpc('clear_recovery_codes');
  expect(error, error?.message).toBeNull();
});
