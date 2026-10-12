/**
 * The dashboard's "My team" card for a manager: how many report to them, who is away today and what is waiting
 * for their decision. Pure; the screen reads the rows. Nothing here is for HR, a member or the demo.
 */
import { formatDay } from './dates';
import { leaveLabel, onLeaveOn } from './overview';
import { reportsOf } from './reporting';
import { teamScreenView } from './tier';
import type { Employee, LeaveRequest, PeopleViewer } from './types';
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
];

/** Whether the dashboard reads anything for the team card. */
export function showsTeamSection(viewer: PeopleViewer): boolean {
  return teamScreenView(viewer) === 'manager';
}

const when = (from: string, to: string) => (from === to ? formatDay(from) : `${formatDay(from)}–${formatDay(to)}`);

/** The dashboard's team card: null for everyone but a manager outside the demo. */
export function buildTeamSection(input: {
  viewer: PeopleViewer;
  employees: Employee[];
  leave: LeaveRequest[];
  waiting: WaitingCounts;
  today: string;
}): TeamSection | null {
  if (!showsTeamSection(input.viewer)) return null;
  const team = reportsOf(input.employees, input.viewer.employeeId);
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
