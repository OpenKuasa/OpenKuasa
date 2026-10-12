// tests/hire-interview-screen.test.tsx
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InterviewRow, InterviewsModel, PickerApplication } from '@/lib/hire/lists';

/**
 * The Interviews screen, the row menu, the form and the invitation step, and
 * where interviews are offered on the board and in the Applications panel, as
 * the server sends them: rendered to a string and read as markup. There is no
 * DOM here (node, no jsdom, no testing library), so nothing can be pressed,
 * typed, focused or closed: what each control decides is in plain functions
 * (tests/hire-interview-dialog.test.ts). What still needs a browser is in the
 * plan's smoke checklist.
 */

const mocks = vi.hoisted(() => ({
  viewer: { orgId: 'org1', orgName: 'Rimba Ventures', role: 'member', isDemo: false } as { orgId: string; orgName: string; role: string; isDemo: boolean },
  interviews: null as unknown,
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: () => {} }), usePathname: () => '/hire/interviews' }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => mocks.viewer }));
vi.mock('@/screens/hire/parts', () => ({
  LOAD_FAILED: <p>load failed</p>,
  Muted: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  FUNNEL_COLOR: {},
  topSlices: () => [],
  loadHire: async (tag: string) => ({
    model: tag === 'interviews' ? mocks.interviews : tag === 'applications' ? mocks.applications : mocks.board,
    isDemo: false,
  }),
}));
vi.mock('@/components/charts', () => ({
  AreaTrend: () => null, BarGroup: () => null, DonutStat: () => null, FunnelFlow: () => null,
}));
// A closed menu draws nothing but its button. Here its items are drawn in place, so what the menu offers can be read.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Item = ({ children, variant }: { children?: ReactNode; variant?: string }) => (
    <div role="menuitem" data-variant={variant ?? 'default'}>{children}</div>
  );
  return {
    DropdownMenu: Pass, DropdownMenuTrigger: Pass, DropdownMenuContent: Pass, DropdownMenuLabel: Pass,
    DropdownMenuRadioGroup: Pass, DropdownMenuSeparator: () => <hr />, DropdownMenuItem: Item, DropdownMenuRadioItem: Item,
  };
});

import { ApplicationActions, ApplicationMenu, type ApplicationSubject } from '@/screens/hire/application-actions';
import { ApplicationRow, type ApplicationRowData } from '@/screens/hire/application-details';
import { InterviewHeaderButtons, InterviewRowMenu } from '@/screens/hire/interview-actions';
import { InterviewDialogHost, InterviewFormView, InvitationStep, type InterviewFormViewProps } from '@/screens/hire/interview-dialog';
import InterviewsScreen from '@/screens/hire/interviews';
import { DELETION_NOTICE_ID } from '@/lib/hire/delete-dialog-state';
import { emptyValues, openerId, valuesFrom } from '@/lib/hire/interview-dialog-state';

const APP = '44444444-4444-4444-8444-444444444444';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const IV = '77777777-7777-4777-8777-777777777777';

const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const buttons = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? text(inner));
/** The opening tag of the button with this accessible name. */
const buttonTag = (html: string, name: string) => {
  const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(([, attrs, inner]) => (/aria-label="([^"]*)"/.exec(attrs)?.[1] ?? text(inner)) === name);
  if (!found) throw new Error(`no button named ${name}`);
  return `<button${found[1]}>`;
};
const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map(([tag]) => tag);
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1];
/** The text of every label, in order, with the id of the control it is for. */
const labels = (html: string) =>
  [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)].map(([, attrs, inner]) => ({ for: attr(`<label${attrs}>`, 'for'), text: text(inner) }));
/** The control (input, select or textarea) a label with this text is for. */
const control = (html: string, label: string) => {
  const id = labels(html).find((l) => l.text === label)?.for;
  if (!id) throw new Error(`no label ${label}`);
  const tag = [...tags(html, 'input'), ...tags(html, 'select'), ...tags(html, 'textarea')].find((t) => attr(t, 'id') === id);
  if (!tag) throw new Error(`the label ${label} is for nothing`);
  return tag;
};
/** The text of the element with this id. */
const byId = (html: string, id: string) => {
  const found = new RegExp(`<(\\w+)\\b[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return found ? text(found[2]) : null;
};
const options = (html: string, selectId: string) => {
  const select = new RegExp(`<select\\b[^>]*\\sid="${selectId}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '';
  return [...select.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g)].map(([, inner]) => text(inner));
};
const items = (html: string) =>
  [...html.matchAll(/<div role="menuitem" data-variant="([^"]*)">([\s\S]*?)<\/div>/g)].map(([, variant, inner]) => ({ variant, label: text(inner) }));
// The attribute, not the `disabled:` classes every button carries.
const DISABLED = /\sdisabled(=|\s|>)/;

const row = (over: Partial<InterviewRow> = {}): InterviewRow => ({
  id: IV, name: 'Aina Rahman', role: 'Sales Executive', date: '20 Oct 2026', time: '3:00 pm', interviewer: 'Farah Lim', type: 'Video', status: 'Scheduled',
  applicationId: APP, statusKey: 'scheduled', scheduledAt: '2026-10-20T07:00:00+00:00', durationMinutes: 60, length: '1 hour', kind: 'video',
  place: 'https://meet.example.com/abc', placeLink: { href: 'https://meet.example.com/abc', host: 'meet.example.com' },
  interviewerName: 'Farah Lim', notes: null, createdAt: '2026-10-12T02:00:00+00:00', updatedAt: '2026-10-12T02:05:00+00:00',
  applicationStage: 'screening', applicationOutcome: 'active', needsOutcome: false, ...over,
});
const AHEAD = row();
const OVERDUE = row({
  id: 'iv-overdue', name: 'Ben Tan', role: 'Cashier', date: '10 Oct 2026', time: '9:30 am', length: '1 hour 30 minutes', durationMinutes: 90, type: 'Onsite',
  kind: 'onsite', scheduledAt: '2026-10-10T01:30:00+00:00', place: 'Level 3, Menara Rimba', placeLink: null, needsOutcome: true,
});
const CLOSED_APPLICATION = row({
  id: 'iv-rejected', name: 'Mei Ling Tan', role: 'Driver', date: '21 Oct 2026', applicationOutcome: 'rejected',
  // Not a link the app will draw: `safeLink` answered null for it on the server.
  place: 'javascript:alert(1)', placeLink: null,
});
const DONE_ROW = row({
  id: 'iv-done', name: 'Farid bin Osman', role: 'Barista', date: '06 Oct 2026', status: 'Completed', statusKey: 'completed', place: null, placeLink: null,
  interviewer: '—', interviewerName: null,
});
const APPS: PickerApplication[] = [
  { id: APP, name: 'Aina Rahman', job: 'Sales Executive', stage: 'screening', outcome: 'active' },
  { id: 'app-2', name: 'Ben Tan', job: 'Cashier', stage: 'applied', outcome: 'active' },
  { id: 'app-3', name: 'Farid bin Osman', job: 'Barista', stage: 'interview', outcome: 'rejected' },
];
const model = (over: Partial<InterviewsModel> = {}): InterviewsModel => ({
  isEmpty: false,
  rows: [OVERDUE, AHEAD, CLOSED_APPLICATION, DONE_ROW],
  upcoming: [AHEAD, CLOSED_APPLICATION],
  scheduled: 3, ahead: 2, completed: 1, noShow: 0, next7Days: 0, weekLoad: [],
  applications: APPS, applicationsCut: false, today: '2026-10-12',
  ...over,
});
const VIEWERS = [
  { orgId: 'org1', orgName: 'Rimba Ventures', role: 'viewer', isDemo: false },
  { orgId: 'org1', orgName: 'Rimba Ventures', role: 'owner', isDemo: true },
];
const screen = async () => renderToStaticMarkup(await InterviewsScreen());

beforeEach(() => {
  mocks.viewer = { orgId: 'org1', orgName: 'Rimba Ventures', role: 'member', isDemo: false };
  mocks.interviews = model();
  mocks.action.mockReset();
  mocks.refresh.mockReset();
});

describe('the Interviews screen\'s header', () => {
  it('has two real buttons for someone who may edit: Record a past interview in the outline style, then Schedule interview', async () => {
    const html = await screen();
    const names = buttons(html);
    expect(names).toEqual(expect.arrayContaining(['Record a past interview', 'Schedule interview']));
    expect(names.indexOf('Record a past interview')).toBeLessThan(names.indexOf('Schedule interview'));
    for (const name of ['Record a past interview', 'Schedule interview']) {
      const tag = buttonTag(html, name);
      expect(tag, name).toContain('type="button"');
      expect(tag, name).toContain('min-h-11');
      expect(tag, name).toMatch(/focus-visible:ring-/);
      expect(tag, name).not.toMatch(DISABLED);
    }
    expect(buttonTag(html, 'Record a past interview')).toContain('data-variant="outline"');
    expect(buttonTag(html, 'Schedule interview')).toContain(`id="${openerId('header-schedule')}"`);
    expect(buttonTag(html, 'Record a past interview')).toContain(`id="${openerId('header-past')}"`);
    // The placeholder has gone, with its capital I.
    expect(html).not.toContain('Coming soon');
    expect(html).not.toContain('Schedule Interview');
    expect(buttons(renderToStaticMarkup(<InterviewHeaderButtons />))).toEqual(['Record a past interview', 'Schedule interview']);
  });
  it('has no button for a viewer or the demo workspace, and none when the screen could not be loaded', async () => {
    for (const viewer of VIEWERS) {
      mocks.viewer = viewer;
      const html = await screen();
      expect(buttons(html)).toEqual([]);
      expect(text(html)).toContain('Aina Rahman');
    }
    mocks.viewer = { orgId: 'org1', orgName: 'Rimba Ventures', role: 'owner', isDemo: false };
    mocks.interviews = null;
    const failed = await screen();
    // No list of applications to pick from: no form can open.
    expect(buttons(failed)).toEqual([]);
    expect(text(failed)).toContain('load failed');
  });
  it('carries the notice line for someone who may edit, and not for a viewer', async () => {
    expect(await screen()).toContain(`id="${DELETION_NOTICE_ID}"`);
    mocks.viewer = VIEWERS[0];
    expect(await screen()).not.toContain(DELETION_NOTICE_ID);
  });
});

describe('the Interviews screen\'s lists', () => {
  it('Upcoming interviews is what the model says is still ahead, not every scheduled row', async () => {
    const html = await screen();
    const upcoming = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(([, inner]) => text(inner));
    expect(upcoming).toHaveLength(2);
    expect(upcoming[0]).toContain('Aina Rahman');
    expect(upcoming[1]).toContain('Mei Ling Tan');
    // Ben Tan's interview is scheduled but its time has passed: it is in the table, tagged, and not here.
    expect(upcoming.join(' ')).not.toContain('Ben Tan');
    // The card's count is of the same thing as its list: three are scheduled, two of them still ahead.
    expect(text(await screen())).toContain('Upcoming interviews 2 upcoming');
    expect(text(await screen())).not.toMatch(/Upcoming interviews \d+ scheduled/);
    // One scheduled interview whose time has passed: nothing is upcoming, and the card does not say "1 scheduled" over an empty list.
    mocks.interviews = model({ rows: [OVERDUE], upcoming: [], scheduled: 1, ahead: 0 });
    const none = text(await screen());
    expect(none).toContain('Upcoming interviews 0 upcoming');
    expect(none).toContain('No upcoming interviews');
    expect(none).not.toContain('No interviews scheduled');
    // More ahead than the list shows.
    mocks.interviews = model({ ahead: 60 });
    expect(text(await screen())).toContain('60 upcoming, showing the first 2');
  });
  it('the table has the two new columns, Where and Actions', async () => {
    const html = await screen();
    const heads = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(([, inner]) => text(inner));
    expect(heads).toEqual(['Candidate', 'Role', 'Date', 'Time', 'Interviewer', 'Type', 'Where', 'Status', 'Actions']);
    expect(html.match(/<tr\b/g)).toHaveLength(5);
  });
  it('writes the time with the length', async () => {
    const said = text(await screen());
    // Changed from the plan's 24-hour `15:00`: a row's time now reads as the invitation's does (Task 2's review).
    expect(said).toContain('3:00 pm · 1 hour');
    expect(said).toContain('9:30 am · 1 hour 30 minutes');
    expect(said).not.toMatch(/\b15:00\b|\b09:30\b/);
  });
  it('draws a place as a link only from the link the server made safe, and otherwise as text or a dash', async () => {
    const html = await screen();
    const links = tags(html, 'a');
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('href="https://meet.example.com/abc"');
    expect(links[0]).toContain('target="_blank"');
    expect(links[0]).toContain('rel="noopener noreferrer"');
    expect(links[0]).toContain('min-h-11');
    expect(text(html)).toContain('meet.example.com');
    // Text, as typed: an address, and something that is not a link the app will follow.
    expect(text(html)).toContain('Level 3, Menara Rimba');
    expect(text(html)).toContain('javascript:alert(1)');
    expect(html).not.toMatch(/href="javascript:/i);
  });
  it('tags a scheduled row that needs an outcome, and one whose application is closed, in words', async () => {
    const html = await screen();
    const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(([, inner]) => text(inner));
    expect(rows.find((r) => r.includes('Ben Tan'))).toContain('Needs an outcome');
    expect(rows.find((r) => r.includes('Mei Ling Tan'))).toContain('Application rejected');
    expect(rows.find((r) => r.includes('Aina Rahman'))).not.toMatch(/Needs an outcome|Application rejected|Application withdrawn/);
    expect(rows.find((r) => r.includes('Farid bin Osman'))).not.toMatch(/Needs an outcome|Application rejected/);
  });
  it('gives every row a menu button named after the interview, for someone who may edit', async () => {
    const html = await screen();
    for (const name of ['Aina Rahman', 'Ben Tan', 'Mei Ling Tan', 'Farid bin Osman']) {
      const tag = buttonTag(html, `Actions for the interview with ${name}`);
      expect(tag, name).toContain('min-h-11');
      expect(tag, name).toContain('min-w-11');
      expect(tag, name).toMatch(/focus-visible:ring-/);
    }
    expect(buttonTag(html, 'Actions for the interview with Aina Rahman')).toContain(`id="${openerId('row', IV)}"`);
  });
  it('a viewer and the demo workspace see every row and an empty Actions cell', async () => {
    for (const viewer of VIEWERS) {
      mocks.viewer = viewer;
      const html = await screen();
      expect(text(html)).toContain('Farid bin Osman');
      expect(html).not.toMatch(/Actions for the interview|Reschedule or edit|Cancel interview|Mark as scheduled again/);
      // The place is for reading: a viewer gets the link too.
      expect(tags(html, 'a')).toHaveLength(1);
    }
  });
  it('sends nothing to the server just by being drawn, and carries no contact detail and nothing purple or violet', async () => {
    const html = await screen();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(html).not.toMatch(/[\w.]+@[\w-]+\.\w+|\+?60\d{8,}/);
    expect(html).not.toMatch(/purple|violet|chart-5/i);
  });
});

describe('a row\'s menu', () => {
  const menu = (r: InterviewRow) => renderToStaticMarkup(<InterviewRowMenu row={r} />);
  it('a scheduled interview: change, invitation, a rule, the two outcomes, a rule, and Cancel interview last in the danger style', () => {
    const html = menu(AHEAD);
    expect(items(html)).toEqual([
      { variant: 'default', label: 'Reschedule or edit' },
      { variant: 'default', label: 'Invitation and calendar file' },
      { variant: 'default', label: 'Mark completed' },
      { variant: 'default', label: 'Mark no-show' },
      { variant: 'destructive', label: 'Cancel interview' },
    ]);
    expect(html.match(/<hr\/>/g)).toHaveLength(2);
    expect(html.indexOf('Invitation and calendar file')).toBeLessThan(html.indexOf('<hr/>'));
    expect(html.lastIndexOf('<hr/>')).toBeLessThan(html.indexOf('Cancel interview'));
    expect(html.lastIndexOf('<hr/>')).toBeGreaterThan(html.indexOf('Mark no-show'));
  });
  it('a scheduled interview of a rejected or withdrawn application: no Reschedule or edit, which would be refused', () => {
    for (const applicationOutcome of ['rejected', 'withdrawn'] as const) {
      const labelsOf = items(menu(row({ applicationOutcome }))).map((i) => i.label);
      expect(labelsOf, applicationOutcome).toEqual(['Invitation and calendar file', 'Mark completed', 'Mark no-show', 'Cancel interview']);
    }
  });
  it('a cancelled, completed or no-show interview: Mark as scheduled again, alone', () => {
    for (const statusKey of ['cancelled', 'completed', 'no_show'] as const) {
      const html = menu(row({ statusKey }));
      expect(items(html), statusKey).toEqual([{ variant: 'default', label: 'Mark as scheduled again' }]);
      expect(html).not.toContain('<hr/>');
    }
  });
  it('has one polite line for "Saving…", empty and hidden until then, and no refusal before anything is tried', () => {
    const html = menu(AHEAD);
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/purple|violet/i);
    expect(mocks.action).not.toHaveBeenCalled();
  });
});

describe('the form\'s inner content', () => {
  const noop = () => {};
  const view = (over: Partial<InterviewFormViewProps> = {}) =>
    renderToStaticMarkup(
      <InterviewFormView
        base="f" mode="schedule" fixed={null} picker={{ applications: APPS, cut: false }} query="" values={emptyValues()} problems={{}} refusal={null}
        unchanged={false} pending={false} today="2026-10-12" storedDuration={null} onQuery={noop} onChange={noop} onSubmit={noop} onCancel={noop}
        {...over}
      />,
    );

  it('picking (from the header): a search field, then a native select of the active applications, then the fields', () => {
    const html = view();
    expect(labels(html).map((l) => l.text)).toEqual([
      'Find an application', 'Application', 'Date', 'Time', 'Duration', 'Type', 'Meeting link', 'Interviewer', 'Notes',
    ]);
    // Every label is for a control that is in the form.
    for (const { text: label } of labels(html)) expect(control(html, label), label).toBeTruthy();
    expect(attr(control(html, 'Find an application'), 'type')).toBe('search');
    expect(byId(html, attr(control(html, 'Find an application'), 'aria-describedby')!)).toBe('Type a name or a job.');
    expect(options(html, 'f-application_id')).toEqual([
      'Choose an application', 'Aina Rahman — Sales Executive (Screening)', 'Ben Tan — Cashier (Applied)',
    ]);
    expect(buttons(html)).toEqual(['Cancel', 'Schedule interview']);
    expect(html).not.toContain('role="alert"');
    expect(text(html)).not.toContain('What happened');
  });
  it('uses the browser\'s own date and time fields, with today in Kuala Lumpur as the earliest day', () => {
    const html = view();
    const date = control(html, 'Date');
    expect(attr(date, 'type')).toBe('date');
    expect(attr(date, 'min')).toBe('2026-10-12');
    expect(attr(date, 'max')).toBeUndefined();
    expect(date).toContain('h-11');
    expect(attr(date, 'aria-describedby')).toBe('f-date-help');
    expect(byId(html, 'f-date-help')).toBe('In Kuala Lumpur.');
    const time = control(html, 'Time');
    expect(attr(time, 'type')).toBe('time');
    expect(byId(html, 'f-time-help')).toBe('Kuala Lumpur time (GMT+8).');
  });
  it('offers the eight lengths with an hour chosen, the three types, and says which fields are optional', () => {
    const html = view();
    expect(options(html, 'f-duration_minutes')).toEqual([
      '15 minutes', '30 minutes', '45 minutes', '1 hour', '1 hour 30 minutes', '2 hours', '3 hours', '4 hours',
    ]);
    expect(html).toMatch(/<option[^>]*value="60"[^>]*selected=""[^>]*>1 hour<\/option>|<option[^>]*selected=""[^>]*value="60"[^>]*>1 hour<\/option>/);
    expect(options(html, 'f-kind')).toEqual(['Video call', 'In person', 'Phone call']);
    expect(byId(html, 'f-place-help')).toBe('Optional. Shown in the invitation.');
    expect(byId(html, 'f-interviewer_name-help')).toBe('Optional. A name, as you want the candidate to read it.');
    expect(byId(html, 'f-notes-help')).toBe('Optional. For your team only: never in the invitation.');
    expect(control(html, 'Notes')).toMatch(/^<textarea/);
  });
  it('names the place field after the type', () => {
    expect(labels(view({ values: { ...emptyValues(), kind: 'onsite' } })).map((l) => l.text)).toContain('Place');
    expect(labels(view({ values: { ...emptyValues(), kind: 'phone' } })).map((l) => l.text)).toContain('Phone number or details');
  });
  it('says what the picker cannot show', () => {
    expect(text(view({ query: 'nobody' }))).toContain('No active application matches.');
    expect(options(view({ query: 'nobody' }), 'f-application_id')).toEqual(['Choose an application']);
    expect(text(view({ picker: { applications: [APPS[2]], cut: false } }))).toContain('There are no active applications to schedule for.');
    expect(text(view({ picker: { applications: APPS, cut: true } })))
      .toContain('Only the newest 1,000 applications are listed here. If the one you want is missing, schedule from its row on the Applications screen.');
    const many = Array.from({ length: 201 }, (_, i) => ({ id: `a${i}`, name: `Person ${i}`, job: 'Barista', stage: 'applied' as const, outcome: 'active' as const }));
    const crowded = view({ picker: { applications: many, cut: false } });
    expect(options(crowded, 'f-application_id')).toHaveLength(201);
    expect(text(crowded)).toContain('Showing the first 200. Type more of the name.');
  });
  it('a fixed application (from a card or a panel): shown as text, with no search field and no select for it', () => {
    const html = view({ fixed: { name: 'Aina Rahman', job: 'Sales Executive' } });
    expect(labels(html).map((l) => l.text)).toEqual(['Date', 'Time', 'Duration', 'Type', 'Meeting link', 'Interviewer', 'Notes']);
    expect(text(html)).toContain('Application Aina Rahman — Sales Executive');
    expect(html).not.toContain('f-find');
    expect(html).not.toContain('id="f-application_id"');
  });
  it('changing: every field starts at what is stored, a stored length outside the eight is offered, and the button saves', () => {
    const stored = row({ durationMinutes: 75, length: '1 hour 15 minutes', kind: 'onsite', place: 'Level 3, Menara Rimba', placeLink: null, notes: 'Second round.' });
    const html = view({ mode: 'change', fixed: { name: 'Aina Rahman', job: 'Sales Executive' }, values: valuesFrom(stored), storedDuration: 75 });
    expect(attr(control(html, 'Date'), 'value')).toBe('2026-10-20');
    expect(attr(control(html, 'Time'), 'value')).toBe('15:00');
    expect(options(html, 'f-duration_minutes')).toContain('1 hour 15 minutes');
    expect(attr(control(html, 'Place'), 'value')).toBe('Level 3, Menara Rimba');
    expect(attr(control(html, 'Interviewer'), 'value')).toBe('Farah Lim');
    expect(html).toMatch(/<textarea[^>]*id="f-notes"[^>]*>Second round\.<\/textarea>/);
    expect(buttons(html)).toEqual(['Cancel', 'Save changes']);
    expect(text(view({ mode: 'change', fixed: { name: 'Aina Rahman', job: 'Sales Executive' }, values: valuesFrom(stored), unchanged: true })))
      .toContain('Nothing has been changed yet.');
    expect(text(html)).not.toContain('Nothing has been changed yet.');
  });
  it('a field error: at its field, as an alert, tied to the control, which is marked wrong', () => {
    const html = view({ problems: { date: 'Choose a date.', application_id: 'Choose an application.' } });
    const date = control(html, 'Date');
    expect(attr(date, 'aria-invalid')).toBe('true');
    expect(attr(date, 'aria-describedby')).toBe('f-date-error f-date-help');
    expect(html).toMatch(/<p[^>]*id="f-date-error"[^>]*role="alert"[^>]*>Choose a date\.<\/p>|<p[^>]*role="alert"[^>]*id="f-date-error"[^>]*>Choose a date\.<\/p>/);
    expect(attr(control(html, 'Application'), 'aria-invalid')).toBe('true');
    expect(byId(html, 'f-application_id-error')).toBe('Choose an application.');
    // The fields that are right are not marked.
    expect(attr(control(html, 'Time'), 'aria-invalid')).toBeUndefined();
    expect(html).not.toContain('id="f-alert"');
  });
  it('a refusal about no field: an alert at the top of the form that script can focus', () => {
    const SENTENCE = 'This interview was changed a moment ago. Nothing was saved. Check it and try again.';
    const html = view({ mode: 'change', fixed: { name: 'Aina Rahman', job: 'Sales Executive' }, values: valuesFrom(AHEAD), refusal: { text: SENTENCE, word: 'changed' } });
    const alert = tags(html, 'p').find((tag) => attr(tag, 'id') === 'f-alert')!;
    expect(alert).toContain('role="alert"');
    expect(alert).toContain('tabindex="-1"');
    expect(byId(html, 'f-alert')).toBe(SENTENCE);
    // Before every field.
    expect(html.indexOf('id="f-alert"')).toBeLessThan(html.indexOf('id="f-date"'));
  });
  // Final-review fix pass: a way on from "changed a moment ago" that does not need the dialog closed and opened again.
  it('after "changed a moment ago", once the current details were read: a button to load them, which says what it discards', () => {
    const SENTENCE = 'This interview was changed a moment ago. Nothing was saved. Check it and try again.';
    const stale = { mode: 'change' as const, fixed: { name: 'Aina Rahman', job: 'Sales Executive' }, values: valuesFrom(AHEAD), refusal: { text: SENTENCE, word: 'changed' } };
    const html = view({ ...stale, onLoadCurrent: () => {} });
    expect(buttons(html)).toEqual(['Load the current details', 'Cancel', 'Save changes']);
    const tag = buttonTag(html, 'Load the current details');
    expect(tag).toContain('type="button"');
    expect(tag).toContain('min-h-11');
    expect(tag).not.toMatch(/\saria-disabled=/);
    expect(byId(html, attr(tag, 'aria-describedby')!)).toBe('This replaces what you typed with the interview as it is now. Nothing is saved until you save again.');
    // Under the sentence, before every field, and what was typed is still in the form.
    expect(html.indexOf('id="f-alert"')).toBeLessThan(html.indexOf('Load the current details'));
    expect(html.indexOf('Load the current details')).toBeLessThan(html.indexOf('id="f-date"'));
    expect(attr(control(html, 'Time'), 'value')).toBe('15:00');
    // Not before the current details were read, not for any other refusal, and not while a save is in flight.
    expect(buttons(view(stale))).toEqual(['Cancel', 'Save changes']);
    expect(buttons(view({ ...stale, refusal: { text: 'x', word: 'not_scheduled' }, onLoadCurrent: () => {} }))).toEqual(['Cancel', 'Save changes']);
    expect(buttons(view({ ...stale, pending: true, onLoadCurrent: () => {} }))).toEqual(['Cancel', 'Saving…']);
  });
  it('a refusal about the time: at the date field (or the time field for a double booking), not in the box', () => {
    const PASSED = 'That time has already passed in Kuala Lumpur. Choose a later one, or use “Record a past interview” if it already took place.';
    const passed = view({ refusal: { text: PASSED, word: 'in_past' } });
    expect(byId(passed, 'f-date-error')).toBe(PASSED);
    expect(attr(control(passed, 'Date'), 'aria-invalid')).toBe('true');
    expect(passed).not.toContain('id="f-alert"');
    const TWICE = 'This application already has an interview at that time.';
    const twice = view({ refusal: { text: TWICE, word: 'duplicate' } });
    expect(byId(twice, 'f-time-error')).toBe(TWICE);
    expect(twice).not.toContain('id="f-alert"');
  });
  it('pending: both buttons stay focusable and say they are waiting, and the submit says what it is doing', () => {
    const html = view({ pending: true });
    expect(buttons(html)).toEqual(['Cancel', 'Scheduling…']);
    for (const name of ['Cancel', 'Scheduling…']) {
      expect(buttonTag(html, name), name).toContain('aria-disabled="true"');
      expect(buttonTag(html, name), name).not.toMatch(DISABLED);
    }
    expect(buttons(view({ pending: true, mode: 'change', fixed: { name: 'A', job: 'B' } }))).toEqual(['Cancel', 'Saving…']);
    expect(buttons(view({ pending: true, mode: 'past' }))).toEqual(['Cancel', 'Recording…']);
    // The attribute, not the `aria-disabled:` classes a waiting-capable button carries.
    expect(buttonTag(view(), 'Schedule interview')).not.toMatch(/\saria-disabled=/);
    expect(buttonTag(view(), 'Schedule interview')).toContain('type="submit"');
  });
  it('a past interview: every application in the picker, no day after today, and what happened asked with nothing chosen', () => {
    const html = view({ mode: 'past' });
    expect(options(html, 'f-application_id')).toEqual([
      'Choose an application', 'Aina Rahman — Sales Executive (Screening)', 'Ben Tan — Cashier (Applied)', 'Farid bin Osman — Barista (Rejected)',
    ]);
    const date = control(html, 'Date');
    expect(attr(date, 'max')).toBe('2026-10-12');
    expect(attr(date, 'min')).toBeUndefined();
    expect(byId(html, 'f-date-help')).toBe('The day it took place, in Kuala Lumpur.');
    expect(byId(html, 'f-time-help')).toBe('When it started, Kuala Lumpur time (GMT+8).');
    expect(byId(html, 'f-place-help')).toBe('Optional.');
    // Corrected from the plan's `not.toContain('invitation')`: the Notes helper ("never in the invitation") is the same
    // in every mode, as the Global Constraints have it. What must not be said here is that anything is shown in one.
    expect(text(html)).not.toContain('Shown in the invitation');
    // Two radio buttons in a named group, neither chosen.
    expect(html).toMatch(/<fieldset\b[^>]*>\s*<legend[^>]*>What happened<\/legend>/);
    const radios = tags(html, 'input').filter((tag) => attr(tag, 'type') === 'radio');
    expect(radios).toHaveLength(2);
    expect(radios.some((tag) => /\schecked/.test(tag))).toBe(false);
    expect(attr(radios[0], 'id')).toBe('f-outcome');
    expect(new Set(radios.map((tag) => attr(tag, 'name'))).size).toBe(1);
    expect(labels(html).map((l) => l.text)).toEqual(expect.arrayContaining(['Completed', 'No-show']));
    expect(byId(html, 'f-outcome-help')).toBe('Completed if the interview took place. No-show if the candidate did not turn up.');
    expect(buttons(html)).toEqual(['Cancel', 'Record interview']);
    const missing = view({ mode: 'past', problems: { outcome: 'Choose what happened.' } });
    expect(byId(missing, 'f-outcome-error')).toBe('Choose what happened.');
    const chosen = view({ mode: 'past', values: { ...emptyValues(), outcome: 'no_show' } });
    expect(tags(chosen, 'input').filter((tag) => attr(tag, 'type') === 'radio').map((tag) => /\schecked/.test(tag))).toEqual([false, true]);
  });
  it('gives every control a 44 pixel target and uses nothing purple or violet', () => {
    const html = view({ mode: 'past' });
    for (const tag of [...tags(html, 'select'), ...tags(html, 'input').filter((t) => attr(t, 'type') !== 'radio')]) expect(tag).toContain('h-11');
    for (const tag of tags(html, 'button')) {
      expect(tag).toContain('min-h-11');
      expect(tag).toContain('min-w-11');
    }
    expect(html).not.toMatch(/purple|violet/i);
  });
});

describe('the invitation step', () => {
  const TEXT = 'Hi Aina Rahman,\n\nYou are invited to an interview for the Sales Executive role at Rimba Ventures.';
  // The file as the server made it: the step is given the content and only saves it (final-review fix pass; the plan
  // gave the step a source to build the file from in the browser).
  const FILE = { name: 'interview-aina-rahman-2026-10-20.ics', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' };
  const step = (moveFor: string | null, file: typeof FILE | null = FILE) =>
    renderToStaticMarkup(<InvitationStep text={TEXT} file={file} moveFor={moveFor} onDone={() => {}} />);

  it('shows the invitation in a read-only, labelled text area', () => {
    const html = step(null);
    expect(labels(html).map((l) => l.text)).toEqual(['Invitation']);
    const area = control(html, 'Invitation');
    expect(area).toMatch(/^<textarea/);
    expect(area.toLowerCase()).toContain('readonly');
    expect(unescape(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? '')).toBe(TEXT);
  });
  it('without the move: Copy invitation, Download calendar file (.ics) and Done', () => {
    const html = step(null);
    expect(buttons(html)).toEqual(['Copy invitation', 'Download calendar file (.ics)', 'Done']);
    expect(text(html)).toContain('Opens in most calendar apps. Attach it to your message so the candidate gets a reminder from their own calendar.');
    expect(text(html)).not.toContain('Move to Interview');
  });
  it('with the move: Move to Interview before Done', () => {
    expect(buttons(step(APP))).toEqual(['Copy invitation', 'Download calendar file (.ics)', 'Move to Interview', 'Done']);
  });
  it('offers no calendar file when there is nothing to make one from', () => {
    expect(buttons(step(null, null))).toEqual(['Copy invitation', 'Done']);
    expect(text(step(null, null))).not.toContain('Opens in most calendar apps');
  });
  // Not in the plan: added by Task 3. With no text there is nothing to copy, and no stub stands where it would be.
  it('with no invitation text: no text area and no Copy button, and nothing in their place', () => {
    const html = renderToStaticMarkup(<InvitationStep text={null} file={null} moveFor={null} onDone={() => {}} />);
    expect(buttons(html)).toEqual(['Done']);
    expect(tags(html, 'textarea')).toEqual([]);
    expect(labels(html)).toEqual([]);
    expect(html).not.toMatch(DISABLED);
    expect(html).not.toMatch(/\saria-disabled=/);
  });
  it('has polite lines, empty until something is copied or moved, 44 pixel buttons, and nothing said or sent by being drawn', () => {
    const html = step(APP);
    expect(html.match(/aria-live="polite"/g)).toHaveLength(2);
    expect(html).not.toContain('role="alert"');
    expect(text(html)).not.toMatch(/Copied|Couldn't copy|Moved to Interview\./);
    for (const tag of tags(html, 'button')) {
      expect(tag).toContain('type="button"');
      expect(tag).toContain('min-h-11');
      expect(tag).not.toMatch(/\saria-disabled=/);
    }
    expect(mocks.action).not.toHaveBeenCalled();
    expect(html).not.toMatch(/purple|violet/i);
  });
});

describe('the dialog\'s host', () => {
  it('draws nothing until something opens it', () => {
    expect(renderToStaticMarkup(<InterviewDialogHost today="2026-10-12" picker={{ applications: APPS, cut: false }} />)).toBe('');
    expect(renderToStaticMarkup(<InterviewDialogHost today="" />)).toBe('');
  });
});

describe('where an interview is offered for an application', () => {
  const subject = (over: Partial<ApplicationSubject> = {}): ApplicationSubject => ({
    id: APP, candidateId: CANDIDATE, name: 'Aina Rahman', job: 'Sales Executive', stage: 'screening', outcome: 'active', rating: null, rejectReason: null,
    ...over,
  });

  it('the board card\'s menu has Schedule interview under a rule of its own, above the rule that precedes Edit candidate', () => {
    const html = renderToStaticMarkup(<ApplicationMenu application={subject()} canEdit />);
    const all = items(html).map((i) => i.label);
    expect(all).toContain('Schedule interview');
    expect(all.indexOf('Schedule interview')).toBeGreaterThan(all.indexOf('Rate 5 out of 5'));
    expect(all.indexOf('Schedule interview')).toBe(all.indexOf('Edit candidate') - 1);
    expect(html.slice(html.indexOf('Schedule interview'), html.indexOf('Edit candidate'))).toContain('<hr/>');
    expect(html.slice(html.indexOf('Rate 5 out of 5'), html.indexOf('Schedule interview'))).toContain('<hr/>');
    expect(items(html).find((i) => i.label === 'Schedule interview')?.variant).toBe('default');
    // Not on the card: the menu is long already, and the panel has it.
    expect(all).not.toContain('Record a past interview');
    // Its button has the id focus is given back to, the same when the card is drawn again in another column.
    expect(buttonTag(html, 'Actions for Aina Rahman')).toContain(`id="${openerId('card', APP)}"`);
  });
  it('the card menu of an application that is no longer active does not offer it', () => {
    const all = items(renderToStaticMarkup(<ApplicationMenu application={subject({ outcome: 'rejected' })} canEdit />)).map((i) => i.label);
    expect(all).not.toContain('Schedule interview');
  });
  it('the panel has Schedule interview for an active application, and Record a past interview for every outcome', () => {
    const active = renderToStaticMarkup(<ApplicationActions application={subject()} canEdit />);
    const names = buttons(active);
    expect(names.indexOf('Schedule interview')).toBe(names.indexOf('Rate 5 out of 5') + 1);
    expect(names[names.indexOf('Schedule interview') + 1]).toBe('Record a past interview');
    expect(names[names.indexOf('Record a past interview') + 1]).toBe('Edit candidate');
    expect(buttonTag(active, 'Schedule interview')).toContain(`id="${openerId('panel-schedule', APP)}"`);
    expect(buttonTag(active, 'Record a past interview')).toContain(`id="${openerId('panel-past', APP)}"`);
    for (const outcome of ['rejected', 'withdrawn'] as const) {
      const closed = buttons(renderToStaticMarkup(<ApplicationActions application={subject({ outcome })} canEdit />));
      expect(closed, outcome).toContain('Record a past interview');
      expect(closed, outcome).not.toContain('Schedule interview');
    }
  });
  it('neither is there for someone who may not edit', () => {
    expect(renderToStaticMarkup(<ApplicationMenu application={subject()} canEdit={false} />)).toBe('');
    expect(renderToStaticMarkup(<ApplicationActions application={subject()} canEdit={false} />)).toBe('');
  });
});

describe('the Interviews list in the Applications panel', () => {
  const data = (over: Partial<ApplicationRowData> = {}): ApplicationRowData => ({
    id: APP, candidateId: CANDIDATE, name: 'Aina Rahman', job: 'Sales Executive', source: 'LinkedIn', status: 'In review', statusClass: 'pill', live: true,
    applied: '08 Oct 2026', details: null, stage: 'screening', outcome: 'active', rating: null, rejectReason: null, ...over,
  });
  const render = (over: Partial<ApplicationRowData>, canEdit: boolean) =>
    renderToStaticMarkup(<table><tbody><ApplicationRow row={data(over)} canEdit={canEdit} /></tbody></table>);
  const DETAILS = { coverLetter: 'Dear team', cv: null, hasCvFile: false, portfolio: null, expectedSalary: null };

  it('is headed Interviews and comes above the controls, one line an interview with its place on a second line', () => {
    const html = render({ interviews: [AHEAD, OVERDUE] }, true);
    expect(html).toMatch(/<h4\b[^>]*>Interviews<\/h4>/);
    expect(html.indexOf('>Interviews</h4>')).toBeLessThan(html.indexOf('Move to Interview'));
    const lines = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(([, inner]) => text(inner));
    expect(lines).toEqual([
      'Tue 20 Oct 2026, 3:00 pm · 1 hour · Video call · Farah Lim · Scheduled meet.example.com',
      'Sat 10 Oct 2026, 9:30 am · 1 hour 30 minutes · In person · Farah Lim · Scheduled Level 3, Menara Rimba',
    ]);
    // A link only from the link the server made safe.
    const links = tags(html, 'a');
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('href="https://meet.example.com/abc"');
    expect(links[0]).toContain('rel="noopener noreferrer"');
    expect(text(html)).not.toContain('No interviews yet.');
  });
  it('shows five and says how many more are on the Interviews screen', () => {
    const seven = Array.from({ length: 7 }, (_, i) => row({ id: `iv${i}`, place: null, placeLink: null }));
    const html = render({ interviews: seven }, true);
    expect(html.match(/<li\b/g)).toHaveLength(5);
    expect(text(html)).toContain('and 2 more on the Interviews screen');
    expect(text(render({ interviews: seven.slice(0, 6) }, true))).toContain('and 1 more on the Interviews screen');
    expect(text(render({ interviews: seven.slice(0, 5) }, true))).not.toContain('more on the Interviews screen');
  });
  it('says there are none', () => {
    const html = render({ interviews: [] }, true);
    expect(html).toMatch(/<h4\b[^>]*>Interviews<\/h4>/);
    expect(text(html)).toContain('No interviews yet.');
    expect(html).not.toContain('<li');
  });
  it('is shown to a viewer too, with no control', () => {
    const html = render({ interviews: [AHEAD] }, false);
    // The list alone is something to open, even with no form details.
    expect(buttons(html)).toEqual(['Details for Aina Rahman']);
    expect(text(html)).toContain('Tue 20 Oct 2026, 3:00 pm · 1 hour · Video call · Farah Lim · Scheduled');
    expect(text(html)).not.toMatch(/Schedule interview|Record a past interview/);
    // A viewer who opens the panel for the form details is told when there are no interviews.
    expect(text(render({ details: DETAILS, interviews: [] }, false))).toContain('No interviews yet.');
  });
  it('a rejected application\'s panel lists its interviews, and has Record a past interview but no Schedule interview', () => {
    const html = render({ outcome: 'rejected', status: 'Rejected', interviews: [DONE_ROW] }, true);
    expect(text(html)).toContain('Tue 20 Oct 2026, 3:00 pm · 1 hour · Video call · Completed');
    expect(buttons(html)).toContain('Record a past interview');
    expect(buttons(html)).not.toContain('Schedule interview');
  });
});
