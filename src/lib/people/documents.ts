/**
 * Pure builders for the Records, My Documents, Letters and Settings screens.
 * The database decides which rows come back; these functions only narrow
 * "everything I may read" to "mine" on the personal screens (Records,
 * My Documents) and shape the rows for display.
 */

import { daysBetween, formatDate, malaysiaDate, monthYearLabel } from './dates';
import { EXPIRY_WINDOW_DAYS, type ExpiryState, expiryState } from './document-forms';
import { EMPLOYMENT_LABEL } from './employees';
import { unfilledInLetter } from './letter-placeholders';
import { DOCUMENT_TYPE_LABEL, LETTER_LANG_LABEL, LETTER_TYPE_LABEL, isTeamView, ownRows } from './own';
import { sumBy } from './series';
import type {
  DocumentType,
  Employee,
  EmployeePrivate,
  HrDocument,
  LeaveBalance,
  Letter,
  LetterTemplate,
  LetterLang,
  LetterType,
  Payslip,
  PeopleData,
  PeopleSettings,
  PeopleViewer,
  Weekday,
} from './types';

export const NOT_RECORDED = 'Not recorded';
export { EXPIRY_WINDOW_DAYS };

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

/* ------------------------------------------------------------ Documents and letters */

/** Who may add, change or remove other people's documents and letters: an owner or admin outside the sample company. */
export function canManageDocuments(viewer: Pick<PeopleViewer, 'isHr' | 'isDemo'>): boolean {
  return viewer.isHr && !viewer.isDemo;
}

/** `340 KB`, `1.2 MB`: a file's size for a person. Null for a size that is not known. */
export function formatFileSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toString()} MB`;
}

const FILE_TYPE_LABEL: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/heic': 'HEIC',
};

/** `passport.pdf · 340 KB · PDF`, from what the row records (storage's own figures when it recorded them). Null without a file. */
export function fileLabel(doc: Pick<HrDocument, 'has_file' | 'file_name' | 'file_size' | 'file_type'>): string | null {
  if (!doc.has_file) return null;
  return [doc.file_name, formatFileSize(doc.file_size), doc.file_type ? (FILE_TYPE_LABEL[doc.file_type] ?? null) : null]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
}

export const NO_FILE_LABEL = 'Sample document, no file';

/** `Expires 31 Dec 2026`, `Expired 31 Dec 2026`, or null with no expiry date. */
function expiryLabel(doc: Pick<HrDocument, 'expires_on'>, state: ExpiryState): string | null {
  if (!doc.expires_on) return null;
  return `${state === 'expired' ? 'Expired' : 'Expires'} ${formatDate(doc.expires_on)}`;
}

/** The document asks its employee to acknowledge it and they have not yet. */
export const documentAwaiting = (doc: Pick<HrDocument, 'ack_requested' | 'acknowledged_at'>): boolean =>
  doc.ack_requested && doc.acknowledged_at === null;

/** The letter is issued, asks its employee to acknowledge it and they have not yet. */
export const letterAwaiting = (letter: Pick<Letter, 'status' | 'ack_requested' | 'acknowledged_at'>): boolean =>
  letter.status === 'issued' && letter.ack_requested && letter.acknowledged_at === null;

/**
 * How many of the viewer's OWN documents and letters await their acknowledgement: HR-added documents that ask and
 * issued letters that ask. 0 in the sample company (the database refuses an acknowledgement there, so the count
 * could never clear) and for a viewer with no employee record. An owner who is also an employee is counted their
 * own rows, never the team's.
 */
export function awaitingAcknowledgement(documents: HrDocument[], letters: Letter[], viewer: PeopleViewer): number {
  if (viewer.isDemo || viewer.employeeId === null) return 0;
  return (
    ownRows(documents, viewer).filter((doc) => doc.source === 'hr' && documentAwaiting(doc)).length +
    ownRows(letters, viewer).filter(letterAwaiting).length
  );
}

const readOn = (acknowledged_at: string | null): string | null =>
  acknowledged_at ? `Acknowledged on ${formatDate(malaysiaDate(acknowledged_at))}` : null;

export type MyDocumentRow = {
  id: string;
  kind: 'document' | 'letter' | 'payslip';
  title: string;
  type_label: string;
  /** When it was added or issued, or the payslip's month. */
  date_label: string;
  expiry: ExpiryState;
  /** `Expires 31 Dec 2026` / `Expired 31 Dec 2026`; null without an expiry date or for a letter or payslip. */
  expiry_label: string | null;
  /** The file as storage recorded it, e.g. `passport.pdf · 340 KB · PDF`; null without one. */
  file_label: string | null;
  /** `Sample document, no file` for a document with nothing attached, else null. */
  no_file_label: string | null;
  /** `Added by you` / `Added by HR` for a document; null for a letter or payslip. */
  added_by_label: string | null;
  /** Needs the employee's acknowledgement (shown first, even in the sample company). */
  awaiting_acknowledgement: boolean;
  /** `Acknowledged on 12 Oct 2026` once acknowledged. */
  acknowledged_label: string | null;
  /** Awaiting, and not in the sample company, where the database refuses it: the only condition for the button. */
  can_acknowledge: boolean;
  /** A document with a file, outside the sample company. */
  can_download: boolean;
  /** The employee's own upload, outside the sample company. */
  can_remove: boolean;
  /** Where a letter or a payslip lives; null for a document. */
  href: string | null;
};

export type MyDocumentsModel =
  | { linked: false }
  | {
      linked: true;
      /** Add one with `addMyDocumentAction` (not in the sample company). */
      can_upload: boolean;
      employee_id: string;
      /** Tiles: the viewer's documents (files), those awaiting acknowledgement, expiring within 90 days, payslips. */
      documents: number;
      awaiting_acknowledgement: number;
      expiring_soon: number;
      expired: number;
      payslips: number;
      letters: number;
      /** Awaiting acknowledgement first; then newest first. */
      rows: MyDocumentRow[];
    };

const dateOfDocument = (doc: HrDocument): string => malaysiaDate(doc.created_at);
const byNewest = (a: { sort: string; title: string }, b: { sort: string; title: string }) =>
  a.sort === b.sort ? a.title.localeCompare(b.title) : b.sort.localeCompare(a.sort);

/**
 * The viewer's own documents, issued letters and paid payslips in one list. Whatever the provider returned, only
 * the viewer's own rows are used, a letter only once issued, a payslip only once paid: a draft letter or payslip
 * never gets as far as a row or a count. Anything awaiting acknowledgement comes first.
 */
export function buildMyDocumentsModel(input: {
  documents: HrDocument[];
  letters: Letter[];
  payslips: Payslip[];
  today: string;
  viewer: PeopleViewer;
}): MyDocumentsModel {
  const { viewer, today } = input;
  if (viewer.employeeId === null) return { linked: false };
  const documents = ownRows(input.documents, viewer);
  const letters = ownRows(input.letters, viewer).filter((letter) => letter.status === 'issued');
  const payslips = ownRows(input.payslips, viewer).filter((slip) => slip.status === 'paid');

  const rows: { sort: string; title: string; row: MyDocumentRow }[] = [
    ...documents.map((doc) => {
      const expiry = expiryState(doc.expires_on, today);
      const awaiting = documentAwaiting(doc);
      const sort = dateOfDocument(doc);
      const row: MyDocumentRow = {
        id: doc.id,
        kind: 'document',
        title: doc.title,
        type_label: DOCUMENT_TYPE_LABEL[doc.doc_type],
        date_label: sort ? formatDate(sort) : '—',
        expiry,
        expiry_label: expiryLabel(doc, expiry),
        file_label: fileLabel(doc),
        no_file_label: doc.has_file ? null : NO_FILE_LABEL,
        added_by_label: doc.source === 'employee' ? 'Added by you' : 'Added by HR',
        awaiting_acknowledgement: awaiting,
        acknowledged_label: readOn(doc.acknowledged_at),
        can_acknowledge: awaiting && !viewer.isDemo,
        can_download: doc.has_file && !viewer.isDemo,
        can_remove: doc.source === 'employee' && !viewer.isDemo,
        href: null,
      };
      return { sort, title: doc.title, row };
    }),
    ...letters.map((letter) => {
      const awaiting = letterAwaiting(letter);
      const sort = letter.issued_on ?? malaysiaDate(letter.created_at);
      const row: MyDocumentRow = {
        id: letter.id,
        kind: 'letter',
        title: letter.title,
        type_label: LETTER_TYPE_LABEL[letter.letter_type],
        date_label: sort ? formatDate(sort) : '—',
        expiry: 'none',
        expiry_label: null,
        file_label: null,
        no_file_label: null,
        added_by_label: null,
        awaiting_acknowledgement: awaiting,
        acknowledged_label: readOn(letter.acknowledged_at),
        can_acknowledge: awaiting && !viewer.isDemo,
        can_download: false,
        can_remove: false,
        href: '/people/letters',
      };
      return { sort, title: letter.title, row };
    }),
    ...payslips.map((slip) => {
      const row: MyDocumentRow = {
        id: slip.id,
        kind: 'payslip',
        title: `Payslip, ${monthYearLabel(slip.period_month)}`,
        type_label: 'Payslip',
        date_label: monthYearLabel(slip.period_month),
        expiry: 'none',
        expiry_label: null,
        file_label: null,
        no_file_label: null,
        added_by_label: null,
        awaiting_acknowledgement: false,
        acknowledged_label: null,
        can_acknowledge: false,
        can_download: false,
        can_remove: false,
        href: '/people/my-payslips',
      };
      return { sort: slip.period_month, title: row.title, row };
    }),
  ].sort((a, b) => Number(b.row.awaiting_acknowledgement) - Number(a.row.awaiting_acknowledgement) || byNewest(a, b));

  const states = documents.map((doc) => expiryState(doc.expires_on, today));
  return {
    linked: true,
    can_upload: !viewer.isDemo,
    employee_id: viewer.employeeId,
    documents: documents.length,
    awaiting_acknowledgement: awaitingAcknowledgement(documents, letters, viewer),
    expiring_soon: states.filter((state) => state === 'expiring').length,
    expired: states.filter((state) => state === 'expired').length,
    payslips: payslips.length,
    letters: letters.length,
    rows: rows.map((entry) => entry.row),
  };
}

export type EmployeeDocumentRow = {
  id: string;
  title: string;
  doc_type: DocumentType;
  type_label: string;
  expires_on: string | null;
  expiry: ExpiryState;
  expiry_label: string | null;
  date_label: string;
  file_label: string | null;
  no_file_label: string | null;
  source: 'hr' | 'employee';
  /** `Added by HR` / `Uploaded by the employee`. */
  added_by_label: string;
  ack_requested: boolean;
  /** `Not asked`, `Waiting for the employee`, or `Acknowledged on 12 Oct 2026`. */
  ack_label: string;
  acknowledged_at: string | null;
  can_download: boolean;
  /** Asking for an acknowledgement is allowed only for a document HR added. */
  can_request_ack: boolean;
  can_withdraw_ack: boolean;
};

export type EmployeeDocumentsModel =
  | { allowed: false }
  | { allowed: true; employee_id: string; total: number; expiring_soon: number; expired: number; rows: EmployeeDocumentRow[] };

/**
 * One employee's documents for an owner or admin (the Employees screen's Documents action). Everyone else gets
 * nothing: an employee's own list is My Documents.
 */
export function buildEmployeeDocumentsModel(input: {
  documents: HrDocument[];
  employeeId: string;
  today: string;
  viewer: PeopleViewer;
}): EmployeeDocumentsModel {
  const { viewer, today, employeeId } = input;
  if (!canManageDocuments(viewer)) return { allowed: false };
  const documents = input.documents.filter((doc) => doc.employee_id === employeeId);
  const rows = documents
    .map((doc) => {
      const expiry = expiryState(doc.expires_on, today);
      const sort = dateOfDocument(doc);
      const row: EmployeeDocumentRow = {
        id: doc.id,
        title: doc.title,
        doc_type: doc.doc_type,
        type_label: DOCUMENT_TYPE_LABEL[doc.doc_type],
        expires_on: doc.expires_on,
        expiry,
        expiry_label: expiryLabel(doc, expiry),
        date_label: sort ? formatDate(sort) : '—',
        file_label: fileLabel(doc),
        no_file_label: doc.has_file ? null : NO_FILE_LABEL,
        source: doc.source,
        added_by_label: doc.source === 'employee' ? 'Uploaded by the employee' : 'Added by HR',
        ack_requested: doc.ack_requested,
        ack_label: doc.acknowledged_at ? (readOn(doc.acknowledged_at) ?? '') : doc.ack_requested ? 'Waiting for the employee' : 'Not asked',
        acknowledged_at: doc.acknowledged_at,
        can_download: doc.has_file,
        can_request_ack: doc.source === 'hr' && !doc.ack_requested,
        can_withdraw_ack: doc.source === 'hr' && doc.ack_requested,
      };
      return { sort, title: doc.title, row };
    })
    .sort(byNewest)
    .map((entry) => entry.row);
  return {
    allowed: true,
    employee_id: employeeId,
    total: rows.length,
    expiring_soon: rows.filter((row) => row.expiry === 'expiring').length,
    expired: rows.filter((row) => row.expiry === 'expired').length,
    rows,
  };
}

/* ----------------------------------------------------------------- Letters */

export type LetterRow = {
  id: string;
  employee_id: string;
  title: string;
  employee_name: string;
  letter_type: LetterType;
  type_label: string;
  date_label: string;
  status: Letter['status'];
  /** The letter's text, for the viewer's printable layout. */
  body: string;
  ack_requested: boolean;
  acknowledged_at: string | null;
  /** Issued, asked for, not yet read by the employee (the owner's view of "waiting"). */
  awaiting_acknowledgement: boolean;
  acknowledged_label: string | null;
  /** The addressee only, on an issued letter that asks, outside the sample company. */
  can_acknowledge: boolean;
  /** Known placeholders still in the title or body of a DRAFT, in the order they appear; none for an issued letter. */
  unfilled: string[];
  /** Owners and admins only, outside the sample company. */
  can_edit: boolean;
  can_delete: boolean;
  /** A draft with text and no placeholder left. */
  can_issue: boolean;
  can_unissue: boolean;
};

export type LettersModel = {
  /** True for HR and the demo: the rows are the team's. Otherwise they are the viewer's own issued letters. */
  team: boolean;
  /** Owners and admins outside the sample company: the controls (New letter, Edit, Issue, ...) exist. */
  can_manage: boolean;
  /** Null for someone who is not on the team view: those figures would be the team's. */
  totals: { issued_this_year: number; drafts: number; issued_this_month: number } | null;
  by_type: { key: string; label: string; value: number; color: string }[] | null;
  rows: LetterRow[];
};

const LETTER_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

/** A letter's date: when it was issued, or for a draft (or a missing date) when it was started. */
const letterDate = (letter: Letter) => letter.issued_on ?? malaysiaDate(letter.created_at);

export function buildLettersModel(letters: Letter[], viewer: PeopleViewer, today: string): LettersModel {
  const team = isTeamView(viewer);
  const manage = canManageDocuments(viewer);
  // A member sees their own issued letters only, whatever the provider returned: a draft is not even a count.
  const visible = team ? letters : ownRows(letters, viewer).filter((letter) => letter.status === 'issued');
  const rows = [...visible]
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
      const unfilled = l.status === 'draft' ? unfilledInLetter(l.title, l.body) : [];
      const awaiting = letterAwaiting(l);
      return {
        id: l.id,
        employee_id: l.employee_id,
        title: l.title,
        employee_name: l.employee_name,
        letter_type: l.letter_type,
        type_label: LETTER_TYPE_LABEL[l.letter_type],
        date_label: date ? formatDate(date) : '—',
        status: l.status,
        body: l.body,
        ack_requested: l.ack_requested,
        acknowledged_at: l.acknowledged_at,
        awaiting_acknowledgement: awaiting,
        acknowledged_label: readOn(l.acknowledged_at),
        can_acknowledge: awaiting && viewer.employeeId === l.employee_id && !viewer.isDemo,
        unfilled,
        can_edit: manage && l.status === 'draft',
        can_delete: manage && l.status === 'draft',
        can_issue: manage && l.status === 'draft' && l.body.trim() !== '' && unfilled.length === 0,
        can_unissue: manage && l.status === 'issued',
      };
    });
  if (!team) return { team, can_manage: false, totals: null, by_type: null, rows };

  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  const issued = letters.filter((l) => l.status === 'issued');
  const issuedThisYear = issued.filter((l) => l.issued_on?.startsWith(year));
  return {
    team,
    can_manage: manage,
    totals: {
      issued_this_year: issuedThisYear.length,
      drafts: letters.filter((l) => l.status === 'draft').length,
      issued_this_month: issued.filter((l) => l.issued_on?.startsWith(month)).length,
    },
    by_type: sumBy(issuedThisYear, (l) => l.letter_type, () => 1).map((entry, index) => ({
      key: entry.key,
      label: LETTER_TYPE_LABEL[entry.key as LetterType],
      value: entry.value,
      color: LETTER_COLORS[index % LETTER_COLORS.length],
    })),
    rows,
  };
}

export type LetterTemplateRow = {
  id: string;
  name: string;
  letter_type: LetterType;
  type_label: string;
  title: string;
  body: string;
  lang: LetterLang;
  /** "English" or "Bahasa Malaysia": the language a letter's dates and salary are written in. */
  lang_label: string;
};

export type LetterTemplatesModel =
  | { allowed: false }
  /** `can_manage` is false in the sample company: the templates are shown, nothing can be changed. */
  | { allowed: true; can_manage: boolean; rows: LetterTemplateRow[] };

/** Templates are for owners and admins (and the sample company's visitors, read-only). Anyone else gets none. */
export function buildLetterTemplatesModel(templates: LetterTemplate[], viewer: PeopleViewer): LetterTemplatesModel {
  if (!isTeamView(viewer)) return { allowed: false };
  return {
    allowed: true,
    can_manage: canManageDocuments(viewer),
    rows: [...templates]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ ...t, type_label: LETTER_TYPE_LABEL[t.letter_type], lang_label: LETTER_LANG_LABEL[t.lang] ?? LETTER_LANG_LABEL.en })),
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

const multiplier = (value: number) => `${value}x`;

export type SettingsModel =
  | { hr_only: true }
  | {
      hr_only: false;
      working_days: string;
      /** The attendance settings as the form edits them. */
      attendance: { work_week: Weekday[]; work_start_time: string; late_grace_minutes: number };
      annual_leave_days: string;
      medical_leave_days: string;
      emergency_leave_days: string;
      overtime: { label: string; value: string }[];
    };

export function buildSettingsModel(settings: PeopleSettings): SettingsModel {
  return {
    hr_only: false,
    working_days: workWeekLabel(settings.work_week),
    attendance: {
      work_week: [...settings.work_week],
      work_start_time: settings.work_start_time,
      late_grace_minutes: settings.late_grace_minutes,
    },
    annual_leave_days: String(settings.default_annual_leave_days),
    medical_leave_days: String(settings.default_medical_leave_days),
    emergency_leave_days: String(settings.default_emergency_leave_days),
    overtime: [
      { label: 'Weekday', value: multiplier(settings.overtime_rates.weekday) },
      { label: 'Rest day', value: multiplier(settings.overtime_rates.rest_day) },
      { label: 'Public holiday', value: multiplier(settings.overtime_rates.public_holiday) },
    ],
  };
}

/** Settings are for owners and admins (and the demo). Anyone else gets the notice and nothing is read. */
export async function loadSettingsModel(data: PeopleData, viewer: PeopleViewer): Promise<SettingsModel> {
  if (!isTeamView(viewer)) return { hr_only: true };
  return buildSettingsModel(await data.getSettings());
}
