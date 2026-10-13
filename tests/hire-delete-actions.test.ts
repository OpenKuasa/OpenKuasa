import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three actions behind the delete dialog. The viewer, the database client
 * and the capabilities are replaced: nothing here reaches a database.
 */

const ctl = vi.hoisted(() => ({
  viewer: { orgId: 'org1', role: 'member', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  revalidated: [] as string[],
  calls: [] as { fn: string; ctx: { orgId: string; client: unknown }; input: unknown }[],
  result: null as unknown,
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { ctl.revalidated.push(path); } }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ marker: 'session' }) }));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => { throw new Error('the service role is never used to delete'); } }));
vi.mock('@/lib/hire/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hire/capabilities')>();
  const record = (fn: string) => async (ctx: { orgId: string; client: unknown }, input: unknown) => {
    ctl.calls.push({ fn, ctx, input });
    return ctl.result;
  };
  return {
    ...actual,
    deleteApplication: record('deleteApplication'),
    deleteCandidate: record('deleteCandidate'),
    deletionSummary: record('deletionSummary'),
  };
});

const { deleteApplicationAction, deleteCandidateAction, getDeletionSummaryAction } = await import('@/app/(app)/hire/actions');

const ID = '44444444-4444-4444-8444-444444444444';
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const EVERY_PATH = [
  '/hire/jobs', '/hire/careers-page', '/hire/assistant', '/hire/dashboard', '/hire/applications', '/hire/candidates',
  '/hire/interviews', '/hire/talent-pool',
];
const DELETED = { ok: true, data: { id: ID, name: 'Aina Rahman', job: null, applications: 2, interviews: 0, cv_files: 1, message: 'Deleted Aina Rahman, with 2 applications and 1 CV file.' } };

beforeEach(() => {
  ctl.viewer = { orgId: 'org1', role: 'member', isDemo: false };
  ctl.revalidated = [];
  ctl.calls = [];
  ctl.result = DELETED;
});

const ACTIONS = [
  ['deleteApplication', deleteApplicationAction],
  ['deleteCandidate', deleteCandidateAction],
  ['deletionSummary', getDeletionSummaryAction],
] as const;

describe('who may use the delete actions', () => {
  it.each(ACTIONS)('%s: a viewer and the demo workspace are refused before the capability is reached', async (_name, action) => {
    for (const viewer of [
      { orgId: 'org1', role: 'viewer', isDemo: false },
      { orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      expect(await action({ id: ID, kind: 'candidate' })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
  it.each(['owner', 'admin', 'member'])('a %s reaches the capability with the session\'s own workspace', async (role) => {
    ctl.viewer = { orgId: 'org1', role, isDemo: false };
    await deleteCandidateAction({ id: ID, org_id: 'evil' });
    expect(ctl.calls).toHaveLength(1);
    expect(ctl.calls[0].ctx.orgId).toBe('org1');
    expect(ctl.calls[0].ctx.client).toEqual({ marker: 'session' });
  });
});

describe('the two delete actions', () => {
  it.each(ACTIONS.slice(0, 2))('%s: hands the input on, returns the result and revalidates every hiring screen', async (name, action) => {
    const input = { id: ID };
    expect(await action(input)).toBe(DELETED);
    expect(ctl.calls.map((c) => c.fn)).toEqual([name]);
    expect(ctl.calls[0].input).toBe(input);
    expect(ctl.revalidated).toEqual(EVERY_PATH);
  });
  it.each(ACTIONS.slice(0, 2))('%s: a refusal revalidates nothing', async (_name, action) => {
    ctl.result = { ok: false, error: 'That candidate could not be found. They may already have been deleted.' };
    expect(await action({ id: ID })).toBe(ctl.result);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('getDeletionSummaryAction', () => {
  it('returns what the capability read, and revalidates nothing', async () => {
    ctl.result = { ok: true, data: { name: 'Aina Rahman', job: null, applications: 2, interviews: 1, cvFiles: 1 } };
    const input = { kind: 'candidate', id: ID };
    expect(await getDeletionSummaryAction(input)).toBe(ctl.result);
    expect(ctl.calls).toEqual([{ fn: 'deletionSummary', ctx: { client: { marker: 'session' }, orgId: 'org1' }, input }]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('hands a malformed input to the capability, which refuses it', async () => {
    ctl.result = { ok: false, error: 'Couldn\'t check what this removes. Close this and try again.' };
    expect(await getDeletionSummaryAction('nonsense')).toBe(ctl.result);
    expect(ctl.calls[0].input).toBe('nonsense');
  });
});
