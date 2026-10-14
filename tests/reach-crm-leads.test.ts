import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ hasEnv: true, org: { orgId: 'o1', role: 'member' } as unknown }));
vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => env.hasEnv }));
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: async () => env.org }));

import { capturedContactToLead, mergeCapturedLeads, type CapturedContactRow } from '@/lib/reach/crm-leads';
import { getReachData } from '@/lib/reach/supabase';
import { buildOverviewModel } from '@/lib/reach/overview';
import { deriveContacts, deriveLeadSummary } from '@/lib/ai/tools';
import { opportunityScan } from '@/lib/agents/reach-agent';
import type { Lead } from '@/lib/reach/types';

const contact = (over: Partial<CapturedContactRow> = {}): CapturedContactRow => ({
  id: 'c1',
  first_name: 'Naim',
  last_name: null,
  status: 'lead',
  source: 'Lead form: Test Form',
  created_at: '2026-10-14T01:00:00Z',
  ...over,
});

const adLead: Lead = {
  id: 'l1',
  name: 'Aisyah',
  channel: 'facebook',
  stage: 'qualified',
  source: 'Raya promo',
  created_at: '2026-10-10T00:00:00Z',
  promoted_contact_id: null,
};

describe('capturedContactToLead', () => {
  it('reads a form contact as a web lead that is already in Kasturi', () => {
    expect(capturedContactToLead(contact({ last_name: 'Rahidin' }))).toEqual({
      id: 'c1',
      name: 'Naim Rahidin',
      channel: 'web',
      stage: 'lead',
      source: 'Lead form: Test Form',
      created_at: '2026-10-14T01:00:00Z',
      promoted_contact_id: 'c1',
      origin: 'crm',
    });
  });

  it('takes the stage from the Kasturi status', () => {
    expect(capturedContactToLead(contact({ status: 'contacted' }))?.stage).toBe('contacted');
    expect(capturedContactToLead(contact({ status: 'qualified' }))?.stage).toBe('qualified');
    expect(capturedContactToLead(contact({ status: 'customer' }))?.stage).toBe('won');
    expect(capturedContactToLead(contact({ status: null }))?.stage).toBe('lead');
  });

  it('leaves out an archived contact', () => {
    expect(capturedContactToLead(contact({ status: 'archived' }))).toBeNull();
  });
});

describe('mergeCapturedLeads', () => {
  it('puts ad leads and captured contacts together, newest first', () => {
    const merged = mergeCapturedLeads([adLead], [contact(), contact({ id: 'c2', status: 'archived' })]);
    expect(merged.map((l) => l.id)).toEqual(['c1', 'l1']);
  });
});

describe('Jebat reads form leads from Kasturi', () => {
  afterEach(() => {
    env.hasEnv = true;
    env.org = { orgId: 'o1', role: 'member' };
  });

  /** A client whose `leads` table is empty and whose contacts hold one form submission. */
  function clientWithFormContact() {
    const asked: { table: string; overlaps?: [string, string[]] }[] = [];
    const client = {
      from: (table: string) => {
        const entry: { table: string; overlaps?: [string, string[]] } = { table };
        asked.push(entry);
        const data = table === 'crm_contacts' ? [contact()] : [];
        const chain = {
          select: () => chain,
          eq: () => chain,
          overlaps: (col: string, values: string[]) => {
            entry.overlaps = [col, values];
            return chain;
          },
          order: () => Promise.resolve({ data, error: null }),
        };
        return chain;
      },
    } as never;
    return { client, asked };
  }

  it('lists the form contact as a lead, asking only for captured contacts', async () => {
    const { client, asked } = clientWithFormContact();
    const leads = await (await getReachData(client)).listLeads();
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ id: 'c1', name: 'Naim', channel: 'web', origin: 'crm' });
    expect(asked.find((a) => a.table === 'crm_contacts')?.overlaps).toEqual(['tags', ['lead-form', 'chatbot']]);
  });

  it('counts it on the Overview and in the AI lead lookups', async () => {
    const { client } = clientWithFormContact();
    const data = await getReachData(client);
    const now = new Date('2026-10-14T02:00:00Z');
    const overview = await buildOverviewModel(data, now);
    expect(overview.kpis.leads.value).toBe(1);
    expect(overview.channelMix.find((c) => c.key === 'web')).toEqual({ key: 'web', label: 'Website', value: 1 });

    const leads = await data.listLeads();
    expect(deriveLeadSummary(leads, now).by_channel.web).toBe(1);
    expect(deriveContacts(leads, { stage: 'lead' })).toEqual([
      expect.objectContaining({ id: 'c1', channel: 'web', managed_in: 'kasturi' }),
    ]);
  });
});

describe('opportunityScan', () => {
  it('does not offer to change the stage of a Kasturi contact', () => {
    const lead = capturedContactToLead(contact())!;
    const appts = [{
      id: 'a1', contact_name: 'Naim', kind: 'Call', scheduled_at: '2026-10-13T00:00:00Z',
      via: 'Phone', status: 'completed' as const, created_at: '2026-10-12T00:00:00Z',
    }];
    const actions = opportunityScan([lead], appts, new Date('2026-10-14T00:00:00Z')).map((c) => c.action);
    expect(actions).not.toContain('setLeadStage');
    expect(actions).not.toContain('promoteLeadToContact');
  });
});
