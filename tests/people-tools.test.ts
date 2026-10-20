import { describe, expect, it, vi } from 'vitest';
import { PEOPLE_TOOL_NAMES, createPeopleTools } from '@/lib/ai/people-tools';
import { HIRE_TOOL_NAMES } from '@/lib/ai/hire-tools';
import { CRM_WRITE_TOOL_NAMES } from '@/lib/ai/crm-tools';
import { REACH_WRITE_TOOL_NAMES } from '@/lib/ai/products';
import { createReachTools } from '@/lib/ai/tools';
import { toolMeta } from '@/components/chat/tool-parts';
import { buildPeopleOverviewModel } from '@/lib/people/overview';
import { createSeedPeopleData } from '@/lib/people/seed';
import { asMember } from './setup/people-member-view';
import { createSeedReachData } from '@/lib/reach/seed';
import { rm } from '@/lib/reach/format';
import { DEFAULT_PEOPLE_SETTINGS, type PeopleData, type PeopleViewer } from '@/lib/people/types';

// A Friday in Kuala Lumpur.
const NOW = new Date('2026-10-09T04:00:00Z');
const HR: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const MEMBER: PeopleViewer = { employeeId: 'seed-emp-2', isHr: false, isDemo: false };
const data = createSeedPeopleData(NOW);

// The tool results are untyped JSON; the tests read them loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const runner = (source: PeopleData, viewer: PeopleViewer = HR, now: Date = NOW) => {
  const tools = createPeopleTools(source, viewer, now);
  return (name: string) => (input: Record<string, unknown>): Promise<Loose> =>
    (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
      toolCallId: 't', messages: [],
    });
};
const run = runner(data);

const EMPTY: PeopleData = {
  listDepartments: async () => [], listEmployees: async () => [], getEmployeePrivate: async () => null,
  listLeaveRequests: async () => [], listLeaveBalances: async () => [], listTimeOffRequests: async () => [],
  listClaims: async () => [], listOvertime: async () => [], listAttendance: async () => [],
  listTimesheet: async () => [], listShifts: async () => [], listPublicHolidays: async () => [],
  listPayrollRuns: async () => [], listPayslips: async () => [], listGoals: async () => [],
  listReviews: async () => [], listTrainings: async () => [],
  listTrainingEnrolments: async () => [], listAnnouncements: async () => [],
  listDocuments: async () => [], listLetters: async () => [], listLetterTemplates: async () => [], listPaymentVouchers: async () => [],
  getSettings: async () => structuredClone(DEFAULT_PEOPLE_SETTINGS),
};

describe('people tools', () => {
  it('is exactly the twenty-five lookups, none sharing a name with another product', () => {
    expect(Object.keys(createPeopleTools(data, HR, NOW))).toEqual([...PEOPLE_TOOL_NAMES]);
    expect(PEOPLE_TOOL_NAMES).toEqual([
      'getPeopleOverview', 'listEmployees', 'getEmployee', 'listDepartments', 'getHeadcountByDepartment',
      'listWhoIsOnLeave', 'listLeaveRequests', 'listTimeOffRequests', 'getLeaveBalances', 'listPendingApprovals', 'listClaims',
      'listOvertime', 'getAttendanceSummary', 'getTimesheet', 'listShifts', 'listPublicHolidays',
      'getPayrollSummary', 'listPayslips', 'getPerformanceSummary', 'listGoals', 'listReviews', 'listTrainings', 'listAnnouncements',
      'listDocuments', 'listLetters',
    ]);
    const others = new Set<string>([
      ...Object.keys(createReachTools(createSeedReachData())),
      ...REACH_WRITE_TOOL_NAMES,
      ...CRM_WRITE_TOOL_NAMES,
      ...HIRE_TOOL_NAMES,
      'listCrmContacts', 'listDeals', 'listPipelines', 'getDealStats', 'listFollowUps', 'getCalendar',
      'getBillingSummary', 'listBillingInvoices',
    ]);
    for (const name of PEOPLE_TOOL_NAMES) expect(others.has(name), name).toBe(false);
  });

  it('has a named card for every tool', () => {
    for (const name of PEOPLE_TOOL_NAMES) expect(toolMeta(name).isFallback, name).toBe(false);
  });

  it('never lets the model choose the workspace', () => {
    const tools = createPeopleTools(data, HR, NOW);
    for (const name of PEOPLE_TOOL_NAMES) {
      const shape = (tools[name] as unknown as { inputSchema: { shape: Record<string, unknown> } }).inputSchema.shape;
      for (const key of Object.keys(shape)) expect(key.toLowerCase(), `${name}.${key}`).not.toMatch(/org|workspace/);
    }
  });

  it('gives the same overview totals as the screen', async () => {
    const model = await buildPeopleOverviewModel(data, NOW);
    const overview = await run('getPeopleOverview')({});
    expect(overview).toMatchObject({
      date: '2026-10-09', headcount: 20, departments: 5, on_leave_today: 3, clocked_in_so_far: 17,
      pending_approvals: { leave: 3, claims: 2, overtime: 1, time_off: 0, total: 6 },
    });
    expect(overview.headcount).toBe(model.totals.headcount);
  });

  it('lists the directory, filtered and capped, without private details', async () => {
    const all = await run('listEmployees')({});
    expect(all.total).toBe(20);
    expect(all.employees).toHaveLength(20);
    expect((await run('listEmployees')({ department: 'sales' })).total).toBe(6);
    expect((await run('listEmployees')({ limit: 5 })).employees).toHaveLength(5);
    expect(JSON.stringify(all)).not.toMatch(/salary|nric|bank/i);
  });

  it('looks up one employee, and gives private details only when asked', async () => {
    const plain = await run('getEmployee')({ employee: 'aisyah' });
    expect(plain).toMatchObject({ found: true, employee: { name: 'Aisyah Rahim', department: 'Sales' } });
    expect(plain).not.toHaveProperty('private');
    const full = await run('getEmployee')({ employee: 'Aisyah Rahim', includePrivate: true });
    expect(full.private_access).toBe(true);
    expect(full.private).toMatchObject({ base_salary: 'RM 5,600.00', bank_name: 'CIMB' });
  });

  it('says the caller has no access to private details, not that there are none', async () => {
    const hidden: PeopleData = { ...data, getEmployeePrivate: async () => null };
    const result = await runner(hidden, MEMBER)('getEmployee')({ employee: 'Ahmad Zaki', includePrivate: true });
    expect(result).toMatchObject({ found: true, private: null, private_access: false });
  });

  it('asks which one when a name matches several people, and says so when it matches none', async () => {
    expect(await run('getEmployee')({ employee: 'siti' })).toEqual({
      found: false, several_match: ['Siti Aminah', 'Siti Lestari'],
    });
    expect(await run('getEmployee')({ employee: 'nobody at all' })).toEqual({ found: false });
    expect(await run('getEmployee')({ employee: '   ' })).toEqual({ found: false });
  });

  it('gives headcount by department', async () => {
    const result = await run('getHeadcountByDepartment')({});
    expect(result.headcount).toBe(20);
    expect(result.departments[0]).toEqual({ department: 'Sales', headcount: 6 });
  });

  it('says who is on leave today, or on another day', async () => {
    const today = await run('listWhoIsOnLeave')({});
    expect(today.date).toBe('2026-10-09');
    expect(today.people.map((p: { name: string }) => p.name)).toEqual(['Lim Wei Jie', 'Nurul Huda', 'Siti Lestari']);
    expect((await run('listWhoIsOnLeave')({ date: '2026-10-07' })).people).toHaveLength(1);
    expect((await run('listWhoIsOnLeave')({ date: 'next friday' })).date).toBe('2026-10-09');
  });

  it('lists leave requests by employee, status and type', async () => {
    expect((await run('listLeaveRequests')({ status: 'pending' })).total).toBe(3);
    const aisyah = await run('listLeaveRequests')({ employee: 'aisyah' });
    expect(aisyah.total).toBe(3);
    expect(aisyah.requests[0]).toMatchObject({ employee: 'Aisyah Rahim', type: 'Annual leave', status: 'pending' });
    expect((await run('listLeaveRequests')({ leaveType: 'medical', status: 'approved' })).total).toBe(4);
  });

  it('gives leave balances with what is left', async () => {
    const result = await run('getLeaveBalances')({ employee: 'aisyah' });
    expect(result.year).toBe(2026);
    expect(result.balances).toHaveLength(3);
    expect(result.balances.find((b: { leave_type: string }) => b.leave_type === 'annual')).toMatchObject({
      entitled_days: 16, used_days: 2, remaining_days: 14,
    });
  });

  it('lists what is waiting for approval', async () => {
    const result = await run('listPendingApprovals')({});
    expect(result.counts).toEqual({ leave: 3, claims: 2, overtime: 1, time_off: 0, total: 6 });
    expect(result.approvals).toHaveLength(6);
  });

  it('lists claims and overtime with amounts in Ringgit', async () => {
    const pending = await run('listClaims')({ status: 'pending' });
    expect(pending.total).toBe(2);
    expect(pending.claims.map((c: { amount: string }) => c.amount).sort()).toEqual(['RM 180.00', 'RM 240.00']);
    expect((await run('listClaims')({ category: 'travel' })).total).toBe(4);
    const overtime = await run('listOvertime')({ employee: 'ahmad zaki' });
    expect(overtime.total).toBe(2);
    expect(overtime.overtime.find((o: { status: string }) => o.status === 'pending')).toMatchObject({
      hours: 4, amount: 'RM 150.00',
    });
  });

  it('summarises attendance over a window that it caps at 31 days', async () => {
    const week = await run('getAttendanceSummary')({});
    expect(week).toMatchObject({ from: '2026-10-03', to: '2026-10-09' });
    expect(week.present + week.late + week.absent + week.on_leave).toBe(100);
    const capped = await run('getAttendanceSummary')({ days: 500 });
    expect(capped.from).toBe('2026-09-09');
    expect((await run('getAttendanceSummary')({ days: 1 })).from).toBe('2026-10-09');
  });

  it('adds up timesheet hours', async () => {
    const result = await run('getTimesheet')({ days: 1 });
    expect(result.by_employee).toHaveLength(17);
    const sum = result.by_employee.reduce((s: number, r: { hours: number }) => s + r.hours, 0);
    expect(result.total_hours).toBe(Math.round(sum * 100) / 100);
    expect((await run('getTimesheet')({ days: 1, employee: 'aisyah' })).by_employee).toHaveLength(1);
  });

  it('gives this week\'s roster and next week\'s', async () => {
    const week = await run('listShifts')({});
    expect(week).toMatchObject({ from: '2026-10-05', to: '2026-10-11', total: 35 });
    expect(week.shifts[0]).toHaveProperty('employee');
    expect((await run('listShifts')({ week: 'next' })).from).toBe('2026-10-12');
  });

  it('lists public holidays, all or only those still ahead', async () => {
    expect((await run('listPublicHolidays')({})).holidays).toHaveLength(6);
    expect((await run('listPublicHolidays')({ upcomingOnly: true })).holidays.map((h: { name: string }) => h.name)).toEqual([
      'Christmas Day',
    ]);
  });

  it('totals payroll and lists payslips in Ringgit', async () => {
    const payroll = await run('getPayrollSummary')({});
    expect(payroll.runs).toHaveLength(3);
    expect(payroll.runs[0]).toMatchObject({ month: '2026-10', status: 'draft', headcount: 20, gross: 'RM 107,387.50' });
    expect((await run('getPayrollSummary')({ months: 50 })).runs).toHaveLength(8);
    const slips = await run('listPayslips')({ employee: 'aisyah', month: '2026-09' });
    expect(slips.total).toBe(1);
    expect(slips.payslips[0]).toMatchObject({ employee: 'Aisyah Rahim', month: '2026-09', gross: 'RM 6,287.50', status: 'paid' });
  });

  it('lists a payslip’s basic pay, other deductions and lines in Ringgit; a lookup holding no change tool gets no ids', async () => {
    const slips = await run('listPayslips')({ month: '2026-10', limit: 50 });
    const withLine = slips.payslips.find((p: Loose) => p.lines.length > 0);
    expect(withLine).toBeDefined();
    expect(withLine.basic).toMatch(/^RM [\d,]+\.\d{2}$/);
    expect(withLine.other_deductions).toMatch(/^RM [\d,]+\.\d{2}$/);
    expect(withLine.run_status).toBe('draft');
    for (const slip of slips.payslips) {
      // createPeopleTools was given no write access here, so no payroll change tool could use an id.
      expect(slip).not.toHaveProperty('id');
      for (const line of slip.lines) expect(line).toMatchObject({ label: expect.any(String), kind: expect.any(String), amount: expect.stringMatching(/^RM / ) });
    }
    expect(JSON.stringify(slips)).not.toMatch(/_cents/);
  });

  it('summarises performance, trainings and announcements', async () => {
    expect((await run('getPerformanceSummary')({})).goals.total).toBe(40);
    const trainings = await run('listTrainings')({});
    expect(trainings.trainings).toHaveLength(5);
    expect(trainings.trainings.every((t: { enrolled: number }) => t.enrolled > 0)).toBe(true);
    expect(trainings).not.toHaveProperty('scope');
    expect((await run('listTrainings')({ status: 'upcoming' })).trainings).toHaveLength(2);
    expect((await run('listAnnouncements')({ limit: 2 })).announcements).toHaveLength(2);
  });

  it('tells the model whose records it is looking at', async () => {
    expect((await run('listClaims')({})).scope).toBe('everyone in the workspace');
    expect((await runner(data, MEMBER)('listClaims')({})).scope).toBe('your own records only');
    expect((await runner(data, { employeeId: null, isHr: false, isDemo: true })('listPayslips')({})).scope).toBe(
      'everyone in the workspace',
    );
  });

  it('answers a filter that matches nothing with nothing, not everything', async () => {
    expect((await run('listLeaveRequests')({ employee: 'zzzz' })).total).toBe(0);
    expect((await run('listEmployees')({ department: 'legal' })).total).toBe(0);
  });

  it('answers from an empty workspace without NaN', async () => {
    const empty = runner(EMPTY);
    const badNumbers = (value: unknown): unknown[] => {
      if (typeof value === 'number') return Number.isNaN(value) || !Number.isFinite(value) ? [value] : [];
      if (Array.isArray(value)) return value.flatMap(badNumbers);
      if (value && typeof value === 'object') return Object.values(value).flatMap(badNumbers);
      return [];
    };
    for (const name of PEOPLE_TOOL_NAMES) {
      const result = await empty(name)(name === 'getEmployee' ? { employee: 'aisyah' } : {});
      expect(badNumbers(result), name).toEqual([]);
      expect(result.ok, name).not.toBe(false);
    }
    const overview = await empty('getPeopleOverview')({});
    expect(overview.clocked_in_so_far).toBe(0);
    // Today is never a rate: a rate over today's rows alone reads 100% by construction.
    expect(overview).not.toHaveProperty('attendance_rate_pct');
  });

  it('reports a failed read as an error, without the database message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: PeopleData = {
      ...data,
      listEmployees: async () => {
        throw new Error('relation "hr_employees" does not exist');
      },
    };
    const result = await runner(broken)('listEmployees')({});
    expect(result).toEqual({ ok: false, error: 'Could not read HR data.' });
    expect(JSON.stringify(result)).not.toContain('hr_employees');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('gives a member the team headcount and their own requests, not team-wide figures', async () => {
    const member = await runner(data, MEMBER)('getPeopleOverview')({});
    expect(member).toMatchObject({
      date: '2026-10-09', headcount: 20, departments: 5, scope: 'your own records only',
      team_figures: 'On-leave, attendance and approval figures for the whole team are visible to HR admins only.',
    });
    expect(member).toHaveProperty('your_pending_requests');
    for (const key of ['on_leave_today', 'clocked_in_so_far', 'attendance_rate_pct', 'pending_approvals']) {
      expect(member, key).not.toHaveProperty(key);
    }
    const hr = await run('getPeopleOverview')({});
    expect(hr).not.toHaveProperty('your_pending_requests');
    expect(hr).not.toHaveProperty('team_figures');
  });

  it('says a member sees only their own leave, and HR is not told that', async () => {
    const member = await runner(data, MEMBER)('listWhoIsOnLeave')({});
    expect(member.covers).toBe('Only your own leave. Who else is on leave is visible to HR admins only.');
    expect(member).toMatchObject({ date: '2026-10-09', scope: 'your own records only' });
    expect(await run('listWhoIsOnLeave')({})).not.toHaveProperty('covers');
  });

  it('explains "scope" in exactly the tools that return it', async () => {
    const sentence =
      ' The result says whose records it covers in "scope": everyone for an HR admin; for a manager, their own and their direct reports\' where "scope" says so; otherwise their own records only. Never present a narrower scope as the whole team.';
    const tools = createPeopleTools(data, HR, NOW);
    for (const name of PEOPLE_TOOL_NAMES) {
      const description = (tools[name] as unknown as { description: string }).description;
      const result = await run(name)(name === 'getEmployee' ? { employee: 'aisyah' } : {});
      expect(description.includes(sentence), `${name} description`).toBe('scope' in result);
    }
  });

  it('tells a member whether they themselves are enrolled, not how many are', async () => {
    const member = await runner(data, MEMBER)('listTrainings')({});
    expect(member.trainings).toHaveLength(5);
    expect(member).not.toHaveProperty('scope');
    for (const t of member.trainings) {
      expect(typeof t.you_are_enrolled).toBe('boolean');
      expect(t).not.toHaveProperty('enrolled');
    }
    const none = await runner({ ...data, listTrainingEnrolments: async () => [] }, MEMBER)('listTrainings')({});
    expect(none.trainings.every((t: { you_are_enrolled: boolean }) => t.you_are_enrolled === false)).toBe(true);
  });

  it('rounds hour totals so float noise does not show', async () => {
    const [base] = await data.listOvertime();
    const overtime = runner({
      ...data,
      listOvertime: async () => [
        { ...base, id: 'a', hours: 0.1 },
        { ...base, id: 'b', hours: 0.2 },
      ],
    });
    expect((await overtime('listOvertime')({})).total_hours).toBe(0.3);
    const [entry] = await data.listTimesheet('2026-10-09', '2026-10-09');
    const sheet = runner({
      ...data,
      listTimesheet: async () => [
        { ...entry, id: 'a', hours: 0.1, billable_hours: 0.1 },
        { ...entry, id: 'b', hours: 0.2, billable_hours: 0.2 },
      ],
    });
    const result = await sheet('getTimesheet')({ days: 1 });
    expect(result.total_hours).toBe(0.3);
    expect(result.billable_hours).toBe(0.3);
  });

  it('lists who a name filter matched, so a shared first name is not merged silently', async () => {
    // LEAVE has Siti Aminah (employee 5, annual leave 60 days ago) and Siti Lestari (employee 7, annual leave from 2 days ago).
    const siti = await run('listLeaveRequests')({ employee: 'siti' });
    expect(siti.matched_employees).toEqual(['Siti Aminah', 'Siti Lestari']);
    expect((await run('listLeaveRequests')({ employee: 'aisyah' })).matched_employees).toEqual(['Aisyah Rahim']);
    expect(await run('listLeaveRequests')({})).not.toHaveProperty('matched_employees');
    expect(await run('listLeaveRequests')({ employee: '  ' })).not.toHaveProperty('matched_employees');
    expect((await run('listClaims')({ employee: 'aisyah' })).matched_employees).toEqual(['Aisyah Rahim']);
    expect((await run('listOvertime')({ employee: 'aisyah' })).matched_employees).toEqual(['Aisyah Rahim']);
    expect((await run('listPayslips')({ employee: 'aisyah' })).matched_employees).toEqual(['Aisyah Rahim']);
    expect((await run('getLeaveBalances')({ employee: 'aisyah' })).matched_employees).toEqual(['Aisyah Rahim']);
    expect((await run('getTimesheet')({ employee: 'aisyah' })).matched_employees).toEqual(['Aisyah Rahim']);
    expect(await run('getTimesheet')({})).not.toHaveProperty('matched_employees');
  });

  it('says payroll is for HR admins only instead of an empty list that reads as no payroll', async () => {
    const member = await runner(data, MEMBER)('getPayrollSummary')({});
    expect(member).toEqual({ runs: [], visible_to: 'HR admins only' });
    const hr = await run('getPayrollSummary')({});
    expect(hr.runs).toHaveLength(3);
    expect(hr.scope).toBe('everyone in the workspace');
  });

  const NOT_LINKED_TEXT =
    'This account is not linked to an employee record yet, so none of this person\'s own records can be shown. It does not mean they have none.';
  const UNLINKED: PeopleViewer = { employeeId: null, isHr: false, isDemo: false };

  it('tells an unlinked member that nothing can be shown, in every result that has a scope', async () => {
    const unlinked = runner(data, UNLINKED);
    for (const name of PEOPLE_TOOL_NAMES) {
      const result = await unlinked(name)(name === 'getEmployee' ? { employee: 'aisyah' } : {});
      if ('scope' in result) expect(result.not_linked, name).toBe(NOT_LINKED_TEXT);
    }
    expect((await unlinked('listTrainings')({})).not_linked).toBe(NOT_LINKED_TEXT);
  });

  it('adds no not_linked note for HR or a linked member', async () => {
    for (const viewer of [HR, MEMBER]) {
      const r = runner(data, viewer);
      for (const name of PEOPLE_TOOL_NAMES) {
        const result = await r(name)(name === 'getEmployee' ? { employee: 'aisyah' } : {});
        expect(result, name).not.toHaveProperty('not_linked');
      }
    }
  });

  it('says private details were never entered, apart from the user not being allowed to see them', async () => {
    const blank: PeopleData = { ...data, getEmployeePrivate: async () => null };
    const hr = await runner(blank, HR)('getEmployee')({ employee: 'Ahmad Zaki', includePrivate: true });
    expect(hr).toMatchObject({ private_access: true, private_recorded: false, private: null });
    const self = await runner(blank, MEMBER)('getEmployee')({ employee: 'Faiz Hakim', includePrivate: true });
    expect(self).toMatchObject({ private_access: true, private_recorded: false, private: null });
    const other = await runner(blank, MEMBER)('getEmployee')({ employee: 'Ahmad Zaki', includePrivate: true });
    expect(other).toMatchObject({ private_access: false, private: null });
    expect(other).not.toHaveProperty('private_recorded');
    const real = await run('getEmployee')({ employee: 'Aisyah Rahim', includePrivate: true });
    expect(real).toMatchObject({ private_access: true, private_recorded: true });
  });

  it('explains a null attendance rate in the overview description', () => {
    const description = (createPeopleTools(data, HR, NOW).getPeopleOverview as unknown as { description: string }).description;
    expect(description).toContain('clocked_in_so_far counts only people who have clocked in so far today');
    expect(description.endsWith('Never present a narrower scope as the whole team.')).toBe(true);
  });

  it('gives each employee an id, and says whether an account is linked, but never the account itself', async () => {
    const { employees } = await run('listEmployees')({ limit: 3 });
    for (const row of employees) {
      expect(typeof row.id).toBe('string');
      expect(row.account_linked).toBe(false);
      expect(row).not.toHaveProperty('user_id');
    }
    // Aisyah is the sample company's fixed "me".
    const one = await run('getEmployee')({ employee: 'Aisyah Rahim' });
    expect(one.employee.id).toBe('dea97d89-a5b6-f264-bd42-c6df73f664a7');
  });

  it('lists departments with an id and their active headcount', async () => {
    const result = await run('listDepartments')({});
    expect(result.total).toBe(5);
    const sales = result.departments.find((d: Loose) => d.name === 'Sales');
    expect(typeof sales.id).toBe('string');
    expect(sales.headcount).toBe(6);
    expect(await runner(EMPTY)('listDepartments')({})).toEqual({ total: 0, departments: [] });
  });

  it('prefers the one exact name when a fragment matches several people', async () => {
    const twoSitis = await run('getEmployee')({ employee: 'Siti' });
    expect(twoSitis.found).toBe(false);
    expect(twoSitis.several_match).toEqual(expect.arrayContaining(['Siti Aminah', 'Siti Lestari']));

    const all = await data.listEmployees();
    const shadowed: PeopleData = {
      ...data,
      listEmployees: async () => [...all, { ...all[0], id: 'seed-emp-99', name: 'Siti', employee_no: 'EMP-099' }],
    };
    const exact = await runner(shadowed)('getEmployee')({ employee: 'siti' });
    expect(exact.found).toBe(true);
    expect(exact.employee.name).toBe('Siti');
  });

  it('says which employee is asking when their account is linked', async () => {
    const linkedHr: PeopleViewer = { employeeId: 'seed-emp-2', isHr: true, isDemo: false, employeeName: 'Faiz Hakim' };
    expect((await runner(data, linkedHr)('listLeaveRequests')({})).asked_by).toBe('Faiz Hakim');
    expect((await runner(data, linkedHr)('getPeopleOverview')({})).asked_by).toBe('Faiz Hakim');
    expect(await run('listLeaveRequests')({})).not.toHaveProperty('asked_by');
  });

  it('behaves for a member whose data looks the way the database returns it', async () => {
    const asFaiz = runner(asMember(data, 'seed-emp-2'), MEMBER);
    const leave = await asFaiz('listLeaveRequests')({});
    for (const row of leave.requests) expect(row.employee).toBe('Faiz Hakim');
    expect(leave.scope).toBe('your own records only');
    expect((await asFaiz('getPayrollSummary')({})).visible_to).toBe('HR admins only');
    const colleague = await asFaiz('getEmployee')({ employee: 'Ahmad Zaki', includePrivate: true });
    expect(colleague.private_access).toBe(false);
    expect(colleague.private).toBeNull();
  });

  it('holds no change tool without write access, or as a member with no employee record of their own', () => {
    const none = Object.keys(createPeopleTools(data, HR, NOW));
    const refused = Object.keys(createPeopleTools(data, HR, NOW, { ctx: { client: {} as never, orgId: 'o' }, tier: 'self', employeeId: null, receipt: null, userId: 'u1' }));
    expect(none).toEqual([...PEOPLE_TOOL_NAMES]);
    expect(refused).toEqual([...PEOPLE_TOOL_NAMES]);
  });
});

describe('claim and overtime lookups', () => {
  it('has a named card for the overtime preview', () => {
    expect(toolMeta('previewOvertime').isFallback).toBe(false);
  });

  it('offers paid as a status, and says approved means approved and not yet paid', () => {
    const tools = createPeopleTools(data, HR, NOW);
    const claims = tools.listClaims as unknown as {
      inputSchema: { safeParse: (v: unknown) => { success: boolean }; shape: { status: { description?: string } } };
    };
    expect(claims.inputSchema.safeParse({ status: 'paid' }).success).toBe(true);
    expect(claims.inputSchema.safeParse({ status: 'refunded' }).success).toBe(false);
    expect(claims.inputSchema.shape.status.description).toContain('not yet paid');
  });

  it('counts a paid claim with the approved ones, from the same rows the screens use', async () => {
    const rows = await data.listClaims();
    const paid = { ...rows[0], id: 'paid-1', status: 'paid' as const, amount_cents: 7000, paid_on: '2026-10-08' };
    const source: PeopleData = { ...data, listClaims: async () => [...rows, paid] };
    const result = await runner(source)('listClaims')({});
    const approvedCents = [...rows, paid]
      .filter((c) => c.status === 'approved' || c.status === 'paid')
      .reduce((sum, c) => sum + c.amount_cents, 0);
    expect(result.approved_or_paid_total).toBe(rm(approvedCents));
    expect((await runner(source)('listClaims')({ status: 'paid' })).claims).toMatchObject([{ status: 'paid', paid_on: '2026-10-08' }]);
  });

  it('gives a plain lookup (no change tools) no ids; HR sees the figures on every row, a member only on their own', async () => {
    const hrRows = (await run('listOvertime')({})).overtime;
    expect(hrRows.length).toBeGreaterThan(0);
    for (const o of hrRows) {
      expect(o).not.toHaveProperty('id');
      expect(o).toHaveProperty('amount_calculated');
      expect(o).toHaveProperty('hourly_rate');
    }
    // Were the provider to return everyone's rows, a member is still narrowed to their own before anything is shown,
    // and the member's own record carries its figures.
    const all = await data.listOvertime();
    const ownRecord = { ...all[0], id: 'ot-own', employee_id: 'seed-emp-2', employee_name: all.find((r) => r.employee_id === 'seed-emp-2')?.employee_name ?? 'Own' };
    const shared: PeopleData = { ...data, listOvertime: async () => [...all, ownRecord] };
    const everyone = (await runner(shared, MEMBER)('listOvertime')({})).overtime;
    expect(everyone.length).toBeGreaterThan(0);
    for (const o of everyone) {
      expect(o).not.toHaveProperty('id');
      expect(o.employee).toBe(ownRecord.employee_name);
      expect(o).toHaveProperty('hourly_rate');
    }
    for (const c of (await run('listClaims')({})).claims) {
      expect(c).not.toHaveProperty('id');
      expect(c).not.toHaveProperty('approved_this_year');
    }
  });

  it('never returns a receipt path', async () => {
    const rows = await data.listClaims();
    const source: PeopleData = { ...data, listClaims: async () => rows.map((c) => ({ ...c, receipt_path: 'u1/secret-file.png' })) };
    expect(JSON.stringify(await runner(source)('listClaims')({}))).not.toContain('secret-file');
  });
});

describe('the lookups after the performance slice', () => {
  const OWN_DRAFT = {
    id: 'own-draft', employee_id: 'seed-emp-2', employee_name: 'Faiz Hakim', period: 'H1 2026',
    competencies: { Delivery: 5, Teamwork: 5, Ownership: 5, Communication: 5 }, rating: 'exceeds' as const, score: 5,
    comment: 'SECRET', status: 'draft' as const, released_at: null, reviewer_name: 'Kavitha', reviewed_at: '2026-09-01',
  };

  it('counts released reviews only in the performance summary for HR: 18 of the 20, never a draft', async () => {
    const summary = await run('getPerformanceSummary')({});
    expect(summary.ratings.exceeds + summary.ratings.meets + summary.ratings.below).toBe(18);
    const drafts = new Set((await data.listReviews()).filter((r) => r.status === 'draft').map((r) => r.employee_name));
    expect(summary.top.some((t: { employee: string }) => drafts.has(t.employee))).toBe(false);
  });

  it('gives a member nothing from their own draft review, even when the rows they are handed include it', async () => {
    const handed: PeopleData = { ...data, listReviews: async () => [OWN_DRAFT] };
    const summary = await runner(handed, MEMBER)('getPerformanceSummary')({});
    expect(summary.average_score).toBeNull();
    expect(summary.ratings).toEqual({ exceeds: 0, meets: 0, below: 0 });
    expect(summary.top).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain('SECRET');
  });

  it('gives a member their own released review in the summary', async () => {
    const summary = await runner(asMember(data, 'seed-emp-5'), { ...MEMBER, employeeId: 'seed-emp-5' })('getPerformanceSummary')({});
    expect(summary.ratings.meets + summary.ratings.exceeds + summary.ratings.below).toBe(1);
    expect(summary.average_score).toBe(3);
  });

  it('never hands a member a draft announcement, but lists it for HR', async () => {
    const asked = { limit: 20 };
    const member = await runner(data, MEMBER)('listAnnouncements')(asked);
    expect(member.total).toBe(5);
    expect(JSON.stringify(member)).not.toContain('Year-end dinner');
    const hr = await run('listAnnouncements')(asked);
    expect(JSON.stringify(hr)).toContain('Year-end dinner');
  });

  it('works a course\'s status out from its dates and the clock, for the filter and for the result', async () => {
    const trainings = await run('listTrainings')({});
    expect(trainings.trainings.map((t: { status: string }) => t.status).sort()).toEqual([
      'completed', 'completed', 'in_progress', 'upcoming', 'upcoming',
    ]);
    // Two weeks later the "Consultative selling" course has ended.
    const later = runner(data, HR, new Date('2026-10-25T04:00:00Z'));
    expect((await later('listTrainings')({ status: 'completed' })).trainings).toHaveLength(4);
    expect((await later('listTrainings')({ status: 'in_progress' })).trainings).toHaveLength(0);
  });
});

describe('the goal and review lookups', () => {
  const NOT_LINKED_TEXT =
    'This account is not linked to an employee record yet, so none of this person\'s own records can be shown. It does not mean they have none.';
  it('list goals for an owner and only the asker’s own for a member, who is told whose they are', async () => {
    const all = await run('listGoals')({ limit: 50 });
    expect(all.scope).toBe('everyone in the workspace');
    expect(all.total).toBe(40);
    const own = await runner(asMember(data, 'seed-emp-2'), MEMBER)('listGoals')({ limit: 50 });
    expect(own.scope).toBe('your own records only');
    expect(own.total).toBeGreaterThan(0);
    expect(own.total).toBeLessThan(all.total);
    expect(own.goals.every((g: Loose) => g.employee === own.goals[0].employee)).toBe(true);
    // Nobody here holds a change tool, so no goal carries an id.
    for (const g of [...all.goals, ...own.goals]) expect(g).not.toHaveProperty('id');
  });

  it('list reviews for an owner with every status, and for a member their own released reviews only', async () => {
    const all = await run('listReviews')({ limit: 50 });
    expect(all.total).toBe(20);
    expect(all.drafts).toBe(2);
    const member = await runner(asMember(data, 'seed-emp-5'), { ...MEMBER, employeeId: 'seed-emp-5' })('listReviews')({ limit: 50 });
    expect(member.total).toBe(1);
    expect(member.reviews[0]).not.toHaveProperty('status');
    expect(member.reviews[0]).not.toHaveProperty('id');
    expect(member).not.toHaveProperty('drafts');
  });

  it('a member linked to no employee record gets nothing and is told why, never "no reviews"', async () => {
    const unlinked = runner(asMember(data, 'seed-emp-5'), { employeeId: null, isHr: false, isDemo: false });
    for (const name of ['listGoals', 'listReviews']) {
      const result = await unlinked(name)({});
      expect(result.not_linked, name).toBe(NOT_LINKED_TEXT);
      expect(result.total, name).toBe(0);
    }
  });

  it('say whose records they cover in their descriptions', () => {
    const tools = createPeopleTools(data, HR, NOW);
    for (const name of ['listGoals', 'listReviews']) {
      expect((tools[name] as unknown as { description: string }).description, name).toContain('whose records it covers');
    }
  });
});

describe('listTrainings and listAnnouncements for an owner', () => {
  it('says who is enrolled and how many are marked completed, for each course', async () => {
    const trainings = await run('listTrainings')({});
    for (const t of trainings.trainings) {
      expect(t.people.length).toBe(t.enrolled);
      expect(t.completed_count).toBe(t.people.filter((p: { completed: boolean }) => p.completed).length);
    }
    expect(trainings.trainings.some((t: { completed_count: number }) => t.completed_count > 0)).toBe(true);
  });

  it('marks drafts, and counts unread only for published ones', async () => {
    const result = await run('listAnnouncements')({ limit: 20 });
    const draft = result.announcements.find((a: { title: string }) => a.title === 'Year-end dinner');
    expect(draft).toMatchObject({ status: 'draft', unread: false });
    expect(result.announcements.filter((a: { status: string }) => a.status === 'published').length).toBe(5);
  });
});
