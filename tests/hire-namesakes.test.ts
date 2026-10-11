// tests/hire-namesakes.test.ts
import { describe, expect, it } from 'vitest';
import { NAMESAKE_LIMIT, nameRegex, namesakesFromLists, readNamesakes, sameText } from '@/lib/hire/namesakes';

/**
 * The read that finds the rows sharing a name with one row. No database here:
 * the client is a stand-in that writes down each query and answers from rows
 * the test gives it, applying nothing itself. So what is pinned is how each
 * query is put (table, filters, bound) and what the code makes of the answer.
 * That the database's own match behaves as written is for the live test.
 */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

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
      builder.maybeSingle = async () => settle();
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(settle()).then(resolve);
      return builder;
    },
  };
  return { client: client as never, queries };
}
const has = (query: Query, ...call: unknown[]) => query.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));
const person = (id: string, name: string, over: Record<string, unknown> = {}) =>
  ({ id, name, email: null, location: null, headline: null, created_at: '2026-10-03T02:00:00Z', ...over });

describe('sameText', () => {
  it('is blind to letter case, spacing, and how the same letters are written down', () => {
    expect(sameText('  Aisyah   LIM ')).toBe(sameText('aisyah lim'));
    expect(sameText('Aisyah Lim')).toBe(sameText('Aisyah Lim'));
    // A composed and a decomposed é; a full-width letter; a character that takes no room.
    expect(sameText('Renée Tan')).toBe(sameText('Renée Tan'));
    expect(sameText('Ａisyah Lim')).toBe(sameText('Aisyah Lim'));
    expect(sameText('Ais​yah Lim')).toBe(sameText('Aisyah Lim'));
    expect(sameText('Aisyah Lim Abdullah')).not.toBe(sameText('Aisyah Lim'));
    expect(sameText('Aisyah Liem')).not.toBe(sameText('Aisyah Lim'));
  });
});

describe('nameRegex', () => {
  it('is the words in order, with any spacing between and around them, and nothing else', () => {
    expect(nameRegex('Aisyah Lim')).toBe('^\\s*(Aisyah\\s+Lim)\\s*$');
    expect(nameRegex('  Aisyah \t Lim ')).toBe('^\\s*(Aisyah\\s+Lim)\\s*$');
    const pattern = new RegExp(nameRegex('Aisyah Lim'), 'i');
    for (const yes of ['aisyah lim', ' AISYAH   LIM ']) expect(pattern.test(yes), yes).toBe(true);
    for (const no of ['Aisyah Halim', 'Nur Aisyah Lim', 'Aisyah Lim Abdullah', 'AisyahLim']) expect(pattern.test(no), no).toBe(false);
  });
  it('takes the letters of a name as letters, not as a pattern', () => {
    const pattern = new RegExp(nameRegex('D.J. (Dee) O\'Neil+'), 'i');
    expect(pattern.test('d.j. (dee) o\'neil+')).toBe(true);
    expect(pattern.test('DxJx Dee O\'Neill')).toBe(false);
  });
  it('tries the name in each way its letters can be encoded', () => {
    const pattern = new RegExp(nameRegex('Renée Tan'), 'i');
    expect(pattern.test('Renée Tan')).toBe(true);
    expect(pattern.test('Renée Tan')).toBe(true);
  });
});

describe('readNamesakes, for a candidate', () => {
  it('reads the row by its id, then the people of that name, bounded, in the caller\'s workspace', async () => {
    const { client, queries } = standIn((q) =>
      q.calls.some((c) => c[0] === 'filter')
        ? { data: [person(A, 'Aisyah Lim', { email: 'a@example.com' }), person(B, 'aisyah  lim', { location: 'Ipoh' }), person(C, 'Aisyah Lim x')] }
        : { data: person(A, 'Aisyah Lim', { email: 'a@example.com' }) });
    const got = await readNamesakes(client, 'org1', 'candidate', A);
    expect(queries.map((q) => q.table)).toEqual(['hire_candidates', 'hire_candidates']);
    expect(has(queries[0], 'eq', 'org_id', 'org1')).toBe(true);
    expect(has(queries[0], 'eq', 'id', A)).toBe(true);
    expect(has(queries[1], 'eq', 'org_id', 'org1')).toBe(true);
    expect(has(queries[1], 'filter', 'name', 'imatch', '^\\s*(Aisyah\\s+Lim)\\s*$')).toBe(true);
    expect(has(queries[1], 'limit', NAMESAKE_LIMIT + 1)).toBe(true);
    // No phone, and nothing that is not needed to tell two people apart.
    expect(has(queries[1], 'select', 'id,name,email,location,headline,created_at')).toBe(true);
    // The row itself and a row the database let through that is not the same name are left out by the code.
    expect(got).toEqual({
      target: { id: A, name: 'Aisyah Lim', job: null, email: 'a@example.com', location: null, headline: null, added_at: '2026-10-03T02:00:00Z' },
      others: [{ id: B, name: 'aisyah  lim', job: null, email: null, location: 'Ipoh', headline: null, added_at: '2026-10-03T02:00:00Z' }],
      cut: false,
    });
  });
  it('a row that is not there, or an id that is not text: nobody, and no second query', async () => {
    const { client, queries } = standIn(() => ({ data: null }));
    expect(await readNamesakes(client, 'org1', 'candidate', A)).toEqual({ target: null, others: [], cut: false });
    expect(queries).toHaveLength(1);
    expect(await readNamesakes(client, 'org1', 'candidate', undefined)).toEqual({ target: null, others: [], cut: false });
    expect(queries).toHaveLength(1);
  });
  it('says so when there were more of that name than it read', async () => {
    const many = Array.from({ length: NAMESAKE_LIMIT + 1 }, (_, n) => person(`id-${n}`, 'Aisyah Lim'));
    const { client } = standIn((q) => (q.calls.some((c) => c[0] === 'filter') ? { data: many } : { data: person(A, 'Aisyah Lim') }));
    expect((await readNamesakes(client, 'org1', 'candidate', A)).cut).toBe(true);
  });
  it('throws what the database answered with, for the caller to refuse on', async () => {
    const { client } = standIn(() => ({ error: { code: '42883' } }));
    await expect(readNamesakes(client, 'org1', 'candidate', A)).rejects.toEqual({ code: '42883' });
    const later = standIn((q) => (q.calls.some((c) => c[0] === 'filter') ? { error: { code: 'PGRST100' } } : { data: person(A, 'Aisyah Lim') }));
    await expect(readNamesakes(later.client, 'org1', 'candidate', A)).rejects.toEqual({ code: 'PGRST100' });
  });
});

describe('readNamesakes, for an application', () => {
  const APP = '77777777-7777-4777-8777-777777777777';
  const TWIN = '88888888-8888-4888-8888-888888888888';
  it('finds the other applications from someone of that name for a job of that title', async () => {
    const { client, queries } = standIn((q) => {
      if (q.table === 'hire_applications' && q.calls.some((c) => c[0] === 'eq' && c[1] === 'id')) {
        return { data: { id: APP, candidate_id: A, job_id: 'j1', applied_at: '2026-10-03T02:00:00Z', candidate: { name: 'Aisyah Lim', email: 'a@example.com', location: null, headline: null }, job: { title: 'Barista' } } };
      }
      if (q.table === 'hire_candidates') return { data: [person(A, 'Aisyah Lim', { email: 'a@example.com' }), person(B, 'Aisyah Lim', { email: 'b@example.com' })] };
      if (q.table === 'hire_jobs') return { data: [{ id: 'j1', title: 'Barista' }, { id: 'j2', title: 'barista ' }, { id: 'j3', title: 'Barista (night)' }] };
      return { data: [{ id: TWIN, candidate_id: B, applied_at: '2026-09-01T02:00:00Z' }] };
    });
    const got = await readNamesakes(client, 'org1', 'application', APP);
    expect(queries.map((q) => q.table)).toEqual(['hire_applications', 'hire_candidates', 'hire_jobs', 'hire_applications']);
    expect(has(queries[2], 'filter', 'title', 'imatch', '^\\s*(Barista)\\s*$')).toBe(true);
    const twins = queries[3];
    expect(has(twins, 'eq', 'org_id', 'org1')).toBe(true);
    expect(has(twins, 'neq', 'id', APP)).toBe(true);
    expect(has(twins, 'in', 'candidate_id', [A, B])).toBe(true);
    // A job the database let through whose title is not the same is left out by the code.
    expect(has(twins, 'in', 'job_id', ['j1', 'j2'])).toBe(true);
    expect(has(twins, 'limit', NAMESAKE_LIMIT + 1)).toBe(true);
    expect(got).toEqual({
      target: { id: APP, name: 'Aisyah Lim', job: 'Barista', email: 'a@example.com', location: null, headline: null, added_at: '2026-10-03T02:00:00Z' },
      others: [{ id: TWIN, name: 'Aisyah Lim', job: 'Barista', email: 'b@example.com', location: null, headline: null, added_at: '2026-09-01T02:00:00Z' }],
      cut: false,
    });
  });
});

describe('namesakesFromLists', () => {
  const candidates = [person(A, 'Aisyah Lim', { email: 'a@example.com' }), person(B, ' aisyah  LIM', { location: 'Ipoh' }), person(C, 'Farid Osman')] as never;
  const application = (id: string, candidate_id: string, candidate_name: string, job_title: string) =>
    ({ id, candidate_id, candidate_name, job_title, applied_at: '2026-10-05T02:00:00Z' });
  it('finds a candidate\'s namesakes', () => {
    const got = namesakesFromLists('candidate', A, candidates, []);
    expect(got.target?.id).toBe(A);
    expect(got.others.map((o) => o.id)).toEqual([B]);
    expect(namesakesFromLists('candidate', C, candidates, []).others).toEqual([]);
    expect(namesakesFromLists('candidate', 'nobody', candidates, [])).toEqual({ target: null, others: [], cut: false });
  });
  it('for an application, needs the same name and the same job, and describes each by its candidate', () => {
    const apps = [application('x1', A, 'Aisyah Lim', 'Barista'), application('x2', B, 'aisyah lim', ' BARISTA'), application('x3', B, 'aisyah lim', 'Cashier'), application('x4', C, 'Farid Osman', 'Barista')];
    const got = namesakesFromLists('application', 'x1', candidates, apps);
    expect(got.target).toMatchObject({ id: 'x1', job: 'Barista', email: 'a@example.com', added_at: '2026-10-05T02:00:00Z' });
    expect(got.others).toEqual([{ id: 'x2', name: 'aisyah lim', job: ' BARISTA', email: null, location: 'Ipoh', headline: null, added_at: '2026-10-05T02:00:00Z' }]);
  });
});
