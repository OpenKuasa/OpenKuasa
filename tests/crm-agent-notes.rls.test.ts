// Live: agent notes on Kasturi records (20261125140100_crm_agent_notes.sql).
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Workspace = { c: SupabaseClient; orgId: string; dealId: string; contactId: string };

async function workspaceWithDeal(name: string): Promise<Workspace> {
  const c = liveClient();
  await signInOwner(c);
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
  return { c, orgId: org, dealId: deal.data!.id, contactId: contact.data!.id };
}

let owner: Workspace;
let other: Workspace;
beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  owner = await workspaceWithDeal('Agent Notes Owner Sdn Bhd');
  other = await workspaceWithDeal('Agent Notes Other Sdn Bhd');
}, 60_000);
afterAll(async () => {
  await owner?.c.auth.signOut();
  await other?.c.auth.signOut();
});

const addAgentNote = (c: SupabaseClient, dealId: string, body: string) =>
  c.rpc('crm_add_agent_note', { p_deal_id: dealId, p_contact_id: null, p_body: body });

testWithSupabase('crm_add_agent_note on an own deal returns an id and the note is marked agent', async () => {
  const { data: id, error } = await addAgentNote(owner.c, owner.dealId, 'Follow up this week.');
  expect(error, error?.message).toBeNull();
  expect(typeof id).toBe('string');
  const row = await owner.c.from('crm_notes').select('source,deal_id,org_id').eq('id', id as string).single();
  expect(row.error, row.error?.message).toBeNull();
  expect(row.data).toEqual({ source: 'agent', deal_id: owner.dealId, org_id: owner.orgId });
});

testWithSupabase('crm_add_agent_note refuses both ids or neither id', async () => {
  const both = await owner.c.rpc('crm_add_agent_note', {
    p_deal_id: owner.dealId,
    p_contact_id: owner.contactId,
    p_body: 'x',
  });
  expect(both.error).not.toBeNull();
  const neither = await owner.c.rpc('crm_add_agent_note', { p_deal_id: null, p_contact_id: null, p_body: 'x' });
  expect(neither.error).not.toBeNull();
});

testWithSupabase('a direct insert of an agent note is refused; a user note is fine', async () => {
  const forged = await owner.c
    .from('crm_notes')
    .insert({ org_id: owner.orgId, deal_id: owner.dealId, body: 'forged', source: 'agent' });
  expect(forged.error).not.toBeNull();
  expect(forged.error?.code).toBe('42501');

  const plain = await owner.c
    .from('crm_notes')
    .insert({ org_id: owner.orgId, deal_id: owner.dealId, body: 'mine' })
    .select('id,source')
    .single();
  expect(plain.error, plain.error?.message).toBeNull();
  expect(plain.data!.source).toBe('user');
  const relabel = await owner.c.from('crm_notes').update({ source: 'agent' }).eq('id', plain.data!.id);
  expect(relabel.error?.code).toBe('42501');
});

testWithSupabase('an agent note cannot be edited but can be deleted', async () => {
  const { data: id, error } = await addAgentNote(owner.c, owner.dealId, 'Deal has gone quiet.');
  expect(error, error?.message).toBeNull();

  const edit = await owner.c.from('crm_notes').update({ body: 'changed' }).eq('id', id as string);
  expect(edit.error).not.toBeNull();
  expect(edit.error?.code).toBe('42501');
  const still = await owner.c.from('crm_notes').select('body').eq('id', id as string).single();
  expect(still.data!.body).toBe('Deal has gone quiet.');

  const del = await owner.c.from('crm_notes').delete().eq('id', id as string).select('id');
  expect(del.error, del.error?.message).toBeNull();
  expect(del.data ?? []).toHaveLength(1);
});

testWithSupabase('crm_add_agent_note on another workspace’s deal is refused', async () => {
  const { data, error } = await addAgentNote(other.c, owner.dealId, 'Not yours.');
  expect(data).toBeNull();
  expect(error).not.toBeNull();
  expect(error?.code).toBe('42501');
  const seen = await owner.c.from('crm_notes').select('id').eq('body', 'Not yours.');
  expect(seen.data ?? []).toHaveLength(0);
});
