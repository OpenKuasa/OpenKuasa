import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '11111111-1111-4111-8111-111111111111';

type Query = {
  table: string;
  op: 'select' | 'delete';
  columns?: string;
  filters: Record<string, unknown>;
  gte?: [string, unknown];
  order?: [string, { ascending: boolean }];
  limit?: number;
  range?: [number, number];
};

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  queries: [] as unknown[],
  /** Answers, in the order the queries are made. */
  answers: [] as { data: unknown; error: unknown }[],
  revalidated: [] as string[],
}));

/** A stand-in client: records each query and answers with the next canned result. */
function fakeClient() {
  return {
    from(table: string) {
      const query: Query = { table, op: 'select', filters: {} };
      ctl.queries.push(query);
      const answer = () => Promise.resolve(ctl.answers.shift() ?? { data: [], error: null });
      const builder = {
        select(columns: string) { query.columns = columns; return builder; },
        delete() { query.op = 'delete'; return builder; },
        eq(column: string, value: unknown) { query.filters[column] = value; return builder; },
        gte(column: string, value: unknown) { query.gte = [column, value]; return builder; },
        order(column: string, options: { ascending: boolean }) { query.order = [column, options]; return builder; },
        limit(n: number) { query.limit = n; return builder; },
        range(from: number, to: number) { query.range = [from, to]; return builder; },
        maybeSingle: () => answer(),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          answer().then(resolve, reject),
      };
      return builder;
    },
  };
}

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer, hasSupabaseEnv: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeClient() }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { ctl.revalidated.push(path); } }));

const { createSupabaseReachData } = await import('@/lib/reach/supabase');
const { createSeedReachData } = await import('@/lib/reach/seed');
const { deleteFormSubmission, deleteFormSubmissionInput } = await import('@/lib/reach/capabilities');
const { deleteFormSubmissionAction, listFormSubmissionsAction } = await import('@/app/(app)/reach/actions');

const queries = () => ctl.queries as Query[];
const stored = (n: number) => ({
  id: `s${n}`, form_id: ID, contact_id: `c${n}`, created_at: `2026-10-10T0${n}:00:00Z`,
  payload: { name: `Person ${n}`, email: `p${n}@example.com`, phone: null, message: null },
});

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  ctl.queries = [];
  ctl.answers = [];
  ctl.revalidated = [];
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
});

describe('the Supabase provider reads submissions', () => {
  it('lists one form\'s newest twenty, in the caller workspace', async () => {
    ctl.answers = [{ data: [stored(2), stored(1)], error: null }];
    const rows = await createSupabaseReachData(fakeClient() as never, 'org1').listFormSubmissions!(ID);
    expect(rows.map((r) => r.id)).toEqual(['s2', 's1']);
    expect(rows[0]).toEqual({
      id: 's2', form_id: ID, contact_id: 'c2', name: 'Person 2', email: 'p2@example.com',
      phone: null, message: null, consent_text: null, consented_at: null, created_at: '2026-10-10T02:00:00Z',
    });
    expect(queries()).toEqual([
      {
        table: 'form_submissions', op: 'select', columns: 'id,form_id,contact_id,payload,consent_text,consented_at,created_at',
        filters: { org_id: 'org1', form_id: ID }, order: ['created_at', { ascending: false }], limit: 20,
      },
    ]);
  });

  it('takes another limit when asked', async () => {
    await createSupabaseReachData(fakeClient() as never, 'org1').listFormSubmissions!(ID, 5);
    expect(queries()[0].limit).toBe(5);
  });

  it('throws what the database refused, so the caller can say so', async () => {
    ctl.answers = [{ data: null, error: { code: '42P01', message: 'no table' } }];
    await expect(createSupabaseReachData(fakeClient() as never, 'org1').listFormSubmissions!(ID))
      .rejects.toMatchObject({ code: '42P01' });
  });

  it('reads submission times since a moment, only the one column', async () => {
    ctl.answers = [{ data: [{ created_at: 'b' }, { created_at: 'a' }], error: null }];
    const times = await createSupabaseReachData(fakeClient() as never, 'org1')
      .listFormSubmissionTimes!('2026-09-27T16:00:00.000Z');
    expect(times).toEqual(['b', 'a']);
    expect(queries()).toEqual([
      {
        table: 'form_submissions', op: 'select', columns: 'created_at', filters: { org_id: 'org1' },
        gte: ['created_at', '2026-09-27T16:00:00.000Z'],
        order: ['created_at', { ascending: false }], range: [0, 999],
      },
    ]);
  });

  it('keeps reading while a page comes back full', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ created_at: `t${i}` }));
    ctl.answers = [
      { data: page(1000), error: null },
      { data: page(1000), error: null },
      { data: page(3), error: null },
    ];
    const times = await createSupabaseReachData(fakeClient() as never, 'org1').listFormSubmissionTimes!('x');
    expect(times).toHaveLength(2003);
    expect(queries().map((q) => q.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('stops at twenty pages however many there are', async () => {
    const full = Array.from({ length: 1000 }, () => ({ created_at: 't' }));
    ctl.answers = Array.from({ length: 30 }, () => ({ data: full, error: null }));
    const times = await createSupabaseReachData(fakeClient() as never, 'org1').listFormSubmissionTimes!('x');
    expect(times).toHaveLength(20_000);
    expect(queries()).toHaveLength(20);
  });

  it('is not offered by the sample provider, which has no submissions', () => {
    const seed = createSeedReachData();
    expect(seed.listFormSubmissions).toBeUndefined();
    expect(seed.listFormSubmissionTimes).toBeUndefined();
  });
});

describe('deleteFormSubmission', () => {
  const ctx = () => ({ client: fakeClient() as never, orgId: 'org1' });

  it('deletes by id inside the caller workspace', async () => {
    ctl.answers = [{ data: { id: ID }, error: null }];
    expect(await deleteFormSubmission(ctx(), { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(queries()).toEqual([
      { table: 'form_submissions', op: 'delete', columns: 'id', filters: { id: ID, org_id: 'org1' } },
    ]);
  });

  it('says it is gone when nothing matched (already deleted, or another workspace)', async () => {
    ctl.answers = [{ data: null, error: null }];
    expect(await deleteFormSubmission(ctx(), { id: ID })).toEqual({
      ok: false, error: 'That submission no longer exists.',
    });
  });

  it('hides a database error behind the usual message', async () => {
    ctl.answers = [{ data: null, error: { code: '42501', message: 'permission denied' } }];
    expect(await deleteFormSubmission(ctx(), { id: ID })).toEqual({
      ok: false, error: 'That change could not be saved. Please try again.',
    });
  });

  it('accepts only an id', () => {
    expect(deleteFormSubmissionInput.safeParse({ id: 'nope' }).error?.issues[0]?.message)
      .toBe('That submission no longer exists.');
    expect(deleteFormSubmissionInput.safeParse({}).success).toBe(false);
  });
});

describe('submission actions', () => {
  it('let any member read, a viewer included', async () => {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      ctl.viewer = { ...ctl.viewer, role };
      ctl.answers = [{ data: [stored(1)], error: null }];
      const result = await listFormSubmissionsAction({ formId: ID });
      expect(result, role).toMatchObject({ ok: true, data: [{ id: 's1', name: 'Person 1' }] });
    }
    // Always the viewer's own workspace, whatever was sent.
    expect(queries().every((q) => q.filters.org_id === 'org1' && q.filters.form_id === ID)).toBe(true);
  });

  it('give a demo guest an empty list without asking the database', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await listFormSubmissionsAction({ formId: ID })).toEqual({ ok: true, data: [] });
    expect(queries()).toHaveLength(0);
  });

  it('refuse a form id that is not one', async () => {
    expect(await listFormSubmissionsAction({ formId: 'form_1' })).toEqual({
      ok: false, error: 'That form no longer exists.',
    });
    expect(await listFormSubmissionsAction(null)).toMatchObject({ ok: false });
    expect(queries()).toHaveLength(0);
  });

  it('say the list could not be loaded when the read fails', async () => {
    ctl.answers = [{ data: null, error: { code: 'PGRST205', message: 'no table' } }];
    expect(await listFormSubmissionsAction({ formId: ID })).toEqual({
      ok: false, error: 'The submissions could not be loaded. Please try again.',
    });
  });

  it('forbid a demo guest and a viewer from deleting', async () => {
    for (const who of [{ isDemo: true }, { role: 'viewer' }]) {
      ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false, ...who };
      expect(await deleteFormSubmissionAction({ id: ID })).toEqual({
        ok: false, error: 'You do not have permission to make changes here.',
      });
    }
    expect(queries()).toHaveLength(0);
    expect(ctl.revalidated).toHaveLength(0);
  });

  it('delete for a member and refresh both Lead Forms routes', async () => {
    ctl.answers = [{ data: { id: ID }, error: null }];
    expect(await deleteFormSubmissionAction({ id: ID, org_id: 'someone-else' })).toEqual({
      ok: true, data: { id: ID },
    });
    expect(queries()[0]).toMatchObject({ op: 'delete', filters: { id: ID, org_id: 'org1' } });
    expect(ctl.revalidated).toEqual(['/reach/lead-forms', '/crm/lead-forms']);
  });

  it('answer a bad id with a message, and delete nothing', async () => {
    expect(await deleteFormSubmissionAction({ id: 'x' })).toEqual({
      ok: false, error: 'That submission no longer exists.',
    });
    expect(queries()).toHaveLength(0);
  });
});
