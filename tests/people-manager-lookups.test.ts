import { describe, expect, it, vi } from 'vitest';
import { createPeopleTools } from '@/lib/ai/people-tools';
import { todayInMalaysia } from '@/lib/people/dates';
import { approvalCounts, pendingApprovals } from '@/lib/people/overview';
import { createSeedPeopleData } from '@/lib/people/seed';
import { DEMO_EMPLOYEE_ID, type OvertimeRecord, type PeopleData, type PeopleViewer } from '@/lib/people/types';
import { asManager } from './setup/people-manager-view';
import { asMember } from './setup/people-member-view';

const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = todayInMalaysia(NOW);
const MANAGER = 'seed-emp-12';
const TEAM = [DEMO_EMPLOYEE_ID, 'seed-emp-5', 'seed-emp-10', 'seed-emp-11', 'seed-emp-13'];
const VIEWER: PeopleViewer = { employeeId: MANAGER, employeeName: 'Farid Ismail', isHr: false, isDemo: false, managesTeam: true };
const MEMBER_VIEWER: PeopleViewer = { employeeId: MANAGER, isHr: false, isDemo: false };
const HR_VIEWER: PeopleViewer = { employeeId: MANAGER, employeeName: 'Farid Ismail', isHr: true, isDemo: false };
const MANAGER_NAME = 'Farid Ismail';
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
  opts: {
    tier?: 'manager' | 'self' | 'hr';
    client?: ReturnType<typeof fakeClient>;
    viewer?: PeopleViewer;
    data?: PeopleData;
    noWrite?: boolean;
  } = {},
): Promise<Loose> => {
  const tier = opts.tier ?? 'manager';
  const viewer = opts.viewer ?? (tier === 'manager' ? VIEWER : tier === 'hr' ? HR_VIEWER : MEMBER_VIEWER);
  const data = opts.data ?? (tier === 'manager' ? asManager(seed, MANAGER, TEAM) : tier === 'hr' ? seed : asMember(seed, MANAGER));
  const write = opts.noWrite
    ? undefined
    : { ctx: { client: (opts.client ?? fakeClient()) as never, orgId: 'org-1' }, tier, employeeId: MANAGER, receipt: null, userId: 'u1' };
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

/** The manager's data with a pending leave, a pending claim and an approved leave covering today of the manager's own, and one of a report. */
async function withOwnRequests(): Promise<PeopleData> {
  const base = asManager(seed, MANAGER, TEAM);
  const [leave] = await seed.listLeaveRequests();
  const [claim] = await seed.listClaims();
  const mine = { ...leave, id: 'lv-mine', employee_id: MANAGER, employee_name: MANAGER_NAME, status: 'pending' as const };
  const awayMine = { ...leave, id: 'lv-away-mine', employee_id: MANAGER, employee_name: MANAGER_NAME, status: 'approved' as const, start_date: TODAY, end_date: TODAY };
  const awayTeam = { ...leave, id: 'lv-away-team', employee_id: TEAM[1], employee_name: 'A Report', status: 'approved' as const, start_date: TODAY, end_date: TODAY };
  const ownClaim = { ...claim, id: 'cl-mine', employee_id: MANAGER, employee_name: MANAGER_NAME, status: 'pending' as const };
  return {
    ...base,
    listLeaveRequests: async () => [mine, awayMine, awayTeam, ...(await base.listLeaveRequests())],
    listClaims: async () => [ownClaim, ...(await base.listClaims())],
  };
}

describe("a manager's lookups say whose rows they are", () => {
  it.each(['listLeaveRequests', 'listTimeOffRequests', 'listClaims'])('%s: the team, with names, and yours true or false', async (name) => {
    const result = await run(name);
    const rows = (result.requests ?? result.claims) as { employee: string; yours: boolean; id?: string; status: string }[];
    expect(result.scope).toBe('your own records and those of the people who report to you');
    // The sample has no time-off of the manager's own; the other two lists hold some.
    if (name !== 'listTimeOffRequests') expect(rows.some((r) => r.yours)).toBe(true);
    expect(rows.some((r) => !r.yours)).toBe(true);
    // The flag is told against the actual owner of every row.
    expect(rows.every((r) => r.yours === (r.employee === MANAGER_NAME))).toBe(true);
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

  it("a manager's own rows carry no over_balance or approved_this_year; only pending team claims carry the year total", async () => {
    const data = await withOwnRequests();
    const leave = (await run('listLeaveRequests', {}, { data })).requests as Loose[];
    expect(leave.some((r) => r.yours)).toBe(true);
    for (const r of leave.filter((x) => x.yours)) expect(r).not.toHaveProperty('over_balance');
    for (const r of leave.filter((x) => !x.yours)) expect(r).toHaveProperty('over_balance');
    const claims = (await run('listClaims', {}, { data })).claims as Loose[];
    expect(claims.some((c) => c.yours)).toBe(true);
    for (const c of claims.filter((x) => x.yours)) expect(c).not.toHaveProperty('approved_this_year');
    for (const c of claims.filter((x) => !x.yours && x.status !== 'pending')) expect(c).not.toHaveProperty('approved_this_year');
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
    expect(result.overtime.every((o: Loose) => o.yours === (o.employee === MANAGER_NAME))).toBe(true);
  });

  it('a manager\'s own overtime row keeps its figures, a report\'s has none', async () => {
    const sample = (await seed.listOvertime())[0];
    const mine: OvertimeRecord = {
      ...sample, id: 'ot-mine', employee_id: MANAGER, employee_name: MANAGER_NAME, status: 'pending',
      amount_cents: 4500, hourly_rate_cents: 3000, created_at: '2026-10-08T10:00:00Z',
    };
    const base = asManager(seed, MANAGER, TEAM);
    const data: PeopleData = { ...base, listOvertime: async () => [mine] };
    const result = await run('listOvertime', {}, { data, client: fakeClient([teamOvertime('ot-1', TEAM[0])]) });
    const own = result.overtime.find((o: Loose) => o.id === 'ot-mine');
    expect(own.yours).toBe(true);
    expect(own).toHaveProperty('amount');
    const report = result.overtime.find((o: Loose) => o.id === 'ot-1');
    expect(report.yours).toBe(false);
    expect(report).not.toHaveProperty('amount');
  });

  it('splits every total into the manager\'s own and the team\'s, and the two add up to the whole', async () => {
    const claims = await run('listClaims');
    const money = (s: string) => Number(s.replace(/[^0-9.]/g, ''));
    expect(claims.your_own.total).toBeGreaterThan(0);
    expect(claims.your_team.total).toBeGreaterThan(0);
    expect(claims.your_own.total + claims.your_team.total).toBe(claims.total);
    expect(money(claims.your_own.total_amount) + money(claims.your_team.total_amount)).toBeCloseTo(money(claims.total_amount), 2);
    expect(money(claims.your_own.approved_or_paid_total) + money(claims.your_team.approved_or_paid_total)).toBeCloseTo(
      money(claims.approved_or_paid_total), 2,
    );
    expect(claims.your_own.total_amount).not.toBe(claims.total_amount);
    const leave = await run('listLeaveRequests');
    expect(leave.your_own.total + leave.your_team.total).toBe(leave.total);
    expect(leave.your_own.total).not.toBe(leave.total);
    const timeOff = await run('listTimeOffRequests');
    expect(timeOff.your_own.total + timeOff.your_team.total).toBe(timeOff.total);
    const client = fakeClient([teamOvertime('ot-1', TEAM[0]), teamOvertime('ot-2', TEAM[1])]);
    const overtime = await run('listOvertime', {}, { client });
    expect(overtime.your_team.total).toBe(2);
    expect(overtime.your_team.total_hours).toBe(4);
    expect(overtime.your_own.total + overtime.your_team.total).toBe(overtime.total);
    expect(overtime.your_own.total_hours + overtime.your_team.total_hours).toBe(overtime.total_hours);
  });

  it('keeps the member and owner totals as they were, with no split', async () => {
    for (const tier of ['self', 'hr'] as const) {
      for (const name of ['listClaims', 'listLeaveRequests', 'listTimeOffRequests', 'listOvertime']) {
        const result = await run(name, {}, { tier });
        expect(result, `${tier} ${name}`).not.toHaveProperty('your_own');
        expect(result, `${tier} ${name}`).not.toHaveProperty('your_team');
      }
    }
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
    expect(balances.balances.length).toBeGreaterThan(0);
    expect(balances.balances.some((b: Loose) => b.yours === false)).toBe(true);
    expect(balances.balances.every((b: Loose) => b.yours === (b.employee === MANAGER_NAME))).toBe(true);
    const attendance = await run('getAttendanceSummary', { days: 31 });
    expect(attendance).toHaveProperty('your_own');
    expect(attendance).toHaveProperty('your_team');
    expect(attendance.late_most_often.every((l: Loose) => l.yours === (l.employee === MANAGER_NAME))).toBe(true);
    expect(attendance.flagged_days.every((d: Loose) => d.yours === (d.employee === MANAGER_NAME))).toBe(true);
  });

  it('listPendingApprovals marks each row against its owner, and splits waiting for you from your own', async () => {
    const client = fakeClient([teamOvertime('ot-1', TEAM[0])]);
    const result = await run('listPendingApprovals', {}, { client, data: await withOwnRequests() });
    expect(result.approvals.every((a: Loose) => a.yours === (a.employee === MANAGER_NAME))).toBe(true);
    expect(result.approvals.some((a: Loose) => a.yours === false)).toBe(true);
    expect(result.your_own_requests.total).toBeGreaterThan(0);
    expect(result.waiting_for_you.total).toBeGreaterThan(0);
    expect(result.waiting_for_you.total + result.your_own_requests.total).toBe(result.counts.total);
    expect(result.waiting_for_you.total).not.toBe(result.counts.total);
  });

  it('getPeopleOverview counts the manager\'s own pending requests, and the team apart', async () => {
    const result = await run('getPeopleOverview');
    const member = await run('getPeopleOverview', {}, { tier: 'self' });
    expect(result.your_pending_requests).toEqual(member.your_pending_requests);
    // The narrowing is real: over the unnarrowed lists the counts would be different.
    const wide = approvalCounts(
      pendingApprovals(
        await asManager(seed, MANAGER, TEAM).listLeaveRequests(),
        await asManager(seed, MANAGER, TEAM).listClaims(),
        await asManager(seed, MANAGER, TEAM).listOvertime(),
        await asManager(seed, MANAGER, TEAM).listTimeOffRequests(),
      ),
    );
    expect(wide).not.toEqual(member.your_pending_requests);
    expect(result.team.members).toBe(5);
    const away = (await asManager(seed, MANAGER, TEAM).listLeaveRequests()).filter(
      (r) => TEAM.includes(r.employee_id) && r.status === 'approved' && r.start_date <= TODAY && r.end_date >= TODAY,
    );
    expect(result.team.on_leave_today).toBe(away.length);
    expect(result.team.waiting_for_you).toBe(10);
    expect(member).not.toHaveProperty('team');
  });

  it('getPeopleOverview does not turn a failed or missing count into zero', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await run('getPeopleOverview', {}, { client: fakeClient([], {}, true) });
    expect(failed.team).not.toHaveProperty('waiting_for_you');
    expect(failed.team.waiting_unknown).toBe(true);
    const none = await run('getPeopleOverview', {}, { noWrite: true });
    expect(none.team).not.toHaveProperty('waiting_for_you');
    expect(none.team.waiting_unknown).toBe(true);
    log.mockRestore();
  });

  it('listWhoIsOnLeave says it covers the team, flags every row, and the member tier says own only', async () => {
    const manager = await run('listWhoIsOnLeave', { date: TODAY }, { data: await withOwnRequests() });
    expect(manager.people.some((p: Loose) => p.yours === true)).toBe(true);
    expect(manager.people.some((p: Loose) => p.yours === false)).toBe(true);
    expect(manager.people.every((p: Loose) => p.yours === (p.name === MANAGER_NAME))).toBe(true);
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
    expect(result.active).toBe(5);
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
  it('says it could not read, and never answers zeros, when the database fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await run('getWaitingForMe', {}, { client: fakeClient([], {}, true) });
    expect(result).toEqual({ ok: false, error: 'Could not read HR data.' });
    log.mockRestore();
  });
});

describe('the directory and the manager\'s schemas', () => {
  it('listEmployees for an owner carries reports_to and reports_to_id, and no is_manager', async () => {
    const result = await run('listEmployees', {}, { tier: 'hr' });
    const people = await seed.listEmployees();
    const row = result.employees.find((e: Loose) => e.id === TEAM[1]);
    expect(row.reports_to).toBe('Farid Ismail');
    expect(row.reports_to_id).toBe(MANAGER);
    expect(people.length).toBeGreaterThan(0);
    for (const e of result.employees) expect(e).not.toHaveProperty('is_manager');
  });

  it('a manager\'s apply and submit schemas have no employee field', () => {
    const write = { ctx: { client: fakeClient() as never, orgId: 'org-1' }, tier: 'manager' as const, employeeId: MANAGER, receipt: null, userId: 'u1' };
    const tools = createPeopleTools(asManager(seed, MANAGER, TEAM), VIEWER, NOW, write);
    for (const name of ['applyLeave', 'applyTimeOff', 'submitClaim', 'submitOvertime', 'previewLeave', 'previewOvertime']) {
      const shape = (tools[name] as unknown as { inputSchema: { shape: Record<string, unknown> } }).inputSchema.shape;
      expect(Object.keys(shape), name).not.toContain('employee_id');
    }
  });

  it('a manager\'s own pending request carries its id, so they can cancel it', async () => {
    const leave = await run('listLeaveRequests', { status: 'pending' }, { data: await withOwnRequests() });
    const own = leave.requests.filter((r: Loose) => r.yours);
    expect(own.length).toBeGreaterThan(0);
    for (const r of own) expect(typeof r.id).toBe('string');
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
