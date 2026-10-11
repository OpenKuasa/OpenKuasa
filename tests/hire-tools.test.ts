// tests/hire-tools.test.ts
import { describe, expect, it, vi } from 'vitest';
import { HIRE_TOOL_NAMES, createHireTools } from '@/lib/ai/hire-tools';
import { CRM_WRITE_TOOL_NAMES } from '@/lib/ai/crm-tools';
import { HIRE_WRITE_TOOL_NAMES, REACH_WRITE_TOOL_NAMES } from '@/lib/ai/products';
import {
  createJobInput, deleteJobInput, setJobStatusInput, updateApplicationFormInput, updateCareersPageInput, updateJobInput,
} from '@/lib/hire/capabilities';
import { createReachTools } from '@/lib/ai/tools';
import { toolMeta } from '@/components/chat/tool-parts';
import { formatWhen } from '@/lib/reach/overview';
import { funnelCounts } from '@/lib/hire/applications-view';
import { timeToHire } from '@/lib/hire/dashboard';
import { createSeedHireData } from '@/lib/hire/seed';
import { createSeedReachData } from '@/lib/reach/seed';
import type { HireData } from '@/lib/hire/types';

const NOW = new Date('2026-10-10T04:00:00Z');
const data = createSeedHireData(NOW);
const tools = createHireTools(data, NOW);
// The tool results are untyped JSON; the tests read them loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type Run = (input: Record<string, unknown>) => Promise<Loose>;
const run = (name: string): Run => (input) =>
  (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 't', messages: [],
  });

describe('hire tools', () => {
  it('is exactly the nine lookups, none sharing a name with another product', () => {
    expect(Object.keys(tools)).toEqual([...HIRE_TOOL_NAMES]);
    expect(HIRE_TOOL_NAMES).toEqual([
      'getHiringOverview', 'listJobs', 'listApplications', 'getHiringFunnel',
      'listTalentPool', 'listInterviews', 'getTimeToHire', 'getSourceBreakdown', 'getCareersPage',
    ]);
    const others = new Set([
      ...Object.keys(createReachTools(createSeedReachData())),
      ...REACH_WRITE_TOOL_NAMES,
      ...CRM_WRITE_TOOL_NAMES,
      'listCrmContacts', 'listDeals', 'listPipelines', 'getDealStats',
    ]);
    for (const name of HIRE_TOOL_NAMES) expect(others.has(name), name).toBe(false);
  });

  it('has a named card for every tool', () => {
    for (const name of HIRE_TOOL_NAMES) expect(toolMeta(name).isFallback, name).toBe(false);
  });

  it('gives the overview totals', async () => {
    expect(await run('getHiringOverview')({})).toMatchObject({
      applications: 248, open_jobs: 6, interviews_next_7_days: 6, offers_out: 2, hires_last_30_days: 2,
    });
  });

  it('lists jobs with applicant counts, filtered by status and department', async () => {
    const all = await run('listJobs')({});
    expect(all.total).toBe(9);
    const open = await run('listJobs')({ status: 'open' });
    expect(open.total).toBe(6);
    expect(open.jobs.find((j: { title: string }) => j.title === 'Software Engineer').applicants).toBe(56);
    expect((await run('listJobs')({ department: 'sales' })).total).toBe(2);
  });

  it('caps a list at 50 rows and still reports the total', async () => {
    const result = await run('listApplications')({ limit: 500 });
    expect(result.applications).toHaveLength(50);
    expect(result.total).toBe(248);
    expect((await run('listApplications')({ limit: Number.NaN })).applications.length).toBeLessThanOrEqual(50);
  });

  it('filters applications by a loosely typed job title, stage and outcome', async () => {
    const sales = await run('listApplications')({ jobTitle: 'sales exec' });
    expect(sales.total).toBe(42);
    expect(sales.applications.every((a: { job: string }) => a.job === 'Sales Executive')).toBe(true);
    expect((await run('listApplications')({ jobTitle: 'SALES EXECUTIVE' })).total).toBe(42);
    const offers = await run('listApplications')({ stage: 'offer', outcome: 'active', includeContact: true });
    expect(offers.total).toBe(2);
    expect(offers.applications[0]).toMatchObject({ stage: 'offer', label: 'Shortlisted' });
    expect(offers.applications[0].email).toMatch(/@demo\.openkuasa\.com$/);
  });

  it('leaves contact details out unless asked, and does not even read candidates', async () => {
    let candidateReads = 0;
    const counting: HireData = { ...data, listCandidates: async () => { candidateReads += 1; return data.listCandidates(); } };
    const t = createHireTools(counting, NOW);
    const exec = (name: string, input: Record<string, unknown>) =>
      (t[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<Loose> }).execute(input, { toolCallId: 't', messages: [] });
    const apps = await exec('listApplications', {});
    expect(apps.applications.length).toBeGreaterThan(0);
    expect(apps.applications.some((r: object) => 'email' in r || 'phone' in r)).toBe(false);
    expect(candidateReads).toBe(0);
    const pool = await exec('listTalentPool', {});
    expect(pool.candidates.length).toBeGreaterThan(0);
    expect(pool.candidates.some((r: object) => 'email' in r || 'phone' in r)).toBe(false);
  });

  it('includes email and phone when includeContact is true', async () => {
    const apps = await run('listApplications')({ includeContact: true });
    expect(apps.applications.every((r: object) => 'email' in r && 'phone' in r)).toBe(true);
    const pool = await run('listTalentPool')({ includeContact: true });
    expect(pool.candidates.every((r: object) => 'email' in r && 'phone' in r)).toBe(true);
    expect(pool.candidates.some((r: { email: string | null }) => r.email)).toBe(true);
  });

  describe('application details', () => {
    const FIELDS = ['cover_letter', 'cv_url', 'portfolio_url', 'expected_salary_cents'];
    const long = 'x'.repeat(3000);
    const withDetails = async () => {
      const apps = (await data.listApplications()).slice(0, 2);
      const custom: HireData = {
        ...data,
        listApplications: async () => [
          { ...apps[0], cover_letter: long, cv_url: 'https://drive.example.com/cv', cv_path: null, portfolio_url: 'https://me.example.com', expected_salary_cents: 350000 },
          { ...apps[1], cover_letter: 'Short and sweet.', cv_url: null, cv_path: null, portfolio_url: null, expected_salary_cents: null },
        ],
      };
      const t = createHireTools(custom, NOW);
      const exec = (input: Record<string, unknown>) =>
        (t.listApplications as unknown as { execute: (i: unknown, o: unknown) => Promise<Loose> }).execute(input, { toolCallId: 't', messages: [] });
      return exec;
    };
    it('returns none of the four without includeContact', async () => {
      const exec = await withDetails();
      const { applications } = await exec({});
      expect(applications).toHaveLength(2);
      for (const row of applications) for (const f of FIELDS) expect(f in row, f).toBe(false);
    });
    it('returns all four with includeContact, the letter cut at 600 characters', async () => {
      const exec = await withDetails();
      const { applications } = await exec({ includeContact: true });
      for (const row of applications) for (const f of FIELDS) expect(f in row, f).toBe(true);
      expect(applications[0].cover_letter).toHaveLength(601);
      expect(applications[0].cover_letter.endsWith('…')).toBe(true);
      expect(applications[0]).toMatchObject({ cv_url: 'https://drive.example.com/cv', portfolio_url: 'https://me.example.com', expected_salary_cents: 350000 });
      expect(applications[1]).toMatchObject({ cover_letter: 'Short and sweet.', cv_url: null, expected_salary_cents: null });
    });
  });

  it('says whether a file is held with includeContact, and never the path', async () => {
    const path = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-8ccc-cccccccccccc.pdf';
    const apps = (await data.listApplications()).slice(0, 2);
    const custom: HireData = {
      ...data,
      listApplications: async () => [{ ...apps[0], cv_path: path }, { ...apps[1], cv_path: null }],
    };
    const t = createHireTools(custom, NOW);
    const exec = (input: Record<string, unknown>) =>
      (t.listApplications as unknown as { execute: (i: unknown, o: unknown) => Promise<Loose> }).execute(input, { toolCallId: 't', messages: [] });
    const withContact = await exec({ includeContact: true });
    expect(withContact.applications.map((r: { has_cv_file: boolean }) => r.has_cv_file)).toEqual([true, false]);
    const without = await exec({});
    for (const row of without.applications) expect('has_cv_file' in row).toBe(false);
    for (const result of [withContact, without]) {
      expect(JSON.stringify(result)).not.toContain('cccccccc');
      for (const row of result.applications) expect('cv_path' in row).toBe(false);
    }
  });

  it('orders past interviews latest first whatever order the provider returns', async () => {
    const all = await data.listInterviews();
    const shuffled: HireData = { ...data, listInterviews: async () => [...all].reverse() };
    const t = createHireTools(shuffled, NOW);
    const result = await (t.listInterviews as unknown as { execute: (i: unknown, o: unknown) => Promise<Loose> }).execute({ when: 'past' }, { toolCallId: 't', messages: [] });
    const times = result.interviews.map((i: { scheduled_at: string }) => Date.parse(i.scheduled_at));
    expect(times.length).toBeGreaterThan(1);
    expect(times).toEqual([...times].sort((a: number, b: number) => b - a));
  });

  it('never lets the model choose the workspace', () => {
    const withWrite = createHireTools(data, NOW, { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true });
    for (const name of [...HIRE_TOOL_NAMES, ...HIRE_WRITE_TOOL_NAMES]) {
      const shape = (withWrite[name] as unknown as { inputSchema: { shape: Record<string, unknown> } }).inputSchema.shape;
      expect(Object.keys(shape).some((k) => /org|tenant|workspace/i.test(k)), name).toBe(false);
    }
  });

  it('answers a filter that matches nothing with nothing, not everything', async () => {
    expect(await run('listApplications')({ jobTitle: 'plumber' })).toMatchObject({ total: 0, applications: [] });
    expect(await run('listJobs')({ department: 'plumbing' })).toMatchObject({ total: 0, jobs: [] });
    expect(await run('getHiringFunnel')({ jobTitle: 'plumber' })).toMatchObject({ applications: 0 });
  });

  it('gives the same funnel as the helper, overall and for one job', async () => {
    const apps = await data.listApplications();
    const all = await run('getHiringFunnel')({});
    expect(all.reached).toEqual(funnelCounts(apps));
    expect(all.applications).toBe(248);
    const one = await run('getHiringFunnel')({ jobTitle: 'Software Engineer' });
    expect(one.applications).toBe(56);
    expect(one.reached).toEqual(funnelCounts(apps.filter((a) => a.job_title === 'Software Engineer')));
  });

  it('lists the talent pool, filtered by skill', async () => {
    const pool = await run('listTalentPool')({ skill: 'react' });
    expect(pool.total).toBeGreaterThan(0);
    expect(pool.candidates.every((c: { skills: string[] }) => c.skills.includes('React'))).toBe(true);
    expect(pool.candidates.length).toBeLessThanOrEqual(50);
  });

  it('lists upcoming and past interviews', async () => {
    expect((await run('listInterviews')({ when: 'upcoming' })).total).toBe(6);
    expect((await run('listInterviews')({ when: 'past' })).total).toBe(4);
    expect((await run('listInterviews')({ status: 'no_show' })).total).toBe(1);
  });

  it('gives every interview a Kuala Lumpur `when`', async () => {
    const result = await run('listInterviews')({});
    expect(result.interviews.length).toBeGreaterThan(0);
    for (const row of result.interviews) expect(typeof row.when).toBe('string');
    const first = result.interviews[0];
    expect(first.when).toBe(formatWhen(first.scheduled_at, NOW));
  });

  it('gives the same time to hire as the helper', async () => {
    expect(await run('getTimeToHire')({})).toEqual(timeToHire(await data.listApplications()));
  });

  it('breaks applications down by source', async () => {
    const result = await run('getSourceBreakdown')({});
    expect(result.sources[0]).toMatchObject({ source: 'JobStreet', applications: 104 });
  });

  it('answers from an empty workspace without NaN', async () => {
    const empty: HireData = {
      listJobs: async () => [], listCandidates: async () => [],
      listApplications: async () => [], listInterviews: async () => [],
      getSettings: async () => ({ org_id: null, careers_enabled: false, careers_headline: null, careers_tagline: null, require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false }),
    };
    const t = createHireTools(empty, NOW);
    for (const name of HIRE_TOOL_NAMES) {
      const result = await (t[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({}, { toolCallId: 't', messages: [] });
      // JSON.stringify would hide NaN and Infinity (it writes them as null), so check the numbers themselves.
      const numbersIn = (value: unknown): number[] =>
        typeof value === 'number' ? [value]
        : Array.isArray(value) ? value.flatMap(numbersIn)
        : value && typeof value === 'object' ? Object.values(value).flatMap(numbersIn)
        : [];
      expect(result, name).not.toMatchObject({ ok: false });
      expect(numbersIn(result).every(Number.isFinite), name).toBe(true);
    }
  });

  it('reports a failed read as an error, without the database message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: HireData = {
      listJobs: async () => { throw new Error('relation "hire_jobs" does not exist'); },
      listCandidates: async () => [], listApplications: async () => [], listInterviews: async () => [],
      getSettings: async () => ({ org_id: null, careers_enabled: false, careers_headline: null, careers_tagline: null, require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false }),
    };
    const t = createHireTools(broken, NOW);
    const result = await (t.listJobs as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({}, { toolCallId: 't', messages: [] });
    expect(result).toEqual({ ok: false, error: 'Could not read hiring data.' });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('hire change tools', () => {
  const ctx = { client: {} as never, orgId: 'org1' };
  it('are offered only to someone who may write', () => {
    const none = Object.keys(createHireTools(data, NOW));
    const viewer = Object.keys(createHireTools(data, NOW, { ctx, canWrite: false }));
    const member = Object.keys(createHireTools(data, NOW, { ctx, canWrite: true }));
    for (const name of HIRE_WRITE_TOOL_NAMES) {
      expect(none).not.toContain(name);
      expect(viewer).not.toContain(name);
      expect(member).toContain(name);
    }
    expect(HIRE_WRITE_TOOL_NAMES).toEqual(['createJob', 'updateJob', 'setJobStatus', 'deleteJob', 'updateCareersPage', 'updateApplicationForm']);
  });
  it('gives a writer nothing beyond the lookups except the listed change tools, so each one needs approval', () => {
    const writerTools = createHireTools(data, NOW, { ctx, canWrite: true });
    const lookups: readonly string[] = HIRE_TOOL_NAMES;
    const beyond = Object.keys(writerTools).filter((name) => !lookups.includes(name));
    expect(new Set(beyond)).toEqual(new Set(HIRE_WRITE_TOOL_NAMES));
    expect(beyond).toHaveLength(HIRE_WRITE_TOOL_NAMES.length);
  });
  it('tells the model today\'s date in Kuala Lumpur, for working out a closing date', async () => {
    const lateUtc = new Date('2026-10-10T17:00:00Z'); // 01:00 on 11 Oct in Kuala Lumpur
    const t = createHireTools(data, lateUtc, { ctx, canWrite: true }) as Record<
      string,
      { description: string; execute: (i: unknown, o: unknown) => Promise<Loose> }
    >;
    expect(t.createJob.description).toContain('Today in Malaysia is 2026-10-11.');
    expect(t.updateJob.description).toContain('Today in Malaysia is 2026-10-11.');
    const listed = await t.listJobs.execute({}, { toolCallId: 't', messages: [] });
    expect(listed).toMatchObject({ total: 9, today_in_malaysia: '2026-10-11' });
  });
  it('take exactly the capability schemas as input', () => {
    const t = createHireTools(data, NOW, { ctx, canWrite: true }) as Record<string, { inputSchema: unknown }>;
    expect(t.createJob.inputSchema).toBe(createJobInput);
    expect(t.updateJob.inputSchema).toBe(updateJobInput);
    expect(t.setJobStatus.inputSchema).toBe(setJobStatusInput);
    expect(t.deleteJob.inputSchema).toBe(deleteJobInput);
    expect(t.updateCareersPage.inputSchema).toBe(updateCareersPageInput);
    expect(t.updateApplicationForm.inputSchema).toBe(updateApplicationFormInput);
  });
  it('lets listJobs hand the model an id and the new fields', async () => {
    const { jobs } = await run('listJobs')({ status: 'open' });
    expect(jobs[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), headcount: expect.any(Number), has_description: true });
    // The whole description of every job would be thousands of characters per lookup.
    expect(jobs[0]).not.toHaveProperty('description');
    expect(jobs[0].description_excerpt.length).toBeLessThanOrEqual(161);
    expect(jobs[0]).toHaveProperty('closes_on');
  });
});

describe('getCareersPage', () => {
  const settings = { org_id: 'org-1', careers_enabled: true, careers_headline: 'Join us', careers_tagline: null, require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
  const withSettings = (over: Record<string, unknown> = {}): HireData => ({
    ...createSeedHireData(NOW),
    getSettings: async () => ({ ...settings, ...over }),
  });
  const call = (t: ReturnType<typeof createHireTools>, input: Record<string, unknown>): Promise<Loose> =>
    (t.getCareersPage as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
      toolCallId: 't', messages: [],
    });

  it('gives the address from the site origin and the session workspace, never from the model', async () => {
    const out = await call(createHireTools(withSettings(), NOW, undefined, { origin: 'https://openkuasa.com' }), { org_id: 'evil' });
    expect(out).toMatchObject({
      enabled: true, headline: 'Join us', tagline: null,
      path: '/careers/org-1', url: 'https://openkuasa.com/careers/org-1',
    });
    // Open jobs that have a description: what a visitor would see listed.
    const open = (await data.listJobs()).filter((j) => j.status === 'open' && j.description?.trim()).length;
    expect(open).toBeGreaterThan(0);
    expect(out).toMatchObject({ jobs_showing: open });
  });
  it('reports what the application form asks for, whether the page is on or off', async () => {
    const switches = { require_cv: true, require_cover_letter: false, ask_portfolio: true, ask_expected_salary: false };
    for (const careers_enabled of [true, false]) {
      const out = await call(createHireTools(withSettings({ ...switches, careers_enabled }), NOW), {});
      expect(out.application_form).toEqual(switches);
    }
    const sample = await call(createHireTools(createSeedHireData(NOW), NOW), {});
    expect(sample.application_form).toEqual({ require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false });
  });
  it('shows nothing public while the page is off', async () => {
    const t = createHireTools(withSettings({ careers_enabled: false }), NOW, undefined, { origin: 'https://openkuasa.com' });
    expect(await call(t, {})).toMatchObject({ enabled: false, jobs_showing: 0, url: null });
  });
  it('has no address for the sample data', async () => {
    expect(await call(createHireTools(createSeedHireData(NOW), NOW), {})).toMatchObject({ path: null, url: null });
  });
});
