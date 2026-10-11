import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  hasEnv: true,
  org: { orgId: 'o1', role: 'member' } as { orgId: string; role: string } | null,
  user: { id: 'u1' } as { id: string } | null,
  fail: false,
}));
vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => env.hasEnv }));
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: async () => env.org }));

import { getPeopleData } from '@/lib/people/supabase';
import { NO_WORKSPACE_VIEWER, PREVIEW_PEOPLE_VIEWER, getPeopleViewer } from '@/lib/people/viewer';
import { DEFAULT_PEOPLE_SETTINGS, DEMO_EMPLOYEE_ID } from '@/lib/people/types';

type Call = { table: string; columns: string; filters: [string, string, unknown][]; order: string[]; nullsLast?: string[]; range?: [number, number] };
const calls: Call[] = [];

const ROWS: Record<string, unknown[]> = {
  hr_departments: [{ id: 'd1', name: 'Sales', created_at: '2026-01-01T00:00:00Z' }],
  hr_employees: [
    { id: 'e1', name: 'Aisyah Rahim', employee_no: 'EMP-001', department_id: 'd1', department: { name: 'Sales' } },
    { id: 'e2', name: 'Faiz Hakim', employee_no: 'EMP-002', department_id: null, department: null },
  ],
  hr_leave_requests: [
    { id: 'l1', employee_id: 'e1', leave_type: 'annual', employee: { name: 'Aisyah Rahim' } },
    { id: 'l2', employee_id: 'e9', leave_type: 'medical', employee: null },
  ],
  hr_documents: [{ id: 'd1', employee_id: 'e1', title: 'Payslip', doc_type: 'payslip', employee: { name: 'Aisyah Rahim' } }],
  hr_letters: [{ id: 'lt1', employee_id: 'e1', title: 'Offer', employee: { name: 'Aisyah Rahim' } }],
  hr_payment_vouchers: [{ id: 'v1', voucher_no: 'PV-1041', payee: 'KWSP', amount_cents: 100 }],
  hr_attendance_days: Array.from({ length: 1500 }, (_, i) => ({ id: `a${i}`, employee_id: 'e1', work_date: '2026-10-09', status: 'present' })),
};
/** What `.maybeSingle()` answers, by table. */
const SINGLE: Record<string, unknown> = {};

const client = {
  auth: { getUser: async () => ({ data: { user: env.user }, error: null }) },
  from(table: string) {
    const call: Call = { table, columns: '', filters: [], order: [] };
    const query = {
      select(columns: string) { call.columns = columns; return query; },
      eq(column: string, value: unknown) { call.filters.push(['eq', column, value]); return query; },
      gte(column: string, value: unknown) { call.filters.push(['gte', column, value]); return query; },
      lte(column: string, value: unknown) { call.filters.push(['lte', column, value]); return query; },
      order(column: string, opts?: { nullsFirst?: boolean }) {
        call.order.push(column);
        if (opts?.nullsFirst === false) call.nullsLast = [...(call.nullsLast ?? []), column];
        return query;
      },
      range(from: number, to: number) {
        call.range = [from, to];
        calls.push(call);
        return Promise.resolve(
          env.fail
            ? { data: null, error: { message: 'relation does not exist' } }
            : { data: (ROWS[table] ?? []).slice(from, to + 1), error: null },
        );
      },
      maybeSingle() {
        calls.push(call);
        const single = SINGLE[table] as { __error?: boolean } | undefined;
        if (single?.__error) return Promise.resolve({ data: null, error: { message: 'permission denied' } });
        return Promise.resolve({ data: single ?? null, error: null });
      },
    };
    return query;
  },
} as never;

afterEach(() => {
  env.hasEnv = true;
  env.org = { orgId: 'o1', role: 'member' };
  env.user = { id: 'u1' };
  env.fail = false;
  calls.length = 0;
  for (const key of Object.keys(SINGLE)) delete SINGLE[key];
});

describe('getPeopleData', () => {
  it('reads every table for the current workspace only', async () => {
    const data = await getPeopleData(client);
    await Promise.all([
      data.listDepartments(), data.listEmployees(), data.listLeaveRequests(), data.listLeaveBalances(2026),
      data.listTimeOffRequests(), data.listClaims(), data.listOvertime(),
      data.listAttendance('2026-10-01', '2026-10-09'), data.listTimesheet('2026-10-01', '2026-10-09'),
      data.listShifts('2026-10-05', '2026-10-11'), data.listPublicHolidays(), data.listPayrollRuns(),
      data.listPayslips(), data.listGoals(), data.listScorecards(), data.listReviews(), data.listTrainings(),
      data.listTrainingEnrolments(), data.listAnnouncements(), data.getEmployeePrivate('e1'),
      data.listDocuments(), data.listLetters(), data.listPaymentVouchers(), data.getSettings(),
    ]);
    expect([...new Set(calls.map((c) => c.table))].sort()).toEqual([
      'hr_announcements', 'hr_attendance_days', 'hr_claims', 'hr_departments', 'hr_documents',
      'hr_employee_private', 'hr_employees', 'hr_goals', 'hr_leave_balances', 'hr_leave_requests', 'hr_letters',
      'hr_overtime_records', 'hr_payment_vouchers', 'hr_payroll_runs', 'hr_payslips', 'hr_public_holidays',
      'hr_reviews', 'hr_scorecards', 'hr_settings', 'hr_shifts', 'hr_time_off_requests', 'hr_timesheet_entries', 'hr_training_enrolments', 'hr_trainings',
    ]);
    for (const call of calls) expect(call.filters, call.table).toContainEqual(['eq', 'org_id', 'o1']);
  });

  it('reads the claim and overtime columns the write path adds, and no one else\'s private ones', async () => {
    const data = await getPeopleData(client);
    await Promise.all([data.listClaims(), data.listOvertime()]);
    const claims = calls.find((c) => c.table === 'hr_claims')!.columns!;
    for (const column of ['decision_note', 'receipt_path', 'paid_on', 'paid_reference', 'has_receipt']) expect(claims).toContain(column);
    const overtime = calls.find((c) => c.table === 'hr_overtime_records')!.columns!;
    for (const column of ['hourly_rate_cents', 'day_kind', 'reason', 'decision_note']) expect(overtime).toContain(column);
  });

  it('never asks the directory for a private column', async () => {
    await (await getPeopleData(client)).listEmployees();
    const { columns } = calls.find((c) => c.table === 'hr_employees')!;
    for (const column of ['nric', 'base_salary_cents', 'bank_account', 'address', 'phone']) {
      expect(columns).not.toContain(column);
    }
  });

  it('flattens the joined department and employee names', async () => {
    const data = await getPeopleData(client);
    const [first, second] = await data.listEmployees();
    expect(first).toMatchObject({ id: 'e1', department_name: 'Sales' });
    expect(first).not.toHaveProperty('department');
    expect(second.department_name).toBeNull();
    const [leave, orphan] = await data.listLeaveRequests();
    expect(leave).toMatchObject({ id: 'l1', employee_name: 'Aisyah Rahim' });
    expect(leave).not.toHaveProperty('employee');
    expect(orphan.employee_name).toBe('Unknown');
  });

  it('reads the half-day flag and the decision note with each leave and time-off request', async () => {
    const data = await getPeopleData(client);
    await data.listLeaveRequests();
    await data.listTimeOffRequests();
    const leaveColumns = calls.find((c) => c.table === 'hr_leave_requests')!.columns;
    expect(leaveColumns).toContain('half_day');
    expect(leaveColumns).toContain('decision_note');
    expect(calls.find((c) => c.table === 'hr_time_off_requests')!.columns).toContain('decision_note');
  });

  it('asks for a date window with both ends', async () => {
    await (await getPeopleData(client)).listShifts('2026-10-05', '2026-10-11');
    const { filters } = calls.find((c) => c.table === 'hr_shifts')!;
    expect(filters).toContainEqual(['gte', 'work_date', '2026-10-05']);
    expect(filters).toContainEqual(['lte', 'work_date', '2026-10-11']);
  });

  it('asks for one year of leave balances', async () => {
    await (await getPeopleData(client)).listLeaveBalances(2026);
    expect(calls.find((c) => c.table === 'hr_leave_balances')!.filters).toContainEqual(['eq', 'year', 2026]);
  });

  it('reads past the first thousand rows, a page at a time', async () => {
    const days = await (await getPeopleData(client)).listAttendance('2026-10-01', '2026-10-09');
    expect(days).toHaveLength(1500);
    const pages = calls.filter((c) => c.table === 'hr_attendance_days').map((c) => c.range);
    expect(pages).toEqual([[0, 999], [1000, 1999]]);
  });

  it('reads one employee private row, and answers null when there is none to see', async () => {
    const data = await getPeopleData(client);
    expect(await data.getEmployeePrivate('e1')).toBeNull();
    SINGLE.hr_employee_private = { employee_id: 'e1', base_salary_cents: 400000 };
    expect(await data.getEmployeePrivate('e1')).toMatchObject({ base_salary_cents: 400000 });
    expect(calls.at(-1)!.filters).toContainEqual(['eq', 'employee_id', 'e1']);
  });

  it('reads documents and letters with the employee joined, and vouchers newest first', async () => {
    const data = await getPeopleData(client);
    const [document] = await data.listDocuments();
    expect(document).toMatchObject({ id: 'd1', employee_name: 'Aisyah Rahim' });
    expect(document).not.toHaveProperty('employee');
    expect((await data.listLetters())[0]).toMatchObject({ id: 'lt1', employee_name: 'Aisyah Rahim' });
    expect(await data.listPaymentVouchers()).toHaveLength(1);
    expect(calls.find((c) => c.table === 'hr_documents')!.columns).toContain('employee:hr_employees(name)');
    expect(calls.find((c) => c.table === 'hr_documents')!.order[0]).toBe('issued_on');
    expect(calls.find((c) => c.table === 'hr_documents')!.nullsLast).toEqual(['issued_on']);
    expect(calls.find((c) => c.table === 'hr_letters')!.order[0]).toBe('created_at');
    expect(calls.find((c) => c.table === 'hr_payment_vouchers')!.order[0]).toBe('issued_date');
  });

  it('gives the default settings when there is no row, and fills a partial one from them', async () => {
    const data = await getPeopleData(client);
    expect(await data.getSettings()).toEqual(DEFAULT_PEOPLE_SETTINGS);
    expect(calls.at(-1)!.filters).toContainEqual(['eq', 'org_id', 'o1']);
    SINGLE.hr_settings = { notifications: { birthdays: false }, default_annual_leave_days: 16, overtime_rates: { weekday: 1.25 } };
    expect(await data.getSettings()).toEqual({
      work_week: ['mon', 'tue', 'wed', 'thu', 'fri'],
      default_annual_leave_days: 16,
      default_medical_leave_days: 14,
      default_emergency_leave_days: 3,
      overtime_rates: { weekday: 1.25, rest_day: 2, public_holiday: 3 },
      notifications: { birthdays: false },
    });
    SINGLE.hr_settings = { default_medical_leave_days: '10.5', default_emergency_leave_days: 2 };
    expect(await data.getSettings()).toMatchObject({
      default_annual_leave_days: 14,
      default_medical_leave_days: 10.5,
      default_emergency_leave_days: 2,
    });
  });

  it('gives the default settings to a signed-in user with no workspace', async () => {
    env.org = null;
    expect(await (await getPeopleData(client)).getSettings()).toEqual(DEFAULT_PEOPLE_SETTINGS);
  });

  it('still throws when the settings read fails for a reason other than no row', async () => {
    SINGLE.hr_settings = { __error: true };
    await expect((await getPeopleData(client)).getSettings()).rejects.toMatchObject({ message: 'permission denied' });
  });

  it('throws when a read fails, so a screen can say so', async () => {
    env.fail = true;
    await expect((await getPeopleData(client)).listEmployees()).rejects.toMatchObject({ message: 'relation does not exist' });
  });

  it('uses the sample data only when no project is configured', async () => {
    env.hasEnv = false;
    expect(await (await getPeopleData(client)).listEmployees()).toHaveLength(20);
    expect(calls).toEqual([]);
  });

  it('gives someone in no workspace nothing, never the sample data', async () => {
    env.org = null;
    const data = await getPeopleData(client);
    expect(await data.listEmployees()).toEqual([]);
    expect(await data.listPayslips()).toEqual([]);
    expect(await data.listAttendance('2026-10-01', '2026-10-09')).toEqual([]);
    expect(await data.getEmployeePrivate('e1')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('getPeopleViewer', () => {
  it('treats an owner or admin as HR and finds their linked employee', async () => {
    SINGLE.orgs = { slug: 'acme' };
    SINGLE.hr_employees = { id: 'e7' };
    expect(await getPeopleViewer(client, { orgId: 'o1', role: 'admin' })).toEqual({ employeeId: 'e7', isHr: true, isDemo: false });
    expect((await getPeopleViewer(client, { orgId: 'o1', role: 'owner' })).isHr).toBe(true);
    const lookup = calls.find((c) => c.table === 'hr_employees')!;
    expect(lookup.filters).toContainEqual(['eq', 'org_id', 'o1']);
    expect(lookup.filters).toContainEqual(['eq', 'user_id', 'u1']);
  });

  it('does not treat a member or viewer as HR', async () => {
    SINGLE.orgs = { slug: 'acme' };
    SINGLE.hr_employees = { id: 'e2' };
    expect(await getPeopleViewer(client, { orgId: 'o1', role: 'member' })).toEqual({ employeeId: 'e2', isHr: false, isDemo: false });
    expect((await getPeopleViewer(client, { orgId: 'o1', role: 'viewer' })).isHr).toBe(false);
  });

  it('says so when a member has no linked employee record', async () => {
    SINGLE.orgs = { slug: 'acme' };
    expect((await getPeopleViewer(client, { orgId: 'o1', role: 'member' })).employeeId).toBeNull();
  });

  it('gives anyone in the demo workspace the demo employee', async () => {
    SINGLE.orgs = { slug: 'rimba-ventures-demo' };
    expect(await getPeopleViewer(client, { orgId: 'demo', role: 'viewer' })).toEqual({
      employeeId: DEMO_EMPLOYEE_ID, isHr: false, isDemo: true,
    });
  });

  it('answers without asking the database when there is no project or no workspace', async () => {
    expect(await getPeopleViewer(client, null)).toEqual(NO_WORKSPACE_VIEWER);
    env.hasEnv = false;
    expect(await getPeopleViewer(client, { orgId: 'o1', role: 'owner' })).toEqual(PREVIEW_PEOPLE_VIEWER);
    expect(calls).toEqual([]);
  });
});
