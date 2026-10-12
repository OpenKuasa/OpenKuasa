/**
 * The single write path for Lekiu's HR data. Each change is one Zod schema and
 * one function. The Employees screen's server actions parse with the schema
 * and Lekiu's change tools use it as their `inputSchema`, so the two cannot
 * drift apart. `org_id` always comes from the {@link PeopleWriteContext} (the
 * caller's session), never from the input.
 *
 * The database allows these writes for an owner or admin only, and grants
 * UPDATE per column: an update must never carry `id`, `org_id`, `created_at`
 * or `updated_at`. When a write by an owner is refused, check their second
 * factor first: the write policy includes `mfa_ok()`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { PAYROLL_REFUSALS } from './payroll-refusals';
import type { Department } from './types';

export type PeopleWriteContext = { client: SupabaseClient; orgId: string };
export type CapResult<T> = { ok: true; data: T } | { ok: false; error: string };
export type Refusal = { ok: false; error: string };

export const WRITE_FAILED = 'That change could not be saved. Please try again.';

/**
 * What a write answered. `unknown` is the generic {@link WRITE_FAILED} sentence: the database error, a lost
 * network call or an unmapped failure, so the change may or may not have been saved. Any other refusal is a
 * sentence the rules produced and is definite. A form with something to undo on refusal (a receipt upload)
 * must undo only on `refused`.
 */
export function writeOutcome(result: CapResult<unknown>): 'saved' | 'refused' | 'unknown' {
  if (result.ok) return 'saved';
  return result.error === WRITE_FAILED ? 'unknown' : 'refused';
}

type DbError = { code?: string; message?: string } | null | undefined;

export const refuse = (error: string): Refusal => ({ ok: false, error });

/**
 * Logs the database's code and message, and nothing of what was typed: an
 * employee change can carry an NRIC, a bank account or a salary.
 */
export function writeFailed(fn: string, error: DbError): Refusal {
  console.error(`[people-capability] ${fn} failed:`, error?.code ?? 'no-code', error?.message ?? 'no row came back');
  return refuse(WRITE_FAILED);
}

/** True for a Postgres error of this code, optionally only when its message names `needle`. */
export const violates = (error: DbError, code: string, needle?: string): boolean =>
  error?.code === code && (!needle || (error.message ?? '').includes(needle));

/** Checks an input against its schema, so a bad one is refused in words rather than thrown. */
function parseInput<S extends z.ZodType>(schema: S, input: unknown): CapResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return refuse(parsed.error.issues[0]?.message ?? 'That input was not valid.');
}

const UNIQUE = '23505';
const FOREIGN_KEY = '23503';

// Any Postgres uuid: `.uuid()` would refuse ids that are valid but not RFC-versioned (such as the demo's md5-made ones).
const id = z.guid();

// ---- Departments ------------------------------------------------------------

const DEPARTMENT_COLUMNS = 'id,name,created_at';
const departmentName = z
  .string()
  .trim()
  .min(1, 'Give the department a name.')
  .max(80, 'Keep the department name to 80 characters.');

export const createDepartmentInput = z.object({ name: departmentName });
export const updateDepartmentInput = z.object({
  id: id.describe('The department, by its id from listDepartments.'),
  name: departmentName,
});
export const deleteDepartmentInput = z.object({
  id: id.describe('The department, by its id from listDepartments.'),
});

const NAME_TAKEN = 'A department with that name already exists.';
const DEPARTMENT_MISSING = 'That department was not found.';

export async function createDepartment(
  ctx: PeopleWriteContext,
  input: z.infer<typeof createDepartmentInput>,
): Promise<CapResult<Department>> {
  const parsed = parseInput(createDepartmentInput, input);
  if (!parsed.ok) return parsed;
  const { name } = parsed.data;
  const { data, error } = await ctx.client
    .from('hr_departments')
    .insert({ name, org_id: ctx.orgId })
    .select(DEPARTMENT_COLUMNS)
    .single();
  if (violates(error, UNIQUE)) return refuse(NAME_TAKEN);
  if (error || !data) return writeFailed('createDepartment', error);
  return { ok: true, data: data as Department };
}

export async function updateDepartment(
  ctx: PeopleWriteContext,
  input: z.infer<typeof updateDepartmentInput>,
): Promise<CapResult<Department>> {
  const parsed = parseInput(updateDepartmentInput, input);
  if (!parsed.ok) return parsed;
  const { id: departmentId, name } = parsed.data;
  const { data, error } = await ctx.client
    .from('hr_departments')
    .update({ name })
    .eq('id', departmentId)
    .eq('org_id', ctx.orgId)
    .select(DEPARTMENT_COLUMNS)
    .maybeSingle();
  if (violates(error, UNIQUE)) return refuse(NAME_TAKEN);
  if (error) return writeFailed('updateDepartment', error);
  if (!data) return refuse(DEPARTMENT_MISSING);
  return { ok: true, data: data as Department };
}

export async function deleteDepartment(
  ctx: PeopleWriteContext,
  input: z.infer<typeof deleteDepartmentInput>,
): Promise<CapResult<{ id: string; name: string }>> {
  const parsed = parseInput(deleteDepartmentInput, input);
  if (!parsed.ok) return parsed;
  const { id: departmentId } = parsed.data;
  const { data, error } = await ctx.client
    .from('hr_departments')
    .delete()
    .eq('id', departmentId)
    .eq('org_id', ctx.orgId)
    .select('id,name')
    .maybeSingle();
  if (violates(error, FOREIGN_KEY)) {
    return refuse('That department still has employees, including inactive ones. Move them to another department first.');
  }
  if (error) return writeFailed('deleteDepartment', error);
  if (!data) return refuse(DEPARTMENT_MISSING);
  return { ok: true, data: data as { id: string; name: string } };
}

// ---- Employees --------------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SAVED_COLUMNS = 'id,name,employee_no';
const EMPLOYEE_NO_TAKEN = 'hr_employees_org_id_employee_no_key';

const EMPLOYEE_MISSING = 'That employee was not found.';

/** True for a date that exists: 2026-02-31 matches the pattern but is not a day. */
function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Free text that may be left out (unchanged) or sent empty (cleared). */
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const day = (what: string) => z.string().regex(DAY, `${what} must be YYYY-MM-DD.`).nullable().optional();

const PRIVATE_TEXT = [
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

const privateFields = z
  .object({
    nric: text(20).describe('NRIC or passport number.'),
    date_of_birth: day('Date of birth'),
    phone: text(30),
    address: text(300),
    base_salary: z
      .number()
      .min(0, 'Salary cannot be negative.')
      .max(1_000_000, 'That salary is too large.')
      .nullable()
      .optional()
      .describe('Monthly base salary in ringgit, such as 3500.'),
    bank_name: text(80),
    bank_account: text(40),
    epf_no: text(30).describe('KWSP (EPF) number.'),
    socso_no: text(30).describe('PERKESO (SOCSO) number.'),
    tax_no: text(30).describe('LHDN tax number.'),
    emergency_contact_name: text(120),
    emergency_contact_phone: text(30),
  })
  .describe('Pay and identity details. Give only what the person stated; leave the rest out.');

export type EmployeePrivateInput = z.infer<typeof privateFields>;

const directoryFields = {
  employee_no: z
    .string()
    .trim()
    .max(30)
    .optional()
    .describe('Leave out to be given the next free number, such as EMP-021.'),
  work_email: z.string().trim().max(200).nullable().optional(),
  department_id: id.nullable().optional().describe('The department, by its id from listDepartments.'),
  designation: text(120).describe('Job title, such as Sales Executive.'),
  employment_type: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
  is_manager: z.boolean().optional(),
  join_date: day('Join date'),
  status: z.enum(['active', 'inactive']).optional(),
  private: privateFields.optional(),
};

const employeeName = z.string().trim().min(1, 'Give the employee a name.').max(120);
const employeeId = id.describe('The employee, by their id from listEmployees or getEmployee.');

export const createEmployeeInput = z.object({ name: employeeName, ...directoryFields });
export const updateEmployeeInput = z.object({ id: employeeId, name: employeeName.optional(), ...directoryFields });
export const setEmployeeStatusInput = z.object({ id: employeeId, status: z.enum(['active', 'inactive']) });
export const deleteEmployeeInput = z.object({ id: employeeId });
export const linkEmployeeToMemberInput = z.object({
  id: employeeId,
  user_id: id.nullable().describe('The workspace member to link, or null to unlink.'),
});

export type SavedEmployee = { id: string; name: string; employee_no: string };

type DirectoryInput = Partial<z.infer<typeof createEmployeeInput>>;

const blankToNull = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim());

/** The `hr_employees` columns an input sets. A key appears only when the input carried it. */
function directoryValues(input: DirectoryInput): CapResult<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (input.name !== undefined) out.name = input.name;
  if (input.employee_no !== undefined && input.employee_no !== '') out.employee_no = input.employee_no;
  if (input.work_email !== undefined) {
    const email = blankToNull(input.work_email)?.toLowerCase() ?? null;
    if (email && !EMAIL.test(email)) return refuse('That work email does not look right.');
    out.work_email = email;
  }
  if (input.department_id !== undefined) out.department_id = input.department_id;
  if (input.designation !== undefined) out.designation = blankToNull(input.designation);
  if (input.employment_type !== undefined) out.employment_type = input.employment_type;
  if (input.is_manager !== undefined) out.is_manager = input.is_manager;
  if (input.join_date !== undefined) {
    if (input.join_date !== null && !isRealDay(input.join_date)) {
      return refuse('Join date must be a real date, as YYYY-MM-DD.');
    }
    out.join_date = input.join_date;
  }
  if (input.status !== undefined) out.status = input.status;
  // The birthday without its year sits on the directory row, where colleagues may see it.
  const born = input.private?.date_of_birth;
  if (born !== undefined) {
    if (born !== null && !isRealDay(born)) return refuse('Date of birth must be a real date, as YYYY-MM-DD.');
    out.date_of_birth_day = born ? Number(born.slice(8, 10)) : null;
    out.date_of_birth_month = born ? Number(born.slice(5, 7)) : null;
  }
  return { ok: true, data: out };
}

/** The `hr_employee_private` columns an input sets. A key appears only when the input carried it. */
function privateValues(input: EmployeePrivateInput | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input) return out;
  if (input.base_salary !== undefined) {
    out.base_salary_cents = input.base_salary === null ? null : Math.round(input.base_salary * 100);
  }
  for (const key of PRIVATE_TEXT) {
    const value = input[key];
    if (value !== undefined) out[key] = blankToNull(value);
  }
  if (input.date_of_birth !== undefined) out.date_of_birth = input.date_of_birth;
  return out;
}

const hasValue = (values: Record<string, unknown>) => Object.values(values).some((value) => value !== null);

function employeeFailed(fn: string, error: DbError): Refusal {
  if (violates(error, UNIQUE, EMPLOYEE_NO_TAKEN)) return refuse('Another employee already has that employee number.');
  if (violates(error, UNIQUE, 'hr_employees_org_email_idx')) return refuse('Another employee already has that work email.');
  if (violates(error, UNIQUE, 'hr_employees_org_user_idx')) return refuse('That member is already linked to another employee.');
  if (violates(error, FOREIGN_KEY)) return refuse('That department was not found.');
  return writeFailed(fn, error);
}

/**
 * The next `EMP-###` after the highest one in the workspace, or null when the numbers cannot be read.
 * One request reads at most 1,000 rows; past that the unique rule still stops a duplicate, and the
 * person is asked to try again or give a number.
 */
async function nextEmployeeNo(ctx: PeopleWriteContext): Promise<string | null> {
  const { data, error } = await ctx.client.from('hr_employees').select('employee_no').eq('org_id', ctx.orgId);
  if (error) return null;
  let highest = 0;
  for (const row of (data ?? []) as { employee_no: string }[]) {
    const match = /^EMP-(\d+)$/.exec(row.employee_no);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `EMP-${String(highest + 1).padStart(3, '0')}`;
}

export async function createEmployee(
  ctx: PeopleWriteContext,
  input: z.infer<typeof createEmployeeInput>,
): Promise<CapResult<SavedEmployee>> {
  const parsed = parseInput(createEmployeeInput, input);
  if (!parsed.ok) return parsed;
  const values = parsed.data;
  const row = directoryValues(values);
  if (!row.ok) return row;

  const assigned = row.data.employee_no === undefined;
  if (assigned) {
    const next = await nextEmployeeNo(ctx);
    if (!next) return writeFailed('createEmployee', { message: 'could not read the employee numbers' });
    row.data.employee_no = next;
  }

  const { data, error } = await ctx.client
    .from('hr_employees')
    .insert({ ...row.data, org_id: ctx.orgId })
    .select(SAVED_COLUMNS)
    .single();
  if (assigned && violates(error, UNIQUE, EMPLOYEE_NO_TAKEN)) {
    return refuse('Could not pick a free employee number. Please try again.');
  }
  if (error || !data) return employeeFailed('createEmployee', error);
  const saved = data as SavedEmployee;

  const priv = privateValues(values.private);
  if (hasValue(priv)) {
    const { error: privateError } = await ctx.client
      .from('hr_employee_private')
      .insert({ ...priv, employee_id: saved.id, org_id: ctx.orgId });
    if (privateError) {
      // Two tables, no transaction: take the employee back out so nothing is left half-made.
      const undo = await ctx.client.from('hr_employees').delete().eq('id', saved.id).eq('org_id', ctx.orgId);
      if (undo.error) writeFailed('createEmployee (rollback)', undo.error);
      return writeFailed('createEmployee (private details)', privateError);
    }
  }
  return { ok: true, data: saved };
}

export async function updateEmployee(
  ctx: PeopleWriteContext,
  input: z.infer<typeof updateEmployeeInput>,
): Promise<CapResult<SavedEmployee>> {
  const parsed = parseInput(updateEmployeeInput, input);
  if (!parsed.ok) return parsed;
  const { id: target, ...fields } = parsed.data;
  const row = directoryValues(fields);
  if (!row.ok) return row;
  const priv = privateValues(fields.private);
  const directoryChanged = Object.keys(row.data).length > 0;
  if (!directoryChanged && Object.keys(priv).length === 0) return refuse('Nothing to update.');

  const current = await ctx.client
    .from('hr_employees')
    .select(SAVED_COLUMNS)
    .eq('id', target)
    .eq('org_id', ctx.orgId)
    .maybeSingle();
  if (current.error) return writeFailed('updateEmployee', current.error);
  if (!current.data) return refuse(EMPLOYEE_MISSING);
  let saved = current.data as SavedEmployee;

  if (directoryChanged) {
    const { data, error } = await ctx.client
      .from('hr_employees')
      .update(row.data)
      .eq('id', target)
      .eq('org_id', ctx.orgId)
      .select(SAVED_COLUMNS)
      .maybeSingle();
    if (error) return employeeFailed('updateEmployee', error);
    if (!data) return refuse(EMPLOYEE_MISSING);
    saved = data as SavedEmployee;
  }

  if (Object.keys(priv).length > 0) {
    const failed = (error: DbError): Refusal => {
      writeFailed('updateEmployee (private details)', error);
      return refuse(
        directoryChanged
          ? 'The directory details were saved, but the private details were not. Please try again.'
          : WRITE_FAILED,
      );
    };
    const existing = await ctx.client
      .from('hr_employee_private')
      .select('employee_id')
      .eq('employee_id', target)
      .eq('org_id', ctx.orgId)
      .maybeSingle();
    if (existing.error) return failed(existing.error);
    // Never an upsert: its ON CONFLICT clause would set the key columns, which the column grants refuse.
    if (existing.data) {
      const { error } = await ctx.client
        .from('hr_employee_private')
        .update(priv)
        .eq('employee_id', target)
        .eq('org_id', ctx.orgId);
      if (error) return failed(error);
    } else if (hasValue(priv)) {
      const { error } = await ctx.client
        .from('hr_employee_private')
        .insert({ ...priv, employee_id: target, org_id: ctx.orgId });
      if (error) return failed(error);
    }
  }
  return { ok: true, data: saved };
}

export async function setEmployeeStatus(
  ctx: PeopleWriteContext,
  input: z.infer<typeof setEmployeeStatusInput>,
): Promise<CapResult<SavedEmployee>> {
  const parsed = parseInput(setEmployeeStatusInput, input);
  if (!parsed.ok) return parsed;
  const { id: target, status } = parsed.data;
  return updateEmployee(ctx, { id: target, status });
}

/** Deletes an employee. Their leave, claims, payslips and every other HR row go with them. */
export async function deleteEmployee(
  ctx: PeopleWriteContext,
  input: z.infer<typeof deleteEmployeeInput>,
): Promise<CapResult<{ id: string; name: string }>> {
  const parsed = parseInput(deleteEmployeeInput, input);
  if (!parsed.ok) return parsed;
  const { id: target } = parsed.data;
  const { data, error } = await ctx.client
    .from('hr_employees')
    .delete()
    .eq('id', target)
    .eq('org_id', ctx.orgId)
    .select('id,name')
    .maybeSingle();
  // A trigger refuses an employee with a paid payslip; its message is the bare code.
  if (error?.message === 'HR_EMPLOYEE_HAS_PAID_PAYSLIPS') return refuse(PAYROLL_REFUSALS.HR_EMPLOYEE_HAS_PAID_PAYSLIPS);
  if (error) return writeFailed('deleteEmployee', error);
  if (!data) return refuse(EMPLOYEE_MISSING);
  return { ok: true, data: data as { id: string; name: string } };
}

/** Links an employee record to a workspace member's account, or unlinks it with `user_id: null`. */
export async function linkEmployeeToMember(
  ctx: PeopleWriteContext,
  input: z.infer<typeof linkEmployeeToMemberInput>,
): Promise<CapResult<{ id: string; name: string; user_id: string | null }>> {
  const parsed = parseInput(linkEmployeeToMemberInput, input);
  if (!parsed.ok) return parsed;
  const { id: target, user_id } = parsed.data;
  const { data, error } = await ctx.client
    .from('hr_employees')
    .update({ user_id })
    .eq('id', target)
    .eq('org_id', ctx.orgId)
    .select('id,name,user_id')
    .maybeSingle();
  if (violates(error, UNIQUE, 'hr_employees_org_user_idx')) {
    return refuse('That member is already linked to another employee.');
  }
  // The database refuses a user who is not in this workspace (trigger), or who does not exist.
  if (violates(error, 'P0001', 'not a member of this workspace') || violates(error, FOREIGN_KEY)) {
    return refuse('That person is not a member of this workspace.');
  }
  // Only an account that has signed up and confirmed its email address can be linked (same trigger).
  if (violates(error, 'P0001', 'has not confirmed their email')) {
    return refuse('That member has not confirmed their email address yet, so their account cannot be linked.');
  }
  if (error) return writeFailed('linkEmployeeToMember', error);
  if (!data) return refuse(EMPLOYEE_MISSING);
  return { ok: true, data: data as { id: string; name: string; user_id: string | null } };
}
