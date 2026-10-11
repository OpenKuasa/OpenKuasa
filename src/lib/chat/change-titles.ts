/**
 * The wording of an approval card: what a change is, and the name of the
 * thing it is about. Pure, so the server can word a change a specialist
 * prepared and the chat can word one it finds in a message.
 */
// Itself pure and import-free: the words for the application form switches live with the switches.
import { describeFormChange } from '@/lib/hire/application-form';
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
  | 'employee'
  | 'department'
  | 'leave'
  | 'time-off'
  | 'claim'
  | 'overtime';
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
  listDepartments: 'department',
  createDepartment: 'department',
  updateDepartment: 'department',
  deleteDepartment: 'department',
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
    if (Object.keys(into).length < NAMES_MAX) into[`${kind}:${row.id}`] = label;
  }
  for (const inner of Object.values(row)) gather(inner, kind, into, depth + 1);
}

/** Every named row in a set of tool results, by the kind of thing its tool is about. */
export function collectNames(results: ToolResult[], into: KnownNames = {}): KnownNames {
  for (const result of results) {
    const kind = KIND_OF_TOOL[result.tool];
    if (kind) gather(result.output, kind, into);
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
  return (id, kind) => {
    if (typeof id !== 'string' || !id) return null;
    for (let r = results.length - 1; r >= 0; r -= 1) {
      if (kind && KIND_OF_TOOL[results[r].tool] !== kind) continue;
      const found = nameOf(results[r].output, id, kind);
      if (found) return found;
    }
    return null;
  };
}

const UNLISTED_LEAVE = 'a leave request that was not in the list above';
const UNLISTED_TIME_OFF = 'a time-off request that was not in the list above';
const UNLISTED_CLAIM = 'a claim that was not in the list above';
const UNLISTED_OVERTIME = 'an overtime record that was not in the list above';

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

/**
 * The second line of an approval card. For a job it shows the values the
 * user is approving that the question itself does not: the salary and the
 * closing date above all.
 */
export function approvalDetail(toolName: string, input?: unknown, receipt?: ReceiptState): string | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'deleteEmployee') {
    return 'Their leave, claims, payslips and every other HR record are deleted too. This cannot be undone.';
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
  if (toolName === 'deleteContact') return 'Their deals are deleted too. This cannot be undone.';
  if (
    toolName === 'deleteCampaign' ||
    toolName === 'deleteCreative' ||
    toolName === 'deleteForm' ||
    toolName === 'deleteDeal' ||
    toolName === 'deleteLead' ||
    toolName === 'deleteAppointment' ||
    toolName === 'deleteJob' ||
    toolName === 'deleteDepartment'
  ) {
    return 'This cannot be undone.';
  }
  return null;
}
