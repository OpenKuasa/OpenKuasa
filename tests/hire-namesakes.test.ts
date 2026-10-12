// tests/hire-namesakes.test.ts
import { describe, expect, it } from 'vitest';
import {
  NAMESAKE_LIMIT, interviewCardFromLists, nameRegex, namesakesFromLists, readInterviewCard, readNamesakes, sameText,
} from '@/lib/hire/namesakes';

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

const NOTHING = { target: null, others: [], cut: false, also: [], alsoClosed: [], application_outcome: null };

describe('readInterviewCard', () => {
  const IV = '99999999-9999-4999-8999-999999999999';
  const SECOND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const THIRD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const APP = '77777777-7777-4777-8777-777777777777';
  const TWIN_APP = '88888888-8888-4888-8888-888888888888';
  const found = {
    id: IV, application_id: APP, scheduled_at: '2026-10-20T07:00:00+00:00', kind: 'video', status: 'scheduled', duration_minutes: 45, place: 'Level 3',
    application: { outcome: 'active', candidate_id: A, candidate: { name: 'Aisyah Lim' }, job: { title: 'Barista' } },
  };
  const byId = (q: { table: string; calls: [string, ...unknown[]][] }) =>
    q.table === 'hire_interviews' && q.calls.some((c) => c[0] === 'eq' && c[1] === 'id');
  const OTHER_APP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const FOURTH = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const selects = (q: { calls: [string, ...unknown[]][] }, text: string) => q.calls.some((c) => c[0] === 'select' && c[1] === text);
  const rest = { status: 'scheduled', duration_minutes: 60, place: null };
  /** Answers each of the seven reads; `over` replaces the answer for one table of the middle four, or one of the last two (`every_application`, `scheduled`). */
  const answering = (over: Record<string, { data?: unknown; error?: unknown }> = {}) =>
    standIn((q) => {
      if (byId(q)) return over.target ?? { data: found };
      if (q.table === 'hire_candidates') return over.hire_candidates ?? { data: [{ id: A, name: 'Aisyah Lim' }, { id: B, name: 'aisyah  lim' }, { id: C, name: 'Aisyah Lim x' }] };
      if (q.table === 'hire_jobs') return over.hire_jobs ?? { data: [{ id: 'j1', title: 'Barista' }, { id: 'j2', title: 'barista ' }, { id: 'j3', title: 'Barista (night)' }] };
      if (q.table === 'hire_applications' && selects(q, 'id,job:hire_jobs(title)')) {
        return over.every_application ?? over.hire_applications ?? { data: [{ id: APP, job: { title: 'Barista' } }, { id: OTHER_APP, job: { title: 'Cashier' } }] };
      }
      if (q.table === 'hire_applications') return over.hire_applications ?? { data: [{ id: TWIN_APP }, { id: APP }] };
      // The last read: every other interview of the candidate's own applications, whatever its status.
      if (q.calls.some((c) => c[0] === 'in' && c[1] === 'application_id' && JSON.stringify(c[2]) === JSON.stringify([APP, OTHER_APP]))) {
        return over.scheduled ?? over.hire_interviews ?? {
          data: [
            { id: FOURTH, application_id: OTHER_APP, scheduled_at: '2026-10-23T02:00:00+00:00', kind: 'phone', ...rest, place: '+60 12-345 6789' },
            { id: SECOND, application_id: APP, scheduled_at: '2026-10-27T07:00:00+00:00', kind: 'onsite', ...rest, status: 'completed' },
          ],
        };
      }
      return over.hire_interviews ?? {
        data: [
          { id: SECOND, application_id: APP, scheduled_at: '2026-10-27T07:00:00+00:00', kind: 'onsite', ...rest, status: 'completed' },
          { id: THIRD, application_id: TWIN_APP, scheduled_at: '2026-10-20T07:00:00+00:00', kind: 'video', ...rest },
        ],
      };
    });

  it('reads the interview by its id, then every other interview of someone of that name for a job of that title', async () => {
    const { client, queries } = answering();
    const got = await readInterviewCard(client, 'org1', IV);
    expect(queries.map((q) => q.table)).toEqual(['hire_interviews', 'hire_candidates', 'hire_jobs', 'hire_applications', 'hire_interviews', 'hire_applications', 'hire_interviews']);
    for (const query of queries) expect(has(query, 'eq', 'org_id', 'org1'), query.table).toBe(true);

    expect(has(queries[0], 'eq', 'id', IV)).toBe(true);
    expect(has(queries[0], 'select', 'id,application_id,scheduled_at,kind,status,duration_minutes,place,application:hire_applications(outcome,candidate_id,candidate:hire_candidates(name),job:hire_jobs(title))')).toBe(true);

    expect(has(queries[1], 'select', 'id,name')).toBe(true);
    expect(has(queries[1], 'filter', 'name', 'imatch', '^\\s*(Aisyah\\s+Lim)\\s*$')).toBe(true);
    expect(has(queries[1], 'limit', NAMESAKE_LIMIT + 1)).toBe(true);

    expect(has(queries[2], 'select', 'id,title')).toBe(true);
    expect(has(queries[2], 'filter', 'title', 'imatch', '^\\s*(Barista)\\s*$')).toBe(true);
    expect(has(queries[2], 'limit', NAMESAKE_LIMIT + 1)).toBe(true);

    // A person and a job the database let through that are not the same name are left out by the code.
    expect(has(queries[3], 'in', 'candidate_id', [A, B])).toBe(true);
    expect(has(queries[3], 'in', 'job_id', ['j1', 'j2'])).toBe(true);
    expect(has(queries[3], 'limit', NAMESAKE_LIMIT + 1)).toBe(true);

    // The interview's own application is always among them: a second round is the common case.
    expect(has(queries[4], 'in', 'application_id', [APP, TWIN_APP])).toBe(true);
    expect(has(queries[4], 'neq', 'id', IV)).toBe(true);
    expect(has(queries[4], 'select', 'id,application_id,scheduled_at,kind,status,duration_minutes,place')).toBe(true);
    expect(has(queries[4], 'order', 'scheduled_at', { ascending: true })).toBe(true);
    expect(has(queries[4], 'limit', NAMESAKE_LIMIT + 1)).toBe(true);

    // Every application of this very candidate, whatever the job (by the candidate's id, never by name: a namesake's
    // interviews are not this person's); then the other interviews of those applications.
    expect(has(queries[5], 'select', 'id,job:hire_jobs(title)')).toBe(true);
    expect(has(queries[5], 'eq', 'candidate_id', A)).toBe(true);
    expect(queries[5].calls.some((c) => c[0] === 'in')).toBe(false);
    expect(queries[5].calls.some((c) => c[0] === 'filter')).toBe(false);
    expect(has(queries[5], 'limit', NAMESAKE_LIMIT + 1)).toBe(true);
    expect(has(queries[6], 'neq', 'id', IV)).toBe(true);
    expect(has(queries[6], 'in', 'application_id', [APP, OTHER_APP])).toBe(true);
    expect(has(queries[6], 'order', 'scheduled_at', { ascending: true })).toBe(true);
    expect(has(queries[6], 'limit', NAMESAKE_LIMIT + 1)).toBe(true);

    expect(got).toEqual({
      target: { id: IV, application_id: APP, candidate: 'Aisyah Lim', job: 'Barista', scheduled_at: '2026-10-20T07:00:00+00:00', kind: 'video', status: 'scheduled', duration_minutes: 45, place: 'Level 3' },
      others: [
        { id: SECOND, application_id: APP, candidate: 'Aisyah Lim', job: 'Barista', scheduled_at: '2026-10-27T07:00:00+00:00', kind: 'onsite', ...rest, status: 'completed' },
        { id: THIRD, application_id: TWIN_APP, candidate: 'Aisyah Lim', job: 'Barista', scheduled_at: '2026-10-20T07:00:00+00:00', kind: 'video', ...rest },
      ],
      cut: false,
      // Still scheduled, with this candidate, each under its own job's title. The namesake's interview (THIRD) is in
      // `others`, because a card could be taken for it; it is not listed as this person's.
      also: [
        { id: FOURTH, application_id: OTHER_APP, candidate: 'Aisyah Lim', job: 'Cashier', scheduled_at: '2026-10-23T02:00:00+00:00', kind: 'phone', ...rest, place: '+60 12-345 6789' },
      ],
      // And her other interviews that are over: what a "mark as scheduled again" card lists.
      alsoClosed: [
        { id: SECOND, application_id: APP, candidate: 'Aisyah Lim', job: 'Barista', scheduled_at: '2026-10-27T07:00:00+00:00', kind: 'onsite', ...rest, status: 'completed' },
      ],
      application_outcome: 'active',
    });
  });
  it('reads no contact detail and no notes at any step; the place is read, for the card', async () => {
    const { client, queries } = answering();
    await readInterviewCard(client, 'org1', IV);
    const selected = queries.map((q) => String(q.calls.find((c) => c[0] === 'select')?.[1])).join(' ');
    expect(selected).not.toMatch(/email|phone|notes|interviewer|cv_/);
  });
  it('still looks among the interview\'s own application when the applications read does not return it', async () => {
    const { client, queries } = answering({ hire_applications: { data: [] } });
    await readInterviewCard(client, 'org1', IV);
    expect(has(queries[4], 'in', 'application_id', [APP])).toBe(true);
  });
  it('an interview that is not there, or an id that is not text: nothing, and no further query', async () => {
    const missing = answering({ target: { data: null } });
    expect(await readInterviewCard(missing.client, 'org1', IV)).toEqual(NOTHING);
    expect(missing.queries).toHaveLength(1);
    for (const odd of [undefined, null, '', 7, {}]) {
      const { client, queries } = answering();
      expect(await readInterviewCard(client, 'org1', odd)).toEqual(NOTHING);
      expect(queries).toHaveLength(0);
    }
  });
  it('an interview whose candidate or job cannot be read with it is not described', async () => {
    const nameless = answering({ target: { data: { ...found, application: { candidate: null, job: { title: 'Barista' } } } } });
    expect(await readInterviewCard(nameless.client, 'org1', IV)).toEqual(NOTHING);
    expect(nameless.queries).toHaveLength(1);
    const orphan = answering({ target: { data: { ...found, application: null } } });
    expect((await readInterviewCard(orphan.client, 'org1', IV)).target).toBeNull();
  });
  it('says so when any of the reads had more rows than it took', async () => {
    const people = Array.from({ length: NAMESAKE_LIMIT + 1 }, (_, n) => ({ id: `c-${n}`, name: 'Aisyah Lim' }));
    expect((await readInterviewCard(answering({ hire_candidates: { data: people } }).client, 'org1', IV)).cut).toBe(true);
    const jobs = Array.from({ length: NAMESAKE_LIMIT + 1 }, (_, n) => ({ id: `j-${n}`, title: 'Barista' }));
    expect((await readInterviewCard(answering({ hire_jobs: { data: jobs } }).client, 'org1', IV)).cut).toBe(true);
    const applications = Array.from({ length: NAMESAKE_LIMIT + 1 }, (_, n) => ({ id: `a-${n}` }));
    expect((await readInterviewCard(answering({ hire_applications: { data: applications } }).client, 'org1', IV)).cut).toBe(true);
    const interviews = Array.from({ length: NAMESAKE_LIMIT + 1 }, (_, n) => ({ id: `i-${n}`, application_id: APP, scheduled_at: '2026-10-27T07:00:00+00:00', kind: 'video', ...rest }));
    const many = await readInterviewCard(answering({ hire_interviews: { data: interviews }, scheduled: { data: [] } }).client, 'org1', IV);
    expect(many.cut).toBe(true);
    expect(many.others).toHaveLength(NAMESAKE_LIMIT);
    // The list of what else is scheduled is for reading: more than were read does not refuse the change.
    const listed = await readInterviewCard(answering({ scheduled: { data: interviews } }).client, 'org1', IV);
    expect(listed.cut).toBe(false);
    expect(listed.also).toHaveLength(NAMESAKE_LIMIT);
  });
  it('throws what the database answered with at any step, for the caller to refuse on', async () => {
    await expect(readInterviewCard(answering({ target: { error: { code: '42501' } } }).client, 'org1', IV)).rejects.toEqual({ code: '42501' });
    for (const table of ['hire_candidates', 'hire_jobs', 'hire_applications', 'hire_interviews', 'every_application', 'scheduled']) {
      await expect(readInterviewCard(answering({ [table]: { error: { code: '57014' } } }).client, 'org1', IV), table).rejects.toEqual({ code: '57014' });
    }
  });
});

describe('interviewCardFromLists', () => {
  const interview = (id: string, application_id: string, candidate_name: string, job_title: string, scheduled_at: string, kind: 'video' | 'onsite' | 'phone' = 'video') =>
    ({ id, application_id, candidate_name, job_title, scheduled_at, kind, status: 'scheduled' as const, duration_minutes: 60, place: null, application_outcome: 'active' as const });
  const more = { status: 'scheduled', duration_minutes: 60, place: null };
  const applications = [{ id: 'a1', candidate_id: 'c1' }, { id: 'a2', candidate_id: 'c2' }, { id: 'a3', candidate_id: 'c1' }, { id: 'a4', candidate_id: 'c9' }];
  const list = [
    interview('i1', 'a1', 'Aisyah Lim', 'Barista', '2026-10-20T07:00:00Z'),
    interview('i2', 'a1', 'Aisyah Lim', 'Barista', '2026-10-27T07:00:00Z', 'onsite'),
    interview('i3', 'a2', ' aisyah  LIM', 'BARISTA ', '2026-10-20T07:00:00Z'),
    interview('i4', 'a3', 'Aisyah Lim', 'Cashier', '2026-10-20T07:00:00Z'),
    interview('i5', 'a4', 'Farid Osman', 'Barista', '2026-10-20T07:00:00Z'),
  ];
  it('finds the interview and the others with the same name and the same job, of the same application or a namesake\'s', () => {
    expect(interviewCardFromLists('i1', list, applications)).toEqual({
      target: { id: 'i1', application_id: 'a1', candidate: 'Aisyah Lim', job: 'Barista', scheduled_at: '2026-10-20T07:00:00Z', kind: 'video', ...more },
      others: [
        { id: 'i2', application_id: 'a1', candidate: 'Aisyah Lim', job: 'Barista', scheduled_at: '2026-10-27T07:00:00Z', kind: 'onsite', ...more },
        { id: 'i3', application_id: 'a2', candidate: ' aisyah  LIM', job: 'BARISTA ', scheduled_at: '2026-10-20T07:00:00Z', kind: 'video', ...more },
      ],
      cut: false,
      // Everything else still scheduled with this very candidate, for any job, soonest first: a1 and a3 are hers,
      // a2 is a namesake's.
      also: [
        { id: 'i4', application_id: 'a3', candidate: 'Aisyah Lim', job: 'Cashier', scheduled_at: '2026-10-20T07:00:00Z', kind: 'video', ...more },
        { id: 'i2', application_id: 'a1', candidate: 'Aisyah Lim', job: 'Barista', scheduled_at: '2026-10-27T07:00:00Z', kind: 'onsite', ...more },
      ],
      alsoClosed: [],
      application_outcome: 'active',
    });
    // One that is no longer scheduled is not listed as still to come.
    const closed = list.map((i) => (i.id === 'i2' ? { ...i, status: 'cancelled' as const } : i));
    expect(interviewCardFromLists('i1', closed, applications).also.map((i) => i.id)).toEqual(['i4']);
    expect(interviewCardFromLists('i1', closed, applications).alsoClosed).toEqual([{ id: 'i2', application_id: 'a1', candidate: 'Aisyah Lim', job: 'Barista', scheduled_at: '2026-10-27T07:00:00Z', kind: 'onsite', ...more, status: 'cancelled' }]);
    expect(interviewCardFromLists('i1', closed, applications).others.map((i) => i.id)).toEqual(['i2', 'i3']);
    // The namesake's own card lists nothing of hers.
    expect(interviewCardFromLists('i3', list, applications).also).toEqual([]);
    // Without the applications, only the interview's own application is known to be the same person's.
    expect(interviewCardFromLists('i1', list).also.map((i) => i.id)).toEqual(['i2']);
  });
  it('has no others for an interview that is alone, and nothing for an id that is not in the list', () => {
    expect(interviewCardFromLists('i5', list).others).toEqual([]);
    expect(interviewCardFromLists('i4', list).others).toEqual([]);
    for (const id of ['nobody', undefined, null, 7]) expect(interviewCardFromLists(id, list)).toEqual(NOTHING);
    expect(interviewCardFromLists('i1', [])).toEqual(NOTHING);
  });
});
