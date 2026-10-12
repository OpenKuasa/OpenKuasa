import { afterAll, beforeAll, expect, test } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, signInAnon, liveClient, signInOwner } from './helpers/live-workspaces';

// Workspace AI keys: the sealed key is stored and read by the server only (the
// service role). A signed-in session can neither read the sealed value nor
// store one; members learn only the hint, an owner/admin may clear the key,
// and nobody outside the workspace learns anything. The owner is a signed-up
// account (only those may create a workspace); the stranger is an anonymous
// sign-in, as a demo guest is.
//
// The store/re-seal cases need SUPABASE_SERVICE_ROLE_KEY and are skipped
// without it. All of this needs 20261030101500_ai_key_workspace_binding.sql.

const hasService = hasSupabaseEnv && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const testWithSupabase = hasSupabaseEnv ? test : test.skip;
const testWithService = hasService ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);
else if (!hasService) {
  console.warn('SUPABASE_SERVICE_ROLE_KEY not set: skipping the server-side key storage checks.');
}

function client(): SupabaseClient {
  return liveClient();
}

// Shaped like sealed keys (12-byte iv, 16-byte tag); nothing ever opens them.
const SEALED_V2 = `v2.${'a'.repeat(16)}.${'b'.repeat(22)}.${'c'.repeat(40)}`;
const RESEALED_V2 = `v2.${'d'.repeat(16)}.${'e'.repeat(22)}.${'f'.repeat(40)}`;
const SEALED_V1 = `v1.${'a'.repeat(16)}.${'b'.repeat(22)}.${'c'.repeat(40)}`;
const HINT = 'sk-or-…cdef';

let owner: SupabaseClient;
let stranger: SupabaseClient;
let service: SupabaseClient;
let ownerId: string;
let strangerId: string;
let orgId: string;

const store = (over: Record<string, unknown> = {}) =>
  service.rpc('set_org_ai_key', {
    p_org: orgId,
    p_actor: ownerId,
    p_ciphertext: SEALED_V2,
    p_hint: HINT,
    ...over,
  });

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  owner = client();
  const a = await signInOwner(owner);
  expect(a.error, a.error?.message).toBeNull();
  ownerId = a.data.user!.id;
  const org = await createOrg(owner, 'BYOK Test Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  orgId = org.data as string;

  stranger = client();
  const b = await signInAnon(stranger);
  expect(b.error, b.error?.message).toBeNull();
  strangerId = b.data.user!.id;

  if (hasService) {
    service = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
});

afterAll(async () => {
  await owner?.auth.signOut();
  await stranger?.auth.signOut();
});

testWithSupabase('a signed-in session cannot store a sealed key, in either signature', async () => {
  for (const who of [owner, stranger]) {
    const legacy = await who.rpc('set_org_ai_key', { p_ciphertext: SEALED_V2, p_hint: HINT });
    expect(legacy.error).not.toBeNull();
    const direct = await who.rpc('set_org_ai_key', {
      p_org: orgId,
      p_actor: ownerId,
      p_ciphertext: SEALED_V2,
      p_hint: HINT,
    });
    expect(direct.error).not.toBeNull();
  }
  expect((await owner.rpc('org_ai_key_status')).data).toEqual([]);
});

testWithService('the server stores a key for an owner and members see only its hint', async () => {
  const set = await store();
  expect(set.error, set.error?.message).toBeNull();

  const status = await owner.rpc('org_ai_key_status');
  expect(status.data).toHaveLength(1);
  expect(status.data[0].key_hint).toBe(HINT);
});

testWithSupabase('the sealed key is not readable by any signed-in session', async () => {
  for (const who of [owner, stranger]) {
    const read = await who.rpc('org_ai_key_ciphertext');
    expect(read.error).not.toBeNull();
    expect(read.data).toBeNull();
  }
});

testWithSupabase('someone outside the workspace learns nothing', async () => {
  expect((await stranger.rpc('org_ai_key_status')).data).toEqual([]);
});

testWithSupabase('the key and usage tables are not reachable directly', async () => {
  expect((await owner.from('org_ai_keys').select('org_id')).error).not.toBeNull();
  expect((await owner.from('ai_free_usage').select('count')).error).not.toBeNull();
});

testWithService('the server cannot store a key on behalf of someone who is not an owner or admin', async () => {
  const set = await store({ p_actor: strangerId });
  expect(set.error?.message).toContain('not allowed');
});

testWithService('only a bound-format key with a well-formed hint is stored', async () => {
  for (const over of [
    { p_ciphertext: 'x' },
    { p_ciphertext: SEALED_V1 },
    { p_hint: 'h' },
    { p_hint: 'sk-or-v1-0123456789abcdef' },
    { p_hint: 'sk-or-…cde' },
  ]) {
    expect((await store(over)).error?.message, JSON.stringify(over)).toContain('invalid key');
  }
});

testWithService('the server may replace the sealed value but not with the earlier format', async () => {
  const reseal = await service
    .from('org_ai_keys')
    .update({ ciphertext: RESEALED_V2 })
    .eq('org_id', orgId)
    .eq('ciphertext', SEALED_V2);
  expect(reseal.error, reseal.error?.message).toBeNull();
  const stored = await service.from('org_ai_keys').select('ciphertext').eq('org_id', orgId).single();
  expect(stored.data?.ciphertext).toBe(RESEALED_V2);

  const downgrade = await service
    .from('org_ai_keys')
    .update({ ciphertext: SEALED_V1 })
    .eq('org_id', orgId);
  expect(downgrade.error).not.toBeNull();
  // Only the sealed value is writable by the server outside the store function.
  const hint = await service.from('org_ai_keys').update({ key_hint: 'sk-or-…zzzz' }).eq('org_id', orgId);
  expect(hint.error).not.toBeNull();
});

testWithSupabase('an owner can remove the key', async () => {
  const cleared = await owner.rpc('clear_org_ai_key');
  expect(cleared.error, cleared.error?.message).toBeNull();
  expect((await owner.rpc('org_ai_key_status')).data).toEqual([]);
});

testWithSupabase('demo-style anonymous sessions get no free questions', async () => {
  expect((await stranger.rpc('consume_free_question', { weekly_limit: 3 })).data).toBe(-1);
  expect((await stranger.rpc('free_questions_used')).data).toBe(0);
});
