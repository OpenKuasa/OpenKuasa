/**
 * Reading tool activity out of a chat message: the lookups an assistant ran
 * and the changes it is waiting for approval on. Shared by Ask-Jebat and Tuah.
 */

import type { ComponentType } from 'react';
import type { UIMessage } from 'ai';
import { nameIn, type ItemKind, type NameFinder, type ToolResult } from '@/lib/chat/change-titles';
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

const TOOL_META: Record<string, { label: string; Icon: Icon }> = {
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
  getLeaveBalances: { label: 'Leave balances', Icon: SlidersHorizontal },
  listPendingApprovals: { label: 'Pending approvals', Icon: ClipboardList },
  listClaims: { label: 'Claims', Icon: Coins },
  listOvertime: { label: 'Overtime', Icon: Timer },
  getAttendanceSummary: { label: 'Attendance', Icon: TrendingUp },
  getTimesheet: { label: 'Timesheet', Icon: Timer },
  listShifts: { label: 'Shift roster', Icon: CalendarDays },
  listPublicHolidays: { label: 'Public holidays', Icon: CalendarDays },
  getPayrollSummary: { label: 'Payroll', Icon: Coins },
  listPayslips: { label: 'Payslips', Icon: Coins },
  getPerformanceSummary: { label: 'Performance', Icon: TrendingUp },
  listTrainings: { label: 'Trainings', Icon: Briefcase },
  listAnnouncements: { label: 'Announcements', Icon: Megaphone },
  getCareersPage: { label: 'Careers page', Icon: Globe },
  listContacts: { label: 'Leads', Icon: Users },
};

function humanize(name: string): string {
  const spaced = name.replace(/^(get|list)/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return (spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()).trim();
}

export function toolMeta(name: string): { label: string; Icon: Icon; isFallback: boolean } {
  const known = TOOL_META[name];
  // Tools with no entry are the change tools, named for what they do.
  return known
    ? { ...known, isFallback: false }
    : { label: humanize(name) || 'Tool', Icon: Wrench, isFallback: true };
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
  /** The user said no to this change, so it never ran. */
  denied: boolean;
  output: unknown;
};

export function toToolStep(part: AnyPart, messageId: string, index: number): ToolStep | null {
  const name = toolName(part);
  if (!name) return null;
  const state = 'state' in part ? (part.state as string) : undefined;
  const denied = state === 'output-denied';
  const running = !denied && state !== 'output-available' && state !== 'output-error';
  const output = 'output' in part ? part.output : undefined;
  const key =
    ('toolCallId' in part ? (part.toolCallId as string) : undefined) ?? `${messageId}-${index}`;
  return { key, name, running, denied, output };
}

export type PendingApproval = { approvalId: string; toolName: string; input: unknown };

export function toPendingApproval(part: AnyPart): PendingApproval | null {
  const type = part.type;
  if (typeof type !== 'string' || !type.startsWith('tool-')) return null;
  if (!('state' in part) || (part as { state?: string }).state !== 'approval-requested') return null;
  const approval = (part as { approval?: { id?: string } }).approval;
  if (!approval?.id) return null;
  return {
    approvalId: approval.id,
    toolName: type.slice('tool-'.length),
    input: (part as { input?: unknown }).input,
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
