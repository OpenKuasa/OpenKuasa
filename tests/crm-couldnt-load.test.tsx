import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Six Kasturi screens used to show sample figures when their live read failed.
 * Each page is called as the function it is and rendered to a string. The
 * sample screens are replaced with markers so the test can see which one the
 * page chose.
 */

const mocks = vi.hoisted(() => ({
  hasSupabaseEnv: vi.fn(),
  fail: () => Promise.reject(new Error('relation does not exist')),
}));

vi.mock('@/lib/auth/viewer', () => ({
  hasSupabaseEnv: mocks.hasSupabaseEnv,
  getViewer: async () => ({ orgId: 'org-1', userId: 'user-1', role: 'viewer', isDemo: false, email: 'a@b.test' }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ rpc: async () => ({ data: [], error: null }) }),
}));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@/lib/crm/chatbot', async (original) => ({
  ...(await original<typeof import('@/lib/crm/chatbot')>()),
  loadChatbot: mocks.fail,
  loadChatbotActivity: mocks.fail,
}));
vi.mock('@/lib/crm/automations', async (original) => ({
  ...(await original<typeof import('@/lib/crm/automations')>()),
  listAutomations: mocks.fail,
}));
vi.mock('@/lib/crm/broadcasts', async (original) => ({
  ...(await original<typeof import('@/lib/crm/broadcasts')>()),
  listBroadcasts: mocks.fail,
}));
vi.mock('@/lib/crm/landing-pages', async (original) => ({
  ...(await original<typeof import('@/lib/crm/landing-pages')>()),
  listLandingPageForms: mocks.fail,
  listLandingPages: mocks.fail,
}));
vi.mock('@/lib/crm/contacts', async (original) => ({
  ...(await original<typeof import('@/lib/crm/contacts')>()),
  listCrmContacts: mocks.fail,
}));
vi.mock('@/lib/crm/pipelines', async (original) => ({
  ...(await original<typeof import('@/lib/crm/pipelines')>()),
  listCrmPipelines: mocks.fail,
}));
vi.mock('@/lib/crm/deals', async (original) => ({
  ...(await original<typeof import('@/lib/crm/deals')>()),
  listCrmDeals: mocks.fail,
}));

vi.mock('@/screens/crm/chatbot', () => ({ default: () => <div data-sample="chatbot" /> }));
vi.mock('@/screens/crm/automations', () => ({ default: () => <div data-sample="automations" /> }));
vi.mock('@/screens/crm/broadcast', () => ({ default: () => <div data-sample="broadcasts" /> }));
vi.mock('@/screens/crm/landing-page', () => ({ default: () => <div data-sample="landing pages" /> }));
vi.mock('@/screens/reach/contacts', () => ({ default: () => <div data-sample="contacts" /> }));
vi.mock('@/screens/crm/deals', () => ({ default: () => <div data-sample="deals" /> }));

import ChatbotPage from '@/screens/crm/chatbot-page';
import AutomationsPage from '@/screens/crm/automations-page';
import BroadcastsPage from '@/screens/crm/broadcasts-page';
import LandingPagesPage from '@/screens/crm/landing-pages-page';
import ContactsPage from '@/screens/crm/contacts-page';
import DealsPage from '@/screens/crm/deals-page';

const SCREENS: Array<{ thing: string; title: string; page: () => Promise<React.ReactElement> }> = [
  { thing: 'chatbot', title: 'AI Chatbot', page: ChatbotPage },
  { thing: 'automations', title: 'Automations', page: AutomationsPage },
  { thing: 'broadcasts', title: 'Broadcast', page: BroadcastsPage },
  { thing: 'landing pages', title: 'Landing Pages', page: LandingPagesPage },
  { thing: 'contacts', title: 'Contacts', page: ContactsPage },
  { thing: 'deals', title: 'Deals', page: DealsPage },
];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each(SCREENS)('$title page', ({ thing, title, page }) => {
  it('says it could not load, never the sample screen, when the live read fails', async () => {
    mocks.hasSupabaseEnv.mockReturnValue(true);
    const html = renderToStaticMarkup(await page());
    expect(html).not.toContain('data-sample');
    expect(html).toContain(title);
    expect(html).toMatch(new RegExp(`Couldn.+t load your ${thing} — please refresh`));
  });

  it('shows the sample screen when no database is configured', async () => {
    mocks.hasSupabaseEnv.mockReturnValue(false);
    const html = renderToStaticMarkup(await page());
    expect(html).toContain(`data-sample="${thing}"`);
    expect(html).not.toMatch(/Couldn.+t load/);
  });
});
