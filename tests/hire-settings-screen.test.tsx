import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The hiring Settings screen, called as the function it is and rendered to a
 * string. The five preview cards are real components; the data readers and the
 * Application form card (which has its own tests) are replaced.
 */

const mocks = vi.hoisted(() => ({
  getViewer: vi.fn(),
  loadHire: vi.fn(),
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: mocks.getViewer }));
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
import {
  EmailTemplatesPreview,
  HiringTeamPreview,
  JobBoardsPreview,
  NotificationsPreview,
  PipelinePreview,
  settingsGreeting,
} from '@/screens/hire/settings-previews';

const viewer = (over: Record<string, unknown> = {}) => ({
  userId: 'u1', orgId: 'o1', name: 'Aisyah', email: null, initials: 'A', avatarUrl: null,
  orgName: 'Kedai Maju Sdn Bhd', role: 'owner', isDemo: false, ...over,
});

const render = async () => renderToStaticMarkup(await SettingsScreen());

const CARDS = [
  { key: 'pipeline', Card: PipelinePreview },
  { key: 'boards', Card: JobBoardsPreview },
  { key: 'templates', Card: EmailTemplatesPreview },
  { key: 'team', Card: HiringTeamPreview },
  { key: 'notifications', Card: NotificationsPreview },
] as const;

const TITLES = {
  pipeline: { title: 'Hiring pipeline', subtitle: 'Stages candidates move through' },
  boards: { title: 'Job board integrations', subtitle: 'Where your roles get posted' },
  templates: { title: 'Email templates', subtitle: 'Automated candidate messages' },
  team: { title: 'Hiring team', subtitle: 'Managers and interviewers' },
  notifications: { title: 'Notifications', subtitle: 'Choose what you get notified about' },
} as const;

const LINE = 'A preview of what is planned. Nothing here works or is saved yet.';

/** Every opening tag that starts a button (a switch is a button with role="switch"). */
const buttonTags = (html: string) => html.match(/<button\b[^>]*>/g) ?? [];

beforeEach(() => {
  mocks.getViewer.mockReset().mockResolvedValue(viewer());
  mocks.loadHire.mockReset().mockResolvedValue({ model: {}, isDemo: false });
});

describe('the five preview cards', () => {
  for (const { key, Card } of CARDS) {
    describe(key, () => {
      const html = renderToStaticMarkup(<Card />);
      const id = `settings-soon-${key}`;

      it('says Coming soon and explains it in the card', () => {
        expect(html).toContain('Coming soon');
        expect(html).toContain(LINE);
        expect(html).toMatch(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>${LINE}</`));
      });

      it('disables every control and points each at the explanation', () => {
        const tags = buttonTags(html);
        expect(tags.length).toBeGreaterThan(0);
        const inert = tags.filter(
          (tag) => /\sdisabled=""/.test(tag) && tag.includes(`aria-describedby="${id}"`),
        );
        expect(inert.length).toBe(tags.length);
        const switches = html.match(/role="switch"/g) ?? [];
        const inertSwitches = tags.filter(
          (tag) => tag.includes('role="switch"') && /\sdisabled=""/.test(tag) && tag.includes(`aria-describedby="${id}"`),
        );
        expect(inertSwitches.length).toBe(switches.length);
      });

      it('lets the title and the subtitle wrap instead of being cut off', () => {
        const title = TITLES[key];
        const wraps = (text: string) =>
          new RegExp(`<[a-z]+[^>]*class="[^"]*\\bwhitespace-normal\\b[^"]*"[^>]*>${text}</`).test(html);
        expect(wraps(title.title)).toBe(true);
        expect(wraps(title.subtitle)).toBe(true);
      });

      it('has no switch that is on', () => {
        expect(html).not.toContain('aria-checked="true"');
      });
    });
  }

  it('names the pipeline grips', () => {
    const html = renderToStaticMarkup(<PipelinePreview />);
    for (const stage of ['Applied', 'Screening', 'Interview', 'Offer', 'Hired']) {
      expect(html).toContain(`aria-label="Move ${stage} (coming soon)"`);
    }
    expect(html).toContain('Add stage');
  });

  it('names the job boards generically and connects none', () => {
    const html = renderToStaticMarkup(<JobBoardsPreview />);
    for (const letter of ['A', 'B', 'C']) {
      expect(html).toContain(`Example job board ${letter}`);
      expect(html).toContain(`aria-label="Connect Example job board ${letter}"`);
    }
    expect(html).toContain('Post your open roles here automatically');
    expect(html).toContain('Not connected');
    expect(html).not.toContain('role="switch"');
  });

  it('names the template edit buttons', () => {
    const html = renderToStaticMarkup(<EmailTemplatesPreview />);
    for (const name of ['Application received', 'Interview invitation', 'Offer letter', 'Not selected']) {
      expect(html).toContain(`aria-label="Edit ${name} (coming soon)"`);
    }
    expect(html).toContain('Example template');
  });

  it('shows roles only in the team card, with a link to the real Team page', () => {
    const html = renderToStaticMarkup(<HiringTeamPreview />);
    for (const role of ['Admin', 'Hiring manager', 'Interviewer', 'Recruiter']) {
      expect(html).toContain(role);
    }
    expect(html).toContain('Example');
    expect(html).toContain('Invite member');
    expect(html).toMatch(/<a [^>]*href="\/account\/team"[^>]*>Team in your account<\/a>/);
    expect(html).toContain('To add people to your workspace today, use ');
    expect(html).toContain('.</p>');
  });

  it('labels each notification switch', () => {
    const html = renderToStaticMarkup(<NotificationsPreview />);
    for (const label of ['Email me on new applications', 'Daily applicant digest', 'Interview reminders']) {
      expect(html).toContain(label);
    }
    expect(html.match(/role="switch"/g)?.length).toBe(3);
    expect(html.match(/<label\b[^>]*\bfor="/g)?.length).toBe(3);
  });
});

describe('settingsGreeting', () => {
  it('names a real workspace', () => {
    expect(settingsGreeting('Kedai Maju Sdn Bhd', false)).toBe('Recruiting preferences for Kedai Maju Sdn Bhd, Saudara.');
  });
  it('leaves the company out when the name is empty, spaces, or missing', () => {
    expect(settingsGreeting('', false)).toBe('Recruiting preferences, Saudara.');
    expect(settingsGreeting('   ', false)).toBe('Recruiting preferences, Saudara.');
    expect(settingsGreeting(null, false)).toBe('Recruiting preferences, Saudara.');
    expect(settingsGreeting(undefined, false)).toBe('Recruiting preferences, Saudara.');
  });
  it('uses the demo name for the demo workspace whatever the stored name is', () => {
    expect(settingsGreeting('Anything', true)).toBe('Recruiting preferences for Rimba Ventures, Saudara.');
  });
  it('trims the name', () => {
    expect(settingsGreeting('  Kedai  ', false)).toBe('Recruiting preferences for Kedai, Saudara.');
  });
});

describe('the screen', () => {
  it('greets a real workspace by name and keeps none of the made-up content', async () => {
    const html = await render();
    expect(html).toContain('Recruiting preferences for Kedai Maju Sdn Bhd, Saudara.');
    expect(html).not.toContain('Save changes');
    for (const gone of ['Rimba', 'JobStreet', 'LinkedIn', 'Hiredly', 'Ahmad Zaki', 'Faiz Hakim', 'Nurul Huda']) {
      expect(html).not.toContain(gone);
    }
    // The old stage count. Checked on the words a person reads: an icon's path data
    // legitimately holds digits such as "3.128".
    const words = html.replace(/<[^>]*>/g, ' ');
    expect(words).not.toContain('128');
    expect(html).not.toMatch(/(?<!Not )\bConnected\b/i);
    expect(html.match(/Coming soon/g)?.length).toBe(5);
    expect(html).toContain('data-application-form');
  });

  it('leaves the company out when the workspace has no name', async () => {
    mocks.getViewer.mockResolvedValue(viewer({ orgName: '   ' }));
    expect(await render()).toContain('Recruiting preferences, Saudara.');
  });

  it('keeps the demo name for a demo visitor', async () => {
    mocks.getViewer.mockResolvedValue(viewer({ isDemo: true }));
    expect(await render()).toContain('Recruiting preferences for Rimba Ventures, Saudara.');
  });

  it('keeps the demo name when the data reader says demo', async () => {
    mocks.loadHire.mockResolvedValue({ model: {}, isDemo: true });
    expect(await render()).toContain('Recruiting preferences for Rimba Ventures, Saudara.');
  });

  it('escapes a workspace name that contains markup', async () => {
    mocks.getViewer.mockResolvedValue(viewer({ orgName: '<b>Kedai</b>' }));
    const html = await render();
    expect(html).toContain('&lt;b&gt;Kedai&lt;/b&gt;');
    expect(html).not.toContain('<b>Kedai');
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
