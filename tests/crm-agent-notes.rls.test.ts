// Live: agent notes on Kasturi records (20261125150100_crm_agent_notes.sql).
//
// The RPC only writes a note an approved `crm` proposal asked for, so each case seeds
// that approval with the service role (authenticated users cannot insert proposals).
// Seeding needs agent_proposals.product to allow 'crm' (a later migration of the
// Kasturi focus-agent plan widens the check); until then the seed insert fails.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const service: SupabaseClient | null =
  serviceUrl && serviceKey
    ? createClient(serviceUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

const testWithSupabase = hasSupabaseEnv && service ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);
if (hasSupabaseEnv && !service) console.warn('SUPABASE_SERVICE_ROLE_KEY not set: skipping the agent-note asserts.');

type Workspace = { c: SupabaseClient; userId: string; orgId: string; dealId: string; contactId: string };

async function workspaceWithDeal(name: string): Promise<Workspace> {
  const c = liveClient();
  const { userId } = await signInOwner(c);
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  const org = orgId as string;

  const pipeline = await c
    .from('crm_pipelines')
    .insert({ org_id: org, name: 'Sales', is_default: true })
    .select('id')
    .single();
  expect(pipeline.error, pipeline.error?.message).toBeNull();
  const stage = await c
    .from('crm_pipeline_stages')
    .insert({ org_id: org, pipeline_id: pipeline.data!.id, name: 'New', position: 1 })
    .select('id')
    .single();
  expect(stage.error, stage.error?.message).toBeNull();
  const contact = await c
    .from('crm_contacts')
    .insert({ org_id: org, first_name: 'Aina' })
    .select('id')
    .single();
  expect(contact.error, contact.error?.message).toBeNull();
  const deal = await c
    .from('crm_deals')
    .insert({
      org_id: org,
      contact_id: contact.data!.id,
      pipeline_id: pipeline.data!.id,
      stage_id: stage.data!.id,
      title: 'Agent note test deal',
    })
    .select('id')
    .single();
  expect(deal.error, deal.error?.message).toBeNull();
  return { c, userId, orgId: org, dealId: deal.data!.id, contactId: contact.data!.id };
}

type NoteTarget = { dealId?: string; contactId?: string };

/** Seeds an approved createAgentNote proposal, as the approval path leaves it, and returns its id. */
async function seedApproval(orgId: string, decidedBy: string, target: NoteTarget, body: string): Promise<string> {
  const { data, error } = await service!
    .from('agent_proposals')
    .insert({
      org_id: orgId,
      agent_key: 'crm-focus',
      product: 'crm',
      action: 'createAgentNote',
      input: { ...target, body },
      title: 'Add a note?',
      status: 'approved',
      decided_by: decidedBy,
      decided_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  expect(error, error?.message).toBeNull();
  return (data as { id: string }).id;
}

let owner: Workspace;
let other: Workspace;
beforeAll(async () => {
  if (!hasSupabaseEnv || !service) return;
  owner = await workspaceWithDeal('Agent Notes Owner Sdn Bhd');
  other = await workspaceWithDeal('Agent Notes Other Sdn Bhd');
}, 60_000);
afterAll(async () => {
  await owner?.c.auth.signOut();
  await other?.c.auth.signOut();
});

const addAgentNote = (c: SupabaseClient, target: NoteTarget, body: string) =>
  c.rpc('crm_add_agent_note', {
    p_deal_id: target.dealId ?? null,
    p_contact_id: target.contactId ?? null,
    p_body: body,
  });

testWithSupabase('an approved proposal on an own deal gives one agent note, once', async () => {
  const body = 'Follow up this week.';
  const proposalId = await seedApproval(owner.orgId, owner.userId, { dealId: owner.dealId }, body);
  const { data: id, error } = await addAgentNote(owner.c, { dealId: owner.dealId }, body);
  expect(error, error?.message).toBeNull();
  expect(typeof id).toBe('string');
  const row = await owner.c
    .from('crm_notes')
    .select('source,deal_id,contact_id,org_id,agent_proposal_id,created_by')
    .eq('id', id as string)
    .single();
  expect(row.error, row.error?.message).toBeNull();
  expect(row.data).toEqual({
    source: 'agent',
    deal_id: owner.dealId,
    contact_id: null,
    org_id: owner.orgId,
    agent_proposal_id: proposalId,
    created_by: owner.userId,
  });

  const again = await addAgentNote(owner.c, { dealId: owner.dealId }, body);
  expect(again.error?.code).toBe('42501');
});

testWithSupabase('an approved proposal on an own contact gives an agent note', async () => {
  const body = 'Contact asked for a quote.';
  await seedApproval(owner.orgId, owner.userId, { contactId: owner.contactId }, body);
  const { data: id, error } = await addAgentNote(owner.c, { contactId: owner.contactId }, body);
  expect(error, error?.message).toBeNull();
  const row = await owner.c.from('crm_notes').select('source,contact_id,deal_id').eq('id', id as string).single();
  expect(row.data).toEqual({ source: 'agent', contact_id: owner.contactId, deal_id: null });
});

testWithSupabase('without a matching approved proposal the RPC is refused', async () => {
  // nothing approved for this text
  const none = await addAgentNote(owner.c, { dealId: owner.dealId }, 'My own words, labelled agent.');
  expect(none.error?.code).toBe('42501');
  // approved for a different body
  await seedApproval(owner.orgId, owner.userId, { dealId: owner.dealId }, 'The approved text.');
  const otherText = await addAgentNote(owner.c, { dealId: owner.dealId }, 'Different text.');
  expect(otherText.error?.code).toBe('42501');
  // approved for the deal, called for the contact
  await seedApproval(owner.orgId, owner.userId, { dealId: owner.dealId }, 'Wrong record.');
  const wrongRecord = await addAgentNote(owner.c, { contactId: owner.contactId }, 'Wrong record.');
  expect(wrongRecord.error?.code).toBe('42501');
  const seen = await owner.c.from('crm_notes').select('id').in('body', ['My own words, labelled agent.', 'Different text.', 'Wrong record.']);
  expect(seen.data ?? []).toHaveLength(0);
});

testWithSupabase('crm_add_agent_note refuses both ids, neither id, and a body over 1000 characters', async () => {
  const both = await addAgentNote(owner.c, { dealId: owner.dealId, contactId: owner.contactId }, 'x');
  expect(both.error).not.toBeNull();
  const neither = await addAgentNote(owner.c, {}, 'x');
  expect(neither.error).not.toBeNull();
  const long = 'a'.repeat(1001);
  await seedApproval(owner.orgId, owner.userId, { dealId: owner.dealId }, long);
  const tooLong = await addAgentNote(owner.c, { dealId: owner.dealId }, long);
  expect(tooLong.error).not.toBeNull();
});

testWithSupabase('a direct insert of an agent note is refused; a user note is fine', async () => {
  const forged = await owner.c
    .from('crm_notes')
    .insert({ org_id: owner.orgId, deal_id: owner.dealId, body: 'forged', source: 'agent' });
  expect(forged.error?.code).toBe('42501');

  const proposalId = await seedApproval(owner.orgId, owner.userId, { dealId: owner.dealId }, 'claimed');
  const claim = await owner.c
    .from('crm_notes')
    .insert({ org_id: owner.orgId, deal_id: owner.dealId, body: 'claimed', agent_proposal_id: proposalId });
  expect(claim.error?.code).toBe('42501');

  const plain = await owner.c
    .from('crm_notes')
    .insert({ org_id: owner.orgId, deal_id: owner.dealId, body: 'mine' })
    .select('id,source')
    .single();
  expect(plain.error, plain.error?.message).toBeNull();
  expect(plain.data!.source).toBe('user');
  const relabel = await owner.c.from('crm_notes').update({ source: 'agent' }).eq('id', plain.data!.id);
  expect(relabel.error?.code).toBe('42501');
  const attach = await owner.c.from('crm_notes').update({ agent_proposal_id: proposalId }).eq('id', plain.data!.id);
  expect(attach.error?.code).toBe('42501');
});

testWithSupabase('an agent note cannot be edited or lose its author, but can be deleted', async () => {
  const body = 'Deal has gone quiet.';
  await seedApproval(owner.orgId, owner.userId, { dealId: owner.dealId }, body);
  const { data: id, error } = await addAgentNote(owner.c, { dealId: owner.dealId }, body);
  expect(error, error?.message).toBeNull();

  const edit = await owner.c.from('crm_notes').update({ body: 'changed' }).eq('id', id as string);
  expect(edit.error?.code).toBe('42501');
  const strip = await owner.c.from('crm_notes').update({ created_by: null }).eq('id', id as string);
  expect(strip.error?.code).toBe('42501');
  const unlink = await owner.c.from('crm_notes').update({ agent_proposal_id: null }).eq('id', id as string);
  expect(unlink.error?.code).toBe('42501');
  const still = await owner.c.from('crm_notes').select('body,created_by').eq('id', id as string).single();
  expect(still.data).toEqual({ body, created_by: owner.userId });

  const del = await owner.c.from('crm_notes').delete().eq('id', id as string).select('id');
  expect(del.error, del.error?.message).toBeNull();
  expect(del.data ?? []).toHaveLength(1);
});

testWithSupabase('who approved a proposal, and when, cannot be re-stamped after the decision', async () => {
  const body = 'Re-stamp me.';
  // Approved in the other user's name (the owner's workspace, owner's deal).
  const proposalId = await seedApproval(owner.orgId, other.userId, { dealId: owner.dealId }, body);
  const before = await service!.from('agent_proposals').select('decided_at,decided_by').eq('id', proposalId).single();
  expect(before.error, before.error?.message).toBeNull();

  const takeOver = await owner.c.from('agent_proposals').update({ decided_by: owner.userId }).eq('id', proposalId);
  expect(takeOver.error?.code).toBe('AGP01');
  const refresh = await owner.c
    .from('agent_proposals')
    .update({ decided_at: new Date(Date.now() + 1000).toISOString() })
    .eq('id', proposalId);
  expect(refresh.error?.code).toBe('AGP01');

  const after = await service!.from('agent_proposals').select('decided_at,decided_by').eq('id', proposalId).single();
  expect(after.data).toEqual(before.data);
  // and the owner still cannot use the other user's approval
  const use = await addAgentNote(owner.c, { dealId: owner.dealId }, body);
  expect(use.error?.code).toBe('42501');
});

testWithSupabase('crm_add_agent_note on another workspace’s deal is refused', async () => {
  const body = 'Not yours.';
  // Even with an approval in the owner's workspace in the other user's name.
  await seedApproval(owner.orgId, other.userId, { dealId: owner.dealId }, body);
  const { data, error } = await addAgentNote(other.c, { dealId: owner.dealId }, body);
  expect(data).toBeNull();
  expect(error?.code).toBe('42501');
  const seen = await owner.c.from('crm_notes').select('id').eq('body', body);
  expect(seen.data ?? []).toHaveLength(0);
});
