import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from './setup/fake-supabase';

type Role = 'owner' | 'admin' | 'member' | 'viewer';

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false } as {
    userId: string;
    orgId: string;
    role: string;
    isDemo: boolean;
  },
  people: { employeeId: 'emp-own', isHr: true, isDemo: false } as {
    employeeId: string | null;
    isHr: boolean;
    isDemo: boolean;
    managesTeam?: boolean;
  },
  lookupFails: false,
  client: {} as unknown,
  result: { ok: true as boolean },
  ran: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ctl.client }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => ctl.revalidated.push(path) }));
vi.mock('@/lib/people/viewer', () => ({
  getPeopleViewer: async () => {
    if (ctl.lookupFails) throw new Error('lookup failed');
    return ctl.people;
  },
}));
vi.mock('@/lib/people/leave', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/leave')>();
  const record = (fn: string) => async (ctx: { orgId: string }, input: unknown) => {
    ctl.ran.push({ fn, orgId: ctx.orgId, input });
    return ctl.result.ok ? { ok: true as const, data: { id: 'r1', status: 'pending' } } : { ok: false as const, error: 'No.' };
  };
  return {
    ...actual,
    previewLeave: record('previewLeave'),
    applyLeave: record('applyLeave'),
    applyTimeOff: record('applyTimeOff'),
    cancelLeave: record('cancelLeave'),
    cancelTimeOff: record('cancelTimeOff'),
    decideLeave: record('decideLeave'),
    decideTimeOff: record('decideTimeOff'),
    setLeaveEntitlement: record('setLeaveEntitlement'),
  };
});

const actions = await import('@/app/(app)/people/leave-actions');
const { PEOPLE_PATHS } = await import('@/lib/people/paths');

const EMP = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const FORBIDDEN = { ok: false, error: 'Only owners and admins can do that.' };
const DEMO = { ok: false, error: 'The sample company is read-only. Sign up to try leave with your own team.' };
const NOT_LINKED = { ok: false, error: "Your account isn't linked to an employee record yet." };
const DATES = { leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' };

const OWN: [string, (input: unknown) => Promise<unknown>, unknown][] = [
  ['previewOwnLeaveAction', actions.previewOwnLeaveAction, DATES],
  ['applyOwnLeaveAction', actions.applyOwnLeaveAction, DATES],
  ['applyOwnTimeOffAction', actions.applyOwnTimeOffAction, { off_date: '2026-10-20', start_time: '09:00', end_time: '10:00' }],
];
const CANCEL: [string, (input: unknown) => Promise<unknown>, unknown][] = [
  ['cancelLeaveAction', actions.cancelLeaveAction, { id: REQ }],
  ['cancelTimeOffAction', actions.cancelTimeOffAction, { id: REQ }],
];
const ADMIN: [string, (input: unknown) => Promise<unknown>, unknown][] = [
  ['previewLeaveForAction', actions.previewLeaveForAction, { employee_id: EMP, ...DATES }],
  ['applyLeaveForAction', actions.applyLeaveForAction, { employee_id: EMP, ...DATES }],
  ['decideLeaveAction', actions.decideLeaveAction, { id: REQ, approve: true }],
  ['decideTimeOffAction', actions.decideTimeOffAction, { id: REQ, approve: false, note: 'Busy' }],
  ['setLeaveEntitlementAction', actions.setLeaveEntitlementAction, { employee_id: EMP, leave_type: 'annual', year: 2026, days: 18 }],
  ['loadLeaveEntitlementsAction', actions.loadLeaveEntitlementsAction, { employee_id: EMP }],
];

const DECIDE: [string, (input: unknown) => Promise<unknown>, unknown, string][] = [
  ['decideLeaveAction', actions.decideLeaveAction, { id: REQ, approve: true }, 'decideLeave'],
  ['decideTimeOffAction', actions.decideTimeOffAction, { id: REQ, approve: false, note: 'Busy' }, 'decideTimeOff'],
];
const DECIDE_FORBIDDEN = { ok: false, error: "Only owners, admins and the employee's manager can do that." };

const as = (role: Role, linked = true) => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
  ctl.people = { employeeId: linked ? 'emp-own' : null, isHr: role === 'owner' || role === 'admin', isDemo: false };
};

beforeEach(() => {
  as('owner');
  ctl.client = fakeSupabase().client;
  ctl.result = { ok: true };
  ctl.ran = [];
  ctl.revalidated = [];
});

describe("a member's own leave", () => {
  it.each(['owner', 'admin', 'member', 'viewer'] as Role[])('is open to a linked %s', async (role) => {
    as(role);
    for (const [name, action, input] of OWN) {
      expect((await action(input) as { ok: boolean }).ok, name).toBe(true);
    }
    expect(ctl.ran.map((r) => r.fn)).toEqual(['previewLeave', 'applyLeave', 'applyTimeOff']);
  });

  it('uses the linked employee from the server and the workspace from the session', async () => {
    as('member');
    await actions.applyOwnLeaveAction({ ...DATES, reason: 'family' });
    expect(ctl.ran).toEqual([
      { fn: 'applyLeave', orgId: 'org1', input: { ...DATES, reason: 'family', employee_id: 'emp-own' } },
    ]);
  });

  it('ignores an employee_id smuggled into the input, on every own action', async () => {
    as('member');
    for (const [, action, input] of OWN) await action({ ...(input as object), employee_id: EMP, org_id: 'someone-else' });
    expect(ctl.ran.map((r) => (r.input as { employee_id: string }).employee_id)).toEqual(['emp-own', 'emp-own', 'emp-own']);
    expect(ctl.ran.every((r) => r.orgId === 'org1')).toBe(true);
  });

  it('still takes the linked employee when the input is not an object', async () => {
    as('member');
    await actions.applyOwnLeaveAction('nonsense');
    expect(ctl.ran[0].input).toEqual({ employee_id: 'emp-own' });
  });

  it('refuses an account with no linked employee, before any call', async () => {
    as('admin', false);
    for (const [name, action, input] of OWN) expect(await action(input), name).toEqual(NOT_LINKED);
    expect(ctl.ran).toEqual([]);
  });

  it('refuses a demo visitor, before any call', async () => {
    ctl.viewer.isDemo = true;
    for (const [name, action, input] of OWN) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('refuses a real account whose current workspace is the demo', async () => {
    ctl.people = { employeeId: 'emp-own', isHr: false, isDemo: true };
    for (const [name, action, input] of OWN) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('refreshes the Lekiu pages after apply, and not after a preview', async () => {
    await actions.previewOwnLeaveAction(DATES);
    expect(ctl.revalidated).toEqual([]);
    await actions.applyOwnLeaveAction(DATES);
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
  });

  it('does not refresh anything when the change is refused', async () => {
    ctl.result = { ok: false };
    expect(await actions.applyOwnLeaveAction(DATES)).toEqual({ ok: false, error: 'No.' });
    expect(await actions.applyOwnTimeOffAction(DATES)).toEqual({ ok: false, error: 'No.' });
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('cancelling', () => {
  it.each(['owner', 'admin', 'member', 'viewer'] as Role[])('is open to a %s, and the database decides whose', async (role) => {
    as(role);
    for (const [name, action, input] of CANCEL) expect((await action(input) as { ok: boolean }).ok, name).toBe(true);
    expect(ctl.ran.map((r) => r.fn)).toEqual(['cancelLeave', 'cancelTimeOff']);
  });

  it('needs no linked record, so an admin without one can cancel anyone\'s', async () => {
    as('admin', false);
    expect((await actions.cancelLeaveAction({ id: REQ }) as { ok: boolean }).ok).toBe(true);
  });

  it('refuses a demo visitor', async () => {
    ctl.viewer.isDemo = true;
    for (const [name, action, input] of CANCEL) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('refuses a real account whose current workspace is the demo', async () => {
    ctl.people = { employeeId: null, isHr: true, isDemo: true };
    for (const [name, action, input] of CANCEL) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('refreshes only on success', async () => {
    await actions.cancelLeaveAction({ id: REQ });
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
    ctl.revalidated = [];
    ctl.result = { ok: false };
    await actions.cancelTimeOffAction({ id: REQ });
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('owner and admin actions', () => {
  it.each(['owner', 'admin'] as Role[])('are open to an %s, in their own workspace', async (role) => {
    as(role);
    for (const [name, action, input] of ADMIN.slice(0, 5)) expect((await action(input) as { ok: boolean }).ok, name).toBe(true);
    expect(ctl.ran.map((r) => r.fn)).toEqual(['previewLeave', 'applyLeave', 'decideLeave', 'decideTimeOff', 'setLeaveEntitlement']);
    expect(ctl.ran.every((r) => r.orgId === 'org1')).toBe(true);
    expect(ctl.ran[0].input).toEqual({ employee_id: EMP, ...DATES });
  });

  it.each(['member', 'viewer'] as Role[])('refuse a %s on every one before anything runs', async (role) => {
    as(role);
    for (const [name, action, input] of ADMIN) {
      // The two decide actions are open to a manager, so they refuse with their own sentence.
      expect(await action(input), name).toEqual(DECIDE.some(([n]) => n === name) ? DECIDE_FORBIDDEN : FORBIDDEN);
    }
    expect(ctl.ran).toEqual([]);
  });

  it('refuse a demo visitor on every one, even a demo "owner"', async () => {
    ctl.viewer.isDemo = true;
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(DEMO);
    ctl.viewer.role = 'viewer';
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('refuse a real account whose current workspace is the demo, before any call', async () => {
    ctl.people = { employeeId: 'emp-own', isHr: true, isDemo: true };
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('refresh the Lekiu pages after a change, not after a preview or when refused', async () => {
    await actions.previewLeaveForAction({ employee_id: EMP, ...DATES });
    expect(ctl.revalidated).toEqual([]);
    ctl.result = { ok: false };
    await actions.decideLeaveAction({ id: REQ, approve: true });
    expect(ctl.revalidated).toEqual([]);
    ctl.result = { ok: true };
    await actions.decideLeaveAction({ id: REQ, approve: true });
    await actions.setLeaveEntitlementAction(ADMIN[4][2]);
    expect(ctl.revalidated).toEqual([...PEOPLE_PATHS, ...PEOPLE_PATHS]);
  });
});

describe('the decide actions, open to a manager', () => {
  const asManager = () => {
    as('member');
    ctl.people = { employeeId: 'emp-own', isHr: false, isDemo: false, managesTeam: true };
  };

  it.each(DECIDE)('%s: a member who manages a team gets through, once, with the input', async (_name, action, input, fn) => {
    asManager();
    expect(((await action(input)) as { ok: boolean }).ok).toBe(true);
    expect(ctl.ran).toEqual([{ fn, orgId: 'org1', input }]);
  });

  it.each(DECIDE)('%s: a member with no team is refused before anything runs', async (_name, action, input) => {
    as('member');
    expect(await action(input)).toEqual(DECIDE_FORBIDDEN);
    expect(ctl.ran).toEqual([]);
  });

  it.each(DECIDE)('%s: an owner and an admin go through, as today', async (_name, action, input) => {
    for (const role of ['owner', 'admin'] as Role[]) {
      as(role);
      expect(((await action(input)) as { ok: boolean }).ok).toBe(true);
    }
    expect(ctl.ran).toHaveLength(2);
  });

  it.each(DECIDE)('%s: the demo account is refused before the viewer is looked up', async (_name, action, input) => {
    asManager();
    ctl.viewer.isDemo = true;
    expect(await action(input)).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it.each(DECIDE)('%s: a manager in a workspace that is the demo is refused', async (_name, action, input) => {
    asManager();
    ctl.people = { ...ctl.people, isDemo: true };
    expect(await action(input)).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it.each(DECIDE)('%s: a failed viewer lookup is a plain failure and runs nothing', async (_name, action, input) => {
    asManager();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.lookupFails = true;
    try {
      expect(await action(input)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    } finally {
      ctl.lookupFails = false;
      spy.mockRestore();
    }
    expect(ctl.ran).toEqual([]);
  });

  it.each(DECIDE)("%s: the database's own refusal reaches the manager unchanged", async (_name, action, input) => {
    asManager();
    ctl.result = { ok: false };
    expect(await action(input)).toEqual({ ok: false, error: 'No.' });
  });

  it('still keeps the HR-only actions HR-only for a manager', async () => {
    asManager();
    for (const [name, action, input] of ADMIN) {
      if (DECIDE.some(([n]) => n === name)) continue;
      expect(await action(input), name).toEqual(FORBIDDEN);
    }
    expect(ctl.ran).toEqual([]);
  });
});

describe('loadLeaveEntitlementsAction, who may read', () => {
  it.each(['member', 'viewer', 'demo'])('reads nothing for a %s', async (who) => {
    const { client, calls } = fakeSupabase({ 'hr_leave_balances.select': { data: [] } });
    ctl.client = client;
    if (who === 'demo') ctl.viewer.isDemo = true;
    else as(who as Role);
    const result = (await actions.loadLeaveEntitlementsAction({ employee_id: EMP })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('loadLeaveEntitlementsAction', () => {
  it("reads this year's balances for the employee in the session's workspace, as numbers", async () => {
    const { client, calls } = fakeSupabase({
      'hr_leave_balances.select': {
        data: [{ leave_type: 'annual', year: 2026, entitled_days: '16.0', used_days: '2.5' }],
      },
    });
    ctl.client = client;
    expect(await actions.loadLeaveEntitlementsAction({ employee_id: EMP })).toEqual({
      ok: true,
      data: [{ leave_type: 'annual', year: 2026, entitled_days: 16, used_days: 2.5 }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: 'hr_leave_balances', op: 'select', filters: { org_id: 'org1', employee_id: EMP } });
    expect(typeof calls[0].filters.year).toBe('number');
    expect(ctl.revalidated).toEqual([]);
  });

  it('refuses an id that is not a uuid, without reading', async () => {
    const { client, calls } = fakeSupabase();
    ctl.client = client;
    expect(await actions.loadLeaveEntitlementsAction({ employee_id: 'nope' })).toEqual({ ok: false, error: 'That input was not valid.' });
    expect(calls).toEqual([]);
  });

  it('answers in words, logging the database message only, when the read fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.client = fakeSupabase({ 'hr_leave_balances.select': { error: { code: '42501', message: 'permission denied' } } }).client;
    expect(await actions.loadLeaveEntitlementsAction({ employee_id: EMP })).toEqual({
      ok: false,
      error: 'Could not load the entitlements. Please try again.',
    });
    expect(log.mock.calls).toEqual([['[people/leave-actions] could not read the entitlements:', '42501', 'permission denied']]);
    log.mockRestore();
  });
});
