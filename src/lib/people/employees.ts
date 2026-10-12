/**
 * The Employees screen's figures and its form's rules, as pure functions so
 * the server component, the client form and the tests share one version.
 */
import { daysBetween } from './dates';
import type { WorkspaceMember } from './members';
import { headcountByDepartment } from './overview';
import type { Department, Employee, EmployeePrivate, EmployeeStatus, EmploymentType } from './types';

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

export type EmployeeFilter = { query: string; departmentId: string; status: 'all' | EmployeeStatus };

/** `departmentId` is a department's id, `'all'`, or `'none'` for staff in no department. */
export function filterEmployees(employees: Employee[], filter: EmployeeFilter): Employee[] {
  const query = filter.query.trim().toLowerCase();
  return employees.filter((employee) => {
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

/** What the form holds: every field as the text or choice on screen. `''` means empty. */
export type EmployeeFormValues = {
  name: string;
  employee_no: string;
  work_email: string;
  department_id: string;
  designation: string;
  employment_type: EmploymentType;
  is_manager: boolean;
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
    is_manager: employee?.is_manager ?? false,
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
    is_manager: values.is_manager,
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
