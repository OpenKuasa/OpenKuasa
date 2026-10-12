import { describe, expect, it, vi } from 'vitest';
import { createPeopleTools } from '@/lib/ai/people-tools';
import { todayInMalaysia } from '@/lib/people/dates';
import { createSeedPeopleData } from '@/lib/people/seed';
import { DEMO_EMPLOYEE_ID, type PeopleViewer } from '@/lib/people/types';
import { asManager } from './setup/people-manager-view';
import { asMember } from './setup/people-member-view';

const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = todayInMalaysia(NOW);
const MANAGER = 'seed-emp-12';
const TEAM = [DEMO_EMPLOYEE_ID, 'seed-emp-5', 'seed-emp-10', 'seed-emp-11', 'seed-emp-13'];
const VIEWER: PeopleViewer = { employeeId: MANAGER, employeeName: 'Farid Ismail', isHr: false, isDemo: false, managesTeam: true };
const MEMBER_VIEWER: PeopleViewer = { employeeId: MANAGER, isHr: false, isDemo: false };
const seed = createSeedPeopleData(NOW);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** A fake database client: only the two functions a manager's tools call. */
function fakeClient(overtime: unknown[] = [], counts: unknown = { leave: 2, time_off: 1, claims: 3, overtime: 4 }, fail = false) {
  const rpc = vi.fn(async (name: string) => {
    if (fail) return { data: null, error: { code: 'X' } };
    return { data: name === 'hr_team_overtime' ? overtime : counts, error: null };
  });
  return { rpc };
}

const run = async (
  name: string,
  input: Record<string, unknown> = {},
  opts: { tier?: 'manager' | 'self'; client?: ReturnType<typeof fakeClient>; viewer?: PeopleViewer } = {},
): Promise<Loose> => {
  const tier = opts.tier ?? 'manager';
  const viewer = opts.viewer ?? (tier === 'manager' ? VIEWER : MEMBER_VIEWER);
  const data = tier === 'manager' ? asManager(seed, MANAGER, TEAM) : asMember(seed, MANAGER);
  const write = { ctx: { client: (opts.client ?? fakeClient()) as never, orgId: 'org-1' }, tier, employeeId: MANAGER, receipt: null, userId: 'u1' };
  const tools = createPeopleTools(data, viewer, NOW, write);
  return (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 't', messages: [] });
};

const teamOvertime = (id: string, employee: string, status = 'pending') => ({
  id, org_id: 'org-1', employee_id: employee, work_date: '2026-10-07', hours: 2, day_kind: 'weekday', rate_multiplier: 1.5,
  reason: 'Stock count', status, requested_by: null, decided_by: null, decided_at: null, decision_note: null,
  created_at: '2026-10-07T10:00:00Z',
  // A function that holds no pay never sends these; a row that carried them anyway must not show them.
  hourly_rate_cents: 9999, amount_cents: 99999,
});

describe("a manager's lookups say whose rows they are", () => {
  it.each(['listLeaveRequests', 'listTimeOffRequests', 'listClaims'])('%s: the team, with names, and yours true or false', async (name) => {
    const result = await run(name);
    const rows = (result.requests ?? result.claims) as { employee: string; yours: boolean; id?: string; status: string }[];
    expect(result.scope).toBe('your own records and those of the people who report to you');
    // The sample has no time-off of the manager's own; the other two lists hold some.
    if (name !== 'listTimeOffRequests') expect(rows.some((r) => r.yours)).toBe(true);
    expect(rows.some((r) => !r.yours)).toBe(true);
    expect(rows.every((r) => typeof r.yours === 'boolean')).toBe(true);
    for (const r of rows) {
      expect(typeof r.employee).toBe('string');
      // A report's request carries an id only while it is pending (it can be decided, not cancelled).
      if (!r.yours && r.status !== 'pending') expect(r.id).toBeUndefined();
    }
    expect(rows.filter((r) => !r.yours && r.status === 'pending').every((r) => typeof r.id === 'string')).toBe(true);
  });

  it('the member tier is unchanged: own scope, no yours flag', async () => {
    const result = await run('listLeaveRequests', {}, { tier: 'self' });
    expect(result.scope).toBe('your own records only');
    expect(result.requests.every((r: Loose) => !('yours' in r))).toBe(true);
  });

  it('listOvertime comes from the pay-free function for the team, and holds no money for a report', async () => {
    const reports = TEAM.slice(0, 2);
    const client = fakeClient([teamOvertime('ot-1', reports[0]), teamOvertime('ot-2', reports[1], 'approved')]);
    const result = await run('listOvertime', {}, { client });
    expect(client.rpc).toHaveBeenCalledWith('hr_team_overtime', { p_org: 'org-1' });
    const theirs = result.overtime.filter((o: Loose) => o.yours === false);
    expect(theirs).toHaveLength(2);
    for (const o of theirs) {
      for (const key of ['amount', 'amount_calculated', 'hourly_rate', 'paid_month']) expect(o, key).not.toHaveProperty(key);
      expect(typeof o.employee).toBe('string');
    }
    expect(theirs.find((o: Loose) => o.status === 'pending').id).toBe('ot-1');
    expect(theirs.find((o: Loose) => o.status === 'approved').id).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('9999');
    // Their own rows are the table's, with their own figures where they exist, and say they are theirs.
    expect(result.overtime.filter((o: Loose) => o.yours === true).every((o: Loose) => !theirs.includes(o))).toBe(true);
  });

  it('a manager never gets a row for someone who is not their report from the overtime function', async () => {
    const client = fakeClient([teamOvertime('ot-9', 'seed-emp-2')]);
    const result = await run('listOvertime', {}, { client });
    expect(result.overtime.some((o: Loose) => o.id === 'ot-9')).toBe(false);
  });

  it('listOvertime fails plainly when the function fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await run('listOvertime', {}, { client: fakeClient([], {}, true) });
    expect(result).toEqual({ ok: false, error: 'Could not read HR data.' });
    log.mockRestore();
  });

  it('getLeaveBalances and getAttendanceSummary separate the manager from the team', async () => {
    const balances = await run('getLeaveBalances');
    expect(balances.scope).toContain('report to you');
    expect(balances.balances.every((b: Loose) => typeof b.yours === 'boolean')).toBe(true);
    expect(balances.balances.some((b: Loose) => b.yours === false)).toBe(true);
    const attendance = await run('getAttendanceSummary', { days: 31 });
    expect(attendance).toHaveProperty('your_own');
    expect(attendance).toHaveProperty('your_team');
    expect(attendance.late_most_often.every((l: Loose) => typeof l.yours === 'boolean')).toBe(true);
    expect(attendance.flagged_days.every((d: Loose) => typeof d.yours === 'boolean')).toBe(true);
  });

  it('listPendingApprovals marks each row yours or not', async () => {
    const client = fakeClient([teamOvertime('ot-1', TEAM[0])]);
    const result = await run('listPendingApprovals', {}, { client });
    expect(result.approvals.every((a: Loose) => typeof a.yours === 'boolean')).toBe(true);
    expect(result.approvals.some((a: Loose) => a.yours === false)).toBe(true);
  });

  it('getPeopleOverview counts the manager\'s own pending requests, and the team apart', async () => {
    const result = await run('getPeopleOverview');
    const member = await run('getPeopleOverview', {}, { tier: 'self' });
    expect(result.your_pending_requests).toEqual(member.your_pending_requests);
    expect(result.team.members).toBe(5);
    expect(result.team.waiting_for_you).toBe(10);
    expect(member).not.toHaveProperty('team');
  });

  it('listWhoIsOnLeave says it covers the team, and the member tier says own only', async () => {
    const manager = await run('listWhoIsOnLeave', { date: TODAY });
    expect(manager.scope).toContain('report to you');
    const member = await run('listWhoIsOnLeave', { date: TODAY }, { tier: 'self' });
    expect(member.scope).toBe('your own records only');
  });

  it.each(['listPayslips', 'listReviews', 'listDocuments', 'listLetters', 'listGoals'])('%s stays your own records only', async (name) => {
    const result = await run(name);
    expect(result.scope).toBe('your own records only');
  });
});

describe('listMyTeam', () => {
  it('lists the five direct reports and who is away today, and no report of a report', async () => {
    const result = await run('listMyTeam');
    expect(result.total).toBe(5);
    expect(result.manager).toBe('Farid Ismail');
    expect(result.team).toHaveLength(5);
    const away = new Set(
      (await asManager(seed, MANAGER, TEAM).listLeaveRequests())
        .filter((r) => r.status === 'approved' && r.start_date <= TODAY && r.end_date >= TODAY)
        .map((r) => r.employee_id),
    );
    for (const m of result.team) expect(m.on_leave_today).toBe(away.has(m.id));
  });

  it('does not include someone who reports to a report', async () => {
    const people = await seed.listEmployees();
    const data = {
      ...asManager(seed, MANAGER, TEAM),
      listEmployees: async () => people.map((e) => (e.id === 'seed-emp-1' ? { ...e, reports_to: 'seed-emp-5' } : e)),
    };
    const write = { ctx: { client: fakeClient() as never, orgId: 'org-1' }, tier: 'manager' as const, employeeId: MANAGER, receipt: null, userId: 'u1' };
    const tools = createPeopleTools(data, VIEWER, NOW, write);
    const result = (await (tools.listMyTeam as Loose).execute({}, {})) as Loose;
    expect(result.total).toBe(5);
    expect(result.team.some((m: Loose) => m.id === 'seed-emp-1')).toBe(false);
  });
});

describe('getWaitingForMe', () => {
  it('asks the database once for the four figures and adds them up', async () => {
    const client = fakeClient();
    const result = await run('getWaitingForMe', {}, { client });
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('hr_waiting_counts', { p_org: 'org-1' });
    expect(result).toEqual({ leave: 2, time_off: 1, claims: 3, overtime: 4, total: 10 });
  });
  it('answers zeros when the database fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await run('getWaitingForMe', {}, { client: fakeClient([], {}, true) });
    expect(result).toEqual({ leave: 0, time_off: 0, claims: 0, overtime: 0, total: 0 });
    log.mockRestore();
  });
});

describe('who someone reports to', () => {
  it('getEmployee names the manager for a member, with no id', async () => {
    const result = await run('getEmployee', { employee: 'seed-none' }, { tier: 'self' });
    expect(result.found).toBe(false);
    const people = await seed.listEmployees();
    const report = people.find((e) => e.reports_to === MANAGER)!;
    const found = await run('getEmployee', { employee: report.name }, { tier: 'self' });
    expect(found.employee.reports_to).toBe('Farid Ismail');
    expect(found.employee).not.toHaveProperty('reports_to_id');
    expect(found.employee).not.toHaveProperty('is_manager');
  });
});
