import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

// Cross-tenant isolation is the core security guarantee of the tenancy spine.
// Test identities are signed-up accounts made already confirmed by the helper:
// distinct authenticated users for RLS. Only a signed-up account may create a
// workspace.


function client(): SupabaseClient {
  return liveClient();
}

async function anonUserWithOrg(orgName: string) {
  const c = client();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error: rpcErr } = await createOrg(c, orgName);
  expect(rpcErr, rpcErr?.message).toBeNull();
  return { c, orgId: orgId as string };
}

let a: Awaited<ReturnType<typeof anonUserWithOrg>>;
let b: Awaited<ReturnType<typeof anonUserWithOrg>>;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  a = await anonUserWithOrg('Org A Sdn Bhd');
  b = await anonUserWithOrg('Org B Sdn Bhd');
});

afterAll(async () => {
  await a?.c.auth.signOut();
  await b?.c.auth.signOut();
});

testWithSupabase('a user sees only their own org', async () => {
  const { data, error } = await a.c.from('orgs').select('id,name');
  expect(error, error?.message).toBeNull();
  const ids = (data ?? []).map((o) => o.id);
  expect(ids).toContain(a.orgId);
  expect(ids).not.toContain(b.orgId);
});

testWithSupabase('a user cannot read another org membership', async () => {
  const { data, error } = await a.c
    .from('org_members')
    .select('org_id')
    .eq('org_id', b.orgId);
  expect(error, error?.message).toBeNull();
  expect(data ?? []).toHaveLength(0);
});
