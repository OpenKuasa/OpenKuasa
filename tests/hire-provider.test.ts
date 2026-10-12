import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ hasEnv: true, org: { orgId: 'o1', role: 'member' } as unknown }));
vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => env.hasEnv }));
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: async () => env.org }));

import { getHireData, readPoolStatus } from '@/lib/hire/supabase';

const asked: { table: string; columns: string; org: unknown; orderBy?: string; ascending?: boolean }[] = [];
const ROWS: Record<string, unknown[]> = {
  hire_jobs: [{ id: 'j1', title: 'Sales Executive' }],
  hire_candidates: [{ id: 'c1', name: 'Aisyah Rahim', skills: null }],
  hire_applications: [
    { id: 'a1', candidate_id: 'c1', job_id: 'j1', stage: 'applied', outcome: 'active', candidate: { name: 'Aisyah Rahim' }, job: { title: 'Sales Executive' } },
    { id: 'a2', candidate_id: 'c2', job_id: 'j2', stage: 'applied', outcome: 'active', candidate: null, job: null },
  ],
  hire_interviews: [
    // Descending by scheduled_at, as the database returns them.
    { id: 'i2', application_id: 'a9', scheduled_at: '2026-10-20T09:00:00Z', application: null },
    { id: 'i1', application_id: 'a1', scheduled_at: '2026-10-12T09:00:00Z', application: { candidate: { name: 'Aisyah Rahim' }, job: { title: 'Sales Executive' } } },
  ],
};
const fakeClient = {
  from: (table: string) => ({
    select: (columns: string) => ({
      eq: (_column: string, org: unknown) => ({
        order: (orderBy: string, opts: { ascending: boolean }) => ({
          limit: async () => {
            asked.push({ table, columns, org, orderBy, ascending: opts.ascending });
            return { data: ROWS[table], error: null };
          },
        }),
      }),
    }),
  }),
} as never;

afterEach(() => {
  env.hasEnv = true;
  env.org = { orgId: 'o1', role: 'member' };
  asked.length = 0;
});

describe('getHireData', () => {
  it('reads each table for the current org only', async () => {
    const data = await getHireData(fakeClient);
    await Promise.all([data.listJobs(), data.listCandidates(), data.listApplications(), data.listInterviews()]);
    expect(asked.map((a) => a.table).sort()).toEqual(['hire_applications', 'hire_candidates', 'hire_interviews', 'hire_jobs']);
    expect(asked.every((a) => a.org === 'o1')).toBe(true);
  });

  it('flattens the joined candidate name and job title', async () => {
    const [first] = await (await getHireData(fakeClient)).listApplications();
    expect(first).toMatchObject({ id: 'a1', candidate_name: 'Aisyah Rahim', job_title: 'Sales Executive' });
    expect(first).not.toHaveProperty('candidate');
    const [interview] = await (await getHireData(fakeClient)).listInterviews();
    expect(interview).toMatchObject({ candidate_name: 'Aisyah Rahim', job_title: 'Sales Executive' });
  });

  it('does not throw when a joined row is missing', async () => {
    const data = await getHireData(fakeClient);
    expect((await data.listApplications())[1]).toMatchObject({ candidate_name: 'Unknown', job_title: 'Unknown' });
    expect((await data.listInterviews())[1]).toMatchObject({ candidate_name: 'Unknown', job_title: 'Unknown' });
  });

  it('reads interviews newest-first so the row ceiling keeps them, and returns soonest first', async () => {
    const interviews = await (await getHireData(fakeClient)).listInterviews();
    const ask = asked.find((a) => a.table === 'hire_interviews');
    expect(ask).toMatchObject({ orderBy: 'scheduled_at', ascending: false });
    expect(interviews.map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it('turns a null skills column into an empty list', async () => {
    expect((await (await getHireData(fakeClient)).listCandidates())[0].skills).toEqual([]);
  });

  it('uses the sample data when no project is configured', async () => {
    env.hasEnv = false;
    expect(await (await getHireData(fakeClient)).listJobs()).toHaveLength(9);
  });

  it('shows nothing, never the sample data, to someone in no workspace', async () => {
    env.org = null;
    const data = await getHireData(fakeClient);
    expect(await data.listJobs()).toEqual([]);
    expect(await data.listApplications()).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('throws a query error on to the caller', async () => {
    const failing = {
      from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: new Error('boom') }) }) }) }) }),
    } as never;
    await expect((await getHireData(failing)).listJobs()).rejects.toThrow('boom');
  });

  it('asks for the application detail columns', async () => {
    const data = await getHireData(fakeClient);
    await data.listApplications();
    const columns = asked.filter((a) => a.table === 'hire_applications').at(-1)!.columns.split(',');
    for (const column of ['cover_letter', 'cv_url', 'portfolio_url', 'expected_salary_cents', 'consented_at']) {
      expect(columns, column).toContain(column);
    }
  });

  it('asks for the slice 2a job columns', async () => {
    const data = await getHireData(fakeClient);
    await data.listJobs();
    const columns = asked.find((a) => a.table === 'hire_jobs')!.columns.split(',');
    for (const column of ['description', 'salary_min_cents', 'salary_max_cents', 'show_salary', 'closes_on', 'work_arrangement', 'headcount']) {
      expect(columns, column).toContain(column);
    }
  });

  describe('getSettings', () => {
    const settingsClient = (result: { data: unknown; error: unknown }) => {
      const seen: { table?: string; columns?: string; column?: string; org?: unknown } = {};
      const client = {
        from: (table: string) => ({
          select: (columns: string) => ({
            eq: (column: string, org: unknown) => ({
              maybeSingle: async () => {
                Object.assign(seen, { table, columns, column, org });
                return result;
              },
            }),
          }),
        }),
      } as never;
      return { client, seen };
    };

    it('reads the row for the workspace', async () => {
      const { client, seen } = settingsClient({
        data: { careers_enabled: true, careers_headline: 'Hi', careers_tagline: null, require_cv: true }, error: null,
      });
      expect(await (await getHireData(client)).getSettings()).toEqual({
        org_id: 'o1', careers_enabled: true, careers_headline: 'Hi', careers_tagline: null,
        require_cv: true, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false,
      });
      expect(seen).toEqual({
        table: 'hire_settings', columns: 'careers_enabled,careers_headline,careers_tagline,require_cv,require_cover_letter,ask_portfolio,ask_expected_salary', column: 'org_id', org: 'o1',
      });
    });

    it('gives the defaults when there is no row', async () => {
      const { client } = settingsClient({ data: null, error: null });
      expect(await (await getHireData(client)).getSettings()).toEqual({
        org_id: 'o1', careers_enabled: false, careers_headline: null, careers_tagline: null,
        require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false,
      });
    });

    it('throws a read error on to the caller', async () => {
      const { client } = settingsClient({ data: null, error: new Error('boom') });
      await expect((await getHireData(client)).getSettings()).rejects.toThrow('boom');
    });
  });
});

describe('readPoolStatus', () => {
  const ID = '44444444-4444-4444-8444-444444444444';
  /** A client that records the one read and answers it. */
  const fake = (answer: { data: unknown; error: unknown }) => {
    const seen: { table?: string; columns?: string; filters: Record<string, unknown> } = { filters: {} };
    const chain = {
      select: (columns: string) => { seen.columns = columns; return chain; },
      eq: (key: string, value: unknown) => { seen.filters[key] = value; return chain; },
      maybeSingle: async () => answer,
    };
    return { client: { from: (table: string) => { seen.table = table; return chain; } } as never, seen };
  };
  it('reads the one column of the one row, inside the workspace', async () => {
    const f = fake({ data: { pool_status: 'passive' }, error: null });
    expect(await readPoolStatus(f.client, 'org1', ID)).toBe('passive');
    expect(f.seen).toEqual({ table: 'hire_candidates', columns: 'pool_status', filters: { org_id: 'org1', id: ID } });
  });
  it('answers null for a row that is not there, and for something that is not an id, without reading', async () => {
    expect(await readPoolStatus(fake({ data: null, error: null }).client, 'org1', ID)).toBeNull();
    for (const odd of [undefined, null, '', 7]) {
      const f = fake({ data: { pool_status: 'passive' }, error: null });
      expect(await readPoolStatus(f.client, 'org1', odd)).toBeNull();
      expect(f.seen.table).toBeUndefined();
    }
  });
  it('throws on a failed read, so the caller refuses rather than guesses', async () => {
    await expect(readPoolStatus(fake({ data: null, error: { code: '57014' } }).client, 'org1', ID)).rejects.toEqual({ code: '57014' });
  });
});
