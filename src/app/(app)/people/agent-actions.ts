'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { peopleAgent } from '@/lib/agents/people-agent';
import { setAgentCadence, setAgentCap, setAgentEnabled, setAgentCadenceInput, setAgentCapInput } from '@/lib/agents/config';
import {
  START_REFUSED,
  confirmFocus,
  ensureAgentConfig,
  hasConfirmedFocus,
  nextKlSeven,
  saveFocus,
  type SaveFocusResult,
} from '@/lib/agents/focus/settings';
import { runAgent } from '@/lib/agents/run-agent';
import { reapStaleRuns, startRefusal } from '@/lib/agents/runner';
import { PEOPLE_FOCUS, RunInProgressError } from '@/lib/agents/types';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { deleteAgentNote } from '@/lib/people/agent/notes';
import { PEOPLE_FOCUS_SPEC } from '@/lib/people/agent/settings';
import type { CapResult, ReachWriteContext } from '@/lib/reach/capabilities';
import { setWorkspaceCaps, setWorkspaceCapsInput, syncCadenceSchedule } from '@/lib/reach/schedule-capabilities';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';

const AGENTS_PATH = '/people/agents';
const FORBIDDEN = { ok: false, error: 'Only HR can change this.' } as const;
const INVALID = { ok: false, error: 'That input was not valid.' } as const;

const cadenceInput = setAgentCadenceInput.shape.cadence;
const capsInput = z.object({
  max_cost_cents: setAgentCapInput.shape.max_cost_cents,
  daily_cap_cents: setWorkspaceCapsInput.shape.daily_cap_cents,
  weekly_cap_cents: setWorkspaceCapsInput.shape.weekly_cap_cents,
});
const noteId = z.string().uuid();

type AdminCtx = ReachWriteContext & { userId: string };

/**
 * HR only (owner and admin, the `approve` capability) for every action here: the agent reads
 * people's records, so its focus, spend, runs and notes are HR's alone. The org comes from the
 * viewer, never from input.
 */
async function hrCtx(): Promise<AdminCtx | null> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'approve')) return null;
  return { client: await createClient(), orgId: viewer.orgId, userId: viewer.userId };
}

export async function savePeopleFocusAction(text: unknown): Promise<SaveFocusResult> {
  const ctx = await hrCtx();
  if (!ctx) return FORBIDDEN;
  if (typeof text !== 'string') return INVALID;
  const result = await saveFocus({ client: ctx.client, service: serviceClient(), orgId: ctx.orgId }, PEOPLE_FOCUS_SPEC, text);
  // Revalidate even on a refusal after the model call: the spend shows on the screen.
  revalidatePath(AGENTS_PATH);
  return result;
}

export async function confirmPeopleFocusAction(): Promise<CapResult<null>> {
  const ctx = await hrCtx();
  if (!ctx) return FORBIDDEN;
  const result = await confirmFocus(ctx.client, ctx.orgId, PEOPLE_FOCUS_SPEC);
  if (result.ok) revalidatePath(AGENTS_PATH);
  return result;
}

export async function setPeopleCadenceAction(cadence: unknown): Promise<CapResult<null>> {
  const ctx = await hrCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = cadenceInput.safeParse(cadence);
  if (!parsed.success) return INVALID;
  const value = parsed.data;

  const ensured = await ensureAgentConfig(ctx.client, ctx.orgId, PEOPLE_FOCUS_SPEC);
  if (!ensured.ok) return ensured;
  const cad = await setAgentCadence(ctx, { agent_key: PEOPLE_FOCUS, cadence: value });
  if (!cad.ok) return cad;
  const enabled = await setAgentEnabled(ctx, { agent_key: PEOPLE_FOCUS, enabled: value !== 'off' });
  if (!enabled.ok) return enabled;
  const synced = await syncCadenceSchedule(ctx, value, {
    agentKey: PEOPLE_FOCUS,
    firstRunAt: value === 'off' ? undefined : (n) => nextKlSeven(n, value),
  });
  if (!synced.ok) return synced;
  revalidatePath(AGENTS_PATH);
  return { ok: true, data: null };
}

export async function setPeopleCapsAction(input: unknown): Promise<CapResult<null>> {
  const ctx = await hrCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = capsInput.safeParse(input);
  if (!parsed.success) return INVALID;

  const ensured = await ensureAgentConfig(ctx.client, ctx.orgId, PEOPLE_FOCUS_SPEC);
  if (!ensured.ok) return ensured;
  const cap = await setAgentCap(ctx, { agent_key: PEOPLE_FOCUS, max_cost_cents: parsed.data.max_cost_cents });
  if (!cap.ok) return cap;
  const caps = await setWorkspaceCaps(ctx, {
    agent_key: PEOPLE_FOCUS,
    daily_cap_cents: parsed.data.daily_cap_cents,
    weekly_cap_cents: parsed.data.weekly_cap_cents,
  });
  if (!caps.ok) return caps;
  revalidatePath(AGENTS_PATH);
  return { ok: true, data: null };
}

/**
 * Manual "Run now", for HR: it passes the same start gate as a scheduled run, stops at the
 * per-run cap, and a workspace has one run in progress at a time.
 */
export async function runPeopleAgentNowAction(): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const ctx = await hrCtx();
  if (!ctx) return FORBIDDEN;
  const orgId = ctx.orgId;
  const service = serviceClient();
  try {
    await reapStaleRuns(service, orgId);
    const refusal = await startRefusal(service, orgId, PEOPLE_FOCUS);
    if (refusal) return { ok: false, error: START_REFUSED[refusal] };
    if (!(await hasConfirmedFocus(service, orgId, PEOPLE_FOCUS))) {
      return { ok: false, error: 'Save and confirm a focus first.' };
    }
    const result = await runAgent(service, orgId, 'manual', peopleAgent);
    revalidatePath(AGENTS_PATH);
    return { ok: true, runId: result.runId };
  } catch (e) {
    if (e instanceof RunInProgressError) {
      return { ok: false, error: 'A run is already in progress. Please wait for it to finish.' };
    }
    // Deliberately drop the exception: it may carry request details or a key.
    return { ok: false, error: 'The run could not be started.' };
  }
}

/** Deletes one agent note. HR only; the database checks it again. */
export async function deletePeopleAgentNoteAction(id: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await hrCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = noteId.safeParse(id);
  if (!parsed.success) return INVALID;
  const result = await deleteAgentNote({ client: ctx.client, orgId: ctx.orgId }, parsed.data);
  if (!result.ok) return result;
  revalidatePath(AGENTS_PATH);
  return { ok: true };
}
