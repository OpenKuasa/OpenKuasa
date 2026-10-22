'use server';

import { revalidatePath } from 'next/cache';
import { getViewer } from '@/lib/auth/viewer';
import { type CapResult, type PeopleWriteContext, WRITE_FAILED } from '@/lib/people/capabilities';
import { PEOPLE_PATHS } from '@/lib/people/paths';
import { cancelShiftSwap, decideShiftSwap, replyShiftSwap, requestShiftSwap } from '@/lib/people/swap-writes';
import { mayDecideRequests } from '@/lib/people/tier';
import type { PeopleViewer } from '@/lib/people/types';
import { getPeopleViewer } from '@/lib/people/viewer';
import { createClient } from '@/lib/supabase/server';

const DEMO: CapResult<never> = {
  ok: false,
  error: 'The sample company is read-only. Sign up to try shift swaps with your own team.',
};
const NOT_LINKED: CapResult<never> = { ok: false, error: "Your account isn't linked to an employee record yet." };
const DECIDE_FORBIDDEN: CapResult<never> = { ok: false, error: 'Only owners, admins and a manager of both people can decide a shift swap.' };

type Guard = { ctx: PeopleWriteContext; people: PeopleViewer };

/** The signed-in person outside the demo, with their workspace and Lekiu standing. */
async function signedIn(): Promise<Guard | CapResult<never>> {
  const viewer = await getViewer();
  if (viewer.isDemo) return DEMO;
  const client = await createClient();
  try {
    // A real account whose current workspace is the demo is refused too.
    const people = await getPeopleViewer(client, { orgId: viewer.orgId, role: viewer.role });
    if (people.isDemo) return DEMO;
    return { ctx: { client, orgId: viewer.orgId }, people };
  } catch (error) {
    console.error('[people/swap-actions] could not look up the viewer:', error instanceof Error ? error.name : 'error');
    return { ok: false, error: WRITE_FAILED };
  }
}

/** One of the two people in a swap: anyone linked to an employee record. The database checks which swap is theirs. */
async function asLinked(): Promise<Guard | CapResult<never>> {
  const guard = await signedIn();
  if ('ok' in guard) return guard;
  return guard.people.employeeId ? guard : NOT_LINKED;
}

/** An owner, an admin or a manager. Whether they may decide THIS swap is the database's call. */
async function asDecider(): Promise<Guard | CapResult<never>> {
  const guard = await signedIn();
  if ('ok' in guard) return guard;
  return mayDecideRequests(guard.people) ? guard : DECIDE_FORBIDDEN;
}

/** A step succeeded: load the pages that show swaps or the roster afresh. */
function changed<T>(result: CapResult<T>): CapResult<T> {
  if (result.ok) for (const path of PEOPLE_PATHS) revalidatePath(path);
  return result;
}

export async function requestShiftSwapAction(input: unknown) {
  const guard = await asLinked();
  if ('ok' in guard) return guard;
  return changed(await requestShiftSwap(guard.ctx, input as never));
}

export async function replyShiftSwapAction(input: unknown) {
  const guard = await asLinked();
  if ('ok' in guard) return guard;
  return changed(await replyShiftSwap(guard.ctx, input as never));
}

export async function cancelShiftSwapAction(input: unknown) {
  const guard = await asLinked();
  if ('ok' in guard) return guard;
  return changed(await cancelShiftSwap(guard.ctx, input as never));
}

export async function decideShiftSwapAction(input: unknown) {
  const guard = await asDecider();
  if ('ok' in guard) return guard;
  return changed(await decideShiftSwap(guard.ctx, input as never));
}
