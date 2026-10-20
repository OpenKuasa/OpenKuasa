import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_CRM_SETTINGS } from '@/lib/crm/settings';

/**
 * Kasturi's Settings page, called as the function it is and rendered to a
 * string. The database is a stand-in; the sample screen and the live view are
 * replaced with markers so the test can see which one the page chose.
 */

const mocks = vi.hoisted(() => ({
  hasSupabaseEnv: vi.fn(),
  view: vi.fn(),
  loadCrmSettings: vi.fn(),
  loadMyKasturiNotifications: vi.fn(),
  listCrmPipelines: vi.fn(),
  getEmailKeyStatus: vi.fn(),
  client: { current: null as unknown },
}));

vi.mock('@/lib/auth/viewer', () => ({
  hasSupabaseEnv: mocks.hasSupabaseEnv,
  getViewer: async () => ({
    orgId: 'org-1',
    userId: 'user-1',
    role: 'owner',
    isDemo: false,
    orgName: 'Viewer Org',
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mocks.client.current }));
vi.mock('@/lib/crm/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/crm/settings')>()),
  loadCrmSettings: mocks.loadCrmSettings,
  loadMyKasturiNotifications: mocks.loadMyKasturiNotifications,
}));
vi.mock('@/lib/crm/pipelines', () => ({ listCrmPipelines: mocks.listCrmPipelines }));
vi.mock('@/lib/crm/email-key', () => ({ getEmailKeyStatus: mocks.getEmailKeyStatus }));
vi.mock('@/screens/crm/settings', () => ({ default: () => <div data-sample-settings="" /> }));
vi.mock('@/screens/crm/settings-view', () => ({
  CrmSettingsView: (props: Record<string, unknown>) => {
    mocks.view(props);
    return <div data-live-settings="" />;
  },
}));

import CrmSettingsPage from '@/screens/crm/settings-page';

type Answer = { data?: unknown; error?: unknown; count?: number | null };

/** A stand-in for the Supabase client: one answer per table, and one for the AI key RPC. */
function fakeClient({ org, aiKey }: { org: Answer; aiKey: Answer }) {
  const from = (table: string) => {
    const answer: Answer = table === 'orgs' ? org : { count: 3, error: null };
    const builder: Record<string, unknown> = {};
    for (const pass of ['select', 'eq']) builder[pass] = () => builder;
    builder.maybeSingle = async () => answer;
    builder.then = (resolve: (value: Answer) => unknown) => resolve(answer);
    return builder;
  };
  return { from, rpc: async () => aiKey };
}

const GOOD_ORG: Answer = { data: { name: 'Acme Sdn Bhd', registration_no: '123' }, error: null };

async function render() {
  return renderToStaticMarkup(await CrmSettingsPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.hasSupabaseEnv.mockReturnValue(true);
  mocks.loadCrmSettings.mockResolvedValue({ settings: DEFAULT_CRM_SETTINGS, saved: true });
  mocks.loadMyKasturiNotifications.mockResolvedValue({});
  mocks.listCrmPipelines.mockResolvedValue([]);
  mocks.getEmailKeyStatus.mockResolvedValue(null);
  mocks.client.current = fakeClient({ org: GOOD_ORG, aiKey: { data: [{ key_hint: 'abcd' }], error: null } });
});

describe('CrmSettingsPage', () => {
  it('shows the sample screen only when no database is configured', async () => {
    mocks.hasSupabaseEnv.mockReturnValue(false);
    expect(await render()).toContain('data-sample-settings');
  });

  it('shows the live settings when everything loads', async () => {
    const html = await render();
    expect(html).toContain('data-live-settings');
    const { overview } = mocks.view.mock.calls[0][0] as { overview: Record<string, unknown> };
    expect(overview).toMatchObject({ companyName: 'Acme Sdn Bhd', registrationNo: '123', hasAiKey: true });
  });

  it('says it could not load, never the sample settings, when a loader fails', async () => {
    mocks.loadCrmSettings.mockRejectedValue(new Error('relation does not exist'));
    const html = await render();
    expect(html).not.toContain('data-sample-settings');
    expect(html).not.toContain('data-live-settings');
    expect(html).toContain('Settings');
    expect(html).toMatch(/Couldn.+t load your settings/);
  });

  it('does not claim the AI key is not set when the key check fails', async () => {
    mocks.client.current = fakeClient({ org: GOOD_ORG, aiKey: { data: null, error: { code: '42501' } } });
    const html = await render();
    expect(mocks.view).not.toHaveBeenCalled();
    expect(html).not.toContain('data-sample-settings');
    expect(html).toMatch(/Couldn.+t load your settings/);
  });

  it('does not show a made-up company when the workspace lookup fails', async () => {
    mocks.client.current = fakeClient({
      org: { data: null, error: { code: '57014' } },
      aiKey: { data: [], error: null },
    });
    const html = await render();
    expect(mocks.view).not.toHaveBeenCalled();
    expect(html).toMatch(/Couldn.+t load your settings/);
  });

  it('says no key is set when the check succeeds and finds none', async () => {
    mocks.client.current = fakeClient({ org: GOOD_ORG, aiKey: { data: [], error: null } });
    await render();
    const { overview } = mocks.view.mock.calls[0][0] as { overview: Record<string, unknown> };
    expect(overview.hasAiKey).toBe(false);
  });
});
