// tests/hire-capped-lists.test.ts
import { describe, expect, it } from 'vitest';
import { CANDIDATE_COLUMNS, readPool, readPoolPicker } from '@/lib/hire/candidate-search';
import { latestOnly } from '@/lib/hire/latest-answer';
import {
  APPLICATION_SEARCH_LIMIT, findApplications, readApplicationSearch, readContacts, searchApplicationsFromList,
} from '@/lib/hire/application-search';
import { createHireTools } from '@/lib/ai/hire-tools';
import { buildPoolModel } from '@/lib/hire/lists';
import { createSeedHireData } from '@/lib/hire/seed';
import { HIRE_READ_CAP, type Application, type Candidate, type HireData } from '@/lib/hire/types';

/**
 * The last lists that kept only the newest 1,000 rows. No database here: the
 * client is a stand-in that writes down each query and answers from rows the
 * test gives it, applying nothing itself.
 */
type Query = { table: string; calls: [string, ...unknown[]][] };
function standIn(answer: (query: Query) => { data?: unknown; error?: unknown }) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const query: Query = { table, calls: [] };
      queries.push(query);
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'neq', 'in', 'filter', 'order', 'limit']) {
        builder[method] = (...args: unknown[]) => { query.calls.push([method, ...args]); return builder; };
      }
      const settle = () => ({ data: null, error: null, ...answer(query) });
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(settle()).then(resolve);
      return builder;
    },
  };
  return { client: client as never, queries };
}
const has = (query: Query, ...call: unknown[]) => query.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));

const NOW = new Date('2026-10-10T04:00:00Z');
const person = (i: number, over: Partial<Candidate> = {}): Candidate => ({
  id: `c${i}`, name: `Person ${i}`, email: null, phone: null, headline: null, location: null, skills: [], source: null,
  pool_status: 'none', created_at: new Date(NOW.getTime() - i * 60_000).toISOString(), ...over,
});
const EMPTY: HireData = {
  listJobs: async () => [],
  listCandidates: async () => [],
  listApplications: async () => [],
  listInterviews: async () => [],
  getSettings: async () => ({ org_id: null, careers_enabled: false, careers_headline: null, careers_tagline: null, require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false }),
};

// ─── 1. the Talent Pool screen reads the pool itself ─────────────────────────

describe('readPool', () => {
  it('asks for the pool members of this workspace, newest first, up to the list cap', async () => {
    const { client, queries } = standIn(() => ({ data: [{ ...person(1, { pool_status: 'available' }), skills: null }] }));
    const rows = await readPool(client, 'org1');
    expect(queries).toHaveLength(1);
    const [q] = queries;
    expect(q.table).toBe('hire_candidates');
    expect(has(q, 'select', CANDIDATE_COLUMNS)).toBe(true);
    expect(has(q, 'eq', 'org_id', 'org1')).toBe(true);
    expect(has(q, 'neq', 'pool_status', 'none')).toBe(true);
    expect(has(q, 'order', 'created_at', { ascending: false })).toBe(true);
    expect(has(q, 'order', 'id', { ascending: true })).toBe(true);
    expect(has(q, 'limit', HIRE_READ_CAP)).toBe(true);
    expect(rows[0].skills).toEqual([]);
  });
  it('throws when the query fails', async () => {
    const { client } = standIn(() => ({ error: { code: '42501' } }));
    await expect(readPool(client, 'org1')).rejects.toEqual({ code: '42501' });
  });
});

describe('buildPoolModel with the provider\'s own pool read', () => {
  /** 1,500 people on file, the oldest 300 of them in the pool: the newest 1,000 hold no pool member at all. */
  const everyone = Array.from({ length: 1500 }, (_, i) => person(i, i >= 1200 ? { pool_status: 'passive', name: `Member ${i}` } : {}));
  const withPool = (pool: Candidate[]): HireData & { asked: string[] } => {
    const asked: string[] = [];
    return {
      ...EMPTY,
      asked,
      listCandidates: async () => { asked.push('candidates'); return everyone.slice(0, HIRE_READ_CAP); },
      listPool: async () => { asked.push('pool'); return pool; },
    };
  };

  it('counts, lists and searches the whole pool read, not the pool members among the newest 1,000 people', async () => {
    const data = withPool(everyone.filter((c) => c.pool_status !== 'none'));
    const model = await buildPoolModel(data);
    expect(model).toMatchObject({ size: 300, isEmpty: false, readCapped: false });
    expect(model.rows).toHaveLength(50);
    expect(model.statusCounts.find((s) => s.key === 'Passive')?.value).toBe(300);
    expect((await buildPoolModel(data, 'member 1499')).rows.map((r) => r.id)).toEqual(['c1499']);
    // The list of everyone on file is not read at all.
    expect(data.asked).not.toContain('candidates');
  });
  it('says the read was cut only when the pool itself came back full', async () => {
    const full = Array.from({ length: HIRE_READ_CAP }, (_, i) => person(i, { pool_status: 'available' }));
    expect((await buildPoolModel(withPool(full))).readCapped).toBe(true);
    expect((await buildPoolModel(withPool(full.slice(1)))).readCapped).toBe(false);
  });
  it('drops anyone the read hands back who is not in the pool', async () => {
    const model = await buildPoolModel(withPool([person(1), person(2, { pool_status: 'available' })]));
    expect(model.rows.map((r) => r.id)).toEqual(['c2']);
    expect(model.size).toBe(1);
  });
});

// ─── 2. the "Add to pool" picker asks the server ─────────────────────────────

describe('readPoolPicker', () => {
  const byHeadline = (q: Query) => q.calls.some((c) => c[0] === 'filter' && c[1] === 'headline');
  it('asks for the newest people not in the pool whose name, then whose headline, matches, one more than it keeps, with no contact columns', async () => {
    const { client, queries } = standIn(() => ({ data: [] }));
    await readPoolPicker(client, 'org1', ' D.J. 50%* ');
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.table).toBe('hire_candidates');
      expect(has(q, 'select', 'id,name,headline,location,skills,source,created_at')).toBe(true);
      expect(has(q, 'eq', 'org_id', 'org1')).toBe(true);
      expect(has(q, 'eq', 'pool_status', 'none')).toBe(true);
      expect(has(q, 'order', 'created_at', { ascending: false })).toBe(true);
      expect(has(q, 'order', 'id', { ascending: true })).toBe(true);
      expect(has(q, 'limit', 51)).toBe(true);
      expect(JSON.stringify(q.calls)).not.toMatch(/email|phone|ilike|"or"/);
    }
    expect(has(queries.find((q) => !byHeadline(q))!, 'filter', 'name', 'imatch', 'D\\.J\\. 50%\\*')).toBe(true);
    expect(has(queries.find(byHeadline)!, 'filter', 'headline', 'imatch', 'D\\.J\\. 50%\\*')).toBe(true);
  });
  it('with no name, asks once for the newest 50 not in the pool', async () => {
    for (const blank of ['', '   ', '\u200b']) {
      const { client, queries } = standIn(() => ({ data: [] }));
      await readPoolPicker(client, 'org1', blank);
      expect(queries, JSON.stringify(blank)).toHaveLength(1);
      expect(queries[0].calls.some((c) => c[0] === 'filter'), JSON.stringify(blank)).toBe(false);
      expect(has(queries[0], 'limit', 51)).toBe(true);
    }
  });
  const row = (i: number, over: Record<string, unknown> = {}) => ({
    id: `c${i}`, name: `P ${i}`, headline: null, location: null, skills: null, source: null, email: 'x@example.com',
    created_at: new Date(NOW.getTime() - i * 60_000).toISOString(), ...over,
  });
  it('merges the two reads, newest on file first, each person once, and keeps only the six fields of a person', async () => {
    const named = [row(2, { name: 'Driver Dan' }), row(5)];
    const titled = [row(1, { headline: 'Driver' }), row(2, { name: 'Driver Dan' })];
    const got = await readPoolPicker(standIn((q) => ({ data: byHeadline(q) ? titled : named })).client, 'org1', 'driver');
    expect(got.people.map((p) => p.id)).toEqual(['c1', 'c2', 'c5']);
    expect(got.more).toBe(false);
    expect(got.people[0]).toEqual({ id: 'c1', name: 'P 1', headline: 'Driver', location: null, skills: [], source: null });
  });
  it('keeps 50 and says when there were more, from either read or from the two together', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => row(i));
    const full = await readPoolPicker(standIn((q) => ({ data: byHeadline(q) ? [] : rows })).client, 'org1', 'P');
    expect(full.people).toHaveLength(50);
    expect(full.more).toBe(true);
    const few = await readPoolPicker(standIn((q) => ({ data: byHeadline(q) ? [] : rows.slice(0, 50) })).client, 'org1', 'P');
    expect(few).toMatchObject({ more: false });
    expect(few.people).toHaveLength(50);
    const halves = await readPoolPicker(standIn((q) => ({ data: byHeadline(q) ? rows.slice(0, 30) : rows.slice(30) })).client, 'org1', 'P');
    expect(halves.people).toHaveLength(50);
    expect(halves.more).toBe(true);
    const blank = await readPoolPicker(standIn(() => ({ data: rows })).client, 'org1', '');
    expect(blank).toMatchObject({ more: true });
  });
  it('throws when a query fails', async () => {
    await expect(readPoolPicker(standIn(() => ({ error: { code: '42501' } })).client, 'org1', 'x')).rejects.toEqual({ code: '42501' });
  });
});

describe('latestOnly', () => {
  it('lets only the newest question\'s answer through, whatever order the answers come back in', () => {
    const latest = latestOnly();
    const first = latest.begin();
    const second = latest.begin();
    expect(latest.isCurrent(second)).toBe(true);
    expect(latest.isCurrent(first)).toBe(false);
    const third = latest.begin();
    expect(latest.isCurrent(second)).toBe(false);
    expect(latest.isCurrent(third)).toBe(true);
  });
  it('can drop every question still out, as when the picker closes', () => {
    const latest = latestOnly();
    const asked = latest.begin();
    latest.cancel();
    expect(latest.isCurrent(asked)).toBe(false);
  });
});

// ─── 3. Lekir's listApplications asks the database for a name ────────────────

const app = (i: number, over: Partial<Application> = {}): Application => ({
  id: `a${i}`, candidate_id: `c${i}`, job_id: 'j1', candidate_name: `Person ${i}`, job_title: 'Sales Executive', candidate_pool_status: 'none',
  stage: 'applied', outcome: 'active', reject_reason: null, rating: null, source: null,
  applied_at: new Date(NOW.getTime() - i * 60_000).toISOString(), offered_at: null, hired_at: null, created_at: '2026-01-01T00:00:00Z',
  cover_letter: null, cv_url: null, cv_path: null, portfolio_url: null, expected_salary_cents: null, consented_at: null, ...over,
});
/** A row as the database hands it back: the joined name and title still nested. */
const raw = (a: Application) => {
  const { candidate_name, job_title, candidate_pool_status, ...row } = a;
  return { ...row, candidate: { name: candidate_name, pool_status: candidate_pool_status }, job: { title: job_title } };
};
const selectOf = (q: Query) => String(q.calls.find((c) => c[0] === 'select')?.[1]);
const byJob = (q: Query) => q.calls.some((c) => c[1] === 'job.title');

describe('readApplicationSearch', () => {
  it('asks for the newest applications whose candidate\'s name matches, in this workspace, one more than it keeps', async () => {
    const { client, queries } = standIn(() => ({ data: [raw(app(1))] }));
    const got = await readApplicationSearch(client, 'org1', { name: ' D.J. (Dee)* ' });
    expect(queries).toHaveLength(1);
    const [q] = queries;
    expect(q.table).toBe('hire_applications');
    expect(selectOf(q)).toContain('candidate:hire_candidates!inner(name,pool_status)');
    expect(selectOf(q)).toContain('job:hire_jobs(title)');
    expect(has(q, 'eq', 'org_id', 'org1')).toBe(true);
    expect(has(q, 'filter', 'candidate.name', 'imatch', 'D\\.J\\. \\(Dee\\)\\*')).toBe(true);
    expect(has(q, 'order', 'applied_at', { ascending: false })).toBe(true);
    expect(has(q, 'order', 'id', { ascending: true })).toBe(true);
    expect(has(q, 'limit', APPLICATION_SEARCH_LIMIT + 1)).toBe(true);
    expect(JSON.stringify(q.calls)).not.toMatch(/ilike|"or"/);
    expect(got.rows[0]).toMatchObject({ id: 'a1', candidate_name: 'Person 1', job_title: 'Sales Executive', candidate_pool_status: 'none' });
    expect(got.rows[0]).not.toHaveProperty('candidate');
  });
  it('narrows by stage and outcome in the database, and reads up to the list cap when asked', async () => {
    const { client, queries } = standIn(() => ({ data: [] }));
    await readApplicationSearch(client, 'org1', { name: 'Lim', stage: 'offer', outcome: 'active', limit: HIRE_READ_CAP });
    expect(has(queries[0], 'eq', 'stage', 'offer')).toBe(true);
    expect(has(queries[0], 'eq', 'outcome', 'active')).toBe(true);
    expect(has(queries[0], 'limit', HIRE_READ_CAP)).toBe(true);
  });
  it('with alsoJob, asks a second time by job title and merges the two, newest first, each once', async () => {
    const named = [app(2, { candidate_name: 'Sales Sam' }), app(5)];
    const titled = [app(1), app(2, { candidate_name: 'Sales Sam' })];
    const { client, queries } = standIn((q) => ({ data: (byJob(q) ? titled : named).map(raw) }));
    const got = await readApplicationSearch(client, 'org1', { name: 'sales', alsoJob: true });
    expect(queries).toHaveLength(2);
    const jobQuery = queries.find(byJob)!;
    expect(selectOf(jobQuery)).toContain('job:hire_jobs!inner(title)');
    expect(selectOf(jobQuery)).toContain('candidate:hire_candidates(name,pool_status)');
    expect(has(jobQuery, 'filter', 'job.title', 'imatch', 'sales')).toBe(true);
    expect(got.rows.map((a) => a.id)).toEqual(['a1', 'a2', 'a5']);
    expect(got.more).toBe(false);
  });
  it('keeps the limit and says when there were more', async () => {
    const many = Array.from({ length: APPLICATION_SEARCH_LIMIT + 1 }, (_, i) => raw(app(i)));
    const got = await readApplicationSearch(standIn(() => ({ data: many })).client, 'org1', { name: 'Person' });
    expect(got.rows).toHaveLength(APPLICATION_SEARCH_LIMIT);
    expect(got.more).toBe(true);
    expect((await readApplicationSearch(standIn(() => ({ data: many.slice(0, 3) })).client, 'org1', { name: 'Person' })).more).toBe(false);
    // Two halves that only together overflow.
    const halves = standIn((q) => ({ data: byJob(q) ? many.slice(0, 30) : many.slice(30) }));
    const merged = await readApplicationSearch(halves.client, 'org1', { name: 'x', alsoJob: true });
    expect(merged.rows).toHaveLength(APPLICATION_SEARCH_LIMIT);
    expect(merged.more).toBe(true);
  });
  it('reads nothing for an empty name, and throws when a query fails', async () => {
    const empty = standIn(() => ({ data: [] }));
    expect(await readApplicationSearch(empty.client, 'org1', { name: ' \u0000 ' })).toEqual({ rows: [], more: false });
    expect(empty.queries).toHaveLength(0);
    await expect(readApplicationSearch(standIn(() => ({ error: { code: '42501' } })).client, 'org1', { name: 'Lim' })).rejects.toEqual({ code: '42501' });
  });
});

describe('searchApplicationsFromList', () => {
  const list = [app(1, { candidate_name: 'Aisyah Lim' }), app(2, { candidate_name: 'Tan', job_title: 'Lim Supervisor', outcome: 'rejected' }), app(3)];
  it('matches the candidate\'s name, and the job title with alsoJob, with stage and outcome', () => {
    expect(searchApplicationsFromList(list, { name: 'LIM' }).rows.map((a) => a.id)).toEqual(['a1']);
    expect(searchApplicationsFromList(list, { name: 'lim', alsoJob: true }).rows.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(searchApplicationsFromList(list, { name: 'lim', alsoJob: true, outcome: 'active' }).rows.map((a) => a.id)).toEqual(['a1']);
    expect(searchApplicationsFromList(list, { name: 'person', stage: 'offer' }).rows).toEqual([]);
    expect(searchApplicationsFromList(list, { name: '  ' })).toEqual({ rows: [], more: false });
  });
});

describe('readContacts', () => {
  it('reads only the email and phone of the ids asked for, in this workspace', async () => {
    const { client, queries } = standIn(() => ({ data: [{ id: 'c1', email: 'a@example.com', phone: '012' }] }));
    expect(await readContacts(client, 'org1', ['c1', 'c2', 'c1'])).toEqual([{ id: 'c1', email: 'a@example.com', phone: '012' }]);
    const [q] = queries;
    expect(q.table).toBe('hire_candidates');
    expect(has(q, 'select', 'id,email,phone')).toBe(true);
    expect(has(q, 'eq', 'org_id', 'org1')).toBe(true);
    expect(has(q, 'in', 'id', ['c1', 'c2'])).toBe(true);
  });
  it('asks nothing for no ids', async () => {
    const { client, queries } = standIn(() => ({ data: [] }));
    expect(await readContacts(client, 'org1', [])).toEqual([]);
    expect(queries).toHaveLength(0);
  });
});

/** 1,300 applications: the list read sees only the newest HIRE_READ_CAP, the search sees them all. */
const ALL_APPS = Array.from({ length: 1300 }, (_, i) => app(i, i === 1250 ? { candidate_name: 'Zulaikha Old', candidate_id: 'old' } : {}));
const seed = createSeedHireData(NOW);
const appsData = (over: Partial<HireData> = {}): HireData & { asked: string[] } => {
  const asked: string[] = [];
  return {
    ...seed,
    asked,
    listApplications: async () => ALL_APPS.slice(0, HIRE_READ_CAP),
    listCandidates: async () => { asked.push('listCandidates'); return [person(1, { email: 'p1@example.com' })]; },
    searchApplications: async (query) => searchApplicationsFromList(ALL_APPS, query),
    contactsOf: async (ids) => { asked.push(`contactsOf:${ids.join(',')}`); return ids.map((id) => ({ id, email: `${id}@example.com`, phone: '012' })); },
    ...over,
  };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const listApplications = (data: HireData, input: Record<string, unknown>) =>
  (createHireTools(data, NOW).listApplications as unknown as { execute: (i: unknown, o: unknown) => Promise<Loose> })
    .execute(input, { toolCallId: 't', messages: [] });

describe('findApplications', () => {
  it('uses the provider\'s own search, else the list, and says when that list was cut', async () => {
    expect((await findApplications(appsData(), { name: 'zulaikha' })).rows.map((a) => a.id)).toEqual(['a1250']);
    const fallback = await findApplications(appsData({ searchApplications: undefined }), { name: 'zulaikha' });
    expect(fallback).toEqual({ rows: [], more: false, capped: true });
  });
});

describe('listApplications by a candidate name', () => {
  it('finds an application older than the newest 1,000, with the same row shape', async () => {
    const result = await listApplications(appsData(), { candidate: 'Zulaikha' });
    expect(result.total).toBe(1);
    expect(result.applications[0].id).toBe('a1250');
    expect(Object.keys(result.applications[0]).sort()).toEqual(
      ['applied_at', 'candidate', 'id', 'job', 'label', 'outcome', 'rating', 'reject_reason', 'source', 'stage'],
    );
    expect(result).not.toHaveProperty('more_matches');
  });
  it('says when more applications match the name than were looked at', async () => {
    const result = await listApplications(appsData(), { candidate: 'Person' });
    expect(result.applications).toHaveLength(20);
    expect(result.more_matches).toMatch(/More than 50 applications/);
    expect(result.several_match).toBeDefined();
    // total counts only what was looked at, and the result says so.
    expect(result.total).toBe(50);
    expect(result.total_note).toBe('More applications match this name than total counts: total covers only the newest 50 that were looked at.');
    expect((await listApplications(appsData(), { candidate: 'Zulaikha' }))).not.toHaveProperty('total_note');
  });
  it('without a provider search, says when the list it searched was cut', async () => {
    const result = await listApplications(appsData({ searchApplications: undefined }), { candidate: 'Zulaikha' });
    expect(result.total).toBe(0);
    expect(result.read_capped).toBe(true);
    expect(result.note).toBe(`Only the newest ${HIRE_READ_CAP} applications were searched, so an older application may be missing. Narrow the search or say so.`);
    expect(await listApplications(appsData(), { candidate: 'Zulaikha' })).not.toHaveProperty('read_capped');
    // Without a name, nothing changes.
    expect(await listApplications(appsData({ searchApplications: undefined }), { jobTitle: 'sales' })).not.toHaveProperty('read_capped');
  });
  it('takes a candidate name of at most 100 characters', () => {
    const schema = (createHireTools(seed, NOW).listApplications as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }).inputSchema;
    expect(schema.safeParse({ candidate: 'a'.repeat(100) }).success).toBe(true);
    expect(schema.safeParse({ candidate: 'a'.repeat(101) }).success).toBe(false);
  });
  it('with a job title as well, reads as many as the list would and names the job filter when even that was cut', async () => {
    const seen: unknown[] = [];
    const data = appsData({ searchApplications: async (query) => { seen.push(query); return searchApplicationsFromList(ALL_APPS, query); } });
    const result = await listApplications(data, { candidate: 'Person', jobTitle: 'sales', stage: 'applied', outcome: 'active' });
    expect(seen).toEqual([{ name: 'Person', stage: 'applied', outcome: 'active', limit: HIRE_READ_CAP }]);
    expect(result.more_matches).toMatch(new RegExp(`newest ${HIRE_READ_CAP}`));
    expect(result.more_matches).toMatch(/job/);
  });
  it('without a name, reads the list as before', async () => {
    const data = appsData({ searchApplications: async () => { throw new Error('not asked'); } });
    expect((await listApplications(data, { jobTitle: 'sales' })).total).toBe(HIRE_READ_CAP);
  });
});

describe('listApplications contact details', () => {
  it('reads the email and phone of the shown candidates only, not the capped candidates list', async () => {
    const data = appsData();
    const result = await listApplications(data, { candidate: 'Zulaikha', includeContact: true });
    expect(result.applications[0]).toMatchObject({ email: 'old@example.com', phone: '012' });
    expect(data.asked).toEqual(['contactsOf:old']);
    const shown = await listApplications(appsData(), { includeContact: true, limit: 3 });
    expect(shown.applications.map((a: Loose) => a.email)).toEqual(['c0@example.com', 'c1@example.com', 'c2@example.com']);
  });
  it('asks for no contact details without includeContact', async () => {
    const data = appsData();
    await listApplications(data, { candidate: 'Zulaikha' });
    expect(data.asked).toEqual([]);
  });
  it('falls back to the candidates list for a provider without a contact read', async () => {
    const data = appsData({ contactsOf: undefined });
    const result = await listApplications(data, { includeContact: true, limit: 2 });
    expect(data.asked).toEqual(['listCandidates']);
    expect(result.applications.map((a: Loose) => a.email)).toEqual([null, 'p1@example.com']);
  });
});
