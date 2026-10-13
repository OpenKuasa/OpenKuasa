import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApplicationsModel, BoardModel } from '@/lib/hire/lists';

/**
 * The controls that change an application, and the two screens that carry
 * them, as the server sends them: rendered to a string and read as markup.
 * What a press does (the confirm dialog, the pending state, a refusal, where
 * focus goes, the menu's keys) needs a browser: see the task report's checklist.
 */

const mocks = vi.hoisted(() => ({
  viewer: { orgId: 'org1', role: 'member', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  applications: null as unknown,
  board: null as unknown,
  action: vi.fn(),
  refresh: vi.fn(),
}));

// The real file is a server module (cookies, the database). Nothing here runs a handler.
vi.mock('@/app/(app)/hire/actions', () => ({
  moveApplicationAction: mocks.action,
  closeApplicationAction: mocks.action,
  reopenApplicationAction: mocks.action,
  rateApplicationAction: mocks.action,
  viewCvAction: mocks.action,
  addCandidateAction: mocks.action,
  getCandidateAction: mocks.action,
  updateCandidateAction: mocks.action,
  deleteApplicationAction: mocks.action,
  deleteCandidateAction: mocks.action,
  getDeletionSummaryAction: mocks.action,
  setPoolStatusAction: mocks.action,
  moveToPipelineAction: mocks.action,
  listPoolPickerAction: mocks.action,
  scheduleInterviewAction: mocks.action,
  recordPastInterviewAction: mocks.action,
  rescheduleInterviewAction: mocks.action,
  cancelInterviewAction: mocks.action,
  setInterviewOutcomeAction: mocks.action,
  reopenInterviewAction: mocks.action,
  getInterviewInvitationAction: mocks.action,
  getInterviewForEditAction: mocks.action,
}));
// No app router is mounted in a string render: the controls only need one to ask for a refresh after a refusal.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: () => {} }), usePathname: () => '/hire/talent-pool' }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => mocks.viewer }));
// The screens' loader reads the session and the database: replaced by the model under test.
vi.mock('@/screens/hire/parts', () => ({
  LOAD_FAILED: <p>load failed</p>,
  Muted: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  FUNNEL_COLOR: {},
  loadHire: async (tag: string) => ({ model: tag === 'applications' ? mocks.applications : mocks.board, isDemo: false }),
}));
// Charts draw nothing that matters here.
vi.mock('@/components/charts', () => ({
  AreaTrend: () => null, BarGroup: () => null, DonutStat: () => null, FunnelFlow: () => null,
}));

import { ApplicationActions, ApplicationMenu, type ApplicationSubject } from '@/screens/hire/application-actions';
import { ApplicationRow, type ApplicationRowData } from '@/screens/hire/application-details';
import ApplicationsScreen from '@/screens/hire/applications';
import CandidatesScreen from '@/screens/hire/candidates';

const ID = '44444444-4444-4444-8444-444444444444';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const subject = (over: Partial<ApplicationSubject> = {}): ApplicationSubject => ({
  id: ID, candidateId: CANDIDATE, name: 'Aina Rahman', job: 'Barista', stage: 'interview', outcome: 'active', rating: null, rejectReason: null,
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
/** Every button's accessible name, in order: its aria-label, or else its text. */
const buttons = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? text(inner));
/** The opening tag of the button with this accessible name. */
const buttonTag = (html: string, name: string) => {
  const tag = [...html.matchAll(/<button\b[^>]*>/g)].map(([t]) => t).find((t) => t.includes(`aria-label="${name}"`));
  if (!tag) throw new Error(`no button named ${name}`);
  return tag;
};
const controls = (over: Partial<ApplicationSubject> = {}, canEdit = true) =>
  renderToStaticMarkup(<ApplicationActions application={subject(over)} canEdit={canEdit} />);
const moves = (html: string) => buttons(html).filter((name) => /^(Move|Back) to /.test(name));
const STARS = [1, 2, 3, 4, 5].map((n) => `Rate ${n} out of 5`);

beforeEach(() => {
  mocks.viewer = { orgId: 'org1', role: 'member', isDemo: false };
  mocks.action.mockReset();
  mocks.refresh.mockReset();
});

describe('the controls for one application', () => {
  it('offers, at interview: back one stage, every later stage, reject, withdraw and five ratings', () => {
    const html = controls();
    expect(buttons(html)).toEqual([
      'Back to Screening', 'Move to Offer', 'Move to Hired', 'Mark withdrawn', 'Reject', ...STARS,
      'Schedule interview', 'Record a past interview', 'Edit candidate', 'Add to talent pool', 'Delete application', 'Delete candidate',
    ]);
    // The stage it is at, in words.
    expect(text(html)).toContain('Stage: Interview');
  });

  it('has no Back button at the first stage', () => {
    expect(moves(controls({ stage: 'applied' }))).toEqual(['Move to Screening', 'Move to Interview', 'Move to Offer', 'Move to Hired']);
  });

  it('offers only Back to Offer among moves once hired', () => {
    const html = controls({ stage: 'hired' });
    expect(moves(html)).toEqual(['Back to Offer']);
    expect(buttons(html)).toEqual(expect.arrayContaining(['Reject', 'Mark withdrawn']));
  });

  it('says a rejected application is rejected and why, and offers Reopen and no moves', () => {
    const html = controls({ stage: 'screening', outcome: 'rejected', rejectReason: 'experience' });
    expect(text(html)).toContain('Rejected');
    expect(text(html)).toContain('Not enough experience');
    expect(moves(html)).toEqual([]);
    expect(buttons(html)).toEqual([
      'Reopen', ...STARS, 'Record a past interview', 'Edit candidate', 'Add to talent pool', 'Delete application', 'Delete candidate',
    ]);
    // Planning an interview needs an active application. Recording one that already took place does not.
    expect(buttons(html)).not.toContain('Schedule interview');
    expect(buttons(html)).not.toContain('Reject');
    expect(buttons(html)).not.toContain('Mark withdrawn');
  });

  it('says a withdrawn application is withdrawn, not rejected', () => {
    const html = controls({ outcome: 'withdrawn', rejectReason: 'salary' });
    expect(text(html)).toContain('Withdrawn');
    expect(text(html)).toContain('Salary expectations');
    expect(text(html)).not.toContain('Rejected');
    expect(buttons(html)).toContain('Reopen');
  });

  it('says so when a closed application has no reason', () => {
    expect(text(controls({ outcome: 'rejected' }))).toContain('No reason given');
  });

  it('renders nothing at all for someone who may not edit', () => {
    for (const over of [{}, { outcome: 'rejected' as const }, { rating: 4 }]) {
      expect(controls(over, false)).toBe('');
    }
  });

  it('writes the rating in words, marks the current star as pressed and offers to clear it', () => {
    const html = controls({ rating: 4 });
    expect(text(html)).toContain('Rated 4 out of 5');
    expect(text(html)).not.toContain('Not rated');
    for (const n of [1, 2, 3, 4, 5]) {
      expect(buttonTag(html, `Rate ${n} out of 5`)).toContain(`aria-pressed="${n === 4}"`);
    }
    expect(buttons(html)).toContain('Clear rating');
  });

  it('says Not rated, presses no star and offers nothing to clear when there is no rating', () => {
    const html = controls({ rating: null });
    expect(text(html)).toContain('Not rated');
    expect(html).not.toContain('aria-pressed="true"');
    expect(buttons(html)).not.toContain('Clear rating');
  });

  it('gives every button a 44 pixel target and a visible focus ring, and is a named group', () => {
    const html = controls({ rating: 3 });
    const tags = [...html.matchAll(/<button\b[^>]*>/g)].map(([t]) => t);
    expect(tags.length).toBeGreaterThan(8);
    for (const tag of tags) {
      expect(tag).toContain('type="button"');
      expect(tag).toContain('min-h-11');
      expect(tag).toContain('min-w-11');
      expect(tag).toMatch(/focus-visible:ring-/);
      // Idle: nothing is marked unavailable, and nothing uses the disabled attribute.
      expect(tag).not.toMatch(/\sdisabled=|\saria-disabled=/);
    }
    expect(html).toMatch(/role="group"[^>]*aria-label="Change Aina Rahman’s application for Barista"|aria-label="Change Aina Rahman’s application for Barista"[^>]*role="group"/);
    // No failure is shown before anything has been tried.
    expect(html).not.toContain('role="alert"');
  });

  it('uses the danger colour for Reject and the two deletes only, and no purple or violet', () => {
    const html = controls();
    const DANGER = ['Reject', 'Delete application', 'Delete candidate'];
    const all = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    for (const name of DANGER) {
      expect(all.find(([, , inner]) => text(inner) === name)?.[1], name).toContain('text-destructive');
    }
    for (const [, attrs, inner] of all.filter(([, , inner]) => !DANGER.includes(text(inner)))) {
      expect(attrs, text(inner)).not.toMatch(/(^|[\s"])text-destructive/);
    }
    expect(html).not.toMatch(/purple|violet|chart-5|#[0-9a-f]{3,8}\b/i);
  });

  it('sends nothing to the server just by being drawn', () => {
    controls();
    controls({ outcome: 'rejected' });
    expect(mocks.action).not.toHaveBeenCalled();
    // A refresh is for a refusal only: never for a render.
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('states the stage or the outcome in one polite live region, and announces nothing twice', () => {
    const live = (html: string) => [...html.matchAll(/<p\b[^>]*aria-live="polite"[^>]*>([\s\S]*?)<\/p>/g)].map(([, inner]) => text(inner));
    // The same element in both states, so a rejection or a reopen changes its text instead of replacing it.
    // The third is where "Changes saved." is said after the candidate was edited: empty until then.
    expect(live(controls())).toEqual(['Stage: Interview', 'Not rated', '']);
    expect(live(controls({ stage: 'screening', outcome: 'rejected', rejectReason: 'experience', rating: 2 })))
      .toEqual(['Rejected · Not enough experience', 'Rated 2 out of 5', '']);
    expect(live(controls({ outcome: 'withdrawn' }))).toEqual(['Withdrawn · No reason given', 'Not rated', '']);
    for (const html of [controls(), controls({ outcome: 'rejected' })]) {
      expect(html.match(/aria-live=/g)).toHaveLength(3);
      expect(html).not.toContain('aria-live="assertive"');
    }
  });
});

describe('the menu on a board card', () => {
  const menu = (canEdit: boolean) =>
    renderToStaticMarkup(<ApplicationMenu application={subject({ rating: 2 })} canEdit={canEdit} />);

  it('is one button named after the candidate, which says it opens a menu', () => {
    const html = menu(true);
    expect(buttons(html)).toEqual(['Actions for Aina Rahman']);
    const tag = buttonTag(html, 'Actions for Aina Rahman');
    expect(tag).toContain('aria-haspopup="menu"');
    expect(tag).toContain('aria-expanded="false"');
    expect(tag).toContain('min-h-11');
    expect(tag).toContain('min-w-11');
    expect(tag).toMatch(/focus-visible:ring-/);
    expect(html).not.toContain('role="alert"');
  });

  it('is not there for someone who may not edit', () => {
    expect(menu(false)).toBe('');
  });
});

describe('a row of the Applications list', () => {
  const row = (over: Partial<ApplicationRowData> = {}): ApplicationRowData => ({
    id: ID, candidateId: CANDIDATE, name: 'Aina Rahman', job: 'Barista', source: 'LinkedIn', status: 'Shortlisted', statusClass: 'pill', live: true,
    applied: '08 Oct 2026', details: null, stage: 'interview', outcome: 'active', rating: null, rejectReason: null,
    ...over,
  });
  const render = (data: ApplicationRowData, canEdit: boolean) =>
    renderToStaticMarkup(<table><tbody><ApplicationRow row={data} canEdit={canEdit} /></tbody></table>);
  const DETAILS = { coverLetter: 'Dear team', cv: null, hasCvFile: false, portfolio: null, expectedSalary: null };

  it('has a Details button and the controls even when the applicant gave no form details', () => {
    const html = render(row(), true);
    const tag = buttonTag(html, 'Details for Aina Rahman');
    expect(tag).toContain('aria-expanded="false"');
    const panel = /aria-controls="([^"]+)"/.exec(tag)?.[1];
    expect(panel).toBeTruthy();
    // The panel the button controls holds the controls, and starts closed.
    const panelRow = new RegExp(`<tr[^>]*id="${panel}"[^>]*>(.*?)</tr>`, 's').exec(html);
    expect(panelRow?.[0]).toMatch(/<tr[^>]*\shidden=""/);
    expect(buttons(panelRow![1])).toEqual(expect.arrayContaining(['Back to Screening', 'Move to Offer', 'Reject', 'Mark withdrawn']));
  });

  it('shows the form details first, then the controls', () => {
    const html = render(row({ details: DETAILS }), true);
    expect(html.indexOf('Dear team')).toBeGreaterThan(-1);
    expect(html.indexOf('Dear team')).toBeLessThan(html.indexOf('Move to Offer'));
  });

  it('is as before for a viewer: the details and no controls, and no button where there is nothing to open', () => {
    const withDetails = render(row({ details: DETAILS }), false);
    expect(buttons(withDetails)).toEqual(['Details for Aina Rahman']);
    expect(withDetails).toContain('Dear team');
    const without = render(row(), false);
    expect(buttons(without)).toEqual([]);
    expect(without).not.toContain('aria-controls');
  });

  it('keeps the status pill as the server gave it', () => {
    expect(render(row({ status: 'Rejected', outcome: 'withdrawn' }), true)).toMatch(/<span class="[^"]*\bpill\b[^"]*">Rejected<\/span>/);
  });
});

describe('the two screens', () => {
  const PATH = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.pdf';
  const applications: ApplicationsModel = {
    isEmpty: false, total: 2,
    rows: [
      { id: ID, candidateId: CANDIDATE, name: 'Aina Rahman', job: 'Barista', source: 'LinkedIn', status: 'Shortlisted', applied: '08 Oct 2026', details: null, interviews: [], stage: 'interview', outcome: 'active', rating: 4, rejectReason: null },
      { id: '55555555-5555-4555-8555-555555555555', candidateId: '66666666-6666-4666-8666-666666666666', name: 'Ben Tan', job: 'Cashier', source: 'Referral', status: 'Rejected', applied: '07 Oct 2026', details: null, interviews: [], stage: 'applied', outcome: 'rejected', rating: null, rejectReason: 'role_filled' },
    ],
    statusMix: [{ key: 'New', value: 0 }, { key: 'In review', value: 0 }, { key: 'Shortlisted', value: 1 }, { key: 'Rejected', value: 1 }],
    byJob: [],
  };
  const card = { id: ID, candidateId: CANDIDATE, name: 'Aina Rahman', role: 'Barista', source: 'LinkedIn', lastTouch: '2d ago', active: true, stage: 'interview' as const, outcome: 'active' as const, rating: 4, rejectReason: null };
  const board: BoardModel = {
    isEmpty: false, total: 1, hired: 0, inPipeline: 1, interviewing: 1, offers: 0, trend: [], funnel: [], jobs: [{ id: '22222222-2222-4222-8222-222222222222', title: 'Barista' }],
    stages: (['applied', 'screening', 'interview', 'offer', 'hired'] as const).map((key) => ({
      key, name: key, count: key === 'interview' ? 1 : 0, candidates: key === 'interview' ? [card] : [],
    })),
  };
  const VIEWERS = {
    member: { orgId: 'org1', role: 'member', isDemo: false },
    viewer: { orgId: 'org1', role: 'viewer', isDemo: false },
    'demo owner': { orgId: 'org1', role: 'owner', isDemo: true },
  };

  beforeEach(() => {
    mocks.applications = applications;
    mocks.board = board;
  });

  it('Applications: someone who may edit gets a Details button and the controls on every row', async () => {
    const html = renderToStaticMarkup(await ApplicationsScreen());
    const names = buttons(html);
    expect(names).toEqual(expect.arrayContaining(['Details for Aina Rahman', 'Details for Ben Tan', 'Move to Offer', 'Reject', 'Reopen']));
    expect(text(html)).toContain('Rated 4 out of 5');
    expect(text(html)).toContain('Role filled');
  });

  it('Applications: a viewer and the demo workspace get the read-only screen', async () => {
    for (const who of ['viewer', 'demo owner'] as const) {
      mocks.viewer = VIEWERS[who];
      const html = renderToStaticMarkup(await ApplicationsScreen());
      expect(buttons(html)).toEqual([]);
      expect(html).toContain('Aina Rahman');
    }
  });

  it('Candidates: each card has a menu button named after its candidate for someone who may edit', async () => {
    const html = renderToStaticMarkup(await CandidatesScreen());
    expect(buttons(html)).toContain('Actions for Aina Rahman');
    // The rating is written, not only drawn.
    expect(html).toContain('Rated 4 out of 5');
  });

  it('Candidates: every column has a heading that script can focus, where focus goes when a card leaves the board', async () => {
    const html = renderToStaticMarkup(await CandidatesScreen());
    for (const key of ['applied', 'screening', 'interview', 'offer', 'hired']) {
      const tag = [...html.matchAll(/<h3\b[^>]*>/g)].map(([t]) => t).find((t) => t.includes(`id="hire-stage-${key}"`));
      expect(tag, key).toBeDefined();
      // Not a tab stop: reached by script only.
      expect(tag).toContain('tabindex="-1"');
      expect(tag).toMatch(/focus-visible:ring-/);
    }
  });

  it('Candidates: a viewer and the demo workspace get no menu button', async () => {
    for (const who of ['viewer', 'demo owner'] as const) {
      mocks.viewer = VIEWERS[who];
      const html = renderToStaticMarkup(await CandidatesScreen());
      expect(buttons(html).filter((name) => name.startsWith('Actions for'))).toEqual([]);
      expect(html).toContain('Aina Rahman');
    }
  });

  it('neither screen puts a storage path, an email or a phone number in its markup', async () => {
    // A model can only carry what its type allows; this guards the markup against a later slip.
    for (const html of [renderToStaticMarkup(await ApplicationsScreen()), renderToStaticMarkup(await CandidatesScreen())]) {
      expect(html).not.toContain(PATH);
      expect(html).not.toMatch(/cv_path|[\w.]+@[\w-]+\.\w+|\+?60\d{8,}/);
    }
  });
});
