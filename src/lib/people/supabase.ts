import type { SupabaseClient } from '@supabase/supabase-js';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { createSeedPeopleData } from './seed';
import type {
  Announcement,
  AttendanceDay,
  Claim,
  Department,
  Employee,
  EmployeePrivate,
  Goal,
  HrDocument,
  LeaveBalance,
  LeaveRequest,
  Letter,
  OvertimeRecord,
  PayrollRun,
  Payslip,
  PaymentVoucher,
  PeopleData,
  PeopleSettings,
  PublicHoliday,
  Review,
  Scorecard,
  Shift,
  TimeOffRequest,
  TimesheetEntry,
  Training,
  TrainingEnrolment,
} from './types';
import { DEFAULT_PEOPLE_SETTINGS } from './types';

/** The API answers with at most this many rows per request. */
const PAGE_SIZE = 1000;
/** Where reading a long table stops: 5,000 rows. */
const MAX_PAGES = 5;

const NAME = 'employee:hr_employees(name)';
const EMPLOYEE_COLUMNS =
  'id,user_id,employee_no,name,work_email,department_id,designation,employment_type,is_manager,join_date,status,' +
  'date_of_birth_day,date_of_birth_month,created_at,department:hr_departments(name)';
const PRIVATE_COLUMNS =
  'employee_id,nric,date_of_birth,phone,address,base_salary_cents,bank_name,bank_account,epf_no,socso_no,tax_no,' +
  'emergency_contact_name,emergency_contact_phone';
const LEAVE_COLUMNS = `id,employee_id,leave_type,start_date,end_date,days,half_day,reason,status,decision_note,created_at,${NAME}`;
const TIME_OFF_COLUMNS = `id,employee_id,off_date,start_time,end_time,reason,status,decision_note,created_at,${NAME}`;
const CLAIM_COLUMNS = `id,employee_id,category,amount_cents,claim_date,description,has_receipt,status,decision_note,receipt_path,paid_on,paid_reference,created_at,${NAME}`;
const OVERTIME_COLUMNS = `id,employee_id,work_date,hours,rate_multiplier,amount_cents,hourly_rate_cents,day_kind,reason,decision_note,status,created_at,${NAME}`;
const PAYSLIP_COLUMNS =
  `id,employee_id,payroll_run_id,period_month,gross_cents,epf_cents,socso_cents,eis_cents,pcb_cents,net_cents,status,${NAME}`;
const GOAL_COLUMNS = `id,employee_id,title,progress,due_date,status,${NAME}`;
const SCORECARD_COLUMNS = `id,employee_id,period,score,competencies,${NAME}`;
const DOCUMENT_COLUMNS = `id,employee_id,title,doc_type,status,issued_on,expires_on,${NAME}`;
const LETTER_COLUMNS = `id,employee_id,letter_type,title,status,issued_on,created_at,${NAME}`;
const VOUCHER_COLUMNS = 'id,voucher_no,payee,voucher_type,amount_cents,issued_date,status';
const SETTINGS_COLUMNS = 'work_week,default_annual_leave_days,default_medical_leave_days,default_emergency_leave_days,overtime_rates,notifications';
const REVIEW_COLUMNS = `id,employee_id,period,rating,score,reviewer_name,reviewed_at,${NAME}`;

type Named = { name?: string | null } | null | undefined;
type WithEmployee<T> = Omit<T, 'employee_name'> & { employee: Named };
type EmployeeRow = Omit<Employee, 'department_name'> & { department: Named };
type Order = { col: string; asc: boolean; nullsLast?: boolean };
type Options = { window?: { column: string; from: string; to: string }; eq?: [string, string | number] };

const UNKNOWN = 'Unknown';

function named<T extends { employee: Named }>(row: T): Omit<T, 'employee'> & { employee_name: string } {
  const { employee, ...rest } = row;
  return { ...rest, employee_name: employee?.name ?? UNKNOWN };
}

const days = (value: number | null | undefined, fallback: number): number =>
  value === null || value === undefined ? fallback : Number(value);

/** A settings row with every missing key filled from the table's own defaults. */
function withDefaults(row: Partial<PeopleSettings> | null | undefined): PeopleSettings {
  const d = DEFAULT_PEOPLE_SETTINGS;
  if (!row) return { ...d, work_week: [...d.work_week], overtime_rates: { ...d.overtime_rates }, notifications: {} };
  return {
    work_week: Array.isArray(row.work_week) ? row.work_week : [...d.work_week],
    default_annual_leave_days: days(row.default_annual_leave_days, d.default_annual_leave_days),
    default_medical_leave_days: days(row.default_medical_leave_days, d.default_medical_leave_days),
    default_emergency_leave_days: days(row.default_emergency_leave_days, d.default_emergency_leave_days),
    overtime_rates: { ...d.overtime_rates, ...(row.overtime_rates ?? {}) },
    notifications: row.notifications ?? {},
  };
}

/**
 * RLS-scoped {@link PeopleData} over Supabase. Reads are filtered to `orgId`
 * (the caller's current workspace) as a selector; Postgres RLS is what decides
 * which rows come back: every row for an owner or admin, only their own
 * personal rows for anyone else. Nothing here filters by role.
 */
export function createSupabasePeopleData(client: SupabaseClient, orgId: string): PeopleData {
  async function rows<T>(table: string, columns: string, order: Order, options: Options = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let query = client.from(table).select(columns).eq('org_id', orgId);
      if (options.eq) query = query.eq(options.eq[0], options.eq[1]);
      if (options.window) {
        query = query.gte(options.window.column, options.window.from).lte(options.window.column, options.window.to);
      }
      const { data, error } = await query
        .order(order.col, order.nullsLast ? { ascending: order.asc, nullsFirst: false } : { ascending: order.asc })
        // A second, unique order keeps pages from overlapping when many rows share a date.
        .order('id', { ascending: true })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (error) throw error;
      const batch = (data ?? []) as unknown as T[];
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return out;
  }

  const byWorkDate = (from: string, to: string): Options => ({ window: { column: 'work_date', from, to } });

  return {
    listDepartments: () => rows<Department>('hr_departments', 'id,name,created_at', { col: 'name', asc: true }),
    listEmployees: async () =>
      (await rows<EmployeeRow>('hr_employees', EMPLOYEE_COLUMNS, { col: 'name', asc: true })).map(
        ({ department, ...row }) => ({ ...row, department_name: department?.name ?? null }),
      ),
    getEmployeePrivate: async (employeeId) => {
      const { data, error } = await client
        .from('hr_employee_private')
        .select(PRIVATE_COLUMNS)
        .eq('org_id', orgId)
        .eq('employee_id', employeeId)
        .maybeSingle();
      if (error) throw error;
      return (data as EmployeePrivate | null) ?? null;
    },
    listLeaveRequests: async () =>
      (await rows<WithEmployee<LeaveRequest>>('hr_leave_requests', LEAVE_COLUMNS, { col: 'created_at', asc: false })).map(named),
    listLeaveBalances: (year) =>
      rows<LeaveBalance>('hr_leave_balances', 'id,employee_id,leave_type,year,entitled_days,used_days',
        { col: 'leave_type', asc: true }, { eq: ['year', year] }),
    listTimeOffRequests: async () =>
      (await rows<WithEmployee<TimeOffRequest>>('hr_time_off_requests', TIME_OFF_COLUMNS, { col: 'created_at', asc: false })).map(named),
    listClaims: async () =>
      (await rows<WithEmployee<Claim>>('hr_claims', CLAIM_COLUMNS, { col: 'created_at', asc: false })).map(named),
    listOvertime: async () =>
      (await rows<WithEmployee<OvertimeRecord>>('hr_overtime_records', OVERTIME_COLUMNS, { col: 'created_at', asc: false })).map(named),
    listAttendance: (from, to) =>
      rows<AttendanceDay>('hr_attendance_days', 'id,employee_id,work_date,clock_in,clock_out,status',
        { col: 'work_date', asc: false }, byWorkDate(from, to)),
    listTimesheet: (from, to) =>
      rows<TimesheetEntry>('hr_timesheet_entries', 'id,employee_id,work_date,hours,billable_hours',
        { col: 'work_date', asc: false }, byWorkDate(from, to)),
    listShifts: (from, to) =>
      rows<Shift>('hr_shifts', 'id,employee_id,work_date,shift', { col: 'work_date', asc: true }, byWorkDate(from, to)),
    listPublicHolidays: () =>
      rows<PublicHoliday>('hr_public_holidays', 'id,name,holiday_date,scope,state', { col: 'holiday_date', asc: true }),
    listPayrollRuns: () =>
      rows<PayrollRun>('hr_payroll_runs', 'id,period_month,status,paid_at', { col: 'period_month', asc: false }),
    listPayslips: async () =>
      (await rows<WithEmployee<Payslip>>('hr_payslips', PAYSLIP_COLUMNS, { col: 'period_month', asc: false })).map(named),
    listGoals: async () =>
      (await rows<WithEmployee<Goal>>('hr_goals', GOAL_COLUMNS, { col: 'due_date', asc: true })).map(named),
    listScorecards: async () =>
      (await rows<WithEmployee<Scorecard>>('hr_scorecards', SCORECARD_COLUMNS, { col: 'score', asc: false })).map(named),
    listReviews: async () =>
      (await rows<WithEmployee<Review>>('hr_reviews', REVIEW_COLUMNS, { col: 'score', asc: false })).map(named),
    listTrainings: () =>
      rows<Training>('hr_trainings', 'id,title,category,provider,starts_on,ends_on,status', { col: 'starts_on', asc: false }),
    listTrainingEnrolments: () =>
      rows<TrainingEnrolment>('hr_training_enrolments', 'id,employee_id,training_id,completed', { col: 'created_at', asc: false }),
    listAnnouncements: () =>
      rows<Announcement>('hr_announcements', 'id,title,body,category,published_at,author_name', { col: 'published_at', asc: false }),
    listDocuments: async () =>
      (await rows<WithEmployee<HrDocument>>('hr_documents', DOCUMENT_COLUMNS, { col: 'issued_on', asc: false, nullsLast: true })).map(named),
    listLetters: async () =>
      (await rows<WithEmployee<Letter>>('hr_letters', LETTER_COLUMNS, { col: 'created_at', asc: false })).map(named),
    listPaymentVouchers: () =>
      rows<PaymentVoucher>('hr_payment_vouchers', VOUCHER_COLUMNS, { col: 'issued_date', asc: false }),
    getSettings: async () => {
      const { data, error } = await client.from('hr_settings').select(SETTINGS_COLUMNS).eq('org_id', orgId).maybeSingle();
      if (error) throw error;
      return withDefaults(data as Partial<PeopleSettings> | null);
    },
  };
}

const none = async () => [];

const EMPTY_PEOPLE_DATA: PeopleData = {
  listDepartments: none,
  listEmployees: none,
  getEmployeePrivate: async () => null,
  listLeaveRequests: none,
  listLeaveBalances: none,
  listTimeOffRequests: none,
  listClaims: none,
  listOvertime: none,
  listAttendance: none,
  listTimesheet: none,
  listShifts: none,
  listPublicHolidays: none,
  listPayrollRuns: none,
  listPayslips: none,
  listGoals: none,
  listScorecards: none,
  listReviews: none,
  listTrainings: none,
  listTrainingEnrolments: none,
  listAnnouncements: none,
  listDocuments: none,
  listLetters: none,
  listPaymentVouchers: none,
  getSettings: async () => withDefaults(null),
};

/**
 * Request-scoped provider selection: RLS-scoped Supabase in prod, the sample
 * data only when no project is configured (dev, preview, tests). One place, so
 * the route and every screen stay consistent.
 */
export async function getPeopleData(client: SupabaseClient): Promise<PeopleData> {
  if (!hasSupabaseEnv()) return createSeedPeopleData();
  const org = await getCurrentOrg(client);
  // Signed in but not yet in a workspace: show nothing, never the fictional data.
  return org ? createSupabasePeopleData(client, org.orgId) : EMPTY_PEOPLE_DATA;
}
