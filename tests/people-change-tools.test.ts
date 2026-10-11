import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  ran: [] as { fn: string; orgId: string; input: unknown }[],
  fail: null as string | null,
  members: [{ userId: '33333333-3333-4333-8333-333333333333', name: 'Farah', email: 'Farah@Example.com' }],
}));

vi.mock('@/lib/people/members', () => ({ listWorkspaceMembers: async () => ctl.members }));
vi.mock('@/lib/people/capabilities', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/capabilities')>();
  const record = (fn: string) => async (ctx: { orgId: string }, input: unknown) => {
    ctl.ran.push({ fn, orgId: ctx.orgId, input });
    if (ctl.fail === 'throw') throw new Error('secret 900101-14-5678');
    if (ctl.fail) return { ok: false as const, error: ctl.fail };
    return { ok: true as const, data: { id: 'x', name: 'Saved' } };
  };
  return {
    ...actual,
    createEmployee: record('createEmployee'),
    updateEmployee: record('updateEmployee'),
    setEmployeeStatus: record('setEmployeeStatus'),
    deleteEmployee: record('deleteEmployee'),
    linkEmployeeToMember: record('linkEmployeeToMember'),
    createDepartment: record('createDepartment'),
    updateDepartment: record('updateDepartment'),
    deleteDepartment: record('deleteDepartment'),
  };
});

const { PEOPLE_TOOL_NAMES, createPeopleTools } = await import('@/lib/ai/people-tools');
const { PEOPLE_WRITE_TOOL_NAMES, combineToolkits, peopleProduct } = await import('@/lib/ai/products');
const { createSeedPeopleData } = await import('@/lib/people/seed');

const NOW = new Date('2026-10-09T04:00:00Z');
const HR = { employeeId: null, isHr: true, isDemo: false };
const MEMBER = { employeeId: 'seed-emp-2', isHr: false, isDemo: false };
const data = createSeedPeopleData(NOW);
const EMP = '22222222-2222-4222-8222-222222222222';
const write = () => ({ ctx: { client: {} as never, orgId: 'org-1' }, tier: 'hr' as const, employeeId: null, receipt: null, userId: 'u1' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const call = (name: string, input: Record<string, unknown>, access = write()): Promise<Loose> =>
  (
    createPeopleTools(data, HR, NOW, access)[name] as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }
  ).execute(input, { toolCallId: 't', messages: [] });

beforeEach(() => {
  ctl.ran = [];
  ctl.fail = null;
});

describe('Lekiu change tools', () => {
  it('are the eight employee and department changes, then leave, then claims and overtime, after the lookups', () => {
    expect([...PEOPLE_WRITE_TOOL_NAMES]).toEqual([
      'createEmployee', 'updateEmployee', 'setEmployeeStatus', 'deleteEmployee', 'linkEmployeeToMember',
      'createDepartment', 'updateDepartment', 'deleteDepartment',
      'applyLeave', 'applyTimeOff', 'cancelLeaveRequest', 'cancelTimeOffRequest',
      'decideLeave', 'decideTimeOff', 'setLeaveEntitlement',
      'submitClaim', 'cancelClaim', 'submitOvertime', 'cancelOvertime',
      'decideClaim', 'markClaimPaid', 'unmarkClaimPaid', 'decideOvertime',
      'clockIn', 'clockOut', 'correctAttendance', 'saveHoliday', 'removeHoliday', 'saveAttendanceSettings',
      'runPayroll', 'recalculatePayroll', 'savePayslipLine', 'removePayslipLine', 'setPayslipStatutory', 'removePayslip',
    ]);
    // An owner with no linked employee record holds no clock tool; one with a record holds every one.
    const unlinked = Object.keys(createPeopleTools(data, HR, NOW, write())).sort();
    expect(unlinked).toEqual(
      [...PEOPLE_TOOL_NAMES, 'previewLeave', 'previewOvertime', 'getAttendanceSettings', ...PEOPLE_WRITE_TOOL_NAMES]
        .filter((name) => name !== 'clockIn' && name !== 'clockOut')
        .sort(),
    );
    const linked = Object.keys(
      createPeopleTools(data, { ...HR, employeeId: EMP }, NOW, { ...write(), employeeId: EMP }),
    ).sort();
    expect(linked).toEqual(
      [...PEOPLE_TOOL_NAMES, 'previewLeave', 'previewOvertime', 'getMyAttendanceToday', 'getAttendanceSettings', ...PEOPLE_WRITE_TOOL_NAMES].sort(),
    );
  });

  it('every one of them waits for approval, and none is a lookup', () => {
    const linked = { ...write(), employeeId: EMP };
    const kit = peopleProduct({ data, viewer: { ...HR, employeeId: EMP }, write: linked });
    expect(Object.keys(kit.write).sort()).toEqual([...PEOPLE_WRITE_TOOL_NAMES].sort());
    expect(Object.keys(kit.read).sort()).toEqual(
      [...PEOPLE_TOOL_NAMES, 'previewLeave', 'previewOvertime', 'getMyAttendanceToday', 'getAttendanceSettings'].sort(),
    );
    const { toolApproval } = combineToolkits([kit]);
    for (const name of PEOPLE_WRITE_TOOL_NAMES) expect(toolApproval?.[name]).toBe('user-approval');
  });

  it('someone who is not an HR admin holds none, so nothing they read can trigger a change', () => {
    const kit = peopleProduct({ data, viewer: MEMBER });
    expect(Object.keys(kit.write)).toEqual([]);
    expect(combineToolkits([kit]).toolApproval).toBeUndefined();
  });

  it('runs a change in the workspace from the context and reports what the change returned', async () => {
    const result = await call('createDepartment', { name: 'Legal' });
    expect(result).toEqual({ ok: true, data: { id: 'x', name: 'Saved' } });
    expect(ctl.ran).toEqual([{ fn: 'createDepartment', orgId: 'org-1', input: { name: 'Legal' } }]);
  });

  it.each([
    ['createEmployee', { name: 'Farah Idris' }],
    ['updateEmployee', { id: EMP, designation: 'Lead' }],
    ['setEmployeeStatus', { id: EMP, status: 'inactive' }],
    ['deleteEmployee', { id: EMP }],
    ['updateDepartment', { id: EMP, name: 'Ops' }],
    ['deleteDepartment', { id: EMP }],
  ])('%s goes to its own change with the input as given', async (name, input) => {
    await call(name, input);
    expect(ctl.ran).toEqual([{ fn: name, orgId: 'org-1', input }]);
  });

  it('passes a refusal on as it is', async () => {
    ctl.fail = 'That department still has employees, including inactive ones. Move them to another department first.';
    expect(await call('deleteDepartment', { id: EMP })).toEqual({ ok: false, error: ctl.fail });
  });

  it('turns a crash into a plain refusal without logging what it carried', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.fail = 'throw';
    expect(await call('createEmployee', { name: 'Farah Idris' })).toEqual({
      ok: false,
      error: 'That change could not be saved. Please try again.',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('900101');
    log.mockRestore();
  });

  it('links by the member\'s sign-in email, in any letter case', async () => {
    await call('linkEmployeeToMember', { id: EMP, memberEmail: ' farah@example.com ' });
    expect(ctl.ran).toEqual([
      { fn: 'linkEmployeeToMember', orgId: 'org-1', input: { id: EMP, user_id: '33333333-3333-4333-8333-333333333333' } },
    ]);
  });

  it('unlinks with a null email', async () => {
    await call('linkEmployeeToMember', { id: EMP, memberEmail: null });
    expect(ctl.ran[0].input).toEqual({ id: EMP, user_id: null });
  });

  it('refuses an email nobody in the workspace signs in with, and an empty one, without changing anything', async () => {
    const unknown = await call('linkEmployeeToMember', { id: EMP, memberEmail: 'nobody@example.com' });
    expect(unknown).toEqual({
      ok: false,
      error: 'No member of this workspace signs in with that email. They need to join the workspace first.',
    });
    expect((await call('linkEmployeeToMember', { id: EMP, memberEmail: '  ' })).ok).toBe(false);
    expect(ctl.ran).toEqual([]);
  });
});
