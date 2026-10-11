import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false } as {
    userId: string;
    orgId: string;
    role: string;
    isDemo: boolean;
  },
  ran: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
  privateReads: [] as string[],
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => ctl.revalidated.push(path) }));
vi.mock('@/lib/people/supabase', () => ({
  createSupabasePeopleData: () => ({
    getEmployeePrivate: async (id: string) => {
      ctl.privateReads.push(id);
      return { employee_id: id, nric: '900101-14-5678' };
    },
  }),
}));
vi.mock('@/lib/people/capabilities', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/capabilities')>();
  const record = (fn: string, data: unknown) => async (ctx: { orgId: string }, input: unknown) => {
    ctl.ran.push({ fn, orgId: ctx.orgId, input });
    return { ok: true as const, data };
  };
  return {
    ...actual,
    createEmployee: record('createEmployee', { id: 'e1', name: 'Farah', employee_no: 'EMP-001' }),
    updateEmployee: record('updateEmployee', { id: 'e1', name: 'Farah', employee_no: 'EMP-001' }),
    setEmployeeStatus: record('setEmployeeStatus', { id: 'e1', name: 'Farah', employee_no: 'EMP-001' }),
    deleteEmployee: record('deleteEmployee', { id: 'e1', name: 'Farah' }),
    linkEmployeeToMember: record('linkEmployeeToMember', { id: 'e1', name: 'Farah', user_id: null }),
    createDepartment: record('createDepartment', { id: 'd1', name: 'Sales', created_at: '' }),
    updateDepartment: record('updateDepartment', { id: 'd1', name: 'Sales', created_at: '' }),
    deleteDepartment: async () => ({ ok: false as const, error: 'That department still has employees, including inactive ones. Move them to another department first.' }),
  };
});

const actions = await import('@/app/(app)/people/actions');
const { PEOPLE_PATHS } = await import('@/lib/people/paths');

const EMP = '22222222-2222-4222-8222-222222222222';
const DEPT = '11111111-1111-4111-8111-111111111111';
const FORBIDDEN = { ok: false, error: 'Only owners and admins can change HR records.' };

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false };
  ctl.ran = [];
  ctl.revalidated = [];
  ctl.privateReads = [];
});

describe('PEOPLE_PATHS', () => {
  it('covers every Lekiu page that shows employee data', () => {
    expect(PEOPLE_PATHS).toHaveLength(25);
    for (const path of ['/people/employees', '/people/assistant', '/people/payroll', '/people/records', '/people/attendance']) {
      expect(PEOPLE_PATHS).toContain(path);
    }
    for (const path of ['/people/public-holidays', '/people/announcements', '/people/settings', '/people/calendar']) {
      expect(PEOPLE_PATHS).not.toContain(path);
    }
  });
});

describe('people actions', () => {
  it('lets an owner add an employee in their own workspace and refreshes the pages', async () => {
    const result = await actions.createEmployeeAction({ name: 'Farah Idris', org_id: 'someone-else' });
    expect(result.ok).toBe(true);
    expect(ctl.ran).toEqual([{ fn: 'createEmployee', orgId: 'org1', input: { name: 'Farah Idris' } }]);
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
  });

  it('lets an admin, too', async () => {
    ctl.viewer.role = 'admin';
    expect((await actions.createDepartmentAction({ name: 'Sales' })).ok).toBe(true);
  });

  it.each(['member', 'viewer'])('refuses a %s before anything runs', async (role) => {
    ctl.viewer.role = role;
    expect(await actions.createEmployeeAction({ name: 'Farah Idris' })).toEqual(FORBIDDEN);
    expect(await actions.deleteEmployeeAction({ id: EMP })).toEqual(FORBIDDEN);
    expect(await actions.loadEmployeePrivateAction({ id: EMP })).toEqual(FORBIDDEN);
    expect(ctl.ran).toEqual([]);
    expect(ctl.privateReads).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('refuses a demo visitor even with an owner role', async () => {
    ctl.viewer.isDemo = true;
    expect(await actions.createDepartmentAction({ name: 'Sales' })).toEqual(FORBIDDEN);
    expect(ctl.ran).toEqual([]);
  });

  it('answers a bad input with the message written for the person typing', async () => {
    expect(await actions.createEmployeeAction({ name: '  ' })).toEqual({ ok: false, error: 'Give the employee a name.' });
    expect(await actions.updateDepartmentAction({ id: 'not-an-id', name: 'X' })).toMatchObject({ ok: false });
    expect(ctl.ran).toEqual([]);
  });

  it('refreshes nothing when the change was refused', async () => {
    expect(await actions.deleteDepartmentAction({ id: DEPT })).toEqual({
      ok: false,
      error: 'That department still has employees, including inactive ones. Move them to another department first.',
    });
    expect(ctl.revalidated).toEqual([]);
  });

  it('routes each action to its own change', async () => {
    await actions.updateEmployeeAction({ id: EMP, designation: 'Lead' });
    await actions.setEmployeeStatusAction({ id: EMP, status: 'inactive' });
    await actions.deleteEmployeeAction({ id: EMP });
    await actions.linkEmployeeToMemberAction({ id: EMP, user_id: null });
    await actions.updateDepartmentAction({ id: DEPT, name: 'Field Sales' });
    expect(ctl.ran.map((r) => r.fn)).toEqual([
      'updateEmployee',
      'setEmployeeStatus',
      'deleteEmployee',
      'linkEmployeeToMember',
      'updateDepartment',
    ]);
  });

  it('hands an owner one employee\'s private details, and refreshes nothing for a read', async () => {
    expect(await actions.loadEmployeePrivateAction({ id: EMP })).toEqual({
      ok: true,
      data: { employee_id: EMP, nric: '900101-14-5678' },
    });
    expect(ctl.privateReads).toEqual([EMP]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('accepts a Postgres uuid that is not RFC-versioned', async () => {
    const odd = 'dea97d89-a5b6-f264-bd42-c6df73f664a7';
    expect(await actions.loadEmployeePrivateAction({ id: odd })).toMatchObject({ ok: true });
    expect(ctl.privateReads).toEqual([odd]);
  });
});
