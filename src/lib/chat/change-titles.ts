/**
 * The wording of an approval card: what a change is, and the name of the
 * thing it is about. Pure, so the server can word a change a specialist
 * prepared and the chat can word one it finds in a message.
 */
// Itself pure and import-free: the words for the application form switches live with the switches.
import { describeFormChange } from '@/lib/hire/application-form';
import { REASON_LABEL } from '@/lib/hire/application-changes';
import { STAGE_LABEL } from '@/lib/hire/applications-view';
import { isRealDate, monthLabel, weekdayName } from '@/lib/people/dates';
import { blank, hhmm } from '@/lib/people/loose-input';
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
  if (kind === 'application') {
    // A listApplications row has `candidate` and `job`, not `name`.
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
  | 'payroll-run';
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
    const key = `${kind}:${row.id}`;
    if (key in into || Object.keys(into).length < NAMES_MAX) into[key] = label;
  }
  for (const inner of Object.values(row)) gather(inner, kind, into, depth + 1);
}

/** Every named row in a set of tool results, by the kind of thing its tool is about. */
export function collectNames(results: ToolResult[], into: KnownNames = {}): KnownNames {
  for (const result of results) {
    const kind = KIND_OF_TOOL[result.tool];
    // Payslips and their lines are read in order below, so the newest word on each one wins.
    if (kind && kind !== 'payslip') gather(result.output, kind, into);
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
      if (kind && KIND_OF_TOOL[results[r].tool] !== kind) continue;
      const found = nameOf(results[r].output, id, kind);
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

const UNLISTED_APPLICATION = 'an application that was not in the list above';
const UNLISTED_CANDIDATE = 'a candidate that was not in the list above';
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
export function approvalDetail(
  toolName: string,
  input?: unknown,
  receipt?: ReceiptState,
  /** Looks up a name by id (a job's title on an add-candidate card); without it a job is named but not titled. */
  named?: NameFinder,
): string | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'deleteEmployee') {
    return 'Their leave, claims, draft payslips and every other HR record are deleted too. This cannot be undone. Someone with a paid payslip cannot be deleted: make them inactive instead.';
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
