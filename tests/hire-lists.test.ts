// tests/hire-lists.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildApplicationsModel,
  buildBoardModel,
  buildCareersModel,
  buildInterviewsModel,
  buildJobsModel,
  buildPoolModel,
  safeLink,
} from '@/lib/hire/lists';
import { createSeedHireData } from '@/lib/hire/seed';
import type { Application, Candidate, HireData, Job } from '@/lib/hire/types';

const NOW = new Date('2026-10-10T04:00:00Z');
const data = createSeedHireData(NOW);
const EMPTY: HireData = {
  listJobs: async () => [],
  listCandidates: async () => [],
  listApplications: async () => [],
  listInterviews: async () => [],
  getSettings: async () => ({ org_id: null, careers_enabled: false, careers_headline: null, careers_tagline: null, require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false }),
};

describe('jobs', () => {
  it('lists every job with its applicants and status', async () => {
    const model = await buildJobsModel(data, NOW);
    expect(model.rows).toHaveLength(9);
    expect(model.totalApplicants).toBe(248);
    expect(model.openJobs).toBe(6);
    expect(model.rows.find((r) => r.title === 'Software Engineer')).toMatchObject({ applicants: 56, status: 'Open', dept: 'Engineering' });
    expect(model.rows.find((r) => r.title === 'Marketing Lead')).toMatchObject({ applicants: 0, status: 'Draft', posted: '—' });
    expect(model.statusMix.map((s) => [s.key, s.value])).toEqual([['open', 6], ['paused', 1], ['closed', 1], ['draft', 1]]);
    expect(model.byJob).toHaveLength(6);
  });

  it('charts no bars for open jobs that have no applications', async () => {
    const job = (id: string): Job => ({
      id, title: id, department: null, location: null, employment_type: 'full_time', status: 'open',
      description: null, salary_min_cents: null, salary_max_cents: null, show_salary: false, closes_on: null,
      work_arrangement: null, headcount: 1,
      opened_at: '2026-09-01T00:00:00Z', closed_at: null, created_at: '2026-09-01T00:00:00Z',
    });
    const model = await buildJobsModel({ ...EMPTY, listJobs: async () => [job('j1'), job('j2')] }, NOW);
    expect(model.openJobs).toBe(2);
    expect(model.byJob).toEqual([]);
  });

  it('gives an unrated application a null rating on the board', async () => {
    const base: Application = {
      id: 'a1', candidate_id: 'c1', job_id: 'j1', candidate_name: 'Aina', job_title: 'Role', stage: 'applied',
      outcome: 'active', rating: null, source: null, applied_at: '2026-10-01T00:00:00Z', offered_at: null,
      hired_at: null, created_at: '2026-10-01T00:00:00Z',
      cover_letter: null, cv_url: null, cv_path: null, portfolio_url: null, expected_salary_cents: null, consented_at: null, reject_reason: null,
    };
    const board = await buildBoardModel(
      { ...EMPTY, listApplications: async () => [base, { ...base, id: 'a2', rating: 4 }] },
      NOW,
    );
    const ratings = board.stages.flatMap((s) => s.candidates).map((c) => [c.id, c.rating]);
    expect(ratings).toEqual([['a1', null], ['a2', 4]]);
  });
});

describe('careers page', () => {
  it('shows open jobs as Open while the board is off, closed as Closed, the rest as Draft', async () => {
    const model = await buildCareersModel(data);
    expect(model.openRoles).toBe(6);
    expect(model.publishedRoles).toBe(0);
    expect(model.rows.find((r) => r.title === 'Content Writer')?.status).toBe('Closed');
    expect(model.rows.find((r) => r.title === 'Accountant')?.status).toBe('Draft');
    expect(model.rows.find((r) => r.title === 'Customer Support')).toMatchObject({ type: 'Part-time', status: 'Open' });
  });
  it('carries the whole job for editing, and ids for the careers actions', async () => {
    const jobs = await buildJobsModel(data, NOW);
    expect(jobs.rows[0].job).toMatchObject({ id: jobs.rows[0].id, title: jobs.rows[0].title });
    const careers = await buildCareersModel(data);
    expect(careers.rows.every((r) => typeof r.id === 'string' && typeof r.jobStatus === 'string')).toBe(true);
  });
});

describe('careers page: what the public board lists', () => {
  const job = (id: string, over: Partial<Job>): Job => ({
    id, title: id, department: null, location: null, employment_type: 'full_time', status: 'open',
    description: 'What you will do.', salary_min_cents: null, salary_max_cents: null, show_salary: false, closes_on: null,
    work_arrangement: null, headcount: 1,
    opened_at: '2026-09-01T00:00:00Z', closed_at: null, created_at: '2026-09-01T00:00:00Z',
    ...over,
  });
  const settings = { org_id: 'org-1', careers_enabled: true, careers_headline: 'Work with us', careers_tagline: null, require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };

  it('carries the settings from the provider', async () => {
    const model = await buildCareersModel({ ...EMPTY, getSettings: async () => settings });
    expect(model.settings).toEqual(settings);
    expect((await buildCareersModel(EMPTY)).settings.careers_enabled).toBe(false);
  });

  it('shows open jobs with a description, newest opened first', async () => {
    const jobs = [
      job('Older', { opened_at: '2026-09-01T00:00:00Z', location: 'Shah Alam' }),
      job('Draft', { status: 'draft', opened_at: null }),
      job('Paused', { status: 'paused' }),
      job('Blank', { description: '   \n ' }),
      job('None', { description: null }),
      job('Closed', { status: 'closed' }),
      job('Newer', { opened_at: '2026-10-05T00:00:00Z' }),
    ];
    // The busiest job is not first: the order is by opening date, not by applicants.
    const app = (id: string): Application => ({
      id, candidate_id: id, job_id: 'Older', candidate_name: 'Aina', job_title: 'Older', stage: 'applied',
      outcome: 'active', rating: null, source: null, applied_at: '2026-10-01T00:00:00Z', offered_at: null,
      hired_at: null, created_at: '2026-10-01T00:00:00Z',
      cover_letter: null, cv_url: null, cv_path: null, portfolio_url: null, expected_salary_cents: null, consented_at: null, reject_reason: null,
    });
    const model = await buildCareersModel({
      ...EMPTY, listJobs: async () => jobs, listApplications: async () => [app('a1'), app('a2')],
    });
    expect(model.showing).toEqual([
      { title: 'Newer', location: '' },
      { title: 'Older', location: 'Shah Alam' },
    ]);
    expect(model.rows).toHaveLength(7);
  });

  describe('the status each row carries', () => {
    const jobs = [
      job('Described', {}),
      job('Blank', { description: '  ' }),
      job('Closed', { status: 'closed' }),
      job('Draft', { status: 'draft' }),
      job('Paused', { status: 'paused' }),
    ];
    const statuses = async (careers_enabled: boolean) => {
      const model = await buildCareersModel({
        ...EMPTY, listJobs: async () => jobs, getSettings: async () => ({ ...settings, careers_enabled }),
      });
      return { model, byTitle: Object.fromEntries(model.rows.map((r) => [r.title, r.status])) };
    };

    it('reads Open for every open job while the board is off', async () => {
      const { model, byTitle } = await statuses(false);
      expect(byTitle).toEqual({ Described: 'Open', Blank: 'Open', Closed: 'Closed', Draft: 'Draft', Paused: 'Draft' });
      expect(model.publishedRoles).toBe(0);
      expect(model.openRoles).toBe(2);
    });

    it('reads Published only for an open job with a description while the board is on', async () => {
      const { model, byTitle } = await statuses(true);
      expect(byTitle).toEqual({ Described: 'Published', Blank: 'Open', Closed: 'Closed', Draft: 'Draft', Paused: 'Draft' });
      expect(model.publishedRoles).toBe(1);
      expect(model.openRoles).toBe(2);
    });
  });

  it('lists nothing for a workspace with no jobs', async () => {
    expect((await buildCareersModel(EMPTY)).showing).toEqual([]);
  });
});

describe('candidates board', () => {
  it('puts live applications in their stage and counts the rest', async () => {
    const model = await buildBoardModel(data, NOW);
    expect(model.stages.map((s) => s.name)).toEqual(['Applied', 'Screening', 'Interview', 'Offer', 'Hired']);
    expect(model.hired).toBe(2);
    expect(model.offers).toBe(2);
    expect(model.total).toBe(model.inPipeline + model.hired);
    expect(model.stages.every((s) => s.candidates.length <= 50)).toBe(true);
    expect(model.funnel.map((f) => f.value)).toEqual([248, 96, 38, 4, 2]);
    expect(model.stages.reduce((sum, s) => sum + s.count, 0)).toBe(model.total);
    expect(model.stages.find((s) => s.key === 'offer')?.count).toBe(2);
    expect(model.stages.find((s) => s.key === 'hired')?.count).toBe(2);
  });
});

describe('applications list', () => {
  it('labels each application and counts the labels over everything', async () => {
    const model = await buildApplicationsModel(data);
    expect(model.total).toBe(248);
    expect(model.rows).toHaveLength(50);
    expect(model.statusMix.reduce((sum, s) => sum + s.value, 0)).toBe(248);
    expect(model.statusMix.map((s) => s.key)).toEqual(['New', 'In review', 'Shortlisted', 'Rejected']);
    expect(model.rows[0].applied).toMatch(/^\d{2} \w{3} \d{4}$/);
  });
});

describe('what a row carries for the controls that change an application', () => {
  const PATH = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.pdf';
  const app = (over: Partial<Application>): Application => ({
    id: 'a1', candidate_id: 'c1', job_id: 'j1', candidate_name: 'Aina Rahman', job_title: 'Barista', stage: 'interview',
    outcome: 'active', rating: 4, source: null, applied_at: '2026-10-01T00:00:00Z', offered_at: null,
    hired_at: null, created_at: '2026-10-01T00:00:00Z', cover_letter: 'Hello', cv_url: null, cv_path: PATH,
    portfolio_url: null, expected_salary_cents: null, consented_at: null, reject_reason: null,
    ...over,
  });
  const apps = [
    app({}),
    app({ id: 'a2', stage: 'screening', outcome: 'rejected', rating: null, reject_reason: 'experience' }),
    app({ id: 'a3', stage: 'hired', outcome: 'withdrawn', rating: 2 }),
  ];
  const source: HireData = { ...EMPTY, listApplications: async () => apps };
  /** Every key anywhere inside a value. */
  const keysOf = (value: unknown): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
      : [];

  it('gives each row of the list its stage, outcome, rating and reason', async () => {
    const { rows } = await buildApplicationsModel(source);
    expect(rows.map((r) => [r.id, r.stage, r.outcome, r.rating, r.rejectReason])).toEqual([
      ['a1', 'interview', 'active', 4, null],
      ['a2', 'screening', 'rejected', null, 'experience'],
      ['a3', 'hired', 'withdrawn', 2, null],
    ]);
    // The pill still follows the label.
    expect(rows.map((r) => r.status)).toEqual(['Shortlisted', 'Rejected', 'Rejected']);
  });

  it('gives each card of the board its stage, outcome, rating and reason', async () => {
    const board = await buildBoardModel(source, NOW);
    const cards = board.stages.flatMap((s) => s.candidates);
    // The board lists live applications only.
    expect(cards.map((c) => [c.id, c.stage, c.outcome, c.rating, c.rejectReason])).toEqual([
      ['a1', 'interview', 'active', 4, null],
    ]);
    for (const stage of board.stages) for (const card of stage.candidates) expect(card.stage).toBe(stage.key);
  });

  it('carries no storage path and no contact details on either screen', async () => {
    const list = (await buildApplicationsModel(source)).rows;
    const board = (await buildBoardModel(source, NOW)).stages.flatMap((s) => s.candidates);
    for (const rows of [list, board]) {
      expect(JSON.stringify(rows)).not.toContain(PATH);
      const keys = keysOf(rows).map((key) => key.toLowerCase());
      for (const word of ['cv_path', 'cvpath', 'path', 'email', 'phone']) {
        expect(keys.filter((key) => key.includes(word))).toEqual([]);
      }
    }
  });

  it('gives each row and each card the id of its candidate, for the Edit candidate form', async () => {
    const mixed: HireData = { ...EMPTY, listApplications: async () => [app({}), app({ id: 'a4', candidate_id: 'c2', stage: 'offer' })] };
    expect((await buildApplicationsModel(mixed)).rows.map((r) => [r.id, r.candidateId])).toEqual([['a1', 'c1'], ['a4', 'c2']]);
    const cards = (await buildBoardModel(mixed, NOW)).stages.flatMap((s) => s.candidates);
    expect(cards.map((c) => [c.id, c.candidateId])).toEqual([['a1', 'c1'], ['a4', 'c2']]);
  });
});

describe('the jobs the Add Candidate form can pick from', () => {
  const job = (title: string, status: Job['status']): Job => ({
    id: `id-${title}`, title, department: null, location: null, employment_type: 'full_time', status,
    description: null, salary_min_cents: null, salary_max_cents: null, show_salary: false, closes_on: null,
    work_arrangement: null, headcount: 1,
    opened_at: '2026-09-01T00:00:00Z', closed_at: null, created_at: '2026-09-01T00:00:00Z',
  });

  it('lists open and paused jobs only, by title, as an id and a title and nothing else', async () => {
    const board = await buildBoardModel({
      ...EMPTY,
      listJobs: async () => [job('Cashier', 'paused'), job('Writer', 'closed'), job('Lead', 'draft'), job('Barista', 'open')],
    }, NOW);
    expect(board.jobs).toEqual([{ id: 'id-Barista', title: 'Barista' }, { id: 'id-Cashier', title: 'Cashier' }]);
  });

  it('is there for a workspace with no applications, and empty for one with no jobs', async () => {
    const board = await buildBoardModel({ ...EMPTY, listJobs: async () => [job('Barista', 'open')] }, NOW);
    expect(board.isEmpty).toBe(true);
    expect(board.jobs).toEqual([{ id: 'id-Barista', title: 'Barista' }]);
    expect((await buildBoardModel(EMPTY, NOW)).jobs).toEqual([]);
  });

  it('counts seven for the sample data: six open and one paused', async () => {
    const board = await buildBoardModel(data, NOW);
    expect(board.jobs).toHaveLength(7);
    expect(board.jobs.map((j) => j.title)).toEqual([...board.jobs.map((j) => j.title)].sort((a, b) => a.localeCompare(b)));
  });
});

describe('safeLink', () => {
  it('gives the address and its host for an http or https link', () => {
    expect(safeLink('https://drive.google.com/file/d/abc')).toEqual({ href: 'https://drive.google.com/file/d/abc', host: 'drive.google.com' });
    expect(safeLink('http://example.com')).toEqual({ href: 'http://example.com/', host: 'example.com' });
  });
  it('gives nothing for anything else, so it can never become a link', () => {
    for (const bad of [null, '', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:x', 'data:text/html,x', 'ftp://x.y', 'not a url', '//example.com', ' https://example.com']) {
      expect(safeLink(bad as string | null), String(bad)).toBeNull();
    }
  });
  it('refuses a link that carries a username or password, where the name shown would not be the whole story', () => {
    // What looks like good.com is really a login name for evil.com.
    expect(safeLink('https://good.com@evil.com/cv')).toBeNull();
    expect(safeLink('https://user:secret@example.com/cv')).toBeNull();
  });
  it('shows the host a loosely written link really goes to', () => {
    expect(safeLink('http:example.com')).toEqual({ href: 'http://example.com/', host: 'example.com' });
    expect(safeLink('https:/example.com/cv')).toEqual({ href: 'https://example.com/cv', host: 'example.com' });
  });
});

describe('application details', () => {
  const withDetails = async (over: Partial<Application>) => {
    const [seeded] = await data.listApplications();
    const model = await buildApplicationsModel({ ...EMPTY, listApplications: async () => [{ ...seeded, ...over }] });
    return model.rows[0];
  };
  it('gives the letter, both links and the salary', async () => {
    const row = await withDetails({
      cover_letter: 'Dear team,\nI would love to join.',
      cv_url: 'https://drive.google.com/file/d/abc',
      portfolio_url: 'https://aina.example.com/work',
      expected_salary_cents: 350000,
    });
    expect(row.details).toEqual({
      coverLetter: 'Dear team,\nI would love to join.',
      cv: { href: 'https://drive.google.com/file/d/abc', host: 'drive.google.com' },
      hasCvFile: false,
      portfolio: { href: 'https://aina.example.com/work', host: 'aina.example.com' },
      expectedSalary: 'RM 3,500 a month',
    });
  });
  it('has a file and nothing else when only cv_path is set, and never carries the path', async () => {
    const path = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.pdf';
    const row = await withDetails({ cv_path: path });
    expect(row.details).toEqual({ coverLetter: null, cv: null, hasCvFile: true, portfolio: null, expectedSalary: null });
    for (const [key, value] of Object.entries(row.details!)) {
      expect(key.includes(path)).toBe(false);
      expect(String(value).includes(path)).toBe(false);
    }
    expect(JSON.stringify(row)).not.toContain(path);
    expect('cv_path' in row).toBe(false);
  });
  it('gives null when none of the five was given', async () => {
    expect((await withDetails({ cv_path: null })).details).toBeNull();
  });
  it('gives null when none of the four was given', async () => {
    expect((await withDetails({})).details).toBeNull();
  });
  it('never turns a stored value that is not http(s) into a link', async () => {
    const row = await withDetails({ cv_url: 'javascript:alert(1)', cover_letter: 'Hello' });
    expect(row.details?.cv).toBeNull();
    expect(row.details?.coverLetter).toBe('Hello');
  });
  it('gives null when the only thing stored is a link that is not safe', async () => {
    expect((await withDetails({ cv_url: 'javascript:alert(1)' })).details).toBeNull();
  });
});

describe('interviews', () => {
  it('lists interviews with the counts by status', async () => {
    const model = await buildInterviewsModel(data, NOW);
    expect(model.rows).toHaveLength(10);
    expect(model).toMatchObject({ scheduled: 6, completed: 3, noShow: 1, next7Days: 6 });
    // NOW is a Saturday, so some of the six fall on the weekend and are not in the weekday chart.
    const expected: Record<string, number> = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 };
    for (const i of await data.listInterviews()) {
      const at = Date.parse(i.scheduled_at);
      if (i.status !== 'scheduled' || at < NOW.getTime() || at >= NOW.getTime() + 7 * 86_400_000) continue;
      const day = new Date(i.scheduled_at).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Kuala_Lumpur' });
      if (day in expected) expected[day] += 1;
    }
    expect(model.weekLoad.map((d) => d.count)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d) => expected[d]));
    expect(model.weekLoad.reduce((sum, d) => sum + d.count, 0)).toBeGreaterThan(0);
    expect(model.weekLoad.map((d) => d.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(model.rows[0]).toMatchObject({ status: 'Scheduled' });
  });
});

describe('talent pool', () => {
  it('lists only people in the pool', async () => {
    const model = await buildPoolModel(data);
    expect(model.size).toBeGreaterThanOrEqual(94);
    expect(model.rows.length).toBeLessThanOrEqual(50);
    expect(model.rows.every((r) => ['Available', 'Shortlisted', 'Passive', 'Re-engaged'].includes(r.status))).toBe(true);
  });

  it('totals the whole pool by status, headline and source', async () => {
    const model = await buildPoolModel(data);
    const sum = (list: { value: number }[]) => list.reduce((a, b) => a + b.value, 0);
    expect(model.statusCounts.map((s) => s.key)).toEqual(['Available', 'Shortlisted', 'Passive', 'Re-engaged']);
    expect(sum(model.statusCounts)).toBe(model.size);
    expect(sum(model.byTitle)).toBe(model.size);
    expect(sum(model.bySource)).toBe(model.size);
  });

  const cand = (id: string, pool_status: Candidate['pool_status']): Candidate => ({
    id, name: id, email: null, phone: null, headline: null, location: null, skills: [], source: null,
    pool_status, created_at: '2026-01-01T00:00:00Z',
  });
  const app = (id: string, candidate_id: string, over: Partial<Application>): Application => ({
    id, candidate_id, job_id: 'j1', candidate_name: candidate_id, job_title: 'Role', stage: 'applied', outcome: 'active',
    rating: null, source: null, applied_at: '2026-10-01T00:00:00Z', offered_at: null, hired_at: null,
    created_at: '2026-10-01T00:00:00Z',
    cover_letter: null, cv_url: null, cv_path: null, portfolio_url: null, expected_salary_cents: null, consented_at: null, reject_reason: null, ...over,
  });
  const small: HireData = {
    ...EMPTY,
    listCandidates: async () => [
      cand('outsider', 'none'),
      cand('interviewee', 'available'),
      cand('offered', 'passive'),
      cand('hiree', 're_engaged'),
      cand('rejected', 'passive'),
      cand('rated', 'available'),
      cand('unrated', 'available'),
    ],
    listApplications: async () => [
      app('a0', 'outsider', { stage: 'interview' }),
      app('a1', 'interviewee', { stage: 'interview' }),
      app('a2', 'offered', { stage: 'offer' }),
      app('a3', 'hiree', { stage: 'hired' }),
      app('a4', 'rejected', { stage: 'interview', outcome: 'rejected' }),
      app('a5', 'rated', { rating: 3 }),
      app('a6', 'rated', { rating: 5 }),
      app('a7', 'rated', { rating: 4 }),
    ],
  };

  it('leaves out people with pool_status none', async () => {
    const model = await buildPoolModel(small);
    expect(model.size).toBe(6);
    expect(model.rows.map((r) => r.id)).not.toContain('outsider');
  });

  it('shows Shortlisted for a live application at interview or beyond, and the pool label otherwise', async () => {
    const byId = Object.fromEntries((await buildPoolModel(small)).rows.map((r) => [r.id, r.status]));
    expect(byId).toMatchObject({
      interviewee: 'Shortlisted', offered: 'Shortlisted', hiree: 'Shortlisted',
      rejected: 'Passive', rated: 'Available', unrated: 'Available',
    });
  });

  it('counts Shortlisted and leaves out none over the whole pool', async () => {
    const model = await buildPoolModel(small);
    expect(model.statusCounts).toEqual([
      { key: 'Available', value: 2 },
      { key: 'Shortlisted', value: 3 },
      { key: 'Passive', value: 1 },
      { key: 'Re-engaged', value: 0 },
    ]);
    expect(model.byTitle).toEqual([{ label: '—', value: 6 }]);
    expect(model.bySource).toEqual([{ label: 'Unknown', value: 6 }]);
  });

  it('rates by the best application, and null when none is rated', async () => {
    const byId = Object.fromEntries((await buildPoolModel(small)).rows.map((r) => [r.id, r.rating]));
    expect(byId.rated).toBe(5);
    expect(byId.unrated).toBeNull();
    expect(byId.interviewee).toBeNull();
  });
});

/** Every number inside a model, however deep. */
function numbers(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbers);
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbers);
  return [];
}

describe('an empty workspace', () => {
  it('gives zeros and empty lists, not errors', async () => {
    const jobs = await buildJobsModel(EMPTY, NOW);
    expect(jobs).toMatchObject({ isEmpty: true, rows: [], byJob: [], totalApplicants: 0, openJobs: 0 });
    expect(jobs.statusMix.map((s) => [s.key, s.value])).toEqual([['open', 0], ['paused', 0], ['closed', 0], ['draft', 0]]);

    const careers = await buildCareersModel(EMPTY);
    expect(careers).toMatchObject({ isEmpty: true, rows: [], openRoles: 0 });

    const board = await buildBoardModel(EMPTY, NOW);
    expect(board).toMatchObject({ isEmpty: true, total: 0, hired: 0, inPipeline: 0, interviewing: 0, offers: 0 });
    expect(board.stages).toHaveLength(5);
    expect(board.stages.every((s) => s.candidates.length === 0 && s.count === 0)).toBe(true);
    expect(board.funnel).toHaveLength(5);
    expect(board.funnel.every((f) => f.value === 0)).toBe(true);
    expect(board.trend).toHaveLength(8);
    expect(board.trend.every((t) => t.applied === 0 && t.shortlisted === 0)).toBe(true);

    const apps = await buildApplicationsModel(EMPTY);
    expect(apps).toMatchObject({ isEmpty: true, total: 0, rows: [], byJob: [] });
    expect(apps.statusMix.map((s) => [s.key, s.value])).toEqual([['New', 0], ['In review', 0], ['Shortlisted', 0], ['Rejected', 0]]);

    const interviews = await buildInterviewsModel(EMPTY, NOW);
    expect(interviews).toMatchObject({ isEmpty: true, rows: [], scheduled: 0, completed: 0, noShow: 0, next7Days: 0 });
    expect(interviews.weekLoad).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((label) => ({ label, count: 0 })));

    const pool = await buildPoolModel(EMPTY);
    expect(pool).toMatchObject({ isEmpty: true, size: 0, rows: [], byTitle: [], bySource: [] });
    expect(pool.statusCounts.map((s) => [s.key, s.value])).toEqual([['Available', 0], ['Shortlisted', 0], ['Passive', 0], ['Re-engaged', 0]]);
  });

  it('has only finite numbers in every empty model', async () => {
    const models = [
      await buildJobsModel(EMPTY, NOW),
      await buildCareersModel(EMPTY),
      await buildBoardModel(EMPTY, NOW),
      await buildApplicationsModel(EMPTY),
      await buildInterviewsModel(EMPTY, NOW),
      await buildPoolModel(EMPTY),
    ];
    for (const model of models) {
      const leaves = numbers(model);
      expect(leaves.length).toBeGreaterThan(0);
      expect(leaves.every(Number.isFinite)).toBe(true);
    }
  });
});
