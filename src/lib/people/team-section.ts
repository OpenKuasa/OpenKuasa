/**
 * The dashboard's "My team" card for anyone with reports (a manager, or an owner or admin who also has a team): how
 * many report to them, who is away today and what is waiting for their decision. Pure; the screen reads the rows.
 * Nothing here is for someone without reports or for the demo.
 */
import { formatDay } from './dates';
import { leaveLabel, onLeaveOn } from './overview';
import { reportsOf, teamIds } from './reporting';
import { hasReports } from './tier';
import type { Claim, Employee, LeaveRequest, OvertimeRecord, PeopleData, PeopleViewer, TimeOffRequest } from './types';
import { waitingTotal, type WaitingCounts } from './waiting-counts';

export type TeamSection = {
  members: number;
  away: { name: string; kind: string; when: string }[];
  /** Only kinds with a count above 0, in the menu's order. */
  waiting: { label: string; count: number; href: string }[];
  waitingTotal: number;
};

/** The menu's labels, order and addresses (`src/config/nav.ts`, the Approvals section). */
const KINDS: { key: keyof WaitingCounts; label: string; href: string }[] = [
  { key: 'leave', label: 'Leave', href: '/people/approve-leave' },
  { key: 'claims', label: 'Financial Claims', href: '/people/approve-claims' },
  { key: 'overtime', label: 'Overtime', href: '/people/approve-overtime' },
  { key: 'time_off', label: 'Time-Off', href: '/people/approve-time-off' },
  { key: 'swaps', label: 'Shift Swaps', href: '/people/approve-shift-swaps' },
];

/** Whether the dashboard reads anything for the team card. */
export function showsTeamSection(viewer: PeopleViewer): boolean {
  return hasReports(viewer);
}

const when = (from: string, to: string) => (from === to ? formatDay(from) : `${formatDay(from)}–${formatDay(to)}`);

/** The dashboard's team card: null for anyone without reports, and in the demo. */
export function buildTeamSection(input: {
  viewer: PeopleViewer;
  employees: Employee[];
  leave: LeaveRequest[];
  waiting: WaitingCounts;
  today: string;
}): TeamSection | null {
  if (!showsTeamSection(input.viewer)) return null;
  // Active reports only, as team attendance lists them.
  const team = reportsOf(input.employees, input.viewer.employeeId).filter((e) => e.status === 'active');
  const ids = new Set(team.map((e) => e.id));
  return {
    members: team.length,
    away: onLeaveOn(
      input.leave.filter((r) => ids.has(r.employee_id)),
      input.today,
    ).map((r) => ({ name: r.employee_name, kind: leaveLabel(r.leave_type), when: when(r.start_date, r.end_date) })),
    waiting: KINDS.filter((k) => input.waiting[k.key] > 0).map((k) => ({ label: k.label, count: input.waiting[k.key], href: k.href })),
    waitingTotal: waitingTotal(input.waiting),
  };
}

/**
 * Pending requests from the viewer's direct reports, counted from rows already read. Shift swaps are not among the
 * rows read here, so for an owner or admin with a team the card leaves them out (they have their own badge).
 */
export function waitingFromReports(
  rows: { leave: LeaveRequest[]; timeOff: TimeOffRequest[]; claims: Claim[]; overtime: OvertimeRecord[] },
  ids: Set<string>,
): WaitingCounts {
  const count = (list: { employee_id: string; status: string }[]) =>
    list.filter((r) => r.status === 'pending' && ids.has(r.employee_id)).length;
  return {
    leave: count(rows.leave),
    time_off: count(rows.timeOff),
    claims: count(rows.claims),
    overtime: count(rows.overtime),
    swaps: 0,
    swap_replies: 0,
  };
}

/**
 * The card for the dashboard: the section, null for anyone without reports, or 'unavailable' when its own reads
 * fail, so the rest of the dashboard still renders and the card never claims "Nobody is away" on a failed read.
 * `readWaiting` must throw on a failure (pass `readWaitingCountsStrict`), never answer zeros: zeros read as
 * "Nothing is waiting for you".
 * For an owner or admin `hr_waiting_counts` counts the whole workspace, so their card counts only their reports'
 * pending rows instead (HR reads every row) and `readWaiting` is not called.
 */
export async function loadTeamSection(
  data: Pick<PeopleData, 'listLeaveRequests' | 'listTimeOffRequests' | 'listClaims' | 'listOvertime'>,
  input: { viewer: PeopleViewer; employees: Employee[]; today: string; readWaiting: () => Promise<WaitingCounts> },
): Promise<TeamSection | 'unavailable' | null> {
  if (!showsTeamSection(input.viewer)) return null;
  try {
    let leave: LeaveRequest[];
    let waiting: WaitingCounts;
    if (input.viewer.isHr) {
      const [l, timeOff, claims, overtime] = await Promise.all([
        data.listLeaveRequests(),
        data.listTimeOffRequests(),
        data.listClaims(),
        data.listOvertime(),
      ]);
      leave = l;
      waiting = waitingFromReports({ leave, timeOff, claims, overtime }, teamIds(input.employees, input.viewer));
    } else {
      [leave, waiting] = await Promise.all([data.listLeaveRequests(), input.readWaiting()]);
    }
    return buildTeamSection({ viewer: input.viewer, employees: input.employees, leave, waiting, today: input.today });
  } catch {
    return 'unavailable';
  }
}
