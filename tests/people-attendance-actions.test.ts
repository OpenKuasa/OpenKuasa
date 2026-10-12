import { beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
type Reply = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false } as {
    userId: string;
    orgId: string;
    role: string;
    isDemo: boolean;
  },
  people: { employeeId: 'emp-own' as string | null, isHr: true, isDemo: false },
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
vi.mock('@/lib/people/attendance-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/attendance-writes')>();
  const record = (fn: string) => async (ctx: { orgId: string; client: unknown }, input: unknown): Promise<Reply> => {
    ctl.ran.push({ fn, orgId: ctx.orgId, client: ctx.client, input });
    return ctl.reply ?? { ok: true, data: { id: 'x' } };
  };
  return {
    ...actual,
    clockIn: record('clockIn'),
    clockOut: record('clockOut'),
    correctAttendance: record('correctAttendance'),
    saveHoliday: record('saveHoliday'),
    deleteHoliday: record('deleteHoliday'),
    saveAttendanceSettings: record('saveAttendanceSettings'),
  };
});

const actions = await import('@/app/(app)/people/attendance-actions');
const { PEOPLE_PATHS } = await import('@/lib/people/paths');

const EMP = '22222222-2222-4222-8222-222222222222';
const HOLIDAY = '33333333-3333-4333-8333-333333333333';
const FORBIDDEN = { ok: false, error: 'Only owners and admins can do that.' };
const DEMO = { ok: false, error: 'The sample company is read-only. Sign up to try attendance with your own team.' };
const NOT_LINKED = { ok: false, error: "Your account isn't linked to an employee record yet." };
const GENERIC = { ok: false, error: 'That change could not be saved. Please try again.' };

type Action = (input?: unknown) => Promise<unknown>;
const CLOCK: [string, Action][] = [
  ['clockInAction', actions.clockInAction as Action],
  ['clockOutAction', actions.clockOutAction as Action],
];
const ADMIN: [string, Action, unknown][] = [
  ['correctAttendanceAction', actions.correctAttendanceAction, { employee_id: EMP, work_date: '2026-10-09', status: 'absent' }],
  ['saveHolidayAction', actions.saveHolidayAction, { name: 'Deepavali', holiday_date: '2026-11-08' }],
  ['deleteHolidayAction', actions.deleteHolidayAction, { id: HOLIDAY }],
  [
    'saveAttendanceSettingsAction',
    actions.saveAttendanceSettingsAction,
    { work_week: ['mon'], work_start_time: '09:00', late_grace_minutes: 15 },
  ],
];

const as = (role: Role, linked = true) => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
  ctl.people = { employeeId: linked ? 'emp-own' : null, isHr: role === 'owner' || role === 'admin', isDemo: false };
};

beforeEach(() => {
  as('owner');
  ctl.reply = null;
  ctl.ran = [];
  ctl.revalidated = [];
  ctl.lookupFails = false;
});

describe('a manager is not HR', () => {
  it('is still refused a correction to attendance', async () => {
    as('member');
    ctl.people = { employeeId: 'emp-own', isHr: false, isDemo: false, managesTeam: true } as typeof ctl.people;
    expect(await actions.correctAttendanceAction({ employee_id: EMP, work_date: '2026-10-09', status: 'absent' })).toEqual(FORBIDDEN);
    expect(ctl.ran).toEqual([]);
  });
});

describe('clocking in and out', () => {
  it.each(['owner', 'admin', 'member', 'viewer'] as Role[])('is open to a linked %s', async (role) => {
    as(role);
    for (const [name, action] of CLOCK) expect(((await action()) as { ok: boolean }).ok, name).toBe(true);
    expect(ctl.ran.map((r) => r.fn)).toEqual(['clockIn', 'clockOut']);
  });

  it("uses the viewer's own employee and workspace, and the signed-in client", async () => {
    as('member');
    await actions.clockInAction();
    await actions.clockOutAction();
    expect(ctl.ran).toEqual([
      { fn: 'clockIn', orgId: 'org1', client: ctl.client, input: { employee_id: 'emp-own' } },
      { fn: 'clockOut', orgId: 'org1', client: ctl.client, input: { employee_id: 'emp-own' } },
    ]);
  });

  it('ignores any input: no employee, no time, no date', async () => {
    as('member');
    for (const [, action] of CLOCK) {
      await action({ employee_id: EMP, org_id: 'someone-else', clock_in: '08:00', work_date: '2026-10-01' });
      await action('nonsense');
    }
    expect(ctl.ran).toHaveLength(4);
    for (const r of ctl.ran) {
      expect(r.input).toEqual({ employee_id: 'emp-own' });
      expect(r.orgId).toBe('org1');
    }
  });

  it('refuses an account with no linked employee, even an owner, before any call', async () => {
    as('owner', false);
    for (const [name, action] of CLOCK) expect(await action(), name).toEqual(NOT_LINKED);
    as('member', false);
    for (const [name, action] of CLOCK) expect(await action(), name).toEqual(NOT_LINKED);
    expect(ctl.ran).toEqual([]);
  });

  it('refuses a demo visitor, and a real account whose workspace is the demo, before any call', async () => {
    ctl.viewer.isDemo = true;
    for (const [name, action] of CLOCK) expect(await action(), name).toEqual(DEMO);
    ctl.viewer.isDemo = false;
    ctl.people = { employeeId: 'emp-own', isHr: false, isDemo: true };
    for (const [name, action] of CLOCK) expect(await action(), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('refreshes the Lekiu pages after a success and nothing after a refusal', async () => {
    await actions.clockInAction();
    expect(ctl.revalidated).toEqual(expect.arrayContaining(PEOPLE_PATHS));
    ctl.revalidated = [];
    ctl.reply = { ok: false, error: 'You have already clocked in today.' };
    expect(await actions.clockInAction()).toEqual({ ok: false, error: 'You have already clocked in today.' });
    expect(await actions.clockOutAction()).toEqual({ ok: false, error: 'You have already clocked in today.' });
    expect(ctl.revalidated).toEqual([]);
  });

  it('gives the generic sentence, and logs only the error name, when the viewer cannot be looked up', async () => {
    ctl.lookupFails = true;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await actions.clockInAction()).toEqual(GENERIC);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('SECRET');
    logged.mockRestore();
    expect(ctl.ran).toEqual([]);
  });
});

describe('the owner-only actions', () => {
  it.each(['owner', 'admin'] as Role[])('are open to an %s', async (role) => {
    as(role);
    for (const [name, action, input] of ADMIN) expect(((await action(input)) as { ok: boolean }).ok, name).toBe(true);
    expect(ctl.ran.map((r) => r.fn)).toEqual([
      'correctAttendance',
      'saveHoliday',
      'deleteHoliday',
      'saveAttendanceSettings',
    ]);
    expect(ctl.ran.every((r) => r.orgId === 'org1' && r.client === ctl.client)).toBe(true);
  });

  it.each(['member', 'viewer'] as Role[])('refuse a %s on every action, linked or not, before any call', async (role) => {
    for (const linked of [true, false]) {
      as(role, linked);
      for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(FORBIDDEN);
    }
    expect(ctl.ran).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('refuse the demo first, whatever the role, before any call', async () => {
    ctl.viewer.isDemo = true;
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(DEMO);
    as('member');
    ctl.viewer.isDemo = true;
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(DEMO);
    ctl.viewer.isDemo = false;
    as('owner');
    ctl.people = { employeeId: null, isHr: true, isDemo: true };
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('pass the input through untouched to the write path, which validates it', async () => {
    const input = { name: 'Deepavali', holiday_date: '2026-11-08' };
    await actions.saveHolidayAction(input);
    expect(ctl.ran[0].input).toBe(input);
  });

  it('refresh the Lekiu pages, and the holiday, calendar and settings pages too, only on success', async () => {
    for (const [, action, input] of ADMIN) await action(input);
    for (const path of [...PEOPLE_PATHS, '/people/public-holidays', '/people/calendar', '/people/settings']) {
      expect(ctl.revalidated).toContain(path);
    }
    ctl.revalidated = [];
    ctl.reply = { ok: false, error: 'No.' };
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual({ ok: false, error: 'No.' });
    expect(ctl.revalidated).toEqual([]);
  });
});
