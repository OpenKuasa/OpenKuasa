'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { type CapResult, type PeopleWriteContext, WRITE_FAILED } from '@/lib/people/capabilities';
import { todayInMalaysia } from '@/lib/people/dates';
import {
  applyLeave,
  applyTimeOff,
  cancelLeave,
  cancelTimeOff,
  decideLeave,
  decideTimeOff,
  previewLeave,
  setLeaveEntitlement,
} from '@/lib/people/leave';
import { PEOPLE_PATHS } from '@/lib/people/paths';
import { getPeopleViewer } from '@/lib/people/viewer';
import { createClient } from '@/lib/supabase/server';

const DEMO: CapResult<never> = { ok: false, error: 'The sample company is read-only. Sign up to try leave with your own team.' };
const NOT_LINKED: CapResult<never> = { ok: false, error: "Your account isn't linked to an employee record yet." };
const FORBIDDEN: CapResult<never> = { ok: false, error: 'Only owners and admins can do that.' };

type Guarded = { ctx: PeopleWriteContext; employeeId: string | null };

/**
 * Any signed-in member who is not a demo visitor, whatever their role: the
 * database decides what each may do, and lets a linked member (a viewer too)
 * apply for and cancel their own leave. With `needsEmployee` the member's
 * linked employee is looked up here, never taken from the caller.
 */
async function asMember(needsEmployee: boolean): Promise<Guarded | CapResult<never>> {
  const viewer = await getViewer();
  if (viewer.isDemo) return DEMO;
  const client = await createClient();
  const ctx: PeopleWriteContext = { client, orgId: viewer.orgId };
  try {
    // A real account whose current workspace is the demo is refused too.
    const people = await getPeopleViewer(client, { orgId: viewer.orgId, role: viewer.role });
    if (people.isDemo) return DEMO;
    if (!needsEmployee) return { ctx, employeeId: null };
    if (!people.employeeId) return NOT_LINKED;
    return { ctx, employeeId: people.employeeId };
  } catch (error) {
    console.error('[people/leave-actions] could not look up the viewer:', error instanceof Error ? error.name : 'error');
    return { ok: false, error: WRITE_FAILED };
  }
}

/** An owner or admin who is not in the demo. The database enforces the same; this saves a refused round trip. */
async function asAdmin(): Promise<Guarded | CapResult<never>> {
  const viewer = await getViewer();
  if (viewer.isDemo) return DEMO;
  const client = await createClient();
  try {
    const people = await getPeopleViewer(client, { orgId: viewer.orgId, role: viewer.role });
    if (people.isDemo) return DEMO;
  } catch (error) {
    console.error('[people/leave-actions] could not look up the viewer:', error instanceof Error ? error.name : 'error');
    return { ok: false, error: WRITE_FAILED };
  }
  if (!can(viewer.role, 'approve')) return FORBIDDEN;
  return { ctx: { client, orgId: viewer.orgId }, employeeId: null };
}

const refused = (guard: Guarded | CapResult<never>): guard is CapResult<never> => 'ok' in guard;

/** A change succeeded: load the pages that show it afresh. */
function changed<T>(result: CapResult<T>): CapResult<T> {
  if (result.ok) for (const path of PEOPLE_PATHS) revalidatePath(path);
  return result;
}

/** The input without any `employee_id` the caller sent, which the member's own actions never take from it. */
function withoutEmployee(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const rest = { ...(input as Record<string, unknown>) };
  delete rest.employee_id;
  return rest;
}

// ---- A member's own leave ------------------------------------------------------------

export async function previewOwnLeaveAction(input: unknown) {
  const guard = await asMember(true);
  if (refused(guard)) return guard;
  return previewLeave(guard.ctx, { ...withoutEmployee(input), employee_id: guard.employeeId! } as never);
}

export async function applyOwnLeaveAction(input: unknown) {
  const guard = await asMember(true);
  if (refused(guard)) return guard;
  return changed(await applyLeave(guard.ctx, { ...withoutEmployee(input), employee_id: guard.employeeId! } as never));
}

export async function applyOwnTimeOffAction(input: unknown) {
  const guard = await asMember(true);
  if (refused(guard)) return guard;
  return changed(await applyTimeOff(guard.ctx, { ...withoutEmployee(input), employee_id: guard.employeeId! } as never));
}

// Cancelling names a request, not an employee, so it needs no linked record: an owner or admin
// without one can still cancel anyone's. The database lets a member cancel only their own.
export async function cancelLeaveAction(input: unknown) {
  const guard = await asMember(false);
  if (refused(guard)) return guard;
  return changed(await cancelLeave(guard.ctx, input as never));
}

export async function cancelTimeOffAction(input: unknown) {
  const guard = await asMember(false);
  if (refused(guard)) return guard;
  return changed(await cancelTimeOff(guard.ctx, input as never));
}

// ---- Owner or admin ---------------------------------------------------------------------

export async function previewLeaveForAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return previewLeave(guard.ctx, input as never);
}

export async function applyLeaveForAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await applyLeave(guard.ctx, input as never));
}

export async function decideLeaveAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await decideLeave(guard.ctx, input as never));
}

export async function decideTimeOffAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await decideTimeOff(guard.ctx, input as never));
}

export async function setLeaveEntitlementAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await setLeaveEntitlement(guard.ctx, input as never));
}

const employeeOnly = z.object({ employee_id: z.guid() });

/** This year's balances for one employee, for the entitlement editor. Reads only. */
export async function loadLeaveEntitlementsAction(
  input: unknown,
): Promise<CapResult<{ leave_type: string; year: number; entitled_days: number; used_days: number }[]>> {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  const parsed = employeeOnly.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That input was not valid.' };
  const year = Number(todayInMalaysia(new Date()).slice(0, 4));
  const { data, error } = await guard.ctx.client
    .from('hr_leave_balances')
    .select('leave_type,year,entitled_days,used_days')
    .eq('org_id', guard.ctx.orgId)
    .eq('employee_id', parsed.data.employee_id)
    .eq('year', year);
  if (error) {
    console.error('[people/leave-actions] could not read the entitlements:', error.code ?? 'no-code', error.message);
    return { ok: false, error: 'Could not load the entitlements. Please try again.' };
  }
  const rows = (data ?? []) as { leave_type: string; year: number; entitled_days: number | string; used_days: number | string }[];
  return {
    ok: true,
    data: rows.map((row) => ({
      leave_type: row.leave_type,
      year: Number(row.year),
      entitled_days: Number(row.entitled_days),
      used_days: Number(row.used_days),
    })),
  };
}
