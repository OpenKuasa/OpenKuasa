/**
 * Reading tool activity out of a chat message: the lookups an assistant ran
 * and the changes it is waiting for approval on. Shared by Ask-Jebat and Tuah.
 */

import type { ComponentType } from 'react';
import type { UIMessage } from 'ai';
import { nameIn, rowIn, type ItemKind, type NameFinder, type RowFinder, type ToolResult } from '@/lib/chat/change-titles';
import { pickReceipt, userMessageBefore, type ReceiptState } from '@/lib/people/receipts';
import { isFilePart } from '@/lib/chat/attachments';
import {
  APPLY_TOOL,
  ASK_PREFIX,
  isDelegation,
  proposalsIn,
  type Delegation,
  type Proposal,
} from '@/lib/chat/delegation';
import {
  Briefcase,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  Coins,
  FileText,
  Filter,
  Globe,
  Images,
  Megaphone,
  PieChart,
  Contact,
  Handshake,
  SquareKanban,
  ChartColumn,
  Send,
  SlidersHorizontal,
  Timer,
  TrendingUp,
  UserSearch,
  Users,
  Waypoints,
  Wrench,
  Zap,
} from 'lucide-react';

type Icon = ComponentType<{ className?: string }>;

export type AnyPart = UIMessage['parts'][number];

export { approvalDetail, approvalTitle } from '@/lib/chat/change-titles';
export type { ItemKind, RowFinder } from '@/lib/chat/change-titles';

type ToolMeta = {
  label: string;
  Icon: Icon;
  /** A few plain words to show beside the label, read from the tool's result. */
  detail?: (output: unknown) => string | null;
  /** How the tool reads while it runs, where "Looking up <label>…" would not read well. */
  running?: string;
};

/** Whose CV was read: the candidate's name, once the read has succeeded. */
function cvCandidate(output: unknown): string | null {
  const result = output as { ok?: unknown; candidate?: unknown } | null | undefined;
  return result?.ok === true && typeof result.candidate === 'string' && result.candidate.trim()
    ? result.candidate
    : null;
}

/** What a specialist's card says while a change is being prepared. */
const PREPARING = 'Preparing a change…';

const TOOL_META: Record<string, ToolMeta> = {
  getAdsOverview: { label: 'Ads overview', Icon: PieChart },
  getCampaigns: { label: 'Campaigns', Icon: Megaphone },
  getLeadSummary: { label: 'Lead summary', Icon: TrendingUp },
  getSpendByChannel: { label: 'Spend by channel', Icon: Coins },
  getUpcomingAppointments: { label: 'Appointments', Icon: CalendarDays },
  getCreatives: { label: 'Creatives', Icon: Images },
  getAdSettings: { label: 'Ad settings', Icon: SlidersHorizontal },
  listForms: { label: 'Lead forms', Icon: ClipboardList },
  listBroadcasts: { label: 'Broadcasts', Icon: Send },
  listAutomations: { label: 'Automations', Icon: Zap },
  listCrmContacts: { label: 'Contacts', Icon: Contact },
  listDeals: { label: 'Deals', Icon: Handshake },
  listPipelines: { label: 'Pipelines', Icon: SquareKanban },
  getDealStats: { label: 'Deal totals', Icon: ChartColumn },
  listFollowUps: { label: 'Follow-ups', Icon: ClipboardList },
  getCalendar: { label: 'Calendar', Icon: CalendarDays },
  getBillingSummary: { label: 'Billing totals', Icon: ChartColumn },
  listBillingInvoices: { label: 'Invoices', Icon: ClipboardList },
  getHiringOverview: { label: 'Hiring overview', Icon: PieChart },
  listJobs: { label: 'Jobs', Icon: Briefcase },
  listApplications: { label: 'Applications', Icon: ClipboardList },
  getHiringFunnel: { label: 'Hiring funnel', Icon: Filter },
  listTalentPool: { label: 'Talent pool', Icon: UserSearch },
  listCandidates: { label: 'Candidates', Icon: Users },
  listInterviews: { label: 'Interviews', Icon: CalendarDays },
  // The six interview changes. A change tool otherwise has no entry and is named for what it does; these have one,
  // for the icon. `running` keeps a specialist's card saying a change is being prepared: that card takes a tool with
  // no entry to be a change, and would say "Looking up schedule interview…" of one that has an entry.
  scheduleInterview: { label: 'Schedule interview', Icon: CalendarDays, running: PREPARING },
  recordPastInterview: { label: 'Record a past interview', Icon: CalendarCheck, running: PREPARING },
  rescheduleInterview: { label: 'Reschedule or edit interview', Icon: CalendarClock, running: PREPARING },
  cancelInterview: { label: 'Cancel interview', Icon: CalendarDays, running: PREPARING },
  setInterviewOutcome: { label: 'Interview outcome', Icon: CalendarCheck, running: PREPARING },
  reopenInterview: { label: 'Interview scheduled again', Icon: CalendarDays, running: PREPARING },
  getTimeToHire: { label: 'Time to hire', Icon: Timer },
  getSourceBreakdown: { label: 'Candidate sources', Icon: Waypoints },
  getPeopleOverview: { label: 'Team overview', Icon: PieChart },
  listEmployees: { label: 'Employees', Icon: Users },
  getEmployee: { label: 'Employee', Icon: Contact },
  listDepartments: { label: 'Departments', Icon: Users },
  getHeadcountByDepartment: { label: 'Headcount', Icon: ChartColumn },
  listWhoIsOnLeave: { label: 'On leave', Icon: CalendarDays },
  listMyTeam: { label: 'My team', Icon: Users },
  getWaitingForMe: { label: 'Waiting for me', Icon: ClipboardList },
  listLeaveRequests: { label: 'Leave requests', Icon: ClipboardList },
  listTimeOffRequests: { label: 'Time-off requests', Icon: ClipboardList },
  previewLeave: { label: 'Leave preview', Icon: CalendarDays },
  previewOvertime: { label: 'Overtime preview', Icon: Timer },
  getLeaveBalances: { label: 'Leave balances', Icon: SlidersHorizontal },
  listPendingApprovals: { label: 'Pending approvals', Icon: ClipboardList },
  listClaims: { label: 'Claims', Icon: Coins },
  listOvertime: { label: 'Overtime', Icon: Timer },
  getAttendanceSummary: { label: 'Attendance', Icon: TrendingUp },
  getTimesheet: { label: 'Timesheet', Icon: Timer },
  listShifts: { label: 'Shift roster', Icon: CalendarDays },
  listPublicHolidays: { label: 'Public holidays', Icon: CalendarDays },
  getMyAttendanceToday: { label: 'Your attendance today', Icon: Timer },
  getAttendanceSettings: { label: 'Attendance settings', Icon: SlidersHorizontal },
  getPayrollSummary: { label: 'Payroll', Icon: Coins },
  listPayslips: { label: 'Payslips', Icon: Coins },
  getPerformanceSummary: { label: 'Performance', Icon: TrendingUp },
  listGoals: { label: 'Goals', Icon: TrendingUp },
  listReviews: { label: 'Reviews', Icon: ClipboardList },
  listTrainings: { label: 'Trainings', Icon: Briefcase },
  listAnnouncements: { label: 'Announcements', Icon: Megaphone },
  listDocuments: { label: 'Documents', Icon: FileText },
  listLetters: { label: 'Letters', Icon: FileText },
  listLetterTemplates: { label: 'Letter templates', Icon: FileText },
  getCareersPage: { label: 'Careers page', Icon: Globe },
  readCandidateCv: { label: 'Reading CV', Icon: FileText, detail: cvCandidate, running: 'Reading a CV…' },
  listContacts: { label: 'Leads', Icon: Users },
};

function humanize(name: string): string {
  const spaced = name.replace(/^(get|list)/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return (spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()).trim();
}

export function toolMeta(name: string): ToolMeta & { isFallback: boolean } {
  const known = TOOL_META[name];
  // A tool with no entry is a change tool, named for what it does. (The six interview changes have entries, for their icons.)
  return known
    ? { ...known, isFallback: false }
    : { label: humanize(name) || 'Tool', Icon: Wrench, isFallback: true };
}

/** What a specialist is doing while one of its lookups runs, in a few words. */
export function liveStepStatus(name: string): string {
  const { label, running } = toolMeta(name);
  return running ?? `Looking up ${label.toLowerCase()}…`;
}

export function isText(p: AnyPart): p is Extract<AnyPart, { type: 'text' }> {
  return p.type === 'text';
}

function toolName(part: AnyPart): string | null {
  const type = part.type;
  if (type === 'dynamic-tool') return (part as { toolName?: string }).toolName ?? null;
  if (typeof type === 'string' && type.startsWith('tool-')) return type.slice('tool-'.length);
  return null;
}

export type ToolStep = {
  key: string;
  name: string;
  running: boolean;
  /** The change never ran: the user said no to it, or the server refused it before asking (then `reason` says why). */
  denied: boolean;
  /** Why the server refused the change itself. Absent when the user said no. */
  reason?: string;
  /** The user approved it and the server's last check then stopped it. Nothing ran. */
  afterApproval?: true;
  output: unknown;
};

/**
 * The line a person reads on a change the server refused before asking them. The server's reason is written for
 * the model: it can name tools and carry a row's id. So it is not shown; a line written for a person is chosen by
 * how the reason begins (the beginnings are fixed in lib/ai/hire-deletions.ts, and a test holds the two together).
 * A reason that is already a sentence for a person passes as it is. One that is not known shows nothing of itself.
 */
const REFUSAL_LINES: [start: string, line: string | null][] = [
  ['One deletion at a time.', 'Only one deletion is prepared at a time, and one was already prepared. Ask for this one again afterwards.'],
  ['More than one match was found', 'More than one record matches that name, so nothing was prepared. Say which one you mean, then ask again.'],
  ['You have not looked up ', 'The assistant had not looked this record up, so nothing was prepared. Ask again and it will look it up first.'],
  ['Someone else with the same name appeared ', 'A last check stopped this, because someone else with the same name had appeared. Nothing was deleted. Ask for it again.'],
  ['One talent pool change at a time.', 'Only one talent pool change is prepared at a time, and one was already prepared. Ask for this one again afterwards.'],
  ['This candidate is not in the talent pool', 'This person is not in the talent pool, so no move was prepared. Add them to the talent pool first, then ask again.'],
  ['A candidate with the same name appeared ', 'A last check stopped this, because someone else with the same name had appeared. Nothing was changed. Ask for it again.'],
  ['One interview change at a time.', 'Only one interview change is prepared at a time, and one was already prepared. Ask for this one again afterwards.'],
  ['That link was not given by the user', 'That link was not one you gave since the last interview card, so nothing was prepared: give the link again in your message, or ask again without one.'],
  ['This interview was changed after the card was shown', 'A last check stopped this, because the interview had been changed since the card was shown. Nothing was changed. Ask for it again.'],
  ['This interview is still marked scheduled', 'This interview is still marked scheduled, so no feedback was prepared. Say that it took place and ask again, or use “Mark completed and add feedback” on the Interviews screen.'],
  ['This interview did not take place', null],
  ['This interview already has feedback, so nothing was prepared', 'This interview already has feedback, so nothing was prepared. Say that it should be replaced and ask again, or use “Edit feedback” on the Interviews screen.'],
  ['This interview has no feedback yet', 'This interview had no feedback to replace, so nothing was prepared. Ask again to add the feedback.'],
  ['This interview has no feedback to clear', null],
  ['This interview is already marked completed', 'This interview was already marked completed, so nothing was prepared. Ask again to add the feedback.'],
  ['This interview has feedback, so it cannot', null],
  ['Two candidates called ', null],
  ['Two applications from someone called ', null],
  ['The date and time sent are the ones this interview already has', 'The time given was the time this interview already has, so nothing was prepared. Ask again for only what should change.'],
  ['The interviewer\'s name holds a link', 'The interviewer\'s name held a link, so nothing was prepared. A link goes in the Place or link field: give it as the place and ask again, or type it there on the Interviews screen.'],
  ['That link has hidden characters in it', 'That link had hidden characters in it, so nothing was prepared: type the link out by hand in your message, or ask again without one.'],
  ['Nothing would change:', null],
  ['Two interviews with ', null],
  ['This interview no longer exists', null],
  ['The application this interview belongs to is no longer active', null],
  ['I could not check ', null],
  ['This change is no longer waiting for approval', 'This change is no longer waiting for approval: it was already answered, or it waited too long. Nothing was saved. Ask for it again if you still want it.'],
  ['Changes cannot be prepared right now', 'Changes cannot be prepared right now, so nothing was put up for approval. Try again in a few minutes.'],
];
export function refusalForUser(reason: string): string {
  const known = REFUSAL_LINES.find(([start]) => reason.startsWith(start));
  if (!known) return 'This was stopped before it was shown for approval. Nothing was changed.';
  return known[1] ?? reason;
}

export function toToolStep(part: AnyPart, messageId: string, index: number): ToolStep | null {
  const name = toolName(part);
  if (!name) return null;
  const state = 'state' in part ? (part.state as string) : undefined;
  const denied = state === 'output-denied';
  const running = !denied && state !== 'output-available' && state !== 'output-error';
  const output = 'output' in part ? part.output : undefined;
  const key =
    ('toolCallId' in part ? (part.toolCallId as string) : undefined) ?? `${messageId}-${index}`;
  // A refusal of the server's own carries its reason; the chat's Reject button sends none.
  const approval = denied ? (part as { approval?: { approved?: unknown; reason?: unknown } }).approval : undefined;
  const reason = typeof approval?.reason === 'string' && approval.reason.trim() ? refusalForUser(approval.reason) : undefined;
  // Denied although the part says approved: the server checks an approved change once more before running it, and
  // tells the browser only that it was denied. The user's yes stays on the part; the server's reason goes to the model.
  const afterApproval = approval?.approved === true;
  return { key, name, running, denied, ...(reason && { reason }), ...(afterApproval && { afterApproval }), output };
}

/**
 * What the question behind a pending claim carried, for its card: the file on the user message before the assistant
 * message holding the approval, judged by the same rule the server uses to pick the receipt. Undefined when the
 * approval is not found. (In a reopened chat the browser may hold a stored link where the server has bytes only if the
 * stored file resolved; the tool's result note covers a miss.)
 */
export function receiptStateFor(messages: { role: string; parts: AnyPart[] }[], approvalId: string): ReceiptState | undefined {
  const at = messages.findIndex(
    (m) => m.role === 'assistant' && m.parts.some((p) => (p as { approval?: { id?: string } }).approval?.id === approvalId),
  );
  if (at < 0) return undefined;
  const question = userMessageBefore(messages, at);
  const pick = pickReceipt((question?.parts ?? []).filter(isFilePart));
  return pick.state === 'attached' ? { state: 'attached' } : pick;
}

export type PendingApproval = {
  approvalId: string;
  toolName: string;
  input: unknown;
  /** A line the server put on the request for the person deciding (which of two same-named people this is). Never from the model. */
  note?: string;
};

export function toPendingApproval(part: AnyPart): PendingApproval | null {
  const type = part.type;
  if (typeof type !== 'string' || !type.startsWith('tool-')) return null;
  if (!('state' in part) || (part as { state?: string }).state !== 'approval-requested') return null;
  const approval = (part as { approval?: { id?: string; isAutomatic?: boolean; requestReason?: unknown } }).approval;
  // A request the server answered itself is never the user's to decide.
  if (!approval?.id || approval.isAutomatic) return null;
  return {
    approvalId: approval.id,
    toolName: type.slice('tool-'.length),
    input: (part as { input?: unknown }).input,
    ...(typeof approval.requestReason === 'string' && approval.requestReason.trim() && { note: approval.requestReason }),
  };
}

/** How many changes in a conversation ran after the user approved them. */
export function changesApplied(messages: { parts: AnyPart[] }[]): number {
  let count = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (!toolName(part) || !('state' in part) || part.state !== 'output-available') continue;
      if ((part as { approval?: { approved?: boolean } }).approval?.approved) count += 1;
    }
  }
  return count;
}

/** Every tool result in a conversation, oldest first. */
export function toolResults(messages: { parts: AnyPart[] }[]): ToolResult[] {
  const results: ToolResult[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      const tool = toolName(part);
      if (tool && 'output' in part) results.push({ tool, output: part.output });
    }
  }
  return results;
}

/** Looks names up by id across a conversation's tool results. */
export function nameFinder(messages: { parts: AnyPart[] }[]): NameFinder {
  return nameIn(toolResults(messages));
}

/** Looks rows up by id across a conversation's tool results: what a card shows as there now. */
export function rowFinder(messages: { parts: AnyPart[] }[]): RowFinder {
  return rowIn(toolResults(messages));
}

/** The name of the thing a change is about, when the change names it by `id`. */
export function approvalSubject(
  input: unknown,
  messages: { parts: AnyPart[] }[],
  kind?: ItemKind,
): string | null {
  return nameFinder(messages)((input as { id?: unknown } | null)?.id, kind);
}

/** True when a message shows something: words, or tool activity. */
export function hasVisibleContent(message: UIMessage): boolean {
  return message.parts.some(
    (p) => (isText(p) && p.text.trim().length > 0) || toolName(p) !== null,
  );
}

/** A request Tuah made to a specialist, with its work so far. */
export type SpecialistWork = {
  key: string;
  /** The specialist's name, known from the request itself before any work comes back. */
  agent: string;
  work: Delegation | null;
  failed: boolean;
  running: boolean;
};

export function toSpecialistWork(part: AnyPart, messageId: string, index: number): SpecialistWork | null {
  const name = toolName(part);
  if (!name || !name.startsWith(ASK_PREFIX) || name === APPLY_TOOL) return null;
  const state = 'state' in part ? (part.state as string) : undefined;
  const output = 'output' in part ? part.output : undefined;
  const work = isDelegation(output) ? output : null;
  const failed = state === 'output-error' || work?.status === 'failed';
  return {
    key: ('toolCallId' in part ? (part.toolCallId as string) : undefined) ?? `${messageId}-${index}`,
    agent: work?.agent ?? name.slice(ASK_PREFIX.length),
    work,
    failed,
    running: !failed && work?.status !== 'done',
  };
}

/** The change an `applyChange` call is about, found among what the specialists prepared. */
export function proposalFor(input: unknown, messages: { parts: AnyPart[] }[]): Proposal | null {
  const id = (input as { proposalId?: unknown } | null)?.proposalId;
  return typeof id === 'string' ? (proposalsIn(messages).get(id) ?? null) : null;
}
