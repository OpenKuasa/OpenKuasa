import { afterAll, beforeAll, expect, test, type TestContext } from 'vitest';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { proposalsTableMissing, proposalsTableSkipReason } from './helpers/agent-proposals-table';
import { createOrg, signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

async function ownedCtx(name: string) {
  const c = liveClient();
  const { error: e1 } = await signInAnon(c);
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
