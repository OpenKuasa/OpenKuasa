'use server';

import { revalidatePath } from 'next/cache';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import {
  clockIn,
  clockOut,
  correctAttendance,
  deleteHoliday,
  saveAttendanceSettings,
  saveHoliday,
} from '@/lib/people/attendance-writes';
import { type CapResult, type PeopleWriteContext, WRITE_FAILED } from '@/lib/people/capabilities';
import { PEOPLE_PATHS } from '@/lib/people/paths';
import { getPeopleViewer } from '@/lib/people/viewer';
import { createClient } from '@/lib/supabase/server';

const DEMO: CapResult<never> = {
  ok: false,
  error: 'The sample company is read-only. Sign up to try attendance with your own team.',
};
const NOT_LINKED: CapResult<never> = { ok: false, error: "Your account isn't linked to an employee record yet." };
const FORBIDDEN: CapResult<never> = { ok: false, error: 'Only owners and admins can do that.' };

/** Pages outside {@link PEOPLE_PATHS} (they show no employee data) that a holiday or a setting changes. */
const EXTRA_PATHS = ['/people/public-holidays', '/people/calendar', '/people/settings'];

type Guarded = { ctx: PeopleWriteContext; employeeId: string | null };

/** What went wrong looking the viewer up: the error's name only, never its message. */
function lookupFailed(error: unknown): CapResult<never> {
  console.error('[people/attendance-actions] could not look up the viewer:', error instanceof Error ? error.name : 'error');
  return { ok: false, error: WRITE_FAILED };
}

/**
 * Anyone linked to an employee record who is not in the demo, whatever their role: only ever for themselves.
 * The employee is looked up here from the signed-in user, never taken from the caller.
 */
async function asLinkedEmployee(): Promise<Guarded | CapResult<never>> {
  const viewer = await getViewer();
  if (viewer.isDemo) return DEMO;
  const client = await createClient();
  try {
    // A real account whose current workspace is the demo is refused too.
    const people = await getPeopleViewer(client, { orgId: viewer.orgId, role: viewer.role });
    if (people.isDemo) return DEMO;
    if (!people.employeeId) return NOT_LINKED;
    return { ctx: { client, orgId: viewer.orgId }, employeeId: people.employeeId };
  } catch (error) {
    return lookupFailed(error);
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
    return lookupFailed(error);
  }
  if (!can(viewer.role, 'approve')) return FORBIDDEN;
  return { ctx: { client, orgId: viewer.orgId }, employeeId: null };
}

const refused = (guard: Guarded | CapResult<never>): guard is CapResult<never> => 'ok' in guard;

/** A change succeeded: load the pages that show it afresh. */
function changed<T>(result: CapResult<T>): CapResult<T> {
  if (result.ok) for (const path of [...PEOPLE_PATHS, ...EXTRA_PATHS]) revalidatePath(path);
  return result;
}

// ---- The viewer's own clock ----------------------------------------------------------------
// These take no input at all: the employee is the viewer's own, and the database fixes the day and the time.

export async function clockInAction() {
  const guard = await asLinkedEmployee();
  if (refused(guard)) return guard;
  return changed(await clockIn(guard.ctx, { employee_id: guard.employeeId! }));
}

export async function clockOutAction() {
  const guard = await asLinkedEmployee();
  if (refused(guard)) return guard;
  return changed(await clockOut(guard.ctx, { employee_id: guard.employeeId! }));
}

// ---- Owner or admin ---------------------------------------------------------------------------

export async function correctAttendanceAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await correctAttendance(guard.ctx, input as never));
}

export async function saveHolidayAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await saveHoliday(guard.ctx, input as never));
}

export async function deleteHolidayAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await deleteHoliday(guard.ctx, input as never));
}

export async function saveAttendanceSettingsAction(input: unknown) {
  const guard = await asAdmin();
  if (refused(guard)) return guard;
  return changed(await saveAttendanceSettings(guard.ctx, input as never));
}
