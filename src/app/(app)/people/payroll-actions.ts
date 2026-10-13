'use server';

import { revalidatePath } from 'next/cache';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { type CapResult, type PeopleWriteContext, WRITE_FAILED } from '@/lib/people/capabilities';
import { PEOPLE_PATHS } from '@/lib/people/paths';
import {
  deletePayrollRun,
  deletePayslipLine,
  markPayrollPaid,
  recalculatePayroll,
  removePayslip,
  runPayroll,
  savePayslipLine,
  setPayslipStatutory,
  unmarkPayrollPaid,
} from '@/lib/people/payroll-writes';
import { getPeopleViewer } from '@/lib/people/viewer';
import { createClient } from '@/lib/supabase/server';

const DEMO: CapResult<never> = {
  ok: false,
  error: 'The sample company is read-only. Sign up to try payroll with your own team.',
};
const FORBIDDEN: CapResult<never> = { ok: false, error: 'Only owners and admins can do that.' };

/** Pages a payroll change shows on, whether or not the navigation lists them (Payroll, My Payslips, OT Claims). */
const EXTRA_PATHS = ['/people/payroll', '/people/my-payslips', '/people/ot-claims'];

/** What went wrong looking the viewer up: the error's name only, never its message. */
function lookupFailed(error: unknown): CapResult<never> {
  console.error('[people/payroll-actions] could not look up the viewer:', error instanceof Error ? error.name : 'error');
  return { ok: false, error: WRITE_FAILED };
}

/**
 * An owner or admin who is not in the demo. The database enforces the same; this saves a refused round trip.
 * The role is checked before anything is read.
 * The workspace is the session's, never one from the input.
 */
async function asAdmin(): Promise<{ ctx: PeopleWriteContext } | CapResult<never>> {
  const viewer = await getViewer();
  if (viewer.isDemo) return DEMO;
  // The role is known from the session: a member or viewer is refused here with no database read at all.
  if (!can(viewer.role, 'approve')) return FORBIDDEN;
  const client = await createClient();
  try {
    // A real account whose current workspace is the demo is refused too.
    const people = await getPeopleViewer(client, { orgId: viewer.orgId, role: viewer.role });
    if (people.isDemo) return DEMO;
  } catch (error) {
    return lookupFailed(error);
  }
  return { ctx: { client, orgId: viewer.orgId } };
}

const refused = (guard: { ctx: PeopleWriteContext } | CapResult<never>): guard is CapResult<never> => 'ok' in guard;

/** A change succeeded: load the pages that show it afresh. */
function changed<T>(result: CapResult<T>): CapResult<T> {
  if (result.ok) for (const path of [...PEOPLE_PATHS, ...EXTRA_PATHS]) revalidatePath(path);
  return result;
}

// Every action passes its input untouched to the write path, which validates it.

export async function runPayrollAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await runPayroll(guard.ctx, input as never));
}

export async function recalculatePayrollAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await recalculatePayroll(guard.ctx, input as never));
}

export async function savePayslipLineAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await savePayslipLine(guard.ctx, input as never));
}

export async function deletePayslipLineAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await deletePayslipLine(guard.ctx, input as never));
}

export async function setPayslipStatutoryAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await setPayslipStatutory(guard.ctx, input as never));
}

export async function removePayslipAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await removePayslip(guard.ctx, input as never));
}

export async function deletePayrollRunAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await deletePayrollRun(guard.ctx, input as never));
}

export async function markPayrollPaidAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await markPayrollPaid(guard.ctx, input as never));
}

export async function unmarkPayrollPaidAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await unmarkPayrollPaid(guard.ctx, input as never));
}
