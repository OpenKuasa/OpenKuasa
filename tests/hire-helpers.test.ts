// tests/hire-helpers.test.ts
import { describe, expect, it } from 'vitest';
import {
  applicationLabel,
  boardCounts,
  funnelCounts,
  groupByStage,
  matchesText,
} from '@/lib/hire/applications-view';
import { ago, buildHireDashboardModel, timeToHire, timeToHireByMonth, recentActivity } from '@/lib/hire/dashboard';
import {
  applicantsByJob,
  applicationsPerWeek,
  buildHireOverviewModel,
  overviewTotals,
  sourceBreakdown,
  topCandidates,
  upcomingInterviews,
} from '@/lib/hire/overview';
import { createSeedHireData } from '@/lib/hire/seed';
import type { Application, HireData } from '@/lib/hire/types';

const NOW = new Date('2026-10-10T04:00:00Z');
const data = createSeedHireData(NOW);
const EMPTY: HireData = {
  listJobs: async () => [],
  listCandidates: async () => [],
  listApplications: async () => [],
  listInterviews: async () => [],
  getSettings: async () => ({ org_id: null, careers_enabled: false, careers_headline: null, careers_tagline: null, require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false }),
};
const app = (over: Partial<Application>): Application => ({
  id: 'a', candidate_id: 'c', job_id: 'j', candidate_name: 'A', job_title: 'J', stage: 'applied',
  outcome: 'active', rating: null, source: null, applied_at: '2026-10-01T00:00:00Z',
  offered_at: null, hired_at: null, created_at: '2026-10-01T00:00:00Z',
  cover_letter: null, cv_url: null, cv_path: null, portfolio_url: null, expected_salary_cents: null, consented_at: null, reject_reason: null, ...over,
});

// JSON.stringify turns NaN and Infinity into null, so walk the value instead.
const numbersIn = (value: unknown): number[] =>
  typeof value === 'number'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(numbersIn)
      : value !== null && typeof value === 'object'
        ? Object.values(value).flatMap(numbersIn)
        : [];

describe('applicationLabel', () => {
  it('labels every stage and outcome pair', () => {
    expect(applicationLabel('applied', 'active')).toBe('New');
    expect(applicationLabel('screening', 'active')).toBe('In review');
    expect(applicationLabel('interview', 'active')).toBe('Shortlisted');
    expect(applicationLabel('offer', 'active')).toBe('Shortlisted');
    expect(applicationLabel('hired', 'active')).toBe('Shortlisted');
    for (const stage of ['applied', 'screening', 'interview', 'offer', 'hired'] as const) {
      expect(applicationLabel(stage, 'rejected')).toBe('Rejected');
      expect(applicationLabel(stage, 'withdrawn')).toBe('Rejected');
    }
  });
});

describe('funnel and board', () => {
  it('counts the funnel cumulatively, whatever the outcome', async () => {
    expect(funnelCounts(await data.listApplications())).toEqual({
      applied: 248, screening: 96, interview: 38, offer: 4, hired: 2,
    });
  });
  it('counts the board by current stage, active only', async () => {
    const apps = await data.listApplications();
    const board = boardCounts(apps);
    expect(board.offer).toBe(2);
    expect(board.hired).toBe(2);
    expect(Object.values(board).reduce((a, b) => a + b, 0)).toBe(apps.filter((a) => a.outcome === 'active').length);
    expect(board.applied).toBeLessThan(152);
  });
  it('groups active applications by stage, and has all five keys when empty', () => {
    expect(groupByStage([])).toEqual({ applied: [], screening: [], interview: [], offer: [], hired: [] });
    const grouped = groupByStage([app({ id: '1' }), app({ id: '2', outcome: 'rejected' })]);
    expect(grouped.applied.map((a) => a.id)).toEqual(['1']);
  });
  it('matches text loosely, and everything when there is no query', () => {
    expect(matchesText('Sales Executive', 'sales exec')).toBe(true);
    expect(matchesText('Sales Executive', '  SALES  ')).toBe(true);
    expect(matchesText('Sales Executive', 'plumber')).toBe(false);
    expect(matchesText(null, 'sales')).toBe(false);
    expect(matchesText('Sales Executive', undefined)).toBe(true);
    expect(matchesText(null, '')).toBe(true);
  });
});

describe('overview numbers', () => {
  it('totals the seed', async () => {
    const [jobs, apps, interviews] = await Promise.all([data.listJobs(), data.listApplications(), data.listInterviews()]);
    expect(overviewTotals(jobs, apps, interviews, NOW)).toMatchObject({
      applications: 248, open_jobs: 6, interviews_next_7_days: 6, offers_out: 2, hires_last_30_days: 2,
    });
  });
  it('does not count a hire dated after now', () => {
    const future = app({ stage: 'hired', hired_at: '2026-10-11T04:00:00Z' });
    expect(overviewTotals([], [future], [], NOW).hires_last_30_days).toBe(0);
  });
  it('spreads applications over 8 weeks, oldest first, summing to the total', async () => {
    const trend = applicationsPerWeek(await data.listApplications(), NOW);
    expect(trend.map((w) => w.label)).toEqual(['Wk1', 'Wk2', 'Wk3', 'Wk4', 'Wk5', 'Wk6', 'Wk7', 'Wk8']);
    expect(trend.reduce((sum, w) => sum + w.applied, 0)).toBe(248);
    expect(trend.reduce((sum, w) => sum + w.shortlisted, 0)).toBe(38);
  });
  it('breaks applications and hires down by source, biggest first', async () => {
    const rows = sourceBreakdown(await data.listApplications());
    expect(rows.map((r) => [r.source, r.applications])).toEqual([
      ['JobStreet', 104], ['LinkedIn', 72], ['Referral', 44], ['Careers page', 28],
    ]);
    expect(rows.reduce((sum, r) => sum + r.hires, 0)).toBe(2);
  });
  it('files an application with no source under Unknown', () => {
    expect(sourceBreakdown([app({ source: null })])).toEqual([{ source: 'Unknown', applications: 1, hires: 0 }]);
  });
  it('ranks top candidates by rating among active, rated applications', async () => {
    const top = topCandidates(await data.listApplications(), 5);
    expect(top).toHaveLength(5);
    expect(top.every((a) => a.outcome === 'active' && a.rating === 5)).toBe(true);
  });
  it('lists only scheduled interviews still ahead, soonest first', async () => {
    const next = upcomingInterviews(await data.listInterviews(), NOW, 3);
    expect(next).toHaveLength(3);
    expect(next.every((i) => i.status === 'scheduled' && Date.parse(i.scheduled_at) > NOW.getTime())).toBe(true);
    expect(next[0].scheduled_at < next[1].scheduled_at).toBe(true);
  });
  it('counts applicants per job, including a job with none', async () => {
    const rows = applicantsByJob(await data.listJobs(), await data.listApplications());
    expect(rows.find((r) => r.job.title === 'Software Engineer')?.applicants).toBe(56);
    expect(rows.find((r) => r.job.title === 'Marketing Lead')?.applicants).toBe(0);
  });
});

describe('dashboard numbers', () => {
  it('averages days to offer and to hire', async () => {
    const time = timeToHire(await data.listApplications());
    expect(time).toEqual({ days_to_offer: 18.5, days_to_hire: 27, offers: 4, hires: 2 });
  });
  it('gives null, not NaN, when nobody was offered or hired', () => {
    expect(timeToHire([app({})])).toEqual({ days_to_offer: null, days_to_hire: null, offers: 0, hires: 0 });
    expect(timeToHire([])).toEqual({ days_to_offer: null, days_to_hire: null, offers: 0, hires: 0 });
  });
  it('gives one row per month for the months asked, oldest first', async () => {
    const months = timeToHireByMonth(await data.listApplications(), NOW, 4);
    expect(months.map((m) => m.label)).toEqual(['Jul', 'Aug', 'Sep', 'Oct']);
    expect(months.some((m) => m.hire !== null)).toBe(true);
  });
  it('uses the Kuala Lumpur month for the window', () => {
    const months = timeToHireByMonth([], new Date('2026-09-30T18:00:00Z'), 4);
    expect(months[months.length - 1].label).toBe('Oct');
  });
  it('describes recent activity newest first', async () => {
    const activity = recentActivity(await data.listApplications(), await data.listInterviews(), NOW, 5);
    expect(activity).toHaveLength(5);
    expect(activity[0].text).toMatch(/applied|offer|hired|interview/i);
  });
  it('says how long ago', () => {
    expect(ago('2026-10-10T03:30:00Z', NOW)).toBe('30m');
    expect(ago('2026-10-10T01:00:00Z', NOW)).toBe('3h');
    expect(ago('2026-10-08T04:00:00Z', NOW)).toBe('2d');
    expect(ago('2026-10-10T05:00:00Z', NOW)).toBe('now');
  });
});

describe('models', () => {
  it('builds the overview model from the seed', async () => {
    const model = await buildHireOverviewModel(data, NOW);
    expect(model.isEmpty).toBe(false);
    expect(model.funnel.map((f) => f.value)).toEqual([248, 96, 38, 4, 2]);
    expect(model.interviews).toHaveLength(3);
    expect(model.top).toHaveLength(5);
  });
  it('gives each upcoming interview its date and its year: never a weekday alone, never Today or Tomorrow', async () => {
    const model = await buildHireOverviewModel(data, NOW);
    for (const i of model.interviews) {
      expect(i.when).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} (am|pm)$/);
    }
    // An interview five weeks off reads as its own day, not as "Thu".
    const far: HireData = {
      ...EMPTY,
      listInterviews: async () => [{ ...(await data.listInterviews())[0], status: 'scheduled', scheduled_at: '2026-11-19T07:00:00+00:00' }],
    };
    expect((await buildHireOverviewModel(far, NOW)).interviews.map((i) => i.when)).toEqual(['Thu 19 Nov 2026, 3:00 pm']);
  });
  it('builds empty models without NaN or a throw', async () => {
    const overview = await buildHireOverviewModel(EMPTY, NOW);
    expect(overview.isEmpty).toBe(true);
    expect(overview.totals).toEqual({ applications: 0, open_jobs: 0, active_applications: 0, interviews_next_7_days: 0, offers_out: 0, hires_last_30_days: 0 });
    expect(overview.funnel.map((f) => f.value)).toEqual([0, 0, 0, 0, 0]);
    const dashboard = await buildHireDashboardModel(EMPTY, NOW);
    expect(dashboard.isEmpty).toBe(true);
    expect(numbersIn(overview).every(Number.isFinite)).toBe(true);
    expect(numbersIn(dashboard).every(Number.isFinite)).toBe(true);
    expect(dashboard.time).toEqual({ days_to_offer: null, days_to_hire: null, offers: 0, hires: 0 });
    expect(dashboard.timeByMonth.every((m) => m.hire === null && m.offer === null)).toBe(true);
  });
});

describe('hires count only while the application is live', () => {
  const hired = (over: Partial<Application>) =>
    app({ stage: 'hired', applied_at: '2026-10-01T00:00:00Z', offered_at: '2026-10-05T00:00:00Z', hired_at: '2026-10-08T00:00:00Z', ...over });
  const live = hired({ id: 'live', candidate_name: 'Live One' });
  const withdrawn = hired({ id: 'gone', candidate_name: 'Gone One', outcome: 'withdrawn' });
  it('timeToHire and the monthly series count one hire, not two', () => {
    expect(timeToHire([live, withdrawn]).hires).toBe(1);
    expect(timeToHireByMonth([live, withdrawn], NOW, 1)[0].hire).toBe(7);
    const other = hired({ id: 'other', hired_at: '2026-10-10T00:00:00Z', outcome: 'rejected' });
    expect(timeToHireByMonth([live, other], NOW, 1)[0].hire).toBe(7);
  });
  it('still counts an offer that was later rejected', () => {
    const rejected = app({ stage: 'offer', outcome: 'rejected', offered_at: '2026-10-05T00:00:00Z' });
    expect(timeToHire([rejected]).offers).toBe(1);
    expect(timeToHireByMonth([rejected], NOW, 1)[0].offer).toBe(4);
  });
  it('hires_last_30_days counts the live one only', () => {
    expect(overviewTotals([], [live, withdrawn], [], NOW).hires_last_30_days).toBe(1);
  });
  it('has no hired line in recent activity for the withdrawn one', () => {
    const lines = recentActivity([live, withdrawn], [], NOW, 10).map((e) => e.text);
    expect(lines).toContain('Live One hired — J');
    expect(lines).not.toContain('Gone One hired — J');
  });
  it('hires by source skip the withdrawn one', () => {
    expect(sourceBreakdown([{ ...live, source: 'X' }, { ...withdrawn, source: 'X' }])[0]).toMatchObject({ applications: 2, hires: 1 });
  });
});
