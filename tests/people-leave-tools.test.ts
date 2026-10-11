import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaveBalance, LeaveRequest, PeopleData, PeopleViewer, TimeOffRequest } from '@/lib/people/types';

const ctl = vi.hoisted(() => ({
  ran: [] as { fn: string; orgId: string; input: unknown }[],
  fail: null as string | null,
}));

// Every leave function is replaced by a recorder; the schemas and `overBalanceBy` stay real.
vi.mock('@/lib/people/leave', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/leave')>();
  const record = (fn: string) => async (ctx: { orgId: string }, input: unknown) => {
    ctl.ran.push({ fn, orgId: ctx.orgId, input });
    if (ctl.fail === 'throw') throw new Error('secret reason: my mother is ill');
    if (ctl.fail) return { ok: false as const, error: ctl.fail };
    return { ok: true as const, data: { id: 'x', status: 'pending' } };
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

const { PEOPLE_TOOL_NAMES, createPeopleTools } = await import('@/lib/ai/people-tools');
const { PEOPLE_WRITE_TOOL_NAMES, combineToolkits, peopleProduct } = await import('@/lib/ai/products');
const { createSeedPeopleData } = await import('@/lib/people/seed');

const NOW = new Date('2026-10-09T04:00:00Z');
const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const REQ = '44444444-4444-4444-8444-444444444444';
const HR_VIEWER: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const MEMBER_VIEWER: PeopleViewer = { employeeId: ME, employeeName: 'Faiz Hakim', isHr: false, isDemo: false };
const DEMO_VIEWER: PeopleViewer = { employeeId: ME, isHr: false, isDemo: true };
const base = createSeedPeopleData(NOW);

const hr = () => ({ ctx: { client: {} as never, orgId: 'org-1' }, tier: 'hr' as const, employeeId: null as string | null, receipt: null, userId: 'u1' });
const self = (employeeId: string | null = ME) => ({ ctx: { client: {} as never, orgId: 'org-1' }, tier: 'self' as const, employeeId, receipt: null, userId: 'u1' });

const SELF_TOOLS = [
  'previewLeave', 'previewOvertime', 'applyLeave', 'applyTimeOff', 'cancelLeaveRequest', 'cancelTimeOffRequest',
  'submitClaim', 'cancelClaim', 'submitOvertime', 'cancelOvertime',
  // Anyone linked to an employee record can clock in and out for themselves, and ask whether they have.
  'clockIn', 'clockOut', 'getMyAttendanceToday',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const tools = (viewer = HR_VIEWER, write?: ReturnType<typeof hr> | ReturnType<typeof self>, data: PeopleData = base) =>
  createPeopleTools(data, viewer, NOW, write);
const run = (name: string, input: Record<string, unknown>, viewer = HR_VIEWER, write?: ReturnType<typeof hr> | ReturnType<typeof self>): Promise<Loose> =>
  (tools(viewer, write)[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 't',
    messages: [],
  });
const shapeOf = (name: string, write: ReturnType<typeof hr> | ReturnType<typeof self>) =>
  Object.keys(
    (tools(write.tier === 'hr' ? HR_VIEWER : MEMBER_VIEWER, write)[name] as unknown as { inputSchema: { shape: object } })
      .inputSchema.shape,
  );

beforeEach(() => {
  ctl.ran = [];
  ctl.fail = null;
});

describe('who holds which leave tools', () => {
  it('an owner or admin holds every change tool, and the preview', () => {
    // This owner has no linked employee record, so the clock tools (and "have I clocked in?") are not theirs.
    const held = Object.keys(tools(HR_VIEWER, hr()));
    expect(held.sort()).toEqual(
      [...PEOPLE_TOOL_NAMES, 'previewLeave', 'previewOvertime', 'getAttendanceSettings', ...PEOPLE_WRITE_TOOL_NAMES]
        .filter((name) => !['clockIn', 'clockOut'].includes(name))
        .sort(),
    );
    for (const name of ['decideLeave', 'decideTimeOff', 'setLeaveEntitlement']) expect(PEOPLE_WRITE_TOOL_NAMES).toContain(name);
  });

  it('a linked member holds the preview, apply and cancel for themselves, and nothing that decides', () => {
    const held = Object.keys(tools(MEMBER_VIEWER, self()));
    expect(held.sort()).toEqual([...PEOPLE_TOOL_NAMES, ...SELF_TOOLS].sort());
    for (const name of ['decideLeave', 'decideTimeOff', 'setLeaveEntitlement', 'createEmployee', 'linkEmployeeToMember', 'deleteDepartment']) {
      expect(held, name).not.toContain(name);
    }
  });

  it('a member with no employee record, and someone with no write access at all, hold lookups only', () => {
    expect(Object.keys(tools(MEMBER_VIEWER, self(null)))).toEqual([...PEOPLE_TOOL_NAMES]);
    expect(Object.keys(tools(MEMBER_VIEWER))).toEqual([...PEOPLE_TOOL_NAMES]);
    expect(Object.keys(tools(DEMO_VIEWER))).toEqual([...PEOPLE_TOOL_NAMES]);
  });

  it('every change waits for approval and the preview does not, whoever holds them', () => {
    for (const write of [hr(), self()]) {
      const kit = peopleProduct({ data: base, viewer: write.tier === 'hr' ? HR_VIEWER : MEMBER_VIEWER, write });
      const { toolApproval } = combineToolkits([kit]);
      expect(Object.keys(kit.write).sort()).toEqual(Object.keys(toolApproval ?? {}).sort());
      for (const name of Object.keys(kit.write)) expect(toolApproval?.[name], name).toBe('user-approval');
      expect(kit.read).toHaveProperty('previewLeave');
      expect(kit.read).toHaveProperty('previewOvertime');
      expect(toolApproval).not.toHaveProperty('previewLeave');
      expect(toolApproval).not.toHaveProperty('previewOvertime');
    }
    const member = peopleProduct({ data: base, viewer: MEMBER_VIEWER, write: self() });
    expect(Object.keys(member.write).sort()).toEqual([
      'applyLeave', 'applyTimeOff', 'cancelClaim', 'cancelLeaveRequest', 'cancelOvertime', 'cancelTimeOffRequest',
      'clockIn', 'clockOut', 'submitClaim', 'submitOvertime',
    ]);
  });
});

describe('a member’s tools act for themselves only', () => {
  it('have no employee field in their schema, for the preview and both applies', () => {
    for (const name of ['previewLeave', 'applyLeave', 'applyTimeOff']) {
      expect(shapeOf(name, self()), name).not.toContain('employee_id');
      expect(shapeOf(name, hr()), name).toContain('employee_id');
    }
    expect(shapeOf('applyLeave', self()).sort()).toEqual(['end_date', 'half_day', 'leave_type', 'reason', 'start_date']);
  });

  it('drop an employee the model sends before the call is even made', () => {
    const schema = (tools(MEMBER_VIEWER, self()).applyLeave as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: object } } })
      .inputSchema;
    const parsed = schema.safeParse({ employee_id: OTHER, leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('employee_id');
  });

  it('apply and preview with the member’s own id, whatever the model sends', async () => {
    const leave = { employee_id: OTHER, leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' };
    await run('applyLeave', leave, MEMBER_VIEWER, self());
    await run('previewLeave', leave, MEMBER_VIEWER, self());
    await run(
      'applyTimeOff',
      { employee_id: OTHER, off_date: '2026-10-20', start_time: '14:00', end_time: '16:00' },
      MEMBER_VIEWER,
      self(),
    );
    expect(ctl.ran.map((r) => r.fn)).toEqual(['applyLeave', 'previewLeave', 'applyTimeOff']);
    for (const r of ctl.ran) {
      expect(r.orgId).toBe('org-1');
      expect(r.input).toMatchObject({ employee_id: ME });
    }
  });

  it('an owner or admin names the employee they apply for', async () => {
    await run('applyLeave', { employee_id: OTHER, leave_type: 'medical', start_date: '2026-10-20', end_date: '2026-10-20' }, HR_VIEWER, hr());
    expect(ctl.ran).toEqual([
      { fn: 'applyLeave', orgId: 'org-1', input: { employee_id: OTHER, leave_type: 'medical', start_date: '2026-10-20', end_date: '2026-10-20' } },
    ]);
  });

  it('cancel by request id only, for a member and for an owner or admin', async () => {
    await run('cancelLeaveRequest', { id: REQ }, MEMBER_VIEWER, self());
    await run('cancelTimeOffRequest', { id: REQ }, HR_VIEWER, hr());
    expect(ctl.ran).toEqual([
      { fn: 'cancelLeave', orgId: 'org-1', input: { id: REQ } },
      { fn: 'cancelTimeOff', orgId: 'org-1', input: { id: REQ } },
    ]);
    expect(shapeOf('cancelLeaveRequest', self())).toEqual(['id']);
  });
});

describe('an owner or admin’s decisions', () => {
  it('goes to the decide and entitlement functions with the input as given', async () => {
    await run('decideLeave', { id: REQ, approve: false, note: 'Busy week' }, HR_VIEWER, hr());
    await run('decideTimeOff', { id: REQ, approve: true }, HR_VIEWER, hr());
    await run('setLeaveEntitlement', { employee_id: OTHER, leave_type: 'annual', year: 2026, days: 18 }, HR_VIEWER, hr());
    expect(ctl.ran).toEqual([
      { fn: 'decideLeave', orgId: 'org-1', input: { id: REQ, approve: false, note: 'Busy week' } },
      { fn: 'decideTimeOff', orgId: 'org-1', input: { id: REQ, approve: true } },
      { fn: 'setLeaveEntitlement', orgId: 'org-1', input: { employee_id: OTHER, leave_type: 'annual', year: 2026, days: 18 } },
    ]);
  });
});

// The provider's own unit is the group; the route runs these with `hr()` as the write access of an owner.
async function runWith(
  data: PeopleData,
  name: string,
  viewer: PeopleViewer,
  write?: ReturnType<typeof hr> | ReturnType<typeof self>,
): Promise<Loose> {
  const tool = tools(viewer, write, data)[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> };
  return tool.execute({}, { toolCallId: 't', messages: [] });
}

const leaveRow = (id: string, employee_id: string, over: Partial<LeaveRequest> = {}): LeaveRequest => ({
  id,
  employee_id,
  employee_name: employee_id === ME ? 'Faiz Hakim' : 'Amirul Hakim',
  leave_type: 'annual',
  start_date: '2026-10-20',
  end_date: '2026-10-22',
  days: 3,
  half_day: false,
  reason: 'Family trip',
  status: 'pending',
  decision_note: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});
const balance = (employee_id: string): LeaveBalance => ({
  id: `b-${employee_id}`,
  employee_id,
  leave_type: 'annual',
  year: 2026,
  entitled_days: 14,
  used_days: 10,
});
const timeOffRow = (id: string, employee_id: string, over: Partial<TimeOffRequest> = {}): TimeOffRequest => ({
  id,
  employee_id,
  employee_name: employee_id === ME ? 'Faiz Hakim' : 'Amirul Hakim',
  off_date: '2026-10-20',
  start_time: '14:00:00',
  end_time: '16:00:00',
  reason: 'Clinic',
  status: 'pending',
  decision_note: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});

const lookupData: PeopleData = {
  ...base,
  listLeaveRequests: async () => [
    leaveRow('55555555-5555-4555-8555-555555555555', ME),
    leaveRow('66666666-6666-4666-8666-666666666666', OTHER, { days: 6, start_date: '2026-11-02', end_date: '2026-11-09' }),
  ],
  listLeaveBalances: async () => [balance(ME), balance(OTHER)],
  listTimeOffRequests: async () => [timeOffRow('77777777-7777-4777-8777-777777777777', ME), timeOffRow('88888888-8888-4888-8888-888888888888', OTHER)],
};

describe('leave lookups carry what a change needs', () => {
  it('give an owner or admin every request’s id, and how far over balance each is', async () => {
    const { requests } = await runWith(lookupData, 'listLeaveRequests', HR_VIEWER, hr());
    expect(requests.map((r: Loose) => r.id)).toEqual(['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666']);
    // 14 entitled, 10 used: 4 left. Three days fits; six is two over.
    expect(requests.map((r: Loose) => r.over_balance)).toEqual([0, 2]);
    expect(requests[0]).toMatchObject({ employee: 'Faiz Hakim', leave_type: 'annual', half_day: false });
  });

  it('give a member the id of their own requests only, and no over_balance', async () => {
    const { requests } = await runWith(lookupData, 'listLeaveRequests', MEMBER_VIEWER, self());
    expect(requests[0].id).toBe('55555555-5555-4555-8555-555555555555');
    expect(requests[1]).not.toHaveProperty('id');
    for (const r of requests) expect(r).not.toHaveProperty('over_balance');
  });

  it('give an id to no one who holds no change tool, and to no one in the demo', async () => {
    for (const result of [
      await runWith(lookupData, 'listLeaveRequests', MEMBER_VIEWER),
      await runWith(lookupData, 'listLeaveRequests', DEMO_VIEWER, self()),
    ]) {
      for (const r of result.requests) {
        expect(r).not.toHaveProperty('id');
        expect(r).not.toHaveProperty('over_balance');
      }
    }
  });

  it('return a decision note only when there is one', async () => {
    const noted: PeopleData = {
      ...lookupData,
      listLeaveRequests: async () => [
        leaveRow('55555555-5555-4555-8555-555555555555', ME, { status: 'rejected', decision_note: 'Team is short that week' }),
        leaveRow('66666666-6666-4666-8666-666666666666', ME),
      ],
      listTimeOffRequests: async () => [
        timeOffRow('77777777-7777-4777-8777-777777777777', ME, { status: 'rejected', decision_note: 'Audit day' }),
        timeOffRow('88888888-8888-4888-8888-888888888888', ME),
      ],
    };
    const leave = (await runWith(noted, 'listLeaveRequests', MEMBER_VIEWER, self())).requests;
    expect(leave[0].decision_note).toBe('Team is short that week');
    expect(leave[1]).not.toHaveProperty('decision_note');
    const off = (await runWith(noted, 'listTimeOffRequests', MEMBER_VIEWER, self())).requests;
    expect(off[0].decision_note).toBe('Audit day');
    expect(off[1]).not.toHaveProperty('decision_note');
  });

  it('list time-off requests with the same rule for ids, and times as HH:MM', async () => {
    const hrRows = (await runWith(lookupData, 'listTimeOffRequests', HR_VIEWER, hr())).requests;
    expect(hrRows.map((r: Loose) => r.id)).toEqual(['77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888']);
    expect(hrRows[0]).toMatchObject({ off_date: '2026-10-20', start_time: '14:00', end_time: '16:00', employee: 'Faiz Hakim' });
    const memberRows = (await runWith(lookupData, 'listTimeOffRequests', MEMBER_VIEWER, self())).requests;
    expect(memberRows[0].id).toBe('77777777-7777-4777-8777-777777777777');
    expect(memberRows[1]).not.toHaveProperty('id');
    const none = (await runWith(lookupData, 'listTimeOffRequests', MEMBER_VIEWER)).requests;
    for (const r of none) expect(r).not.toHaveProperty('id');
  });
});

describe('a change that fails', () => {
  it('passes a refusal on as it is', async () => {
    ctl.fail = 'That overlaps leave already applied for on those dates.';
    expect(await run('cancelLeaveRequest', { id: REQ }, MEMBER_VIEWER, self())).toEqual({ ok: false, error: ctl.fail });
  });

  it('a crashing preview says it could not work out the days, not that a change failed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.fail = 'throw';
    const result = await run('previewLeave', { leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' }, MEMBER_VIEWER, self());
    expect(result).toEqual({ ok: false, error: 'Could not work out the days just now.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('mother');
    log.mockRestore();
  });

  it('turns a crash into a plain refusal and logs only the error’s name, never what it carried', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.fail = 'throw';
    const result = await run(
      'applyLeave',
      { leave_type: 'medical', start_date: '2026-10-20', end_date: '2026-10-20', reason: 'my mother is ill' },
      MEMBER_VIEWER,
      self(),
    );
    expect(result).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('mother');
    expect(log).toHaveBeenCalledWith('[lekiu] applyLeave failed:', 'Error');
    log.mockRestore();
  });
});

describe('an owner or admin’s own requests', () => {
  const NO_ONE = 'Say which employee this is for. Your own account is not linked to an employee record.';
  const linked = (employeeId: string | null) => ({ ...hr(), employeeId });
  const LEAVE = { leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' };
  const OFF = { off_date: '2026-10-20', start_time: '14:00', end_time: '16:00' };
  const CALLS: [string, Record<string, unknown>][] = [
    ['previewLeave', LEAVE],
    ['applyLeave', LEAVE],
    ['applyTimeOff', OFF],
  ];

  it('make the employee optional in the schema, and say what leaving it out means', () => {
    for (const [name] of CALLS) {
      const schema = (tools(HR_VIEWER, hr())[name] as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean }; shape: { employee_id: { description?: string } } } })
        .inputSchema;
      expect(schema.safeParse({ ...(name === 'applyTimeOff' ? OFF : LEAVE) }).success, name).toBe(true);
      expect(schema.shape.employee_id.description, name).toContain('leave it out when the request is for the person you are talking to');
    }
  });

  it('act for their own linked employee when none is named', async () => {
    for (const [name, input] of CALLS) await run(name, input, HR_VIEWER, linked(ME));
    expect(ctl.ran.map((r) => r.fn)).toEqual(['previewLeave', 'applyLeave', 'applyTimeOff']);
    for (const r of ctl.ran) expect(r.input).toMatchObject({ employee_id: ME });
  });

  it('refuse, without touching the database, when none is named and their account is linked to no one', async () => {
    for (const [name, input] of CALLS) {
      expect(await run(name, input, HR_VIEWER, linked(null)), name).toEqual({ ok: false, error: NO_ONE });
    }
    expect(ctl.ran).toEqual([]);
  });

  it('let an employee they name win over their own', async () => {
    for (const [name, input] of CALLS) await run(name, { ...input, employee_id: OTHER }, HR_VIEWER, linked(ME));
    for (const r of ctl.ran) expect(r.input).toMatchObject({ employee_id: OTHER });
    expect(ctl.ran).toHaveLength(3);
  });

  it('treat an employee sent as null like one left out', async () => {
    for (const [name, input] of CALLS) await run(name, { ...input, employee_id: null }, HR_VIEWER, linked(ME));
    expect(ctl.ran).toHaveLength(3);
    for (const r of ctl.ran) expect(r.input).toMatchObject({ employee_id: ME });
  });

  it('refuse when their own employee is undefined, never writing it as an id', async () => {
    const unset = { ...hr(), employeeId: undefined as unknown as null };
    for (const [name, input] of CALLS) {
      expect(await run(name, input, HR_VIEWER, unset), name).toEqual({ ok: false, error: NO_ONE });
    }
    expect(ctl.ran).toEqual([]);
  });

  it('leave a member’s tools as they were: no employee field, always their own', async () => {
    for (const [name] of CALLS) expect(shapeOf(name, self()), name).not.toContain('employee_id');
    await run('applyLeave', { ...LEAVE, employee_id: OTHER }, MEMBER_VIEWER, self());
    expect(ctl.ran[0].input).toMatchObject({ employee_id: ME });
  });
});
