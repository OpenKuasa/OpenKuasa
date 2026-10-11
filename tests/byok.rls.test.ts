import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

// Workspace AI keys: only an owner/admin may set or clear one, members learn
// only its hint, and nobody outside the workspace learns anything. Identities
// are anonymous sign-ins; an anonymous user who creates an org is its owner.


function client(): SupabaseClient {
  return liveClient();
}

const SEALED = 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccccccc';

let owner: SupabaseClient;
let stranger: SupabaseClient;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  owner = client();
  const a = await signInAnon(owner);
  expect(a.error, a.error?.message).toBeNull();
  const org = await createOrg(owner, 'BYOK Test Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();

  stranger = client();
  const b = await signInAnon(stranger);
  expect(b.error, b.error?.message).toBeNull();
});

afterAll(async () => {
  await owner?.auth.signOut();
  await stranger?.auth.signOut();
});

testWithSupabase('an owner can set the workspace key and members see only its hint', async () => {
  const none = await owner.rpc('org_ai_key_status');
  expect(none.data).toEqual([]);

  const set = await owner.rpc('set_org_ai_key', {
    p_ciphertext: SEALED,
    p_hint: 'sk-or-…cdef',
  });
  expect(set.error, set.error?.message).toBeNull();

  const status = await owner.rpc('org_ai_key_status');
  expect(status.data).toHaveLength(1);
  expect(status.data[0].key_hint).toBe('sk-or-…cdef');
  expect((await owner.rpc('org_ai_key_ciphertext')).data).toBe(SEALED);
});

testWithSupabase('someone outside the workspace learns nothing and cannot set a key', async () => {
  expect((await stranger.rpc('org_ai_key_status')).data).toEqual([]);
  expect((await stranger.rpc('org_ai_key_ciphertext')).data).toBeNull();
  const set = await stranger.rpc('set_org_ai_key', {
    p_ciphertext: SEALED,
    p_hint: 'sk-or-…xxxx',
  });
  expect(set.error).not.toBeNull();
});

testWithSupabase('the key and usage tables are not reachable directly', async () => {
  expect((await owner.from('org_ai_keys').select('org_id')).error).not.toBeNull();
  expect((await owner.from('ai_free_usage').select('count')).error).not.toBeNull();
});

testWithSupabase('malformed input is refused', async () => {
  const bad = await owner.rpc('set_org_ai_key', { p_ciphertext: 'x', p_hint: 'h' });
  expect(bad.error?.message).toContain('invalid key');
});

testWithSupabase('an owner can remove the key', async () => {
  const cleared = await owner.rpc('clear_org_ai_key');
  expect(cleared.error, cleared.error?.message).toBeNull();
  expect((await owner.rpc('org_ai_key_status')).data).toEqual([]);
});

testWithSupabase('demo-style anonymous sessions get no free questions', async () => {
  expect((await owner.rpc('consume_free_question', { weekly_limit: 3 })).data).toBe(-1);
  expect((await owner.rpc('free_questions_used')).data).toBe(0);
});
