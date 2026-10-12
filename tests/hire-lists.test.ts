// tests/hire-lists.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildApplicationsModel,
  buildPoolPicker,
  buildBoardModel,
  buildCareersModel,
  buildInterviewsModel,
  buildJobsModel,
  buildPoolModel,
  safeLink,
} from '@/lib/hire/lists';
import { createSeedHireData } from '@/lib/hire/seed';
import type { Application, Candidate, HireData, Interview, Job } from '@/lib/hire/types';

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
  it('carries the stored status beside the label, so a Shortlisted row can still show and change it', async () => {
    const byId = Object.fromEntries((await buildPoolModel(small)).rows.map((r) => [r.id, [r.status, r.poolStatus]]));
    expect(byId).toMatchObject({
      interviewee: ['Shortlisted', 'available'], offered: ['Shortlisted', 'passive'], hiree: ['Shortlisted', 're_engaged'],
      rejected: ['Passive', 'passive'], rated: ['Available', 'available'],
    });
  });

  it('carries the open and paused jobs, by title, each with its status', async () => {
    const job = (id: string, title: string, status: Job['status']): Job => ({
      id, title, department: null, location: null, employment_type: 'full_time', status,
      description: null, salary_min_cents: null, salary_max_cents: null, show_salary: false, closes_on: null,
      work_arrangement: null, headcount: 1, opened_at: null, closed_at: null, created_at: '2026-10-01T00:00:00Z',
    });
    const model = await buildPoolModel({
      ...small,
      listJobs: async () => [job('j3', 'Cashier', 'paused'), job('j1', 'Barista', 'open'), job('j2', 'Baker', 'closed'), job('j4', 'Driver', 'draft')],
    });
    expect(model.jobs).toEqual([{ id: 'j1', title: 'Barista', status: 'open' }, { id: 'j3', title: 'Cashier', status: 'paused' }]);
    expect((await buildPoolModel(small)).jobs).toEqual([]);
  });

  describe('search', () => {
    /** `n` pool members, newest first as the provider gives them; the last is the one put on file longest ago. */
    const person = (id: string, over: Partial<Candidate> = {}): Candidate => ({
      id, name: `Person ${id}`, email: `${id}@example.com`, phone: '+60 12-000 0000', headline: 'Sales Executive', location: 'Kuala Lumpur',
      skills: ['Excel'], source: 'LinkedIn', pool_status: 'available', created_at: '2026-01-01T00:00:00Z', ...over,
    });
    const sixty = [
      ...Array.from({ length: 59 }, (_, i) => person(`p${i + 1}`)),
      person('oldest', { name: 'Zarina binti Hashim', headline: 'Warehouse Supervisor', location: 'Klang', source: 'Referral', skills: ['Forklift'], pool_status: 'passive' }),
    ];
    const big: HireData = { ...EMPTY, listCandidates: async () => [person('outsider', { name: 'Zarina Outside', pool_status: 'none' }), ...sixty] };

    it('with no search draws the newest 50 and says so; the oldest member is not among them', async () => {
      const model = await buildPoolModel(big);
      expect(model).toMatchObject({ size: 60, matched: 60, search: null, readCapped: false });
      expect(model.rows).toHaveLength(50);
      expect(model.rows.map((r) => r.id)).not.toContain('oldest');
      // A blank search is no search.
      for (const blank of ['', '   ', null, undefined]) expect((await buildPoolModel(big, blank)).search).toBeNull();
    });
    it('finds the oldest member by name, though they are not among the 50 drawn', async () => {
      const model = await buildPoolModel(big, 'zarina binti hashim');
      expect(model.rows.map((r) => r.id)).toEqual(['oldest']);
      expect(model).toMatchObject({ matched: 1, search: 'zarina binti hashim', size: 60 });
    });
    it('matches the headline, the location, the source and one skill, in any letter case, ignoring spaces around the text', async () => {
      for (const text of ['warehouse', 'KLANG', 'referral', 'forklift', '  Zarina  ']) {
        expect((await buildPoolModel(big, text)).rows.map((r) => r.id), text).toEqual(['oldest']);
      }
      expect((await buildPoolModel(big, '  Zarina  ')).search).toBe('Zarina');
    });
    it('never matches someone who is not in the pool', async () => {
      const model = await buildPoolModel(big, 'zarina');
      expect(model.rows.map((r) => r.id)).toEqual(['oldest']);
      expect(model.matched).toBe(1);
    });
    it('draws 50 of 59 matches and reports 59', async () => {
      const model = await buildPoolModel(big, 'person');
      expect(model.rows).toHaveLength(50);
      expect(model.matched).toBe(59);
      expect(model.rows[0].id).toBe('p1');
    });
    it('gives no rows and a count of 0 when nobody matches', async () => {
      const model = await buildPoolModel(big, 'nobody-at-all');
      expect(model).toMatchObject({ rows: [], matched: 0, search: 'nobody-at-all', isEmpty: false, size: 60 });
    });
    it('leaves the size, the status counts and the two tallies as figures for the whole pool', async () => {
      const whole = await buildPoolModel(big);
      const searched = await buildPoolModel(big, 'zarina');
      for (const key of ['size', 'statusCounts', 'byTitle', 'bySource', 'isEmpty'] as const) expect(searched[key], key).toEqual(whole[key]);
    });
    it('cuts a search of more than 80 characters', async () => {
      expect((await buildPoolModel(big, 'z'.repeat(200))).search).toHaveLength(80);
    });
    it('says when the read came back full, and not below that', async () => {
      const full: HireData = { ...EMPTY, listCandidates: async () => Array.from({ length: 1000 }, (_, i) => person(`c${i}`, { pool_status: 'none' })) };
      expect((await buildPoolModel(full)).readCapped).toBe(true);
      const under: HireData = { ...EMPTY, listCandidates: async () => Array.from({ length: 999 }, (_, i) => person(`c${i}`, { pool_status: 'none' })) };
      expect((await buildPoolModel(under)).readCapped).toBe(false);
    });
  });

  describe('the picker\'s read', () => {
    it('lists the people who are not in the pool, newest on file first, with no contact details', async () => {
      const picker = await buildPoolPicker({
        ...EMPTY,
        listCandidates: async () => [
          { ...cand('c1', 'none'), name: 'Kamal Ariffin', email: 'kamal@example.com', phone: '+60 12-345 6789', headline: 'Driver', location: 'Klang', skills: ['GDL'], source: 'Referral' },
          cand('c2', 'passive'),
          cand('c3', 'none'),
        ],
      });
      expect(picker).toEqual({
        people: [
          { id: 'c1', name: 'Kamal Ariffin', headline: 'Driver', location: 'Klang', skills: ['GDL'], source: 'Referral' },
          { id: 'c3', name: 'c3', headline: null, location: null, skills: [], source: null },
        ],
        capped: false,
      });
      expect(JSON.stringify(picker)).not.toMatch(/kamal@example\.com|345 6789|email|phone|pool_status/);
    });
    it('says when the read came back full', async () => {
      const full = Array.from({ length: 1000 }, (_, i) => cand(`c${i}`, i % 2 ? 'none' : 'available'));
      expect((await buildPoolPicker({ ...EMPTY, listCandidates: async () => full })).capped).toBe(true);
      expect((await buildPoolPicker({ ...EMPTY, listCandidates: async () => full.slice(1) })).capped).toBe(false);
      expect(await buildPoolPicker(EMPTY)).toEqual({ people: [], capped: false });
    });
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

describe('the pool status of the person behind an application', () => {
  const application = (id: string, over: Partial<Application>): Application => ({
    id, candidate_id: `c-${id}`, job_id: 'j1', candidate_name: `Person ${id}`, job_title: 'Barista', stage: 'applied', outcome: 'active',
    rating: null, source: null, applied_at: '2026-10-01T00:00:00Z', offered_at: null, hired_at: null, created_at: '2026-10-01T00:00:00Z',
    cover_letter: null, cv_url: null, cv_path: null, portfolio_url: null, expected_salary_cents: null, consented_at: null, reject_reason: null, ...over,
  });
  const source: HireData = {
    ...EMPTY,
    listApplications: async () => [application('a1', { candidate_pool_status: 'passive' }), application('a2', { candidate_pool_status: 'none' }), application('a3', {})],
  };
  it('is on every Applications row and every board card; a row that does not say reads as not in the pool', async () => {
    const rows = (await buildApplicationsModel(source)).rows.map((r) => [r.id, r.poolStatus]);
    expect(rows).toEqual([['a1', 'passive'], ['a2', 'none'], ['a3', 'none']]);
    const cards = (await buildBoardModel(source, NOW)).stages.flatMap((s) => s.candidates).map((c) => [c.id, c.poolStatus]);
    expect(cards).toEqual([['a1', 'passive'], ['a2', 'none'], ['a3', 'none']]);
  });
  it('is filled by the sample data from its own candidates', async () => {
    const seeded = createSeedHireData(NOW);
    const people = new Map((await seeded.listCandidates()).map((c) => [c.id, c.pool_status]));
    const apps = await seeded.listApplications();
    expect(apps.length).toBeGreaterThan(0);
    for (const a of apps) expect(a.candidate_pool_status, a.id).toBe(people.get(a.candidate_id));
    expect(apps.some((a) => a.candidate_pool_status === 'available')).toBe(true);
  });
});

describe('interviews: rows, order and the application picker', () => {
  const iv = (id: string, over: Partial<Interview> = {}): Interview => ({
    id, application_id: 'a1', candidate_name: 'Aina Rahman', job_title: 'Sales Executive', scheduled_at: '2026-10-12T07:00:00Z',
    duration_minutes: 60, kind: 'video', place: null, interviewer_name: 'Farah Lim', notes: null, status: 'scheduled',
    created_at: '2026-10-08T02:00:00Z', updated_at: '2026-10-08T02:00:00Z', application_stage: 'screening', application_outcome: 'active', ...over,
  });
  const application = (id: string, over: Partial<Application> = {}): Application => ({
    id, candidate_id: `c-${id}`, job_id: 'j1', candidate_name: `Person ${id}`, job_title: 'Barista', stage: 'applied', outcome: 'active',
    rating: null, source: null, applied_at: '2026-10-01T00:00:00Z', offered_at: null, hired_at: null, created_at: '2026-10-01T00:00:00Z',
    cover_letter: null, cv_url: null, cv_path: null, portfolio_url: null, expected_salary_cents: null, consented_at: null, reject_reason: null, ...over,
  });
  /** Soonest first, as a provider gives them. Two are scheduled and already past; two are scheduled and ahead; three are closed. */
  const seven = [
    iv('done', { scheduled_at: '2026-10-07T02:00:00Z', status: 'completed' }),
    iv('overdue-old', { scheduled_at: '2026-10-08T02:00:00Z' }),
    iv('overdue-new', { scheduled_at: '2026-10-09T02:00:00Z' }),
    iv('gone', { scheduled_at: '2026-10-09T08:00:00Z', status: 'no_show' }),
    iv('soon', { scheduled_at: '2026-10-11T02:00:00Z' }),
    iv('next', { scheduled_at: '2026-10-12T07:00:00Z' }),
    iv('called-off', { scheduled_at: '2026-10-15T02:00:00Z', status: 'cancelled' }),
  ];
  const source: HireData = { ...EMPTY, listInterviews: async () => seven };
  /** Every key anywhere inside a value. */
  const keysOf = (value: unknown): string[] =>
    value && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]) : [];

  it('gives a row everything the menu, the form and the calendar file need', async () => {
    const one = iv('next', {
      duration_minutes: 90, place: 'https://meet.example.com/abc', notes: 'Bring a portfolio', updated_at: '2026-10-09T02:00:00Z',
    });
    const model = await buildInterviewsModel({ ...EMPTY, listInterviews: async () => [one] }, NOW);
    expect(model.rows).toEqual([{
      id: 'next', name: 'Aina Rahman', role: 'Sales Executive', date: '12 Oct 2026', time: '3:00 pm', interviewer: 'Farah Lim', type: 'Video', status: 'Scheduled',
      applicationId: 'a1', statusKey: 'scheduled', scheduledAt: '2026-10-12T07:00:00Z', durationMinutes: 90, length: '1 hour 30 minutes', kind: 'video',
      place: 'https://meet.example.com/abc', placeLink: { href: 'https://meet.example.com/abc', host: 'meet.example.com' },
      interviewerName: 'Farah Lim', notes: 'Bring a portfolio', createdAt: '2026-10-08T02:00:00Z', updatedAt: '2026-10-09T02:00:00Z',
      applicationStage: 'screening', applicationOutcome: 'active', needsOutcome: false,
    }]);
  });
  it('keeps a place as text and gives no link unless safeLink takes it', async () => {
    const places = ['Level 3, Menara Rimba', 'javascript:alert(1)', 'https://good.com@evil.com/x', null];
    const model = await buildInterviewsModel({ ...EMPTY, listInterviews: async () => places.map((place, n) => iv(`i${n}`, { place })) }, NOW);
    expect(model.rows.map((r) => [r.place, r.placeLink])).toEqual(places.map((place) => [place, null]));
  });
  it('shows a dash for no interviewer, and keeps the stored value beside it', async () => {
    const model = await buildInterviewsModel({ ...EMPTY, listInterviews: async () => [iv('i1', { interviewer_name: null })] }, NOW);
    expect(model.rows[0]).toMatchObject({ interviewer: '—', interviewerName: null });
  });
  it('carries the application\'s stage and outcome, for the tag and for what the menu leaves out', async () => {
    const model = await buildInterviewsModel({
      ...EMPTY, listInterviews: async () => [iv('i1', { application_stage: 'interview', application_outcome: 'rejected' })],
    }, NOW);
    expect(model.rows[0]).toMatchObject({ applicationStage: 'interview', applicationOutcome: 'rejected' });
  });
  it('lists the ones that need an outcome first, then the ones ahead soonest first, then the closed ones latest first', async () => {
    const model = await buildInterviewsModel(source, NOW);
    expect(model.rows.map((r) => r.id)).toEqual(['overdue-old', 'overdue-new', 'soon', 'next', 'called-off', 'gone', 'done']);
    expect(model.rows.map((r) => r.needsOutcome)).toEqual([true, true, false, false, false, false, false]);
    // Whatever order the provider gives them in.
    const shuffled = await buildInterviewsModel({ ...EMPTY, listInterviews: async () => [...seven].reverse() }, NOW);
    expect(shuffled.rows.map((r) => r.id)).toEqual(model.rows.map((r) => r.id));
  });
  it('lists as upcoming only the scheduled interviews that are still ahead', async () => {
    const model = await buildInterviewsModel(source, NOW);
    expect(model.upcoming.map((r) => r.id)).toEqual(['soon', 'next']);
    expect(model.upcoming.every((r) => r.statusKey === 'scheduled' && !r.needsOutcome)).toBe(true);
    // An interview that starts this very moment is still ahead, not yet in need of an outcome.
    const atNow = await buildInterviewsModel({ ...EMPTY, listInterviews: async () => [iv('now', { scheduled_at: NOW.toISOString() })] }, NOW);
    expect(atNow.upcoming.map((r) => r.id)).toEqual(['now']);
    expect(atNow.rows[0].needsOutcome).toBe(false);
  });
  it('leaves the figures as they were: scheduled counts every scheduled row, the next 7 days only the ones ahead', async () => {
    const model = await buildInterviewsModel(source, NOW);
    expect(model).toMatchObject({ isEmpty: false, scheduled: 4, completed: 1, noShow: 1, next7Days: 2 });
    // What "Upcoming interviews" counts: the scheduled ones still ahead, by the list's own rule. Two more are overdue.
    expect(model.ahead).toBe(2);
    expect(model.ahead).toBe(model.upcoming.length);
    // 'soon' is Sunday 11 October and 'next' Monday 12 October in Kuala Lumpur: only the Monday is in the weekday chart.
    expect(model.weekLoad).toEqual([
      { label: 'Mon', count: 1 }, { label: 'Tue', count: 0 }, { label: 'Wed', count: 0 }, { label: 'Thu', count: 0 }, { label: 'Fri', count: 0 },
    ]);
  });
  it('keeps the sample data\'s figures when one of its interviews has passed, and tags that one', async () => {
    const before = await buildInterviewsModel(data, NOW);
    expect(before.upcoming).toHaveLength(6);
    expect(before.rows.some((r) => r.needsOutcome)).toBe(false);
    const later = new Date(NOW.getTime() + 6 * 3_600_000);
    const passed = (await data.listInterviews()).filter((i) => i.status === 'scheduled' && Date.parse(i.scheduled_at) < later.getTime());
    expect(passed.length).toBeGreaterThan(0);
    const after = await buildInterviewsModel(data, later);
    expect(after).toMatchObject({ scheduled: 6, completed: 3, noShow: 1 });
    expect(after.rows.filter((r) => r.needsOutcome).map((r) => r.id).sort()).toEqual(passed.map((i) => i.id).sort());
    expect(after.rows[0].needsOutcome).toBe(true);
    expect(after.upcoming).toHaveLength(6 - passed.length);
    expect(after.next7Days).toBe(6 - passed.length);
  });
  it('cuts the rows and the upcoming list at 50', async () => {
    const many = Array.from({ length: 60 }, (_, n) => iv(`i${n}`, { scheduled_at: new Date(NOW.getTime() + (n + 1) * 3_600_000).toISOString() }));
    const model = await buildInterviewsModel({ ...EMPTY, listInterviews: async () => many }, NOW);
    expect(model.rows).toHaveLength(50);
    expect(model.upcoming).toHaveLength(50);
    expect(model.scheduled).toBe(60);
    // The count is not cut with the list.
    expect(model.ahead).toBe(60);
  });
  it('lists every application for the two pickers, by name, with its stage and outcome and nothing to contact anyone by', async () => {
    const model = await buildInterviewsModel({
      ...EMPTY,
      listApplications: async () => [
        application('a2', { candidate_name: 'Zarina Hashim', job_title: 'Cashier', stage: 'screening', cv_url: 'https://example.com/cv', cv_path: 'org/a2/cv.pdf', cover_letter: 'Call me on 012-345 6789' }),
        application('a1', { candidate_name: 'Aina Rahman', job_title: 'Sales Executive', stage: 'interview', outcome: 'rejected', reject_reason: 'salary', rating: 4 }),
        application('a3', { candidate_name: 'Aina Rahman', job_title: 'Barista', outcome: 'withdrawn' }),
      ],
    }, NOW);
    expect(model.applications).toEqual([
      { id: 'a3', name: 'Aina Rahman', job: 'Barista', stage: 'applied', outcome: 'withdrawn' },
      { id: 'a1', name: 'Aina Rahman', job: 'Sales Executive', stage: 'interview', outcome: 'rejected' },
      { id: 'a2', name: 'Zarina Hashim', job: 'Cashier', stage: 'screening', outcome: 'active' },
    ]);
    expect(model.applicationsCut).toBe(false);
    // A workspace can have applications and no interview yet: the screen is empty, the picker is not.
    expect(model.isEmpty).toBe(true);
    expect(JSON.stringify(model.applications)).not.toMatch(/example\.com|cv\.pdf|345 6789|salary/);
  });
  it('says when the applications read came back full, and not below that', async () => {
    const full = Array.from({ length: 1000 }, (_, n) => application(`a${n}`));
    expect((await buildInterviewsModel({ ...EMPTY, listApplications: async () => full }, NOW)).applicationsCut).toBe(true);
    expect((await buildInterviewsModel({ ...EMPTY, listApplications: async () => full.slice(1) }, NOW)).applicationsCut).toBe(false);
  });
  it('gives the sample data all 248 applications, in name order', async () => {
    const model = await buildInterviewsModel(data, NOW);
    expect(model.applications).toHaveLength(248);
    const names = model.applications.map((a) => a.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
  it('gives today as the date in Kuala Lumpur, which is a day ahead of UTC in the evening', async () => {
    expect((await buildInterviewsModel(EMPTY, NOW)).today).toBe('2026-10-10');
    expect((await buildInterviewsModel(EMPTY, new Date('2026-10-10T15:59:00Z'))).today).toBe('2026-10-10');
    expect((await buildInterviewsModel(EMPTY, new Date('2026-10-10T16:00:00Z'))).today).toBe('2026-10-11');
  });
  it('is empty and finite for a workspace with nothing', async () => {
    expect(await buildInterviewsModel(EMPTY, NOW)).toMatchObject({ isEmpty: true, rows: [], upcoming: [], applications: [], applicationsCut: false });
  });
  it('carries no storage path and no contact details', async () => {
    const model = await buildInterviewsModel({
      ...source, listApplications: async () => [application('a1', { cv_path: 'org/a1/cv.pdf', cv_url: 'https://example.com/cv' })],
    }, NOW);
    const keys = keysOf(model).map((key) => key.toLowerCase());
    for (const word of ['cv_path', 'cvpath', 'path', 'email', 'phone', 'cv_url', 'cover']) {
      expect(keys.filter((key) => key.includes(word)), word).toEqual([]);
    }
    expect(JSON.stringify(model)).not.toContain('cv.pdf');
  });

  describe('an application\'s own interviews', () => {
    const apps: HireData = {
      ...EMPTY,
      listApplications: async () => [application('a1'), application('a2')],
      listInterviews: async () => [...seven, iv('other', { application_id: 'a9' })],
    };
    it('are on its row: the ones ahead first, soonest first, then the past ones, latest first', async () => {
      const { rows } = await buildApplicationsModel(apps, NOW);
      expect(rows.map((r) => r.id)).toEqual(['a1', 'a2']);
      // Ahead or past is by the start alone: a cancelled interview that was due next week is listed among those ahead.
      expect(rows[0].interviews.map((i) => i.id)).toEqual(['soon', 'next', 'called-off', 'gone', 'overdue-new', 'overdue-old', 'done']);
      expect(rows[1].interviews).toEqual([]);
    });
    it('are the rows of the Interviews screen without the team\'s notes, which the panel never draws and a viewer must not be sent', async () => {
      const noted: HireData = { ...apps, listInterviews: async () => seven.map((i) => ({ ...i, notes: 'Asked for RM 4,500. Weak on Excel.' })) };
      const { rows } = await buildApplicationsModel(noted, NOW);
      const screen = await buildInterviewsModel(noted, NOW);
      const byId = new Map(screen.rows.map((r) => [r.id, r]));
      expect(rows[0].interviews).toHaveLength(7);
      for (const interview of rows[0].interviews) {
        const { notes, ...rest } = byId.get(interview.id)!;
        // The Interviews screen's own row keeps them, for the edit form of someone who may edit.
        expect(notes).toBe('Asked for RM 4,500. Weak on Excel.');
        expect(interview, interview.id).toEqual(rest);
        expect(Object.keys(interview)).not.toContain('notes');
      }
      expect(JSON.stringify(await buildApplicationsModel(noted, NOW))).not.toMatch(/4,500|Excel/);
      expect(rows[0].interviews.find((i) => i.id === 'overdue-new')).toMatchObject({ needsOutcome: true, status: 'Scheduled', length: '1 hour' });
    });
    it('are not cut: every one of an application\'s interviews is there for the panel to count', async () => {
      const eight = Array.from({ length: 8 }, (_, n) => iv(`i${n}`, { scheduled_at: new Date(NOW.getTime() + (n + 1) * 86_400_000).toISOString() }));
      const { rows } = await buildApplicationsModel({ ...apps, listInterviews: async () => eight }, NOW);
      expect(rows[0].interviews.map((i) => i.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7']);
    });
    it('are there for the sample data: ten applications have one each', async () => {
      const { rows } = await buildApplicationsModel(data, NOW);
      const all = await data.listInterviews();
      for (const row of rows) {
        expect(row.interviews.map((i) => i.id).sort(), row.id).toEqual(all.filter((i) => i.application_id === row.id).map((i) => i.id).sort());
      }
    });
    it('leave the rest of the model as it was', async () => {
      const model = await buildApplicationsModel(data);
      expect(model.total).toBe(248);
      expect(model.rows).toHaveLength(50);
      expect(model.statusMix.reduce((sum, s) => sum + s.value, 0)).toBe(248);
    });
  });
});

// ─── boundaries beyond the plan's own tests ──────────────────────────────────

describe('interviews: the day and the time a row shows', () => {
  const at = (id: string, scheduled_at: string): Interview => ({
    id, application_id: 'a1', candidate_name: 'Aina Rahman', job_title: 'Sales Executive', scheduled_at,
    duration_minutes: 60, kind: 'video', place: null, interviewer_name: null, notes: null, status: 'scheduled',
    created_at: '2026-10-08T02:00:00Z', updated_at: '2026-10-08T02:00:00Z', application_stage: 'interview', application_outcome: 'active',
  });
  const edges = [
    // Midnight in Kuala Lumpur is 16:00 the day before in UTC.
    at('midnight', '2026-10-19T16:00:00+00:00'),
    at('last-minute', '2026-10-20T15:59:00+00:00'),
    at('new-year', '2026-12-31T16:00:00+00:00'),
    at('leap-day', '2028-02-28T16:00:00+00:00'),
    at('as-sent', '2026-10-20T15:00:00+08:00'),
  ];
  const shown = async () => {
    const model = await buildInterviewsModel({ ...EMPTY, listInterviews: async () => edges }, NOW);
    return Object.fromEntries(model.rows.map((r) => [r.id, `${r.date} ${r.time}`]));
  };
  const EXPECTED = {
    midnight: '20 Oct 2026 12:00 am',
    'last-minute': '20 Oct 2026 11:59 pm',
    'new-year': '01 Jan 2027 12:00 am',
    'leap-day': '29 Feb 2028 12:00 am',
    'as-sent': '20 Oct 2026 3:00 pm',
  };
  it('are the Kuala Lumpur ones at midnight, at the last minute, across a year and on 29 February, with the year', async () => {
    expect(await shown()).toEqual(EXPECTED);
  });
  it('are the same whatever zone the server is in, and so is today', async () => {
    const before = process.env.TZ;
    try {
      for (const [zone, behind] of [['UTC', 0], ['America/New_York', 240], ['Asia/Tokyo', -540]] as const) {
        process.env.TZ = zone;
        expect(new Date('2026-10-20T07:00:00Z').getTimezoneOffset(), zone).toBe(behind);
        expect(await shown(), zone).toEqual(EXPECTED);
        expect((await buildInterviewsModel(EMPTY, new Date('2026-12-31T16:00:00Z'))).today, zone).toBe('2027-01-01');
        expect((await buildInterviewsModel(EMPTY, new Date('2028-02-28T16:00:00Z'))).today, zone).toBe('2028-02-29');
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});
