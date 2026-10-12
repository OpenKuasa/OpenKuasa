/**
 * Fictional Rimba Ventures HR data: the dev, preview and test stand-in for the
 * `hr_*` tables. It is the same company the demo workspace shows (the same 20
 * people, the same leave, claims and pay), built from `now` so tests are
 * stable. `private.reseed_demo_people()` writes the same people in SQL.
 */

import { addDays, addMonths, isWeekday, monthLabel, monthStart, todayInMalaysia, weekStart } from './dates';
import {
  DEMO_EMPLOYEE_ID,
  type Announcement,
  type AttendanceDay,
  type AttendanceStatus,
  type Claim,
  type ClaimCategory,
  type Department,
  type Employee,
  type EmployeePrivate,
  type EmploymentType,
  type Goal,
  type HrDocument,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveType,
  type Letter,
  type LetterTemplate,
  type OvertimeRecord,
  type PayrollRun,
  type Payslip,
  type PayslipLine,
  type PaymentVoucher,
  type PeopleData,
  type PeopleSettings,
  type PublicHoliday,
  type RequestStatus,
  type Review,
  type Shift,
  type TimeOffRequest,
  type TimesheetEntry,
  type Training,
  type TrainingEnrolment,
} from './types';

const DEPARTMENTS = ['Sales', 'Operations', 'Marketing', 'Finance', 'Management'];

/** n, name, email handle, department, designation, employment type, manager, days since joining, days to next birthday. */
const PEOPLE: [number, string, string, string, string, EmploymentType, boolean, number, number][] = [
  [1, 'Aisyah Rahim', 'aisyah', 'Sales', 'Sales Executive', 'full_time', false, 1730, 19],
  [2, 'Faiz Hakim', 'faiz', 'Marketing', 'Designer', 'full_time', false, 1680, 143],
  [3, 'Ahmad Zaki', 'zaki', 'Operations', 'Ops Lead', 'full_time', true, 1081, 201],
  [4, 'Nurul Huda', 'nurul', 'Finance', 'Accountant', 'full_time', false, 960, 9],
  [5, 'Siti Aminah', 'siti', 'Sales', 'Sales Executive', 'part_time', false, 850, 77],
  [6, 'Lim Wei Jie', 'weijie', 'Operations', 'Technician', 'contract', false, 1060, 256],
  [7, 'Siti Lestari', 'lestari', 'Management', 'HR Executive', 'full_time', false, 610, 310],
  [8, 'Raj Kumar', 'raj', 'Finance', 'Finance Analyst', 'full_time', false, 470, 118],
  [9, 'Tan Mei Ling', 'meiling', 'Marketing', 'Content Lead', 'full_time', true, 1240, 45],
  [10, 'Hafiz Osman', 'hafiz', 'Sales', 'Business Development', 'full_time', false, 395, 170],
  [11, 'Amirul Danial', 'amirul', 'Sales', 'Sales Executive', 'full_time', false, 720, 228],
  [12, 'Farid Ismail', 'farid', 'Sales', 'Sales Manager', 'full_time', true, 2010, 284],
  [13, 'Priya Devi', 'priya', 'Sales', 'Account Executive', 'full_time', false, 330, 61],
  [14, 'Chong Wei Han', 'weihan', 'Operations', 'Logistics Coordinator', 'full_time', false, 890, 332],
  [15, 'Zainab Yusof', 'zainab', 'Operations', 'Customer Support', 'full_time', false, 540, 97],
  [16, 'Daniel Wong', 'daniel', 'Operations', 'Technician', 'contract', false, 210, 189],
  [17, 'Syafiq Karim', 'syafiq', 'Marketing', 'Performance Marketer', 'full_time', false, 660, 131],
  [18, 'Liyana Salleh', 'liyana', 'Finance', 'Finance Manager', 'full_time', true, 1520, 266],
  [19, 'Kavitha Nair', 'kavitha', 'Management', 'Operations Director', 'full_time', true, 2300, 29],
  [20, 'Hakim Abdullah', 'hakim', 'Management', 'Managing Director', 'full_time', true, 2800, 215],
];

/** n, type, first day and last day from today, days, reason, status, applied days ago. */
const LEAVE: [number, LeaveType, number, number, number, string, RequestStatus, number][] = [
  [7, 'annual', -2, 1, 4, 'Family trip', 'approved', 12],
  [6, 'medical', 0, 0, 1, 'Clinic visit', 'approved', 1],
  [4, 'emergency', 0, 0, 1, 'Family matter', 'approved', 1],
  [1, 'annual', 10, 11, 2, 'Balik kampung', 'pending', 2],
  [11, 'annual', 5, 5, 1, 'Personal errand', 'pending', 1],
  [9, 'emergency', 3, 3, 1, 'Car repair', 'pending', 0],
  [2, 'annual', -40, -38, 3, 'Holiday', 'approved', 55],
  [3, 'medical', -25, -24, 2, 'Flu', 'approved', 26],
  [5, 'annual', -60, -58, 3, 'Wedding', 'approved', 75],
  [8, 'unpaid', -33, -33, 1, 'Personal', 'rejected', 40],
  [10, 'annual', -18, -17, 2, 'Rest', 'approved', 30],
  [12, 'annual', -75, -71, 5, 'Umrah', 'approved', 100],
  [13, 'medical', -12, -12, 1, 'Dental', 'approved', 13],
  [15, 'annual', -50, -49, 2, 'Holiday', 'approved', 62],
  [17, 'emergency', -8, -8, 1, 'Child unwell', 'approved', 9],
  [18, 'annual', -90, -86, 5, 'Holiday', 'approved', 110],
  [1, 'medical', -21, -21, 1, 'Fever', 'approved', 22],
  [1, 'annual', -45, -44, 2, 'Holiday', 'approved', 60],
];

/** n, day from today, start, end, reason, status. */
const TIME_OFF: [number, number, string, string, string, RequestStatus][] = [
  [1, -9, '15:00', '17:00', 'Bank appointment', 'approved'],
  [1, -30, '09:00', '11:00', 'School event', 'approved'],
  [2, 2, '14:00', '16:00', 'Clinic follow-up', 'approved'],
  [5, -14, '16:00', '18:00', 'JPJ appointment', 'approved'],
  [10, -6, '09:00', '10:30', 'Car service', 'rejected'],
  [14, -20, '13:00', '15:00', 'Bank appointment', 'approved'],
];

/** n, category, amount in cents, day from today, description, receipt, status. */
const CLAIMS: [number, ClaimCategory, number, number, string, boolean, RequestStatus][] = [
  [2, 'medical', 24000, -1, 'Clinic consultation', true, 'pending'],
  [4, 'travel', 18000, -2, 'Site visit mileage', true, 'pending'],
  [1, 'travel', 32000, -12, 'Client visit, Johor Bahru', true, 'approved'],
  [1, 'meals', 8600, -20, 'Client lunch', true, 'approved'],
  [1, 'medical', 15000, -41, 'Panel clinic', true, 'approved'],
  [1, 'equipment', 68400, -55, 'Headset and keyboard', false, 'rejected'],
  [3, 'travel', 21000, -9, 'Warehouse run', true, 'approved'],
  [5, 'meals', 6400, -15, 'Team lunch', true, 'approved'],
  [9, 'equipment', 129000, -27, 'Camera tripod', true, 'approved'],
  [12, 'travel', 54000, -33, 'Penang roadshow', true, 'approved'],
  [13, 'medical', 9000, -6, 'Pharmacy', true, 'approved'],
  [17, 'other', 12000, -18, 'Courier fees', false, 'rejected'],
];

/** n, day from today, hours, rate, status. */
const OVERTIME: [number, number, number, number, RequestStatus][] = [
  [3, -2, 4, 1.5, 'pending'],
  [1, -7, 2, 1.5, 'approved'],
  [1, -23, 3, 1.5, 'approved'],
  [1, -37, 2.5, 2, 'approved'],
  [6, -5, 3.5, 1.5, 'approved'],
  [6, -19, 4, 2, 'approved'],
  [14, -11, 2, 1.5, 'approved'],
  [15, -4, 1.5, 1.5, 'approved'],
  [16, -13, 5, 2, 'approved'],
  [16, -26, 3, 1.5, 'rejected'],
  [3, -16, 2.5, 1.5, 'approved'],
  [10, -8, 2, 1.5, 'approved'],
];

const HOLIDAYS: [string, number, number, 'national' | 'state', string | null][] = [
  ["New Year's Day", 1, 1, 'state', 'Kuala Lumpur'],
  ['Federal Territory Day', 2, 1, 'state', 'Kuala Lumpur'],
  ['Labour Day', 5, 1, 'national', null],
  ['National Day', 8, 31, 'national', null],
  ['Malaysia Day', 9, 16, 'national', null],
  ['Christmas Day', 12, 25, 'national', null],
];

const GOALS: [string, number, number][] = [
  ['Hit the quarterly target', 62, 40],
  ['Complete the compliance course', 85, 20],
  ['Cut response time to under 4 hours', 30, 60],
  ['Mentor one new hire', 55, 75],
];

/** title, category, provider, first and last day from today. A course's status follows its dates. */
const TRAININGS: [string, string, string, number, number][] = [
  ['Workplace safety refresher', 'Compliance', 'In-house', -60, -59],
  ['PDPA for customer data', 'Compliance', 'In-house', -30, -30],
  ['Consultative selling', 'Sales', 'External trainer', -3, 4],
  ['Excel for finance teams', 'Skills', 'Online course', 12, 13],
  ['First-time manager programme', 'Leadership', 'External trainer', 30, 32],
];

/** title, text, category, status, days since it was published (0 for a draft). The last one is still a draft. */
const ANNOUNCEMENTS: [string, string, Announcement['category'], Announcement['status'], number][] = [
  ['Office closed for National Day', 'The office is closed on 31 August. Support runs a skeleton shift.', 'holiday', 'published', 4],
  ['New panel clinics added', 'Three more panel clinics are available under the medical benefit.', 'benefits', 'published', 9],
  ['Quarterly town hall', 'Join the town hall this Friday at 3pm in the main meeting room.', 'general', 'published', 13],
  ['Updated leave policy', 'Annual leave may now be carried forward up to five days.', 'policy', 'published', 21],
  ['Second-half priorities', 'Leadership has shared the three priorities for the second half.', 'strategy', 'published', 34],
  ['Year-end dinner', 'Save the date for the year-end dinner. Venue and time to be confirmed.', 'general', 'draft', 0],
];

/** title, document type, day added from today, expiry day from today, asks for acknowledgement. All employee 1's, as in the demo. */
const OWN_DOCUMENTS: [string, HrDocument['doc_type'], number, number | null, boolean][] = [
  ['EA form', 'tax', -150, null, false],
  ['Code of conduct', 'contract', -6, null, true],
  ['Medical card', 'benefits', -340, 25, false],
  ['Insurance certificate', 'benefits', -375, -10, false],
];

/** employee, type, title, status, issued day from today, asks for acknowledgement, body. As the demo's. */
const LETTERS: [number, Letter['letter_type'], string, Letter['status'], number, boolean, string][] = [
  [1, 'confirmation', 'Confirmation of employment', 'issued', -2, true,
    'Following the end of your probation, we are pleased to confirm your employment as Sales Executive. The other terms of your employment stay as they are.'],
  [13, 'offer', 'Offer of employment', 'issued', -330, false,
    'We are pleased to offer you the position of Account Executive in the Sales department. Your salary and benefits are set out in your employment contract.'],
  [10, 'warning', 'Late attendance reminder', 'draft', 0, false,
    'Our records show several late arrivals this month. Please make sure you are at work by the start of the working day from now on.'],
  [9, 'promotion', 'Promotion to Content Lead', 'issued', -120, false,
    'We are pleased to tell you that you have been promoted to Content Lead in the Marketing department. Congratulations.'],
  [16, 'contract_renewal', 'Contract renewal', 'draft', 0, false,
    'We are pleased to renew your contract as Technician in the Operations department for a further twelve months.'],
];

/** The starter templates every workspace gets (the same six as `private.hr_seed_letter_templates`). */
const TEMPLATES: [LetterTemplate['letter_type'], string, string, string][] = [
  ['offer', 'Offer of employment', 'Offer of employment',
    '{today}\n\nDear {employee_name},\n\nWe are pleased to offer you the position of {designation} in the {department} department of {company_name}, starting on {join_date}.\n\nYour salary, benefits and other terms of employment are set out in your employment contract. Please read it with this letter.\n\nWe look forward to working with you.\n\nYours sincerely,\n{company_name}'],
  ['confirmation', 'Confirmation of employment', 'Confirmation of employment',
    '{today}\n\nDear {employee_name} ({employee_no}),\n\nFollowing the end of your probation, we are pleased to confirm your employment as {designation} in the {department} department of {company_name}. You joined us on {join_date}.\n\nThe other terms of your employment stay as they are.\n\nCongratulations, and thank you for your work so far.\n\nYours sincerely,\n{company_name}'],
  ['promotion', 'Promotion', 'Letter of promotion',
    '{today}\n\nDear {employee_name},\n\nWe are pleased to tell you that you have been promoted to {designation} in the {department} department.\n\nThis recognises your contribution to {company_name} since you joined on {join_date}. Any change to your pay will be confirmed to you separately.\n\nCongratulations.\n\nYours sincerely,\n{company_name}'],
  ['warning', 'Warning', 'Warning letter',
    '{today}\n\nDear {employee_name} ({employee_no}),\n\nThis letter is a formal warning about the matter discussed with you. [Describe what happened, and when.]\n\nWe expect this to improve from now on. [Describe what is expected, and by when.] If it does not, further action may follow.\n\nPlease speak to us if anything in this letter is unclear.\n\nYours sincerely,\n{company_name}'],
  ['contract_renewal', 'Contract renewal', 'Renewal of contract',
    '{today}\n\nDear {employee_name} ({employee_no}),\n\nWe are pleased to renew your contract as {designation} in the {department} department of {company_name}.\n\nThe renewed contract runs from [start date] to [end date]. The other terms of your contract stay as they are.\n\nThank you for your continued work.\n\nYours sincerely,\n{company_name}'],
  ['other', 'General letter', 'To whom it may concern',
    "{today}\n\nTo whom it may concern,\n\nThis is to confirm that {employee_name} ({employee_no}) has been employed by {company_name} as {designation} in the {department} department since {join_date}.\n\nThis letter is issued at the employee's request.\n\nYours sincerely,\n{company_name}"],
];

/** number, payee, type, amount in cents, day from today, status. */
const VOUCHERS: [number, string, string, number, number, PaymentVoucher['status']][] = [
  [1041, 'Aisyah Rahim', 'Claim reimbursement', 32000, -10, 'paid'],
  [1042, 'Tan Mei Ling', 'Claim reimbursement', 129000, -24, 'paid'],
  [1043, 'Lembaga Hasil Dalam Negeri', 'Statutory payment', 412000, -18, 'paid'],
  [1044, 'KWSP', 'Statutory payment', 1986000, -18, 'paid'],
  [1045, 'Farid Ismail', 'Advance', 150000, -3, 'issued'],
  [1046, 'Daniel Wong', 'Overtime payout', 37500, 0, 'draft'],
];

/** The demo workspace's one settings row: only the notifications are set. */
const SETTINGS: PeopleSettings = {
  work_week: ['mon', 'tue', 'wed', 'thu', 'fri'],
  work_start_time: '09:00',
  late_grace_minutes: 15,
  default_annual_leave_days: 14,
  default_medical_leave_days: 14,
  default_emergency_leave_days: 3,
  overtime_rates: { weekday: 1.5, rest_day: 2, public_holiday: 3 },
  notifications: { leave_requests: true, payslip_ready: true, document_expiry: true, birthdays: false },
};

const DAY = 86_400_000;
const pad = (n: number, width: number) => String(n).padStart(width, '0');
const employeeId = (n: number) => (n === 1 ? DEMO_EMPLOYEE_ID : `seed-emp-${n}`);
const between = (date: string, from: string, to: string) => date >= from && date <= to;

/** Base pay: RM 2,800 to RM 5,600 by position in the list; managers RM 3,000 more. */
const salaryCents = (n: number, manager: boolean) => 280000 + ((n * 7) % 8) * 40000 + (manager ? 300000 : 0);

/** Illustrative round figures, not the official contribution tables. */
function deductions(gross: number) {
  return {
    epf_cents: Math.round(gross * 0.11),
    socso_cents: Math.min(Math.round(gross * 0.005), 2975),
    eis_cents: Math.min(Math.round(gross * 0.002), 1190),
    pcb_cents:
      gross > 500000 ? 8000 + Math.round((gross - 500000) * 0.08) : gross > 350000 ? Math.round((gross - 350000) * 0.03) : 0,
  };
}

export function createSeedPeopleData(now: Date = new Date()): PeopleData {
  const today = todayInMalaysia(now);
  const year = Number(today.slice(0, 4));
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const nameOf = new Map(PEOPLE.map(([n, name]) => [n, name]));

  const departments: Department[] = DEPARTMENTS.map((name) => ({
    id: `seed-dept-${name.toLowerCase()}`,
    name,
    created_at: ago(3000),
  }));

  const employees: Employee[] = PEOPLE.map(([n, name, handle, dept, designation, type, manager, tenure, bday]) => {
    const birthday = addDays(today, bday);
    return {
      id: employeeId(n),
      user_id: null,
      employee_no: `EMP-${pad(n, 3)}`,
      name,
      work_email: `${handle}@openkuasa.com`,
      department_id: `seed-dept-${dept.toLowerCase()}`,
      department_name: dept,
      designation,
      employment_type: type,
      is_manager: manager,
      join_date: addDays(today, -tenure),
      status: 'active',
      date_of_birth_day: Number(birthday.slice(8, 10)),
      date_of_birth_month: Number(birthday.slice(5, 7)),
      created_at: ago(tenure),
    };
  });

  const privates: EmployeePrivate[] = PEOPLE.map(([n, name, , , , , manager, , bday]) => {
    const birthday = addDays(today, bday);
    return {
      employee_id: employeeId(n),
      nric: `900101-14-${pad(5000 + n, 4)}`,
      date_of_birth: `${year - 26 - (n % 14)}-${birthday.slice(5, 7)}-${pad(Math.min(Number(birthday.slice(8, 10)), 28), 2)}`,
      phone: `+60 12-555 ${pad(1000 + n * 37, 4)}`,
      address: `${n} Jalan Rimba, 50450 Kuala Lumpur`,
      base_salary_cents: salaryCents(n, manager),
      bank_name: ['Maybank', 'CIMB', 'Public Bank', 'RHB'][n % 4],
      bank_account: String(100000000 + n * 7919).padStart(12, '5'),
      epf_no: `EPF${pad(20000 + n, 8)}`,
      socso_no: `SOC${pad(30000 + n, 8)}`,
      tax_no: `SG${pad(40000 + n, 9)}`,
      emergency_contact_name: `Waris ${name.split(' ')[0]}`,
      emergency_contact_phone: `+60 13-555 ${pad(2000 + n * 41, 4)}`,
    };
  });

  const leave: LeaveRequest[] = LEAVE.map(([n, type, from, to, days, reason, status, applied], index) => ({
    id: `seed-leave-${index + 1}`,
    employee_id: employeeId(n),
    employee_name: nameOf.get(n)!,
    leave_type: type,
    start_date: addDays(today, from),
    end_date: addDays(today, to),
    days,
    half_day: false,
    reason,
    status,
    decision_note: null,
    created_at: ago(applied),
  }));

  const balances: LeaveBalance[] = employees.flatMap((employee) =>
    ([['annual', 16], ['medical', 14], ['emergency', 3]] as [LeaveType, number][]).map(([type, entitled]) => ({
      id: `seed-balance-${employee.id}-${type}`,
      employee_id: employee.id,
      leave_type: type,
      year,
      entitled_days: entitled,
      used_days: leave
        .filter(
          (r) =>
            r.employee_id === employee.id &&
            r.leave_type === type &&
            r.status === 'approved' &&
            Number(r.start_date.slice(0, 4)) === year,
        )
        .reduce((sum, r) => sum + r.days, 0),
    })),
  );

  const timeOff: TimeOffRequest[] = TIME_OFF.map(([n, day, start, end, reason, status], index) => ({
    id: `seed-timeoff-${index + 1}`,
    employee_id: employeeId(n),
    employee_name: nameOf.get(n)!,
    off_date: addDays(today, day),
    start_time: `${start}:00`,
    end_time: `${end}:00`,
    reason,
    status,
    decision_note: null,
    created_at: ago(Math.max(0, 3 - day)),
  }));

  const claims: Claim[] = CLAIMS.map(([n, category, amount, day, description, receipt, status], index) => ({
    id: `seed-claim-${index + 1}`,
    employee_id: employeeId(n),
    employee_name: nameOf.get(n)!,
    category,
    amount_cents: amount,
    claim_date: addDays(today, day),
    description,
    has_receipt: receipt,
    status,
    decision_note: null,
    receipt_path: null,
    paid_on: null,
    paid_reference: null,
    created_at: ago(-day),
  }));

  const overtime: OvertimeRecord[] = OVERTIME.map(([n, day, hours, rate, status], index) => ({
    id: `seed-ot-${index + 1}`,
    employee_id: employeeId(n),
    employee_name: nameOf.get(n)!,
    work_date: addDays(today, day),
    hours,
    rate_multiplier: rate,
    amount_cents: Math.round(hours * rate * 2500),
    hourly_rate_cents: 2500,
    day_kind: null,
    reason: null,
    decision_note: null,
    status,
    created_at: ago(-day),
    paid_month: null,
  }));

  // Every weekday of the last eight weeks. h is a stable 0..39 per employee and
  // day: 0 is absent, 1 to 4 late, the rest on time.
  const attendance: AttendanceDay[] = [];
  const timesheet: TimesheetEntry[] = [];
  for (let back = 55; back >= 0; back -= 1) {
    const date = addDays(today, -back);
    if (!isWeekday(date)) continue;
    for (const [n] of PEOPLE) {
      const id = employeeId(n);
      const h = (n * 31 + back * 17) % 40;
      const away = leave.some(
        (r) => r.employee_id === id && r.status === 'approved' && between(date, r.start_date, r.end_date),
      );
      const status: AttendanceStatus = away ? 'on_leave' : h === 0 ? 'absent' : h <= 4 ? 'late' : 'present';
      const worked = status === 'present' || status === 'late';
      // 09:00 in Kuala Lumpur is 01:00 UTC.
      const nine = Date.parse(`${date}T01:00:00Z`);
      attendance.push({
        id: `seed-att-${n}-${date}`,
        employee_id: id,
        work_date: date,
        clock_in: worked
          ? new Date(nine + (status === 'late' ? 10 + h * 5 : -(h % 10)) * 60_000).toISOString()
          : null,
        clock_out: worked && date !== today ? new Date(nine + (9 * 60 + (h % 30)) * 60_000).toISOString() : null,
        status,
        corrected: false,
        correction_note: null,
      });
      if (worked) {
        const hours = 7.5 + ((n + back) % 3) * 0.5;
        timesheet.push({
          id: `seed-ts-${n}-${date}`,
          employee_id: id,
          work_date: date,
          hours,
          billable_hours: Math.round(hours * 0.8 * 2) / 2,
        });
      }
    }
  }

  const monday = weekStart(today);
  const shifts: Shift[] = PEOPLE.filter(([, , , dept]) => dept === 'Operations').flatMap(([n]) =>
    Array.from({ length: 7 }, (_, i): Shift => {
      const turn = (n + i) % 4;
      return {
        id: `seed-shift-${n}-${i}`,
        employee_id: employeeId(n),
        work_date: addDays(monday, i),
        shift: turn === 0 ? 'off' : turn === 1 ? 'night' : 'morning',
      };
    }),
  );

  const holidays: PublicHoliday[] = HOLIDAYS.map(([name, month, day, scope, state], index) => ({
    id: `seed-holiday-${index + 1}`,
    name,
    holiday_date: `${year}-${pad(month, 2)}-${pad(day, 2)}`,
    scope,
    state,
  }));

  const thisMonth = monthStart(today);
  const runs: PayrollRun[] = Array.from({ length: 8 }, (_, m) => {
    const period = addMonths(thisMonth, -m);
    return {
      id: `seed-run-${m}`,
      period_month: period,
      status: m === 0 ? 'draft' : 'paid',
      paid_at: m === 0 ? null : new Date(Date.parse(`${addDays(period, 27)}T02:00:00Z`)).toISOString(),
      paid_by_name: null,
    };
  });

  // SAMPLE DATA ONLY, NOT THE PAYROLL RULE. This copy makes the demo look like what the demo re-seed produces; the
  // rule lives in the database (`hr_run_payroll` and friends) and nothing should read this as it. It does NOT
  // model: public holidays (working days are plain weekdays, so a joiner's cut can differ by a day), unpaid leave
  // (there are no unpaid-leave lines), overtime paid late (every overtime line is on its own month's payslip),
  // or a figure set by hand (`set_by_hr` is always empty).
  const lastDay = (month: string) => addDays(addMonths(month, 1), -1);
  const workingDays = (from: string, to: string) => {
    let n = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekday(d)) n += 1;
    return n;
  };
  const dayLabel = (date: string) => `${Number(date.slice(8, 10))} ${monthLabel(date)} ${date.slice(0, 4)}`;
  // Lines an owner or admin added by hand: this month and last month. n, months ago, kind, name, amount.
  const HAND_LINES: [number, number, 'earning' | 'deduction', string, number][] = [
    [12, 0, 'earning', 'Sales commission', 85000],
    [12, 1, 'earning', 'Sales commission', 72000],
    [1, 1, 'earning', 'Sales commission', 45000],
    [19, 0, 'earning', 'Project bonus', 100000],
    [10, 0, 'deduction', 'Salary advance', 30000],
    [5, 1, 'deduction', 'Uniform', 6000],
  ];
  const paidMonth = new Map<string, string>();

  const payslips: Payslip[] = runs.flatMap((run) =>
    employees
      .filter((employee) => employee.join_date! < addMonths(run.period_month, 1))
      .map((employee): Payslip => {
        const basic = privates.find((p) => p.employee_id === employee.id)!.base_salary_cents!;
        const id = `seed-slip-${run.id}-${employee.id}`;
        const lines: PayslipLine[] = [];
        const add = (kind: PayslipLine['kind'], source: PayslipLine['source'], label: string, amount: number) =>
          lines.push({ id: `seed-line-${id}-${lines.length + 1}`, payslip_id: id, kind, source, label, amount_cents: amount });

        if (employee.join_date! > run.period_month) {
          const last = lastDay(run.period_month);
          const month = workingDays(run.period_month, last);
          const after = workingDays(employee.join_date!, last);
          const cut = month === 0 ? 0 : basic - Math.round((basic * after) / month);
          if (cut > 0) add('unpaid', 'joiner', `Joined ${dayLabel(employee.join_date!)}`, cut);
        }
        for (const record of overtime
          .filter(
            (o) =>
              o.employee_id === employee.id &&
              o.status === 'approved' &&
              o.amount_cents > 0 &&
              o.work_date.slice(0, 7) === run.period_month.slice(0, 7),
          )
          .sort((a, b) => a.work_date.localeCompare(b.work_date))) {
          add('earning', 'overtime', `Overtime, ${dayLabel(record.work_date)}, ${record.hours} h`, record.amount_cents);
          if (run.status === 'paid') paidMonth.set(record.id, run.period_month.slice(0, 7));
        }
        for (const [n, back, kind, label, amount] of HAND_LINES) {
          if (employeeId(n) === employee.id && addMonths(thisMonth, -back) === run.period_month) add(kind, 'hr', label, amount);
        }

        const earnings = lines.filter((l) => l.kind === 'earning').reduce((t, l) => t + l.amount_cents, 0);
        const unpaid = lines.filter((l) => l.kind === 'unpaid').reduce((t, l) => t + l.amount_cents, 0);
        const other = lines.filter((l) => l.kind === 'deduction').reduce((t, l) => t + l.amount_cents, 0);
        const gross = Math.max(0, basic + earnings - unpaid);
        const cut = deductions(gross);
        // The illustrative PCB follows the salary, as the database's re-seed has it.
        const pcb_cents = deductions(basic).pcb_cents;
        return {
          id,
          employee_id: employee.id,
          employee_name: employee.name,
          payroll_run_id: run.id,
          period_month: run.period_month,
          basic_cents: basic,
          gross_cents: gross,
          epf_cents: cut.epf_cents,
          socso_cents: cut.socso_cents,
          eis_cents: cut.eis_cents,
          pcb_cents,
          other_deductions_cents: other,
          net_cents: gross - cut.epf_cents - cut.socso_cents - cut.eis_cents - pcb_cents - other,
          set_by_hr: [],
          lines,
          status: run.status === 'paid' ? 'paid' : 'pending',
        };
      }),
  );
  const overtimeOut = overtime.map((o) => ({ ...o, paid_month: paidMonth.get(o.id) ?? null }));

  const goals: Goal[] = PEOPLE.filter(([n]) => n <= 10).flatMap(([n, name]) =>
    GOALS.map(([title, base, due], index): Goal => {
      const progress = Math.min(100, base + ((n * 7) % 20));
      return {
        id: `seed-goal-${n}-${index + 1}`,
        employee_id: employeeId(n),
        employee_name: name,
        title,
        progress,
        due_date: addDays(today, due),
        status: progress >= 100 ? 'done' : base < 40 ? 'at_risk' : 'on_track',
      };
    }),
  );

  // Reviews as the demo's re-seed writes them: four scores in half steps, the overall score their average, all
  // released but two (employees 10 and 16), which are still drafts.
  const reviews: Review[] = PEOPLE.map(([n, name]) => {
    const competencies = {
      Delivery: 3 + ((n * 3) % 5) * 0.5,
      Teamwork: 3 + ((n * 5) % 4) * 0.5,
      Ownership: 2.5 + ((n * 11) % 5) * 0.5,
      Communication: 3 + ((n * 13) % 5) * 0.5,
    };
    const mean = (competencies.Delivery + competencies.Teamwork + competencies.Ownership + competencies.Communication) / 4;
    const rating: Review['rating'] = mean >= 4.3 ? 'exceeds' : mean >= 3.4 ? 'meets' : 'below';
    const draft = n === 10 || n === 16;
    return {
      id: `seed-review-${n}`,
      employee_id: employeeId(n),
      employee_name: name,
      period: `H1 ${year}`,
      competencies,
      rating,
      score: Math.round(mean * 100) / 100,
      comment:
        rating === 'exceeds'
          ? 'Consistently ahead of plan, and a steady hand for the team.'
          : rating === 'meets'
            ? 'A solid half. Keep building on ownership of the bigger pieces.'
            : 'Below what the role needs this half. A plan for the next quarter is agreed.',
      status: draft ? 'draft' : 'released',
      released_at: draft ? null : ago(40),
      reviewer_name: 'Kavitha Nair',
      reviewed_at: addDays(today, -45),
    };
  });

  const trainings: Training[] = TRAININGS.map(([title, category, provider, from, to], index) => ({
    id: `seed-training-${index + 1}`,
    title,
    category,
    provider,
    starts_on: addDays(today, from),
    ends_on: addDays(today, to),
  }));

  // Whoever is marked completed carries the time: the end of the course's last day, Malaysia time.
  const enrolments: TrainingEnrolment[] = PEOPLE.flatMap(([n]) =>
    trainings
      .map((training, index) => ({ training, k: index + 1 }))
      .filter(({ k }) => (n + k) % 3 === 0 || (n === 1 && k <= 3))
      .map(({ training }): TrainingEnrolment => {
        const done = (training.ends_on ?? today) < today;
        return {
          id: `seed-enrol-${n}-${training.id}`,
          employee_id: employeeId(n),
          training_id: training.id,
          completed: done,
          completed_at: done ? `${training.ends_on}T10:00:00.000Z` : null,
        };
      }),
  );

  const announcements: Announcement[] = ANNOUNCEMENTS.map(([title, body, category, status, days], index) => ({
    id: `seed-announcement-${index + 1}`,
    title,
    body,
    category,
    status,
    published_at: status === 'published' ? ago(days) : null,
    author_name: status === 'published' ? 'Siti Lestari' : null,
    edited_at: null,
    // The sample company is the demo: nobody in it has read marks, and its unread count is always zero.
    unread: false,
  }));

  // None of the demo's documents has a file: the screens say "Sample document, no file".
  const noFile = { file_name: null, file_size: null, file_type: null, has_file: false, source: 'hr' as const };
  const documents: HrDocument[] = [
    ...employees.map((e, index): HrDocument => ({
      id: `seed-doc-contract-${index + 1}`,
      employee_id: e.id,
      employee_name: e.name,
      title: 'Employment contract',
      doc_type: 'contract',
      expires_on: null,
      ack_requested: false,
      acknowledged_at: null,
      created_at: `${e.join_date}T00:00:00.000Z`,
      ...noFile,
    })),
    ...OWN_DOCUMENTS.map(([title, doc_type, added, expires, ack], index): HrDocument => ({
      id: `seed-doc-own-${index + 1}`,
      employee_id: employeeId(1),
      employee_name: nameOf.get(1)!,
      title,
      doc_type,
      expires_on: expires === null ? null : addDays(today, expires),
      ack_requested: ack,
      acknowledged_at: null,
      created_at: ago(-added),
      ...noFile,
    })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const letters: Letter[] = LETTERS.map(([n, letter_type, title, status, day, ack, body], index) => ({
    id: `seed-letter-${index + 1}`,
    employee_id: employeeId(n),
    employee_name: nameOf.get(n)!,
    letter_type,
    title,
    body: `Dear ${nameOf.get(n)!},\n\n${body}\n\nYours sincerely,\nRimba Ventures`,
    status,
    issued_on: status === 'issued' ? addDays(today, day) : null,
    ack_requested: ack,
    acknowledged_at: null,
    created_at: ago(-day),
  }));

  const templates: LetterTemplate[] = TEMPLATES.map(([letter_type, name, title, body], index) => ({
    id: `seed-template-${index + 1}`,
    name,
    letter_type,
    title,
    body,
  }));

  const vouchers: PaymentVoucher[] = VOUCHERS.map(([no, payee, voucher_type, amount_cents, day, status]) => ({
    id: `seed-voucher-${no}`,
    voucher_no: `PV-${no}`,
    payee,
    voucher_type,
    amount_cents,
    issued_date: addDays(today, day),
    status,
  })).sort((a, b) => b.issued_date.localeCompare(a.issued_date) || b.voucher_no.localeCompare(a.voucher_no));

  const newestFirst = <T extends { created_at: string }>(rows: T[]) =>
    [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    listDepartments: async () => departments,
    listEmployees: async () => employees,
    getEmployeePrivate: async (id) => privates.find((p) => p.employee_id === id) ?? null,
    listLeaveRequests: async () => newestFirst(leave),
    listLeaveBalances: async (wanted) => balances.filter((b) => b.year === wanted),
    listTimeOffRequests: async () => newestFirst(timeOff),
    listClaims: async () => newestFirst(claims),
    listOvertime: async () => newestFirst(overtimeOut),
    listAttendance: async (from, to) => attendance.filter((d) => between(d.work_date, from, to)),
    listTimesheet: async (from, to) => timesheet.filter((d) => between(d.work_date, from, to)),
    listShifts: async (from, to) => shifts.filter((s) => between(s.work_date, from, to)),
    listPublicHolidays: async () => holidays,
    listPayrollRuns: async () => runs,
    listPayslips: async (employeeId) =>
      employeeId ? payslips.filter((p) => p.employee_id === employeeId) : payslips,
    listGoals: async () => goals,
    listReviews: async () => reviews,
    listTrainings: async () => trainings,
    listTrainingEnrolments: async () => enrolments,
    listAnnouncements: async () => announcements,
    listDocuments: async () => documents,
    listLetters: async () => newestFirst(letters),
    listLetterTemplates: async () => templates,
    listPaymentVouchers: async () => vouchers,
    getSettings: async () => structuredClone(SETTINGS),
  };
}
