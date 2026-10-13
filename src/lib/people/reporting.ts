import type { Employee, PeopleViewer } from './types';

/** How far up the database walks before it gives up: a line longer than this is refused as a loop. */
const MAX_STEPS = 50;

/** The employees who report directly to `managerId`, by name. One hop only. */
export function reportsOf(employees: Employee[], managerId: string | null): Employee[] {
  if (managerId === null) return [];
  return employees.filter((e) => e.reports_to === managerId).sort((a, b) => a.name.localeCompare(b.name));
}

/** The ids of the viewer's direct reports. Empty when the account is not linked. */
export function teamIds(employees: Employee[], viewer: PeopleViewer): Set<string> {
  return new Set(reportsOf(employees, viewer.employeeId).map((e) => e.id));
}

/** The employee this one reports to, or null: nobody, or a manager not in the rows. */
export function managerOf(employee: Pick<Employee, 'reports_to'>, employees: Employee[]): Employee | null {
  if (employee.reports_to === null) return null;
  return employees.find((e) => e.id === employee.reports_to) ?? null;
}

/** The manager's name as a screen shows it, with "(inactive)" after a manager who has left. Null for nobody. */
export function managerLabel(employee: Pick<Employee, 'reports_to'>, employees: Employee[]): string | null {
  const manager = managerOf(employee, employees);
  if (!manager) return null;
  return manager.status === 'inactive' ? `${manager.name} (inactive)` : manager.name;
}

/** Everyone who has at least one report. */
export function managerIdsOf(employees: Employee[]): Set<string> {
  const ids = new Set<string>();
  for (const e of employees) if (e.reports_to !== null) ids.add(e.reports_to);
  return ids;
}

/**
 * The database's rule, on the rows loaded: would `managerId` as `employeeId`'s manager make a loop? Walks up from
 * `managerId`; true on meeting the employee or after more than 50 steps, false on running off the top or meeting an
 * id that is not in the rows (an unknown manager is the database's to refuse).
 */
export function wouldLoop(employeeId: string, managerId: string, employees: Employee[]): boolean {
  const byId = new Map(employees.map((e) => [e.id, e]));
  let current: string | null = managerId;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (current === null) return false;
    if (current === employeeId) return true;
    const row = byId.get(current);
    if (!row) return false;
    current = row.reports_to;
  }
  return true;
}
