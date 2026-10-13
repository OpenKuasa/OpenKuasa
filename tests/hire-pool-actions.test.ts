import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three actions behind the talent pool's controls. The viewer, the database
 * client, the capabilities and the read layer are replaced: nothing here reaches
 * a database.
 */

const ctl = vi.hoisted(() => ({
  viewer: { orgId: 'org1', role: 'member', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  revalidated: [] as string[],
  calls: [] as { fn: string; ctx: { orgId: string; client: unknown }; input: unknown }[],
  result: null as unknown,
  reads: [] as { client: unknown; orgId: string }[],
  candidates: [] as unknown[],
  readThrows: null as unknown,
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { ctl.revalidated.push(path); } }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ marker: 'session' }) }));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => { throw new Error('the service role is never used for the talent pool'); } }));
vi.mock('@/lib/hire/supabase', () => ({
  createSupabaseHireData: (client: unknown, orgId: string) => {
    ctl.reads.push({ client, orgId });
    return {
      listCandidates: async () => {
        if (ctl.readThrows) throw ctl.readThrows;
        return ctl.candidates;
      },
    };
  },
}));
vi.mock('@/lib/hire/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hire/capabilities')>();
  const record = (fn: string) => async (ctx: { orgId: string; client: unknown }, input: unknown) => {
    ctl.calls.push({ fn, ctx, input });
    return ctl.result;
  };
  return { ...actual, setPoolStatus: record('setPoolStatus'), moveToPipeline: record('moveToPipeline') };
});

const { listPoolPickerAction, moveToPipelineAction, setPoolStatusAction } = await import('@/app/(app)/hire/actions');

const ID = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const EVERY_PATH = [
  '/hire/jobs', '/hire/careers-page', '/hire/assistant', '/hire/dashboard', '/hire/applications', '/hire/candidates',
  '/hire/interviews', '/hire/talent-pool',
];
const CHANGED = { ok: true, data: { id: ID, name: 'Aina Rahman', from: 'none', to: 'available', message: 'Added Aina Rahman to the talent pool as Available.' } };
const person = (id: string, pool_status: string, over: Record<string, unknown> = {}) => ({
  id, name: `Person ${id}`, email: `${id}@example.com`, phone: '+60 12-345 6789', headline: 'Driver', location: 'Klang',
  skills: ['GDL'], source: 'Referral', pool_status, created_at: '2026-10-01T00:00:00Z', ...over,
});

beforeEach(() => {
  ctl.viewer = { orgId: 'org1', role: 'member', isDemo: false };
  ctl.revalidated = [];
  ctl.calls = [];
  ctl.result = CHANGED;
  ctl.reads = [];
  ctl.candidates = [];
  ctl.readThrows = null;
});

const CHANGES = [
  ['setPoolStatus', setPoolStatusAction, { id: ID, status: 'available', only_if_outside: true }],
  ['moveToPipeline', moveToPipelineAction, { id: ID, job_id: JOB }],
] as const;

describe('who may change the talent pool', () => {
  it.each(CHANGES)('%s: a viewer and the demo workspace are refused before the capability is reached', async (_name, action, input) => {
    for (const viewer of [
      { orgId: 'org1', role: 'viewer', isDemo: false },
      { orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      expect(await action(input)).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
  it.each(['owner', 'admin', 'member'])('a %s reaches the capability with the session\'s own workspace', async (role) => {
    ctl.viewer = { orgId: 'org1', role, isDemo: false };
    await setPoolStatusAction({ id: ID, status: 'passive', org_id: 'evil' });
    expect(ctl.calls).toHaveLength(1);
    expect(ctl.calls[0].ctx.orgId).toBe('org1');
    expect(ctl.calls[0].ctx.client).toEqual({ marker: 'session' });
  });
});

describe('the two change actions', () => {
  it.each(CHANGES)('%s: hands the input on, returns the result and revalidates every hiring screen, the Talent Pool among them', async (name, action, input) => {
    expect(await action(input)).toBe(CHANGED);
    expect(ctl.calls.map((c) => c.fn)).toEqual([name]);
    expect(ctl.calls[0].input).toBe(input);
    expect(ctl.revalidated).toEqual(EVERY_PATH);
    expect(ctl.revalidated).toContain('/hire/talent-pool');
  });
  it.each(CHANGES)('%s: a refusal revalidates nothing', async (_name, action, input) => {
    ctl.result = { ok: false, error: 'Aina Rahman is already in the talent pool as Passive. Nothing was changed.' };
    expect(await action(input)).toBe(ctl.result);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('listPoolPickerAction', () => {
  it('refuses a viewer and the demo workspace before anything is read', async () => {
    for (const viewer of [
      { orgId: 'org1', role: 'viewer', isDemo: false },
      { orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      expect(await listPoolPickerAction()).toEqual(FORBIDDEN);
    }
    expect(ctl.reads).toEqual([]);
  });
  it('lists the people outside the pool, read with the member\'s own client inside their workspace, with no email or phone', async () => {
    ctl.candidates = [person('c1', 'none'), person('c2', 'passive'), person('c3', 'none', { headline: null, location: null, skills: [], source: null })];
    const result = await listPoolPickerAction();
    expect(result).toEqual({
      ok: true,
      data: {
        people: [
          { id: 'c1', name: 'Person c1', headline: 'Driver', location: 'Klang', skills: ['GDL'], source: 'Referral' },
          { id: 'c3', name: 'Person c3', headline: null, location: null, skills: [], source: null },
        ],
        capped: false,
      },
    });
    expect(ctl.reads).toEqual([{ client: { marker: 'session' }, orgId: 'org1' }]);
    expect(JSON.stringify(result)).not.toMatch(/@example\.com|345 6789|email|phone|pool_status/);
    expect(ctl.revalidated).toEqual([]);
  });
  it('says when the read came back with its full 1,000 rows', async () => {
    ctl.candidates = Array.from({ length: 1000 }, (_, i) => person(`c${i}`, 'none'));
    expect(await listPoolPickerAction()).toMatchObject({ ok: true, data: { capped: true } });
    ctl.candidates = ctl.candidates.slice(1);
    expect(await listPoolPickerAction()).toMatchObject({ ok: true, data: { capped: false } });
  });
  it('answers with the sentence and logs only a code when the read fails', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.readThrows = Object.assign(new Error('Person c1 could not be read'), { code: '57014' });
    expect(await listPoolPickerAction()).toEqual({ ok: false, error: 'The list could not be loaded. Check your connection and try again.' });
    expect(JSON.stringify(said.mock.calls)).not.toContain('Person c1');
    said.mockRestore();
  });
});
