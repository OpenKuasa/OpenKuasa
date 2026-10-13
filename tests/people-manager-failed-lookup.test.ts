import { describe, expect, it, vi } from 'vitest';
import { createPeopleTools } from '@/lib/ai/people-tools';
import { todayInMalaysia } from '@/lib/people/dates';
import { createSeedPeopleData } from '@/lib/people/seed';
import { DEMO_EMPLOYEE_ID, type PeopleData, type PeopleViewer } from '@/lib/people/types';
import { asManager } from './setup/people-manager-view';
import { asMember } from './setup/people-member-view';

const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = todayInMalaysia(NOW);
const MANAGER = 'seed-emp-12';
const TEAM = [DEMO_EMPLOYEE_ID, 'seed-emp-5', 'seed-emp-10', 'seed-emp-11', 'seed-emp-13'];
const seed = createSeedPeopleData(NOW);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const execute = async (tools: ReturnType<typeof createPeopleTools>, name: string, input: Record<string, unknown> = {}): Promise<Loose> =>
  (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 't', messages: [] });

describe('a failed team lookup never makes a report\'s rows "yours"', () => {
  // The viewer is a manager whose `hr_my_team` read failed: `managesTeam` is unset, so they are treated as a member.
  // The data source nevertheless hands back their reports' rows, as the database does for a manager.
  const viewer: PeopleViewer = { employeeId: MANAGER, isHr: false, isDemo: false };
  const base = asManager(seed, MANAGER, TEAM);
  const leaky: PeopleData = {
    ...base,
    // A report approved on leave today, so the who-is-on-leave answer has something to leak.
    listLeaveRequests: async () => {
      const [first] = await seed.listLeaveRequests();
      const away = { ...first, id: 'away-report', employee_id: TEAM[1], employee_name: 'A Report', status: 'approved' as const, start_date: TODAY, end_date: TODAY };
      return [away, ...(await base.listLeaveRequests())];
    },
    // The overtime table is closed to a manager; this simulates a source that leaks anyway.
    listOvertime: async () => seed.listOvertime(),
  };
  const honest = asMember(seed, MANAGER);
  const names = [
    'getPeopleOverview',
    'listWhoIsOnLeave',
    'listLeaveRequests',
    'listTimeOffRequests',
    'getLeaveBalances',
    'listPendingApprovals',
    'listClaims',
    'listOvertime',
    'getAttendanceSummary',
  ];

  it.each(names)('%s answers over their own rows only, exactly as for a member', async (name) => {
    const input = name === 'listWhoIsOnLeave' ? { date: TODAY } : {};
    const fromLeaky = await execute(createPeopleTools(leaky, viewer, NOW), name, input);
    const fromHonest = await execute(createPeopleTools(honest, viewer, NOW), name, input);
    expect(fromLeaky).toEqual(fromHonest);
    expect(fromLeaky.scope).toBe('your own records only');
  });

  it('the data really would have leaked (the leaky source holds rows that are not theirs)', async () => {
    const leave = await leaky.listLeaveRequests();
    expect(leave.some((r) => r.employee_id !== MANAGER)).toBe(true);
    expect((await honest.listLeaveRequests()).every((r) => r.employee_id === MANAGER)).toBe(true);
  });
});

describe('getPeopleOverview description', () => {
  it('says what waiting_unknown means', () => {
    const tools = createPeopleTools(seed, { employeeId: MANAGER, isHr: false, isDemo: false, managesTeam: true }, NOW);
    const description = (tools.getPeopleOverview as unknown as { description: string }).description;
    expect(description).toMatch(/waiting_unknown: true.*could not be read/);
  });
});

describe('"away today" counts active reports only', () => {
  it('leaves an inactive report on approved leave today out of team.on_leave_today', async () => {
    const viewer: PeopleViewer = { employeeId: MANAGER, employeeName: 'Farid Ismail', isHr: false, isDemo: false, managesTeam: true };
    const base = asManager(seed, MANAGER, TEAM);
    const [leave] = await seed.listLeaveRequests();
    const employees = (await seed.listEmployees()).map((e) => (e.id === TEAM[1] ? { ...e, status: 'inactive' as const } : e));
    const away = (id: string, who: string) => ({
      ...leave, id: `away-${id}`, employee_id: id, employee_name: who, status: 'approved' as const, start_date: TODAY, end_date: TODAY,
    });
    const data: PeopleData = {
      ...base,
      listEmployees: async () => employees,
      listLeaveRequests: async () => [away(TEAM[0], 'Active Report'), away(TEAM[1], 'Inactive Report')],
    };
    const write = {
      ctx: { client: { rpc: vi.fn(async () => ({ data: { leave: 0, time_off: 0, claims: 0, overtime: 0 }, error: null })) } as never, orgId: 'org-1' },
      tier: 'manager' as const, employeeId: MANAGER, receipt: null, userId: 'u1',
    };
    const result = await execute(createPeopleTools(data, viewer, NOW, write), 'getPeopleOverview');
    expect(result.team.members).toBe(4);
    expect(result.team.on_leave_today).toBe(1);
  });
});
