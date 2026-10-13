import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PoolModel } from '@/lib/hire/lists';

/**
 * The delete dialog's decisions, and where a deletion is offered, as the
 * server sends it. There is no DOM here (node, no jsdom, no testing library),
 * so nothing can be pressed, focused or closed: what the dialog decides is in
 * plain functions, tested first. What still needs a browser is listed in the
 * plan's smoke checklist.
 */

const mocks = vi.hoisted(() => ({
  viewer: { orgId: 'org1', role: 'member', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  pool: null as unknown,
  action: vi.fn(),
  refresh: vi.fn(),
}));

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
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: () => {} }), usePathname: () => '/hire/talent-pool' }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => mocks.viewer }));
vi.mock('@/screens/hire/parts', () => ({
  LOAD_FAILED: <p>load failed</p>,
  Muted: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  FUNNEL_COLOR: {},
  topSlices: () => [],
  loadHire: async () => ({ model: mocks.pool, isDemo: false }),
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
import { DeletionNotice, announceDeletion, claimResult, shownNotice } from '@/screens/hire/delete-dialog';
import { PoolRowControls } from '@/screens/hire/pool-actions';
import TalentPoolScreen from '@/screens/hire/talent-pool';
import {
  DELETION_NOTICE_ID, LOADING, canConfirm, confirmLabel, deleteTargetFor, dialogBody, focusIdAfter, mayClose, summaryFrom,
} from '@/lib/hire/delete-dialog-state';

const APP = '44444444-4444-4444-8444-444444444444';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const subject: ApplicationSubject = {
  id: APP, candidateId: CANDIDATE, name: 'Aina Rahman', job: 'Barista', stage: 'interview', outcome: 'active', rating: null, rejectReason: null,
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = (html: string) =>
  [...html.matchAll(/<div role="menuitem" data-variant="([^"]*)">([\s\S]*?)<\/div>/g)].map(([, variant, inner]) => ({ variant, label: text(inner) }));
const buttons = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? text(inner));
const READY = { state: 'ready', removal: { name: 'Aina Rahman', job: 'Barista', applications: 2, interviews: 1, cvFiles: 1 } } as const;

beforeEach(() => {
  mocks.viewer = { orgId: 'org1', role: 'member', isDemo: false };
  mocks.action.mockReset();
});

describe('what the dialog knows about what will go', () => {
  it('starts by loading', () => {
    expect(LOADING).toEqual({ state: 'loading' });
  });
  it('is ready only with a well-formed answer', () => {
    expect(summaryFrom({ ok: true, data: READY.removal })).toEqual(READY);
    expect(summaryFrom({ ok: true, data: { name: 'Aina', job: null, applications: 0, interviews: 0, cvFiles: 0 } }))
      .toEqual({ state: 'ready', removal: { name: 'Aina', job: null, applications: 0, interviews: 0, cvFiles: 0 } });
  });
  it('keeps a refusal\'s own sentence', () => {
    expect(summaryFrom({ ok: false, error: 'That candidate could not be found. They may already have been deleted.' }))
      .toEqual({ state: 'failed', error: 'That candidate could not be found. They may already have been deleted.' });
  });
  it('fails closed on anything else: a throw, a missing count, a count that is not a whole number', () => {
    const FAILED = { state: 'failed', error: 'Couldn\'t check what this removes. Close this and try again.' };
    for (const odd of [
      null, undefined, 'ok', { ok: true }, { ok: true, data: null }, { ok: false },
      { ok: true, data: { name: 'Aina', job: null, applications: 1, interviews: 0 } },
      { ok: true, data: { name: 'Aina', job: null, applications: '1', interviews: 0, cvFiles: 0 } },
      { ok: true, data: { name: 'Aina', job: null, applications: -1, interviews: 0, cvFiles: 0 } },
      { ok: true, data: { name: 'Aina', job: null, applications: 1.5, interviews: 0, cvFiles: 0 } },
      { ok: true, data: { name: 7, job: null, applications: 1, interviews: 0, cvFiles: 0 } },
    ]) {
      expect(summaryFrom(odd), JSON.stringify(odd)).toEqual(FAILED);
    }
  });
});

describe('what the dialog says and allows', () => {
  it('says it is checking, then exactly what goes, or why it could not check', () => {
    expect(dialogBody('candidate', LOADING)).toBe('Checking what this removes…');
    expect(dialogBody('candidate', READY)).toBe('This removes 2 applications, 1 interview and 1 CV file. This can\'t be undone.');
    expect(dialogBody('application', READY)).toBe('This removes the application, 1 interview and 1 CV file. Aina Rahman stays on file as a candidate. This can\'t be undone.');
    expect(dialogBody('candidate', { state: 'failed', error: 'Nope.' })).toBe('Nope.');
  });
  it('lets a deletion be confirmed only once the numbers are on screen, and never while one is being saved', () => {
    expect(canConfirm(READY, false)).toBe(true);
    expect(canConfirm(READY, true)).toBe(false);
    expect(canConfirm(LOADING, false)).toBe(false);
    expect(canConfirm({ state: 'failed', error: 'x' }, false)).toBe(false);
  });
  it('labels the confirm button by what it deletes, and says when it is deleting', () => {
    expect(confirmLabel('application', false)).toBe('Delete application');
    expect(confirmLabel('candidate', false)).toBe('Delete candidate');
    expect(confirmLabel('application', true)).toBe('Deleting…');
    expect(confirmLabel('candidate', true)).toBe('Deleting…');
  });
  it('does not close while a deletion is being saved', () => {
    expect(mayClose(false)).toBe(true);
    expect(mayClose(true)).toBe(false);
  });
  it('gives focus back to the opener on cancel, and to a place that still exists after a deletion', () => {
    expect(focusIdAfter(false, 'hire-stage-offer')).toBeNull();
    expect(focusIdAfter(false)).toBeNull();
    expect(focusIdAfter(true, 'hire-stage-offer')).toBe('hire-stage-offer');
    expect(focusIdAfter(true)).toBe(DELETION_NOTICE_ID);
  });
  it('deletes the application by the application\'s id and the candidate by the candidate\'s', () => {
    expect(deleteTargetFor('application', subject)).toEqual({ kind: 'application', id: APP, name: 'Aina Rahman', job: 'Barista' });
    expect(deleteTargetFor('candidate', subject)).toEqual({ kind: 'candidate', id: CANDIDATE, name: 'Aina Rahman', job: null });
  });
});

describe('where a deletion is offered', () => {
  it('is the last two items of a board card\'s menu, under a separator, in the danger style', () => {
    const html = renderToStaticMarkup(<ApplicationMenu application={subject} canEdit />);
    const all = items(html);
    expect(all.slice(-2)).toEqual([
      { variant: 'destructive', label: 'Delete application' },
      { variant: 'destructive', label: 'Delete candidate' },
    ]);
    expect(all.map((i) => i.label).indexOf('Reject')).toBeLessThan(all.length - 2);
    // A separator stands between Reject and the two deletes.
    const afterReject = html.slice(html.lastIndexOf('Reject'), html.indexOf('Delete application'));
    expect(afterReject).toContain('<hr/>');
  });
  it('is in the menu of a rejected application too', () => {
    const html = renderToStaticMarkup(<ApplicationMenu application={{ ...subject, outcome: 'rejected' }} canEdit />);
    expect(items(html).slice(-2).map((i) => i.label)).toEqual(['Delete application', 'Delete candidate']);
  });
  it('is two buttons at the end of the Applications panel, for every outcome', () => {
    for (const outcome of ['active', 'rejected', 'withdrawn'] as const) {
      const html = renderToStaticMarkup(<ApplicationActions application={{ ...subject, outcome }} canEdit />);
      expect(buttons(html).slice(-2), outcome).toEqual(['Delete application', 'Delete candidate']);
    }
  });
  it('is nowhere for someone who may not edit', () => {
    expect(renderToStaticMarkup(<ApplicationMenu application={subject} canEdit={false} />)).toBe('');
    expect(renderToStaticMarkup(<ApplicationActions application={subject} canEdit={false} />)).toBe('');
  });
  it('sends nothing to the server just by being drawn', () => {
    renderToStaticMarkup(<ApplicationMenu application={subject} canEdit />);
    renderToStaticMarkup(<ApplicationActions application={subject} canEdit />);
    renderToStaticMarkup(<PoolRowControls candidate={{ id: CANDIDATE, name: 'Aina Rahman', poolStatus: 'available', label: 'Available' }} jobs={[]} />);
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe('a talent pool row', () => {
  const pool: PoolModel = {
    isEmpty: false,
    size: 1,
    rows: [{ id: CANDIDATE, name: 'Aina Rahman', title: 'Barista', skills: ['POS'], location: 'Klang', source: 'Referral', rating: 4, status: 'Available', poolStatus: 'available' }],
    statusCounts: [
      { key: 'Available', value: 1 }, { key: 'Shortlisted', value: 0 }, { key: 'Passive', value: 0 }, { key: 'Re-engaged', value: 0 },
    ],
    byTitle: [{ label: 'Barista', value: 1 }],
    bySource: [{ label: 'Referral', value: 1 }],
    jobs: [],
    search: null,
    matched: 1,
    readCapped: false,
  };
  beforeEach(() => {
    mocks.pool = pool;
  });

  const rowControls = () =>
    renderToStaticMarkup(<PoolRowControls candidate={{ id: CANDIDATE, name: 'Aina Rahman', poolStatus: 'available', label: 'Available' }} jobs={[]} />);

  it('Delete candidate is the last item of the row\'s menu, in the danger style, under a rule of its own', () => {
    const html = rowControls();
    expect(buttons(html)).toContain('Actions for Aina Rahman');
    expect(items(html).slice(-1)).toEqual([{ variant: 'destructive', label: 'Delete candidate' }]);
    expect(html.slice(html.lastIndexOf('<hr/>'))).toContain('Delete candidate');
    const tag = [...html.matchAll(/<button\b[^>]*>/g)].map(([t]) => t).find((t) => t.includes('aria-label="Actions for Aina Rahman"'))!;
    expect(tag).toContain('min-h-11');
    expect(tag).toContain('min-w-11');
    expect(tag).toMatch(/focus-visible:ring-/);
  });
  it('is on the screen for someone who may edit, with the notice line', async () => {
    const html = renderToStaticMarkup(await TalentPoolScreen());
    expect(buttons(html)).toContain('Actions for Aina Rahman');
    expect(html).toContain(`id="${DELETION_NOTICE_ID}"`);
  });
  it('is not on the screen for a viewer or the demo workspace', async () => {
    for (const viewer of [{ orgId: 'org1', role: 'viewer', isDemo: false }, { orgId: 'org1', role: 'owner', isDemo: true }]) {
      mocks.viewer = viewer;
      const html = renderToStaticMarkup(await TalentPoolScreen());
      expect(buttons(html)).not.toContain('Actions for Aina Rahman');
      expect(html).not.toContain('Delete candidate');
      expect(html).not.toContain(DELETION_NOTICE_ID);
      expect(html).toContain('Aina Rahman');
    }
  });
  it('carries no email, phone or storage path, and nothing purple or violet', async () => {
    const html = renderToStaticMarkup(await TalentPoolScreen());
    expect(html).not.toMatch(/cv_path|[\w.]+@[\w-]+\.\w+|\+?60\d{8,}/);
    expect(rowControls()).not.toMatch(/purple|violet/i);
  });
});

describe('the notice line', () => {
  it('is one polite live region that script can focus, empty until something is deleted', () => {
    const html = renderToStaticMarkup(<DeletionNotice />);
    expect(html).toContain(`id="${DELETION_NOTICE_ID}"`);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('tabindex="-1"');
    expect(text(html)).toBe('');
    expect(html).not.toMatch(/purple|violet/i);
  });
  it('holds one result at a time: a newer result elsewhere on the screen empties it, and a newer notice takes over again', () => {
    announceDeletion('Deleted Aina Rahman.');
    expect(shownNotice()).toBe('Deleted Aina Rahman.');
    // A card says "Changes saved." on its own line: the older sentence must not stay beside it.
    const card = claimResult();
    expect(shownNotice()).toBe('');
    // Then a pool change is said on the notice line: it shows, and the card's line is no longer the newest.
    announceDeletion('Removed Aina Rahman from the talent pool. They are still on file.');
    expect(shownNotice()).toBe('Removed Aina Rahman from the talent pool. They are still on file.');
    const later = claimResult();
    expect(later).toBeGreaterThan(card);
    expect(shownNotice()).toBe('');
    // The same sentence said twice is two results.
    announceDeletion('x');
    announceDeletion('x');
    expect(shownNotice()).toBe('x');
  });
});
