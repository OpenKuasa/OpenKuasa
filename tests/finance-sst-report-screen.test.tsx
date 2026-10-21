import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The SST Report loader, live branch (#222 stage 1): an owner or admin outside the demo is given Save on the
 * settings card; a member, a viewer and the demo read it. A failed settings read throws rather than showing an
 * empty form, and the company's SST no. is only offered. The reads are mocked.
 */

const actions = vi.hoisted(() => ({ saveSstSettingsAction: vi.fn() }));
vi.mock('@/app/(app)/finance/actions', () => actions);

const state = vi.hoisted(() => ({
  viewer: { orgId: 'org', orgName: 'Org', role: 'owner', isDemo: false } as { orgId: string; orgName: string; role: string; isDemo: boolean },
  settings: async (): Promise<unknown> => null,
  company: async (): Promise<{ sstNo: string }> => ({ sstNo: '' }),
}));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => state.viewer, hasSupabaseEnv: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/account/data', () => ({ getCompany: () => state.company() }));
vi.mock('@/lib/finance/sst', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSstSettings: () => state.settings(),
}));

const { default: SstReportScreen } = await import('@/screens/finance/sst-report');
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

beforeEach(() => {
  state.viewer = { orgId: 'org', orgName: 'Org', role: 'owner', isDemo: false };
  state.settings = async () => null;
  state.company = async () => ({ sstNo: '' });
});

describe('the SST Report loader', () => {
  it.each(['owner', 'admin'])('gives an %s the form with Save', async (role) => {
    state.viewer.role = role;
    const html = renderToStaticMarkup(await SstReportScreen());
    expect(html).toMatch(/<button[^>]*type="submit"/);
  });

  it.each(['member', 'viewer'])('gives a %s the card read only', async (role) => {
    state.viewer.role = role;
    const html = renderToStaticMarkup(await SstReportScreen());
    expect(html).not.toMatch(/<button[^>]*type="submit"/);
    expect(textOf(html)).toContain('Only an owner or admin can change SST settings.');
  });

  it('gives the demo workspace the card read only, even as owner', async () => {
    state.viewer.isDemo = true;
    const html = renderToStaticMarkup(await SstReportScreen());
    expect(html).not.toMatch(/<button[^>]*type="submit"/);
  });

  it('throws when the settings cannot be read, instead of showing an empty form', async () => {
    state.settings = async () => {
      throw new Error('read failed');
    };
    await expect(SstReportScreen()).rejects.toThrow('read failed');
  });

  it('offers the company SST no., and is still shown when the company details cannot be read', async () => {
    state.company = async () => ({ sstNo: ' W10-9 ' });
    expect(textOf(renderToStaticMarkup(await SstReportScreen()))).toContain('Your company details have SST no. W10-9.');
    state.company = async () => {
      throw new Error('no company');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const text = textOf(renderToStaticMarkup(await SstReportScreen()));
    expect(text).toContain('SST settings');
    expect(text).not.toContain('Your company details have');
  });
});
