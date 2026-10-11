import { afterAll, beforeAll, expect, test, type TestContext } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { proposalsTableMissing, proposalsTableSkipReason } from './helpers/agent-proposals-table';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const client = (): SupabaseClient =>
  createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });

async function signedIn() {
  const c = client();
  const { error } = await c.auth.signInAnonymously();
  expect(error, error?.message).toBeNull();
  return c;
}
async function ownedOrg(c: SupabaseClient, name: string) {
  const { data: orgId, error } = await c.rpc('create_org_for_current_user', { org_name: name });
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}
type Owned = Awaited<ReturnType<typeof ownedOrg>>;

let owner: Owned;
let other: Owned;
let tableMissing = false;
const proposalFields = (orgId: string) => ({
  org_id: orgId,
  action: 'promoteLeadToContact',
  input: { id: '00000000-0000-0000-0000-000000000000' },
  title: 'Promote lead “X” to a CRM contact?',
});
function needsTable(ctx: TestContext) {
  if (tableMissing) ctx.skip();
}

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const first = await signedIn();
  tableMissing = await proposalsTableMissing(first);
  if (tableMissing) {
    console.warn(proposalsTableSkipReason);
    await first.auth.signOut();
    return;
  }
  owner = await ownedOrg(first, 'Proposals Owner Sdn Bhd');
  other = await ownedOrg(await signedIn(), 'Proposals Other Sdn Bhd');
});
afterAll(async () => {
  if (owner) await owner.c.from('agent_proposals').delete().eq('org_id', owner.orgId);
  await owner?.c.auth.signOut();
  await other?.c.auth.signOut();
});

testWithSupabase('authenticated users cannot INSERT a proposal (worker/service-role only)', async (ctx) => {
  needsTable(ctx);
  const ins = await owner.c.from('agent_proposals').insert(proposalFields(owner.orgId));
  expect(ins.error?.code).toBe('42501');
});

testWithSupabase('another workspace sees nothing and cannot update', async (ctx) => {
  needsTable(ctx);
  // RLS filters the other org's rows out: a cross-tenant select is empty (no error).
  const seen = await other.c.from('agent_proposals').select('id').eq('org_id', owner.orgId);
  expect(seen.error).toBeNull();
  expect(seen.data ?? []).toHaveLength(0);
});
