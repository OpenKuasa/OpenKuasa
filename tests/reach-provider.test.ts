import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ hasEnv: true, org: { orgId: 'o1', role: 'member' } as unknown }));
vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => env.hasEnv }));
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: async () => env.org }));

import { getReachData } from '@/lib/reach/supabase';

/** Records which table and columns the provider asked for. */
const asked = { tables: [] as string[], columns: [] as string[] };
const row = { id: 'c1', name: 'X', channel: 'whatsapp', status: 'active', leads_count: 1, spend_cents: 1, cpl_cents: 1, created_at: 'now' };
const fakeClient = {
  from: (table: string) => {
    asked.tables.push(table);
    return {
      select: (columns: string) => {
        asked.columns.push(columns);
        return { eq: () => ({ order: async () => ({ data: [row], error: null }) }) };
      },
    };
  },
} as never;

afterEach(() => {
  env.hasEnv = true;
  env.org = { orgId: 'o1', role: 'member' };
  asked.tables = [];
  asked.columns = [];
});

describe('getReachData', () => {
  it('uses the Supabase provider when env + org are present', async () => {
    const data = await getReachData(fakeClient);
    const campaigns = await data.listCampaigns();
    expect(campaigns[0].id).toBe('c1');
  });

  it('reads lead forms from the forms table, every column the Form type has', async () => {
    const data = await getReachData(fakeClient);
    expect(await data.listForms()).toHaveLength(1);
    expect(asked.tables).toEqual(['forms']);
    expect(asked.columns[0].split(',').sort()).toEqual([
      'category', 'channel', 'consent_text', 'created_at', 'id', 'name', 'slug', 'status', 'submissions_count', 'updated_at', 'views_count',
    ]);
  });

  it('gives the six sample forms from the seed, and none without a workspace', async () => {
    env.hasEnv = false;
    expect(await (await getReachData(fakeClient)).listForms()).toHaveLength(6);
    env.hasEnv = true;
    env.org = null;
    expect(await (await getReachData(fakeClient)).listForms()).toEqual([]);
    expect(asked.tables).toEqual([]);
  });

  it('falls back to the seed provider when no Supabase env', async () => {
    env.hasEnv = false;
    const data = await getReachData(fakeClient);
    // seed campaigns use string ids like "camp_1" and have 5 rows
    expect(await data.listCampaigns()).toHaveLength(5);
  });

  it('returns empty data (never the seed) when there is no current org', async () => {
    env.org = null;
    const data = await getReachData(fakeClient);
    expect(await data.listCampaigns()).toHaveLength(0);
    expect(await data.listLeads()).toHaveLength(0);
  });
});
