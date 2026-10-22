// tests/hire-candidate-search.test.ts
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_SEARCH_LIMIT, findCandidates, readCandidateSearch, searchCandidatesFromList, searchPattern,
} from '@/lib/hire/candidate-search';
import { createHireTools } from '@/lib/ai/hire-tools';
import { createSeedHireData } from '@/lib/hire/seed';
import { HIRE_READ_CAP, type Candidate, type HireData } from '@/lib/hire/types';

/**
 * Finding a candidate by name across the whole workspace, not only the newest
 * page. No database here: the client is a stand-in that writes down each query
 * and answers from rows the test gives it, applying nothing itself.
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

describe('searchPattern', () => {
  it('is the text as letters, in any letter case, anywhere in the name', () => {
    expect(searchPattern('Aisyah')).toBe('Aisyah');
    expect(searchPattern('  Aisyah Lim ')).toBe('Aisyah Lim');
    const pattern = new RegExp(searchPattern('isyah l'), 'i');
    expect(pattern.test('Nur AISYAH Lim')).toBe(true);
  });
  it('takes wildcards and pattern signs as plain letters', () => {
    for (const text of ['50%', 'a_b', 'D.J. (Dee)', 'Tan*', 'back\\slash', 'x|y', '[a]', '^Lim$']) {
      const pattern = new RegExp(`^${searchPattern(text)}$`, 'i');
      expect(pattern.test(text), text).toBe(true);
    }
    expect(new RegExp(searchPattern('D.J.'), 'i').test('DxJx')).toBe(false);
    expect(new RegExp(searchPattern('Tan*'), 'i').test('Tann')).toBe(false);
  });
  it('drops characters that take no room', () => {
    expect(searchPattern('Ais​yah')).toBe('Aisyah');
  });
});

describe('readCandidateSearch', () => {
  it('asks the database for the newest matches by name, in this workspace, one more than it keeps', async () => {
    const { client, queries } = standIn(() => ({ data: [] }));
    await readCandidateSearch(client, 'org1', { name: ' 50%_off ' });
    expect(queries).toHaveLength(1);
    const [q] = queries;
    expect(q.table).toBe('hire_candidates');
    expect(has(q, 'eq', 'org_id', 'org1')).toBe(true);
    expect(has(q, 'filter', 'name', 'imatch', '50%_off')).toBe(true);
    expect(has(q, 'order', 'created_at', { ascending: false })).toBe(true);
    expect(has(q, 'limit', CANDIDATE_SEARCH_LIMIT + 1)).toBe(true);
    expect(q.calls.some((c) => c[0] === 'neq' || (c[0] === 'eq' && c[1] === 'pool_status'))).toBe(false);
  });
  it('escapes pattern signs in what is sent', async () => {
    const { client, queries } = standIn(() => ({ data: [] }));
    await readCandidateSearch(client, 'org1', { name: 'D.J. (Dee)*' });
    expect(has(queries[0], 'filter', 'name', 'imatch', 'D\\.J\\. \\(Dee\\)\\*')).toBe(true);
  });
  it('keeps to the talent pool, or one pool status, when asked', async () => {
    const pool = standIn(() => ({ data: [] }));
    await readCandidateSearch(pool.client, 'org1', { name: 'Lim', inPool: true });
    expect(has(pool.queries[0], 'neq', 'pool_status', 'none')).toBe(true);
    const status = standIn(() => ({ data: [] }));
    await readCandidateSearch(status.client, 'org1', { name: 'Lim', inPool: true, poolStatus: 'passive' });
    expect(has(status.queries[0], 'eq', 'pool_status', 'passive')).toBe(true);
  });
  it('keeps the limit and says when there were more matches than that', async () => {
    const many = Array.from({ length: CANDIDATE_SEARCH_LIMIT + 1 }, (_, i) => ({ ...person(i), skills: null }));
    const { client } = standIn(() => ({ data: many }));
    const got = await readCandidateSearch(client, 'org1', { name: 'Person' });
    expect(got.rows).toHaveLength(CANDIDATE_SEARCH_LIMIT);
    expect(got.more).toBe(true);
    expect(got.rows[0].skills).toEqual([]);
    const few = standIn(() => ({ data: many.slice(0, 3) }));
    expect((await readCandidateSearch(few.client, 'org1', { name: 'Person' })).more).toBe(false);
  });
  it('reads nothing for an empty name, and throws when the query fails', async () => {
    const empty = standIn(() => ({ data: [] }));
    expect(await readCandidateSearch(empty.client, 'org1', { name: '  ' })).toEqual({ rows: [], more: false });
    expect(empty.queries).toHaveLength(0);
    const failing = standIn(() => ({ error: { code: '42501' } }));
    await expect(readCandidateSearch(failing.client, 'org1', { name: 'Lim' })).rejects.toEqual({ code: '42501' });
  });
});

describe('searchCandidatesFromList', () => {
  const list = [
    person(1, { name: 'Aisyah Lim', pool_status: 'available' }),
    person(2, { name: 'Nur aisyah', pool_status: 'passive' }),
    person(3, { name: 'Tan Mei Ling' }),
  ];
  it('matches part of the name in any letter case, newest first', () => {
    expect(searchCandidatesFromList(list, { name: 'AISYAH' }).rows.map((c) => c.id)).toEqual(['c1', 'c2']);
  });
  it('keeps to the pool or a pool status when asked', () => {
    expect(searchCandidatesFromList(list, { name: 'a', inPool: true }).rows.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(searchCandidatesFromList(list, { name: 'a', inPool: true, poolStatus: 'passive' }).rows.map((c) => c.id)).toEqual(['c2']);
  });
  it('keeps the limit and says when there were more', () => {
    const many = Array.from({ length: CANDIDATE_SEARCH_LIMIT + 5 }, (_, i) => person(i));
    const got = searchCandidatesFromList(many, { name: 'person' });
    expect(got.rows).toHaveLength(CANDIDATE_SEARCH_LIMIT);
    expect(got.more).toBe(true);
    expect(searchCandidatesFromList(many.slice(0, 2), { name: 'person' }).more).toBe(false);
  });
});

/** A workspace of 1,200 people: the list read sees only the newest HIRE_READ_CAP, the search sees everyone. */
const EVERYONE = Array.from({ length: 1200 }, (_, i) => person(i, i === 1150 ? { name: 'Zulaikha Old', pool_status: 'available' } : {}));
const seed = createSeedHireData(NOW);
const big = (withSearch: boolean): HireData => ({
  ...seed,
  listCandidates: async () => EVERYONE.slice(0, HIRE_READ_CAP),
  listApplications: async () => [],
  ...(withSearch && { searchCandidates: async (query) => searchCandidatesFromList(EVERYONE, query) }),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const exec = (data: HireData, name: string, input: Record<string, unknown>) =>
  (createHireTools(data, NOW)[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<Loose> })
    .execute(input, { toolCallId: 't', messages: [] });

describe('findCandidates', () => {
  it('uses the provider\'s own search when it has one', async () => {
    const got = await findCandidates(big(true), { name: 'zulaikha' });
    expect(got.rows.map((c) => c.id)).toEqual(['c1150']);
    expect(got.capped).toBe(false);
  });
  it('falls back to the list, and says when that list was cut', async () => {
    const got = await findCandidates(big(false), { name: 'zulaikha' });
    expect(got.rows).toEqual([]);
    expect(got.capped).toBe(true);
    const sample = await findCandidates(seed, { name: (await seed.listCandidates())[0].name });
    expect(sample.rows.length).toBeGreaterThan(0);
    expect(sample.capped).toBe(false);
  });
});

describe('the lookup tools find someone older than the newest page', () => {
  it('listCandidates finds a candidate beyond the first 1,000 by name, with the same row shape', async () => {
    const result = await exec(big(true), 'listCandidates', { name: 'Zulaikha' });
    expect(result.total).toBe(1);
    expect(result.candidates[0].id).toBe('c1150');
    expect(Object.keys(result.candidates[0]).sort()).toEqual(
      ['applications', 'headline', 'id', 'location', 'name', 'pool_status', 'skills', 'source'],
    );
    expect(result).not.toHaveProperty('read_capped');
    expect(result).not.toHaveProperty('more_matches');
  });
  it('listTalentPool finds a pool member beyond the first 1,000 by name', async () => {
    const result = await exec(big(true), 'listTalentPool', { name: 'zulaikha' });
    expect(result.total).toBe(1);
    expect(result.candidates[0].id).toBe('c1150');
  });
  it('says when more people match the name than were returned', async () => {
    const result = await exec(big(true), 'listCandidates', { name: 'Person' });
    expect(result.candidates).toHaveLength(20);
    expect(result.more_matches).toMatch(/More than 50/);
    expect(result.several_match).toBeDefined();
  });
  it('without a provider search, the cut list is still flagged', async () => {
    const result = await exec(big(false), 'listCandidates', { name: 'Zulaikha' });
    expect(result.total).toBe(0);
    expect(result.read_capped).toBe(true);
  });
  it('a full applications read only warns that the counts may be low', async () => {
    const firstApp = (await seed.listApplications())[0];
    const data: HireData = { ...big(true), listApplications: async () => Array.from({ length: HIRE_READ_CAP }, (_, i) => ({ ...firstApp, id: `a${i}` })) };
    const result = await exec(data, 'listCandidates', { name: 'Zulaikha' });
    expect(result.candidates[0].id).toBe('c1150');
    expect(result.read_capped).toBe(true);
    expect(result.note).toMatch(/application counts may be low/);
    expect(result.note).not.toMatch(/candidate may be missing/);
  });
});

describe('a wider read when skill or place narrows the name', () => {
  it('asks the database for up to the list cap, and says more only when that came back full', async () => {
    const { client, queries } = standIn(() => ({ data: [] }));
    await readCandidateSearch(client, 'org1', { name: 'Lim', limit: HIRE_READ_CAP });
    expect(has(queries[0], 'limit', HIRE_READ_CAP)).toBe(true);
    const full = standIn(() => ({ data: Array.from({ length: HIRE_READ_CAP }, (_, i) => person(i)) }));
    const got = await readCandidateSearch(full.client, 'org1', { name: 'Person', limit: HIRE_READ_CAP });
    expect(got.rows).toHaveLength(HIRE_READ_CAP);
    expect(got.more).toBe(true);
  });
  const MUHAMMADS = Array.from({ length: 200 }, (_, i) =>
    person(i, { name: `Muhammad ${i}`, skills: i === 120 ? ['React'] : ['Excel'], location: i === 130 ? 'Ipoh' : 'Shah Alam' }));
  const many = (): HireData => ({
    ...seed,
    listCandidates: async () => MUHAMMADS,
    listApplications: async () => [],
    searchCandidates: async (query) => searchCandidatesFromList(MUHAMMADS, query),
  });
  it('listCandidates finds the only skill match older than the newest 50 of that name, with no "more of the name"', async () => {
    const result = await exec(many(), 'listCandidates', { name: 'Muhammad', skill: 'react' });
    expect(result.candidates.map((c: Loose) => c.id)).toEqual(['c120']);
    expect(result).not.toHaveProperty('more_matches');
    const placed = await exec(many(), 'listCandidates', { name: 'Muhammad', location: 'ipoh' });
    expect(placed.candidates.map((c: Loose) => c.id)).toEqual(['c130']);
  });
  it('listTalentPool does the same', async () => {
    const pool = MUHAMMADS.map((c) => ({ ...c, pool_status: 'available' as const }));
    const data: HireData = { ...many(), searchCandidates: async (query) => searchCandidatesFromList(pool, query) };
    const result = await exec(data, 'listTalentPool', { name: 'Muhammad', skill: 'react' });
    expect(result.candidates.map((c: Loose) => c.id)).toEqual(['c120']);
    expect(result).not.toHaveProperty('more_matches');
  });
  it('when even the wider read was cut, says the filter covered only the newest people of that name', async () => {
    const lots = Array.from({ length: HIRE_READ_CAP + 10 }, (_, i) => person(i, { name: `Muhammad ${i}` }));
    const data: HireData = { ...many(), searchCandidates: async (query) => searchCandidatesFromList(lots, query) };
    const result = await exec(data, 'listCandidates', { name: 'Muhammad', skill: 'react' });
    expect(result.more_matches).toMatch(new RegExp(`newest ${HIRE_READ_CAP}`));
    expect(result.more_matches).toMatch(/skill/);
  });
});

describe('what is typed is cleaned once', () => {
  it('a name with a character that takes no room still finds the person', async () => {
    const result = await exec(big(true), 'listCandidates', { name: 'Zulai​kha' });
    expect(result.candidates.map((c: Loose) => c.id)).toEqual(['c1150']);
  });
  it('NUL bytes never reach the database', async () => {
    const { client, queries } = standIn(() => ({ data: [] }));
    await readCandidateSearch(client, 'org1', { name: 'Li\u0000m' });
    expect(has(queries[0], 'filter', 'name', 'imatch', 'Lim')).toBe(true);
  });
  it('the tools take a name of at most 100 characters', () => {
    const tools = createHireTools(seed, NOW);
    for (const name of ['listCandidates', 'listTalentPool']) {
      const schema = (tools[name] as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }).inputSchema;
      expect(schema.safeParse({ name: 'a'.repeat(100) }).success, name).toBe(true);
      expect(schema.safeParse({ name: 'a'.repeat(101) }).success, name).toBe(false);
    }
  });
});
