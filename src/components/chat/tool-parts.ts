/**
 * Reading tool activity out of a chat message: the lookups an assistant ran
 * and the changes it is waiting for approval on. Shared by Ask-Jebat and Tuah.
 */

import type { ComponentType } from 'react';
import type { UIMessage } from 'ai';
import { nameIn, type ItemKind, type NameFinder, type ToolResult } from '@/lib/chat/change-titles';
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
export type { ItemKind } from '@/lib/chat/change-titles';

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
  getHiringOverview: { label: 'Hiring overview', Icon: PieChart },
  listJobs: { label: 'Jobs', Icon: Briefcase },
  listApplications: { label: 'Applications', Icon: ClipboardList },
  getHiringFunnel: { label: 'Hiring funnel', Icon: Filter },
  listTalentPool: { label: 'Talent pool', Icon: UserSearch },
  listCandidates: { label: 'Candidates', Icon: Users },
  listInterviews: { label: 'Interviews', Icon: CalendarDays },
  getTimeToHire: { label: 'Time to hire', Icon: Timer },
  getSourceBreakdown: { label: 'Candidate sources', Icon: Waypoints },
  getPeopleOverview: { label: 'Team overview', Icon: PieChart },
  listEmployees: { label: 'Employees', Icon: Users },
  getEmployee: { label: 'Employee', Icon: Contact },
  listDepartments: { label: 'Departments', Icon: Users },
  getHeadcountByDepartment: { label: 'Headcount', Icon: ChartColumn },
  listWhoIsOnLeave: { label: 'On leave', Icon: CalendarDays },
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
  listTrainings: { label: 'Trainings', Icon: Briefcase },
  listAnnouncements: { label: 'Announcements', Icon: Megaphone },
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
  // Tools with no entry are the change tools, named for what they do.
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
  ['Two candidates called ', null],
  ['Two applications from someone called ', null],
  ['I could not check ', null],
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
