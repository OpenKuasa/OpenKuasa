import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { badgeAriaLabel, getProduct } from '@/config/nav';
import { clearOverride, mergeBadges, setOverride } from '@/lib/nav-badges';
import { buildAnnouncementsModel } from '@/lib/people/company';
import { buildReviewsModel, buildScorecardModel } from '@/lib/people/performance';
import { reviewPeriods, toScore } from '@/lib/people/performance-forms';
import {
  RATING_OPTIONS,
  SCORE_OPTIONS,
  announcementMarks,
  announcementsScreenControls,
  claimOnce,
  markReadOnce,
  reviewScreenControls,
  shouldReadUnread,
  competencyLine,
  deleteAnnouncementSentence,
  deleteReviewSentence,
  firstFreePeriod,
  periodTaken,
  publishSentence,
  pullBackAnnouncementSentence,
  pullBackSentence,
  releaseSentence,
  reviewFormDefaults,
  reviewMark,
  reviewTiles,
  scoreCell,
  scorecardTiles,
  shouldMarkRead,
  showsWriteControls,
  visibleAnnouncements,
  visibleReviewRows,
  visibleScorecardRows,
} from '@/lib/people/reviews-announcements';
import type { Announcement, Employee, PeopleViewer, Review } from '@/lib/people/types';

const member: PeopleViewer = { employeeId: 'e1', isHr: false, isDemo: false, employeeName: 'Aisyah' };
const admin: PeopleViewer = { employeeId: 'e9', isHr: true, isDemo: false };
const demoGuest: PeopleViewer = { employeeId: 'e1', isHr: false, isDemo: true };
const demoAdmin: PeopleViewer = { employeeId: 'e9', isHr: true, isDemo: true };

const employee = (id: string, name: string, department_name: string): Employee =>
  ({ id, name, department_name, status: 'active' }) as Employee;
const employees = [employee('e1', 'Aisyah', 'Ops'), employee('e2', 'Bala', 'Ops')];

const review = (over: Partial<Review>): Review => ({
  id: 'r1',
  employee_id: 'e1',
  employee_name: 'Aisyah',
  period: 'H1 2026',
  competencies: { Delivery: 4, Teamwork: 4, Ownership: 4, Communication: 4 },
  rating: 'meets',
  score: 4,
  comment: 'Steady.',
  status: 'released',
  released_at: '2026-07-01T00:00:00+00:00',
  reviewer_name: 'Owner',
  reviewed_at: '2026-07-01',
  ...over,
});

const announcement = (over: Partial<Announcement>): Announcement => ({
  id: 'a1',
  title: 'Raya hours',
  body: 'Offices close early.',
  category: 'holiday',
  status: 'published',
  published_at: '2026-10-10T02:00:00+00:00',
  author_name: 'Owner',
  edited_at: null,
  unread: true,
  ...over,
});

const NOW = new Date('2026-10-12T04:00:00Z');

describe('the review form options', () => {
  it('offers 1 to 5 in half steps and nothing else, each one accepted by toScore', () => {
    expect(SCORE_OPTIONS).toEqual(['1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5']);
    for (const option of SCORE_OPTIONS) expect(toScore(option)).toBe(Number(option));
  });
  it('offers the three ratings', () => {
    expect(RATING_OPTIONS.map((r) => r.value)).toEqual(['exceeds', 'meets', 'below']);
  });
});

describe('the second-step sentences', () => {
  it('says what Release and Pull back do, with the name', () => {
    expect(releaseSentence('Aisyah')).toBe('Aisyah will be able to see this review.');
    expect(pullBackSentence('Aisyah')).toBe('Aisyah will no longer see this review.');
  });
  it('names what a delete removes and that it cannot be undone', () => {
    expect(deleteReviewSentence('Aisyah', 'H1 2026')).toBe('Delete the draft H1 2026 review of Aisyah? This cannot be undone.');
    expect(deleteAnnouncementSentence('Raya hours')).toBe('Delete "Raya hours"? This cannot be undone.');
  });
  it('says who will read a published announcement and what pulling it back does', () => {
    expect(publishSentence()).toBe('Everyone in your workspace will be able to read this.');
    expect(pullBackAnnouncementSentence()).toBe('It goes back to a draft and no one but owners and admins will see it until you publish it again.');
  });
});

describe('periods already reviewed', () => {
  const rows = [
    { id: 'r1', employee_id: 'e1', period: 'H1 2026' },
    { id: 'r2', employee_id: 'e2', period: 'H2 2026' },
  ];
  it('marks the period of the same employee as taken, not another employee’s', () => {
    expect(periodTaken(rows, 'e1', 'H1 2026')).toBe(true);
    expect(periodTaken(rows, 'e1', 'H2 2026')).toBe(false);
    expect(periodTaken(rows, 'e2', 'H1 2026')).toBe(false);
  });
  it('does not count the review being edited against itself', () => {
    expect(periodTaken(rows, 'e1', 'H1 2026', 'r1')).toBe(false);
  });
  it('picks the first free period for the employee, else none', () => {
    const periods = reviewPeriods('2026-10-12');
    expect(firstFreePeriod(periods, rows, 'e1')).toBe('H2 2026');
    expect(firstFreePeriod(periods, rows, 'e2')).toBe('H1 2026');
    const all = periods.map((period, i) => ({ id: `x${i}`, employee_id: 'e1', period }));
    expect(firstFreePeriod(periods, all, 'e1')).toBe('');
  });
});

describe('reviewFormDefaults', () => {
  it('starts a new review with nothing chosen except the first free period', () => {
    const d = reviewFormDefaults(null, 'H2 2026');
    expect(d).toEqual({
      employee_id: '',
      period: 'H2 2026',
      competencies: { Delivery: '', Teamwork: '', Ownership: '', Communication: '' },
      rating: '',
      comment: '',
    });
  });
  it('fills an edit from the row, with the four scores as plain text', () => {
    const d = reviewFormDefaults({ employee_id: 'e1', period: 'H1 2026', rating: 'exceeds', comment: 'Great', competencies: { Delivery: 4.5, Teamwork: 4, Ownership: 3.5, Communication: 5 } }, '');
    expect(d.competencies).toEqual({ Delivery: '4.5', Teamwork: '4', Ownership: '3.5', Communication: '5' });
    expect(d.rating).toBe('exceeds');
    expect(d.comment).toBe('Great');
  });
  it('tolerates an old row whose competencies are {}: blank scores, no NaN', () => {
    const d = reviewFormDefaults({ employee_id: 'e1', period: 'H1 2026', rating: 'meets', comment: null, competencies: {} }, '');
    expect(d.competencies).toEqual({ Delivery: '', Teamwork: '', Ownership: '', Communication: '' });
    expect(d.comment).toBe('');
    expect(JSON.stringify(d)).not.toContain('NaN');
  });
});

describe('what an old or missing score shows', () => {
  it('shows a dash for no scores and for a score of nothing', () => {
    expect(competencyLine({})).toBe('—');
    expect(scoreCell(0)).toBe('—');
    expect(scoreCell(Number.NaN)).toBe('—');
    expect(scoreCell(4.63)).toBe('4.6 / 5');
  });
  it('shows a dash for just the missing one, in the fixed order', () => {
    expect(competencyLine({ Teamwork: 3.5, Delivery: 4 })).toBe('Delivery 4.0 · Teamwork 3.5 · Ownership — · Communication —');
  });
  it('never prints NaN', () => {
    expect(competencyLine({ Delivery: Number.NaN, Teamwork: 4 })).not.toContain('NaN');
  });
});

describe('who sees write controls', () => {
  it('owners and admins outside the demo only', () => {
    expect(showsWriteControls(admin)).toBe(true);
    expect(showsWriteControls(member)).toBe(false);
    expect(showsWriteControls(demoGuest)).toBe(false);
    expect(showsWriteControls(demoAdmin)).toBe(false);
  });
});

describe('a member never gets a draft review from the screen rules', () => {
  const draft = review({ id: 'd1', status: 'draft', released_at: null, score: 1, rating: 'below', comment: 'secret' });
  const released = review({ id: 'r2', period: 'H2 2025', score: 4 });

  it('Review Scores: a draft alone yields no row, no count and no average', () => {
    const model = buildReviewsModel([draft], employees, member);
    expect(visibleReviewRows(model)).toEqual([]);
    expect(model.drafts).toBeNull();
    const tiles = reviewTiles(model);
    expect(tiles.map((t) => t.value)).toEqual(['0', '—']);
    expect(JSON.stringify(tiles)).not.toMatch(/draft/i);
  });
  it('Review Scores: a draft beside a released one changes nothing for the member', () => {
    const model = buildReviewsModel([draft, released], employees, member);
    expect(visibleReviewRows(model).map((r) => r.id)).toEqual(['r2']);
    expect(reviewTiles(model).map((t) => t.value)).toEqual(['1', '4.0 / 5']);
  });
  it('Review Scores: even a model that was handed a draft row is filtered again for a member', () => {
    const model = buildReviewsModel([draft, released], employees, admin);
    expect(visibleReviewRows({ ...model, team: false }).map((r) => r.id)).toEqual(['r2']);
  });
  it('Scorecard: a draft alone yields no row, no count and no average for a member', () => {
    const model = buildScorecardModel([draft], employees, member);
    expect(visibleScorecardRows(model)).toEqual([]);
    const tiles = scorecardTiles(model);
    expect(tiles.map((t) => t.value)).toEqual(['—', '0']);
    expect(JSON.stringify(tiles)).not.toMatch(/draft/i);
  });
  it('Scorecard: a model that was handed a draft row is filtered again for a member', () => {
    const model = buildScorecardModel([draft, released], employees, admin);
    expect(visibleScorecardRows({ ...model, team: false }).map((r) => r.id)).toEqual(['r2']);
  });
  it('another employee’s released review is not the member’s either', () => {
    const other = review({ id: 'o1', employee_id: 'e2', employee_name: 'Bala' });
    const model = buildReviewsModel([other], employees, member);
    expect(visibleReviewRows(model)).toEqual([]);
    expect(reviewTiles(model).map((t) => t.value)).toEqual(['0', '—']);
  });
});

describe('an owner or admin sees drafts marked and uncounted', () => {
  const draft = review({ id: 'd1', status: 'draft', released_at: null, score: 1, rating: 'below' });
  const released = review({ id: 'r2', employee_id: 'e2', employee_name: 'Bala', score: 4, rating: 'exceeds' });
  it('marks a draft row "Draft" and a released one "Released"', () => {
    const rows = visibleReviewRows(buildReviewsModel([draft, released], employees, admin));
    expect(rows.map((r) => [r.id, reviewMark(r, true)])).toEqual([
      ['d1', 'Draft'],
      ['r2', 'Released'],
    ]);
  });
  it('shows no status mark to a member', () => {
    const rows = visibleReviewRows(buildReviewsModel([released], employees, { ...member, employeeId: 'e2' }));
    expect(rows.map((r) => reviewMark(r, false))).toEqual([null]);
  });
  it('leaves drafts out of every Review Scores figure and says how many are not counted', () => {
    const tiles = reviewTiles(buildReviewsModel([draft, released], employees, admin));
    expect(tiles.map((t) => [t.label, t.value])).toEqual([
      ['Exceeds', '1'],
      ['Meets', '0'],
      ['Below', '0'],
      ['Average score', '4.0 / 5'],
    ]);
    expect(tiles.at(-1)?.caption).toBe('1 draft not counted');
  });
  it('leaves drafts out of the Scorecard figures and marks the draft row', () => {
    const model = buildScorecardModel([draft, released], employees, admin);
    const tiles = scorecardTiles(model);
    expect(tiles.map((t) => [t.label, t.value])).toEqual([
      ['Average score', '4.0 / 5'],
      ['Highest', '4.0 / 5'],
      ['Scored', '1'],
    ]);
    expect(tiles[2].caption).toBe('1 draft not counted');
    expect(visibleScorecardRows(model).map((r) => r.draft)).toEqual([false, true]);
  });
  it('says nothing about drafts when there are none', () => {
    const tiles = scorecardTiles(buildScorecardModel([released], employees, admin));
    expect(tiles[2].caption).toBeUndefined();
  });
  it('copes with a review whose competencies are {} and a score of nothing', () => {
    const old = review({ id: 'old', competencies: {} as Review['competencies'], score: Number.NaN });
    const reviews = buildReviewsModel([old], employees, admin);
    const card = buildScorecardModel([old], employees, admin);
    expect(JSON.stringify(reviewTiles(reviews))).not.toContain('NaN');
    expect(JSON.stringify(scorecardTiles(card))).not.toContain('NaN');
    expect(JSON.stringify(visibleReviewRows(reviews))).not.toContain('NaN');
    expect(competencyLine(reviews.rows[0].competencies)).toBe('—');
  });
  it('shows the placeholder tiles when the read failed', () => {
    expect(reviewTiles(null).map((t) => t.value)).toEqual(['—', '—', '—', '—']);
    expect(scorecardTiles(null).map((t) => t.value)).toEqual(['—', '—', '—']);
  });
});

describe('announcements on screen', () => {
  const draft = announcement({ id: 'd', status: 'draft', published_at: null, author_name: null, unread: false, title: 'Dinner' });
  const edited = announcement({ id: 'e', edited_at: '2026-10-11T00:00:00+00:00', unread: false });
  it('never lists a draft for a member, even one handed to a model that says team', () => {
    const model = buildAnnouncementsModel([draft, announcement({})], NOW, member);
    expect(visibleAnnouncements(model).map((a) => a.id)).toEqual(['a1']);
    const team = buildAnnouncementsModel([draft, announcement({})], NOW, admin);
    expect(visibleAnnouncements(team, false).map((a) => a.id)).toEqual(['a1']);
    expect(visibleAnnouncements(team, true).map((a) => a.id)).toEqual(['d', 'a1']);
  });
  it('marks a draft, an unread post and an edited one', () => {
    const model = buildAnnouncementsModel([draft, edited, announcement({ id: 'n' })], NOW, admin);
    const marks = Object.fromEntries(model.list.map((a) => [a.id, announcementMarks(a)]));
    expect(marks.d).toEqual(['Draft']);
    expect(marks.n).toEqual(['New']);
    expect(marks.e).toEqual(['edited']);
  });
  it('shows no unread mark in the demo', () => {
    const model = buildAnnouncementsModel([announcement({})], NOW, demoGuest);
    expect(model.unread).toBe(0);
    expect(model.list.flatMap(announcementMarks)).toEqual([]);
  });
});

describe('when the page marks announcements read', () => {
  it('only for a signed-in person outside the demo who has something unread', () => {
    expect(shouldMarkRead({ isDemo: false, unread: 2 })).toBe(true);
    expect(shouldMarkRead({ isDemo: false, unread: 0 })).toBe(false);
    expect(shouldMarkRead({ isDemo: true, unread: 3 })).toBe(false);
  });
  it('fires once per mount, whatever React does to the effect', () => {
    const flag = { current: false };
    expect([claimOnce(flag), claimOnce(flag), claimOnce(flag)]).toEqual([true, false, false]);
  });
});

describe('when the people layout reads the unread count', () => {
  it('reads for a signed-in member of a real workspace', () => {
    expect(shouldReadUnread({ isDemo: false, orgId: 'o1' })).toBe(true);
  });
  it('does not read in the demo or without a workspace', () => {
    expect(shouldReadUnread({ isDemo: true, orgId: 'o1' })).toBe(false);
    expect(shouldReadUnread({ isDemo: false, orgId: '' })).toBe(false);
    expect(shouldReadUnread({ isDemo: false, orgId: null })).toBe(false);
  });
  it('the people layout exists and is a component', async () => {
    const layout = await import('@/app/(app)/people/layout');
    expect(typeof layout.default).toBe('function');
  });
});

describe('nav badges set from a page', () => {
  const server = {
    pendingProposals: 3,
    unreadAnnouncements: 0,
    awaitingAcknowledgement: 0,
    waitingLeave: 0,
    waitingTimeOff: 0,
    waitingClaims: 0,
    waitingOvertime: 0,
  };
  it('keeps the server value of the marketing badge whatever a page sets', () => {
    expect(mergeBadges(server, {})).toEqual(server);
    expect(mergeBadges(server, setOverride({}, 'unreadAnnouncements', 5))).toEqual({ ...server, unreadAnnouncements: 5 });
  });
  it('puts the count back to 0 when the page goes away', () => {
    const set = setOverride({}, 'unreadAnnouncements', 5);
    expect(mergeBadges(server, clearOverride(set, 'unreadAnnouncements')).unreadAnnouncements).toBe(0);
  });
  it('turns a bad count into 0 and does not change state for the same value', () => {
    expect(setOverride({}, 'unreadAnnouncements', -2)).toEqual({ unreadAnnouncements: 0 });
    expect(setOverride({}, 'unreadAnnouncements', Number.NaN)).toEqual({ unreadAnnouncements: 0 });
    const same = { unreadAnnouncements: 2 };
    expect(setOverride(same, 'unreadAnnouncements', 2)).toBe(same);
    expect(clearOverride({}, 'unreadAnnouncements')).toEqual({});
  });
});

describe('the Announcements nav item', () => {
  it('carries the unread badge, worded "unread"', () => {
    const item = getProduct('people')!.sections.flatMap((s) => s.items).find((i) => i.slug === 'announcements');
    expect(item?.badge).toBe('unreadAnnouncements');
    expect(item?.badgeLabel).toBe('unread');
    expect(badgeAriaLabel(3, item?.badgeLabel)).toBe('3 unread');
  });
  it('words the other badge "waiting" unless told otherwise', () => {
    expect(badgeAriaLabel(2)).toBe('2 waiting');
  });
});

describe('the mark-read effect', () => {
  const ok = async () => ({ ok: true });
  it('calls once and refreshes once when React runs the effect twice', async () => {
    const flag = { current: false };
    let calls = 0;
    let refreshes = 0;
    const call = async () => {
      calls += 1;
      return { ok: true };
    };
    const results = [await markReadOnce(flag, call, () => (refreshes += 1)), await markReadOnce(flag, call, () => (refreshes += 1))];
    expect(results).toEqual(['refreshed', 'skipped']);
    expect([calls, refreshes]).toEqual([1, 1]);
  });
  it('does not refresh when the server refused or the call failed', async () => {
    let refreshes = 0;
    expect(await markReadOnce({ current: false }, async () => ({ ok: false }), () => (refreshes += 1))).toBe('not-marked');
    expect(
      await markReadOnce({ current: false }, async () => {
        throw new Error('offline');
      }, () => (refreshes += 1)),
    ).toBe('not-marked');
    expect(refreshes).toBe(0);
    expect(await markReadOnce({ current: false }, ok, () => {})).toBe('refreshed');
  });
});

describe('what each screen draws for each kind of viewer', () => {
  const kinds: [string, { isHr: boolean; isDemo: boolean }, boolean][] = [
    ['owner', { isHr: true, isDemo: false }, true],
    ['admin', { isHr: true, isDemo: false }, true],
    ['member', { isHr: false, isDemo: false }, false],
    ['viewer', { isHr: false, isDemo: false }, false],
    ['unlinked account', { isHr: false, isDemo: false }, false],
    ['demo visitor', { isHr: false, isDemo: true }, false],
    ['demo admin', { isHr: true, isDemo: true }, false],
  ];
  for (const [name, viewer, write] of kinds) {
    it(`${name}: write controls ${write ? 'drawn' : 'absent'} on both screens`, () => {
      expect(reviewScreenControls(viewer, true).write).toBe(write);
      expect(announcementsScreenControls(viewer, true, 0).write).toBe(write);
    });
    it(`${name}: marks read only outside the demo with something unread`, () => {
      expect(announcementsScreenControls(viewer, true, 2).markRead).toBe(!viewer.isDemo);
      expect(announcementsScreenControls(viewer, true, 0).markRead).toBe(false);
    });
  }
  it('draws nothing when the data did not load', () => {
    expect(reviewScreenControls({ isHr: true, isDemo: false }, false).write).toBe(false);
    expect(announcementsScreenControls({ isHr: true, isDemo: false }, false, 3)).toEqual({ write: false, markRead: false });
  });
});

/** Every local module an entry reaches, transitively, with its source. */
function reachable(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);
    // The member action's module also defines the owner-only ones: look at what is imported from it, not behind it.
    if (file.endsWith('announcement-actions.ts')) continue;
    for (const m of source.matchAll(/(?:import|export)\s[^;]*?from\s+'([^']+)'|import\s+'([^']+)'/g)) {
      const spec = m[1] ?? m[2];
      const base = spec.startsWith('@/') ? join(resolve('src'), spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(file), spec) : null;
      if (!base) continue;
      const found = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((e) => base + e).find((p) => existsSync(p));
      if (found) queue.push(found);
    }
  }
  return seen;
}

const OWNER_ONLY_FILES = /review-form|review-row-controls|announcement-form|announcement-row-controls|performance-actions|-writes\.ts/;

/** Every action that asks for an owner or admin, read from the action files (their body calls `asAdmin`). */
function ownerOnlyActions(): string[] {
  return ['src/app/(app)/people/performance-actions.ts', 'src/app/(app)/people/announcement-actions.ts'].flatMap((file) =>
    readFileSync(resolve(file), 'utf8')
      .split('export async function ')
      .slice(1)
      .filter((chunk) => chunk.includes('asAdmin('))
      .map((chunk) => chunk.slice(0, chunk.indexOf('('))),
  );
}

describe('components written for members name no owner-only action', () => {
  const names = ownerOnlyActions();
  it('finds the owner-only actions in the action files', () => {
    expect(names).toEqual(expect.arrayContaining(['saveReviewAction', 'releaseReviewAction', 'publishAnnouncementAction', 'deleteAnnouncementAction']));
    expect(names).not.toContain('markAnnouncementsReadAction');
    expect(names).not.toContain('saveMyGoalAction');
  });
  for (const entry of ['src/screens/people/scorecard.tsx', 'src/components/people/mark-announcements-read.tsx']) {
    const graph = reachable(resolve(entry));
    it(`${entry} reaches a real set of modules`, () => {
      expect(graph.size).toBeGreaterThan(2);
    });
    it(`${entry} imports no owner-only component or write path, and names no owner-only action`, () => {
      for (const [file, source] of graph) {
        if (file.endsWith('announcement-actions.ts')) continue; // the boundary: only the member action is imported from it
        expect(file, file).not.toMatch(OWNER_ONLY_FILES);
        for (const name of names) expect(source, `${file} names ${name}`).not.toContain(name);
      }
    });
  }
  it('the mark-read component imports exactly one action from the shared module', () => {
    const source = readFileSync(resolve('src/components/people/mark-announcements-read.tsx'), 'utf8');
    const named = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*announcement-actions'/g)].flatMap((m) =>
      m[1].split(',').map((s) => s.trim()).filter(Boolean),
    );
    expect(named).toEqual(['markAnnouncementsReadAction']);
  });
});
