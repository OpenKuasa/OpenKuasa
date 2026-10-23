import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  hasSupabaseEnv: vi.fn(),
  loadCrmConnections: vi.fn(),
}));

vi.mock('@/lib/auth/viewer', () => ({
  hasSupabaseEnv: mocks.hasSupabaseEnv,
  getViewer: async () => ({ orgId: 'org-1', userId: 'user-1', role: 'viewer', isDemo: false, email: 'a@b.test' }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/crm/connections', () => ({ loadCrmConnections: mocks.loadCrmConnections }));
vi.mock('@/screens/crm/plugins', () => ({ default: () => <p>SAMPLE PLUGINS</p> }));

import CrmPluginsPage from '@/screens/crm/plugins-page';
import { NOT_AVAILABLE, PluginsView } from '@/screens/crm/plugins-view';

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe('Kasturi Plugins', () => {
  beforeEach(() => {
    mocks.hasSupabaseEnv.mockReset().mockReturnValue(true);
    mocks.loadCrmConnections.mockReset();
  });

  it('shows each connection with its state and where it is set up, and no buttons', () => {
    const out = html(
      <PluginsView connections={{ hasAiKey: false, emailSender: 'hi@shop.my', pagesWithChat: null, automationsOn: 3 }} />,
    );
    expect(out).toContain('AI key (OpenRouter)');
    expect(out).toContain('Not set');
    expect(out).toContain('href="/account/ai"');
    expect(out).toContain('Add a key');
    expect(out).toContain('From hi@shop.my');
    expect(out).toContain('Unknown');
    expect(out).toContain('3 on');
    expect(out).not.toContain('<button');
    expect(out).not.toMatch(/>Connected</);
  });

  it('lists what is not built yet, MyInvois included, as not available', () => {
    const out = html(<PluginsView connections={{ hasAiKey: true, emailSender: null, pagesWithChat: 0, automationsOn: 0 }} />);
    expect(out).toContain('Not available yet');
    for (const item of NOT_AVAILABLE) expect(out).toContain(item.name);
    expect(out).toContain('nothing is sent to LHDN yet');
  });

  it('says it could not load instead of showing sample states', async () => {
    mocks.loadCrmConnections.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = html(await CrmPluginsPage());
    expect(out).toContain('Couldn&#x27;t load your connections');
    expect(out).not.toContain('SAMPLE PLUGINS');
  });

  it('shows the workspace connections once loaded', async () => {
    mocks.loadCrmConnections.mockResolvedValue({ hasAiKey: true, emailSender: null, pagesWithChat: 2, automationsOn: 0 });
    const out = html(await CrmPluginsPage());
    expect(out).toContain('On for 2 pages');
    expect(out).toContain('None on');
  });

  it('uses the sample screen only without a database', async () => {
    mocks.hasSupabaseEnv.mockReturnValue(false);
    expect(html(await CrmPluginsPage())).toContain('SAMPLE PLUGINS');
    expect(mocks.loadCrmConnections).not.toHaveBeenCalled();
  });
});
