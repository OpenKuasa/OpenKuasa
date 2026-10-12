/**
 * The Employees screen's figures and its form's rules, as pure functions so
 * the server component, the client form and the tests share one version.
 */
import { daysBetween } from './dates';
import { showsOwnerDocumentControls } from './documents-screens';
import type { WorkspaceMember } from './members';
import { headcountByDepartment } from './overview';
import { managerIdsOf, managerLabel, wouldLoop } from './reporting';
import { REPORTS_TO_REFUSALS, REPORTS_TO_SAVED_NOT_LINE, reportsToLoop } from './reporting-refusals';
import type { Department, Employee, EmployeePrivate, EmployeeStatus, EmploymentType, PeopleViewer } from './types';

export const EMPLOYMENT_TYPES: readonly EmploymentType[] = ['full_time', 'part_time', 'contract', 'intern'];
export const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  intern: 'Intern',
};

export type EmployeesModel = {
  employees: Employee[];
  /** Every department, with how many active staff are in it. */
  departments: (Department & { headcount: number })[];
  totals: {
    /** Active staff. */
    headcount: number;
    inactive: number;
    departments: number;
    new_joiners_90d: number;
    /** Null when no active employee has a join date. */
    avg_tenure_years: number | null;
  };
  by_department: { department: string; headcount: number }[];
  tenure: { label: string; count: number }[];
  employment: { type: EmploymentType; label: string; count: number }[];
};

const YEAR = 365;
const BANDS: [string, number, number][] = [
  ['<1 yr', 0, YEAR],
  ['1–2 yr', YEAR, 2 * YEAR],
  ['2–3 yr', 2 * YEAR, 3 * YEAR],
  ['3+ yr', 3 * YEAR, Infinity],
];

export function buildEmployeesModel(employees: Employee[], departments: Department[], today: string): EmployeesModel {
  const active = employees.filter((employee) => employee.status === 'active');
  // Days served, for active staff whose join date is known and not in the future.
  const served = active
    .filter((employee) => employee.join_date !== null && employee.join_date <= today)
    .map((employee) => daysBetween(employee.join_date as string, today));
  const total = served.reduce((sum, days) => sum + days, 0);

  return {
    employees,
    departments: departments.map((department) => ({
      ...department,
      headcount: active.filter((employee) => employee.department_id === department.id).length,
    })),
    totals: {
      headcount: active.length,
      inactive: employees.length - active.length,
      departments: departments.length,
      new_joiners_90d: served.filter((days) => days <= 90).length,
      avg_tenure_years: served.length > 0 ? Math.round((total / served.length / YEAR) * 10) / 10 : null,
    },
    by_department: headcountByDepartment(employees),
    tenure: BANDS.map(([label, from, to]) => ({ label, count: served.filter((days) => days >= from && days < to).length })),
    employment: EMPLOYMENT_TYPES.map((type) => ({
      type,
      label: EMPLOYMENT_LABEL[type],
      count: active.filter((employee) => employee.employment_type === type).length,
    })),
  };
}

export type EmployeeFilter = { query: string; departmentId: string; status: 'all' | EmployeeStatus; team: 'all' | 'mine' };

/**
 * `departmentId` is a department's id, `'all'`, or `'none'` for staff in no department. `team: 'mine'` keeps the
 * viewer's direct reports, and nobody when the viewer has no employee record.
 */
export function filterEmployees(
  employees: Employee[],
  filter: EmployeeFilter,
  viewerEmployeeId?: string | null,
): Employee[] {
  const query = filter.query.trim().toLowerCase();
  return employees.filter((employee) => {
    if (filter.team === 'mine' && (!viewerEmployeeId || employee.reports_to !== viewerEmployeeId)) return false;
    if (filter.status !== 'all' && employee.status !== filter.status) return false;
    if (filter.departmentId === 'none' && employee.department_id !== null) return false;
    if (filter.departmentId !== 'all' && filter.departmentId !== 'none' && employee.department_id !== filter.departmentId) {
      return false;
    }
    if (!query) return true;
    return [employee.name, employee.work_email, employee.employee_no, employee.designation].some((value) =>
      (value ?? '').toLowerCase().includes(query),
    );
  });
}

export type ReportsToOption = { id: string; label: string };

/** Who this employee may be set to report to: active employees, not themselves, by name; the manager they have now is kept even if inactive, labelled "(inactive)". */
export function reportsToOptions(
  employees: Employee[],
  employeeId: string | null,
  currentManagerId: string | null,
): ReportsToOption[] {
  return employees
    .filter((e) => e.id !== employeeId && (e.status === 'active' || e.id === currentManagerId))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ id: e.id, label: e.status === 'inactive' ? `${e.name} (inactive)` : e.name }));
}

/** The options whose label contains the typed text, any capitals; all of them for a blank search. The chosen one is always kept. */
export function searchReportsTo(options: ReportsToOption[], query: string, chosenId: string): ReportsToOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((o) => o.id === chosenId || o.label.toLowerCase().includes(needle));
}

/** What the form sends for the reporting line: nothing when it is as it was. `''` means nobody. */
export function reportsToChange(initial: string | null, chosen: string): { changed: boolean; managerId: string | null } {
  const managerId = chosen === '' ? null : chosen;
  return { changed: managerId !== initial, managerId };
}

/** The sentence the form shows before sending, or null when the choice is fine on the rows loaded. */
export function reportsToProblem(employeeId: string | null, chosen: string, employees: Employee[]): string | null {
  if (!employeeId || !chosen) return null;
  if (!wouldLoop(employeeId, chosen, employees)) return null;
  const name = employees.find((e) => e.id === chosen)?.name;
  return name ? reportsToLoop(name) : REPORTS_TO_REFUSALS.EMP_BAD_MANAGER;
}

/**
 * A refusal from setReportsToAction, worded for the form. The database's bad-manager sentence is general (a loop, a
 * manager gone, a chain too deep); only when the loaded rows themselves show a loop does it name the chosen manager.
 */
export function reportsToRefusal(error: string, employeeId: string, chosen: string, employees: Employee[]): string {
  if (error !== REPORTS_TO_REFUSALS.EMP_BAD_MANAGER) return error;
  if (!chosen || !wouldLoop(employeeId, chosen, employees)) return error;
  const name = employees.find((e) => e.id === chosen)?.name;
  return name ? reportsToLoop(name) : error;
}

/** What the list shows per employee: who they report to, and whether they are someone's manager. */
export type DirectoryExtras = { reportsTo: string | null; manages: boolean };

export function directoryExtras(employees: Employee[]): Map<string, DirectoryExtras> {
  const managers = managerIdsOf(employees);
  return new Map(
    employees.map((e) => [e.id, { reportsTo: managerLabel(e, employees), manages: managers.has(e.id) }]),
  );
}

/** What the Employees screen offers this viewer. */
export type EmployeesControls = { canEdit: boolean; reportsToField: boolean; myTeamFilter: boolean };

export function employeesControls(viewer: PeopleViewer | null | undefined): EmployeesControls {
  const canEdit = showsOwnerDocumentControls(viewer);
  const myTeamFilter =
    !canEdit && viewer != null && !viewer.isHr && !viewer.isDemo && viewer.managesTeam === true && !!viewer.employeeId;
  return { canEdit, reportsToField: canEdit, myTeamFilter };
}

/** The order the table saves an edit in, and what the person is told when a later step is refused. */
export const SAVE_ORDER = ['details', 'reports_to', 'entitlements'] as const;

export type SaveStep = (typeof SAVE_ORDER)[number];
export type StepResult = { ok: true } | { ok: false; error: string };
export type SaveOutcome =
  | { ok: true; done: SaveStep[] }
  | { ok: false; step: SaveStep; error: string; done: SaveStep[] };

/**
 * Walks SAVE_ORDER with the table's steps, stopping at the first refusal. The line step runs only when
 * `lineChanged`. A refusal after the details is worded with {@link saveFailure}; a request that rejects after the
 * details were saved says so the same way. A rejected details request is rethrown: nothing was saved.
 */
export async function runSave(lineChanged: boolean, steps: Record<SaveStep, () => Promise<StepResult>>): Promise<SaveOutcome> {
  const done: SaveStep[] = [];
  for (const step of SAVE_ORDER) {
    if (step === 'reports_to' && !lineChanged) continue;
    let result: StepResult;
    try {
      result = await steps[step]();
    } catch (error) {
      if (step === 'details') throw error;
      result = { ok: false, error: 'Something went wrong. Try again.' };
    }
    if (!result.ok) {
      return { ok: false, step, error: step === 'details' ? result.error : saveFailure(step, result.error), done };
    }
    done.push(step);
  }
  return { ok: true, done };
}

/** The reporting line the form should treat as saved after a save that stopped part way. */
export function reportsToBaseline(initial: string | null, outcome: SaveOutcome, savedManagerId: string | null): string | null {
  return outcome.done.includes('reports_to') ? savedManagerId : initial;
}

export function saveFailure(step: 'reports_to' | 'entitlements', reason: string): string {
  return step === 'reports_to'
    ? REPORTS_TO_SAVED_NOT_LINE(reason)
    : `The employee was saved, but an entitlement was not: ${reason}`;
}

/** What the form holds: every field as the text or choice on screen. `''` means empty. */
export type EmployeeFormValues = {
  name: string;
  employee_no: string;
  work_email: string;
  department_id: string;
  designation: string;
  employment_type: EmploymentType;
  join_date: string;
  status: EmployeeStatus;
  nric: string;
  date_of_birth: string;
  phone: string;
  address: string;
  /** In ringgit, as typed. */
  base_salary: string;
  bank_name: string;
  bank_account: string;
  epf_no: string;
  socso_no: string;
  tax_no: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
};

export const PRIVATE_TEXT_FIELDS = [
  'nric',
  'phone',
  'address',
  'bank_name',
  'bank_account',
  'epf_no',
  'socso_no',
  'tax_no',
  'emergency_contact_name',
  'emergency_contact_phone',
] as const;

export function employeeFormValues(employee: Employee | null, priv: EmployeePrivate | null): EmployeeFormValues {
  return {
    name: employee?.name ?? '',
    employee_no: employee?.employee_no ?? '',
    work_email: employee?.work_email ?? '',
    department_id: employee?.department_id ?? '',
    designation: employee?.designation ?? '',
    employment_type: employee?.employment_type ?? 'full_time',
    join_date: employee?.join_date ?? '',
    status: employee?.status ?? 'active',
    nric: priv?.nric ?? '',
    date_of_birth: priv?.date_of_birth ?? '',
    phone: priv?.phone ?? '',
    address: priv?.address ?? '',
    base_salary: priv?.base_salary_cents == null ? '' : String(priv.base_salary_cents / 100),
    bank_name: priv?.bank_name ?? '',
    bank_account: priv?.bank_account ?? '',
    epf_no: priv?.epf_no ?? '',
    socso_no: priv?.socso_no ?? '',
    tax_no: priv?.tax_no ?? '',
    emergency_contact_name: priv?.emergency_contact_name ?? '',
    emergency_contact_phone: priv?.emergency_contact_phone ?? '',
  };
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/**
 * The form as the input `createEmployee` and `updateEmployee` take. An emptied
 * field is sent as null, which clears it. With `includePrivate` false the
 * private details are not sent at all, so they stay as they are.
 */
export function toEmployeeInput(
  values: EmployeeFormValues,
  options: { includePrivate: boolean },
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  if (!values.name.trim()) return { ok: false, error: 'Give the employee a name.' };

  const input: Record<string, unknown> = {
    name: values.name.trim(),
    work_email: orNull(values.work_email),
    department_id: orNull(values.department_id),
    designation: orNull(values.designation),
    employment_type: values.employment_type,
    join_date: orNull(values.join_date),
    status: values.status,
  };
  // Left out when blank: a new employee is then given the next number, and an edit keeps the one it has.
  if (values.employee_no.trim()) input.employee_no = values.employee_no.trim();

  if (options.includePrivate) {
    let salary: number | null = null;
    if (values.base_salary.trim()) {
      salary = Number(values.base_salary.trim().replace(/,/g, ''));
      if (!Number.isFinite(salary) || salary < 0) return { ok: false, error: 'Salary must be a number, such as 3500.' };
    }
    const priv: Record<string, unknown> = { base_salary: salary, date_of_birth: orNull(values.date_of_birth) };
    for (const key of PRIVATE_TEXT_FIELDS) priv[key] = orNull(values[key]);
    input.private = priv;
  }
  return { ok: true, input };
}

/** Members this employee can be linked to: those linked to nobody, and the one they already have. */
export function linkableMembers(
  members: WorkspaceMember[],
  employees: Employee[],
  employee: Employee,
): WorkspaceMember[] {
  const taken = new Set(
    employees.filter((other) => other.id !== employee.id && other.user_id !== null).map((other) => other.user_id),
  );
  return members.filter((member) => !taken.has(member.userId));
}

/**
 * The member an unlinked employee most likely is: the linkable one whose sign-in email is the record's work email.
 * Only a suggestion for an owner or admin to accept; nothing links the two without them.
 */
export function suggestedMember(
  members: WorkspaceMember[],
  employees: Employee[],
  employee: Employee,
): WorkspaceMember | null {
  const workEmail = employee.work_email?.trim().toLowerCase();
  if (employee.user_id !== null || !workEmail) return null;
  return (
    linkableMembers(members, employees, employee).find((member) => member.email.trim().toLowerCase() === workEmail) ??
    null
  );
}
