/**
 * Who may call a performance or announcement action, shared by `performance-actions.ts` and
 * `announcement-actions.ts` (a `'use server'` file may export only actions, so the guards live here).
 * The database enforces the same rules; these save a refused round trip and keep the order the plan requires:
 * the demo and the role are settled from the session before anything is read.
 */
import 'server-only';
import { revalidatePath } from 'next/cache';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { type CapResult, type PeopleWriteContext, WRITE_FAILED } from '@/lib/people/capabilities';
import { PEOPLE_PATHS } from '@/lib/people/paths';
import { getPeopleViewer } from '@/lib/people/viewer';
import { createClient } from '@/lib/supabase/server';

export const DEMO: CapResult<never> = {
  ok: false,
  error: 'The sample company is read-only. Sign up to try this with your own team.',
};
export const NOT_LINKED: CapResult<never> = { ok: false, error: "Your account isn't linked to an employee record yet." };
export const FORBIDDEN: CapResult<never> = { ok: false, error: 'Only owners and admins can do that.' };

export type Guarded = { ctx: PeopleWriteContext; employeeId: string | null };

/** The pages an announcement change shows on (the navigation badge is drawn by the same page's layout). */
export const ANNOUNCEMENT_PATHS = ['/people/announcements'];

function lookupFailed(source: string, error: unknown): CapResult<never> {
  console.error(`[people/${source}] could not look up the viewer:`, error instanceof Error ? error.name : 'error');
  return { ok: false, error: WRITE_FAILED };
}

/**
 * Any signed-in member who is not in the demo, whatever their role. With `needsEmployee` the member's linked
 * employee is looked up here, never taken from the caller, and an unlinked account is refused.
 */
export async function asMember(source: string, needsEmployee: boolean): Promise<Guarded | CapResult<never>> {
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
    return lookupFailed(source, error);
  }
}

/** An owner or admin who is not in the demo. The role comes from the session and is checked before anything is read. */
export async function asAdmin(source: string): Promise<Guarded | CapResult<never>> {
  const viewer = await getViewer();
  if (viewer.isDemo) return DEMO;
  if (!can(viewer.role, 'approve')) return FORBIDDEN;
  const client = await createClient();
  try {
    const people = await getPeopleViewer(client, { orgId: viewer.orgId, role: viewer.role });
    if (people.isDemo) return DEMO;
  } catch (error) {
    return lookupFailed(source, error);
  }
  return { ctx: { client, orgId: viewer.orgId }, employeeId: null };
}

export const refused = (guard: Guarded | CapResult<never>): guard is CapResult<never> => 'ok' in guard;

/** A change succeeded: load the pages that show it afresh. */
export function changed<T>(result: CapResult<T>, paths: string[] = PEOPLE_PATHS): CapResult<T> {
  if (result.ok) for (const path of paths) revalidatePath(path);
  return result;
}

/** The input without any `employee_id` the caller sent, which a member's own actions never take from it. */
export function withoutEmployee(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const rest = { ...(input as Record<string, unknown>) };
  delete rest.employee_id;
  return rest;
}
