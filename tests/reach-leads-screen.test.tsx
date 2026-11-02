import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead } from '@/lib/reach/types';

const state = vi.hoisted(() => ({
  hasEnv: true,
  clientCreations: 0,
  lookupError: null as null | { code: string },
}));

const lead: Lead = {
  id: 'lead-1',
  name: 'Aisyah',
  channel: 'whatsapp',
  stage: 'lead',
  source: 'ad',
  promoted_contact_id: 'missing-contact',
  created_at: new Date().toISOString(),
};

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ role: 'viewer', isDemo: true }),
  hasSupabaseEnv: () => state.hasEnv,
  usesSampleData: () => !state.hasEnv,
}));
vi.mock('@/screens/reach/parts', () => ({
  loadReachData: async () => ({ listLeads: async () => [lead] }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    state.clientCreations += 1;
    return {
      from: () => ({
        select: () => ({
          in: async () => (state.lookupError ? { data: null, error: state.lookupError } : { data: [], error: null }),
        }),
      }),
    };
  },
}));
vi.mock('@/components/reach/lead-funnel-table', () => ({
  LeadFunnelTable: ({ leads }: { leads: Lead[] }) => (
    <span>promotion:{leads[0]?.promoted_contact_id ?? 'none'}</span>
  ),
}));
vi.mock('@/components/charts', () => ({
  BarGroup: () => null,
  FunnelFlow: () => null,
}));

beforeEach(() => {
  state.hasEnv = true;
  state.clientCreations = 0;
  state.lookupError = null;
});

describe('the Reach leads screen promotion check', () => {
  it('checks dangling promotions for an anonymous demo viewer on a configured project', async () => {
    const { default: LeadsScreen } = await import('@/screens/reach/leads');
    const html = renderToStaticMarkup(await LeadsScreen());

    expect(state.clientCreations).toBe(1);
    expect(html).toContain('promotion:none');
  });

  it('does not construct a Supabase client in environment-less preview mode', async () => {
    state.hasEnv = false;
    const { default: LeadsScreen } = await import('@/screens/reach/leads');
    const html = renderToStaticMarkup(await LeadsScreen());

    expect(state.clientCreations).toBe(0);
    expect(html).toContain('promotion:missing-contact');
  });

  it('keeps the promotion when the contact lookup fails, instead of inviting a duplicate', async () => {
    state.lookupError = { code: '42501' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: LeadsScreen } = await import('@/screens/reach/leads');
    const html = renderToStaticMarkup(await LeadsScreen());

    expect(html).toContain('promotion:missing-contact');
    expect(JSON.stringify(err.mock.calls)).toContain('42501');
    err.mockRestore();
  });
});
