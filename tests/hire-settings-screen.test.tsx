import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceOverview } from '@/lib/account/workspace-overview';
import type { SettingsModel } from '@/lib/hire/settings-model';
import { DEFAULT_HIRE_SETTINGS } from '@/lib/hire/types';

/**
 * The hiring Settings screen, called as the function it is and rendered to a
 * string. The cards are real components; the data readers and the Application
 * form card (which has its own tests) are replaced.
 */

const mocks = vi.hoisted(() => ({
  getViewer: vi.fn(),
  loadHire: vi.fn(),
  loadWorkspaceOverview: vi.fn(),
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: mocks.getViewer }));
vi.mock('@/lib/account/workspace-overview', () => ({ loadWorkspaceOverview: mocks.loadWorkspaceOverview }));
vi.mock('@/screens/hire/parts', () => ({
  LOAD_FAILED: <p>load failed</p>,
  loadHire: mocks.loadHire,
}));
vi.mock('@/screens/hire/application-form-card', () => ({
  ApplicationFormCard: () => <div data-application-form="" />,
}));
// The card imports the server action; the real one pulls in the server stack.
vi.mock('@/app/(app)/hire/actions', () => ({ updateApplicationFormAction: vi.fn() }));

import SettingsScreen from '@/screens/hire/settings';
import { settingsGreeting } from '@/screens/hire/settings-cards';

const viewer = (over: Record<string, unknown> = {}) => ({
  userId: 'u1', orgId: 'o1', name: 'Aisyah', email: null, initials: 'A', avatarUrl: null,
  orgName: 'Kedai Maju Sdn Bhd', role: 'owner', isDemo: false, ...over,
});

const model = (over: Partial<SettingsModel['board']> = {}): SettingsModel => ({
  settings: { org_id: 'o1', ...DEFAULT_HIRE_SETTINGS },
  stages: [
    { stage: 'applied', label: 'Applied', count: 7 },
    { stage: 'screening', label: 'Screening', count: 0 },
    { stage: 'interview', label: 'Interview', count: 3 },
    { stage: 'offer', label: 'Offer', count: 1 },
    { stage: 'hired', label: 'Hired', count: 2 },
  ],
  board: { enabled: true, orgId: 'o1', listed: 4, hiddenOpen: 0, ...over },
});

const workspace = (over: Partial<WorkspaceOverview> = {}): WorkspaceOverview => ({
  companyName: 'Kedai Maju Sdn Bhd', registrationNo: '202601099999', members: 4, ...over,
});

const render = async () => renderToStaticMarkup(await SettingsScreen());
/** The words a person reads, with the markup taken out and spaces closed up. */
const words = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

beforeEach(() => {
  mocks.getViewer.mockReset().mockResolvedValue(viewer());
  mocks.loadHire.mockReset().mockResolvedValue({ model: model(), isDemo: false });
  mocks.loadWorkspaceOverview.mockReset().mockResolvedValue(workspace());
});

describe('the screen', () => {
  it('has no Coming soon card, no made-up board and no email cards left', async () => {
    const html = await render();
    expect(html.toLowerCase()).not.toContain('coming soon');
    for (const gone of ['Example job board', 'Email templates', 'Notifications', 'Example template', 'Add stage']) {
      expect(html).not.toContain(gone);
    }
    expect(html).toContain('data-application-form');
  });

  it('shows each stage with its live count, and links to Applications', async () => {
    const text = words(await render());
    for (const row of ['Applied 7', 'Screening 0', 'Interview 3', 'Offer 1', 'Hired 2']) expect(text).toContain(row);
    expect(text).toContain('The five stages are the same in every workspace.');
    expect(await render()).toMatch(/<a [^>]*href="\/hire\/applications"[^>]*>Open Applications<\/a>/);
  });

  it('says the careers page is on, how many jobs it shows, and links to it and to its screen', async () => {
    const html = await render();
    expect(html).toMatch(/>On<\/span>/);
    expect(words(html)).toContain('4 jobs are showing on it.');
    expect(html).toMatch(/<a [^>]*href="\/careers\/o1"[^>]*>View the public page<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/hire\/careers-page"[^>]*>Manage careers page<\/a>/);
  });

  it('says when open jobs are left off the page for having no description', async () => {
    mocks.loadHire.mockResolvedValue({ model: model({ listed: 1, hiddenOpen: 2 }), isDemo: false });
    const text = words(await render());
    expect(text).toContain('1 job is showing on it.');
    expect(text).toContain('2 open jobs have no description, so the page leaves them out.');
  });

  it('says the same jobs would be left out while the page is off', async () => {
    mocks.loadHire.mockResolvedValue({ model: model({ enabled: false, listed: 0, hiddenOpen: 1 }), isDemo: false });
    expect(words(await render())).toContain('1 open job has no description, so the page would leave it out.');
  });

  it('says the careers page is off and offers no public link then', async () => {
    mocks.loadHire.mockResolvedValue({ model: model({ enabled: false }), isDemo: false });
    const html = await render();
    expect(html).toMatch(/>Off<\/span>/);
    expect(words(html)).toContain('No one outside your workspace can see it.');
    expect(html).not.toContain('href="/careers/o1"');
  });

  it('shows the Workspace card first, with the company, the team size and links to Account', async () => {
    const html = await render();
    const text = words(html);
    expect(text).toMatch(/Settings.*Workspace.*Application form/);
    expect(text).toContain('Kedai Maju Sdn Bhd Reg. no 202601099999');
    expect(text).toContain('4 people have access to this workspace');
    expect(html).toMatch(/<a [^>]*href="\/account\/company"[^>]*>Edit company<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/account\/team"[^>]*>Manage team<\/a>/);
    expect(text).not.toContain('Hiring team');
  });

  it('lets each card title and subtitle wrap instead of being cut off, and gives every link 44 pixels', async () => {
    const html = await render();
    const wraps = (text: string) =>
      new RegExp(`<[a-z]+[^>]*class="[^"]*\\bwhitespace-normal\\b[^"]*"[^>]*>${text}</`).test(html);
    for (const t of ['Hiring pipeline', 'Stages candidates move through', 'Careers page', 'Your own public job board']) {
      expect(wraps(t), t).toBe(true);
    }
    const links = html.match(/<a\b[^>]*>/g) ?? [];
    expect(links.length).toBe(5);
    for (const tag of links) expect(tag).toContain('min-h-11');
  });

  it('says so on the Workspace card alone when the workspace cannot be read', async () => {
    mocks.loadWorkspaceOverview.mockResolvedValue(null);
    const text = words(await render());
    expect(text).toContain("Workspace Set in your account, used across every product Couldn't load");
    expect(text).toContain('Applied 7');
  });

  it('says so on the hiring cards when the hiring data cannot be read', async () => {
    mocks.loadHire.mockResolvedValue({ model: null, isDemo: false });
    const html = await render();
    expect(html.match(/load failed/g)?.length).toBe(3);
    expect(words(html)).toContain('Kedai Maju Sdn Bhd Reg. no');
  });

  it('escapes names that contain markup', async () => {
    mocks.getViewer.mockResolvedValue(viewer({ orgName: '<b>Kedai</b>' }));
    mocks.loadWorkspaceOverview.mockResolvedValue(workspace({ companyName: '<i>Zed</i>' }));
    const html = await render();
    expect(html).toContain('&lt;b&gt;Kedai&lt;/b&gt;');
    expect(html).toContain('&lt;i&gt;Zed&lt;/i&gt;');
    expect(html).not.toContain('<i>Zed');
  });

  it('greets the workspace, or the demo company for a demo', async () => {
    expect(await render()).toContain('Recruiting preferences for Kedai Maju Sdn Bhd.');
    mocks.loadHire.mockResolvedValue({ model: model(), isDemo: true });
    expect(await render()).toContain('Recruiting preferences for Rimba Ventures.');
  });
});

describe('settingsGreeting', () => {
  it('names a real workspace', () => {
    expect(settingsGreeting('Kedai Maju Sdn Bhd', false)).toBe('Recruiting preferences for Kedai Maju Sdn Bhd.');
  });
  it('leaves the company out when the name is empty, spaces, or missing', () => {
    expect(settingsGreeting('', false)).toBe('Recruiting preferences.');
    expect(settingsGreeting('   ', false)).toBe('Recruiting preferences.');
    expect(settingsGreeting(null, false)).toBe('Recruiting preferences.');
    expect(settingsGreeting(undefined, false)).toBe('Recruiting preferences.');
  });
  it('uses the demo name for the demo workspace whatever the stored name is', () => {
    expect(settingsGreeting('Anything', true)).toBe('Recruiting preferences for Rimba Ventures.');
  });
  it('trims the name', () => {
    expect(settingsGreeting('  Kedai  ', false)).toBe('Recruiting preferences for Kedai.');
  });
});

describe('the Application form card footnote', () => {
  it('is true now that the public apply form exists', async () => {
    vi.resetModules();
    vi.doUnmock('@/screens/hire/application-form-card');
    const { ApplicationFormCard } = await import('@/screens/hire/application-form-card');
    const html = renderToStaticMarkup(
      <ApplicationFormCard
        mode="edit"
        saved={{ require_cv: true, require_cover_letter: false, ask_portfolio: true, ask_expected_salary: true }}
      />,
    );
    expect(html).toContain('Saved to your workspace. The public apply form follows these switches.');
    expect(html.toLowerCase()).not.toContain('coming soon');
  });
});
