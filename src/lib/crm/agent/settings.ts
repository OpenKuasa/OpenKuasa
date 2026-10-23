import type { SupabaseClient } from '@supabase/supabase-js';
import { TEXT_ESTIMATE_CENTS } from '@/lib/agents/costs';
import { interpretFocus } from '@/lib/agents/focus/interpret';
import { readBack, type FocusPlan } from '@/lib/agents/focus/plan';
import { startRefusal, type StartRefusal } from '@/lib/agents/runner';
import { CRM_FOCUS } from '@/lib/agents/types';
import { readWorkspaceKey } from '@/lib/ai/workspace-key';
import { CRM_DEFAULTS, CRM_FOCUS_MENU, CRM_MAX_FOCUS_CHARS as MAX_FOCUS_CHARS } from '@/lib/crm/agent/checks';
import type { CapResult } from '@/lib/reach/capabilities';

export { CRM_DEFAULTS };
const MAX_CHANGES_PER_DAY = 10;
const KL_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

const COULD_NOT_SAVE = 'That change could not be saved.';

/** What the person is told when the start gate refuses. */
export const CRM_START_REFUSED: Record<StartRefusal, string> = {
  disabled: 'The agent is turned off. An owner or admin can turn it on.',
  'daily budget reached':
    'The workspace daily spend cap has been reached. Try again tomorrow, or ask an owner or admin to raise it.',
  'weekly budget reached':
    'The workspace weekly spend cap has been reached. Ask an owner or admin to raise it.',
};

/**
 * Makes sure Kasturi's settings row exists, created with Kasturi's own defaults and its
 * schedule off: the owner picks daily or weekly once the focus is confirmed.
 * Update-first (a no-op touch), then insert: column grants make upsert fail 42501.
 * A lost insert race (23505) means the row exists, which is what we wanted.
 */
export async function ensureCrmAgentConfig(client: SupabaseClient, orgId: string): Promise<CapResult<null>> {
  const upd = await client
    .from('agent_configs')
    .update({ updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('agent_key', CRM_FOCUS)
    .select('id')
    .maybeSingle();
  if (upd.error) {
    console.error('[crm-agent-settings] ensure failed:', upd.error.code);
    return { ok: false, error: COULD_NOT_SAVE };
  }
  if (upd.data) return { ok: true, data: null };
  const ins = await client
    .from('agent_configs')
    .insert({ org_id: orgId, agent_key: CRM_FOCUS, cadence: 'off', ...CRM_DEFAULTS });
  if (ins.error && ins.error.code !== '23505') {
    console.error('[crm-agent-settings] ensure insert failed:', ins.error.code);
    return { ok: false, error: COULD_NOT_SAVE };
  }
  return { ok: true, data: null };
}

/** Writes columns on Kasturi's row, creating it with Kasturi's defaults first. */
export async function writeCrmConfig(
  client: SupabaseClient,
  orgId: string,
  patch: Record<string, unknown>,
): Promise<CapResult<null>> {
  const ensured = await ensureCrmAgentConfig(client, orgId);
  if (!ensured.ok) return ensured;
  const upd = await client
    .from('agent_configs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('agent_key', CRM_FOCUS)
    .select('id')
    .maybeSingle();
  if (upd.error || !upd.data) {
    console.error('[crm-agent-settings] write failed:', upd.error?.code);
    return { ok: false, error: COULD_NOT_SAVE };
  }
  return { ok: true, data: null };
}

/** Whether the workspace has a confirmed focus plan. Pass the service client for the runner. */
export async function hasConfirmedFocus(client: SupabaseClient, orgId: string): Promise<boolean> {
  const { data } = await client
    .from('agent_configs')
    .select('focus_confirmed_at')
    .eq('org_id', orgId)
    .eq('agent_key', CRM_FOCUS)
    .maybeSingle();
  return Boolean(data && (data as { focus_confirmed_at: string | null }).focus_confirmed_at);
}

export type SaveFocusDeps = {
  client: SupabaseClient;
  service: SupabaseClient;
  orgId: string;
  interpret?: typeof interpretFocus;
  now?: Date;
};

export type SaveFocusResult =
  | { ok: true; readBack: string[]; cannot: string[] }
  | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Midnight (Kuala Lumpur) that starts the KL day containing `now`, as a UTC instant. */
function klDayStart(now: Date): Date {
  const local = now.getTime() + KL_OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - KL_OFFSET_MS);
}

/**
 * Reads the workspace's own words into a plan from the fixed menu, records the model
 * call as an `interpret` run (so its cost counts against the caps), and stores the plan
 * UNconfirmed: an owner or admin must confirm it before the agent acts on it.
 * `service` MUST be the service-role client; `orgId` comes from the viewer.
 */
export async function saveFocus(deps: SaveFocusDeps, text: string): Promise<SaveFocusResult> {
  const { client, service, orgId } = deps;
  const interpret = deps.interpret ?? interpretFocus;
  const now = deps.now ?? new Date();

  const focus = text.trim();
  if (focus.length < 1 || focus.length > MAX_FOCUS_CHARS) {
    return fail(`Write what the agent should watch for (up to ${MAX_FOCUS_CHARS} characters).`);
  }

  const key = await readWorkspaceKey(service, orgId);
  if (key.status !== 'ok') return fail('Add your AI key in Settings to use the agent.');

  try {
    const refusal = await startRefusal(service, orgId, CRM_FOCUS);
    // Only the budget part of the gate: a switched-off agent can still have its focus edited
    // (confirming switches it on).
    if (refusal && refusal !== 'disabled') return fail(CRM_START_REFUSED[refusal]);
  } catch {
    return fail('The focus could not be read just now. Please try again.');
  }

  const { count, error: countError } = await service
    .from('agent_runs')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('agent_key', CRM_FOCUS)
    .eq('trigger', 'interpret')
    .gte('started_at', klDayStart(now).toISOString());
  if (countError) return fail('The focus could not be read just now. Please try again.');
  if ((count ?? 0) >= MAX_CHANGES_PER_DAY) {
    return fail(`You have changed the focus ${MAX_CHANGES_PER_DAY} times today. Try again tomorrow.`);
  }

  // Reserve the spend BEFORE the model call so a failed record can never bypass the daily
  // limit. 'done' (not 'running'): a running row would take the workspace's single run slot.
  const reserved = await service
    .from('agent_runs')
    .insert({
      org_id: orgId,
      agent_key: CRM_FOCUS,
      status: 'done',
      trigger: 'interpret',
      cost_cents: TEXT_ESTIMATE_CENTS,
      finished_at: now.toISOString(),
    })
    .select('id')
    .single();
  const runId = (reserved.data as { id: string } | null)?.id;
  if (reserved.error || !runId) {
    console.error('[crm-agent-settings] interpret run not reserved:', reserved.error?.code);
    return fail('The focus could not be saved just now. Please try again.');
  }
  const settle = async (patch: Record<string, unknown>) => {
    const { error } = await service.from('agent_runs').update(patch).eq('org_id', orgId).eq('id', runId);
    if (error) console.error('[crm-agent-settings] interpret run not settled:', error.code);
  };

  let result: Awaited<ReturnType<typeof interpretFocus>>;
  try {
    result = await interpret(key.apiKey, CRM_FOCUS_MENU, focus);
  } catch {
    // The estimate stays on the row: the spend may have happened.
    await settle({ status: 'failed', error: 'interpret failed' });
    return fail('The focus could not be read just now. Please try again.');
  }
  if (result.cost_cents != null) await settle({ cost_cents: Math.round(result.cost_cents) });

  const saved = await writeCrmConfig(client, orgId, {
    focus_text: focus,
    focus_plan: result.plan,
    focus_cannot: result.cannot,
    focus_confirmed_at: null,
  });
  if (!saved.ok) return saved;
  return { ok: true, readBack: readBack(CRM_FOCUS_MENU, result.plan), cannot: result.cannot };
}

/** Confirms the saved plan (owner/admin) and switches the agent on. Refuses an empty plan. */
export async function confirmFocus(
  client: SupabaseClient,
  orgId: string,
  now: Date = new Date(),
): Promise<CapResult<null>> {
  const { data } = await client
    .from('agent_configs')
    .select('focus_plan')
    .eq('org_id', orgId)
    .eq('agent_key', CRM_FOCUS)
    .maybeSingle();
  const plan = (data as { focus_plan: FocusPlan | null } | null)?.focus_plan;
  if (!plan || !Array.isArray(plan.checks) || plan.checks.length === 0) {
    return { ok: false, error: 'There is nothing to confirm yet. Save a focus the agent can act on first.' };
  }
  return writeCrmConfig(client, orgId, { focus_confirmed_at: now.toISOString(), enabled: true });
}

/**
 * The next 07:00 in Kuala Lumpur (UTC+8, no daylight saving) strictly after `now`.
 * Weekly: the first such 07:00 that falls on a Monday in KL (Sunday 23:00 UTC).
 */
export function nextKlSeven(now: Date, cadence: 'daily' | 'weekly'): Date {
  const SEVEN = 7 * 3_600_000;
  const local = now.getTime() + KL_OFFSET_MS;
  let t = Math.floor(local / DAY_MS) * DAY_MS + SEVEN;
  if (t <= local) t += DAY_MS;
  if (cadence === 'weekly') {
    // getUTCDay on the shifted instant is the KL weekday; 1 = Monday.
    while (new Date(t).getUTCDay() !== 1) t += DAY_MS;
  }
  return new Date(t - KL_OFFSET_MS);
}
