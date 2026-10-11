import { describe, expect, it } from 'vitest';
import {
  createCampaignInput,
  leadStageToCrmStatus,
  leadStageToScore,
  splitLeadName,
  updateAdSettingsInput,
  updateCampaignInput,
} from '@/lib/reach/capabilities';

describe('campaign capability schemas', () => {
  it('rejects an empty name', () => {
    expect(createCampaignInput.safeParse({ name: '', channel: 'facebook' }).success).toBe(false);
  });
  it('rejects a bad channel', () => {
    expect(createCampaignInput.safeParse({ name: 'x', channel: 'linkedin' }).success).toBe(false);
  });
  it('rejects negative spend', () => {
    expect(createCampaignInput.safeParse({ name: 'x', channel: 'facebook', spend_cents: -1 }).success).toBe(false);
  });
  it('defaults status active, spend 0, leads 0', () => {
    const p = createCampaignInput.parse({ name: 'x', channel: 'facebook' });
    expect(p).toMatchObject({ status: 'active', spend_cents: 0, leads_count: 0 });
  });
  it('update requires a uuid id and allows partial fields', () => {
    expect(updateCampaignInput.safeParse({ id: 'not-a-uuid', name: 'y' }).success).toBe(false);
    expect(updateCampaignInput.safeParse({ id: '00000000-0000-0000-0000-000000000000', name: 'y' }).success).toBe(true);
  });
});

describe('ad settings schema', () => {
  it('requires a 3-letter currency', () => {
    expect(updateAdSettingsInput.safeParse({ currency: 'MY' }).success).toBe(false);
    expect(updateAdSettingsInput.safeParse({ currency: 'MYR' }).success).toBe(true);
  });
  it('accepts boolean toggle maps and rejects non-boolean values', () => {
    expect(updateAdSettingsInput.safeParse({ automation: { auto_pause: true }, notifications: { email: false } }).success).toBe(true);
    expect(updateAdSettingsInput.safeParse({ automation: { auto_pause: 'yes' } }).success).toBe(false);
  });
});

import { hasSupabaseEnv } from './setup/supabase';
import { createOrg, signInAnon, liveClient } from './helpers/live-workspaces';
import { createCampaign, deleteCampaign, type ReachWriteContext } from '@/lib/reach/capabilities';
import { test as vtest } from 'vitest';
const itSb = hasSupabaseEnv ? vtest : vtest.skip;

itSb('createCampaign writes to the caller org and ignores an input org_id', async () => {
  const c = liveClient();
  const signIn = await signInAnon(c);
  expect(signIn.error).toBeNull();
  const { data: orgId, error: orgError } = await createOrg(c, 'Cap IT Sdn Bhd');
  expect(orgError).toBeNull();
  expect(orgId).toBeTruthy();
  const ctx: ReachWriteContext = { client: c, orgId: orgId as string };
  let createdId: string | null = null;
  try {
    // Pass a bogus org_id in the input; the capability must ignore it and use ctx.orgId.
    const res = await createCampaign(ctx, {
      name: 'From capability', channel: 'facebook', status: 'active', spend_cents: 2000, leads_count: 4,
      // @ts-expect-error — org_id is not part of the input type; prove it's ignored even if present.
      org_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      createdId = res.data.id;
      expect(res.data.cpl_cents).toBe(500);
      const row = await c.from('campaigns').select('org_id').eq('id', res.data.id).single();
      expect(row.error).toBeNull();
      expect(row.data?.org_id).toBe(orgId);
    }
  } finally {
    if (createdId) {
      const del = await deleteCampaign(ctx, { id: createdId });
      expect(del.ok).toBe(true);
    }
    await c.auth.signOut();
  }
});

import { createLeadInput, updateLeadInput } from '@/lib/reach/capabilities';

describe('lead capability schemas', () => {
  it('rejects an empty name and a bad channel', () => {
    expect(createLeadInput.safeParse({ name: '', channel: 'whatsapp' }).success).toBe(false);
    expect(createLeadInput.safeParse({ name: 'x', channel: 'linkedin' }).success).toBe(false);
  });
  it('defaults stage to lead', () => {
    expect(createLeadInput.parse({ name: 'x', channel: 'whatsapp' })).toMatchObject({ stage: 'lead' });
  });
  it('update requires a uuid id and ignores org_id / promoted_contact_id', () => {
    expect(updateLeadInput.safeParse({ id: 'nope', name: 'y' }).success).toBe(false);
    const p = updateLeadInput.parse({
      id: '00000000-0000-0000-0000-000000000000',
      name: 'y',
      org_id: 'evil',
      promoted_contact_id: 'evil',
    });
    expect('org_id' in p).toBe(false);
    expect('promoted_contact_id' in p).toBe(false);
  });
});

import { createLead, deleteLead, setLeadStage } from '@/lib/reach/capabilities';

itSb('createLead writes to the caller org, ignores an input org_id, and round-trips', async () => {
  const c = liveClient();
  const signIn = await signInAnon(c);
  expect(signIn.error).toBeNull();
  const { data: orgId, error: orgError } = await createOrg(c, 'Lead Cap IT Sdn Bhd');
  expect(orgError).toBeNull();
  expect(orgId).toBeTruthy();
  const ctx: ReachWriteContext = { client: c, orgId: orgId as string };
  let createdId: string | null = null;
  try {
    const res = await createLead(ctx, {
      name: 'From capability', channel: 'whatsapp',
      // @ts-expect-error — org_id is not part of the input type; prove it's ignored even if present.
      org_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      createdId = res.data.id;
      expect(res.data.stage).toBe('lead');
      expect(res.data.promoted_contact_id).toBeNull();
      const row = await c.from('leads').select('org_id').eq('id', res.data.id).single();
      expect(row.error).toBeNull();
      expect(row.data?.org_id).toBe(orgId);
      const moved = await setLeadStage(ctx, { id: res.data.id, stage: 'qualified' });
      expect(moved.ok).toBe(true);
      if (moved.ok) expect(moved.data.stage).toBe('qualified');
    }
  } finally {
    if (createdId) {
      const del = await deleteLead(ctx, { id: createdId });
      expect(del.ok).toBe(true);
    }
    await c.auth.signOut();
  }
});

describe('lead → contact mapping helpers', () => {
  it('maps lead stages to CRM statuses', () => {
    expect(leadStageToCrmStatus('won')).toBe('customer');
    expect(leadStageToCrmStatus('booked')).toBe('qualified');
    expect(leadStageToCrmStatus('lead')).toBe('lead');
  });
  it('maps lead stages to a lead score', () => {
    expect(leadStageToScore('qualified')).toBe(60);
    expect(leadStageToScore('won')).toBe(100);
  });
  it('splits a name into first and last', () => {
    expect(splitLeadName('Aisyah Rahim')).toEqual({ first_name: 'Aisyah', last_name: 'Rahim' });
    expect(splitLeadName('Cher')).toEqual({ first_name: 'Cher', last_name: null });
  });
});
