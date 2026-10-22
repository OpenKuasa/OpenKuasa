import { beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false },
  people: { employeeId: 'emp-own' as string | null, isHr: true, isDemo: false } as { employeeId: string | null; isHr: boolean; isDemo: boolean; managesTeam?: boolean },
  client: { marker: 'the-signed-in-client' } as unknown,
  reply: null as null | { ok: false; error: string },
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
vi.mock('@/lib/people/roster-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/roster-writes')>();
  const record = (fn: string) => async (ctx: { orgId: string; client: unknown }, input: unknown): Promise<Reply> => {
    ctl.ran.push({ fn, orgId: ctx.orgId, client: ctx.client, input });
    return ctl.reply ?? { ok: true, data: { week: '2026-10-05', saved: 1, removed: 0 } };
  };
  return {
    ...actual,
    saveRoster: record('saveRoster'),
    saveHours: record('saveHours'),
    saveShiftType: record('saveShiftType'),
    archiveShiftType: record('archiveShiftType'),
  };
});

const actions = await import('@/app/(app)/people/attendance-actions');

const EMP = '22222222-2222-4222-8222-222222222222';
const DEMO = { ok: false, error: 'The sample company is read-only. Sign up to try attendance with your own team.' };
const FORBIDDEN = { ok: false, error: 'Only owners and admins can do that.' };
const NOT_LINKED = { ok: false, error: "Your account isn't linked to an employee record yet." };
const NOT_YOURS = { ok: false, error: 'You can only record your own hours.' };
const ROSTER = { week_start: '2026-10-05', cells: [{ employee_id: EMP, work_date: '2026-10-05', shift: 'off' }] };

const as = (role: 'owner' | 'admin' | 'member' | 'viewer', linked = true, extra: Partial<typeof ctl.people> = {}) => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
  ctl.people = { employeeId: linked ? 'emp-own' : null, isHr: role === 'owner' || role === 'admin', isDemo: false, ...extra };
};

beforeEach(() => {
  as('owner');
  ctl.reply = null;
  ctl.ran = [];
  ctl.revalidated = [];
  ctl.lookupFails = false;
});

describe('saveRosterAction', () => {
  it.each(['owner', 'admin'] as const)('lets an %s save the week with the session workspace', async (role) => {
    as(role);
    expect(((await actions.saveRosterAction(ROSTER)) as { ok: boolean }).ok).toBe(true);
    expect(ctl.ran).toEqual([{ fn: 'saveRoster', orgId: 'org1', client: ctl.client, input: ROSTER }]);
    expect(ctl.revalidated).toContain('/people/shift-calendar');
  });

  it('refuses a member and a manager before any call', async () => {
    as('member');
    expect(await actions.saveRosterAction(ROSTER)).toEqual(FORBIDDEN);
    as('member', true, { managesTeam: true });
    expect(await actions.saveRosterAction(ROSTER)).toEqual(FORBIDDEN);
    expect(ctl.ran).toEqual([]);
  });

  it('refuses the demo, even an admin there', async () => {
    ctl.viewer.isDemo = true;
    expect(await actions.saveRosterAction(ROSTER)).toEqual(DEMO);
    as('admin', true, { isDemo: true });
    expect(await actions.saveRosterAction(ROSTER)).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('passes the refusal through and refreshes nothing', async () => {
    ctl.reply = { ok: false, error: 'One of those employees is inactive, so their shifts cannot be changed.' };
    expect(await actions.saveRosterAction(ROSTER)).toEqual(ctl.reply);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('saveHoursAction', () => {
  const mine = { employee_id: 'emp-own', work_date: '2026-10-05', hours: 8, billable_hours: null };
  const theirs = { ...mine, employee_id: EMP };

  it('lets anyone linked save their own hours', async () => {
    for (const role of ['member', 'viewer'] as const) {
      as(role);
      expect(((await actions.saveHoursAction(mine)) as { ok: boolean }).ok).toBe(true);
    }
    expect(ctl.ran.map((r) => r.input)).toEqual([mine, mine]);
    expect(ctl.revalidated).toContain('/people/timesheet');
  });

  it("refuses a member, or a manager, someone else's hours before any call", async () => {
    as('member');
    expect(await actions.saveHoursAction(theirs)).toEqual(NOT_YOURS);
    as('member', true, { managesTeam: true });
    expect(await actions.saveHoursAction(theirs)).toEqual(NOT_YOURS);
    expect(await actions.saveHoursAction('nonsense')).toEqual(NOT_YOURS);
    expect(ctl.ran).toEqual([]);
  });

  it('refuses an unlinked member, but not an unlinked owner', async () => {
    as('member', false);
    expect(await actions.saveHoursAction(mine)).toEqual(NOT_LINKED);
    as('owner', false);
    expect(((await actions.saveHoursAction(theirs)) as { ok: boolean }).ok).toBe(true);
    expect(ctl.ran.map((r) => r.input)).toEqual([theirs]);
  });

  it('lets an owner or admin save anyone', async () => {
    as('admin');
    expect(((await actions.saveHoursAction(theirs)) as { ok: boolean }).ok).toBe(true);
  });

  it('refuses the demo before any call', async () => {
    ctl.viewer.isDemo = true;
    expect(await actions.saveHoursAction(mine)).toEqual(DEMO);
    as('member', true, { isDemo: true });
    expect(await actions.saveHoursAction(mine)).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('answers a failed lookup with the generic sentence and logs no message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.lookupFails = true;
    expect(await actions.saveHoursAction(mine)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    log.mockRestore();
  });
});

describe('shift type actions', () => {
  const TYPE = { name: 'Graveyard', is_off: false, start_time: '22:00', end_time: '06:00', color: 'slate' };
  it('let an owner or admin add and archive types in the session workspace', async () => {
    as('admin');
    expect(((await actions.saveShiftTypeAction(TYPE)) as { ok: boolean }).ok).toBe(true);
    expect(((await actions.archiveShiftTypeAction({ id: EMP, archived: true })) as { ok: boolean }).ok).toBe(true);
    expect(ctl.ran.map((r) => [r.fn, r.orgId])).toEqual([['saveShiftType', 'org1'], ['archiveShiftType', 'org1']]);
    expect(ctl.revalidated).toContain('/people/shift-calendar');
  });

  it('refuse a member, a manager and the demo before any call', async () => {
    as('member');
    expect(await actions.saveShiftTypeAction(TYPE)).toEqual(FORBIDDEN);
    as('member', true, { managesTeam: true });
    expect(await actions.archiveShiftTypeAction({ id: EMP, archived: true })).toEqual(FORBIDDEN);
    as('owner', true, { isDemo: true });
    expect(await actions.saveShiftTypeAction(TYPE)).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });
});
