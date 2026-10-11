/**
 * Lekiu (`people`) domain types. Field names match the `hr_*` columns one to
 * one, so the Supabase provider maps rows directly and the sample provider can
 * stand in for it in dev and tests. Money is integer cents. Dates are
 * `YYYY-MM-DD`; moments are ISO strings.
 *
 * Who may read a row is the database's decision (see the plan A migrations):
 * a provider returns whatever the caller's session is allowed to see.
 */

/** The fictional employee a demo visitor sees on the "My …" screens. Fixed by the demo seed. */
export const DEMO_EMPLOYEE_ID = 'dea97d89-a5b6-f264-bd42-c6df73f664a7';
export const DEMO_ORG_SLUG = 'rimba-ventures-demo';

export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';
export type EmployeeStatus = 'active' | 'inactive';
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
/** A claim can also be paid once approved; no other request has that step. */
export type ClaimStatus = RequestStatus | 'paid';
export type OvertimeDayKind = 'weekday' | 'rest_day' | 'public_holiday';
export type LeaveType = 'annual' | 'medical' | 'emergency' | 'unpaid' | 'maternity' | 'paternity';
export type ClaimCategory = 'medical' | 'travel' | 'meals' | 'equipment' | 'other';
export type AttendanceStatus = 'present' | 'late' | 'absent' | 'on_leave';
/** A day of the work week, as `hr_settings.work_week` stores it. */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
/** Monday first, the order the database stores a work week in. */
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export type ShiftKind = 'morning' | 'night' | 'off';

export type Department = { id: string; name: string; created_at: string };

/** The staff directory row: nothing here is private. */
export type Employee = {
  id: string;
  user_id: string | null;
  employee_no: string;
  name: string;
  work_email: string | null;
  department_id: string | null;
  /** The department's name, joined in by the provider. */
  department_name: string | null;
  designation: string | null;
  employment_type: EmploymentType;
  is_manager: boolean;
  join_date: string | null;
  status: EmployeeStatus;
  date_of_birth_day: number | null;
  date_of_birth_month: number | null;
  created_at: string;
};

/** Pay and identity details. Readable by HR and by the employee themselves. */
export type EmployeePrivate = {
  employee_id: string;
  nric: string | null;
  date_of_birth: string | null;
  phone: string | null;
  address: string | null;
  base_salary_cents: number | null;
  bank_name: string | null;
  bank_account: string | null;
  epf_no: string | null;
  socso_no: string | null;
  tax_no: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
};

export type LeaveRequest = {
  id: string;
  employee_id: string;
  employee_name: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  days: number;
  /** A single date counted as half a day. */
  half_day: boolean;
  reason: string | null;
  status: RequestStatus;
  /** Why an owner or admin rejected it, when they said. */
  decision_note: string | null;
  created_at: string;
};

export type LeaveBalance = {
  id: string;
  employee_id: string;
  leave_type: LeaveType;
  year: number;
  entitled_days: number;
  used_days: number;
};

export type TimeOffRequest = {
  id: string;
  employee_id: string;
  employee_name: string;
  off_date: string;
  /** `HH:MM:SS`. */
  start_time: string;
  end_time: string;
  reason: string | null;
  status: RequestStatus;
  /** Why an owner or admin rejected it, when they said. */
  decision_note: string | null;
  created_at: string;
};

export type Claim = {
  id: string;
  employee_id: string;
  employee_name: string;
  category: ClaimCategory;
  amount_cents: number;
  claim_date: string;
  description: string | null;
  /** True when a receipt was attached, as a file or (in the sample company) just ticked. */
  has_receipt: boolean;
  status: ClaimStatus;
  /** Why an owner or admin rejected it, when they said. */
  decision_note: string | null;
  /** The receipt file in the private bucket; null when there is none. Never shown, never logged. */
  receipt_path: string | null;
  /** The date it was paid, when the status is paid. */
  paid_on: string | null;
  paid_reference: string | null;
  created_at: string;
};

export type OvertimeRecord = {
  id: string;
  employee_id: string;
  employee_name: string;
  work_date: string;
  hours: number;
  rate_multiplier: number;
  /** Fixed when the record was made; 0 while `hourly_rate_cents` is null. */
  amount_cents: number;
  /** Null when no salary was on file: the amount is then not calculated. */
  hourly_rate_cents: number | null;
  day_kind: OvertimeDayKind | null;
  reason: string | null;
  decision_note: string | null;
  status: RequestStatus;
  created_at: string;
  /** `YYYY-MM` of the payroll run that paid this, once that run is paid and the viewer can read its payslip; otherwise null. */
  paid_month: string | null;
};

export type AttendanceDay = {
  id: string;
  employee_id: string;
  work_date: string;
  clock_in: string | null;
  clock_out: string | null;
  status: AttendanceStatus;
  /** An owner or admin set this day (told by `corrected_at`, which outlives the corrector's account). */
  corrected: boolean;
  /** Why it was corrected, when they said. */
  correction_note: string | null;
};

export type TimesheetEntry = {
  id: string;
  employee_id: string;
  work_date: string;
  hours: number;
  billable_hours: number;
};

export type Shift = { id: string; employee_id: string; work_date: string; shift: ShiftKind };

export type PublicHoliday = {
  id: string;
  name: string;
  holiday_date: string;
  scope: 'national' | 'state';
  state: string | null;
};

export type PayrollRun = {
  id: string;
  /** The first day of the month the run pays. */
  period_month: string;
  status: 'draft' | 'paid';
  paid_at: string | null;
  /** Who marked it paid. Null when unknown: the app has no way to turn the user id into a name. */
  paid_by_name: string | null;
};

/** `unpaid` lines subtract from gross, `earning` lines add to it, `deduction` lines come off net. */
export type PayslipLineKind = 'earning' | 'unpaid' | 'deduction';
/** `hr` lines are written by an owner or admin; the rest are worked out by the system. */
export type PayslipLineSource = 'hr' | 'overtime' | 'unpaid_leave' | 'joiner';
export type PayslipLine = {
  id: string;
  payslip_id: string;
  kind: PayslipLineKind;
  source: PayslipLineSource;
  label: string;
  amount_cents: number;
  /** An overtime line: the day the work was done. Null (or absent) for every other line. */
  work_date?: string | null;
};
export type StatutoryField = 'epf' | 'socso' | 'eis' | 'pcb';

export type Payslip = {
  id: string;
  employee_id: string;
  employee_name: string;
  payroll_run_id: string;
  period_month: string;
  /** The salary the payslip started from. */
  basic_cents: number;
  gross_cents: number;
  epf_cents: number;
  socso_cents: number;
  eis_cents: number;
  pcb_cents: number;
  /** The sum of the payslip's deduction lines. */
  other_deductions_cents: number;
  net_cents: number;
  /** Which of the four figures an owner or admin typed over, in the order epf, socso, eis, pcb. */
  set_by_hr: StatutoryField[];
  /** System lines first (joiner, unpaid leave, overtime), then the owner's own, each in the order made. */
  lines: PayslipLine[];
  status: 'pending' | 'paid';
};

export type Goal = {
  id: string;
  employee_id: string;
  employee_name: string;
  title: string;
  progress: number;
  due_date: string | null;
  status: 'on_track' | 'at_risk' | 'done';
};

export type Scorecard = {
  id: string;
  employee_id: string;
  employee_name: string;
  period: string;
  score: number;
  competencies: Record<string, number>;
};

export type Review = {
  id: string;
  employee_id: string;
  employee_name: string;
  period: string;
  rating: 'exceeds' | 'meets' | 'below';
  score: number;
  reviewer_name: string | null;
  reviewed_at: string | null;
};

export type Training = {
  id: string;
  title: string;
  category: string | null;
  provider: string | null;
  starts_on: string | null;
  ends_on: string | null;
  status: 'upcoming' | 'in_progress' | 'completed';
};

export type TrainingEnrolment = {
  id: string;
  employee_id: string;
  training_id: string;
  completed: boolean;
};

export type Announcement = {
  id: string;
  title: string;
  body: string;
  category: 'general' | 'holiday' | 'benefits' | 'strategy' | 'policy';
  published_at: string;
  author_name: string | null;
};

export type DocumentType = 'payslip' | 'contract' | 'letter' | 'tax' | 'benefits';
export type DocumentStatus = 'signed' | 'pending_signature' | 'available' | 'expiring';

export type HrDocument = {
  id: string;
  employee_id: string;
  employee_name: string;
  title: string;
  doc_type: DocumentType;
  status: DocumentStatus;
  issued_on: string | null;
  expires_on: string | null;
};

export type Letter = {
  id: string;
  employee_id: string;
  employee_name: string;
  letter_type: string;
  title: string;
  status: 'draft' | 'issued';
  issued_on: string | null;
  created_at: string;
};

export type PaymentVoucher = {
  id: string;
  voucher_no: string;
  payee: string;
  voucher_type: string;
  amount_cents: number;
  issued_date: string;
  status: 'draft' | 'issued' | 'paid';
};

export type PeopleSettings = {
  /** Monday first. */
  work_week: Weekday[];
  /** `HH:MM`, Malaysia time. */
  work_start_time: string;
  /** Minutes after the start time that still count as on time. */
  late_grace_minutes: number;
  default_annual_leave_days: number;
  default_medical_leave_days: number;
  default_emergency_leave_days: number;
  overtime_rates: { weekday: number; rest_day: number; public_holiday: number };
  notifications: Record<string, boolean>;
};

/** What a workspace with no settings row has: the table's own defaults. */
export const DEFAULT_PEOPLE_SETTINGS: PeopleSettings = {
  work_week: ['mon', 'tue', 'wed', 'thu', 'fri'],
  work_start_time: '09:00',
  late_grace_minutes: 15,
  default_annual_leave_days: 14,
  default_medical_leave_days: 14,
  default_emergency_leave_days: 3,
  overtime_rates: { weekday: 1.5, rest_day: 2, public_holiday: 3 },
  notifications: {},
};

/**
 * Everything the Overview and the lookups read. One provider per request.
 * Each method returns the rows this caller may see: all of them for HR, only
 * their own personal rows for anyone else.
 */
export type PeopleData = {
  listDepartments(): Promise<Department[]>;
  listEmployees(): Promise<Employee[]>;
  /** Null when there is no private row, or the caller may not read it. */
  getEmployeePrivate(employeeId: string): Promise<EmployeePrivate | null>;
  listLeaveRequests(): Promise<LeaveRequest[]>;
  listLeaveBalances(year: number): Promise<LeaveBalance[]>;
  listTimeOffRequests(): Promise<TimeOffRequest[]>;
  listClaims(): Promise<Claim[]>;
  listOvertime(): Promise<OvertimeRecord[]>;
  /** Attendance from `fromDate` to `toDate`, both included. */
  listAttendance(fromDate: string, toDate: string): Promise<AttendanceDay[]>;
  listTimesheet(fromDate: string, toDate: string): Promise<TimesheetEntry[]>;
  listShifts(fromDate: string, toDate: string): Promise<Shift[]>;
  listPublicHolidays(): Promise<PublicHoliday[]>;
  listPayrollRuns(): Promise<PayrollRun[]>;
  /** Every payslip the caller may read, or (with `employeeId`) that one employee's only. */
  listPayslips(employeeId?: string): Promise<Payslip[]>;
  listGoals(): Promise<Goal[]>;
  listScorecards(): Promise<Scorecard[]>;
  listReviews(): Promise<Review[]>;
  listTrainings(): Promise<Training[]>;
  listTrainingEnrolments(): Promise<TrainingEnrolment[]>;
  listAnnouncements(): Promise<Announcement[]>;
  /** hr_documents, newest `issued_on` first. */
  listDocuments(): Promise<HrDocument[]>;
  /** hr_letters, newest `created_at` first. */
  listLetters(): Promise<Letter[]>;
  /** hr_payment_vouchers, newest `issued_date` first. HR only: anyone else gets none. */
  listPaymentVouchers(): Promise<PaymentVoucher[]>;
  /** The workspace's settings, or {@link DEFAULT_PEOPLE_SETTINGS} when there is no row or the caller may not read it. */
  getSettings(): Promise<PeopleSettings>;
};

/** Who is looking: used for wording and defaults, never to decide what they may read. */
export type PeopleViewer = {
  /** The employee record linked to this user, if any. */
  employeeId: string | null;
  /** The linked employee's name, when there is a linked record. For wording only. */
  employeeName?: string;
  /** Owner or admin of the workspace. */
  isHr: boolean;
  /** The current workspace is the demo workspace. */
  isDemo: boolean;
};
