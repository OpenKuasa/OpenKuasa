import { describe, expect, it } from 'vitest';
import { formatDay } from '@/lib/people/dates';
import { leaveLabel } from '@/lib/people/overview';
import { buildTeamSection, showsTeamSection } from '@/lib/people/team-section';
import { ZERO_WAITING } from '@/lib/people/waiting-counts';
import type { Employee, LeaveRequest, PeopleViewer } from '@/lib/people/types';

const TODAY = '2026-10-09';
const owner: PeopleViewer = { employeeId: null, isHr: true, isOwner: true, isDemo: false };
const admin: PeopleViewer = { employeeId: 'boss', isHr: true, isDemo: false };
const member: PeopleViewer = { employeeId: 'e1', isHr: false, isDemo: false };
const demo: PeopleViewer = { employeeId: 'e1', isHr: false, isDemo: true };
const manager: PeopleViewer = { employeeId: 'boss', isHr: false, isDemo: false, managesTeam: true };

const emp = (id: string, over: Partial<Employee> = {}): Employee => ({
  id, user_id: null, employee_no: id, name: id.toUpperCase(), work_email: null, department_id: null, department_name: null,
  designation: null, employment_type: 'full_time', reports_to: 'boss', join_date: '2025-01-01', status: 'active',
  date_of_birth_day: null, date_of_birth_month: null, created_at: '2025-01-01T00:00:00Z', ...over,
});
const leave = (over: Partial<LeaveRequest>): LeaveRequest => ({
  id: 'l', employee_id: 'r1', employee_name: 'R1', leave_type: 'annual', start_date: '2026-10-08', end_date: '2026-10-10',
  days: 3, half_day: false, reason: null, status: 'approved', decision_note: null, created_at: '2026-10-01T00:00:00Z', ...over,
});
const team = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => emp(id));
const employees = [emp('boss', { reports_to: null }), ...team, emp('x9', { reports_to: 'r1' })];
const build = (over: Partial<Parameters<typeof buildTeamSection>[0]> = {}) =>
  buildTeamSection({ viewer: manager, employees, leave: [], waiting: ZERO_WAITING, today: TODAY, ...over });

describe('showsTeamSection', () => {
  it('is for a manager only', () => {
    expect([owner, admin, member, demo, manager].map(showsTeamSection)).toEqual([false, false, false, false, true]);
  });
});

describe('buildTeamSection', () => {
  it('is null for everyone but a manager', () => {
    for (const viewer of [owner, admin, member, demo]) expect(build({ viewer })).toBeNull();
  });

  it('counts the team and lists the reports away today, not the manager, and not others', () => {
    const section = build({
      leave: [
        leave({ id: 'a', employee_id: 'r1', employee_name: 'R1' }),
        leave({ id: 'b', employee_id: 'r2', employee_name: 'R2', start_date: '2026-10-14', end_date: '2026-10-15' }),
        leave({ id: 'c', employee_id: 'boss', employee_name: 'BOSS' }),
        leave({ id: 'd', employee_id: 'x9', employee_name: 'X9' }),
      ],
    })!;
    expect(section.members).toBe(5);
    expect(section.away).toEqual([
      { name: 'R1', kind: leaveLabel('annual'), when: `${formatDay('2026-10-08')}–${formatDay('2026-10-10')}` },
    ]);
  });

  it('leaves out leave that is pending or rejected', () => {
    const section = build({
      leave: [leave({ id: 'a', status: 'pending' }), leave({ id: 'b', employee_id: 'r2', employee_name: 'R2', status: 'rejected' })],
    })!;
    expect(section.away).toEqual([]);
  });

  it('lists only the kinds with something waiting, in the menu order', () => {
    const section = build({ waiting: { leave: 2, time_off: 0, claims: 1, overtime: 0 } })!;
    expect(section.waiting).toEqual([
      { label: 'Leave', count: 2, href: '/people/approve-leave' },
      { label: 'Financial Claims', count: 1, href: '/people/approve-claims' },
    ]);
    expect(section.waitingTotal).toBe(3);
  });

  it('has the four labels and hrefs of the menu', () => {
    const section = build({ waiting: { leave: 1, time_off: 1, claims: 1, overtime: 1 } })!;
    expect(section.waiting.map((w) => [w.label, w.href])).toEqual([
      ['Leave', '/people/approve-leave'],
      ['Financial Claims', '/people/approve-claims'],
      ['Overtime', '/people/approve-overtime'],
      ['Time-Off', '/people/approve-time-off'],
    ]);
  });

  it('has nothing waiting when the counts are zero', () => {
    expect(build()).toMatchObject({ waiting: [], waitingTotal: 0 });
  });

  it('a manager with no employees in the list has no members and nobody away', () => {
    expect(build({ employees: [] })).toMatchObject({ members: 0, away: [] });
  });
});
