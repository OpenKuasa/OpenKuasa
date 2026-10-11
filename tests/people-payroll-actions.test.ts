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
  people: { employeeId: null as string | null, isHr: true, isDemo: false },
  client: { marker: 'the-signed-in-client' } as unknown,
  reply: null as null | { ok: false; error: string },
  ran: [] as { fn: string; orgId: string; client: unknown; input: unknown }[],
  revalidated: [] as string[],
  lookupFails: false,
  lookups: 0,
  clients: 0,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => {
    ctl.clients += 1;
    return ctl.client;
  } }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => ctl.revalidated.push(path) }));
vi.mock('@/lib/people/viewer', () => ({
  getPeopleViewer: async () => {
    ctl.lookups += 1;
    if (ctl.lookupFails) throw new Error('SECRET lookup failure');
    return ctl.people;
  },
}));
vi.mock('@/lib/people/payroll-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/payroll-writes')>();
  const record = (fn: string) => async (ctx: { orgId: string; client: unknown }, input: unknown): Promise<Reply> => {
    ctl.ran.push({ fn, orgId: ctx.orgId, client: ctx.client, input });
    return ctl.reply ?? { ok: true, data: { id: 'x' } };
  };
  return {
    ...actual,
    runPayroll: record('runPayroll'),
    recalculatePayroll: record('recalculatePayroll'),
    savePayslipLine: record('savePayslipLine'),
    deletePayslipLine: record('deletePayslipLine'),
    setPayslipStatutory: record('setPayslipStatutory'),
    removePayslip: record('removePayslip'),
    deletePayrollRun: record('deletePayrollRun'),
    markPayrollPaid: record('markPayrollPaid'),
    unmarkPayrollPaid: record('unmarkPayrollPaid'),
  };
});

const actions = await import('@/app/(app)/people/payroll-actions');
const { PEOPLE_PATHS } = await import('@/lib/people/paths');

const RUN = '11111111-1111-4111-8111-111111111111';
const SLIP = '22222222-2222-4222-8222-222222222222';
const LINE = '33333333-3333-4333-8333-333333333333';
const FORBIDDEN = { ok: false, error: 'Only owners and admins can do that.' };
const DEMO = { ok: false, error: 'The sample company is read-only. Sign up to try payroll with your own team.' };
const GENERIC = { ok: false, error: 'That change could not be saved. Please try again.' };

type Action = (input?: unknown) => Promise<unknown>;
const ALL: [string, string, Action, unknown][] = [
  ['runPayrollAction', 'runPayroll', actions.runPayrollAction, { month: '2026-10' }],
  ['recalculatePayrollAction', 'recalculatePayroll', actions.recalculatePayrollAction, { run_id: RUN }],
  [
    'savePayslipLineAction',
    'savePayslipLine',
    actions.savePayslipLineAction,
    { payslip_id: SLIP, kind: 'earning', label: 'Bonus', amount_cents: 100 },
  ],
  ['deletePayslipLineAction', 'deletePayslipLine', actions.deletePayslipLineAction, { line_id: LINE }],
  [
    'setPayslipStatutoryAction',
    'setPayslipStatutory',
    actions.setPayslipStatutoryAction,
    { payslip_id: SLIP, field: 'epf', amount_cents: null },
  ],
  ['removePayslipAction', 'removePayslip', actions.removePayslipAction, { payslip_id: SLIP }],
  ['deletePayrollRunAction', 'deletePayrollRun', actions.deletePayrollRunAction, { run_id: RUN }],
  ['markPayrollPaidAction', 'markPayrollPaid', actions.markPayrollPaidAction, { run_id: RUN }],
  ['unmarkPayrollPaidAction', 'unmarkPayrollPaid', actions.unmarkPayrollPaidAction, { run_id: RUN }],
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
  ctl.lookups = 0;
  ctl.clients = 0;
});

describe('the payroll actions', () => {
  it('are nine functions', () => {
    expect(ALL).toHaveLength(9);
    for (const [name, , action] of ALL) expect(typeof action, name).toBe('function');
  });

  it.each(['owner', 'admin'] as Role[])('are open to an %s and reach the write path', async (role) => {
    as(role);
    for (const [name, , action, input] of ALL) expect(((await action(input)) as { ok: boolean }).ok, name).toBe(true);
    expect(ctl.ran.map((r) => r.fn)).toEqual(ALL.map(([, fn]) => fn));
  });

  it("use the context's workspace and the signed-in client, never ones from the input", async () => {
    for (const [, , action, input] of ALL) {
      await action({ ...(input as object), org_id: 'someone-else', orgId: 'someone-else' });
    }
    expect(ctl.ran).toHaveLength(9);
    for (const r of ctl.ran) {
      expect(r.orgId).toBe('org1');
      expect(r.client).toBe(ctl.client);
    }
  });

  it('pass the input through untouched to the write path, which validates it', async () => {
    const input = { month: '2026-10' };
    await actions.runPayrollAction(input);
    expect(ctl.ran[0].input).toBe(input);
  });

  it.each(['member', 'viewer'] as Role[])('refuse a %s on every action, linked or not, before any call', async (role) => {
    for (const linked of [true, false]) {
      as(role, linked);
      for (const [name, , action, input] of ALL) expect(await action(input), name).toEqual(FORBIDDEN);
    }
    expect(ctl.ran).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
    // Not even the viewer lookup: the role alone settles it.
    expect(ctl.lookups).toBe(0);
    expect(ctl.clients).toBe(0);
  });

  it('refuse the demo first, whatever the role, before any call', async () => {
    ctl.viewer.isDemo = true;
    for (const [name, , action, input] of ALL) expect(await action(input), name).toEqual(DEMO);
    as('member');
    ctl.viewer.isDemo = true;
    for (const [name, , action, input] of ALL) expect(await action(input), name).toEqual(DEMO);
    ctl.viewer.isDemo = false;
    as('owner');
    ctl.people = { employeeId: null, isHr: true, isDemo: true };
    for (const [name, , action, input] of ALL) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('refresh the Lekiu pages, Payroll, My Payslips and OT Claims only on success', async () => {
    for (const [, , action, input] of ALL) await action(input);
    for (const path of [...PEOPLE_PATHS, '/people/payroll', '/people/my-payslips', '/people/ot-claims']) {
      expect(ctl.revalidated).toContain(path);
    }
    ctl.revalidated = [];
    ctl.reply = { ok: false, error: 'No.' };
    for (const [name, , action, input] of ALL) expect(await action(input), name).toEqual({ ok: false, error: 'No.' });
    expect(ctl.revalidated).toEqual([]);
  });

  it('give the generic sentence, and log only the error name, when the viewer cannot be looked up', async () => {
    ctl.lookupFails = true;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [name, , action, input] of ALL) expect(await action(input), name).toEqual(GENERIC);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('SECRET');
    logged.mockRestore();
    expect(ctl.ran).toEqual([]);
  });
});
