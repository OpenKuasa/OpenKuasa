import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';

const ctl = vi.hoisted(() => ({
  ran: [] as { fn: string; orgId: string; input: unknown }[],
  swaps: [] as unknown[],
  options: [] as unknown[],
}));

// The real write-path schemas stay; only the database call is recorded.
vi.mock('@/lib/people/roster-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/roster-writes')>();
  const record = (fn: string) => async (ctx: { orgId: string }, input: unknown) => {
    ctl.ran.push({ fn, orgId: ctx.orgId, input });
    return { ok: true as const, data: { id: 'x', status: 'saved' } };
  };
  return { ...actual, saveRoster: record('saveRoster'), saveHours: record('saveHours'), saveShiftType: record('saveShiftType'), archiveShiftType: record('archiveShiftType') };
});
vi.mock('@/lib/people/swap-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/swap-writes')>();
  const record = (fn: string) => async (ctx: { orgId: string }, input: unknown) => {
    ctl.ran.push({ fn, orgId: ctx.orgId, input });
    return { ok: true as const, data: { id: 'x', status: 'requested' } };
  };
  return {
    ...actual,
    requestShiftSwap: record('requestShiftSwap'),
    replyShiftSwap: record('replyShiftSwap'),
    decideShiftSwap: record('decideShiftSwap'),
    cancelShiftSwap: record('cancelShiftSwap'),
  };
});
vi.mock('@/lib/people/swaps', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/swaps')>();
  return { ...actual, listSwaps: async () => ctl.swaps, listSwapOptions: async () => ctl.options };
});

const { createPeopleTools } = await import('@/lib/ai/people-tools');
const { PEOPLE_WRITE_TOOL_NAMES, combineToolkits, peopleProduct } = await import('@/lib/ai/products');
const { guardRosterWrites, rosterIdProblem, rosterIds } = await import('@/lib/ai/roster-id-gate');
const { approvalDetail, approvalTitle, nameIn } = await import('@/lib/chat/change-titles');
const { changeRows } = await import('@/lib/chat/change-rows');
const { refusalForUser } = await import('@/components/chat/tool-parts');
const { ROSTER_CHANGE_TOOLS } = await import('@/lib/people/roster-cards');
const { DEFAULT_PEOPLE_SETTINGS } = await import('@/lib/people/types');
type PeopleData = import('@/lib/people/types').PeopleData;
type PeopleViewer = import('@/lib/people/types').PeopleViewer;

// A Thursday in Kuala Lumpur: this week starts Mon 19 Oct, last week Mon 12 Oct.
const NOW = new Date('2026-10-22T04:00:00Z');
const AINA = '11111111-1111-4111-8111-111111111111';
const FAIZ = '22222222-2222-4222-8222-222222222222';
const SITI = '33333333-3333-4333-8333-333333333333';
const MORNING = '44444444-4444-4444-8444-444444444444';
const NIGHT = '55555555-5555-4555-8555-555555555555';
const OLD = '66666666-6666-4666-8666-666666666666';
const SHIFT_MINE = '77777777-7777-4777-8777-777777777777';
const SHIFT_FAIZ = '88888888-8888-4888-8888-888888888888';
const SWAP_ASKED = '99999999-9999-4999-8999-999999999991';
const SWAP_AGREED = '99999999-9999-4999-8999-999999999992';
const SWAP_OTHERS = '99999999-9999-4999-8999-999999999993';

const person = (id: string, name: string, reports_to: string | null = null) => ({
  id, name, user_id: `u-${id}`, employee_no: name.slice(0, 3), work_email: null, department_id: null, department_name: null,
  designation: null, employment_type: 'full_time' as const, reports_to, join_date: null, status: 'active' as const,
  date_of_birth_day: null, date_of_birth_month: null, created_at: '2026-01-01T00:00:00Z',
});

const data: PeopleData = {
  listDepartments: async () => [],
  listEmployees: async () => [person(AINA, 'Aina Rahman'), person(FAIZ, 'Faiz Hakim', SITI), person(SITI, 'Siti Aminah')],
  getEmployeePrivate: async () => null,
  listLeaveRequests: async () => [], listLeaveBalances: async () => [], listTimeOffRequests: async () => [],
  listClaims: async () => [], listOvertime: async () => [], listAttendance: async () => [],
  listTimesheet: async () => [], listShifts: async () => [],
  listShiftTypes: async () => [
    { id: MORNING, name: 'Morning', start_time: '09:00', end_time: '18:00', is_off: false, color: 'sky', archived: false },
    { id: NIGHT, name: 'Night', start_time: '21:00', end_time: '06:00', is_off: false, color: 'slate', archived: false },
    { id: OLD, name: 'Split', start_time: '07:00', end_time: '12:00', is_off: false, color: 'amber', archived: true },
  ],
  listPublicHolidays: async () => [], listPayrollRuns: async () => [], listPayslips: async () => [], listGoals: async () => [],
  listReviews: async () => [], listTrainings: async () => [], listTrainingEnrolments: async () => [], listAnnouncements: async () => [],
  listDocuments: async () => [], listLetters: async () => [], listLetterTemplates: async () => [], listPaymentVouchers: async () => [],
  getSettings: async () => structuredClone(DEFAULT_PEOPLE_SETTINGS),
};

type Tier = 'hr' | 'manager' | 'self';
const access = (tier: Tier, employeeId: string | null) => ({
  ctx: { client: {} as never, orgId: 'org-1' }, tier, employeeId, receipt: null, userId: 'u1',
});
const HR_UNLINKED: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const HR_LINKED: PeopleViewer = { employeeId: SITI, employeeName: 'Siti Aminah', isHr: true, isDemo: false, isOwner: false };
const MANAGER: PeopleViewer = { employeeId: SITI, employeeName: 'Siti Aminah', isHr: false, isDemo: false, managesTeam: true };
const MEMBER: PeopleViewer = { employeeId: AINA, employeeName: 'Aina Rahman', isHr: false, isDemo: false };

const toolsFor = (viewer: PeopleViewer, tier: Tier) => createPeopleTools(data, viewer, NOW, access(tier, viewer.employeeId));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const exec = (tools: Record<string, unknown>, name: string, input: unknown): Promise<Loose> =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 't', messages: [] });
const parse = (tools: Record<string, unknown>, name: string, input: unknown) =>
  ((tools[name] as { inputSchema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] }; data?: unknown } } }).inputSchema).safeParse(input);

beforeEach(() => {
  ctl.ran = [];
  ctl.swaps = [];
  ctl.options = [];
});

describe('who holds the roster tools', () => {
  const rosterNames = (tools: Record<string, unknown>) =>
    Object.keys(tools).filter((n) => (ROSTER_CHANGE_TOOLS as readonly string[]).includes(n) || ['listShiftSwaps', 'listSwapOptions'].includes(n)).sort();

  it('an owner or admin with no employee record: the roster, hours, types and deciding; none of a person\'s own swap tools', () => {
    expect(rosterNames(toolsFor(HR_UNLINKED, 'hr'))).toEqual(['archiveShiftType', 'decideShiftSwap', 'listShiftSwaps', 'logHours', 'saveShiftType', 'setShifts']);
  });

  it('an owner or admin linked to a record also asks, answers and cancels their own swaps', () => {
    expect(rosterNames(toolsFor(HR_LINKED, 'hr'))).toEqual([...ROSTER_CHANGE_TOOLS, 'listShiftSwaps', 'listSwapOptions'].sort());
  });

  it('a manager: their own hours and swaps, and deciding a swap; never the roster or the types', () => {
    expect(rosterNames(toolsFor(MANAGER, 'manager'))).toEqual(
      ['cancelShiftSwap', 'decideShiftSwap', 'listShiftSwaps', 'listSwapOptions', 'logHours', 'replyShiftSwap', 'requestShiftSwap'].sort(),
    );
  });

  it('a member: their own hours and swaps only', () => {
    expect(rosterNames(toolsFor(MEMBER, 'self'))).toEqual(
      ['cancelShiftSwap', 'listShiftSwaps', 'listSwapOptions', 'logHours', 'replyShiftSwap', 'requestShiftSwap'].sort(),
    );
  });

  it('the demo and someone with no write access hold none, and still read the shift types', () => {
    const demo = createPeopleTools(data, { ...HR_LINKED, isDemo: true }, NOW, access('hr', SITI));
    const readOnly = createPeopleTools(data, MEMBER, NOW);
    for (const tools of [demo, readOnly]) {
      expect(rosterNames(tools)).toEqual([]);
      expect(Object.keys(tools)).toContain('listShiftTypes');
    }
  });

  it('every roster change is on the write side, so it always waits for approval', () => {
    const kit = peopleProduct({ data, viewer: HR_LINKED, write: access('hr', SITI) });
    const { toolApproval } = combineToolkits([kit]);
    for (const name of ROSTER_CHANGE_TOOLS) {
      expect(PEOPLE_WRITE_TOOL_NAMES as readonly string[], name).toContain(name);
      expect(kit.write, name).toHaveProperty(name);
      expect(toolApproval?.[name], name).toBe('user-approval');
    }
    for (const name of ['listShiftTypes', 'listShiftSwaps', 'listSwapOptions']) expect(kit.read, name).toHaveProperty(name);
  });
});

describe('the roster lookups', () => {
  it('listShiftTypes gives the id, name and times, and leaves archived types out unless asked', async () => {
    const tools = toolsFor(MEMBER, 'self');
    const result = await exec(tools, 'listShiftTypes', {});
    expect(result.shift_types).toEqual([
      { id: MORNING, name: 'Morning', times: '09:00–18:00', off: false, color: 'sky' },
      { id: NIGHT, name: 'Night', times: '21:00–06:00 (overnight)', off: false, color: 'slate' },
    ]);
    const all = await exec(tools, 'listShiftTypes', { includeArchived: true });
    expect(all.shift_types.map((t: Loose) => [t.name, t.archived ?? false])).toEqual([['Morning', false], ['Night', false], ['Split', true]]);
  });

  const swap = (id: string, requester: string, colleague: string, status: string) => ({
    id, requester_employee_id: requester, colleague_employee_id: colleague, requester_date: '2026-10-27', requester_type_id: MORNING,
    colleague_date: '2026-10-28', colleague_type_id: NIGHT, note: null, status, decision_note: null, created_at: '2026-10-21T00:00:00Z',
  });

  it('listShiftSwaps says what this person may do with each swap', async () => {
    ctl.swaps = [swap(SWAP_ASKED, FAIZ, AINA, 'requested'), swap(SWAP_AGREED, AINA, FAIZ, 'accepted')];
    const mine = await exec(toolsFor(MEMBER, 'self'), 'listShiftSwaps', {});
    expect(mine.scope).toBe('your own swaps only');
    expect(mine.swaps.map((s: Loose) => [s.id, s.you_can])).toEqual([
      [SWAP_ASKED, ['accept_or_decline']],
      [SWAP_AGREED, ['cancel']],
    ]);
    expect(mine.swaps[0]).toMatchObject({
      requester: 'Faiz Hakim', colleague: 'Aina Rahman', gives: '27 Oct · Morning · 09:00–18:00', takes: '28 Oct · Night · 21:00–06:00 (overnight)',
    });
  });

  it('an owner or admin, or a manager of both, may decide a swap both agreed to; never one they are part of', async () => {
    ctl.swaps = [swap(SWAP_AGREED, AINA, FAIZ, 'accepted'), swap(SWAP_OTHERS, SITI, FAIZ, 'accepted')];
    const hr = await exec(toolsFor(HR_LINKED, 'hr'), 'listShiftSwaps', {});
    expect(hr.swaps.map((s: Loose) => [s.id, s.you_can])).toEqual([
      [SWAP_AGREED, ['approve_or_reject']],
      [SWAP_OTHERS, ['cancel']],
    ]);
    const manager = await exec(toolsFor(MANAGER, 'manager'), 'listShiftSwaps', {});
    expect(manager.swaps[0].you_can).toEqual(['approve_or_reject']);
  });

  it('a closed or expired swap is left out unless status is all', async () => {
    ctl.swaps = [swap(SWAP_ASKED, FAIZ, AINA, 'declined'), { ...swap(SWAP_AGREED, AINA, FAIZ, 'requested'), requester_date: '2026-10-22' }];
    expect((await exec(toolsFor(MEMBER, 'self'), 'listShiftSwaps', {})).swaps).toEqual([]);
    const all = await exec(toolsFor(MEMBER, 'self'), 'listShiftSwaps', { status: 'all' });
    expect(all.swaps.map((s: Loose) => [s.status, s.you_can])).toEqual([['Declined', []], ['Expired', []]]);
  });

  it('listSwapOptions gives the person\'s own shifts and the colleagues\' shifts each may be swapped for, by id', async () => {
    ctl.options = [
      { shift_id: SHIFT_MINE, employee_id: AINA, employee_name: 'Aina Rahman', work_date: '2026-10-27', shift_type_id: MORNING, mine: true },
      { shift_id: SHIFT_FAIZ, employee_id: FAIZ, employee_name: 'Faiz Hakim', work_date: '2026-10-27', shift_type_id: NIGHT, mine: false },
    ];
    const result = await exec(toolsFor(MEMBER, 'self'), 'listSwapOptions', {});
    expect(result).toEqual({
      your_shifts: [{ id: SHIFT_MINE, shift: '27 Oct · Morning · 09:00–18:00' }],
      colleague_shifts: [{ id: SHIFT_FAIZ, shift: 'Faiz Hakim · 27 Oct · Night · 21:00–06:00 (overnight)', swaps_with: [SHIFT_MINE] }],
      total_colleague_shifts: 1,
    });
    expect((await exec(toolsFor(MEMBER, 'self'), 'listSwapOptions', { colleague: 'siti' })).colleague_shifts).toEqual([]);
  });
});

describe('the roster changes check their input before any card', () => {
  const hr = () => toolsFor(HR_LINKED, 'hr');
  const errorOf = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? null : r.error!.issues[0].message);

  it('setShifts takes one week, each person and day once, up to 300 cells', () => {
    const cell = (date: string, employee = AINA) => ({ employee_id: employee, work_date: date, shift_type_id: MORNING });
    expect(parse(hr(), 'setShifts', { cells: [cell('2026-10-26'), cell('2026-11-01')] }).success).toBe(true);
    expect(errorOf(parse(hr(), 'setShifts', { cells: [cell('2026-10-26'), cell('2026-11-02')] }))).toMatch(/same Monday-to-Sunday week/);
    expect(errorOf(parse(hr(), 'setShifts', { cells: [cell('2026-10-26'), cell('2026-10-26')] }))).toMatch(/once only/);
    expect(errorOf(parse(hr(), 'setShifts', { cells: [] }))).toMatch(/at least one/);
    const many = Array.from({ length: 301 }, (_, n) => cell('2026-10-26', `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`));
    expect(errorOf(parse(hr(), 'setShifts', { cells: many }))).toMatch(/At most 300/);
    expect(errorOf(parse(hr(), 'setShifts', { cells: [{ ...cell('2026-10-26'), employee_id: 'Aina' }] }))).toMatch(/listEmployees/);
  });

  it('logHours: never a day to come; a member only this week and last; billable no more than the hours', () => {
    const member = toolsFor(MEMBER, 'self');
    expect(parse(member, 'logHours', { work_date: '2026-10-12', hours: 8 }).success).toBe(true);
    expect(errorOf(parse(member, 'logHours', { work_date: '2026-10-23', hours: 8 }))).toMatch(/hasn't happened yet/);
    expect(errorOf(parse(member, 'logHours', { work_date: '2026-10-11', hours: 8 }))).toMatch(/this week and last week only/);
    expect(errorOf(parse(member, 'logHours', { work_date: '2026-10-20', hours: 6, billable_hours: 7 }))).toMatch(/more than the hours/);
    expect(errorOf(parse(member, 'logHours', { work_date: '2026-10-20', hours: 7.25 }))).toMatch(/half an hour/);
    expect(errorOf(parse(member, 'logHours', { work_date: '2026-10-20', hours: null, billable_hours: 2 }))).toMatch(/before the billable/);
    // An owner or admin may correct an older week.
    expect(parse(hr(), 'logHours', { employee_id: AINA, work_date: '2026-09-01', hours: 8 }).success).toBe(true);
    // A member's schema has no employee field at all.
    expect(Object.keys((member.logHours as unknown as { inputSchema: { shape: object } }).inputSchema.shape)).not.toContain('employee_id');
  });

  it('saveShiftType: both times or neither, none for an off type, both for a working shift', () => {
    const base = { name: 'Evening', is_off: false, start_time: '18:00', end_time: '23:00', color: 'teal' };
    expect(parse(hr(), 'saveShiftType', base).success).toBe(true);
    expect(parse(hr(), 'saveShiftType', { ...base, start_time: '9:00', end_time: '17:30:00' }).success).toBe(true);
    expect(errorOf(parse(hr(), 'saveShiftType', { ...base, end_time: '' }))).toMatch(/both a start and an end/);
    expect(errorOf(parse(hr(), 'saveShiftType', { ...base, is_off: true }))).toMatch(/off type has no times/);
    expect(errorOf(parse(hr(), 'saveShiftType', { ...base, start_time: null, end_time: null }))).toMatch(/needs a start and an end/);
    expect(errorOf(parse(hr(), 'saveShiftType', { ...base, color: 'violet' }))).toMatch(/colour/);
  });

  it('requestShiftSwap needs two different shifts', () => {
    expect(errorOf(parse(toolsFor(MEMBER, 'self'), 'requestShiftSwap', { my_shift_id: SHIFT_MINE, their_shift_id: SHIFT_MINE }))).toMatch(/colleague's shift/);
  });
});

describe('the roster changes call the same write path as the screens', () => {
  it('setShifts saves the week the cells are in, from its Monday, in the session\'s workspace', async () => {
    const cells = [
      { employee_id: AINA, work_date: '2026-10-28', shift_type_id: MORNING },
      { employee_id: FAIZ, work_date: '2026-10-29', shift_type_id: null },
    ];
    await exec(toolsFor(HR_UNLINKED, 'hr'), 'setShifts', { cells });
    expect(ctl.ran).toEqual([{ fn: 'saveRoster', orgId: 'org-1', input: { week_start: '2026-10-26', cells } }]);
  });

  it('logHours: a member always logs their own; an owner names the employee or logs their own', async () => {
    await exec(toolsFor(MEMBER, 'self'), 'logHours', { work_date: '2026-10-20', hours: 8, billable_hours: 6 });
    await exec(toolsFor(HR_LINKED, 'hr'), 'logHours', { employee_id: FAIZ, work_date: '2026-10-20', hours: null, billable_hours: null });
    await exec(toolsFor(HR_LINKED, 'hr'), 'logHours', { work_date: '2026-10-21', hours: 7.5 });
    expect(ctl.ran.map((r) => r.input)).toEqual([
      { employee_id: AINA, work_date: '2026-10-20', hours: 8, billable_hours: 6 },
      { employee_id: FAIZ, work_date: '2026-10-20', hours: null, billable_hours: null },
      { employee_id: SITI, work_date: '2026-10-21', hours: 7.5, billable_hours: null },
    ]);
  });

  it('logHours for an owner with no employee record and none named is refused before the database', async () => {
    const result = await exec(toolsFor(HR_UNLINKED, 'hr'), 'logHours', { work_date: '2026-10-21', hours: 7 });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Say which employee') });
    expect(ctl.ran).toEqual([]);
  });

  it('saveShiftType reads loose times and an empty id as an add; archiveShiftType passes the id', async () => {
    const tools = toolsFor(HR_UNLINKED, 'hr');
    await exec(tools, 'saveShiftType', { id: '', name: 'Evening', is_off: false, start_time: '9:00', end_time: '17:30:00', color: 'teal' });
    await exec(tools, 'archiveShiftType', { id: NIGHT, archived: true });
    expect(ctl.ran.map((r) => [r.fn, r.input])).toEqual([
      ['saveShiftType', { id: null, name: 'Evening', is_off: false, start_time: '09:00', end_time: '17:30', color: 'teal' }],
      ['archiveShiftType', { id: NIGHT, archived: true }],
    ]);
  });

  it('the swap steps go to their own functions; an approval carries no note', async () => {
    const member = toolsFor(MEMBER, 'self');
    await exec(member, 'requestShiftSwap', { my_shift_id: SHIFT_MINE, their_shift_id: SHIFT_FAIZ, note: '  ' });
    await exec(member, 'replyShiftSwap', { id: SWAP_ASKED, accept: true });
    await exec(member, 'cancelShiftSwap', { id: SWAP_AGREED });
    await exec(toolsFor(MANAGER, 'manager'), 'decideShiftSwap', { id: SWAP_OTHERS, approve: true, note: 'fine' });
    expect(ctl.ran.map((r) => [r.fn, r.input])).toEqual([
      ['requestShiftSwap', { my_shift_id: SHIFT_MINE, their_shift_id: SHIFT_FAIZ, note: null }],
      ['replyShiftSwap', { id: SWAP_ASKED, accept: true }],
      ['cancelShiftSwap', { id: SWAP_AGREED }],
      ['decideShiftSwap', { id: SWAP_OTHERS, approve: true, note: null }],
    ]);
  });
});

/** The tool results of a conversation that looked everything up, as the model and the chat see them. */
async function lookups() {
  ctl.swaps = [
    {
      id: SWAP_AGREED, requester_employee_id: AINA, colleague_employee_id: FAIZ, requester_date: '2026-10-27', requester_type_id: MORNING,
      colleague_date: '2026-10-28', colleague_type_id: NIGHT, note: null, status: 'accepted', decision_note: null, created_at: '2026-10-21T00:00:00Z',
    },
  ];
  ctl.options = [
    { shift_id: SHIFT_MINE, employee_id: SITI, employee_name: 'Siti Aminah', work_date: '2026-10-27', shift_type_id: MORNING, mine: true },
    { shift_id: SHIFT_FAIZ, employee_id: FAIZ, employee_name: 'Faiz Hakim', work_date: '2026-10-27', shift_type_id: NIGHT, mine: false },
  ];
  const tools = toolsFor(HR_LINKED, 'hr');
  const results = [];
  for (const [tool, input] of [['listEmployees', {}], ['listShiftTypes', {}], ['listShiftSwaps', {}], ['listSwapOptions', {}]] as const) {
    results.push({ tool, output: await exec(tools, tool, input) });
  }
  return results;
}

describe('the approval cards name people, days, types and hours, never ids', () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

  it('says what each change does in plain words', async () => {
    const find = nameIn(await lookups());
    const title = (tool: string, input: unknown) => approvalTitle(tool, input, find);
    expect(title('setShifts', { cells: [{ employee_id: AINA, work_date: '2026-10-28', shift_type_id: MORNING }, { employee_id: AINA, work_date: '2026-10-29', shift_type_id: NIGHT }] }))
      .toBe("Set Aina Rahman's shifts for the week of 26 Oct?");
    expect(title('setShifts', { cells: [{ employee_id: AINA, work_date: '2026-10-28', shift_type_id: MORNING }, { employee_id: FAIZ, work_date: '2026-10-28', shift_type_id: null }] }))
      .toBe('Set shifts for Aina Rahman and Faiz Hakim for the week of 26 Oct?');
    expect(title('setShifts', { cells: [{ employee_id: FAIZ, work_date: '2026-10-28', shift_type_id: null }] })).toBe("Clear Faiz Hakim's shifts for the week of 26 Oct?");
    expect(title('logHours', { work_date: '2026-10-20', hours: 8 })).toBe('Log 8 hours for yourself on Tue, 20 Oct 2026?');
    expect(title('logHours', { employee_id: FAIZ, work_date: '2026-10-20', hours: 1 })).toBe('Log 1 hour for Faiz Hakim on Tue, 20 Oct 2026?');
    expect(title('logHours', { employee_id: FAIZ, work_date: '2026-10-20', hours: null })).toBe("Clear Faiz Hakim's hours on Tue, 20 Oct 2026?");
    expect(title('saveShiftType', { name: 'Evening', is_off: false, start_time: '18:00', end_time: '23:00', color: 'teal' })).toBe('Add shift type Evening · 18:00–23:00?');
    expect(title('saveShiftType', { id: MORNING, name: 'Morning', is_off: false, start_time: '8:00', end_time: '17:00', color: 'sky' }))
      .toBe('Change shift type Morning · 09:00–18:00 to Morning · 08:00–17:00?');
    expect(title('archiveShiftType', { id: NIGHT, archived: true })).toBe('Archive shift type Night · 21:00–06:00 (overnight)?');
    expect(title('requestShiftSwap', { my_shift_id: SHIFT_MINE, their_shift_id: SHIFT_FAIZ }))
      .toBe('Ask to swap your 27 Oct · Morning · 09:00–18:00 for Faiz Hakim · 27 Oct · Night · 21:00–06:00 (overnight)?');
    expect(title('decideShiftSwap', { id: SWAP_AGREED, approve: true })).toBe('Approve the shift swap between Aina Rahman and Faiz Hakim?');
    expect(title('replyShiftSwap', { id: SWAP_AGREED, accept: false })).toBe('Decline the shift swap between Aina Rahman and Faiz Hakim?');
    expect(title('cancelShiftSwap', { id: SWAP_AGREED })).toBe('Cancel the shift swap between Aina Rahman and Faiz Hakim?');
    expect(approvalDetail('decideShiftSwap', { id: SWAP_AGREED, approve: false, note: 'short staffed' }, undefined, find))
      .toBe("Aina Rahman's 27 Oct · Morning · 09:00–18:00 for Faiz Hakim's 28 Oct · Night · 21:00–06:00 (overnight) · Note: “short staffed”");
    expect(approvalDetail('logHours', { work_date: '2026-10-20', hours: 8, billable_hours: 6 })).toBe('Billable: 6 hours');
  });

  it('a row that no lookup named says so instead of naming a guess', () => {
    const find = nameIn([]);
    expect(approvalTitle('decideShiftSwap', { id: SWAP_AGREED, approve: true }, find)).toBe('Approve a shift swap that was not in the list above?');
    expect(approvalTitle('setShifts', { cells: [{ employee_id: AINA, work_date: '2026-10-28', shift_type_id: MORNING }] }, find))
      .toBe('Set the shifts of an employee not in the list above for the week of 26 Oct?');
  });

  it('every row names its person, day, type and hours from the lookups, and no row shows an id', async () => {
    const results = await lookups();
    const find = nameIn(results);
    const inputs: [string, unknown][] = [
      ['setShifts', { cells: [{ employee_id: AINA, work_date: '2026-10-28', shift_type_id: MORNING }, { employee_id: FAIZ, work_date: '2026-10-29', shift_type_id: null }] }],
      ['logHours', { employee_id: FAIZ, work_date: '2026-10-20', hours: 8, billable_hours: 6 }],
      ['saveShiftType', { id: MORNING, name: 'Morning', is_off: false, start_time: '8:00', end_time: '17:00', color: 'sky' }],
      ['archiveShiftType', { id: NIGHT, archived: true }],
      ['requestShiftSwap', { my_shift_id: SHIFT_MINE, their_shift_id: SHIFT_FAIZ, note: 'family day' }],
      ['replyShiftSwap', { id: SWAP_AGREED, accept: true }],
      ['decideShiftSwap', { id: SWAP_AGREED, approve: false, note: 'no' }],
      ['cancelShiftSwap', { id: SWAP_AGREED }],
    ];
    for (const [tool, input] of inputs) {
      const rows = changeRows(tool, input, find);
      for (const row of rows) expect(row.to, `${tool} ${row.key}`).not.toMatch(UUID);
      for (const row of rows) expect(row.to, `${tool} ${row.key}`).not.toMatch(/no name found/);
    }
    const shifts = changeRows('setShifts', inputs[0][1], find).map((r) => [r.label, r.to]);
    expect(shifts).toEqual([
      ['Cells 1 › Employee', 'Aina Rahman'],
      ['Cells 1 › Work date', 'Wed, 28 Oct 2026'],
      ['Cells 1 › Shift type', 'Morning · 09:00–18:00'],
      ['Cells 2 › Employee', 'Faiz Hakim'],
      ['Cells 2 › Work date', 'Thu, 29 Oct 2026'],
      ['Cells 2 › Shift type', 'No shift'],
    ]);
    expect(changeRows('logHours', inputs[1][1], find).map((r) => [r.label, r.to])).toEqual([
      ['Employee', 'Faiz Hakim'], ['Work date', 'Tue, 20 Oct 2026'], ['Hours', '8 hours'], ['Billable hours', '6 hours'],
    ]);
    expect(changeRows('requestShiftSwap', inputs[4][1], find).map((r) => [r.label, r.to])).toEqual([
      ['Your shift', '27 Oct · Morning · 09:00–18:00'],
      ["Colleague's shift", 'Faiz Hakim · 27 Oct · Night · 21:00–06:00 (overnight)'],
      ['Note', 'family day'],
    ]);
    expect(changeRows('replyShiftSwap', inputs[5][1], find).map((r) => [r.label, r.to])).toEqual([
      ['Shift swap', "Aina Rahman's 27 Oct · Morning · 09:00–18:00 for Faiz Hakim's 28 Oct · Night · 21:00–06:00 (overnight)"],
      ['Answer', 'Accept'],
    ]);
  });
});

describe('the id gate', () => {
  const resultMessage = (tool: string, value: unknown): ModelMessage =>
    ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `r-${tool}`, toolName: tool, output: { type: 'json', value } }] }) as ModelMessage;
  const conversation = async (): Promise<ModelMessage[]> => [
    { role: 'user', content: 'Put Aina on mornings next Wednesday' },
    ...(await lookups()).map((r) => resultMessage(r.tool, r.output)),
  ];
  const gate = (approval: Record<string, 'user-approval'>) => guardRosterWrites(approval)!;
  const ask = async (tool: string, input: unknown, messages: ModelMessage[]) => {
    const fn = gate({ [tool]: 'user-approval' })[tool] as (i: unknown, o: { toolCallId: string; messages: ModelMessage[] }) => Promise<unknown>;
    return fn(input, { toolCallId: 'c1', messages });
  };

  it('finds every id a change carries, nested cells included', () => {
    expect(rosterIds('setShifts', { cells: [{ employee_id: AINA, shift_type_id: MORNING }, { employee_id: FAIZ, shift_type_id: null }] })).toEqual([
      { kind: 'employee', id: AINA }, { kind: 'shift-type', id: MORNING }, { kind: 'employee', id: FAIZ },
    ]);
    expect(rosterIds('logHours', { work_date: '2026-10-20', hours: 8 })).toEqual([]);
    expect(rosterIds('saveShiftType', { id: '', name: 'X' })).toEqual([]);
    expect(rosterIds('requestShiftSwap', { my_shift_id: SHIFT_MINE, their_shift_id: SHIFT_FAIZ })).toEqual([
      { kind: 'shift', id: SHIFT_MINE }, { kind: 'shift', id: SHIFT_FAIZ },
    ]);
  });

  it('single agent: lets a change through when every id came from a lookup of its kind', async () => {
    const messages = await conversation();
    expect(await ask('setShifts', { cells: [{ employee_id: AINA, work_date: '2026-10-28', shift_type_id: MORNING }] }, messages)).toBe('user-approval');
    expect(await ask('requestShiftSwap', { my_shift_id: SHIFT_MINE, their_shift_id: SHIFT_FAIZ }, messages)).toBe('user-approval');
    expect(await ask('decideShiftSwap', { id: SWAP_AGREED, approve: true }, messages)).toBe('user-approval');
    expect(await ask('logHours', { work_date: '2026-10-20', hours: 8 }, messages)).toBe('user-approval');
    expect(await ask('saveShiftType', { name: 'Evening', is_off: true, color: 'teal' }, messages)).toBe('user-approval');
  });

  it('single agent: denies, before a card, an id nobody looked up or one seen only as another kind', async () => {
    const messages = await conversation();
    const invented = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
    const made = await ask('setShifts', { cells: [{ employee_id: AINA, work_date: '2026-10-28', shift_type_id: invented }] }, messages);
    expect(made).toEqual({ type: 'denied', reason: expect.stringMatching(/^You have not looked up abcdefab-.* as a shift type\. .*listShiftTypes/) });
    // A shift type's id is not an employee's: listShiftTypes is not where people come from.
    const wrongKind = await ask('logHours', { employee_id: MORNING, work_date: '2026-10-20', hours: 8 }, messages);
    expect(wrongKind).toMatchObject({ type: 'denied' });
    // An employee's id is not a swap's.
    expect(await ask('cancelShiftSwap', { id: AINA }, messages)).toMatchObject({ type: 'denied' });
    // With no lookups at all, nothing passes.
    expect(await ask('decideShiftSwap', { id: SWAP_AGREED, approve: true }, [{ role: 'user', content: 'approve it' }])).toMatchObject({ type: 'denied' });
    // The person reads a sentence written for them, not the model's.
    expect(refusalForUser((made as { reason: string }).reason)).toMatch(/had not looked this record up/);
  });

  it('single agent: leaves every other tool, and an earlier gate\'s refusal, as they were', async () => {
    const denied = { type: 'denied' as const, reason: 'earlier' };
    const guarded = guardRosterWrites({ decideLeave: 'user-approval', setShifts: () => denied })!;
    expect(guarded.decideLeave).toBe('user-approval');
    const messages = await conversation();
    const fn = guarded.setShifts as (i: unknown, o: unknown) => Promise<unknown>;
    expect(await fn({ cells: [{ employee_id: AINA, work_date: '2026-10-28', shift_type_id: MORNING }] }, { toolCallId: 'c', messages })).toEqual(denied);
  });

  it('team mode: an id must be one this specialist or an earlier turn looked up as its kind', async () => {
    const results = await lookups();
    const find = nameIn(results);
    const ok = { cells: [{ employee_id: AINA, work_date: '2026-10-28', shift_type_id: MORNING }] };
    expect(rosterIdProblem('setShifts', ok, find, {})).toBeNull();
    // Known only from an earlier turn's names.
    expect(rosterIdProblem('decideShiftSwap', { id: SWAP_AGREED, approve: true }, nameIn([]), { [`swap:${SWAP_AGREED}`]: '{}' })).toBeNull();
    expect(rosterIdProblem('setShifts', { cells: [{ employee_id: MORNING, work_date: '2026-10-28', shift_type_id: MORNING }] }, find, {}))
      .toMatch(/^You have not looked up 44444444-.* as an employee/);
    expect(rosterIdProblem('requestShiftSwap', { my_shift_id: SHIFT_MINE, their_shift_id: SWAP_AGREED }, find, {})).toMatch(/as a shift that can be swapped/);
  });
});
