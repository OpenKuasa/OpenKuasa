/**
 * Pure builders for the Records, My Documents, Letters and Settings screens.
 * The database decides which rows come back; these functions only narrow
 * "everything I may read" to "mine" on the personal screens (Records,
 * My Documents) and shape the rows for display.
 */

import { daysBetween, formatDate, malaysiaDate } from './dates';
import { EMPLOYMENT_LABEL } from './employees';
import { DOCUMENT_STATUS_LABEL, DOCUMENT_TYPE_LABEL, isTeamView, ownRows } from './own';
import { sumBy } from './series';
import type {
  DocumentStatus,
  DocumentType,
  Employee,
  EmployeePrivate,
  HrDocument,
  LeaveBalance,
  Letter,
  PeopleData,
  PeopleSettings,
  PeopleViewer,
} from './types';

export const NOT_RECORDED = 'Not recorded';
/** A document that expires within this many days (today included) is "expiring soon". */
export const EXPIRY_WINDOW_DAYS = 90;

const present = (value: string | null | undefined): string | null => {
  const text = value?.trim();
  return text ? text : null;
};
const orNotRecorded = (value: string | null | undefined) => present(value) ?? NOT_RECORDED;

/**
 * An account number with all but its last 4 characters hidden. An account of
 * 4 characters or fewer is hidden entirely. Nothing recorded gives null.
 */
export function maskAccount(account: string | null | undefined): string | null {
  const text = present(account);
  if (text === null) return null;
  if (text.length <= 4) return '•'.repeat(text.length);
  return `••••${text.slice(-4)}`;
}

/* ---------------------------------------------------------------- Records */

export type RecordRow = { label: string; value: string };
export type RecordSection = { key: 'personal' | 'employment' | 'statutory' | 'emergency' | 'bank'; title: string; subtitle: string; rows: RecordRow[] };

export type RecordsModel =
  | { linked: false }
  | {
      linked: true;
      status_label: string | null;
      tenure: { value: string; since: string | null };
      annual_leave_left: string;
      department: string;
      designation: string | null;
      employment: string;
      sections: RecordSection[];
    };

/** Years of service as a short figure: '7.2 yrs', '1 yr', '0 yrs'. Null without a join date. */
export function tenureLabel(joinDate: string | null, today: string): string | null {
  if (!joinDate) return null;
  const years = Math.max(0, Math.round((daysBetween(joinDate, today) / 365.25) * 10) / 10);
  return `${years} ${years === 1 ? 'yr' : 'yrs'}`;
}

/** Annual leave still to take this year, to 1 decimal, or null with no annual balance row. */
export function annualLeaveLeft(balances: LeaveBalance[], viewer: PeopleViewer): number | null {
  const own = ownRows(balances, viewer).filter((b) => b.leave_type === 'annual');
  if (own.length === 0) return null;
  const left = own.reduce((sum, b) => sum + (b.entitled_days - b.used_days), 0);
  return Math.round(left * 10) / 10;
}

const dateOrNull = (date: string | null | undefined) => (date ? formatDate(date) : null);

/** The viewer's own record. `employee` and `priv` must already be the viewer's own. */
export function buildRecordsModel(
  viewer: PeopleViewer,
  employees: Employee[],
  priv: EmployeePrivate | null,
  balances: LeaveBalance[],
  today: string,
): RecordsModel {
  if (viewer.employeeId === null) return { linked: false };
  const employee = employees.find((e) => e.id === viewer.employeeId) ?? null;
  const left = annualLeaveLeft(balances, viewer);
  const account = maskAccount(priv?.bank_account);

  return {
    linked: true,
    status_label: employee ? (employee.status === 'active' ? 'Active' : 'Inactive') : null,
    tenure: {
      value: tenureLabel(employee?.join_date ?? null, today) ?? '—',
      since: employee?.join_date ? employee.join_date.slice(0, 4) : null,
    },
    annual_leave_left: left === null ? '—' : String(left),
    department: present(employee?.department_name) ?? '—',
    designation: present(employee?.designation),
    employment: employee ? EMPLOYMENT_LABEL[employee.employment_type] : '—',
    sections: [
      {
        key: 'personal',
        title: 'Personal',
        subtitle: 'Your personal details',
        rows: [
          { label: 'Full name', value: orNotRecorded(employee?.name) },
          { label: 'NRIC', value: orNotRecorded(priv?.nric) },
          { label: 'Date of birth', value: dateOrNull(priv?.date_of_birth) ?? NOT_RECORDED },
          { label: 'Email', value: orNotRecorded(employee?.work_email) },
          { label: 'Phone', value: orNotRecorded(priv?.phone) },
        ],
      },
      {
        key: 'employment',
        title: 'Employment',
        subtitle: 'Your role in the company',
        rows: [
          { label: 'Employee no', value: orNotRecorded(employee?.employee_no) },
          { label: 'Department', value: orNotRecorded(employee?.department_name) },
          { label: 'Designation', value: orNotRecorded(employee?.designation) },
          { label: 'Join date', value: dateOrNull(employee?.join_date) ?? NOT_RECORDED },
          { label: 'Type', value: employee ? EMPLOYMENT_LABEL[employee.employment_type] : NOT_RECORDED },
          { label: 'Status', value: employee ? (employee.status === 'active' ? 'Active' : 'Inactive') : NOT_RECORDED },
        ],
      },
      {
        key: 'statutory',
        title: 'Statutory',
        subtitle: 'EPF · SOCSO · PCB',
        rows: [
          { label: 'EPF / KWSP no', value: orNotRecorded(priv?.epf_no) },
          { label: 'SOCSO / PERKESO no', value: orNotRecorded(priv?.socso_no) },
          { label: 'Income tax no (PCB/MTD)', value: orNotRecorded(priv?.tax_no) },
        ],
      },
      {
        key: 'emergency',
        title: 'Emergency Contact',
        subtitle: 'Who we call first',
        rows: [
          { label: 'Name', value: orNotRecorded(priv?.emergency_contact_name) },
          { label: 'Phone', value: orNotRecorded(priv?.emergency_contact_phone) },
        ],
      },
      {
        key: 'bank',
        title: 'Bank Details',
        subtitle: 'For payroll credit',
        rows: [
          { label: 'Bank', value: orNotRecorded(priv?.bank_name) },
          { label: 'Account', value: account ?? NOT_RECORDED },
        ],
      },
    ],
  };
}

/**
 * Reads the viewer's own record. The private details are fetched only for the
 * viewer's own employee id, and only when the account is linked.
 */
export async function loadRecordsModel(data: PeopleData, viewer: PeopleViewer, today: string): Promise<RecordsModel> {
  if (viewer.employeeId === null) return { linked: false };
  const [employees, priv, balances] = await Promise.all([
    data.listEmployees(),
    data.getEmployeePrivate(viewer.employeeId),
    data.listLeaveBalances(Number(today.slice(0, 4))),
  ]);
  return buildRecordsModel(viewer, employees, priv, balances, today);
}

/* ------------------------------------------------------------ My Documents */

const DOCUMENT_COLORS: Record<DocumentType, string> = {
  payslip: 'var(--chart-1)',
  letter: 'var(--chart-2)',
  contract: 'var(--chart-3)',
  tax: 'var(--chart-4)',
  benefits: 'var(--chart-5)',
};
const DOCUMENT_TYPES = Object.keys(DOCUMENT_COLORS) as DocumentType[];

/** Expires today or within the next 90 days. A document with no expiry date, or one 91 days away, is not. */
export function isExpiringSoon(doc: Pick<HrDocument, 'expires_on'>, today: string): boolean {
  if (!doc.expires_on) return false;
  const days = daysBetween(today, doc.expires_on);
  return days >= 0 && days <= EXPIRY_WINDOW_DAYS;
}

/** 'Expires 31 Dec 2026' for a document that has an expiry and is flagged expiring; else the issue date; else '—'. */
export function documentDateLabel(doc: Pick<HrDocument, 'status' | 'issued_on' | 'expires_on'>): string {
  if (doc.status === 'expiring' && doc.expires_on) return `Expires ${formatDate(doc.expires_on)}`;
  if (doc.issued_on) return formatDate(doc.issued_on);
  return '—';
}

export type DocumentRow = {
  id: string;
  title: string;
  type_label: string;
  date_label: string;
  status: DocumentStatus;
  status_label: string;
  pending_signature: boolean;
};

export type DocumentsModel =
  | { linked: false }
  | {
      linked: true;
      total: number;
      pending_signature: number;
      expiring_soon: number;
      payslips: number;
      by_type: { key: DocumentType; label: string; value: number; color: string }[];
      rows: DocumentRow[];
    };

/** Newest issue date first; documents with no issue date last; ties by title. */
function byIssuedDesc(a: HrDocument, b: HrDocument): number {
  if (a.issued_on === b.issued_on) return a.title.localeCompare(b.title);
  if (a.issued_on === null) return 1;
  if (b.issued_on === null) return -1;
  return b.issued_on.localeCompare(a.issued_on);
}

/** The viewer's own documents. */
export function buildDocumentsModel(documents: HrDocument[], viewer: PeopleViewer, today: string): DocumentsModel {
  if (viewer.employeeId === null) return { linked: false };
  const own = ownRows(documents, viewer).sort(byIssuedDesc);
  const counts = new Map(sumBy(own, (d) => d.doc_type, () => 1).map((entry) => [entry.key, entry.value]));
  return {
    linked: true,
    total: own.length,
    pending_signature: own.filter((d) => d.status === 'pending_signature').length,
    expiring_soon: own.filter((d) => isExpiringSoon(d, today)).length,
    payslips: counts.get('payslip') ?? 0,
    by_type: DOCUMENT_TYPES.filter((type) => (counts.get(type) ?? 0) > 0).map((type) => ({
      key: type,
      label: DOCUMENT_TYPE_LABEL[type],
      value: counts.get(type) ?? 0,
      color: DOCUMENT_COLORS[type],
    })),
    rows: own.map((d) => ({
      id: d.id,
      title: d.title,
      type_label: DOCUMENT_TYPE_LABEL[d.doc_type],
      date_label: documentDateLabel(d),
      status: d.status,
      status_label: DOCUMENT_STATUS_LABEL[d.status],
      pending_signature: d.status === 'pending_signature',
    })),
  };
}

/* ----------------------------------------------------------------- Letters */

export type LetterRow = {
  id: string;
  title: string;
  employee_name: string;
  type_label: string;
  date_label: string;
  status: Letter['status'];
};

export type LettersModel = {
  /** True for HR and the demo: the rows are the team's. Otherwise they are the viewer's own letters. */
  team: boolean;
  /** Null for someone who is not on the team view: those figures would be the team's. */
  totals: { issued_this_year: number; drafts: number; issued_this_month: number } | null;
  by_type: { key: string; label: string; value: number; color: string }[] | null;
  rows: LetterRow[];
};

const LETTER_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

const letterType = (letter: Letter) => present(letter.letter_type) ?? 'Other';
/** A letter's date: when it was issued, or for a draft (or a missing date) when it was started. */
const letterDate = (letter: Letter) => letter.issued_on ?? malaysiaDate(letter.created_at);

export function buildLettersModel(letters: Letter[], viewer: PeopleViewer, today: string): LettersModel {
  const team = isTeamView(viewer);
  const rows = [...letters]
    .sort((a, b) => {
      const da = letterDate(a);
      const db = letterDate(b);
      if (da === db) return a.title.localeCompare(b.title);
      if (da === '') return 1;
      if (db === '') return -1;
      return db.localeCompare(da);
    })
    .map((l): LetterRow => {
      const date = letterDate(l);
      return {
        id: l.id,
        title: l.title,
        employee_name: l.employee_name,
        type_label: letterType(l),
        date_label: date ? formatDate(date) : '—',
        status: l.status,
      };
    });
  if (!team) return { team, totals: null, by_type: null, rows };

  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  const issued = letters.filter((l) => l.status === 'issued');
  const issuedThisYear = issued.filter((l) => l.issued_on?.startsWith(year));
  return {
    team,
    totals: {
      issued_this_year: issuedThisYear.length,
      drafts: letters.filter((l) => l.status === 'draft').length,
      issued_this_month: issued.filter((l) => l.issued_on?.startsWith(month)).length,
    },
    by_type: sumBy(issuedThisYear, letterType, () => 1).map((entry, index) => ({
      key: entry.key,
      label: entry.key,
      value: entry.value,
      color: LETTER_COLORS[index % LETTER_COLORS.length],
    })),
    rows,
  };
}

/* ---------------------------------------------------------------- Settings */

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

/** ['mon'..'fri'] gives 'Mon–Fri'; a run of three or more days is shortened that way, anything else is listed. */
export function workWeekLabel(days: string[]): string {
  const known = DAY_ORDER.filter((d) => days.includes(d));
  if (known.length === 0) return '—';
  const first = DAY_ORDER.indexOf(known[0]);
  const consecutive = known.every((d, i) => DAY_ORDER.indexOf(d) === first + i);
  if (consecutive && known.length >= 3) return `${DAY_LABEL[known[0]]}–${DAY_LABEL[known.at(-1)!]}`;
  return known.map((d) => DAY_LABEL[d]).join(', ');
}

const NOTIFICATIONS: { key: string; label: string; description: string }[] = [
  { key: 'leave_requests', label: 'Leave & claim requests', description: 'Alert approvers the moment a request comes in.' },
  { key: 'payslip_ready', label: 'Payslip ready', description: 'Tell staff when the monthly payslip is published.' },
  { key: 'document_expiry', label: 'Document expiry', description: 'Flag expiring permits, passports and EA forms early.' },
  { key: 'birthdays', label: 'Birthdays & anniversaries', description: 'A friendly nudge for team milestones.' },
];

const multiplier = (value: number) => `${value}x`;

export type SettingsModel =
  | { hr_only: true }
  | {
      hr_only: false;
      working_days: string;
      annual_leave_days: string;
      medical_leave_days: string;
      emergency_leave_days: string;
      overtime: { label: string; value: string }[];
      notifications: { key: string; label: string; description: string; on: boolean }[];
    };

export function buildSettingsModel(settings: PeopleSettings): SettingsModel {
  return {
    hr_only: false,
    working_days: workWeekLabel(settings.work_week),
    annual_leave_days: String(settings.default_annual_leave_days),
    medical_leave_days: String(settings.default_medical_leave_days),
    emergency_leave_days: String(settings.default_emergency_leave_days),
    overtime: [
      { label: 'Weekday', value: multiplier(settings.overtime_rates.weekday) },
      { label: 'Rest day', value: multiplier(settings.overtime_rates.rest_day) },
      { label: 'Public holiday', value: multiplier(settings.overtime_rates.public_holiday) },
    ],
    notifications: NOTIFICATIONS.map((n) => ({ ...n, on: settings.notifications[n.key] === true })),
  };
}

/** Settings are for owners and admins (and the demo). Anyone else gets the notice and nothing is read. */
export async function loadSettingsModel(data: PeopleData, viewer: PeopleViewer): Promise<SettingsModel> {
  if (!isTeamView(viewer)) return { hr_only: true };
  return buildSettingsModel(await data.getSettings());
}
