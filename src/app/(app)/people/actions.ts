'use server';

import { revalidatePath } from 'next/cache';
import { z, type ZodType } from 'zod';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import {
  type CapResult,
  type PeopleWriteContext,
  createDepartment,
  createDepartmentInput,
  createEmployee,
  createEmployeeInput,
  deleteDepartment,
  deleteDepartmentInput,
  deleteEmployee,
  deleteEmployeeInput,
  linkEmployeeToMember,
  linkEmployeeToMemberInput,
  setEmployeeStatus,
  setEmployeeStatusInput,
  setReportsTo,
  setReportsToInput,
  updateDepartment,
  updateDepartmentInput,
  updateEmployee,
  updateEmployeeInput,
} from '@/lib/people/capabilities';
import { removeDocumentFiles } from '@/lib/people/document-files-server';
import { PEOPLE_PATHS } from '@/lib/people/paths';
import { createSupabasePeopleData } from '@/lib/people/supabase';
import type { EmployeePrivate } from '@/lib/people/types';
import { createClient } from '@/lib/supabase/server';

const FORBIDDEN: CapResult<never> = { ok: false, error: 'Only owners and admins can change HR records.' };

/**
 * The write context for an owner or admin; null for anyone else. The database
 * enforces the same rule, so this only saves a refused round trip and gives a
 * clearer message.
 */
async function writeCtx(): Promise<PeopleWriteContext | null> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'approve')) return null;
  return { client: await createClient(), orgId: viewer.orgId };
}

/** Guard, parse, change, refresh. A rejected input answers with the schema's own message. */
async function run<I, O>(
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: PeopleWriteContext, parsed: I) => Promise<CapResult<O>>,
): Promise<CapResult<O>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That input was not valid.' };
  }
  const result = await fn(ctx, parsed.data);
  if (result.ok) for (const path of PEOPLE_PATHS) revalidatePath(path);
  return result;
}

export async function createEmployeeAction(input: unknown) {
  return run(createEmployeeInput, input, createEmployee);
}
export async function updateEmployeeAction(input: unknown) {
  return run(updateEmployeeInput, input, updateEmployee);
}
export async function setReportsToAction(input: unknown) {
  return run(setReportsToInput, input, setReportsTo);
}
export async function setEmployeeStatusAction(input: unknown) {
  return run(setEmployeeStatusInput, input, setEmployeeStatus);
}
export async function deleteEmployeeAction(input: unknown) {
  // The database returns the employee's document files; they are removed here, one path at a time, after the delete.
  return run(deleteEmployeeInput, input, (ctx, parsed) => deleteEmployee(ctx, parsed, removeDocumentFiles));
}
export async function linkEmployeeToMemberAction(input: unknown) {
  return run(linkEmployeeToMemberInput, input, linkEmployeeToMember);
}
export async function createDepartmentAction(input: unknown) {
  return run(createDepartmentInput, input, createDepartment);
}
export async function updateDepartmentAction(input: unknown) {
  return run(updateDepartmentInput, input, updateDepartment);
}
export async function deleteDepartmentAction(input: unknown) {
  return run(deleteDepartmentInput, input, deleteDepartment);
}

// Any Postgres uuid, as in the capability schemas.
const privateInput = z.object({ id: z.guid() });

/**
 * One employee's pay and identity details, for the edit form. Fetched when the
 * form opens rather than sent with the page, so the directory never carries
 * anyone's salary to the browser. Null when nothing has been entered yet.
 */
export async function loadEmployeePrivateAction(input: unknown): Promise<CapResult<EmployeePrivate | null>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = privateInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That input was not valid.' };
  try {
    const data = await createSupabasePeopleData(ctx.client, ctx.orgId).getEmployeePrivate(parsed.data.id);
    return { ok: true, data };
  } catch (error) {
    console.error('[people/actions] could not read private details:', error instanceof Error ? error.message : 'error');
    return { ok: false, error: 'Could not load the private details. Please try again.' };
  }
}
