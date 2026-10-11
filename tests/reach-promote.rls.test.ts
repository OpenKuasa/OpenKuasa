import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  type ReachWriteContext,
  createLead,
  deleteLead,
  promoteLeadToContact,
} from '@/lib/reach/capabilities';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

async function ownedCtx(name: string): Promise<ReachWriteContext> {
  const c = client();
  const { error: e1 } = await signInAnon(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { client: c, orgId: orgId as string };
}

let owner: ReachWriteContext;
let other: ReachWriteContext;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  owner = await ownedCtx('Promote Owner Sdn Bhd');
  other = await ownedCtx('Promote Other Sdn Bhd');
});
afterAll(async () => {
  await owner?.client.auth.signOut();
  await other?.client.auth.signOut();
});

testWithSupabase('promoting a lead creates a CRM contact, stamps the lead, and is idempotent', async () => {
  let leadId: string | null = null;
  let contactId: string | null = null;
  try {
    const created = await createLead(owner, { name: 'Aisyah Rahim', channel: 'whatsapp', stage: 'won' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    leadId = created.data.id;

    // ok + a crm_contacts row with the mapped status, score and channel tag
    const promoted = await promoteLeadToContact(owner, { id: leadId });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    contactId = promoted.data.contact_id;
    const contact = await owner.client
      .from('crm_contacts')
      .select('org_id,first_name,last_name,status,lead_score,tags')
      .eq('id', contactId)
      .single();
    expect(contact.error, contact.error?.message).toBeNull();
    expect(contact.data).toMatchObject({
      org_id: owner.orgId,
      first_name: 'Aisyah',
      last_name: 'Rahim',
      status: 'customer',
      lead_score: 100,
    });
    expect(contact.data?.tags).toContain('whatsapp');

    // the lead is stamped
    const lead = await owner.client.from('leads').select('promoted_contact_id').eq('id', leadId).single();
    expect(lead.error, lead.error?.message).toBeNull();
    expect(lead.data?.promoted_contact_id).toBe(contactId);

    // promoting again is refused
    const again = await promoteLeadToContact(owner, { id: leadId });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/already promoted/i);

    // a second org cannot see (so cannot promote) the owner's lead
    const intrusion = await promoteLeadToContact(other, { id: leadId });
    expect(intrusion.ok).toBe(false);
    if (!intrusion.ok) expect(intrusion.error).toMatch(/not found/i);
  } finally {
    if (contactId) await owner.client.from('crm_contacts').delete().eq('id', contactId);
    if (leadId) await deleteLead(owner, { id: leadId });
  }
});

testWithSupabase('a lead whose promoted CRM contact was deleted can be promoted again', async () => {
  let leadId: string | null = null;
  const contactIds: string[] = [];
  try {
    const created = await createLead(owner, { name: 'Faridah Osman', channel: 'whatsapp', stage: 'qualified' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    leadId = created.data.id;

    const first = await promoteLeadToContact(owner, { id: leadId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const contactId1 = first.data.contact_id;
    contactIds.push(contactId1);

    // a CRM user deletes the promoted contact
    const del = await owner.client.from('crm_contacts').delete().eq('id', contactId1).eq('org_id', owner.orgId);
    expect(del.error, del.error?.message).toBeNull();

    // the guard now allows a fresh promote
    const second = await promoteLeadToContact(owner, { id: leadId });
    expect(second.ok, second.ok ? '' : second.error).toBe(true);
    if (!second.ok) return;
    const contactId2 = second.data.contact_id;
    contactIds.push(contactId2);
    expect(contactId2).not.toBe(contactId1);

    const lead = await owner.client.from('leads').select('promoted_contact_id').eq('id', leadId).single();
    expect(lead.error, lead.error?.message).toBeNull();
    expect(lead.data?.promoted_contact_id).toBe(contactId2);
  } finally {
    for (const cid of contactIds) {
      await owner.client.from('crm_contacts').delete().eq('id', cid).eq('org_id', owner.orgId);
    }
    if (leadId) await deleteLead(owner, { id: leadId });
  }
});
