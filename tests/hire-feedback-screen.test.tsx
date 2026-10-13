// tests/hire-feedback-screen.test.tsx
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Feedback } from '@/lib/hire/interview-feedback';
import type { InterviewRow, InterviewsModel } from '@/lib/hire/lists';

/**
 * Where feedback is drawn: the Interviews table's column, the row menu's
 * items, the Applications panel's lines and the feedback form, rendered to a
 * string and read as markup. There is no DOM here, so nothing can be pressed,
 * typed, focused or closed: what each control decides is in plain functions
 * (tests/hire-feedback-dialog.test.ts). What still needs a browser is listed at
 * the end of this task.
 */

const mocks = vi.hoisted(() => ({
  viewer: { orgId: 'org1', orgName: 'Rimba Ventures', role: 'member', isDemo: false } as { orgId: string; orgName: string; role: string; isDemo: boolean },
  interviews: null as unknown,
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
  saveInterviewFeedbackAction: mocks.action,
  clearInterviewFeedbackAction: mocks.action,
  getInterviewFeedbackAction: mocks.action,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: () => {} }), usePathname: () => '/hire/interviews' }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => mocks.viewer }));
vi.mock('@/screens/hire/parts', () => ({
  LOAD_FAILED: <p>load failed</p>,
  Muted: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  FUNNEL_COLOR: {},
  topSlices: () => [],
  loadHire: async () => ({ model: mocks.interviews, isDemo: false }),
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

import { ApplicationRow, type ApplicationRowData } from '@/screens/hire/application-details';
import { FeedbackFormView, type FeedbackFormViewProps } from '@/screens/hire/feedback-dialog';
import { InterviewRowMenu } from '@/screens/hire/interview-actions';
import InterviewsScreen from '@/screens/hire/interviews';
import { emptyFeedback, valuesFromFeedback } from '@/lib/hire/feedback-dialog-state';

const APP = '44444444-4444-4444-8444-444444444444';
const IV = '77777777-7777-4777-8777-777777777777';
const FEEDBACK: Feedback = { rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.\nClear about targets.', recorded_at: '2026-10-21T02:05:40.123456+00:00' };

const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const buttons = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? text(inner));
const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map(([tag]) => tag);
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1];
const byId = (html: string, id: string) => {
  const found = new RegExp(`<(\\w+)\\b[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return found ? text(found[2]) : null;
};
const items = (html: string) =>
  [...html.matchAll(/<div role="menuitem" data-variant="([^"]*)">([\s\S]*?)<\/div>/g)].map(([, variant, inner]) => ({ variant, label: text(inner) }));

const row = (over: Partial<InterviewRow> = {}): InterviewRow => ({
  id: IV, name: 'Aina Rahman', role: 'Sales Executive', date: '20 Oct 2026', time: '3:00 pm', interviewer: 'Farah Lim', type: 'Video', status: 'Scheduled',
  applicationId: APP, statusKey: 'scheduled', scheduledAt: '2026-10-20T07:00:00+00:00', durationMinutes: 60, length: '1 hour', kind: 'video',
  place: null, placeLink: null, interviewerName: 'Farah Lim', notes: null, createdAt: '2026-10-12T02:00:00+00:00', updatedAt: '2026-10-12T02:05:00+00:00',
  applicationStage: 'screening', applicationOutcome: 'active', needsOutcome: false, ...over,
});
const AHEAD = row();
const DONE = row({ id: 'iv-done', name: 'Farid bin Osman', role: 'Barista', status: 'Completed', statusKey: 'completed' });
const RATED = row({ id: 'iv-rated', name: 'Mei Ling Tan', role: 'Driver', status: 'Completed', statusKey: 'completed', feedback: FEEDBACK });
const MISSED = row({ id: 'iv-missed', name: 'Ben Tan', role: 'Cashier', status: 'No-show', statusKey: 'no_show' });
const model = (): InterviewsModel => ({
  isEmpty: false, rows: [AHEAD, DONE, RATED, MISSED], upcoming: [AHEAD], scheduled: 1, ahead: 1, completed: 2, noShow: 1, next7Days: 0, weekLoad: [],
  applications: [], applicationsCut: false, today: '2026-10-22',
});
const screen = async () => renderToStaticMarkup(await InterviewsScreen());
const menu = (r: InterviewRow) => renderToStaticMarkup(<InterviewRowMenu row={r} />);

beforeEach(() => {
  mocks.viewer = { orgId: 'org1', orgName: 'Rimba Ventures', role: 'member', isDemo: false };
  mocks.interviews = model();
  mocks.action.mockReset();
  mocks.refresh.mockReset();
});

describe('the Feedback column of the Interviews table', () => {
  const cellsOf = (html: string, name: string) => {
    const found = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(([, inner]) => inner).find((inner) => text(inner).includes(name))!;
    return [...found.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, inner]) => text(inner));
  };
  it('is the column before Actions', async () => {
    const heads = [...(await screen()).matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(([, inner]) => text(inner));
    expect(heads.slice(-3)).toEqual(['Status', 'Feedback', 'Actions']);
  });
  it('shows the summary, "None yet" for a completed interview without feedback, and a dash for any other status', async () => {
    const html = await screen();
    // The ninth cell of ten: after Status, before Actions.
    expect(cellsOf(html, 'Mei Ling Tan')[8]).toBe('4 out of 5 · Advance');
    expect(cellsOf(html, 'Farid bin Osman')[8]).toBe('None yet');
    expect(cellsOf(html, 'Aina Rahman')[8]).toBe('—');
    expect(cellsOf(html, 'Ben Tan')[8]).toBe('—');
    // The comments are not in the table: they are read in the Applications panel.
    expect(text(html)).not.toContain('Strong on key accounts');
  });
  it('a viewer and the demo workspace read the column and are offered no feedback control', async () => {
    for (const viewer of [
      { orgId: 'org1', orgName: 'Rimba Ventures', role: 'viewer', isDemo: false },
      { orgId: 'org1', orgName: 'Rimba Ventures', role: 'owner', isDemo: true },
    ]) {
      mocks.viewer = viewer;
      const html = await screen();
      expect(cellsOf(html, 'Mei Ling Tan')[8]).toBe('4 out of 5 · Advance');
      expect(html).not.toMatch(/Add feedback|Edit feedback|Clear feedback|Mark completed and add feedback/);
      expect(buttons(html)).toEqual([]);
    }
  });
  it('sends nothing to the server just by being drawn, and has nothing purple or violet', async () => {
    const html = await screen();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(html).not.toMatch(/purple|violet|chart-5/i);
  });
});

describe('a row\'s menu, with the feedback items', () => {
  it('a scheduled interview: "Mark completed and add feedback" directly after "Mark completed"', () => {
    const html = menu(AHEAD);
    expect(items(html).map((i) => i.label)).toEqual([
      'Reschedule or edit', 'Invitation and calendar file', 'Mark completed', 'Mark completed and add feedback', 'Mark no-show', 'Cancel interview',
    ]);
    expect(items(html).filter((i) => i.variant === 'destructive').map((i) => i.label)).toEqual(['Cancel interview']);
  });
  it('a completed interview without feedback: "Add feedback", a rule, "Mark as scheduled again"', () => {
    const html = menu(DONE);
    expect(items(html)).toEqual([{ variant: 'default', label: 'Add feedback' }, { variant: 'default', label: 'Mark as scheduled again' }]);
    expect(html.match(/<hr\/>/g)).toHaveLength(1);
  });
  it('a completed interview with feedback: "Edit feedback", "Mark as scheduled again", and "Clear feedback" last, under a rule, in the danger style', () => {
    const html = menu(RATED);
    expect(items(html)).toEqual([
      { variant: 'default', label: 'Edit feedback' },
      { variant: 'default', label: 'Mark as scheduled again' },
      { variant: 'destructive', label: 'Clear feedback' },
    ]);
    expect(html.match(/<hr\/>/g)).toHaveLength(2);
    expect(html.lastIndexOf('<hr/>')).toBeLessThan(html.indexOf('Clear feedback'));
    expect(html.lastIndexOf('<hr/>')).toBeGreaterThan(html.indexOf('Mark as scheduled again'));
  });
  it('a cancelled interview and a no-show: no feedback item', () => {
    for (const statusKey of ['cancelled', 'no_show'] as const) {
      expect(items(menu(row({ statusKey }))), statusKey).toEqual([{ variant: 'default', label: 'Mark as scheduled again' }]);
    }
  });
  it('draws no dialog, no confirm and no refusal until something is chosen', () => {
    const html = menu(RATED);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('Keep feedback');
    expect(html).not.toContain('Save feedback');
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
  });
});

describe('feedback in the Applications panel', () => {
  const data = (over: Partial<ApplicationRowData> = {}): ApplicationRowData => ({
    id: APP, candidateId: 'c1', name: 'Aina Rahman', job: 'Sales Executive', source: 'LinkedIn', status: 'In review', statusClass: 'pill', live: true,
    applied: '08 Oct 2026', details: null, stage: 'interview', outcome: 'active', rating: 2, rejectReason: null, ...over,
  });
  const render = (over: Partial<ApplicationRowData>, canEdit: boolean) =>
    renderToStaticMarkup(<table><tbody><ApplicationRow row={data(over)} canEdit={canEdit} /></tbody></table>);
  const lines = (html: string) => [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(([, inner]) => text(inner));

  it('under an interview\'s line: the feedback, the day it was saved with its year, and the comments whole', () => {
    const html = render({ interviews: [RATED, DONE] }, true);
    expect(lines(html)[0]).toBe(
      'Tue 20 Oct 2026, 3:00 pm · 1 hour · Video call · Farah Lim · Completed ' +
        'Feedback: 4 out of 5 · Advance · saved 21 Oct 2026 Strong on key accounts. Clear about targets.',
    );
    // An interview without feedback has its one line and nothing more.
    expect(lines(html)[1]).toBe('Tue 20 Oct 2026, 3:00 pm · 1 hour · Video call · Farah Lim · Completed');
    // The comments keep their line breaks and wrap inside the panel.
    const comments = tags(html, 'p').find((tag) => /whitespace-pre-line/.test(tag) && /break-words/.test(tag));
    expect(comments).toBeDefined();
    expect(html).toContain('Strong on key accounts.\nClear about targets.');
  });
  it('says the two ratings are separate, only when some interview in the list has feedback, and above the list', () => {
    const HELPER = 'Interview feedback is separate from the application\'s rating below.';
    const withFeedback = render({ interviews: [RATED] }, true);
    expect(text(withFeedback)).toContain(HELPER);
    expect(withFeedback.indexOf('>Interviews</h4>')).toBeLessThan(withFeedback.indexOf('Interview feedback is separate'));
    expect(withFeedback.indexOf('Interview feedback is separate')).toBeLessThan(withFeedback.indexOf('<li'));
    expect(text(render({ interviews: [DONE, AHEAD] }, true))).not.toContain(HELPER);
    expect(text(render({ interviews: [] }, true))).not.toContain(HELPER);
  });
  it('a viewer reads the feedback and its comments, and gets no control', () => {
    const html = render({ interviews: [RATED] }, false);
    expect(text(html)).toContain('Feedback: 4 out of 5 · Advance · saved 21 Oct 2026');
    expect(text(html)).toContain('Strong on key accounts.');
    expect(html).not.toMatch(/Add feedback|Edit feedback|Clear feedback/);
  });
  it('feedback is not counted as one of the five lines, and nothing here is purple or violet', () => {
    const seven = Array.from({ length: 7 }, (_, i) => row({ id: `iv${i}`, statusKey: 'completed', status: 'Completed', feedback: FEEDBACK }));
    const html = render({ interviews: seven }, true);
    expect(html.match(/<li\b/g)).toHaveLength(5);
    expect(text(html)).toContain('and 2 more on the Interviews screen');
    expect(html).not.toMatch(/purple|violet/i);
  });
});

describe('the feedback form', () => {
  const noop = () => {};
  const view = (over: Partial<FeedbackFormViewProps> = {}) =>
    renderToStaticMarkup(
      <FeedbackFormView
        base="f" values={emptyFeedback()} problems={{}} refusal={null} unchanged={false} pending={false} announced=""
        onChange={noop} onSubmit={noop} onCancel={noop} {...over}
      />,
    );
  const radio = (html: string, id: string) => tags(html, 'input').find((tag) => attr(tag, 'id') === id)!;

  it('adding: two groups of native radios, each in a fieldset with its legend and helper, and a comments box', () => {
    const html = view();
    const legends = [...html.matchAll(/<legend\b[^>]*>([\s\S]*?)<\/legend>/g)].map(([, inner]) => text(inner));
    expect(legends).toEqual(['Rating', 'Recommendation']);
    expect(html.match(/<fieldset\b/g)).toHaveLength(2);
    const radios = tags(html, 'input').filter((tag) => attr(tag, 'type') === 'radio');
    expect(radios.map((tag) => attr(tag, 'id'))).toEqual([
      'f-rating-1', 'f-rating-2', 'f-rating-3', 'f-rating-4', 'f-rating-5', 'f-recommendation-advance', 'f-recommendation-hold', 'f-recommendation-reject',
    ]);
    // Each rating is read as "n out of 5"; the two groups have their own names, so arrow keys stay inside a group.
    expect(radios.slice(0, 5).map((tag) => attr(tag, 'aria-label'))).toEqual(['1 out of 5', '2 out of 5', '3 out of 5', '4 out of 5', '5 out of 5']);
    expect(new Set(radios.slice(0, 5).map((tag) => attr(tag, 'name')))).toEqual(new Set(['f-rating']));
    expect(new Set(radios.slice(5).map((tag) => attr(tag, 'name')))).toEqual(new Set(['f-recommendation']));
    for (const tag of radios) expect(tag).not.toMatch(/\schecked/);
    expect(byId(html, 'f-rating-help')).toBe('1 is the lowest, 5 the highest.');
    expect(byId(html, 'f-recommendation-help')).toBe('A note for whoever decides. It does not move or reject the application.');
    expect(byId(html, 'f-comments-help')).toBe('Optional. What the interview showed that bears on the job.');
    expect(text(html)).toContain('Advance');
    expect(text(html)).toContain('Hold');
    expect(text(html)).toContain('Reject');
    const box = tags(html, 'textarea')[0];
    expect(attr(box, 'id')).toBe('f-comments');
    expect(attr(box, 'maxLength') ?? attr(box, 'maxlength')).toBe('2000');
    expect(buttons(html)).toEqual(['Cancel', 'Save feedback']);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/purple|violet/i);
  });
  it('every radio with its label is a 44 pixel target, and "Reject" is not drawn in the danger style', () => {
    const html = view();
    const labels = [...html.matchAll(/<label\b([^>]*)>/g)].map(([, attrs]) => attrs).filter((attrs) => /for="f-(rating|recommendation)-/.test(attrs));
    expect(labels).toHaveLength(8);
    for (const attrs of labels) {
      expect(attrs).toContain('min-h-11');
      expect(attrs).toContain('min-w-11');
    }
    // "Reject" rejects nothing: its label and its radio carry no danger colour. (The buttons' own classes are not looked at.)
    expect(labels.find((attrs) => attrs.includes('for="f-recommendation-reject"'))).not.toContain('destructive');
    expect(radio(html, 'f-recommendation-reject')).not.toContain('destructive');
  });
  it('editing: every field starts at what is stored', () => {
    const html = view({ values: valuesFromFeedback(FEEDBACK) });
    expect(radio(html, 'f-rating-4')).toMatch(/\schecked/);
    expect(radio(html, 'f-rating-3')).not.toMatch(/\schecked/);
    expect(radio(html, 'f-recommendation-advance')).toMatch(/\schecked/);
    expect(radio(html, 'f-recommendation-reject')).not.toMatch(/\schecked/);
    expect(html).toContain('Strong on key accounts.\nClear about targets.</textarea>');
  });
  it('a failed check: each error is an alert under its group or field, tied to it', () => {
    const html = view({ problems: { rating: 'Choose a rating from 1 to 5.', recommendation: 'Choose a recommendation.', comments: 'Keep the comments under 2,000 characters.' } });
    expect(byId(html, 'f-rating-error')).toBe('Choose a rating from 1 to 5.');
    expect(byId(html, 'f-recommendation-error')).toBe('Choose a recommendation.');
    expect(byId(html, 'f-comments-error')).toBe('Keep the comments under 2,000 characters.');
    expect(html.match(/role="alert"/g)).toHaveLength(3);
    const fieldsets = tags(html, 'fieldset');
    expect(attr(fieldsets[0], 'aria-describedby')).toBe('f-rating-error f-rating-help');
    expect(attr(fieldsets[1], 'aria-describedby')).toBe('f-recommendation-error f-recommendation-help');
    expect(attr(tags(html, 'textarea')[0], 'aria-describedby')).toBe('f-comments-error f-comments-help');
    expect(attr(tags(html, 'textarea')[0], 'aria-invalid')).toBe('true');
  });
  it('a refusal from the server: an alert at the top of the form that script can focus', () => {
    const SENTENCE = 'This interview already has feedback. Open it to edit it.';
    const html = view({ refusal: { text: SENTENCE, word: 'has_feedback' } });
    const alert = tags(html, 'p').find((tag) => attr(tag, 'id') === 'f-alert')!;
    expect(alert).toContain('role="alert"');
    expect(alert).toContain('tabindex="-1"');
    expect(byId(html, 'f-alert')).toBe(SENTENCE);
    expect(html.indexOf('id="f-alert"')).toBeLessThan(html.indexOf('<fieldset'));
    expect(buttons(html)).toEqual(['Cancel', 'Save feedback']);
  });
  it('after "changed a moment ago", once the current feedback was read: a button to load it, which says what it discards', () => {
    const SENTENCE = 'The feedback on this interview was changed a moment ago. Nothing was saved. Check it and try again.';
    const stale = { values: valuesFromFeedback(FEEDBACK), refusal: { text: SENTENCE, word: 'changed' } };
    const html = view({ ...stale, onLoadCurrent: noop });
    expect(buttons(html)).toEqual(['Load the current feedback', 'Cancel', 'Save feedback']);
    expect(byId(html, 'f-reload-help')).toBe('This replaces what you typed with the feedback as it is now. Nothing is saved until you save again.');
    expect(html.indexOf('id="f-alert"')).toBeLessThan(html.indexOf('Load the current feedback'));
    expect(html.indexOf('Load the current feedback')).toBeLessThan(html.indexOf('<fieldset'));
    // Not before it was read, not for another refusal, not while a save is in flight.
    expect(buttons(view(stale))).toEqual(['Cancel', 'Save feedback']);
    expect(buttons(view({ ...stale, refusal: { text: 'x', word: 'has_feedback' }, onLoadCurrent: noop }))).toEqual(['Cancel', 'Save feedback']);
    expect(buttons(view({ ...stale, pending: true, onLoadCurrent: noop }))).toEqual(['Cancel', 'Saving…']);
  });
  it('while it is saved: the button says so, stays focusable and is marked as waiting, and so is Cancel', () => {
    const html = view({ values: valuesFromFeedback(FEEDBACK), pending: true });
    expect(buttons(html)).toEqual(['Cancel', 'Saving…']);
    for (const tag of tags(html, 'button')) {
      expect(attr(tag, 'aria-disabled')).toBe('true');
      expect(tag).not.toMatch(/\sdisabled(=|\s|>)/);
    }
  });
  it('an edit with nothing altered says so beside the button', () => {
    const html = view({ values: valuesFromFeedback(FEEDBACK), unchanged: true });
    expect(byId(html, 'f-unchanged')).toBe('Nothing has been changed yet.');
    expect(attr(tags(html, 'button').at(-1)!, 'aria-describedby')).toBe('f-unchanged');
  });
  it('the count of characters left appears once fewer than 200 remain, and is read out from one polite line', () => {
    expect(byId(view({ values: { ...emptyFeedback(), comments: 'c'.repeat(1850) } }), 'f-count')).toBe('150 characters left');
    expect(byId(view({ values: { ...emptyFeedback(), comments: 'c'.repeat(2000) } }), 'f-count')).toBe('0 characters left');
    expect(view({ values: { ...emptyFeedback(), comments: 'c'.repeat(1800) } })).not.toContain('id="f-count"');
    const html = view({ values: { ...emptyFeedback(), comments: 'c'.repeat(1801) }, announced: '199 characters left' });
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
    const live = [...html.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)].find(([, attrs]) => /aria-live="polite"/.test(attrs))!;
    expect(text(live[2])).toBe('199 characters left');
    expect(live[1]).toContain('sr-only');
  });
});
