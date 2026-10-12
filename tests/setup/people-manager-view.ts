import type { PeopleData } from '@/lib/people/types';
import { asMember } from './people-member-view';

/**
 * The sample data as the database hands it to a member who manages `team`: `asMember`'s view, plus the lists the
 * database widens for a manager, holding their own rows and their direct reports'. Everything else is exactly what
 * a member gets. (A real manager reads team overtime through a function that leaves out its pay; this fake keeps
 * the whole row, which is enough to prove a personal screen narrows to the viewer's own.)
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
    listOvertime: async () => visible(await data.listOvertime()),
    listAttendance: async (from, to) => visible(await data.listAttendance(from, to)),
  };
}
