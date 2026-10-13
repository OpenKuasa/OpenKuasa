import type { PeopleData } from '@/lib/people/types';
import { asMember } from './people-member-view';

/**
 * The sample data as the database hands it to a member who manages `team`: `asMember`'s view, plus the lists the
 * database widens for a manager, holding their own rows and their direct reports'. Everything else is exactly what
 * a member gets. That includes overtime: the table is not widened (it holds pay), so a manager's table read is a
 * member's, their own rows only. Team overtime comes through `hr_team_overtime` (`readTeamOvertime`, no pay fields).
 */
export function asManager(data: PeopleData, employeeId: string, team: readonly string[]): PeopleData {
  const visible = <T extends { employee_id: string }>(rows: T[]) =>
    rows.filter((row) => row.employee_id === employeeId || team.includes(row.employee_id));
  return {
    ...asMember(data, employeeId),
    listLeaveRequests: async () => visible(await data.listLeaveRequests()),
    listLeaveBalances: async (year) => visible(await data.listLeaveBalances(year)),
    listTimeOffRequests: async () => visible(await data.listTimeOffRequests()),
    listClaims: async () => visible(await data.listClaims()),
    listAttendance: async (from, to) => visible(await data.listAttendance(from, to)),
  };
}
