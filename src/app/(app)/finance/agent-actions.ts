'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { financeAgent } from '@/lib/agents/finance-agent';
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
import { FINANCE_FOCUS, RunInProgressError } from '@/lib/agents/types';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { deleteAgentNote } from '@/lib/finance/agent/notes';
import { FINANCE_FOCUS_SPEC } from '@/lib/finance/agent/settings';
import type { CapResult, ReachWriteContext } from '@/lib/reach/capabilities';
import { setWorkspaceCaps, setWorkspaceCapsInput, syncCadenceSchedule } from '@/lib/reach/schedule-capabilities';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';

const AGENTS_PATH = '/finance/agents';
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' } as const;
const INVALID = { ok: false, error: 'That input was not valid.' } as const;

const cadenceInput = setAgentCadenceInput.shape.cadence;
const capsInput = z.object({
  max_cost_cents: setAgentCapInput.shape.max_cost_cents,
  daily_cap_cents: setWorkspaceCapsInput.shape.daily_cap_cents,
  weekly_cap_cents: setWorkspaceCapsInput.shape.weekly_cap_cents,
});
const noteId = z.string().uuid();

type AdminCtx = ReachWriteContext & { userId: string };

/** Owner/admin only: these decide how much of the workspace's AI key is spent. */
async function adminCtx(): Promise<AdminCtx | null> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'manage-agents')) return null;
  return { client: await createClient(), orgId: viewer.orgId, userId: viewer.userId };
}

export async function saveFinanceFocusAction(text: unknown): Promise<SaveFocusResult> {
  const ctx = await adminCtx();
  if (!ctx) return FORBIDDEN;
  if (typeof text !== 'string') return INVALID;
  const result = await saveFocus({ client: ctx.client, service: serviceClient(), orgId: ctx.orgId }, FINANCE_FOCUS_SPEC, text);
  // Revalidate even on a refusal after the model call: the spend shows on the screen.
  revalidatePath(AGENTS_PATH);
  return result;
}

export async function confirmFinanceFocusAction(): Promise<CapResult<null>> {
  const ctx = await adminCtx();
  if (!ctx) return FORBIDDEN;
  const result = await confirmFocus(ctx.client, ctx.orgId, FINANCE_FOCUS_SPEC);
  if (result.ok) revalidatePath(AGENTS_PATH);
  return result;
}

export async function setFinanceCadenceAction(cadence: unknown): Promise<CapResult<null>> {
  const ctx = await adminCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = cadenceInput.safeParse(cadence);
  if (!parsed.success) return INVALID;
  const value = parsed.data;

  const ensured = await ensureAgentConfig(ctx.client, ctx.orgId, FINANCE_FOCUS_SPEC);
  if (!ensured.ok) return ensured;
  const cad = await setAgentCadence(ctx, { agent_key: FINANCE_FOCUS, cadence: value });
  if (!cad.ok) return cad;
  const enabled = await setAgentEnabled(ctx, { agent_key: FINANCE_FOCUS, enabled: value !== 'off' });
  if (!enabled.ok) return enabled;
  const synced = await syncCadenceSchedule(ctx, value, {
    agentKey: FINANCE_FOCUS,
    firstRunAt: value === 'off' ? undefined : (n) => nextKlSeven(n, value),
  });
  if (!synced.ok) return synced;
  revalidatePath(AGENTS_PATH);
  return { ok: true, data: null };
}

export async function setFinanceCapsAction(input: unknown): Promise<CapResult<null>> {
  const ctx = await adminCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = capsInput.safeParse(input);
  if (!parsed.success) return INVALID;

  const ensured = await ensureAgentConfig(ctx.client, ctx.orgId, FINANCE_FOCUS_SPEC);
  if (!ensured.ok) return ensured;
  const cap = await setAgentCap(ctx, { agent_key: FINANCE_FOCUS, max_cost_cents: parsed.data.max_cost_cents });
  if (!cap.ok) return cap;
  const caps = await setWorkspaceCaps(ctx, {
    agent_key: FINANCE_FOCUS,
    daily_cap_cents: parsed.data.daily_cap_cents,
    weekly_cap_cents: parsed.data.weekly_cap_cents,
  });
  if (!caps.ok) return caps;
  revalidatePath(AGENTS_PATH);
  return { ok: true, data: null };
}

/**
 * Manual "Run now". Anyone who may edit data can press it: it passes the same start gate as a
 * scheduled run, stops at the per-run cap, and a workspace has one run in progress at a time.
 * The org comes from the viewer, never from input.
 */
export async function runFinanceAgentNowAction(): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'edit-data')) return FORBIDDEN;
  const orgId = viewer.orgId;
  const service = serviceClient();
  try {
    await reapStaleRuns(service, orgId);
    const refusal = await startRefusal(service, orgId, FINANCE_FOCUS);
    if (refusal) return { ok: false, error: START_REFUSED[refusal] };
    if (!(await hasConfirmedFocus(service, orgId, FINANCE_FOCUS))) {
      return { ok: false, error: 'Save and confirm a focus first.' };
    }
    const result = await runAgent(service, orgId, 'manual', financeAgent);
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

/** Deletes one agent note. Anyone who edits the workspace's data may; the database checks it again. */
export async function deleteFinanceAgentNoteAction(id: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'edit-data')) return FORBIDDEN;
  const parsed = noteId.safeParse(id);
  if (!parsed.success) return INVALID;
  const result = await deleteAgentNote({ client: await createClient(), orgId: viewer.orgId }, parsed.data);
  if (!result.ok) return result;
  revalidatePath(AGENTS_PATH);
  return { ok: true };
}
