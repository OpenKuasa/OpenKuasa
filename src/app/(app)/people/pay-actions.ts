'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { type CapResult, type PeopleWriteContext, WRITE_FAILED } from '@/lib/people/capabilities';
import {
  cancelClaim,
  cancelOvertime,
  decideClaim,
  decideOvertime,
  markClaimPaid,
  previewOvertime,
  requestIdInput,
  submitClaim,
  submitOvertime,
  unmarkClaimPaid,
} from '@/lib/people/pay-requests';
import { PEOPLE_PATHS } from '@/lib/people/paths';
import { RECEIPT_BUCKET } from '@/lib/people/receipts';
import { DECIDE_FORBIDDEN } from '@/lib/people/reporting-refusals';
import { mayDecideRequests } from '@/lib/people/tier';
import type { PeopleViewer } from '@/lib/people/types';
import { isReceiptPath, releaseReceipt, removeReceipt } from '@/lib/people/receipts-server';
import { createSupabasePeopleData } from '@/lib/people/supabase';
import { getPeopleViewer } from '@/lib/people/viewer';
import { createClient } from '@/lib/supabase/server';

const DEMO: CapResult<never> = {
  ok: false,
  error: 'The sample company is read-only. Sign up to try claims and overtime with your own team.',
};
const NOT_LINKED: CapResult<never> = { ok: false, error: "Your account isn't linked to an employee record yet." };
const FORBIDDEN: CapResult<never> = { ok: false, error: 'Only owners and admins can do that.' };
const NOT_FOUND: CapResult<never> = { ok: false, error: 'That request was not found.' };
const RECEIPT_UNAVAILABLE: CapResult<never> = { ok: false, error: 'The receipt could not be opened. Please try again.' };

/** How long a link to a receipt works. */
const RECEIPT_LINK_SECONDS = 60;

type Guarded = { ctx: PeopleWriteContext; employeeId: string | null };

/**
 * Any signed-in member who is not a demo visitor, whatever their role: the
 * database decides what each may do, and lets a linked member (a viewer too)
 * submit and cancel their own claims and overtime. With `needsEmployee` the
 * member's linked employee is looked up here, never taken from the caller.
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
    console.error('[people/pay-actions] could not look up the viewer:', error instanceof Error ? error.name : 'error');
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
    console.error('[people/pay-actions] could not look up the viewer:', error instanceof Error ? error.name : 'error');
    return { ok: false, error: WRITE_FAILED };
  }
  if (!can(viewer.role, 'approve')) return FORBIDDEN;
  return { ctx: { client, orgId: viewer.orgId }, employeeId: null };
}

/**
 * The decide actions only: an owner or admin, or someone who manages a team, outside the demo. Whether this
 * caller may decide THIS request is the database's call (the request's own manager, or HR); this saves a refused
 * round trip for everyone else.
 */
async function asDecider(): Promise<Guarded | CapResult<never>> {
  const viewer = await getViewer();
  if (viewer.isDemo) return DEMO;
  const client = await createClient();
  let people: PeopleViewer;
  try {
    people = await getPeopleViewer(client, { orgId: viewer.orgId, role: viewer.role });
  } catch (error) {
    console.error('[people/pay-actions] could not look up the viewer:', error instanceof Error ? error.name : 'error');
    return { ok: false, error: WRITE_FAILED };
  }
  if (people.isDemo) return DEMO;
  if (!mayDecideRequests(people)) return { ok: false, error: DECIDE_FORBIDDEN };
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

// ---- A member's own claims and overtime -------------------------------------------------

export async function submitOwnClaimAction(input: unknown) {
  const guard = await asMember(true);
  if (refused(guard)) return guard;
  return changed(await submitClaim(guard.ctx, { ...withoutEmployee(input), employee_id: guard.employeeId! } as never));
}

export async function submitOwnOvertimeAction(input: unknown) {
  const guard = await asMember(true);
  if (refused(guard)) return guard;
  return changed(await submitOvertime(guard.ctx, { ...withoutEmployee(input), employee_id: guard.employeeId! } as never));
}

export async function previewOwnOvertimeAction(input: unknown) {
  const guard = await asMember(true);
  if (refused(guard)) return guard;
  return previewOvertime(guard.ctx, { ...withoutEmployee(input), employee_id: guard.employeeId! } as never);
}

// Cancelling names a request, not an employee, so it needs no linked record: an owner or admin
// without one can still cancel anyone's. The database lets a member cancel only their own.
export async function cancelClaimAction(input: unknown) {
  const guard = await asMember(false);
  if (refused(guard)) return guard;
  const result = await cancelClaim(guard.ctx, input as never);
  if (!result.ok) return result;
  // The claim no longer points at its file; removing it is best effort and changes nothing the caller sees.
  if (result.data.removed_receipt_path) await removeReceipt(result.data.removed_receipt_path);
  // The path begins with a user id, so it stays on the server.
  return changed({ ok: true as const, data: { id: result.data.id, status: result.data.status } });
}

export async function cancelOvertimeAction(input: unknown) {
  const guard = await asMember(false);
  if (refused(guard)) return guard;
  return changed(await cancelOvertime(guard.ctx, input as never));
}

/**
 * A 60-second link to a claim's receipt. The claim is read through the people
 * provider first, so the row rule applies here as well as in storage, whose own
 * read rule decides when the link is made as the signed-in user.
 */
export async function claimReceiptUrlAction(input: unknown): Promise<CapResult<{ url: string }>> {
  const guard = await asMember(false);
  if (refused(guard)) return guard;
  const parsed = requestIdInput.safeParse(input);
  if (!parsed.success) return NOT_FOUND;
  const { client, orgId } = guard.ctx;
  let path: string | null;
  try {
    const claims = await createSupabasePeopleData(client, orgId).listClaims();
    path = claims.find((claim) => claim.id === parsed.data.id)?.receipt_path ?? null;
  } catch (error) {
    console.error('[people/pay-actions] could not read the claim:', error instanceof Error ? error.name : 'error');
    return { ok: false, error: WRITE_FAILED };
  }
  if (!path) return NOT_FOUND;
  try {
    const { data, error } = await client.storage.from(RECEIPT_BUCKET).createSignedUrl(path, RECEIPT_LINK_SECONDS);
    if (!error && data?.signedUrl) return { ok: true, data: { url: data.signedUrl } };
  } catch {
    // Reported the same way as a refused link.
  }
  console.error('[people/pay-actions] a receipt link could not be made.');
  return RECEIPT_UNAVAILABLE;
}

/**
 * Removes a receipt file the caller uploaded and no longer wants (replaced, removed, dialog closed, claim refused).
 * Cheap guards here (own folder, exact path shape); whether the file is really unused is the database's call
 * (`hr_release_receipt`), and the file is deleted only when it says yes. It answers the same way whatever happened, never says anything about the path, and never logs it.
 * (A browser closed mid-form never calls this, so that upload stays: accepted.)
 */
export async function discardReceiptAction(input: unknown): Promise<{ ok: boolean }> {
  const guard = await asMember(false);
  if (refused(guard)) return { ok: false };
  const parsed = z.object({ path: z.string().max(200) }).safeParse(input);
  if (!parsed.success) return { ok: false };
  const { path } = parsed.data;
  const viewer = await getViewer();
  if (path.split('/')[0] !== viewer.userId || !isReceiptPath(path)) return { ok: false };
  // The database decides, atomically and across workspaces; the file goes only on an exact `true`.
  if (!(await releaseReceipt(guard.ctx, path))) return { ok: false };
  await removeReceipt(path);
  return { ok: true };
}

// ---- Owner or admin ---------------------------------------------------------------------

export async function submitClaimForAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await submitClaim(guard.ctx, input as never));
}

export async function submitOvertimeForAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await submitOvertime(guard.ctx, input as never));
}

export async function previewOvertimeForAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return previewOvertime(guard.ctx, input as never);
}

export async function decideClaimAction(input: unknown) {
  const guard = await asDecider();
  if (refused(guard)) return guard;
  return changed(await decideClaim(guard.ctx, input as never));
}

export async function decideOvertimeAction(input: unknown) {
  const guard = await asDecider();
  if (refused(guard)) return guard;
  return changed(await decideOvertime(guard.ctx, input as never));
}

export async function markClaimPaidAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await markClaimPaid(guard.ctx, input as never));
}

export async function unmarkClaimPaidAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await unmarkClaimPaid(guard.ctx, input as never));
}
