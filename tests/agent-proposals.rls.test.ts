import { afterAll, beforeAll, expect, test, type TestContext } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { proposalsTableMissing, proposalsTableSkipReason } from './helpers/agent-proposals-table';
import { createOrg, signInAnon, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

// A service-role client (bypasses RLS) to SEED a pending proposal — authenticated users
// cannot INSERT. Only available when the key is set; the update asserts skip without it.
const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const service: SupabaseClient | null =
  serviceUrl && serviceKey
    ? createClient(serviceUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
const testWithSeed = hasSupabaseEnv && service ? test : test.skip;
if (hasSupabaseEnv && !service) {
  console.warn('SUPABASE_SERVICE_ROLE_KEY not set — skipping the proposal update-RLS asserts.');
}

async function ownedCtx(name: string) {
  const c = liveClient();
  const { error: e1 } = await signInOwner(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}
type Owned = Awaited<ReturnType<typeof ownedCtx>>;

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

/** Seed a fresh pending proposal for an org via the service role; returns its id. */
async function seedPending(orgId: string): Promise<string> {
  const { data, error } = await service!
    .from('agent_proposals')
    .insert(proposalFields(orgId))
    .select('id')
    .single();
  expect(error, error?.message).toBeNull();
  return (data as { id: string }).id;
}

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const probe = liveClient();
  const { error } = await signInAnon(probe);
  expect(error, error?.message).toBeNull();
  tableMissing = await proposalsTableMissing(probe);
  if (tableMissing) {
    console.warn(proposalsTableSkipReason);
    await probe.auth.signOut();
    return;
  }
  owner = await ownedCtx('Proposals Owner Sdn Bhd');
  other = await ownedCtx('Proposals Other Sdn Bhd');
});
afterAll(async () => {
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

testWithSeed('the owner may decide (update) a pending proposal', async (ctx) => {
  needsTable(ctx);
  const id = await seedPending(owner.orgId);
  const res = await owner.c
    .from('agent_proposals')
    .update({ status: 'rejected', decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', owner.orgId)
    .select('id')
    .maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data?.id).toBe(id);
});

testWithSeed('another workspace cannot update the owner’s proposal (RLS)', async (ctx) => {
  needsTable(ctx);
  const id = await seedPending(owner.orgId);
  // Only granted columns, so it is RLS (not the column grant) that blocks: 0 rows matched.
  const res = await other.c
    .from('agent_proposals')
    .update({ status: 'rejected', decided_at: new Date().toISOString() })
    .eq('id', id)
    .select('id');
  expect(res.error).toBeNull();
  expect(res.data ?? []).toHaveLength(0);
  // The row is untouched: still pending.
  const check = await service!.from('agent_proposals').select('status').eq('id', id).single();
  expect(check.data?.status).toBe('pending');
});

testWithSeed('a crm proposal is inserted by the service role and read by a workspace member', async (ctx) => {
  needsTable(ctx);
  const ins = await service!
    .from('agent_proposals')
    .insert({ ...proposalFields(owner.orgId), product: 'crm' })
    .select('id')
    .single();
  expect(ins.error, ins.error?.message).toBeNull();
  const id = (ins.data as { id: string }).id;
  const seen = await owner.c.from('agent_proposals').select('id, product').eq('id', id).maybeSingle();
  expect(seen.error, seen.error?.message).toBeNull();
  expect(seen.data?.product).toBe('crm');
  // Another workspace still cannot see it.
  const hidden = await other.c.from('agent_proposals').select('id').eq('id', id);
  expect(hidden.data ?? []).toHaveLength(0);
});

testWithSeed('the owner cannot update a non-granted column', async (ctx) => {
  needsTable(ctx);
  const id = await seedPending(owner.orgId);
  // `title` is outside the (status, result, decided_at, decided_by) column grant → 42501.
  const res = await owner.c
    .from('agent_proposals')
    .update({ title: 'tampered' })
    .eq('id', id)
    .eq('org_id', owner.orgId);
  expect(res.error?.code).toBe('42501');
});
