// tests/hire-capped-lists.test.ts
import { describe, expect, it } from 'vitest';
import { CANDIDATE_COLUMNS, readPool } from '@/lib/hire/candidate-search';
import { buildPoolModel } from '@/lib/hire/lists';
import { HIRE_READ_CAP, type Candidate, type HireData } from '@/lib/hire/types';

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
