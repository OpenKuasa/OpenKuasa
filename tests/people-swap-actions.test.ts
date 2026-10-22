import { beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false },
  people: { employeeId: 'emp-own' as string | null, isHr: false, isDemo: false } as { employeeId: string | null; isHr: boolean; isDemo: boolean; managesTeam?: boolean },
  client: { marker: 'the-signed-in-client' } as unknown,
  ran: [] as { fn: string; orgId: string; client: unknown; input: unknown }[],
  revalidated: [] as string[],
  lookupFails: false,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ctl.client }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => ctl.revalidated.push(path) }));
vi.mock('@/lib/people/viewer', () => ({
  getPeopleViewer: async () => {
    if (ctl.lookupFails) throw new Error('SECRET lookup failure');
    return ctl.people;
  },
}));
vi.mock('@/lib/people/swap-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/swap-writes')>();
  const record = (fn: string) => async (ctx: { orgId: string; client: unknown }, input: unknown): Promise<Reply> => {
    ctl.ran.push({ fn, orgId: ctx.orgId, client: ctx.client, input });
    return { ok: true, data: { id: 's1', status: 'requested' } };
  };
  return {
    ...actual,
    requestShiftSwap: record('requestShiftSwap'),
    replyShiftSwap: record('replyShiftSwap'),
    decideShiftSwap: record('decideShiftSwap'),
    cancelShiftSwap: record('cancelShiftSwap'),
  };
});

const actions = await import('@/app/(app)/people/swap-actions');

const DEMO = { ok: false, error: 'The sample company is read-only. Sign up to try shift swaps with your own team.' };
const NOT_LINKED = { ok: false, error: "Your account isn't linked to an employee record yet." };
const DECIDE_FORBIDDEN = { ok: false, error: 'Only owners, admins and a manager of both people can decide a shift swap.' };
const INPUT = { id: 's1' };

const as = (role: 'owner' | 'admin' | 'member', linked = true, extra: Partial<typeof ctl.people> = {}) => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
  ctl.people = { employeeId: linked ? 'emp-own' : null, isHr: role !== 'member', isDemo: false, ...extra };
};

beforeEach(() => {
  as('member');
  ctl.ran = [];
  ctl.revalidated = [];
  ctl.lookupFails = false;
});

describe('the steps of the two people', () => {
  it.each([
    ['requestShiftSwapAction', 'requestShiftSwap'],
    ['replyShiftSwapAction', 'replyShiftSwap'],
    ['cancelShiftSwapAction', 'cancelShiftSwap'],
  ] as const)('%s runs for a linked member with the session workspace and refreshes the roster', async (action, fn) => {
    expect((await actions[action](INPUT)).ok).toBe(true);
    expect(ctl.ran).toEqual([{ fn, orgId: 'org1', client: ctl.client, input: INPUT }]);
    expect(ctl.revalidated).toContain('/people/shift-calendar');
    expect(ctl.revalidated).toContain('/people/approve-shift-swaps');
  });

  it('refuses an account with no linked record before any call', async () => {
    as('member', false);
    expect(await actions.requestShiftSwapAction(INPUT)).toEqual(NOT_LINKED);
    as('admin', false);
    expect(await actions.cancelShiftSwapAction(INPUT)).toEqual(NOT_LINKED);
    expect(ctl.ran).toEqual([]);
  });

  it('refuses the demo, by session or by workspace', async () => {
    ctl.viewer.isDemo = true;
    expect(await actions.requestShiftSwapAction(INPUT)).toEqual(DEMO);
    as('member', true, { isDemo: true });
    expect(await actions.replyShiftSwapAction(INPUT)).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('says only that it failed when the viewer lookup throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.lookupFails = true;
    const result = await actions.requestShiftSwapAction(INPUT);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(log.mock.calls.flat().join(' ')).not.toContain('SECRET');
    log.mockRestore();
  });
});

describe('decideShiftSwapAction', () => {
  it.each([
    ['owner', {}],
    ['admin', {}],
    ['member', { managesTeam: true }],
  ] as const)('lets a %s %j through to the database', async (role, extra) => {
    as(role, true, extra);
    expect((await actions.decideShiftSwapAction({ id: 's1', approve: true })).ok).toBe(true);
    expect(ctl.ran.map((r) => r.fn)).toEqual(['decideShiftSwap']);
  });

  it('refuses a member with no team before any call', async () => {
    expect(await actions.decideShiftSwapAction({ id: 's1', approve: true })).toEqual(DECIDE_FORBIDDEN);
    expect(ctl.ran).toEqual([]);
  });

  it('refuses the demo', async () => {
    as('admin', true, { isDemo: true });
    expect(await actions.decideShiftSwapAction({ id: 's1', approve: true })).toEqual(DEMO);
  });
});
