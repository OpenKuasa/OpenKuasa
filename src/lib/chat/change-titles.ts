/**
 * The wording of an approval card: what a change is, and the name of the
 * thing it is about. Pure, so the server can word a change a specialist
 * prepared and the chat can word one it finds in a message.
 */
// Itself pure and import-free: the words for the application form switches live with the switches.
import { describeFormChange } from '@/lib/hire/application-form';
import { REASON_LABEL } from '@/lib/hire/application-changes';
import { STAGE_LABEL } from '@/lib/hire/applications-view';
import { PIPELINE_CARD_DETAIL, pipelineCardTitle, poolCardDetail, poolCardTitle } from '@/lib/hire/pool';
import { interviewCardDetail, interviewCardTitle } from '@/lib/hire/interviews';
import { feedbackCardDetail, feedbackCardTitle } from '@/lib/hire/interview-feedback';
import { isRealDate, monthLabel, weekdayName } from '@/lib/people/dates';
import { blank, hhmm } from '@/lib/people/loose-input';
import { unfilledInLetter } from '@/lib/people/letter-placeholders';
import { LETTER_TYPE_LABEL } from '@/lib/people/own';
import { toPeriod, toScore } from '@/lib/people/performance-forms';
import { STATUTORY_FIELDS } from '@/lib/people/statutory-fields';
import { centsToRinggit, monthLabel as payrollMonthLabel, ringgitToCents, toStatutoryInput } from '@/lib/people/payroll-forms';
import type { ReceiptState } from '@/lib/people/receipts';

const APPOINTMENT_STATUS_LABELS: Record<string, string> = {
  scheduled: 'scheduled',
  completed: 'completed',
  cancelled: 'cancelled',
  no_show: 'no-show',
};

/**
 * What a row is called: its name, or for a leave or time-off request the words
 * that say which request it is ("Amirul's annual leave, 16 Oct"). A request has
 * no name of its own, so it is only labelled when the caller asks for that kind.
 */
function labelOf(row: Record<string, unknown>, kind?: ItemKind): string | null {
  if (kind === 'goal' || kind === 'review' || kind === 'training' || kind === 'announcement') return performanceFact(row, kind);
  if (kind === 'letter' || kind === 'document') return letterDocumentFact(row, kind);
  if (kind === 'application' || kind === 'interview') {
    // A listApplications row has `candidate` and `job`, not `name`. So has an interview's row, and the result of an
    // interview change: the card's own line gives the time, so an interview is named by the person and the job alone.
    const who = text(row.candidate);
    if (!who) return null;
    const job = text(row.job);
    return job ? `${who} (${job})` : who;
  }
  if (kind === 'holiday') {
    const name = text(row.name);
    if (!name) return null;
    const when = dateText(row.date ?? row.holiday_date);
    return when ? `${name}, ${when}` : name;
  }
  if (kind === 'settings') {
    // Not a name: the settings as they are now, so a save card can show only what it changes.
    const week = weekWords(row.work_week);
    const start = timeText(row.work_start_time);
    const grace = row.late_grace_minutes;
    if (!week || !start || typeof grace !== 'number') return null;
    return JSON.stringify({ week: week.key, start, grace });
  }
  if (kind === 'claim') {
    const who = text(row.employee);
    if (!who) return null;
    // The lookup formatted the amount already; only a well-formed one is repeated.
    const amount = typeof row.amount === 'string' && /^RM [\d,]+\.\d{2}$/.test(row.amount) ? row.amount : null;
    const category = typeof row.category_code === 'string' ? CLAIM_WORDS[row.category_code] : undefined;
    const what = [amount, category].filter(Boolean).join(' ');
    return `${who}'s ${what ? `${what} claim` : 'claim'}`;
  }
  if (kind === 'overtime') {
    const who = text(row.employee);
    const when = dayRangeText(row.work_date, row.work_date);
    if (!who || !when) return null;
    const hours = hoursText(row.hours);
    return `${who}'s ${hours ? `${hours} of overtime` : 'overtime'} on ${when}`;
  }
  if (kind === 'leave' || kind === 'time-off') {
    const who = text(row.employee);
    const when = kind === 'leave' ? dayRangeText(row.start_date, row.end_date) : dayRangeText(row.off_date, row.off_date);
    if (!who || !when) return null;
    if (kind === 'time-off') return `${who}'s time-off, ${when}`;
    const type = typeof row.leave_type === 'string' ? LEAVE_WORDS[row.leave_type] : undefined;
    return `${who}'s ${type ?? 'leave'}, ${when}`;
  }
  // Finance documents are named by their number, falling back to the counterparty
  // while still a draft (no number yet). Payments and refunds key on a transaction
  // id, not `id`, so they are not named here.
  if (kind === 'invoice') return text(row.invoice_no) ?? text(row.customer_name);
  if (kind === 'quotation') return text(row.quotation_no) ?? text(row.customer_name);
  if (kind === 'bill') return text(row.bill_no) ?? text(row.supplier_name);
  if (kind === 'credit-note') return text(row.credit_note_no) ?? text(row.customer_name);
  if (kind === 'finance-contact' || kind === 'item') return text(row.name);
  return typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null;
}

/** A named row with this id, anywhere in a tool result (a listing, or a saved row). */
function nameOf(value: unknown, id: string, kind?: ItemKind, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 3) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nameOf(item, id, kind, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const row = value as Record<string, unknown>;
  if (row.id === id) {
    const label = labelOf(row, kind);
    if (label) return label;
  }
  for (const inner of Object.values(row)) {
    const found = nameOf(inner, id, kind, depth + 1);
    if (found) return found;
  }
  return null;
}

/** What kind of thing each tool's result is about, so an id is only named from the right kind. */
export type ItemKind =
  | 'campaign'
  | 'creative'
  | 'form'
  | 'lead'
  | 'contact'
  | 'deal'
  | 'stage'
  | 'follow-up'
  | 'schedule'
  | 'job'
  | 'application'
  | 'candidate'
  | 'interview'
  | 'employee'
  | 'department'
  | 'leave'
  | 'time-off'
  | 'claim'
  | 'overtime'
  | 'holiday'
  | 'settings'
  | 'payslip'
  | 'payslip-line'
  | 'payroll-run'
  | 'goal'
  | 'review'
  | 'training'
  | 'announcement'
  | 'letter'
  | 'document'
  | 'template'
  | 'invoice'
  | 'quotation'
  | 'bill'
  | 'credit-note'
  | 'finance-contact'
  | 'item';
const KIND_OF_TOOL: Record<string, ItemKind> = {
  getCampaigns: 'campaign',
  createCampaign: 'campaign',
  updateCampaign: 'campaign',
  setCampaignStatus: 'campaign',
  getCreatives: 'creative',
  createCreative: 'creative',
  updateCreative: 'creative',
  listForms: 'form',
  createForm: 'form',
  updateForm: 'form',
  setFormStatus: 'form',
  listContacts: 'lead',
  createLead: 'lead',
  updateLead: 'lead',
  setLeadStage: 'lead',
  // Its result is the contact it made.
  promoteLeadToContact: 'contact',
  listCrmContacts: 'contact',
  createContact: 'contact',
  updateContact: 'contact',
  scheduleWeeklyStudio: 'schedule',
  listDeals: 'deal',
  createDeal: 'deal',
  updateDeal: 'deal',
  moveDeal: 'deal',
  markDealLost: 'deal',
  reopenDeal: 'deal',
  listPipelines: 'stage',
  deleteContact: 'contact',
  deleteDeal: 'deal',
  listFollowUps: 'follow-up',
  completeFollowUp: 'follow-up',
  listJobs: 'job',
  createJob: 'job',
  updateJob: 'job',
  setJobStatus: 'job',
  deleteJob: 'job',
  listApplications: 'application',
  moveApplication: 'application',
  rejectApplication: 'application',
  reopenApplication: 'application',
  rateApplication: 'application',
  deleteApplication: 'application',
  // Rows and results of all three carry the candidate's `id` and `name`.
  listCandidates: 'candidate',
  addCandidate: 'candidate',
  updateCandidate: 'candidate',
  deleteCandidate: 'candidate',
  // The pool lookup's rows, and both pool changes' results, carry the candidate's `id` and `name`.
  listTalentPool: 'candidate',
  setPoolStatus: 'candidate',
  moveToPipeline: 'candidate',
  // An interview's row, and the result of each of the six interview changes, carry the interview's `id` with `candidate`
  // and `job`. The two that take an application's id (scheduleInterview, recordPastInterview) answer with the NEW
  // interview's id, so they are an interview's too: a later turn can name that interview, and its id counts as looked up.
  listInterviews: 'interview',
  scheduleInterview: 'interview',
  recordPastInterview: 'interview',
  rescheduleInterview: 'interview',
  cancelInterview: 'interview',
  setInterviewOutcome: 'interview',
  reopenInterview: 'interview',
  // The two changes to an interview's feedback answer with the interview's `id`, `candidate` and `job` too.
  saveInterviewFeedback: 'interview',
  clearInterviewFeedback: 'interview',
  listEmployees: 'employee',
  getEmployee: 'employee',
  createEmployee: 'employee',
  updateEmployee: 'employee',
  setEmployeeStatus: 'employee',
  deleteEmployee: 'employee',
  linkEmployeeToMember: 'employee',
  listLeaveRequests: 'leave',
  listTimeOffRequests: 'time-off',
  listClaims: 'claim',
  listOvertime: 'overtime',
  listPublicHolidays: 'holiday',
  saveHoliday: 'holiday',
  // A save's result carries the values now set, so the newest of lookup or save is "current".
  getAttendanceSettings: 'settings',
  saveAttendanceSettings: 'settings',
  // A payslip lookup names the payslip (employee and month), the four figures now, and each of its lines, by id.
  listPayslips: 'payslip',
  // The payroll change tools hand back what they changed, so a later card believes the newest of lookup or change.
  savePayslipLine: 'payslip',
  removePayslipLine: 'payslip',
  setPayslipStatutory: 'payslip',
  removePayslip: 'payslip',
  // Goals, reviews, courses and announcements: a lookup row and a change's result carry the same fields, so the
  // newest of the two is what a later card believes.
  listGoals: 'goal',
  saveGoal: 'goal',
  removeGoal: 'goal',
  listReviews: 'review',
  saveReview: 'review',
  releaseReview: 'review',
  deleteReview: 'review',
  listTrainings: 'training',
  saveTraining: 'training',
  removeTraining: 'training',
  listAnnouncements: 'announcement',
  saveAnnouncement: 'announcement',
  publishAnnouncement: 'announcement',
  unpublishAnnouncement: 'announcement',
  removeAnnouncement: 'announcement',
  // Letters and documents: a lookup row and a change's result carry the same fields. `requestAcknowledgement` is a
  // letter or a document by what it returned: see `kindOfResult`.
  listLetters: 'letter',
  saveLetter: 'letter',
  startLetterFromTemplate: 'letter',
  issueLetter: 'letter',
  listDocuments: 'document',
  listLetterTemplates: 'template',
  listDepartments: 'department',
  createDepartment: 'department',
  updateDepartment: 'department',
  deleteDepartment: 'department',
  // Finance (Bendahara)
  listInvoices: 'invoice',
  getInvoice: 'invoice',
  saveInvoice: 'invoice',
  postInvoice: 'invoice',
  voidInvoice: 'invoice',
  deleteInvoice: 'invoice',
  setEInvoice: 'invoice',
  listQuotations: 'quotation',
  saveQuotation: 'quotation',
  sendQuotation: 'quotation',
  acceptQuotation: 'quotation',
  declineQuotation: 'quotation',
  convertQuotation: 'quotation',
  deleteQuotation: 'quotation',
  listBills: 'bill',
  getBill: 'bill',
  saveBill: 'bill',
  postBill: 'bill',
  voidBill: 'bill',
  deleteBill: 'bill',
  listCreditNotes: 'credit-note',
  saveCreditNote: 'credit-note',
  issueCreditNote: 'credit-note',
  voidCreditNote: 'credit-note',
  deleteCreditNote: 'credit-note',
  listFinanceContacts: 'finance-contact',
  createFinanceContact: 'finance-contact',
  updateFinanceContact: 'finance-contact',
  setFinanceContactActive: 'finance-contact',
  deleteFinanceContact: 'finance-contact',
  listFinanceItems: 'item',
  createFinanceItem: 'item',
  updateFinanceItem: 'item',
  setFinanceItemActive: 'item',
  deleteFinanceItem: 'item',
};

/** The kind of thing a tool's result, or a change tool's `id`, is about. Undefined for a tool that names none. */
export function kindOfTool(toolName: string): ItemKind | undefined {
  if (Object.hasOwn(KIND_OF_TOOL, toolName)) return KIND_OF_TOOL[toolName];
  return Object.hasOwn(SUBJECT_ONLY, toolName) ? SUBJECT_ONLY[toolName] : undefined;
}

// Tools whose `id` is of a known kind but whose result names nothing (the row is gone).
const SUBJECT_ONLY: Record<string, ItemKind> = {
  deleteCampaign: 'campaign',
  deleteCreative: 'creative',
  deleteForm: 'form',
  deleteLead: 'lead',
};

/** Names by `kind:id`, so a later turn can still say what an id refers to. */
export type KnownNames = Record<string, string>;

const NAMES_MAX = 200;

function gather(value: unknown, kind: ItemKind, into: KnownNames, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 3) return;
  if (Array.isArray(value)) {
    for (const item of value) gather(item, kind, into, depth + 1);
    return;
  }
  const row = value as Record<string, unknown>;
  const label = typeof row.id === 'string' ? labelOf(row, kind) : null;
  if (typeof row.id === 'string' && label) {
    const key = `${kind}:${row.id}`;
    if (key in into || Object.keys(into).length < NAMES_MAX) into[key] = label;
  }
  for (const inner of Object.values(row)) gather(inner, kind, into, depth + 1);
}

/**
 * The tools that name a candidate from the talent pool's side: the pool lookup, which sees pool members only, and
 * the two pool changes, whose id may have come from it. By a first name the pool lookup can answer "one" when two
 * people on file have that name, so an id known only from these is not enough for a deletion (see `knownOnFile`).
 */
const POOL_SIDE_TOOLS = new Set(['listTalentPool', 'setPoolStatus', 'moveToPipeline']);
const FROM_POOL = 'candidate-from-pool:';
const ON_FILE = 'candidate-on-file:';

/** These results without the ones that name a candidate from the pool's side only. */
export function withoutPoolSide(results: ToolResult[]): ToolResult[] {
  return results.filter((result) => !POOL_SIDE_TOOLS.has(result.tool));
}

/**
 * True when the names kept from earlier turns hold this candidate from a lookup of everyone on file, and not only
 * from the pool's side. Names kept before the pool lookup returned ids carry neither mark, and count as on file.
 */
export function knownOnFile(names: KnownNames | undefined, id: unknown): boolean {
  if (!names || typeof id !== 'string' || !names[`candidate:${id}`]) return false;
  return Boolean(names[`${ON_FILE}${id}`]) || !names[`${FROM_POOL}${id}`];
}

/**
 * Tools whose results name an employee beside their `employee_id` (a goal, a review, an enrolment): the person is
 * known from them as well as from listEmployees, because these are the lookups the change tools point the model to.
 */
const EMPLOYEE_SOURCES = new Set([
  'listGoals',
  'listReviews',
  'listTrainings',
  'saveGoal',
  'saveReview',
  'releaseReview',
  'enrolInTraining',
  'withdrawFromTraining',
  'setTrainingCompleted',
  'listDocuments',
  'listLetters',
  'saveLetter',
  'startLetterFromTemplate',
  'issueLetter',
  'requestAcknowledgement',
]);

/** What kind of thing a tool's result is about: by its tool, except `requestAcknowledgement`, which says which it acted on. */
function kindOfResult(result: ToolResult): ItemKind | undefined {
  if (result.tool !== 'requestAcknowledgement') return KIND_OF_TOOL[result.tool];
  const output = asRecord(result.output);
  const item = asRecord(output?.data)?.item ?? output?.item;
  return item === 'letter' ? 'letter' : item === 'document' ? 'document' : undefined;
}

/** Calls `each` for every `employee_id` with a name beside it, anywhere in a result (a course's people sit four deep). */
function eachNamedEmployee(value: unknown, each: (id: string, name: string) => void, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) eachNamedEmployee(item, each, depth + 1);
    return;
  }
  const row = value as Record<string, unknown>;
  const name = text(row.employee) ?? text(row.name);
  if (typeof row.employee_id === 'string' && row.employee_id && name) each(row.employee_id, name);
  for (const inner of Object.values(row)) eachNamedEmployee(inner, each, depth + 1);
}

/** Every named row in a set of tool results, by the kind of thing its tool is about. */
export function collectNames(results: ToolResult[], into: KnownNames = {}): KnownNames {
  for (const result of results) {
    const kind = kindOfResult(result);
    if (kind === 'candidate') {
      // A candidate's name is kept with a mark of which side it came from, or not at all: a name whose mark
      // did not fit under the cap would read as one from before the marks, which counts as on file.
      const found: KnownNames = {};
      gather(result.output, kind, found);
      const prefix = POOL_SIDE_TOOLS.has(result.tool) ? FROM_POOL : ON_FILE;
      for (const [key, label] of Object.entries(found)) {
        const mark = `${prefix}${key.slice('candidate:'.length)}`;
        const more = (key in into ? 0 : 1) + (mark in into ? 0 : 1);
        if (Object.keys(into).length + more > NAMES_MAX) continue;
        into[key] = label;
        into[mark] = '1';
      }
      continue;
    }
    // Payslips and their lines are read in order below, so the newest word on each one wins.
    if (kind && kind !== 'payslip') gather(result.output, kind, into);
  }
  for (const result of results) {
    if (!EMPLOYEE_SOURCES.has(result.tool)) continue;
    eachNamedEmployee(result.output, (id, name) => {
      const key = `employee:${id}`;
      if (!(key in into) && Object.keys(into).length < NAMES_MAX) into[key] = name;
    });
  }
  if (results.some((r) => PAYSLIP_TOOLS.has(r.tool))) {
    const state = payslipState(results);
    for (const [id, fact] of state.slips) {
      if (fact === null) delete into[`payslip:${id}`];
      else if (`payslip:${id}` in into || Object.keys(into).length < NAMES_MAX) into[`payslip:${id}`] = JSON.stringify(fact);
    }
    for (const [id, fact] of state.lines) {
      if (fact === null) delete into[`payslip-line:${id}`];
      else if (`payslip-line:${id}` in into || Object.keys(into).length < NAMES_MAX) into[`payslip-line:${id}`] = JSON.stringify(fact);
    }
  }
  return into;
}

/** What a tool returned, by the tool's name. */
export type ToolResult = { tool: string; output: unknown };

/** Looks up the name of a row by its id, optionally only among results of one kind. */
export type NameFinder = (id: unknown, kind?: ItemKind) => string | null;

/**
 * Finds the name of a row by its id. A change tool is given ids, and the
 * assistant got each id from an earlier tool result (a listing, or the row it
 * created), so the name is there too. With a `kind`, only results about that
 * kind of thing count: an id that belongs to a contact must never put the
 * contact's name on a card about a deal. Later results win.
 */
export function nameIn(results: ToolResult[]): NameFinder {
  let state: PayslipState | null = null;
  return (id, kind) => {
    if (typeof id !== 'string' || !id) return null;
    if (kind === 'payslip' || kind === 'payslip-line' || kind === 'payroll-run') {
      state ??= payslipState(results);
      if (kind === 'payroll-run') return state.runs.get(id) ?? null;
      const fact = kind === 'payslip' ? state.slips.get(id) : state.lines.get(id);
      return fact ? JSON.stringify(fact) : null;
    }
    for (let r = results.length - 1; r >= 0; r -= 1) {
      if (kind && kindOfResult(results[r]) !== kind) continue;
      const found = nameOf(results[r].output, id, kind);
      if (found) return found;
    }
    if (kind === 'employee') {
      // Not in a directory result: a goal, review or enrolment lookup names the person beside their id.
      for (let r = results.length - 1; r >= 0; r -= 1) {
        if (!EMPLOYEE_SOURCES.has(results[r].tool)) continue;
        const hit: { name: string | null } = { name: null };
        eachNamedEmployee(results[r].output, (employeeId, name) => {
          if (employeeId === id && hit.name === null) hit.name = name;
        });
        if (hit.name) return hit.name;
      }
    }
    return null;
  };
}

/** Looks up a row by its id, as a lookup or an earlier change last returned it. */
export type RowFinder = (id: unknown, kind?: ItemKind) => Record<string, unknown> | null;

function rowOf(value: unknown, id: string, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || depth > 3) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = rowOf(item, id, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const row = value as Record<string, unknown>;
  if (row.id === id) return row;
  for (const inner of Object.values(row)) {
    const found = rowOf(inner, id, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Finds a row by its id among tool results, newest first: the values a card
 * shows as what is there now. With a `kind`, only results about that kind of
 * thing count, as for `nameIn`.
 */
export function rowIn(results: ToolResult[]): RowFinder {
  return (id, kind) => {
    if (typeof id !== 'string' || !id) return null;
    for (let r = results.length - 1; r >= 0; r -= 1) {
      if (kind && KIND_OF_TOOL[results[r].tool] !== kind) continue;
      const found = rowOf(results[r].output, id);
      if (found) return found;
    }
    return null;
  };
}

const UNLISTED_PAYSLIP = 'a payslip that was not in the list above';
const UNLISTED_LINE = 'a payslip line that was not in the list above';

const MONEY_WORDS = /^RM [\d,]+\.\d{2}$/;
const STATUTORY_WORDS: Record<string, string> = Object.fromEntries(STATUTORY_FIELDS.map((field) => [field, field.toUpperCase()]));

/**
 * What a model sends as a payroll month: `2026-10`, or the first of that month (`2026-10-01`). Null for anything
 * else, so the tool that runs the month and the card that names it agree. `YYYY-MM` otherwise.
 */
export function payrollMonth(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-01)?$/.exec(value.trim());
  return match && Number(match[1]) >= 2000 ? `${match[1]}-${match[2]}` : null;
}

/** An amount a model typed, as the text a form field would hold: a number is read as its digits; null, undefined and the rest as empty. */
export function looseAmount(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return typeof value === 'string' ? value : '';
}

type PayslipFact = { employee: string | null; month: string; figures: Record<string, string | null>; paid: boolean | null };
type LineFact = {
  payslip_id: string;
  employee: string | null;
  month: string;
  kind: 'earning' | 'deduction' | 'unpaid';
  label: string;
  amount: string | null;
  source: string | null;
};
type PayslipState = {
  /** null: removed. Absent: never seen. */
  slips: Map<string, PayslipFact | null>;
  lines: Map<string, LineFact | null>;
  /** Per month, `YYYY-MM`. */
  runs: Map<string, 'draft' | 'paid'>;
};

/** The tools whose results say something about a payslip, a line or a run. */
const PAYSLIP_TOOLS = new Set([
  'listPayslips',
  'getPayrollSummary',
  'runPayroll',
  'recalculatePayroll',
  'savePayslipLine',
  'removePayslipLine',
  'setPayslipStatutory',
  'removePayslip',
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const figureOf = (value: unknown): string | null => (typeof value === 'string' && MONEY_WORDS.test(value) ? value : null);
const monthKey = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
const lineKindOf = (value: unknown): LineFact['kind'] | null =>
  value === 'earning' || value === 'deduction' || value === 'unpaid' ? value : null;
const paidOf = (status: unknown, run: unknown): boolean | null =>
  status === 'paid' || run === 'paid' ? true : status === 'pending' || run === 'draft' ? false : null;

/**
 * What the conversation knows about payslips, their lines and runs, read in order so the newest word wins: a lookup,
 * or a change that came back (its result carries the payslip as it is after the change). A recalculation rebuilds
 * the month, so what was known about that month's figures and lines is dropped rather than trusted. Pure.
 */
function payslipState(results: ToolResult[]): PayslipState {
  const state: PayslipState = { slips: new Map(), lines: new Map(), runs: new Map() };
  const putLine = (raw: unknown, payslipId: string, employee: string | null, month: string) => {
    const line = asRecord(raw);
    const kind = line ? lineKindOf(line.kind) : null;
    const label = line ? text(line.label) : null;
    if (!line || typeof line.id !== 'string' || !kind || !label) return;
    state.lines.set(line.id, {
      payslip_id: payslipId,
      employee,
      month,
      kind,
      label,
      amount: figureOf(line.amount),
      source: typeof line.source === 'string' ? line.source : null,
    });
  };
  for (const { tool, output } of results) {
    const out = asRecord(output);
    if (!out) continue;
    if (tool === 'listPayslips') {
      for (const raw of Array.isArray(out.payslips) ? out.payslips : []) {
        const row = asRecord(raw);
        const employee = row ? text(row.employee) : null;
        const month = row ? monthKey(row.month) : null;
        if (!row || typeof row.id !== 'string' || !employee || !month) continue;
        const paid = paidOf(row.status, row.run_status);
        state.slips.set(row.id, {
          employee,
          month,
          paid,
          figures: { epf: figureOf(row.epf), socso: figureOf(row.socso), eis: figureOf(row.eis), pcb: figureOf(row.pcb) },
        });
        if (paid !== null) state.runs.set(month, paid ? 'paid' : 'draft');
        for (const line of Array.isArray(row.lines) ? row.lines : []) putLine(line, row.id, employee, month);
      }
      continue;
    }
    if (tool === 'getPayrollSummary') {
      for (const raw of Array.isArray(out.runs) ? out.runs : []) {
        const run = asRecord(raw);
        const month = run ? monthKey(run.month) : null;
        if (run && month && (run.status === 'paid' || run.status === 'draft')) state.runs.set(month, run.status);
      }
      continue;
    }
    // A change that failed changed nothing.
    const data = out.ok === true ? asRecord(out.data) : null;
    if (!data) continue;
    const month = monthKey(data.period);
    if (tool === 'runPayroll' || tool === 'recalculatePayroll') {
      if (!month) continue;
      state.runs.set(month, 'draft');
      if (tool === 'recalculatePayroll') {
        for (const [id, fact] of state.slips) {
          if (fact && fact.month === month) {
            state.slips.set(id, { ...fact, paid: false, figures: { epf: null, socso: null, eis: null, pcb: null } });
          }
        }
        for (const [id, fact] of [...state.lines]) if (fact && fact.month === month) state.lines.delete(id);
      }
      continue;
    }
    const slipId = typeof data.payslip_id === 'string' ? data.payslip_id : null;
    if (!slipId) continue;
    if (tool === 'removePayslip') {
      state.slips.set(slipId, null);
      for (const [id, fact] of state.lines) if (fact && fact.payslip_id === slipId) state.lines.set(id, null);
      continue;
    }
    if (!month) continue;
    const employee = text(data.employee) ?? state.slips.get(slipId)?.employee ?? null;
    state.slips.set(slipId, {
      employee,
      month,
      paid: paidOf(data.status, null),
      figures: { epf: figureOf(data.epf), socso: figureOf(data.socso), eis: figureOf(data.eis), pcb: figureOf(data.pcb) },
    });
    if (tool === 'savePayslipLine') putLine(data.line, slipId, employee, month);
    if (tool === 'removePayslipLine' && typeof data.removed_line_id === 'string') state.lines.set(data.removed_line_id, null);
  }
  return state;
}

function factsOf<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** "Aisyah Rahim's October 2026 payslip", or the words for one no lookup in the conversation showed. */
function payslipWords(find: NameFinder, id: unknown): { words: string; facts: PayslipFact | null; paid: boolean } {
  const facts = factsOf<PayslipFact>(find(id, 'payslip'));
  const label = facts ? payrollMonthLabel(facts.month) : '';
  const words = !facts ? UNLISTED_PAYSLIP : facts.employee ? `${facts.employee}'s ${label} payslip` : `the ${label} payslip`;
  const paid = facts ? (facts.paid ?? find(facts.month, 'payroll-run') === 'paid') : false;
  return { facts, words, paid };
}

/** `the earning “Sales commission”, RM 500.00` from a lookup, else the words for a line no lookup showed. */
function lineWords(find: NameFinder, id: unknown): { words: string; facts: LineFact | null } {
  const facts = factsOf<LineFact>(find(id, 'payslip-line'));
  return { facts, words: facts ? `the ${facts.kind} “${facts.label}”${facts.amount ? `, ${facts.amount}` : ''}` : UNLISTED_LINE };
}

/** A line the conversation shows is worked out by the system, so it is not the owner's to change. */
const systemLine = (facts: LineFact | null): boolean => facts !== null && facts.source !== null && facts.source !== 'hr';

const monthWords = (value: unknown): string => {
  const month = payrollMonth(value);
  return month ? payrollMonthLabel(month) : 'a month that could not be read';
};

const slipOf = (employee: string | null, month: string): string =>
  employee ? `${employee}'s ${payrollMonthLabel(month)} payslip` : `the ${payrollMonthLabel(month)} payslip`;

/**
 * The payroll cards' question. It reads the input through the tools' own normalisers (payrollMonth, looseAmount,
 * toStatutoryInput, ringgitToCents) and the conversation through `find`, so it never claims what it cannot know. A change
 * the conversation already shows the database will refuse (a paid payslip, a system line) says so instead.
 */
function payrollTitle(toolName: string, i: Record<string, unknown>, find: NameFinder): string {
  switch (toolName) {
    case 'runPayroll':
      return `Run payroll for ${monthWords(i.month)}? This creates a draft. Nobody is paid and employees can't see it yet.`;
    case 'recalculatePayroll': {
      return `Recalculate the ${monthWords(i.month)} draft? Your own lines and figures are kept.`;
    }
    case 'savePayslipLine': {
      const { words: slip } = payslipWords(find, i.payslip_id);
      const kind = i.kind === 'earning' || i.kind === 'deduction' ? i.kind : null;
      const label = text(i.label);
      const cents = ringgitToCents(looseAmount(i.amount));
      const what = `${kind ? `the ${kind}` : 'a line'}${label ? ` “${label}”` : ''}`;
      const amount = cents === null ? ' (the amount could not be read)' : `, ${centsToRinggit(cents)}`;
      const lineId = blank(i.line_id);
      if (lineId === null) return `Add ${what}${amount} to ${slip}?`;
      // A line last seen on another payslip is not named here: the detail says so.
      const line = lineOnPayslip(find, lineId, i.payslip_id) ? lineWords(find, lineId) : { words: UNLISTED_LINE };
      return `Change ${line.words} on ${slip} to ${what}${amount}?`;
    }
    case 'removePayslipLine': {
      const { words, facts } = lineWords(find, i.line_id);
      if (!facts) return `Remove ${words}?`;
      return `Remove ${words} from ${slipOf(facts.employee, facts.month)}?`;
    }
    case 'setPayslipStatutory': {
      const { words: slip, facts } = payslipWords(find, i.payslip_id);
      const field = typeof i.field === 'string' ? i.field : '';
      const figure = Object.hasOwn(STATUTORY_WORDS, field) ? STATUTORY_WORDS[field] : null;
      if (!figure) return `Change a statutory figure that could not be read on ${slip}?`;
      const converted = toStatutoryInput({ field, amount: looseAmount(i.amount) });
      if (!converted.ok) return `Set ${figure} on ${slip} to an amount that could not be read?`;
      const old = facts?.figures[field] ?? null;
      if (converted.input.amount_cents === null) {
        return `Put ${figure} on ${slip} back to the proposed amount${old ? ` (now ${old})` : ''}?`;
      }
      const next = centsToRinggit(converted.input.amount_cents);
      if (old === next) return `Keep ${figure} on ${slip} at ${next}, fixed by hand?`;
      return old ? `Change ${figure} on ${slip} from ${old} to ${next}?` : `Set ${figure} on ${slip} to ${next}?`;
    }
    case 'removePayslip': {
      return `Remove ${payslipWords(find, i.payslip_id).words} from the draft?`;
    }
    default:
      return 'Approve this change?';
  }
}

/** Whether a line the conversation knows is known to be on this payslip (or nothing is known about it). */
const lineOnPayslip = (find: NameFinder, lineId: unknown, payslipId: unknown): boolean => {
  const facts = factsOf<LineFact>(find(lineId, 'payslip-line'));
  return !facts || typeof payslipId !== 'string' || facts.payslip_id === payslipId;
};

/**
 * What the conversation suggests will make the database refuse a payroll change. It is a hedge in the detail, never a
 * change to the question: the card always states exactly what will be saved, and what the chat saw can be out of date
 * (paid can be undone on the Payroll screen).
 */
function payrollCaveat(toolName: string, i: Record<string, unknown>, find: NameFinder): string | null {
  if (toolName === 'recalculatePayroll') {
    const month = payrollMonth(i.month);
    return month && find(month, 'payroll-run') === 'paid'
      ? `The ${payrollMonthLabel(month)} run was paid when last checked, so this may be refused.`
      : null;
  }
  const lineId = toolName === 'removePayslipLine' ? i.line_id : toolName === 'savePayslipLine' ? blank(i.line_id) : null;
  if (typeof lineId === 'string') {
    const line = factsOf<LineFact>(find(lineId, 'payslip-line'));
    if (systemLine(line)) return 'This line is worked out by the system, so this will be refused.';
    if (toolName === 'savePayslipLine' && !lineOnPayslip(find, lineId, i.payslip_id)) {
      return 'This line was on a different payslip when last checked, so this may be refused.';
    }
    if (line && payslipWords(find, line.payslip_id).paid) return 'This payslip was paid when last checked, so this may be refused.';
  }
  if (toolName === 'savePayslipLine' || toolName === 'setPayslipStatutory' || toolName === 'removePayslip') {
    if (payslipWords(find, i.payslip_id).paid) return 'This payslip was paid when last checked, so this may be refused.';
  }
  return null;
}

/** The second line of a payroll card: what else the change does. */
function payrollDetail(toolName: string, i: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'savePayslipLine':
    case 'removePayslipLine':
      return 'Gross pay, the proposed EPF, SOCSO, EIS and PCB figures and net pay are worked out again. Figures you set yourself are kept.';
    case 'setPayslipStatutory': {
      const reset = toStatutoryInput({ field: typeof i.field === 'string' ? i.field : '', amount: looseAmount(i.amount) });
      if (reset.ok && reset.input.amount_cents === null) return 'The system proposes this figure again, and net pay changes with it.';
      return 'EPF, SOCSO, EIS and PCB are proposals for you to confirm, not official amounts. A figure you set is kept when the run is recalculated, and net pay changes with it.';
    }
    case 'removePayslip':
      return 'Their overtime on it is released. Recalculating the run adds them again if they are still eligible.';
    default:
      return null;
  }
}

// ---- Goals, reviews, courses and announcements -------------------------------------------
//
// A lookup row and a change's result carry the same fields, so one reader turns either into a fact, and
// `nameIn` (newest result first) makes the newest of the two what a later card believes. A fact is JSON text in the
// name finder, as for payslips. Every card states exactly what will be saved, in full; what the conversation
// suggests about the row's state is a hedged second sentence in the detail, never a change to the question.

const UNLISTED_GOAL = 'a goal that was not in the list above';
const UNLISTED_REVIEW = 'a review that was not in the list above';
const UNLISTED_COURSE = 'a course that was not in the list above';
const UNLISTED_ANNOUNCEMENT = 'an announcement that was not in the list above';

/** The four competencies in the order a card says them, with the key a tool takes them under. */
const COMPETENCY_ORDER: [string, string][] = [
  ['delivery', 'Delivery'],
  ['teamwork', 'Teamwork'],
  ['ownership', 'Ownership'],
  ['communication', 'Communication'],
];
const RATING_WORDS: Record<string, string> = {
  exceeds: 'exceeds expectations',
  meets: 'meets expectations',
  below: 'below expectations',
};
const GOAL_STATUS_WORDS: Record<string, string> = { on_track: 'on track', at_risk: 'at risk', done: 'done' };
const COURSE_STATES = ['upcoming', 'in_progress', 'completed'];

type GoalFact = { employee: string | null; title: string; progress: number | null; due_date: string | null; status: string | null };
type ReviewFact = {
  employee: string | null;
  period: string;
  scores: Record<string, number> | null;
  rating: string | null;
  score: number | null;
  comment: string | null;
  status: 'draft' | 'released' | null;
};
type CourseFact = {
  title: string;
  category: string | null;
  provider: string | null;
  starts_on: string | null;
  ends_on: string | null;
  status: string | null;
  completed_count: number | null;
};
type AnnouncementFact = { title: string; body: string; category: string | null; status: 'draft' | 'published' | null };

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const realDay = (value: unknown): string | null => (typeof value === 'string' && isRealDate(value) ? value : null);

/** The scores a lookup row or a result carries, by competency name; null when none is a number (an older review has `{}`). */
function scoresOf(value: unknown): Record<string, number> | null {
  const record = asRecord(value);
  if (!record) return null;
  const scores: Record<string, number> = {};
  for (const [, name] of COMPETENCY_ORDER) {
    const score = finite(record[name]);
    if (score !== null) scores[name] = score;
  }
  return Object.keys(scores).length > 0 ? scores : null;
}

/**
 * What the conversation knows about one goal, review, course or announcement, as JSON text, from a lookup row or a
 * change's result. A removal's result says only that the row is gone.
 */
function performanceFact(row: Record<string, unknown>, kind: 'goal' | 'review' | 'training' | 'announcement'): string | null {
  if (row.removed === true) return JSON.stringify({ removed: true });
  if (kind === 'goal') {
    const title = text(row.title);
    if (!title) return null;
    const fact: GoalFact = {
      employee: text(row.employee),
      title,
      progress: finite(row.progress),
      due_date: realDay(row.due_date),
      status: typeof row.status === 'string' && Object.hasOwn(GOAL_STATUS_WORDS, row.status) ? row.status : null,
    };
    return JSON.stringify(fact);
  }
  if (kind === 'review') {
    const period = text(row.period);
    if (!period) return null;
    const fact: ReviewFact = {
      employee: text(row.employee),
      period,
      scores: scoresOf(row.scores),
      rating: typeof row.rating === 'string' && Object.hasOwn(RATING_WORDS, row.rating) ? row.rating : null,
      score: finite(row.score),
      comment: text(row.comment),
      status: row.status === 'draft' || row.status === 'released' ? row.status : null,
    };
    return JSON.stringify(fact);
  }
  if (kind === 'training') {
    const title = text(row.title);
    if (!title) return null;
    const fact: CourseFact = {
      title,
      category: text(row.category),
      provider: text(row.provider),
      starts_on: realDay(row.starts_on),
      ends_on: realDay(row.ends_on),
      status: typeof row.status === 'string' && COURSE_STATES.includes(row.status) ? row.status : null,
      completed_count: finite(row.completed_count),
    };
    return JSON.stringify(fact);
  }
  const title = text(row.title);
  if (!title || typeof row.body !== 'string') return null;
  const fact: AnnouncementFact = {
    title,
    body: row.body,
    category: text(row.category),
    status: row.status === 'draft' || row.status === 'published' ? row.status : null,
  };
  return JSON.stringify(fact);
}

/** The fact for an id, or why there is none: `removed` when a change earlier in the chat deleted it. */
function factOf<T>(find: NameFinder, id: unknown, kind: ItemKind): { fact: T | null; removed: boolean } {
  const parsed = factsOf<Record<string, unknown>>(find(id, kind));
  if (!parsed) return { fact: null, removed: false };
  if (parsed.removed === true) return { fact: null, removed: true };
  return { fact: parsed as T, removed: false };
}

const numberWords = (n: number): string => String(n);

/** "5 Oct 2026 to 7 Oct 2026", "on 5 Oct 2026", or `missing` when a date is not there. */
function courseDates(from: unknown, to: unknown, missing = 'dates that could not be read'): string {
  const a = dateText(from);
  const b = dateText(to);
  if (!a || !b) return missing;
  return a === b ? `on ${a}` : `${a} to ${b}`;
}

/** Who a goal or an enrolment is for: nobody named is the caller; a named one is looked up, else "this employee". */
function personWords(find: NameFinder, employeeId: unknown): string {
  const id = blank(employeeId);
  return id === null ? 'yourself' : (find(id, 'employee') ?? 'this employee');
}

function goalStatusOf(progress: number | null, atRisk: unknown): string | null {
  if (progress === null) return null;
  if (progress === 100) return 'done';
  return atRisk === true ? 'at risk' : 'on track';
}

/** What a goal change will save: the title, the progress, the due date and the status the database will work out. */
function goalSentence(i: Record<string, unknown>): string {
  const progress = typeof i.progress === 'number' && Number.isInteger(i.progress) && i.progress >= 0 && i.progress <= 100 ? i.progress : null;
  const due = blank(i.due_date);
  const dueWords = due === null ? 'no due date' : dateText(due) ? `due ${dateText(due)}` : 'a due date that could not be read';
  const status = goalStatusOf(progress, i.at_risk);
  return [
    `“${text(i.title) ?? ''}”`,
    progress === null ? 'a progress that could not be read' : `${progress}% done`,
    dueWords,
    status,
  ]
    .filter(Boolean)
    .join(', ');
}

function goalFactWords(fact: GoalFact): string {
  const progress = fact.progress;
  const parts = [
    progress === null ? null : `${progress}% done`,
    fact.due_date ? `due ${dateText(fact.due_date)}` : 'no due date',
    fact.status ? GOAL_STATUS_WORDS[fact.status] : null,
  ].filter(Boolean);
  return `the goal “${fact.title}”${fact.employee ? ` of ${fact.employee}` : ''} (${parts.join(', ')})`;
}

function scoresText(scores: Record<string, number> | null): string {
  if (!scores) return 'no scores on record';
  return COMPETENCY_ORDER.filter(([, name]) => name in scores)
    .map(([, name]) => `${name} ${numberWords(scores[name])}`)
    .join(', ');
}

function inputScores(i: Record<string, unknown>): string {
  return COMPETENCY_ORDER.map(([key, name]) => {
    const score = typeof i[key] === 'string' || typeof i[key] === 'number' ? toScore(i[key] as string | number) : null;
    return score === null ? `${name} (could not be read)` : `${name} ${numberWords(score)}`;
  }).join(', ');
}

const ratingWords = (rating: unknown): string =>
  typeof rating === 'string' && Object.hasOwn(RATING_WORDS, rating) ? RATING_WORDS[rating] : 'a rating that could not be read';

const commentWords = (comment: string | null): string => (comment ? `comment “${comment}”` : 'no comment');

/** Everything a review holds that its owner will see, in full, from the conversation. */
function reviewFactWords(fact: ReviewFact): string {
  const overall = fact.score === null ? '' : `, overall ${numberWords(fact.score)}`;
  return `${scoresText(fact.scores)}${overall}, rated ${ratingWords(fact.rating)}, ${commentWords(fact.comment)}`;
}

function courseFactWords(fact: CourseFact): string {
  return `“${fact.title}” (${courseDates(fact.starts_on, fact.ends_on, 'no dates')})`;
}

function announcementFactWords(fact: AnnouncementFact): string {
  return `“${fact.title}”${fact.category ? ` (${fact.category})` : ''}: “${fact.body}”`;
}

/** The question on a card for one of the goal, review, course and announcement tools. */
function performanceTitle(toolName: string, i: Record<string, unknown>, find: NameFinder): string {
  switch (toolName) {
    case 'saveGoal': {
      const who = personWords(find, i.employee_id);
      const goalId = blank(i.goal_id);
      if (goalId === null) return `Add a goal for ${who}: ${goalSentence(i)}?`;
      const { fact } = factOf<GoalFact>(find, goalId, 'goal');
      return `Change ${fact ? `the goal “${fact.title}”` : UNLISTED_GOAL} for ${who} to ${goalSentence(i)}?`;
    }
    case 'removeGoal': {
      const { fact } = factOf<GoalFact>(find, i.goal_id, 'goal');
      return `Remove ${fact ? goalFactWords(fact) : UNLISTED_GOAL}?`;
    }
    case 'saveReview': {
      const who = find(i.employee_id, 'employee') ?? 'this employee';
      const period = typeof i.period === 'string' ? toPeriod(i.period) : null;
      const verb = blank(i.review_id) === null ? 'Save a draft review for' : 'Change the draft review for';
      return `${verb} ${who}, ${period ?? 'a period that could not be read'}: ${inputScores(i)}, rated ${ratingWords(i.rating)}, ${commentWords(blank(i.comment))}?`;
    }
    case 'releaseReview': {
      const { fact } = factOf<ReviewFact>(find, i.review_id, 'review');
      if (!fact) return `Release ${UNLISTED_REVIEW}?`;
      return `Release the review for ${fact.employee ?? 'this employee'}, ${fact.period}: ${reviewFactWords(fact)}?`;
    }
    case 'deleteReview': {
      const { fact } = factOf<ReviewFact>(find, i.review_id, 'review');
      if (!fact) return `Delete ${UNLISTED_REVIEW}?`;
      return `Delete the review for ${fact.employee ?? 'this employee'}, ${fact.period}: ${reviewFactWords(fact)}?`;
    }
    case 'saveTraining': {
      const category = blank(i.category);
      const provider = blank(i.provider);
      const what = [
        courseDates(i.starts_on, i.ends_on),
        category ? `category “${category}”` : 'no category',
        provider ? `provider “${provider}”` : 'no provider',
      ].join(', ');
      const name = `“${text(i.title) ?? ''}” (${what})`;
      const trainingId = blank(i.training_id);
      if (trainingId === null) return `Add the course ${name}?`;
      const { fact } = factOf<CourseFact>(find, trainingId, 'training');
      return `Change ${fact ? `the course “${fact.title}”` : UNLISTED_COURSE} to ${name}?`;
    }
    case 'removeTraining': {
      const { fact } = factOf<CourseFact>(find, i.training_id, 'training');
      return fact ? `Remove the course ${courseFactWords(fact)} and everyone's enrolment in it?` : `Remove ${UNLISTED_COURSE}?`;
    }
    case 'enrolInTraining':
    case 'withdrawFromTraining': {
      const who = personWords(find, i.employee_id);
      const { fact } = factOf<CourseFact>(find, i.training_id, 'training');
      const course = fact ? `the course ${courseFactWords(fact)}` : UNLISTED_COURSE;
      return toolName === 'enrolInTraining' ? `Enrol ${who} in ${course}?` : `Withdraw ${who} from ${course}?`;
    }
    case 'setTrainingCompleted': {
      const who = find(i.employee_id, 'employee') ?? 'this employee';
      const { fact } = factOf<CourseFact>(find, i.training_id, 'training');
      const course = fact ? `the course ${courseFactWords(fact)}` : UNLISTED_COURSE;
      if (i.completed === true) return `Mark ${who} as having completed ${course}?`;
      if (i.completed === false) return `Undo ${who}'s completion of ${course}?`;
      return `Change whether ${who} completed ${course}?`;
    }
    case 'saveAnnouncement': {
      const title = text(i.title) ?? '';
      const category = typeof i.category === 'string' && i.category ? ` (${i.category})` : '';
      const body = typeof i.body === 'string' && i.body.trim() ? `“${i.body}”` : 'no text';
      const shown = `“${title}”${category}: ${body}`;
      const publish = i.publish === true;
      const announcementId = blank(i.announcement_id);
      if (announcementId === null) return publish ? `Publish the new announcement ${shown}?` : `Save the new announcement ${shown} as a draft?`;
      const { fact } = factOf<AnnouncementFact>(find, announcementId, 'announcement');
      const old = fact ? `the announcement “${fact.title}”` : UNLISTED_ANNOUNCEMENT;
      return publish ? `Save changes to ${old} and publish it, as ${shown}?` : `Save changes to ${old}, as ${shown}?`;
    }
    case 'publishAnnouncement':
    case 'unpublishAnnouncement':
    case 'removeAnnouncement': {
      const { fact } = factOf<AnnouncementFact>(find, i.announcement_id, 'announcement');
      const verb = toolName === 'publishAnnouncement' ? 'Publish' : toolName === 'unpublishAnnouncement' ? 'Pull back to a draft' : 'Delete';
      return fact ? `${verb} the announcement ${announcementFactWords(fact)}?` : `${verb} ${UNLISTED_ANNOUNCEMENT}?`;
    }
    default:
      return 'Approve this change?';
  }
}

/** What the conversation suggests will make the database refuse a change. A hedge in the detail, never a change to the question. */
function performanceCaveat(toolName: string, i: Record<string, unknown>, find: NameFinder): string | null {
  const gone = (what: string) => `This ${what} was deleted earlier in this chat, so this is likely to be refused.`;
  switch (toolName) {
    case 'saveGoal':
    case 'removeGoal': {
      const goalId = toolName === 'saveGoal' ? blank(i.goal_id) : i.goal_id;
      return goalId !== null && factOf<GoalFact>(find, goalId, 'goal').removed ? gone('goal') : null;
    }
    case 'saveReview':
    case 'releaseReview':
    case 'deleteReview': {
      const reviewId = toolName === 'saveReview' ? blank(i.review_id) : i.review_id;
      if (reviewId === null) return null;
      const { fact, removed } = factOf<ReviewFact>(find, reviewId, 'review');
      if (removed) return gone('review');
      return fact?.status === 'released' ? 'This review was released when last checked, so this may be refused.' : null;
    }
    case 'saveTraining':
    case 'removeTraining':
    case 'enrolInTraining':
    case 'withdrawFromTraining':
    case 'setTrainingCompleted': {
      const trainingId = toolName === 'saveTraining' ? blank(i.training_id) : i.training_id;
      if (trainingId === null) return null;
      const { fact, removed } = factOf<CourseFact>(find, trainingId, 'training');
      if (removed) return gone('course');
      if (!fact) return null;
      const own = blank(i.employee_id) === null;
      if (toolName === 'enrolInTraining' && own && fact.status === 'completed') {
        return 'This course had ended when last checked, so this may be refused.';
      }
      if (toolName === 'withdrawFromTraining' && own && (fact.status === 'in_progress' || fact.status === 'completed')) {
        return 'This course had already started when last checked, so this may be refused. Ask an owner or admin to remove you.';
      }
      if (toolName === 'setTrainingCompleted' && i.completed === true && fact.status === 'upcoming') {
        return 'This course had not started when last checked, so this may be refused.';
      }
      if (toolName === 'removeTraining' && fact.completed_count !== null && fact.completed_count > 0) {
        return 'Someone was marked as completed on it when last checked, so this may be refused. Undo that first.';
      }
      return null;
    }
    case 'saveAnnouncement':
    case 'publishAnnouncement':
    case 'unpublishAnnouncement':
    case 'removeAnnouncement': {
      const announcementId = toolName === 'saveAnnouncement' ? blank(i.announcement_id) : i.announcement_id;
      if (announcementId === null) return null;
      const { fact, removed } = factOf<AnnouncementFact>(find, announcementId, 'announcement');
      if (removed) return gone('announcement');
      if (toolName === 'publishAnnouncement' && fact?.status === 'published') {
        return 'This announcement was published when last checked, so this may be refused.';
      }
      if (toolName === 'unpublishAnnouncement' && fact?.status === 'draft') {
        return 'This announcement was a draft when last checked, so this may be refused.';
      }
      if (toolName === 'saveAnnouncement' && fact?.status === 'published') {
        return i.publish === true
          ? 'It was already published when last checked, so this saves the changes and it stays published.'
          : 'It was published when last checked, so everyone in the workspace sees the changes.';
      }
      return null;
    }
    default:
      return null;
  }
}

/** The second line of a card for one of these tools: what else the change does, then what the conversation suggests. */
function performanceDetail(toolName: string, i: Record<string, unknown>, find?: NameFinder): string | null {
  let base: string | null = null;
  switch (toolName) {
    case 'removeGoal':
      base = 'This cannot be undone.';
      break;
    case 'saveReview':
    case 'deleteReview': {
      // A claim that it is a draft is dropped when the conversation shows it released: the hedge below says so instead.
      const released = find ? factOf<ReviewFact>(find, toolName === 'saveReview' ? blank(i.review_id) : i.review_id, 'review').fact?.status === 'released' : false;
      const draftWords = released ? null : 'A draft: the employee cannot see it yet.';
      base = toolName === 'saveReview' ? draftWords : [draftWords, 'This cannot be undone.'].filter(Boolean).join(' ');
      break;
    }
    case 'releaseReview':
      base = 'The employee will be able to see it.';
      break;
    case 'removeTraining':
      base = 'Everyone enrolled is removed from it too. This cannot be undone.';
      break;
    case 'setTrainingCompleted':
      base = i.completed === true ? 'A course with someone marked as completed cannot be removed until this is undone.' : null;
      break;
    case 'saveAnnouncement':
      // Saving an existing announcement without publishing leaves it as it is: a draft stays a draft and a published
      // one stays published (and shows the changes), so a flat "A draft" would be wrong for it.
      base =
        i.publish === true
          ? 'Everyone in the workspace will see it.'
          : blank(i.announcement_id) === null
            ? 'A draft: only owners and admins can see it.'
            : 'Saved without publishing: a draft stays a draft, and a published announcement stays published and shows the changes.';
      break;
    case 'publishAnnouncement':
      base = 'Everyone in the workspace will see it.';
      break;
    case 'unpublishAnnouncement':
      base = 'Members will no longer see it.';
      break;
    case 'removeAnnouncement':
      base = 'This cannot be undone. Everyone\'s read marks for it are deleted too.';
      break;
    default:
      break;
  }
  const caveat = find ? performanceCaveat(toolName, i, find) : null;
  return [base, caveat].filter(Boolean).join(' ') || null;
}

const PERFORMANCE_TOOLS = new Set([
  'saveGoal',
  'removeGoal',
  'enrolInTraining',
  'withdrawFromTraining',
  'saveReview',
  'deleteReview',
  'releaseReview',
  'saveTraining',
  'removeTraining',
  'setTrainingCompleted',
  'saveAnnouncement',
  'removeAnnouncement',
  'publishAnnouncement',
  'unpublishAnnouncement',
]);

// ---- Letters and acknowledgement requests ------------------------------------------------------
//
// As for the performance tools: a lookup row and a change's result carry the same fields, `nameIn` (newest result
// first) makes the newest of the two what a later card believes, and a card states exactly what will be saved, in
// full. A letter's whole body is shown every time. Anything the conversation suggests about the row's state is a
// hedged sentence in the detail, never a change to the question.

const UNLISTED_LETTER = 'a letter that was not in the list above';
const UNLISTED_DOCUMENT = 'a document that was not in the list above';
const UNLISTED_TEMPLATE = 'a template that was not in the list above';

type LetterFact = {
  employee: string | null;
  employee_id: string | null;
  letter_type: string | null;
  title: string;
  body: string;
  status: 'draft' | 'issued' | null;
  ack_requested: boolean | null;
};
type DocumentFact = { employee: string | null; employee_id: string | null; title: string; uploaded_by: 'HR' | 'the employee' | null; ack_requested: boolean | null };

/** What the conversation knows about one letter or document, as JSON text, from a lookup row or a change's result. */
function letterDocumentFact(row: Record<string, unknown>, kind: 'letter' | 'document'): string | null {
  const title = text(row.title);
  if (!title) return null;
  const ack = typeof row.ack_requested === 'boolean' ? row.ack_requested : null;
  if (kind === 'letter') {
    // The body is kept exactly as it came: a card shows the whole letter.
    if (typeof row.body !== 'string') return null;
    const fact: LetterFact = {
      employee: text(row.employee),
      employee_id: text(row.employee_id),
      letter_type: typeof row.letter_type === 'string' && Object.hasOwn(LETTER_TYPE_LABEL, row.letter_type) ? row.letter_type : null,
      title,
      body: row.body,
      status: row.status === 'draft' || row.status === 'issued' ? row.status : null,
      ack_requested: ack,
    };
    return JSON.stringify(fact);
  }
  const fact: DocumentFact = {
    employee: text(row.employee),
    employee_id: text(row.employee_id),
    title,
    uploaded_by: row.uploaded_by === 'HR' || row.uploaded_by === 'the employee' ? row.uploaded_by : null,
    ack_requested: ack,
  };
  return JSON.stringify(fact);
}

const letterTypeWords = (type: unknown): string =>
  typeof type === 'string' && Object.hasOwn(LETTER_TYPE_LABEL, type)
    ? LETTER_TYPE_LABEL[type as keyof typeof LETTER_TYPE_LABEL]
    : 'a type that could not be read';

const letterBodyWords = (body: unknown): string => (typeof body === 'string' && body.trim() ? `“${body}”` : 'no text yet');

/** "{a}", "{a} and {b}" or "{a}, {b} and {c}". */
function placeholderList(names: string[]): string {
  const braced = names.map((name) => `{${name}}`);
  return braced.length <= 1 ? braced.join('') : `${braced.slice(0, -1).join(', ')} and ${braced[braced.length - 1]}`;
}

/** The question on a card for one of the letter and acknowledgement tools. */
function letterTitle(toolName: string, i: Record<string, unknown>, find: NameFinder): string {
  switch (toolName) {
    case 'saveLetter': {
      const who = find(i.employee_id, 'employee') ?? 'this employee';
      const letterId = blank(i.letter_id);
      const ask =
        i.ack_requested === true
          ? ', asking them to acknowledge it'
          : letterId === null
            ? ''
            : i.ack_requested === false
              ? ', not asking them to acknowledge it'
              : ', leaving the acknowledgement request as it is';
      const what = `type ${letterTypeWords(i.letter_type)}, titled “${text(i.title) ?? ''}”: ${letterBodyWords(i.body)}${ask}`;
      if (letterId === null) return `Save a draft letter for ${who}, ${what}?`;
      const { fact } = factOf<LetterFact>(find, letterId, 'letter');
      return `Change ${fact ? `the letter “${fact.title}”` : UNLISTED_LETTER} for ${who} to ${what}?`;
    }
    case 'startLetterFromTemplate': {
      const who = find(i.employee_id, 'employee') ?? 'this employee';
      const template = find(i.template_id, 'template');
      return `Start a draft letter for ${who} from ${template ? `the template “${template}”` : UNLISTED_TEMPLATE}?`;
    }
    case 'issueLetter': {
      const { fact } = factOf<LetterFact>(find, i.letter_id, 'letter');
      if (!fact) return `Issue ${UNLISTED_LETTER}? Nothing in this chat shows its text, so it cannot be shown here.`;
      return `Issue the letter to ${fact.employee ?? find(fact.employee_id, 'employee') ?? 'this employee'}, type ${letterTypeWords(fact.letter_type)}, titled “${fact.title}”: ${letterBodyWords(fact.body)}?`;
    }
    case 'requestAcknowledgement': {
      const withdraws = i.requested === false;
      const documentId = blank(i.document_id);
      const letterId = blank(i.letter_id);
      if ((documentId === null) === (letterId === null)) return 'Approve this change?';
      const isLetter = letterId !== null;
      const { fact } = isLetter ? factOf<LetterFact>(find, letterId, 'letter') : factOf<DocumentFact>(find, documentId, 'document');
      if (!fact) {
        const unlisted = isLetter ? UNLISTED_LETTER : UNLISTED_DOCUMENT;
        return withdraws ? `Withdraw the acknowledgement request on ${unlisted}?` : `Ask for an acknowledgement of ${unlisted}?`;
      }
      const who = fact.employee ?? find(fact.employee_id, 'employee') ?? 'this employee';
      const item = `${isLetter ? 'the letter' : 'the document'} “${fact.title}”`;
      return withdraws ? `Withdraw the request for ${who} to acknowledge ${item}?` : `Ask ${who} to acknowledge ${item}?`;
    }
    default:
      return 'Approve this change?';
  }
}

/** The second line of a card for one of these tools: the fixed sentence, then what the conversation suggests. */
function letterDetail(toolName: string, i: Record<string, unknown>, find?: NameFinder): string | null {
  const parts: (string | null)[] = [];
  switch (toolName) {
    case 'saveLetter': {
      const letterId = blank(i.letter_id);
      const fact = find && letterId !== null ? factOf<LetterFact>(find, letterId, 'letter').fact : null;
      if (fact?.status === 'issued') {
        parts.push('This letter was issued when last checked, so this is likely to be refused. It is pulled back to a draft on the Letters screen first.');
      } else {
        parts.push('A draft: the employee cannot see it yet.');
      }
      break;
    }
    case 'startLetterFromTemplate':
      parts.push(
        'A draft: the employee cannot see it yet. The template\'s placeholders are filled in from their record, and any that cannot be filled are left in the text.',
      );
      break;
    case 'issueLetter': {
      parts.push('The employee will be able to see it.');
      const fact = find ? factOf<LetterFact>(find, i.letter_id, 'letter').fact : null;
      if (fact?.ack_requested === true) parts.push('They will be asked to acknowledge it.');
      // Worked out from the title and the body the conversation holds, by the one rule the database mirrors.
      const left = fact ? unfilledInLetter(fact.title, fact.body) : [];
      if (fact && !fact.body.trim()) parts.push('It has no text yet, so this is likely to be refused.');
      if (left.length > 0) parts.push(`It still has ${placeholderList(left)} in it, so this is likely to be refused until they are replaced.`);
      if (fact?.status === 'issued') parts.push('This letter was issued when last checked, so this may be refused.');
      if (fact) parts.push('This is the text as last shown in this chat; the letter is issued as it is saved now.');
      break;
    }
    case 'requestAcknowledgement': {
      const withdraws = i.requested === false;
      const letterId = blank(i.letter_id);
      if (letterId !== null) {
        const fact = find ? factOf<LetterFact>(find, letterId, 'letter').fact : null;
        if (fact?.status === 'issued') {
          parts.push('This letter was issued when last checked, so this will be refused. It is pulled back to a draft on the Letters screen first.');
        } else {
          parts.push(withdraws ? 'A draft: the employee will not be asked when it is issued.' : 'A draft: the employee will be asked when it is issued.');
        }
        break;
      }
      parts.push(
        withdraws
          ? 'Any acknowledgement already recorded is cleared.'
          : 'They can mark it as read on their My Documents page. This records that they have read it; it is not a signature.',
      );
      const fact = find ? factOf<DocumentFact>(find, blank(i.document_id), 'document').fact : null;
      if (fact?.uploaded_by === 'the employee') {
        parts.push('The employee uploaded this document themselves, so this is likely to be refused.');
      }
      break;
    }
    default:
      break;
  }
  return parts.filter(Boolean).join(' ') || null;
}

const LETTER_TOOLS = new Set(['saveLetter', 'startLetterFromTemplate', 'issueLetter', 'requestAcknowledgement']);

const UNLISTED_APPLICATION = 'an application that was not in the list above';
const UNLISTED_CANDIDATE = 'a candidate that was not in the list above';
const UNLISTED_INTERVIEW = 'an interview that was not in the list above';
const UNLISTED_LEAVE = 'a leave request that was not in the list above';
const UNLISTED_TIME_OFF = 'a time-off request that was not in the list above';
const UNLISTED_CLAIM = 'a claim that was not in the list above';
const UNLISTED_OVERTIME = 'an overtime record that was not in the list above';
const UNLISTED_HOLIDAY = 'a public holiday that was not in the list above';

const DAY_NAMES: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const DAY_ORDER = Object.keys(DAY_NAMES);

/** A work week in words ("Mon to Fri", "Mon, Wed"), with a key that is the same however the days were ordered. Null unless every day is a known one. */
function weekWords(value: unknown): { key: string; words: string } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((d) => typeof d === 'string' && DAY_ORDER.includes(d))) return null;
  const days = DAY_ORDER.filter((d) => value.includes(d));
  const first = DAY_ORDER.indexOf(days[0]);
  const run = days.length >= 3 && DAY_ORDER.indexOf(days[days.length - 1]) - first === days.length - 1;
  const words = run ? `${DAY_NAMES[days[0]]} to ${DAY_NAMES[days[days.length - 1]]}` : days.map((d) => DAY_NAMES[d]).join(', ');
  return { key: days.join(','), words };
}

/** "9:00 am" from "09:00" or "09:00:00"; null for anything else. */
export function clockWords(value: unknown): string | null {
  const m = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)/.exec(value) : null;
  if (!m) return null;
  const hour = Number(m[1]);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${m[2]} ${hour < 12 ? 'am' : 'pm'}`;
}

const minutesWord = (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`;

const STATUS_WORDS: Record<string, string> = { present: 'present', late: 'late', absent: 'absent', on_leave: 'on leave' };

/** The settings a save card compares with, from an earlier getAttendanceSettings result; null when it is not in the conversation. */
function settingsBefore(find: NameFinder): { week: string; start: string; grace: number } | null {
  const label = find('attendance-settings', 'settings');
  if (!label) return null;
  try {
    const parsed = JSON.parse(label) as { week?: unknown; start?: unknown; grace?: unknown };
    return typeof parsed.week === 'string' && typeof parsed.start === 'string' && typeof parsed.grace === 'number'
      ? { week: parsed.week, start: parsed.start, grace: parsed.grace }
      : null;
  } catch {
    return null;
  }
}

/** "Change the work start time to 8:30 am, with 10 minutes' grace?": only what differs from the earlier lookup, else all three. */
function settingsTitle(i: Record<string, unknown>, find: NameFinder): string {
  const week = weekWords(i.work_week);
  const start = timeText(i.work_start_time);
  const grace = typeof i.late_grace_minutes === 'number' && Number.isInteger(i.late_grace_minutes) ? i.late_grace_minutes : null;
  const before = settingsBefore(find);
  const weekChanged = week !== null && (!before || before.week !== week.key);
  const startChanged = start !== null && (!before || before.start !== start);
  const graceChanged = grace !== null && (!before || before.grace !== grace);
  const parts: string[] = [];
  if (startChanged) {
    const graceWords = graceChanged ? `, with ${grace === 1 ? "1 minute's" : `${grace} minutes'`} grace` : '';
    parts.push(`the work start time to ${clockWords(start)}${graceWords}`);
  } else if (graceChanged && grace !== null) {
    parts.push(`the grace period to ${minutesWord(grace)}`);
  }
  if (weekChanged && week) parts.push(`the work week to ${week.words}`);
  // Never "keep as they are": what is asked equals what the conversation last saw, but the screen may have moved since.
  return parts.length > 0 ? `Change ${parts.join(' and ')}?` : 'Save the attendance settings?';
}

/** All three values that will be saved, whatever the title shows, so a card can never hide one. */
function settingsDetail(i: Record<string, unknown>): string {
  const week = weekWords(i.work_week);
  const start = clockWords(i.work_start_time);
  const grace = typeof i.late_grace_minutes === 'number' && Number.isInteger(i.late_grace_minutes) ? minutesWord(i.late_grace_minutes) : null;
  const values = [
    week && `Work week: ${week.words}`,
    start && `Start time: ${start}`,
    grace && `Grace period: ${grace}`,
  ].filter(Boolean);
  return [...values, 'Applies from the next clock-in.'].join(' · ');
}

/** "Fri, 9 Oct 2026"; null unless a real date. */
function longDay(value: unknown): string | null {
  if (typeof value !== 'string' || !isRealDate(value)) return null;
  return `${weekdayName(value).slice(0, 3)}, ${Number(value.slice(8, 10))} ${monthLabel(value)} ${value.slice(0, 4)}`;
}

/** How a claim's category reads inside a sentence: "RM 85.00 travel claim". */
const CLAIM_WORDS: Record<string, string> = {
  medical: 'medical',
  travel: 'travel',
  meals: 'meals',
  equipment: 'equipment',
  other: 'other',
};
/** "for travel", "for other expenses". */
const claimFor = (category: unknown): string | null => {
  if (typeof category !== 'string' || !Object.hasOwn(CLAIM_WORDS, category)) return null;
  return category === 'other' ? 'other expenses' : CLAIM_WORDS[category];
};

/** "3 hours", "1 hour", "0.5 hours", as given; null unless a positive number. */
function hoursText(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return `${value} ${value === 1 ? 'hour' : 'hours'}`;
}

/** Sen as "RM 85.00", from whole sen, without arithmetic on the figure; null for anything but a positive whole number. */
function senText(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  const digits = String(value).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+$)/g, ',');
  return `RM ${whole}.${digits.slice(-2)}`;
}

/**
 * Who a request is for. No employee in the input is the caller's own, and the card says so ("yourself"), so a
 * request meant for someone else that lost its employee on the way is noticed before it is approved. One that
 * no lookup named must never read like the caller's own, so it says "this employee".
 */
function forWhom(employeeId: unknown, find: NameFinder): string {
  if (employeeId === undefined || employeeId === null) return 'yourself';
  return find(employeeId, 'employee') ?? 'this employee';
}

const LEAVE_WORDS: Record<string, string> = {
  annual: 'annual leave',
  medical: 'medical leave',
  emergency: 'emergency leave',
  unpaid: 'unpaid leave',
  maternity: 'maternity leave',
  paternity: 'paternity leave',
};
const leaveWord = (type: unknown): string => (typeof type === 'string' ? LEAVE_WORDS[type] : undefined) ?? 'leave';

/** "HH:MM" from "HH:MM" or "HH:MM:SS"; null for anything else. */
const timeText = (value: unknown): string | null => {
  const m = typeof value === 'string' ? /^([01]\d|2[0-3]):[0-5]\d/.exec(value) : null;
  return m ? m[0] : null;
};

/** "16 Oct", "20–22 Oct", "30 Oct–2 Nov"; the year only when the range spans two. Null unless both are real dates. */
function dayRangeText(from: unknown, to: unknown): string | null {
  const part = (value: unknown) => {
    const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
    return m && month ? { year: m[1], month, day: Number(m[3]) } : null;
  };
  const a = part(from);
  const b = part(to);
  if (!a || !b) return null;
  if (from === to) return `${a.day} ${a.month}`;
  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year}–${b.day} ${b.month} ${b.year}`;
  if (a.month === b.month) return `${a.day}–${b.day} ${a.month}`;
  return `${a.day} ${a.month}–${b.day} ${b.month}`;
}

/**
 * The question on an approval card. `named` is either the name of the item
 * the change is about, or a way to look names up by id; without it the card
 * falls back to "this campaign".
 */
function intervalLabel(secs: number): string {
  const units: [number, string][] = [[604_800, 'week'], [86_400, 'day'], [3_600, 'hour'], [60, 'minute']];
  for (const [size, name] of units) {
    if (secs % size === 0) {
      const n = secs / size;
      return n === 1 ? name : `${n} ${name}s`;
    }
  }
  return `${secs} seconds`;
}

export function approvalTitle(
  toolName: string,
  input: unknown,
  named?: string | null | NameFinder,
): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const find = typeof named === 'function' ? named : () => null;
  // "campaign “X”" when the item's name is known, else "this campaign".
  const the = (label: string, kind: ItemKind) => {
    const subject = typeof named === 'function' ? named(i.id, kind) : named;
    return subject ? `${label} “${subject}”` : `this ${label}`;
  };
  // "Aina Rahman (Barista)" when a listing in the conversation showed this application, else "an application that was not in the list above".
  const who = () => find(i.id, 'application') ?? UNLISTED_APPLICATION;
  const person = [i.firstName, i.lastName].filter((v) => typeof v === 'string' && v).join(' ');
  switch (toolName) {
    case 'createCampaign': return `Create campaign “${i.name ?? ''}”?`;
    case 'updateCampaign': return `Save changes to ${the('campaign', 'campaign')}?`;
    case 'setCampaignStatus':
      return i.status === 'paused' ? `Pause ${the('campaign', 'campaign')}?` : `Resume ${the('campaign', 'campaign')}?`;
    case 'deleteCampaign': return `Delete ${the('campaign', 'campaign')}?`;
    case 'createCreative': return `Add creative “${i.name ?? ''}”?`;
    case 'updateCreative': return `Save changes to ${the('creative', 'creative')}?`;
    case 'deleteCreative': return `Delete ${the('creative', 'creative')}?`;
    case 'updateAdSettings': return 'Update ad settings?';
    case 'createForm': return `Create lead form “${i.name ?? ''}”?`;
    case 'updateForm': return `Save changes to ${the('lead form', 'form')}?`;
    case 'setFormStatus':
      return i.status === 'active'
        ? `Activate ${the('lead form', 'form')}?`
        : i.status === 'paused'
          ? `Pause ${the('lead form', 'form')}?`
          : `Move ${the('lead form', 'form')} back to draft?`;
    case 'deleteForm': return `Delete ${the('lead form', 'form')}?`;
    case 'createContact': return `Add contact “${person}”?`;
    case 'updateContact': return `Save changes to ${the('contact', 'contact')}?`;
    case 'deleteContact': return `Delete ${the('contact', 'contact')}?`;
    case 'createDeal': {
      const who = find(i.contactId, 'contact');
      return who ? `Add deal “${i.title ?? ''}” for ${who}?` : `Add deal “${i.title ?? ''}”?`;
    }
    case 'updateDeal': return `Save changes to ${the('deal', 'deal')}?`;
    case 'moveDeal': {
      const stage = find(i.stageId, 'stage');
      return stage ? `Move ${the('deal', 'deal')} to ${stage}?` : `Move ${the('deal', 'deal')} to another stage?`;
    }
    case 'markDealLost': return `Mark ${the('deal', 'deal')} as lost?`;
    case 'reopenDeal': return `Reopen ${the('deal', 'deal')}?`;
    case 'deleteDeal': return `Delete ${the('deal', 'deal')}?`;
    case 'createFollowUp': {
      const who = find(i.contactId, 'contact');
      return who ? `Add follow-up “${i.title ?? ''}” for ${who}?` : `Add follow-up “${i.title ?? ''}”?`;
    }
    case 'completeFollowUp': return `Mark ${the('follow-up', 'follow-up')} as done?`;
    case 'createLead': return `Create lead “${i.name ?? ''}”?`;
    case 'updateLead': return `Save changes to ${the('lead', 'lead')}?`;
    case 'setLeadStage': return `Move ${the('lead', 'lead')} to “${i.stage ?? ''}”?`;
    case 'deleteLead': return `Delete ${the('lead', 'lead')}?`;
    case 'promoteLeadToContact': return `Promote ${the('lead', 'lead')} to a CRM contact?`;
    case 'createAppointment': return `Book appointment with “${i.contact_name ?? ''}”?`;
    case 'updateAppointment': return 'Save changes to this appointment?';
    case 'setAppointmentStatus': {
      const label = APPOINTMENT_STATUS_LABELS[String(i.status)] ?? String(i.status ?? '');
      return `Mark this appointment as ${label}?`;
    }
    case 'deleteAppointment': return 'Delete this appointment?';
    case 'scheduleWeeklyStudio': {
      const secs = Number(i.interval_seconds);
      const every = !Number.isFinite(secs) || secs <= 0 ? '' : ` every ${intervalLabel(secs)}`;
      const runs = typeof i.max_runs === 'number' ? `, ${i.max_runs} ${i.max_runs === 1 ? 'run' : 'runs'} at most` : '';
      return `Schedule Weekly Studio${every}${runs}?`;
    }
    case 'createJob': return `Create job “${i.title ?? ''}” as a draft?`;
    case 'updateJob': return `Save changes to ${the('job', 'job')}?`;
    case 'setJobStatus':
      return i.status === 'open'
        ? `Open ${the('job', 'job')}?`
        : i.status === 'paused'
          ? `Pause ${the('job', 'job')}?`
          : `Close ${the('job', 'job')}?`;
    case 'deleteJob': return `Delete ${the('job', 'job')}?`;
    case 'moveApplication': {
      const stage = typeof i.stage === 'string' && Object.hasOwn(STAGE_LABEL, i.stage) ? STAGE_LABEL[i.stage as keyof typeof STAGE_LABEL] : null;
      return stage ? `Move ${who()} to ${stage}?` : `Move ${who()} to another stage?`;
    }
    case 'rejectApplication':
      return i.outcome === 'withdrawn' ? `Mark ${who()} as withdrawn?` : `Reject ${who()}?`;
    case 'reopenApplication': return `Reopen ${who()}?`;
    case 'rateApplication':
      return typeof i.rating === 'number' && Number.isInteger(i.rating)
        ? `Rate ${who()} ${i.rating} out of 5?`
        : `Clear the rating of ${who()}?`;
    case 'addCandidate': return `Add candidate “${text(i.name) ?? ''}”?`;
    case 'updateCandidate': {
      const name = find(i.id, 'candidate');
      return `Save changes to ${name ? `candidate “${name}”` : UNLISTED_CANDIDATE}?`;
    }
    case 'deleteApplication': {
      const which = find(i.id, 'application');
      return which ? `Delete the application of ${which}?` : `Delete ${UNLISTED_APPLICATION}?`;
    }
    case 'deleteCandidate': {
      const name = find(i.id, 'candidate');
      return `Delete ${name ? `candidate “${name}”` : UNLISTED_CANDIDATE}?`;
    }
    case 'setPoolStatus': {
      const name = find(i.id, 'candidate');
      return poolCardTitle(name ? `candidate “${name}”` : UNLISTED_CANDIDATE, i.status, i.only_if_outside);
    }
    case 'moveToPipeline': {
      const name = find(i.id, 'candidate');
      return pipelineCardTitle(name ? `candidate “${name}”` : UNLISTED_CANDIDATE, find(i.job_id, 'job'));
    }
    case 'scheduleInterview':
    case 'recordPastInterview':
      // There is no interview yet: the card names the application, from a listApplications row.
      return interviewCardTitle(toolName, i, find(i.application_id, 'application') ?? UNLISTED_APPLICATION) ?? 'Approve this change?';
    case 'rescheduleInterview':
    case 'cancelInterview':
    case 'setInterviewOutcome':
    case 'reopenInterview':
      return interviewCardTitle(toolName, i, find(i.id, 'interview') ?? UNLISTED_INTERVIEW) ?? 'Approve this change?';
    case 'saveInterviewFeedback':
    case 'clearInterviewFeedback':
      return feedbackCardTitle(toolName, find(i.id, 'interview')) ?? 'Approve this change?';
    case 'createEmployee': return `Add employee “${i.name ?? ''}”?`;
    case 'updateEmployee': return `Save changes to ${the('employee', 'employee')}?`;
    case 'setEmployeeStatus':
      return i.status === 'inactive'
        ? `Deactivate ${the('employee', 'employee')}?`
        : `Reactivate ${the('employee', 'employee')}?`;
    case 'deleteEmployee': return `Delete ${the('employee', 'employee')}?`;
    case 'linkEmployeeToMember':
      // Unlink only on an explicit null; a blank or missing email is not a request to unlink.
      if (i.memberEmail === null) return `Unlink ${the('employee', 'employee')} from their account?`;
      return typeof i.memberEmail === 'string' && i.memberEmail.trim()
        ? `Link ${the('employee', 'employee')} to the account ${i.memberEmail.trim()}?`
        : 'Approve this change?';
    case 'createDepartment': return `Add department “${i.name ?? ''}”?`;
    case 'updateDepartment': return `Rename ${the('department', 'department')} to “${i.name ?? ''}”?`;
    case 'deleteDepartment': return `Delete ${the('department', 'department')}?`;
    case 'applyLeave': {
      const who = forWhom(i.employee_id, find);
      const when = dayRangeText(i.start_date, i.end_date);
      const half = i.half_day === true ? ' (half day)' : '';
      return `Apply for ${leaveWord(i.leave_type)} for ${who}${when ? `, ${when}${half}` : ''}?`;
    }
    case 'applyTimeOff': {
      const who = forWhom(i.employee_id, find);
      const when = dayRangeText(i.off_date, i.off_date);
      const from = timeText(i.start_time);
      const to = timeText(i.end_time);
      return `Request time-off for ${who}${when ? `, ${when}` : ''}${from && to ? `, ${from}–${to}` : ''}?`;
    }
    case 'cancelLeaveRequest': {
      const what = find(i.id, 'leave');
      return what ? `Cancel ${what}?` : `Cancel ${UNLISTED_LEAVE}?`;
    }
    case 'cancelTimeOffRequest': {
      const what = find(i.id, 'time-off');
      return what ? `Cancel ${what}?` : `Cancel ${UNLISTED_TIME_OFF}?`;
    }
    case 'decideLeave': {
      const what = find(i.id, 'leave');
      return `${i.approve === true ? 'Approve' : 'Reject'} ${what ?? UNLISTED_LEAVE}?`;
    }
    case 'decideTimeOff': {
      const what = find(i.id, 'time-off');
      return `${i.approve === true ? 'Approve' : 'Reject'} ${what ?? UNLISTED_TIME_OFF}?`;
    }
    case 'submitClaim': {
      const who = forWhom(i.employee_id, find);
      const amount = senText(i.amount_cents);
      const category = claimFor(i.category);
      const when = dayRangeText(i.claim_date, i.claim_date);
      const parts = [`Claim${amount ? ` ${amount}` : ''}${category ? ` for ${category}` : ''}`, when].filter(Boolean);
      return `${parts.join(', ')}, for ${who}?`;
    }
    case 'cancelClaim': return `Cancel ${find(i.id, 'claim') ?? UNLISTED_CLAIM}?`;
    case 'decideClaim': return `${i.approve === true ? 'Approve' : 'Reject'} ${find(i.id, 'claim') ?? UNLISTED_CLAIM}?`;
    case 'markClaimPaid': return `Mark ${find(i.id, 'claim') ?? UNLISTED_CLAIM} as paid?`;
    case 'unmarkClaimPaid': return `Undo the paid mark on ${find(i.id, 'claim') ?? UNLISTED_CLAIM}?`;
    case 'submitOvertime': {
      const who = forWhom(i.employee_id, find);
      const hours = hoursText(i.hours);
      const when = dayRangeText(i.work_date, i.work_date);
      return `Claim ${hours ? `${hours} of overtime` : 'overtime'}${when ? ` on ${when}` : ''} for ${who}?`;
    }
    case 'cancelOvertime': return `Cancel ${find(i.id, 'overtime') ?? UNLISTED_OVERTIME}?`;
    case 'decideOvertime': return `${i.approve === true ? 'Approve' : 'Reject'} ${find(i.id, 'overtime') ?? UNLISTED_OVERTIME}?`;
    case 'clockIn': return 'Clock in now?';
    case 'clockOut': return 'Clock out now?';
    case 'correctAttendance': {
      const who = find(i.employee_id, 'employee');
      const when = longDay(i.work_date);
      const status = typeof i.status === 'string' ? STATUS_WORDS[i.status] : undefined;
      // Times belong to a worked day only: an absence or a day of leave takes none.
      const worked = i.status === 'present' || i.status === 'late';
      const from = worked ? clockWords(hhmm(i.clock_in)) : null;
      const to = worked ? clockWords(hhmm(i.clock_out)) : null;
      const times = from && to ? `, ${from} to ${to}` : from ? `, from ${from}` : '';
      return `Correct ${who ? `${who}'s` : "this employee's"} attendance${when ? ` on ${when}` : ''} to ${status ?? 'a new status'}${times}?`;
    }
    case 'saveHoliday': {
      const name = text(i.name) ?? '';
      const when = dateText(i.holiday_date);
      const what = `${name}${when ? `, ${when}` : ''}`;
      // An empty or blank id is an add, exactly as the tool reads it.
      const id = blank(i.id);
      if (id === null) return `Add public holiday: ${what}?`;
      const old = find(id, 'holiday');
      return `Change ${old ? `public holiday ${old}` : UNLISTED_HOLIDAY} to ${what}?`;
    }
    case 'removeHoliday': {
      const old = find(i.id, 'holiday');
      return `Remove ${old ? `public holiday: ${old}` : UNLISTED_HOLIDAY}?`;
    }
    case 'saveAttendanceSettings': return settingsTitle(i, find);
    case 'saveGoal':
    case 'removeGoal':
    case 'enrolInTraining':
    case 'withdrawFromTraining':
    case 'saveReview':
    case 'deleteReview':
    case 'releaseReview':
    case 'saveTraining':
    case 'removeTraining':
    case 'setTrainingCompleted':
    case 'saveAnnouncement':
    case 'removeAnnouncement':
    case 'publishAnnouncement':
    case 'unpublishAnnouncement':
      return performanceTitle(toolName, i, find);
    case 'saveLetter':
    case 'startLetterFromTemplate':
    case 'issueLetter':
    case 'requestAcknowledgement':
      return letterTitle(toolName, i, find);
    case 'runPayroll':
    case 'recalculatePayroll':
    case 'savePayslipLine':
    case 'removePayslipLine':
    case 'setPayslipStatutory':
    case 'removePayslip':
      return payrollTitle(toolName, i, find);
    case 'setLeaveEntitlement': {
      const who = find(i.employee_id, 'employee');
      const days =
        typeof i.days === 'number' && Number.isFinite(i.days) ? `${i.days} ${i.days === 1 ? 'day' : 'days'}` : 'a new number of days';
      const year = typeof i.year === 'number' ? ` for ${i.year}` : '';
      return `Set ${who ? `${who}'s` : "this employee's"} ${leaveWord(i.leave_type)}${year} to ${days}?`;
    }
    case 'updateCareersPage':
      return i.careers_enabled === true
        ? 'Turn on the public careers page?'
        : i.careers_enabled === false
          ? 'Turn off the public careers page?'
          : 'Save changes to the careers page?';
    case 'updateApplicationForm': {
      const changes = describeFormChange(i);
      return changes.length === 1 ? `${changes[0]} on applications?` : 'Change what the application form asks for?';
    }
    // Finance (Bendahara)
    case 'saveInvoice': return i.id ? `Save changes to ${the('invoice', 'invoice')}?` : 'Create a draft invoice?';
    case 'postInvoice': return `Post ${the('invoice', 'invoice')}?`;
    case 'voidInvoice': return `Void ${the('invoice', 'invoice')}?`;
    case 'deleteInvoice': return `Delete ${the('invoice', 'invoice')}?`;
    case 'setEInvoice': return `Record the e-Invois status on ${the('invoice', 'invoice')}?`;
    case 'saveQuotation': return i.id ? `Save changes to ${the('quotation', 'quotation')}?` : 'Create a draft quotation?';
    case 'sendQuotation': return `Mark ${the('quotation', 'quotation')} as sent?`;
    case 'acceptQuotation': return `Mark ${the('quotation', 'quotation')} as accepted?`;
    case 'declineQuotation': return `Mark ${the('quotation', 'quotation')} as declined?`;
    case 'convertQuotation': return `Convert ${the('quotation', 'quotation')} into a draft invoice?`;
    case 'deleteQuotation': return `Delete ${the('quotation', 'quotation')}?`;
    case 'saveBill': return i.id ? `Save changes to ${the('supplier bill', 'bill')}?` : 'Create a draft supplier bill?';
    case 'postBill': return `Post ${the('supplier bill', 'bill')}?`;
    case 'voidBill': return `Void ${the('supplier bill', 'bill')}?`;
    case 'deleteBill': return `Delete ${the('supplier bill', 'bill')}?`;
    case 'saveCreditNote': return i.id ? `Save changes to ${the('credit note', 'credit-note')}?` : 'Create a draft credit note?';
    case 'issueCreditNote': return `Issue ${the('credit note', 'credit-note')}?`;
    case 'voidCreditNote': return `Void ${the('credit note', 'credit-note')}?`;
    case 'deleteCreditNote': return `Delete ${the('credit note', 'credit-note')}?`;
    case 'recordRefund': return 'Record a refund to a customer?';
    case 'markRefundPaid': return 'Mark this refund as paid?';
    case 'voidRefund': return 'Void this refund?';
    case 'deleteRefund': return 'Delete this refund?';
    case 'recordPaymentIn': return 'Record a payment received from a customer?';
    case 'recordPaymentOut': return 'Record a payment made to a supplier?';
    case 'markPaymentPaid': return 'Mark this payment as paid?';
    case 'voidPayment':
    case 'voidPaymentIn': return 'Void this payment?';
    case 'deleteScheduledPayment': return 'Delete this scheduled payment?';
    case 'createFinanceContact': return `Add finance contact “${text(i.name) ?? ''}”?`;
    case 'updateFinanceContact': return `Save changes to ${the('finance contact', 'finance-contact')}?`;
    case 'setFinanceContactActive':
      return i.active === false
        ? `Deactivate ${the('finance contact', 'finance-contact')}?`
        : `Reactivate ${the('finance contact', 'finance-contact')}?`;
    case 'deleteFinanceContact': return `Delete ${the('finance contact', 'finance-contact')}?`;
    case 'createFinanceItem': return `Add item “${text(i.name) ?? ''}”?`;
    case 'updateFinanceItem': return `Save changes to ${the('item', 'item')}?`;
    case 'setFinanceItemActive':
      return i.active === false ? `Deactivate ${the('item', 'item')}?` : `Reactivate ${the('item', 'item')}?`;
    case 'deleteFinanceItem': return `Delete ${the('item', 'item')}?`;
    default: return 'Approve this change?';
  }
}

const JOB_FIELD_WORDS: [string[], string][] = [
  [['title'], 'title'],
  [['department'], 'department'],
  [['location'], 'location'],
  [['employment_type'], 'employment type'],
  [['work_arrangement'], 'work arrangement'],
  [['description'], 'description'],
  [['salary_min_cents', 'salary_max_cents'], 'salary'],
  [['show_salary'], 'salary visibility'],
  [['closes_on'], 'closing date'],
  [['headcount'], 'headcount'],
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An amount in sen, or null when the input holds anything else there. */
const sen = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Sen as ringgit: "RM 3,000", with the sen shown only when there are some ("RM 4,500.50"). */
function ringgit(amount: number): string {
  const whole = String(Math.floor(amount / 100)).replace(/\B(?=(\d{3})+$)/g, ',');
  const rest = amount % 100;
  return `RM ${whole}${rest === 0 ? '' : `.${String(rest).padStart(2, '0')}`}`;
}

/** The monthly salary a change asks for, or null when it gives no amount. */
function salaryText(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) return `${ringgit(min)} – ${ringgit(max)} a month`;
  if (min !== null) return `from ${ringgit(min)} a month`;
  if (max !== null) return `up to ${ringgit(max)} a month`;
  return null;
}

/** "2026-10-31" as "31 Oct 2026", without going through a locale; null for anything else. */
function dateText(value: unknown): string | null {
  const parts = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const month = parts ? MONTHS[Number(parts[2]) - 1] : undefined;
  return parts && month ? `${Number(parts[3])} ${month} ${parts[1]}` : null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Ringgit with sen always shown: "RM 4,500.00". */
function ringgitFixed(amount: number): string {
  const [whole, sen] = amount.toFixed(2).split('.');
  return `RM ${whole.replace(/\B(?=(\d{3})+$)/g, ',')}.${sen}`;
}

type EmployeeField = { key: string; word: string; show?: (value: unknown) => string | null };

const shownText = (value: unknown) => text(value);
const shownSalary = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? ringgitFixed(value) : null;

const EMPLOYEE_FIELDS: EmployeeField[] = [
  { key: 'name', word: 'name' },
  { key: 'employee_no', word: 'employee number' },
  { key: 'work_email', word: 'work email', show: shownText },
  { key: 'department_id', word: 'department' },
  { key: 'designation', word: 'designation' },
  { key: 'employment_type', word: 'employment type' },
  { key: 'is_manager', word: 'manager flag' },
  { key: 'join_date', word: 'join date' },
  { key: 'status', word: 'status', show: shownText },
];

// Pay and identity details live under `private`. Only the salary's value is shown; the rest are named.
const PRIVATE_EMPLOYEE_FIELDS: EmployeeField[] = [
  { key: 'base_salary', word: 'monthly salary', show: shownSalary },
  { key: 'nric', word: 'NRIC' },
  { key: 'date_of_birth', word: 'date of birth' },
  { key: 'phone', word: 'phone' },
  { key: 'address', word: 'address' },
  { key: 'bank_name', word: 'bank name' },
  { key: 'bank_account', word: 'bank account' },
  { key: 'epf_no', word: 'EPF number' },
  { key: 'socso_no', word: 'SOCSO number' },
  { key: 'tax_no', word: 'tax number' },
  { key: 'emergency_contact_name', word: 'emergency contact name' },
  { key: 'emergency_contact_phone', word: 'emergency contact phone' },
];

/** The fields an employee change sends, in plain words; a null or blank value reads "cleared". */
function employeeFieldWords(i: Record<string, unknown>, includeName: boolean): string[] {
  const priv = (i.private && typeof i.private === 'object' ? i.private : {}) as Record<string, unknown>;
  const words: string[] = [];
  const add = (fields: EmployeeField[], source: Record<string, unknown>) => {
    for (const { key, word, show } of fields) {
      if (key === 'name' && !includeName) continue;
      const value = source[key];
      if (value === undefined) continue;
      if (value === null || (typeof value === 'string' && value.trim() === '')) {
        words.push(`${word} (cleared)`);
        continue;
      }
      const shown = show?.(value);
      words.push(shown ? `${word} (${shown})` : word);
    }
  };
  add(EMPLOYEE_FIELDS, i);
  add(PRIVATE_EMPLOYEE_FIELDS, priv);
  return words;
}

/** Skills as they read on a card: "Latte art, POS"; null for anything that is not a non-empty list of words. */
function skillsText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const skills = value.map(text).filter((skill): skill is string => skill !== null);
  return skills.length > 0 ? skills.join(', ') : null;
}

// What a candidate change sends, in plain words. An email is shown; a phone number is only named, like the
// employee cards' private details. The job is looked up by its id, so it is handled where the words are made.
const CANDIDATE_FIELDS: EmployeeField[] = [
  { key: 'name', word: 'name' },
  { key: 'email', word: 'email', show: shownText },
  { key: 'phone', word: 'phone' },
  { key: 'headline', word: 'headline' },
  { key: 'location', word: 'location' },
  { key: 'skills', word: 'skills', show: skillsText },
  { key: 'source', word: 'source' },
  { key: 'cover_letter', word: 'cover note' },
  { key: 'cv_url', word: 'CV link' },
];

/** The fields a candidate change sends, in plain words; a null, blank or empty value reads "cleared". */
function candidateFieldWords(i: Record<string, unknown>, includeName: boolean, find?: NameFinder): string[] {
  const words: string[] = [];
  if (typeof i.job_id === 'string' && i.job_id) {
    const job = find?.(i.job_id, 'job');
    words.push(job ? `job (${job})` : 'job');
  }
  for (const { key, word, show } of CANDIDATE_FIELDS) {
    if (key === 'name' && !includeName) continue;
    const value = i[key];
    if (value === undefined) continue;
    if (value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0)) {
      words.push(`${word} (cleared)`);
      continue;
    }
    const shown = show?.(value);
    words.push(shown ? `${word} (${shown})` : word);
  }
  return words;
}

/**
 * The second line of an approval card. For a job it shows the values the
 * user is approving that the question itself does not: the salary and the
 * closing date above all.
 */
/** How much of an interview's notes its card shows (the same number as in lib/hire/interviews.ts). */
const NOTES_ON_CARD = 300;
/**
 * An interview card's second line, saying how much of the notes it does not show. The card shows the first 300
 * characters of the notes a change would save, and up to 1,700 more would be saved unseen: the line then reads
 * "Notes: <first 300>… (and 1,700 more characters)". Counted as the card reads the notes: on one line.
 * (This belongs with the notes' own wording in lib/hire/interviews.ts; it stands here because that file was being
 * changed by someone else when it was written.)
 */
function withNotesLeft(detail: string, notes: unknown): string {
  const text = typeof notes === 'string' ? notes.replace(/\s+/g, ' ').trim() : '';
  const left = text.length - NOTES_ON_CARD;
  if (left <= 0) return detail;
  // The notes are the last part before the closing sentence, so the last "Notes: <first 300>…" is the card's own.
  const shown = `Notes: ${text.slice(0, NOTES_ON_CARD)}…`;
  const at = detail.lastIndexOf(shown);
  if (at < 0) return detail;
  const more = `${shown} (and ${left.toLocaleString('en-US')} more ${left === 1 ? 'character' : 'characters'})`;
  return `${detail.slice(0, at)}${more}${detail.slice(at + shown.length)}`;
}

export function approvalDetail(
  toolName: string,
  input?: unknown,
  receipt?: ReceiptState,
  /** Looks up a name by id (a job's title on an add-candidate card); without it a job is named but not titled. */
  named?: NameFinder,
): string | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'deleteEmployee') {
    return 'Their leave, claims, draft payslips and every other HR record are deleted too, including their documents, the files attached to them and their letters. This cannot be undone. Someone with a paid payslip cannot be deleted: make them inactive instead.';
  }
  if (toolName === 'updateEmployee') {
    const words = employeeFieldWords(i, true);
    return words.length > 0 ? `Changes: ${words.join(', ')}` : null;
  }
  if (toolName === 'createEmployee') {
    // A new employee has nothing to clear: a null or blank field simply sets nothing.
    const words = employeeFieldWords(i, false).filter((w) => !w.endsWith('(cleared)'));
    return words.length > 0 ? `Sets: ${words.join(', ')}` : null;
  }
  if (toolName === 'addCandidate') {
    // A new person has nothing to clear: a null or blank field simply sets nothing.
    const words = candidateFieldWords(i, false, named).filter((w) => !w.endsWith('(cleared)'));
    return words.length > 0 ? `Sets: ${words.join(', ')}` : null;
  }
  if (toolName === 'updateCandidate') {
    const words = candidateFieldWords(i, true);
    return words.length > 0 ? `Changes: ${words.join(', ')}` : null;
  }
  // Fixed sentences, no counts: a number here would be the model's, not the database's. The result carries the real ones.
  if (toolName === 'deleteApplication') {
    return 'Its interviews and its CV file are deleted too. The candidate stays on file. This cannot be undone.';
  }
  if (toolName === 'deleteCandidate') {
    return 'Every application, interview and CV file of theirs is deleted too. This cannot be undone.';
  }
  // Fixed sentences. Which of two same-named people it is, is said on a line of its own, read on the server (hire-pool-gate.ts).
  if (toolName === 'setPoolStatus') return poolCardDetail(i.status);
  if (toolName === 'moveToPipeline') return PIPELINE_CARD_DETAIL;
  // A feedback change's second line is worded by the hiring code too: everything that will be saved (the comments
  // cut at 600 characters, with how many more there are) and what the save will not do. Null for every other tool.
  const feedbackDetail = feedbackCardDetail(toolName, i);
  if (feedbackDetail !== null) return feedbackDetail;
  // An interview change's second line is worded by the hiring code from the change's own input (it answers null for
  // every other tool, and for the two interview changes that have no second line). Which interview it is, is said on
  // a line of its own, read on the server (hire-interview-gate.ts).
  const interviewDetail = interviewCardDetail(toolName, i);
  if (interviewDetail !== null) return withNotesLeft(interviewDetail, i.notes);
  if (toolName === 'submitClaim') {
    // What will be saved under the person's name. The receipt line comes from the conversation (the file on the
    // question that led to the claim), never from anything the assistant put in the input; unknown, it says nothing.
    const why = text(i.description);
    const line =
      receipt?.state === 'attached'
        ? 'Sent with the attached receipt'
        : receipt?.state === 'none'
          ? 'Sent with no receipt'
          : receipt?.state === 'unusable'
            ? `The attached file cannot be used as a receipt (${receipt.problem}): sent with no receipt`
            : null;
    const parts = [line, why && `Description: “${why}”`].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (toolName === 'submitOvertime') {
    const why = text(i.reason);
    return why ? `Reason: “${why}”` : null;
  }
  if (toolName === 'markClaimPaid') {
    const paid = dateText(i.paid_on);
    const reference = text(i.reference);
    const parts = [paid && `Paid on ${paid}`, reference && `Reference: “${reference}”`].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (toolName === 'decideLeave' || toolName === 'decideTimeOff' || toolName === 'decideClaim' || toolName === 'decideOvertime') {
    // The note is only ever said on a rejection; an approval carries none. It is quoted and labelled:
    // it is written by the model and will be saved as the decision note.
    const note = i.approve === false ? text(i.note) : null;
    return note ? `Note: “${note}”` : null;
  }
  if (toolName === 'correctAttendance') {
    // The note is saved on the day under the person's name: quoted and labelled, it is what was typed.
    const note = text(i.note);
    return note ? `Note: “${note}”` : null;
  }
  if (toolName === 'saveAttendanceSettings') return settingsDetail(i);
  if (toolName === 'recalculatePayroll' || ['savePayslipLine', 'removePayslipLine', 'setPayslipStatutory', 'removePayslip'].includes(toolName)) {
    const caveat = named ? payrollCaveat(toolName, i, named) : null;
    return [payrollDetail(toolName, i), caveat].filter(Boolean).join(' ') || null;
  }
  if (PERFORMANCE_TOOLS.has(toolName)) return performanceDetail(toolName, i, named);
  if (LETTER_TOOLS.has(toolName)) return letterDetail(toolName, i, named);
  if (toolName === 'removeHoliday' || (toolName === 'saveHoliday' && blank(i.id) !== null)) {
    return 'Leave and overtime already recorded are not changed.';
  }
  if (toolName === 'applyLeave' || toolName === 'applyTimeOff') {
    // What will be saved under the person's name.
    const why = text(i.reason);
    return why ? `Reason: “${why}”` : null;
  }
  if (toolName === 'updateApplicationForm') {
    const changes = describeFormChange(i);
    // One change is already the question; several are listed.
    return changes.length > 1 ? changes.join(' · ') : null;
  }
  if (toolName === 'updateCareersPage') {
    const quoted = (label: string, key: string) => {
      if (!Object.hasOwn(i, key)) return null;
      const value = text(i[key]);
      return `${label}: ${value ? `“${value}”` : 'none'}`;
    };
    const parts = [
      i.careers_enabled === true ? 'Your open jobs become visible to anyone with the link, and can appear in search engines.' : null,
      i.careers_enabled === false ? 'The page and every job page stop being public.' : null,
      quoted('Headline', 'careers_headline'),
      quoted('Tagline', 'careers_tagline'),
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (toolName === 'createJob') {
    const salary = salaryText(sen(i.salary_min_cents), sen(i.salary_max_cents));
    const closes = dateText(i.closes_on);
    const parts = [text(i.department), text(i.location), salary, closes && `closes ${closes}`].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (toolName === 'updateJob') {
    const sent = (field: string) => Object.hasOwn(i, field);
    const words = JOB_FIELD_WORDS.filter(([fields]) => fields.some(sent)).map(([fields, word]) => {
      if (word === 'salary') {
        const min = sen(i.salary_min_cents);
        const max = sen(i.salary_max_cents);
        // Only one bound sent, and that one cleared: the other bound stays as it is.
        const cleared = fields.every(sent)
          ? 'not stated'
          : sent('salary_min_cents') ? 'no minimum' : 'no maximum';
        return `salary (${salaryText(min, max) ?? cleared})`;
      }
      if (word === 'closing date') {
        // A date that cannot be read is shown as it was sent, never as "none".
        return `closing date (${dateText(i.closes_on) ?? text(i.closes_on) ?? 'none'})`;
      }
      return word;
    });
    return words.length > 0 ? `Changes: ${words.join(', ')}` : null;
  }
  if (toolName === 'rejectApplication') {
    const reason = typeof i.reason === 'string' && Object.hasOwn(REASON_LABEL, i.reason) ? REASON_LABEL[i.reason as keyof typeof REASON_LABEL] : null;
    return reason ? `Reason: ${reason}` : null;
  }
  if (toolName === 'rateApplication') {
    // The grounds the assistant gave for its own reading, as one paragraph: nobody approves a rating of a person blind.
    const basis = typeof i.basis === 'string' ? i.basis.replace(/\s+/g, ' ').trim() : '';
    return basis ? `Why: ${basis}` : null;
  }
  // What goes with the row, where the database's own rules say so (see the CRM, forms and ads migrations).
  if (toolName === 'deleteContact') {
    return 'Their deals are deleted too, with the notes, activities and files kept on them. This cannot be undone.';
  }
  if (toolName === 'deleteDeal') return 'Its notes, activities and files are deleted too. This cannot be undone.';
  if (toolName === 'deleteForm') return 'Every submission it has collected is deleted too. This cannot be undone.';
  if (toolName === 'deleteCampaign') {
    return 'Its creatives are kept, no longer linked to a campaign. This cannot be undone.';
  }
  if (toolName === 'deleteJob') {
    return 'A job that has applications cannot be deleted: close it instead. This cannot be undone.';
  }
  if (toolName === 'recordPaymentIn' || toolName === 'recordPaymentOut') {
    const allocations = Array.isArray(i.allocations) ? (i.allocations as { amount?: unknown }[]) : [];
    const total = allocations.reduce((n, a) => n + (typeof a?.amount === 'number' ? a.amount : 0), 0);
    const noun = toolName === 'recordPaymentIn' ? 'invoice' : 'bill';
    const ref = text(i.reference);
    const parts = [
      total > 0 ? `Amount: ${ringgitFixed(total)}` : null,
      allocations.length > 0 ? `${allocations.length} ${noun}${allocations.length === 1 ? '' : 's'}` : null,
      ref && `Reference: “${ref}”`,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (toolName === 'recordRefund') {
    const amount = typeof i.amount === 'number' ? ringgitFixed(i.amount) : null;
    const ref = text(i.reference);
    const parts = [amount && `Amount: ${amount}`, ref && `Reference: “${ref}”`].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (toolName === 'markPaymentPaid' || toolName === 'markRefundPaid') {
    const paid = dateText(i.paid_on);
    return paid ? `Paid on ${paid}` : null;
  }
  if (toolName === 'postInvoice') return 'Posting gives the invoice a number and locks it; record its e-Invois status afterwards for LHDN.';
  if (toolName === 'postBill') return 'Posting locks the bill so it can no longer be edited.';
  if (toolName === 'setEInvoice') return 'This records the e-Invois (MyInvois) status submitted to LHDN.';
  if (toolName === 'voidInvoice' || toolName === 'voidBill' || toolName === 'voidCreditNote') {
    return 'Voiding keeps the document for the record but cancels its effect.';
  }
  if (
    toolName === 'deleteCreative' ||
    toolName === 'deleteLead' ||
    toolName === 'deleteAppointment' ||
    toolName === 'deleteDepartment' ||
    toolName === 'deleteInvoice' ||
    toolName === 'deleteQuotation' ||
    toolName === 'deleteCreditNote' ||
    toolName === 'deleteRefund' ||
    toolName === 'deleteBill' ||
    toolName === 'deleteFinanceContact' ||
    toolName === 'deleteFinanceItem' ||
    toolName === 'deleteScheduledPayment'
  ) {
    return 'This cannot be undone.';
  }
  return null;
}
