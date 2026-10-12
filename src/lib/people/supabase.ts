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
  LetterTemplate,
  OvertimeRecord,
  PayrollRun,
  Payslip,
  PayslipLine,
  PaymentVoucher,
  PeopleData,
  PeopleSettings,
  PublicHoliday,
  Review,
  Shift,
  TimeOffRequest,
  TimesheetEntry,
  Training,
  TrainingEnrolment,
  Weekday,
} from './types';
import { STATUTORY_FIELDS } from './statutory-fields';
import { DEFAULT_PEOPLE_SETTINGS, WEEKDAYS } from './types';


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
// A payslip reaches an employee by a composite foreign key (employee_id, org_id), which Postgres named by its
// columns. The hint keeps the embed unambiguous if another path between the tables ever appears.
const PAYSLIP_NAME = 'employee:hr_employees!hr_payslips_employee_id_org_id_fkey(name)';
// An overtime line reaches its record by `overtime_record_id` (default constraint name); the record's day lets the
// screen count overtime paid late. Other lines, and a record the caller cannot read, give null.
const LINE_WORK_DATE = 'overtime:hr_overtime_records!hr_payslip_lines_overtime_record_id_fkey(work_date)';
const LEAVE_COLUMNS = `id,employee_id,leave_type,start_date,end_date,days,half_day,reason,status,decision_note,created_at,${NAME}`;
const TIME_OFF_COLUMNS = `id,employee_id,off_date,start_time,end_time,reason,status,decision_note,created_at,${NAME}`;
const CLAIM_COLUMNS = `id,employee_id,category,amount_cents,claim_date,description,has_receipt,status,decision_note,receipt_path,paid_on,paid_reference,created_at,${NAME}`;
// The payslip is embedded through the named constraint: the lines table gives a second path from an overtime
// record to a payslip. A member gets null while the run is a draft, which reads as "not paid".
const OVERTIME_COLUMNS =
  'id,employee_id,work_date,hours,rate_multiplier,amount_cents,hourly_rate_cents,day_kind,reason,decision_note,status,created_at,' +
  `payslip:hr_payslips!hr_overtime_records_payslip_id_fkey(period_month,status),${NAME}`;
const PAYSLIP_COLUMNS =
  'id,employee_id,payroll_run_id,period_month,basic_cents,gross_cents,epf_cents,socso_cents,eis_cents,pcb_cents,' +
  `other_deductions_cents,net_cents,set_by_hr,status,lines:hr_payslip_lines(id,payslip_id,kind,source,label,amount_cents,created_at,${LINE_WORK_DATE}),${PAYSLIP_NAME}`;
// A goal and a review reach their employee by a composite foreign key (employee_id, org_id), named by its columns.
const GOAL_NAME = 'employee:hr_employees!hr_goals_employee_id_org_id_fkey(name)';
const REVIEW_NAME = 'employee:hr_employees!hr_reviews_employee_id_org_id_fkey(name)';
const GOAL_COLUMNS = `id,employee_id,title,progress,due_date,status,${GOAL_NAME}`;
// `file_path` is never selected: the app reads it on the server only, to sign a link (document-files-server.ts).
// The four file columns go together in the database, so a file name means a file is attached.
const DOCUMENT_COLUMNS = `id,employee_id,title,doc_type,expires_on,file_name,file_size,file_type,source,ack_requested,acknowledged_at,created_at,${NAME}`;
const LETTER_COLUMNS = `id,employee_id,letter_type,title,body,status,issued_on,ack_requested,acknowledged_at,created_at,${NAME}`;
const TEMPLATE_COLUMNS = 'id,name,letter_type,title,body';
const VOUCHER_COLUMNS = 'id,voucher_no,payee,voucher_type,amount_cents,issued_date,status';
const SETTINGS_COLUMNS = 'work_week,work_start_time,late_grace_minutes,default_annual_leave_days,default_medical_leave_days,default_emergency_leave_days,overtime_rates,notifications';
const ATTENDANCE_COLUMNS = 'id,employee_id,work_date,clock_in,clock_out,status,corrected_at,correction_note';
const REVIEW_COLUMNS =
  'id,employee_id,period,competencies,rating,score,comment,status,released_at,reviewer_name,reviewed_at,' + REVIEW_NAME;
const TRAINING_COLUMNS = 'id,title,category,provider,starts_on,ends_on';
const ENROLMENT_COLUMNS = 'id,employee_id,training_id,completed,completed_at';
const ANNOUNCEMENT_COLUMNS = 'id,title,body,category,status,published_at,author_name,edited_at';

type Named = { name?: string | null } | null | undefined;
type WithEmployee<T> = Omit<T, 'employee_name'> & { employee: Named };
type PayslipRow = WithEmployee<Omit<Payslip, 'lines'>> & {
  lines: (Omit<PayslipLine, 'work_date'> & { created_at: string; overtime?: { work_date: string } | null })[] | null;
};
type OvertimeRow = WithEmployee<Omit<OvertimeRecord, 'paid_month'>> & {
  payslip: { period_month: string; status: string } | null;
};
type EmployeeRow = Omit<Employee, 'department_name'> & { department: Named };
type Order = { col: string; asc: boolean; nullsLast?: boolean };
type Options = { window?: { column: string; from: string; to: string }; eq?: [string, string | number] };

const UNKNOWN = 'Unknown';

/** A timestamp as [whole seconds in milliseconds, microseconds of fraction]; text compares wrongly (`:00+00` against `:00.000002+00`). */
function instant(value: string): [number, number] {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  const ms = Date.parse(fraction ? value.replace(/\.\d+/, '') : value);
  const micros = Number(fraction.padEnd(6, '0').slice(0, 6));
  return [Number.isNaN(ms) ? 0 : ms, micros];
}

function byMade(a: string, b: string): number {
  const [ams, amicro] = instant(a);
  const [bms, bmicro] = instant(b);
  // Whole seconds, then the fraction as microseconds; the raw text is the last resort.
  return ams - bms || amicro - bmicro || (a < b ? -1 : a > b ? 1 : 0);
}

const SOURCE_ORDER: Record<string, number> = { joiner: 0, unpaid_leave: 1, overtime: 2, hr: 3 };

/**
 * A payslip's lines in the order the database stamps them: by source (joiner, unpaid leave, overtime, HR's own),
 * then when made, then id. Sorting here keeps that order whatever order the nested select comes back in.
 */
function payslipOf({ lines, ...row }: PayslipRow): Payslip {
  const ordered = [...(lines ?? [])].sort(
    (a, b) =>
      (SOURCE_ORDER[a.source] ?? 9) - (SOURCE_ORDER[b.source] ?? 9) ||
      byMade(a.created_at, b.created_at) ||
      a.id.localeCompare(b.id),
  );
  return {
    ...named(row),
    set_by_hr: STATUTORY_FIELDS.filter((field) => (row.set_by_hr ?? []).includes(field)),
    lines: ordered.map((line) => ({
      id: line.id,
      payslip_id: line.payslip_id,
      kind: line.kind,
      source: line.source,
      label: line.label,
      amount_cents: line.amount_cents,
      work_date: line.overtime?.work_date ?? null,
    })),
  };
}

/** `YYYY-MM` of the payslip an overtime record was paid on, only when that payslip is paid and readable. */
function overtimeOf({ payslip, ...row }: OvertimeRow): OvertimeRecord {
  return {
    ...named(row),
    paid_month: payslip && payslip.status === 'paid' ? payslip.period_month.slice(0, 7) : null,
  };
}

/** True when `a` is a later instant than `b` (microseconds compared, not just milliseconds). */
export function isAfter(a: string, b: string): boolean {
  const [ams, amicro] = instant(a);
  const [bms, bmicro] = instant(b);
  return ams - bms > 0 || (ams === bms && amicro > bmicro);
}

export type UnreadContext = { joinedAt: string | null; read: Set<string> };
const NO_MARKS: UnreadContext = { joinedAt: null, read: new Set() };

/**
 * Unread for a person: published, published strictly after they joined the workspace, and not marked read by them.
 * An owner and an admin count the same way (they have a join time too). Without a join time (no session or no
 * membership) nothing is unread. The database function `hr_unread_announcements` counts by the same rule.
 */
export function isUnread(
  row: { id: string; status: string; published_at: string | null },
  context: UnreadContext,
): boolean {
  return (
    row.status === 'published' &&
    row.published_at !== null &&
    context.joinedAt !== null &&
    !context.read.has(row.id) &&
    isAfter(row.published_at, context.joinedAt)
  );
}

type ReviewRow = WithEmployee<Omit<Review, 'competencies' | 'score' | 'status'>> & {
  competencies: unknown;
  score: number | string;
  status: string;
};
type EnrolmentRow = Omit<TrainingEnrolment, 'completed_at'> & { completed_at?: string | null };
type AnnouncementRow = Omit<Announcement, 'unread' | 'status' | 'edited_at' | 'published_at'> & {
  status: string;
  published_at: string | null;
  edited_at?: string | null;
};

/**
 * A review as the screens read it. Anything that is not exactly `released` is a draft (fail closed); the scores are
 * the finite numbers among the stored ones, so a review with `{}` has none and nothing downstream turns NaN.
 */
function reviewOf(row: ReviewRow): Review {
  const { competencies, score, status, ...rest } = named(row);
  const scores: Record<string, number> = {};
  if (typeof competencies === 'object' && competencies !== null && !Array.isArray(competencies)) {
    for (const [name, value] of Object.entries(competencies)) {
      if (typeof value === 'number' && Number.isFinite(value)) scores[name] = value;
    }
  }
  return {
    ...rest,
    competencies: scores as Review['competencies'],
    score: Number.isFinite(Number(score)) ? Number(score) : 0,
    status: status === 'released' ? 'released' : 'draft',
    comment: rest.comment ?? null,
    released_at: rest.released_at ?? null,
  };
}

/** An announcement with its unread flag for the caller. Anything that is not exactly `published` is a draft (fail closed). */
function announcementOf(row: AnnouncementRow, context: UnreadContext): Announcement {
  const status = row.status === 'published' ? 'published' : 'draft';
  return {
    ...row,
    status,
    published_at: row.published_at ?? null,
    edited_at: row.edited_at ?? null,
    unread: isUnread({ id: row.id, status, published_at: row.published_at ?? null }, context),
  };
}

function named<T extends { employee: Named }>(row: T): Omit<T, 'employee'> & { employee_name: string } {
  const { employee, ...rest } = row;
  return { ...rest, employee_name: employee?.name ?? UNKNOWN };
}

const days = (value: number | null | undefined, fallback: number): number =>
  value === null || value === undefined ? fallback : Number(value);

/**
 * The stored work week as a Monday-first list of known days. A list naming no known day is no list at all: the
 * database treats it as Monday to Friday, and so does this.
 */
function weekOf(value: unknown, fallback: Weekday[]): Weekday[] {
  if (!Array.isArray(value)) return [...fallback];
  const week = WEEKDAYS.filter((day) => value.includes(day));
  return week.length > 0 ? week : [...fallback];
}

/** `HH:MM:SS` from the database as `HH:MM`. */
function timeOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : fallback;
}

type AttendanceRow = Omit<AttendanceDay, 'corrected'> & { corrected_at: string | null };

/** A settings row with every missing key filled from the table's own defaults. */
function withDefaults(row: Partial<PeopleSettings> | null | undefined): PeopleSettings {
  const d = DEFAULT_PEOPLE_SETTINGS;
  if (!row) return { ...d, work_week: [...d.work_week], overtime_rates: { ...d.overtime_rates }, notifications: {} };
  return {
    work_week: weekOf(row.work_week, d.work_week),
    work_start_time: timeOf(row.work_start_time, d.work_start_time),
    late_grace_minutes: days(row.late_grace_minutes, d.late_grace_minutes),
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

  /**
   * What decides "unread" for the caller: when they joined this workspace and which announcements they marked.
   * Row level security gives a person only their own marks. Someone with no session, or no membership, has none.
   */
  async function unreadContext(): Promise<UnreadContext> {
    const {
      data: { user },
    } = await client.auth.getUser();
    if (!user) return NO_MARKS;
    const { data: member, error } = await client
      .from('org_members')
      .select('created_at')
      .eq('org_id', orgId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) throw error;
    const joinedAt = (member as { created_at?: string } | null)?.created_at ?? null;
    if (joinedAt === null) return NO_MARKS;
    const read = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { data, error: readError } = await client
        .from('hr_announcement_reads')
        .select('announcement_id')
        .eq('user_id', user.id)
        .order('announcement_id', { ascending: true })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (readError) throw readError;
      const batch = (data ?? []) as { announcement_id: string }[];
      for (const mark of batch) read.add(mark.announcement_id);
      if (batch.length < PAGE_SIZE) break;
    }
    return { joinedAt, read };
  }

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
      (await rows<OvertimeRow>('hr_overtime_records', OVERTIME_COLUMNS, { col: 'created_at', asc: false })).map(overtimeOf),
    listAttendance: (from, to) =>
      rows<AttendanceRow>('hr_attendance_days', ATTENDANCE_COLUMNS, { col: 'work_date', asc: false }, byWorkDate(from, to)).then(
        (list) =>
          list.map(({ corrected_at, correction_note, ...day }) => ({
            ...day,
            corrected: corrected_at !== null && corrected_at !== undefined,
            correction_note: correction_note ?? null,
          })),
      ),
    listTimesheet: (from, to) =>
      rows<TimesheetEntry>('hr_timesheet_entries', 'id,employee_id,work_date,hours,billable_hours',
        { col: 'work_date', asc: false }, byWorkDate(from, to)),
    listShifts: (from, to) =>
      rows<Shift>('hr_shifts', 'id,employee_id,work_date,shift', { col: 'work_date', asc: true }, byWorkDate(from, to)),
    listPublicHolidays: () =>
      rows<PublicHoliday>('hr_public_holidays', 'id,name,holiday_date,scope,state', { col: 'holiday_date', asc: true }),
    listPayrollRuns: () =>
      // There is no way to turn `paid_by` (an auth user id) into a name without a profile lookup, so none is read.
      rows<Omit<PayrollRun, 'paid_by_name'>>('hr_payroll_runs', 'id,period_month,status,paid_at', {
        col: 'period_month',
        asc: false,
      }).then((list) => list.map((run) => ({ ...run, paid_by_name: null }))),
    listPayslips: async (employeeId) =>
      (
        await rows<PayslipRow>(
          'hr_payslips',
          PAYSLIP_COLUMNS,
          { col: 'period_month', asc: false },
          employeeId ? { eq: ['employee_id', employeeId] } : {},
        )
      ).map(payslipOf),
    listGoals: async () =>
      (await rows<WithEmployee<Goal>>('hr_goals', GOAL_COLUMNS, { col: 'due_date', asc: true })).map(named),
    // No status filter on reviews or announcements: the database decides who reads a draft (an owner or admin, and
    // the demo), and the models filter again.
    listReviews: async () =>
      (await rows<ReviewRow>('hr_reviews', REVIEW_COLUMNS, { col: 'score', asc: false })).map(reviewOf),
    listTrainings: () => rows<Training>('hr_trainings', TRAINING_COLUMNS, { col: 'starts_on', asc: false }),
    listTrainingEnrolments: async () =>
      (await rows<EnrolmentRow>('hr_training_enrolments', ENROLMENT_COLUMNS, { col: 'created_at', asc: false })).map(
        (row) => ({ ...row, completed_at: row.completed_at ?? null }),
      ),
    listAnnouncements: async () => {
      const list = await rows<AnnouncementRow>('hr_announcements', ANNOUNCEMENT_COLUMNS, {
        col: 'published_at',
        asc: false,
        nullsLast: true,
      });
      // The caller's own read marks and join time are read only when there is something published to be unread.
      const marks = list.some((row) => row.status === 'published') ? await unreadContext() : NO_MARKS;
      return list.map((row) => announcementOf(row, marks));
    },
    listDocuments: async () =>
      (await rows<WithEmployee<Omit<HrDocument, 'has_file'>>>('hr_documents', DOCUMENT_COLUMNS, { col: 'created_at', asc: false })).map(
        (row) => {
          const doc = named(row);
          return {
            ...doc,
            file_size: doc.file_size === null || doc.file_size === undefined ? null : Number(doc.file_size),
            has_file: doc.file_name !== null && doc.file_name !== undefined,
          };
        },
      ),
    // No status filter on letters or templates: the database decides who reads a draft (an owner or admin, and the
    // demo) and who reads a template, and the models filter again.
    listLetters: async () =>
      (await rows<WithEmployee<Letter>>('hr_letters', LETTER_COLUMNS, { col: 'created_at', asc: false })).map(named),
    listLetterTemplates: () => rows<LetterTemplate>('hr_letter_templates', TEMPLATE_COLUMNS, { col: 'name', asc: true }),
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
  listReviews: none,
  listTrainings: none,
  listTrainingEnrolments: none,
  listAnnouncements: none,
  listDocuments: none,
  listLetters: none,
  listLetterTemplates: none,
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
