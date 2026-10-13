import { afterEach, describe, expect, it, vi } from 'vitest';
const env = vi.hoisted(() => ({
  hasEnv: true,
  org: { orgId: 'o1', role: 'member' } as { orgId: string; role: string } | null,
  user: { id: 'u1' } as { id: string } | null,
  fail: false,
}));
vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => env.hasEnv }));
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: async () => env.org }));

import { getPeopleData, isUnread } from '@/lib/people/supabase';
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
  hr_documents: [
    { id: 'd1', employee_id: 'e1', title: 'Passport', doc_type: 'identity', file_name: 'p.pdf', file_size: 1234, file_type: 'application/pdf', employee: { name: 'Aisyah Rahim' } },
    { id: 'd2', employee_id: 'e1', title: 'Sample', doc_type: 'contract', file_name: null, file_size: null, file_type: null, employee: { name: 'Aisyah Rahim' } },
  ],
  hr_letters: [{ id: 'lt1', employee_id: 'e1', title: 'Offer', employee: { name: 'Aisyah Rahim' } }],
  hr_letter_templates: [{ id: 'tp1', name: 'Offer', letter_type: 'offer', title: 'Offer', body: 'Dear {employee_name}', lang: 'ms' }],
  hr_payroll_runs: [{ id: 'r1', period_month: '2026-10-01', status: 'draft', paid_at: null }],
  hr_payslips: [
    {
      id: 'p1', employee_id: 'e1', payroll_run_id: 'r1', period_month: '2026-10-01', status: 'pending',
      set_by_hr: ['pcb', 'epf'], employee: { name: 'Aisyah Rahim' },
      lines: [
        { id: 'l4', payslip_id: 'p1', kind: 'earning', source: 'hr', label: 'Bonus', amount_cents: 100, created_at: '2026-10-11T00:00:01Z' },
        { id: 'l3', payslip_id: 'p1', kind: 'earning', source: 'overtime', label: 'Overtime, 5 Oct 2026, 2 h', amount_cents: 50, created_at: '2026-10-11T00:00:00.000002Z' },
        { id: 'l2', payslip_id: 'p1', kind: 'earning', source: 'overtime', label: 'Overtime, 2 Oct 2026, 1 h', amount_cents: 25, created_at: '2026-10-11T00:00:00.000001Z' },
        { id: 'l1', payslip_id: 'p1', kind: 'unpaid', source: 'joiner', label: 'Joined 3 Oct 2026', amount_cents: 10, created_at: '2026-10-11T00:00:00.000003Z' },
      ],
    },
    { id: 'p2', employee_id: 'e2', payroll_run_id: 'r1', period_month: '2026-10-01', status: 'pending', set_by_hr: [], employee: null, lines: null },
  ],
  hr_overtime_records: [
    { id: 'o1', employee_id: 'e1', employee: { name: 'Aisyah Rahim' }, payslip: { period_month: '2026-09-01', status: 'paid' } },
    { id: 'o2', employee_id: 'e1', employee: { name: 'Aisyah Rahim' }, payslip: { period_month: '2026-10-01', status: 'pending' } },
    { id: 'o3', employee_id: 'e1', employee: { name: 'Aisyah Rahim' }, payslip: null },
  ],
  hr_payment_vouchers: [{ id: 'v1', voucher_no: 'PV-1041', payee: 'KWSP', amount_cents: 100 }],
  hr_attendance_days: Array.from({ length: 1500 }, (_, i) => ({ id: `a${i}`, employee_id: 'e1', work_date: '2026-10-09', status: 'present', corrected_at: i === 0 ? '2026-10-10T01:00:00Z' : null, correction_note: i === 0 ? 'Forgot to clock in' : null })),
};
/** What `.maybeSingle()` answers, by table. */
const SINGLE: Record<string, unknown> = {};
/** What `rpc(name)` answers, by function name; `__throw` makes the call reject. */
const RPC: Record<string, { data?: unknown; error?: { code?: string; message?: string }; __throw?: boolean }> = {};
const rpcCalls: [string, unknown][] = [];

const client = {
  auth: { getUser: async () => ({ data: { user: env.user }, error: null }) },
  async rpc(name: string, args: unknown) {
    rpcCalls.push([name, args]);
    const reply = RPC[name];
    if (reply?.__throw) throw new Error('network down');
    return { data: reply?.data ?? null, error: reply?.error ?? null };
  },
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
  for (const key of Object.keys(RPC)) delete RPC[key];
  rpcCalls.length = 0;
});

describe('getPeopleData', () => {
  it('reads every table for the current workspace only', async () => {
    const data = await getPeopleData(client);
    await Promise.all([
      data.listDepartments(), data.listEmployees(), data.listLeaveRequests(), data.listLeaveBalances(2026),
      data.listTimeOffRequests(), data.listClaims(), data.listOvertime(),
      data.listAttendance('2026-10-01', '2026-10-09'), data.listTimesheet('2026-10-01', '2026-10-09'),
      data.listShifts('2026-10-05', '2026-10-11'), data.listPublicHolidays(), data.listPayrollRuns(),
      data.listPayslips(), data.listGoals(), data.listReviews(), data.listTrainings(),
      data.listTrainingEnrolments(), data.listAnnouncements(), data.getEmployeePrivate('e1'),
      data.listDocuments(), data.listLetters(), data.listLetterTemplates(), data.listPaymentVouchers(), data.getSettings(),
    ]);
    expect([...new Set(calls.map((c) => c.table))].sort()).toEqual([
      'hr_announcements', 'hr_attendance_days', 'hr_claims', 'hr_departments', 'hr_documents',
      'hr_employee_private', 'hr_employees', 'hr_goals', 'hr_leave_balances', 'hr_leave_requests', 'hr_letter_templates', 'hr_letters',
      'hr_overtime_records', 'hr_payment_vouchers', 'hr_payroll_runs', 'hr_payslips', 'hr_public_holidays',
      'hr_reviews', 'hr_settings', 'hr_shifts', 'hr_time_off_requests', 'hr_timesheet_entries', 'hr_training_enrolments', 'hr_trainings',
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

  it('reads each payslip with its lines, its marks and the new columns, system lines first', async () => {
    const slips = await (await getPeopleData(client)).listPayslips();
    const columns = calls.find((c) => c.table === 'hr_payslips')!.columns;
    for (const column of ['basic_cents', 'other_deductions_cents', 'set_by_hr', 'hr_payslip_lines']) expect(columns).toContain(column);
    expect(slips[0].lines.map((l) => l.id)).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(slips[0].lines[0]).not.toHaveProperty('created_at');
    expect(slips[0].set_by_hr).toEqual(['epf', 'pcb']);
    expect(slips[0]).toMatchObject({ employee_name: 'Aisyah Rahim' });
    expect(slips[1]).toMatchObject({ employee_name: 'Unknown', lines: [] });
  });

  it('names the key the employee embed of a payslip follows', async () => {
    await (await getPeopleData(client)).listPayslips();
    const columns = calls.find((c) => c.table === 'hr_payslips')!.columns;
    expect(columns).toContain('employee:hr_employees!hr_payslips_employee_id_org_id_fkey(name)');
    expect(columns).toContain('lines:hr_payslip_lines(');
  });

  it('gives an overtime line the date the work was done, through the named key, and null for other lines', async () => {
    const saved = ROWS.hr_payslips;
    ROWS.hr_payslips = [
      {
        id: 'p1', employee_id: 'e1', payroll_run_id: 'r1', period_month: '2026-10-01', status: 'pending', set_by_hr: [],
        employee: { name: 'A' },
        lines: [
          { id: 'ot', payslip_id: 'p1', kind: 'earning', source: 'overtime', label: 'Overtime', amount_cents: 1,
            created_at: '2026-10-11T00:00:00Z', overtime: { work_date: '2026-09-28' } },
          { id: 'hr', payslip_id: 'p1', kind: 'earning', source: 'hr', label: 'Bonus', amount_cents: 1,
            created_at: '2026-10-11T00:00:01Z', overtime: null },
        ],
      },
    ];
    try {
      const [slip] = await (await getPeopleData(client)).listPayslips();
      expect(slip.lines.map((l) => [l.id, l.work_date])).toEqual([['ot', '2026-09-28'], ['hr', null]]);
      expect(calls.find((c) => c.table === 'hr_payslips')!.columns).toContain(
        'overtime:hr_overtime_records!hr_payslip_lines_overtime_record_id_fkey(work_date)',
      );
    } finally {
      ROWS.hr_payslips = saved;
    }
  });

  it('can read one employee\'s payslips only', async () => {
    await (await getPeopleData(client)).listPayslips('e1');
    expect(calls.find((c) => c.table === 'hr_payslips')!.filters).toContainEqual(['eq', 'employee_id', 'e1']);
  });

  it('reads every payslip when no employee is named', async () => {
    await (await getPeopleData(client)).listPayslips();
    const filters = calls.find((c) => c.table === 'hr_payslips')!.filters;
    expect(filters.some((f) => f[1] === 'employee_id')).toBe(false);
  });

  it('orders lines by the moment they were made, not by the text of the timestamp', async () => {
    const line = (id: string, created_at: string) => ({
      id, payslip_id: 'p1', kind: 'earning', source: 'hr', label: id, amount_cents: 1, created_at,
    });
    const saved = ROWS.hr_payslips;
    ROWS.hr_payslips = [
      {
        id: 'p1', employee_id: 'e1', payroll_run_id: 'r1', period_month: '2026-10-01', status: 'pending', set_by_hr: [],
        employee: { name: 'A' },
        lines: [
          line('a-late-fraction', '2026-10-11T00:00:00.000002+00:00'),
          line('z-exact', '2026-10-11T00:00:00+00:00'),
          line('b-next-second', '2026-10-11T00:00:01+00:00'),
          line('c-before-next', '2026-10-11T00:00:00.999999+00:00'),
        ],
      },
    ];
    try {
      const [slip] = await (await getPeopleData(client)).listPayslips();
      expect(slip.lines.map((l) => l.id)).toEqual(['z-exact', 'a-late-fraction', 'c-before-next', 'b-next-second']);
    } finally {
      ROWS.hr_payslips = saved;
    }
  });

  it('reads the month an overtime record was paid in only when its payslip is paid', async () => {
    const records = await (await getPeopleData(client)).listOvertime();
    const columns = calls.find((c) => c.table === 'hr_overtime_records')!.columns;
    expect(columns).toContain('hr_overtime_records_payslip_id_fkey');
    expect(records.map((r) => r.paid_month)).toEqual(['2026-09', null, null]);
    expect(records[0]).not.toHaveProperty('payslip');
  });

  it('has no payer name to give a payroll run', async () => {
    const runs = await (await getPeopleData(client)).listPayrollRuns();
    expect(runs).toEqual([{ id: 'r1', period_month: '2026-10-01', status: 'draft', paid_at: null, paid_by_name: null }]);
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

  it('reads the correction columns of a day, and tells a corrected one by corrected_at alone', async () => {
    const days = await (await getPeopleData(client)).listAttendance('2026-10-01', '2026-10-09');
    const columns = calls.find((c) => c.table === 'hr_attendance_days')!.columns;
    expect(columns).toContain('corrected_at');
    expect(columns).toContain('correction_note');
    expect(columns).not.toContain('corrected_by');
    expect(days[0]).toMatchObject({ id: 'a0', corrected: true, correction_note: 'Forgot to clock in' });
    expect(days[1]).toMatchObject({ id: 'a1', corrected: false, correction_note: null });
    expect(days[0]).not.toHaveProperty('corrected_at');
  });

  it('reads one employee private row, and answers null when there is none to see', async () => {
    const data = await getPeopleData(client);
    expect(await data.getEmployeePrivate('e1')).toBeNull();
    SINGLE.hr_employee_private = { employee_id: 'e1', base_salary_cents: 400000 };
    expect(await data.getEmployeePrivate('e1')).toMatchObject({ base_salary_cents: 400000 });
    expect(calls.at(-1)!.filters).toContainEqual(['eq', 'employee_id', 'e1']);
  });

  it('never selects a file path for documents, says whether a file is attached from the file name, and takes the size as a number', async () => {
    const data = await getPeopleData(client);
    const documents = await data.listDocuments();
    const columns = calls.find((c) => c.table === 'hr_documents')!.columns as string;
    expect(columns).not.toContain('file_path');
    expect(columns.split(',')).toEqual(
      expect.arrayContaining(['file_name', 'file_size', 'file_type', 'source', 'ack_requested', 'acknowledged_at', 'created_at']),
    );
    expect(documents.map((d) => d.has_file)).toEqual([true, false]);
    expect(documents[0]).toMatchObject({ file_name: 'p.pdf', file_size: 1234, file_type: 'application/pdf' });
    expect(documents[1]).toMatchObject({ file_name: null, file_size: null, file_type: null });
    expect(JSON.stringify(documents)).not.toContain('file_path');
  });

  it('reads letters with their text and acknowledgement and no status filter, and templates by name', async () => {
    const data = await getPeopleData(client);
    await data.listLetters();
    const letters = calls.find((c) => c.table === 'hr_letters')!;
    expect((letters.columns as string).split(',')).toEqual(expect.arrayContaining(['body', 'ack_requested', 'acknowledged_at', 'issued_on']));
    expect(letters.filters.map((f) => f[1])).not.toContain('status');
    expect(await data.listLetterTemplates()).toEqual([{ id: 'tp1', name: 'Offer', letter_type: 'offer', title: 'Offer', body: 'Dear {employee_name}', lang: 'ms' }]);
    expect((calls.find((c) => c.table === 'hr_letter_templates')!.columns as string).split(',')).toEqual(['id', 'name', 'letter_type', 'title', 'body', 'lang']);
    expect(calls.find((c) => c.table === 'hr_letter_templates')!.order[0]).toBe('name');
  });

  it('reads documents and letters with the employee joined, and vouchers newest first', async () => {
    const data = await getPeopleData(client);
    const [document] = await data.listDocuments();
    expect(document).toMatchObject({ id: 'd1', employee_name: 'Aisyah Rahim' });
    expect(document).not.toHaveProperty('employee');
    expect((await data.listLetters())[0]).toMatchObject({ id: 'lt1', employee_name: 'Aisyah Rahim' });
    expect(await data.listPaymentVouchers()).toHaveLength(1);
    expect(calls.find((c) => c.table === 'hr_documents')!.columns).toContain('employee:hr_employees(name)');
    expect(calls.find((c) => c.table === 'hr_documents')!.order[0]).toBe('created_at');
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
      work_start_time: '09:00',
      late_grace_minutes: 15,
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

  it('reads the work week, start time and grace period, with the time cut to HH:MM and the week Monday first', async () => {
    const data = await getPeopleData(client);
    SINGLE.hr_settings = { work_week: ['sat', 'mon', 'tue'], work_start_time: '08:30:00', late_grace_minutes: 10 };
    expect(await data.getSettings()).toMatchObject({ work_week: ['mon', 'tue', 'sat'], work_start_time: '08:30', late_grace_minutes: 10 });
    expect(calls.at(-1)!.columns).toContain('work_start_time');
    expect(calls.at(-1)!.columns).toContain('late_grace_minutes');
    SINGLE.hr_settings = { work_week: ['mon', 'mon', 'bogus', 'fri'], work_start_time: '00:00:00', late_grace_minutes: 0 };
    expect(await data.getSettings()).toMatchObject({ work_week: ['mon', 'fri'], work_start_time: '00:00', late_grace_minutes: 0 });
  });

  it('reads a work week naming no known day as Monday to Friday, as the database does', async () => {
    const data = await getPeopleData(client);
    for (const work_week of [[], ['bogus'], 'mon', null]) {
      SINGLE.hr_settings = { work_week };
      expect((await data.getSettings()).work_week, JSON.stringify(work_week)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
    }
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
    // Only the owner is marked as one: an admin may not decide or pay their own request, an owner may.
    expect(await getPeopleViewer(client, { orgId: 'o1', role: 'owner' })).toEqual({
      employeeId: 'e7', isHr: true, isDemo: false, isOwner: true,
    });
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
    expect(rpcCalls).toEqual([]);
  });

  describe('the team a member manages', () => {
    it('marks a linked member with a team as managing it', async () => {
      SINGLE.orgs = { slug: 'acme' };
      SINGLE.hr_employees = { id: 'e2' };
      RPC.hr_my_team = { data: ['r1'] };
      expect(await getPeopleViewer(client, { orgId: 'o1', role: 'member' })).toEqual({
        employeeId: 'e2', isHr: false, isDemo: false, managesTeam: true,
      });
      expect(rpcCalls).toEqual([['hr_my_team', { p_org: 'o1' }]]);
    });

    it('gives a member with no team exactly the viewer they had before, with no managesTeam key', async () => {
      SINGLE.orgs = { slug: 'acme' };
      SINGLE.hr_employees = { id: 'e2' };
      RPC.hr_my_team = { data: [] };
      const viewer = await getPeopleViewer(client, { orgId: 'o1', role: 'member' });
      expect(viewer).toEqual({ employeeId: 'e2', isHr: false, isDemo: false });
      expect('managesTeam' in viewer).toBe(false);
    });

    it('does not mark a member with no linked employee record', async () => {
      SINGLE.orgs = { slug: 'acme' };
      RPC.hr_my_team = { data: ['r1'] };
      const viewer = await getPeopleViewer(client, { orgId: 'o1', role: 'member' });
      expect(viewer.employeeId).toBeNull();
      expect('managesTeam' in viewer).toBe(false);
    });

    it('never asks for the team of an owner or an admin', async () => {
      SINGLE.orgs = { slug: 'acme' };
      SINGLE.hr_employees = { id: 'e7' };
      RPC.hr_my_team = { data: ['r1'] };
      for (const role of ['owner', 'admin'] as const) {
        expect('managesTeam' in (await getPeopleViewer(client, { orgId: 'o1', role }))).toBe(false);
      }
      expect(rpcCalls).toEqual([]);
    });

    it('does not mark a member in the demo workspace', async () => {
      SINGLE.orgs = { slug: 'rimba-ventures-demo' };
      SINGLE.hr_employees = { id: 'e2' };
      RPC.hr_my_team = { data: ['r1'] };
      const viewer = await getPeopleViewer(client, { orgId: 'demo', role: 'member' });
      expect('managesTeam' in viewer).toBe(false);
    });

    it.each([
      ['an error', { error: { code: '42883' } }],
      ['a thrown call', { __throw: true }],
    ] as const)('reads %s as no team, without throwing', async (_name, reply) => {
      SINGLE.orgs = { slug: 'acme' };
      SINGLE.hr_employees = { id: 'e2' };
      RPC.hr_my_team = reply;
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await getPeopleViewer(client, { orgId: 'o1', role: 'member' })).toEqual({
          employeeId: 'e2', isHr: false, isDemo: false,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe('the employee columns', () => {
  it('select reports_to and no longer is_manager', async () => {
    await (await getPeopleData(client)).listEmployees();
    const columns = calls.find((c) => c.table === 'hr_employees')!.columns;
    expect(columns).toContain('reports_to');
    expect(columns).not.toContain('is_manager');
  });
});

describe('reviews, goals, trainings and announcements', () => {
  const withRows = async <T>(rows: Record<string, unknown[]>, run: () => Promise<T>): Promise<T> => {
    const saved: Record<string, unknown[] | undefined> = {};
    for (const key of Object.keys(rows)) saved[key] = ROWS[key];
    Object.assign(ROWS, rows);
    try {
      return await run();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete ROWS[key];
        else ROWS[key] = value;
      }
    }
  };

  const reviewRow = (over: Record<string, unknown> = {}) => ({
    id: 'rv1', employee_id: 'e1', period: 'H1 2026', competencies: { Delivery: 4, Teamwork: 3.5, Ownership: 5, Communication: 2 },
    rating: 'meets', score: '3.63', comment: 'Solid.', status: 'released', released_at: '2026-10-01T00:00:00+00:00',
    reviewer_name: 'Kavitha', reviewed_at: '2026-09-30', employee: { name: 'Aisyah Rahim' }, ...over,
  });

  it('reads the new review columns with no status filter, naming the key the employee embed follows', async () => {
    await withRows({ hr_reviews: [reviewRow()] }, async () => {
      await (await getPeopleData(client)).listReviews();
    });
    const call = calls.find((c) => c.table === 'hr_reviews')!;
    for (const column of ['competencies', 'comment', 'status', 'released_at', 'reviewer_name', 'reviewed_at']) {
      expect(call.columns).toContain(column);
    }
    expect(call.columns).toContain('employee:hr_employees!hr_reviews_employee_id_org_id_fkey(name)');
    expect(call.filters.map((f) => f[1])).toEqual(['org_id']);
  });

  it('names the key the employee embed of a goal follows', async () => {
    await (await getPeopleData(client)).listGoals();
    expect(calls.find((c) => c.table === 'hr_goals')!.columns).toContain(
      'employee:hr_employees!hr_goals_employee_id_org_id_fkey(name)',
    );
  });

  it('shapes a review: a numeric score, the name, the scores, a draft kept a draft', async () => {
    const list = await withRows(
      { hr_reviews: [reviewRow(), reviewRow({ id: 'rv2', status: 'draft', released_at: null, comment: null })] },
      async () => (await getPeopleData(client)).listReviews(),
    );
    expect(list[0]).toMatchObject({
      id: 'rv1', employee_name: 'Aisyah Rahim', score: 3.63, status: 'released', comment: 'Solid.',
      competencies: { Delivery: 4, Teamwork: 3.5, Ownership: 5, Communication: 2 },
    });
    expect(list[0]).not.toHaveProperty('employee');
    expect(list[1]).toMatchObject({ status: 'draft', released_at: null, comment: null });
  });

  it('treats anything that is not exactly "released" as a draft, so a surprise value never reaches a member', async () => {
    const list = await withRows(
      { hr_reviews: [reviewRow({ id: 'a', status: 'Released' }), reviewRow({ id: 'b', status: null }), reviewRow({ id: 'c', status: undefined })] },
      async () => (await getPeopleData(client)).listReviews(),
    );
    expect(list.map((r) => r.status)).toEqual(['draft', 'draft', 'draft']);
  });

  it('reads an old-shaped review (empty competencies, draft) without throwing or NaN', async () => {
    const list = await withRows(
      {
        hr_reviews: [
          reviewRow({ id: 'old', competencies: {}, status: 'draft', released_at: null, comment: null }),
          reviewRow({ id: 'odd1', competencies: null }),
          reviewRow({ id: 'odd2', competencies: [4, 5] }),
          reviewRow({ id: 'odd3', competencies: { Delivery: 'x', Teamwork: null, Ownership: 4 } }),
          reviewRow({ id: 'odd4', score: null }),
        ],
      },
      async () => (await getPeopleData(client)).listReviews(),
    );
    expect(list.map((r) => r.competencies)).toEqual([{}, {}, {}, { Ownership: 4 }, expect.any(Object)]);
    expect(list[4].score).toBe(0);
    expect(JSON.stringify(list)).not.toMatch(/NaN|Infinity/);
  });

  it('reads a course without its stored status, and an enrolment with its completion time', async () => {
    const enrolments = await withRows(
      {
        hr_trainings: [{ id: 't1', title: 'Excel', category: null, provider: null, starts_on: '2026-11-01', ends_on: '2026-11-02' }],
        hr_training_enrolments: [
          { id: 'en1', employee_id: 'e1', training_id: 't1', completed: true, completed_at: '2026-11-02T10:00:00+00:00' },
          { id: 'en2', employee_id: 'e2', training_id: 't1', completed: false },
        ],
      },
      async () => {
        const data = await getPeopleData(client);
        await data.listTrainings();
        return data.listTrainingEnrolments();
      },
    );
    expect(calls.find((c) => c.table === 'hr_trainings')!.columns).not.toContain('status');
    expect(calls.find((c) => c.table === 'hr_training_enrolments')!.columns).toContain('completed_at');
    expect(enrolments.map((e) => e.completed_at)).toEqual(['2026-11-02T10:00:00+00:00', null]);
  });

  describe('announcements and the unread flag', () => {
    const ann = (id: string, published_at: string | null, over: Record<string, unknown> = {}) => ({
      id, title: id, body: 'b', category: 'general', status: published_at ? 'published' : 'draft', published_at,
      author_name: published_at ? 'Siti' : null, edited_at: null, ...over,
    });
    const list = (rows: unknown[], reads: unknown[] = []) =>
      withRows({ hr_announcements: rows, hr_announcement_reads: reads }, async () => (await getPeopleData(client)).listAnnouncements());

    it('reads the status, the edit time and the author, drafts last, with no status filter', async () => {
      SINGLE.org_members = { created_at: '2026-01-01T00:00:00+00:00' };
      await list([ann('a1', '2026-10-01T00:00:00+00:00')]);
      const call = calls.find((c) => c.table === 'hr_announcements')!;
      for (const column of ['status', 'published_at', 'author_name', 'edited_at']) expect(call.columns).toContain(column);
      expect(call.filters.map((f) => f[1])).toEqual(['org_id']);
      expect(call.nullsLast).toEqual(['published_at']);
    });

    it('is unread when published after joining and not marked; read when marked; not unread when published before joining', async () => {
      SINGLE.org_members = { created_at: '2026-09-01T00:00:00+00:00' };
      const rows = await list(
        [
          ann('new', '2026-10-01T00:00:00+00:00'),
          ann('marked', '2026-10-02T00:00:00+00:00'),
          ann('before-joining', '2026-08-01T00:00:00+00:00'),
        ],
        [{ announcement_id: 'marked' }],
      );
      expect(Object.fromEntries(rows.map((r) => [r.id, r.unread]))).toEqual({ new: true, marked: false, 'before-joining': false });
    });

    it('asks only for the caller\'s own marks and join time in this workspace', async () => {
      SINGLE.org_members = { created_at: '2026-09-01T00:00:00+00:00' };
      await list([ann('new', '2026-10-01T00:00:00+00:00')]);
      const marks = calls.find((c) => c.table === 'hr_announcement_reads')!;
      expect(marks.filters).toContainEqual(['eq', 'user_id', 'u1']);
      const member = calls.find((c) => c.table === 'org_members')!;
      expect(member.filters).toContainEqual(['eq', 'org_id', 'o1']);
      expect(member.filters).toContainEqual(['eq', 'user_id', 'u1']);
    });

    it('never flags a draft, and does not look up marks when nothing is published', async () => {
      const rows = await list([ann('d', null)]);
      expect(rows[0]).toMatchObject({ status: 'draft', published_at: null, unread: false });
      expect(calls.some((c) => c.table === 'hr_announcement_reads' || c.table === 'org_members')).toBe(false);
    });

    it('flags nothing without a session or without a membership', async () => {
      env.user = null;
      const anon = await list([ann('new', '2026-10-01T00:00:00+00:00')]);
      expect(anon[0].unread).toBe(false);
      env.user = { id: 'u1' };
      const rows = await list([ann('new', '2026-10-01T00:00:00+00:00')]);
      expect(rows[0].unread).toBe(false);
    });

    it('treats a status that is not exactly "published" as a draft', async () => {
      SINGLE.org_members = { created_at: '2026-01-01T00:00:00+00:00' };
      const rows = await list([ann('x', '2026-10-01T00:00:00+00:00', { status: 'Published' }), ann('y', '2026-10-01T00:00:00+00:00', { status: undefined })]);
      expect(rows.map((r) => [r.status, r.unread])).toEqual([['draft', false], ['draft', false]]);
    });

    it('fails the whole read when the marks cannot be read, rather than showing everything as read', async () => {
      SINGLE.org_members = { __error: true };
      await expect(list([ann('new', '2026-10-01T00:00:00+00:00')])).rejects.toBeTruthy();
    });
  });
});

describe('isUnread', () => {
  const context = (joinedAt: string | null, read: string[] = []) => ({ joinedAt, read: new Set(read) });
  const row = (over: Partial<{ id: string; status: string; published_at: string | null }> = {}) => ({
    id: 'a', status: 'published', published_at: '2026-10-02T00:00:00.000100+00:00', ...over,
  });

  it('needs published, after joining, and not marked', () => {
    expect(isUnread(row(), context('2026-10-01T00:00:00+00:00'))).toBe(true);
    expect(isUnread(row({ status: 'draft', published_at: null }), context('2026-10-01T00:00:00+00:00'))).toBe(false);
    expect(isUnread(row(), context('2026-10-01T00:00:00+00:00', ['a']))).toBe(false);
    expect(isUnread(row(), context(null))).toBe(false);
    expect(isUnread(row({ published_at: null }), context('2026-10-01T00:00:00+00:00'))).toBe(false);
  });

  it('compares to the microsecond: strictly after, not at or before', () => {
    const joined = '2026-10-02T00:00:00.000100+00:00';
    expect(isUnread(row({ published_at: '2026-10-02T00:00:00.000101+00:00' }), context(joined))).toBe(true);
    expect(isUnread(row({ published_at: '2026-10-02T00:00:00.000100+00:00' }), context(joined))).toBe(false);
    expect(isUnread(row({ published_at: '2026-10-02T00:00:00.000099+00:00' }), context(joined))).toBe(false);
  });

  it('compares instants, not text, so two offsets for the same moment are equal', () => {
    expect(isUnread(row({ published_at: '2026-10-02T08:00:00+08:00' }), context('2026-10-02T00:00:00+00:00'))).toBe(false);
    expect(isUnread(row({ published_at: '2026-10-02T08:00:01+08:00' }), context('2026-10-02T00:00:00+00:00'))).toBe(true);
  });
});
