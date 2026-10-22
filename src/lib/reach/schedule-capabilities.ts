import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ReachWriteContext, CapResult } from '@/lib/reach/capabilities';
import { WEEKLY_STUDIO, type AgentSchedule } from '@/lib/agents/types';
import { agentKeySchema } from '@/lib/agents/agent-keys';

// Server-only. Writes go through the caller's session client, so they may only
// touch columns granted to `authenticated`: never spent_cents, runs_used,
// last_run_at or paused_reason (the runner owns those).

const agentKey = agentKeySchema;
const iso = z.string().datetime({ offset: true });
const FAILED = { ok: false, error: 'That change could not be saved.' } as const;

export const createScheduleInput = z
  .object({
    agent_key: agentKey,
    interval_seconds: z.number().int().min(300).max(31_536_000),
    starts_at: iso.optional(),
    end_at: iso.optional(),
    max_runs: z.number().int().min(1).max(1000).optional(),
    max_total_cents: z.number().int().min(0).max(100_000).optional(),
    nl_text: z.string().trim().max(200).optional(),
  })
  .refine((v) => !v.end_at || new Date(v.end_at) > new Date(), {
    message: 'end_at must be in the future',
    path: ['end_at'],
  });

export const updateScheduleInput = z.object({
  id: z.string().uuid(),
  interval_seconds: z.number().int().min(300).max(31_536_000).optional(),
  end_at: iso.nullable().optional(),
  max_runs: z.number().int().min(1).max(1000).nullable().optional(),
  max_total_cents: z.number().int().min(0).max(100_000).nullable().optional(),
  nl_text: z.string().trim().max(200).optional(),
});
export const pauseScheduleInput = z.object({ id: z.string().uuid() });
export const resumeScheduleInput = z.object({ id: z.string().uuid() });
export const cancelScheduleInput = z.object({ id: z.string().uuid() });

export const setWorkspaceCapsInput = z.object({
  agent_key: agentKey.default(WEEKLY_STUDIO),
  daily_cap_cents: z.number().int().min(0).max(1_000_000),
  weekly_cap_cents: z.number().int().min(0).max(1_000_000),
});

const COLS =
  'id,org_id,agent_key,created_by,nl_text,interval_seconds,next_run_at,last_run_at,end_at,max_runs,runs_used,max_total_cents,spent_cents,status,paused_reason,created_at,updated_at';

export async function listSchedules(client: SupabaseClient, orgId: string): Promise<AgentSchedule[]> {
  const { data } = await client
    .from('agent_schedules')
    .select(COLS)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  return (data ?? []) as unknown as AgentSchedule[];
}

export async function createSchedule(
  ctx: ReachWriteContext,
  input: z.infer<typeof createScheduleInput>,
): Promise<CapResult<AgentSchedule>> {
  const p = createScheduleInput.parse(input);
  const nextRun = p.starts_at ?? new Date(Date.now() + p.interval_seconds * 1000).toISOString();
  const { data, error } = await ctx.client
    .from('agent_schedules')
    .insert({
      org_id: ctx.orgId,
      agent_key: p.agent_key,
      nl_text: p.nl_text ?? null,
      interval_seconds: p.interval_seconds,
      next_run_at: nextRun,
      end_at: p.end_at ?? null,
      max_runs: p.max_runs ?? null,
      max_total_cents: p.max_total_cents ?? null,
      status: 'active',
    })
    .select(COLS)
    .single();
  if (error || !data) {
    console.error('[schedules] create failed:', error?.code);
    return FAILED;
  }
  return { ok: true, data: data as unknown as AgentSchedule };
}

async function patch(
  ctx: ReachWriteContext,
  id: string,
  fields: Record<string, unknown>,
): Promise<CapResult<AgentSchedule>> {
  const { data, error } = await ctx.client
    .from('agent_schedules')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select(COLS)
    .maybeSingle();
  if (error || !data) {
    console.error('[schedules] update failed:', error?.code);
    return FAILED;
  }
  return { ok: true, data: data as unknown as AgentSchedule };
}

export async function updateSchedule(
  ctx: ReachWriteContext,
  input: z.infer<typeof updateScheduleInput>,
): Promise<CapResult<AgentSchedule>> {
  const { id, ...rest } = updateScheduleInput.parse(input);
  return patch(ctx, id, rest);
}

export async function pauseSchedule(
  ctx: ReachWriteContext,
  input: z.infer<typeof pauseScheduleInput>,
): Promise<CapResult<AgentSchedule>> {
  return patch(ctx, pauseScheduleInput.parse(input).id, { status: 'paused' });
}

export async function resumeSchedule(
  ctx: ReachWriteContext,
  input: z.infer<typeof resumeScheduleInput>,
): Promise<CapResult<AgentSchedule>> {
  // paused_reason is not in the authenticated UPDATE grant; the runner clears it.
  return patch(ctx, resumeScheduleInput.parse(input).id, { status: 'active' });
}

export async function cancelSchedule(
  ctx: ReachWriteContext,
  input: z.infer<typeof cancelScheduleInput>,
): Promise<CapResult<AgentSchedule>> {
  return patch(ctx, cancelScheduleInput.parse(input).id, { status: 'completed' });
}

export async function setWorkspaceCaps(
  ctx: ReachWriteContext,
  input: z.input<typeof setWorkspaceCapsInput>,
): Promise<CapResult<{ daily_cap_cents: number; weekly_cap_cents: number }>> {
  // Callers (the server action) have already checked agent_key against the registry via
  // setWorkspaceCapsInput; here any non-empty key is accepted as trusted server input.
  const { agent_key, ...p } = setWorkspaceCapsInput
    .extend({ agent_key: z.string().min(1).default(WEEKLY_STUDIO) })
    .parse(input);
  const cols = 'daily_cap_cents,weekly_cap_cents';
  // Update-first: the column-level UPDATE grant makes ON CONFLICT (upsert) 42501.
  const upd = await ctx.client
    .from('agent_configs')
    .update({ ...p, updated_at: new Date().toISOString() })
    .eq('org_id', ctx.orgId)
    .eq('agent_key', agent_key)
    .select(cols)
    .maybeSingle();
  if (upd.error) {
    console.error('[schedules] caps update failed:', upd.error.code);
    return FAILED;
  }
  if (upd.data) return { ok: true, data: upd.data as { daily_cap_cents: number; weekly_cap_cents: number } };
  const ins = await ctx.client
    .from('agent_configs')
    .insert({ org_id: ctx.orgId, agent_key, ...p })
    .select(cols)
    .single();
  if (ins.error || !ins.data) {
    console.error('[schedules] caps insert failed:', ins.error?.code);
    return FAILED;
  }
  return { ok: true, data: ins.data as { daily_cap_cents: number; weekly_cap_cents: number } };
}

/** Tag marking the one schedule row owned by the off/daily/weekly dropdown. */
export const CADENCE_PRESET = 'cadence preset';
// Rows the slice-6 data migration created from agent_configs.cadence: adopted as the preset.
const PRESET_TAGS = [CADENCE_PRESET, 'Migrated from daily cadence', 'Migrated from weekly cadence'];
const CADENCE_SECONDS = { daily: 86_400, weekly: 604_800 } as const;

/**
 * Keeps the off/daily/weekly dropdown and the schedule table in step: ensures a
 * single preset schedule row (never a duplicate) mirrors the chosen cadence.
 */
export async function syncCadenceSchedule(
  ctx: ReachWriteContext,
  cadence: 'off' | 'daily' | 'weekly',
  opts: { agentKey?: string; firstRunAt?: (now: Date) => Date } = {},
): Promise<CapResult<null>> {
  const agentKey = opts.agentKey ?? WEEKLY_STUDIO;
  const now = new Date();
  const firstRun = (secs: number) =>
    (opts.firstRunAt ? opts.firstRunAt(now) : new Date(now.getTime() + secs * 1000)).toISOString();
  const scope = () =>
    ctx.client
      .from('agent_schedules')
      .update(
        cadence === 'off'
          ? { status: 'completed', updated_at: now.toISOString() }
          : {
              interval_seconds: CADENCE_SECONDS[cadence],
              next_run_at: firstRun(CADENCE_SECONDS[cadence]),
              status: 'active',
              nl_text: CADENCE_PRESET,
              updated_at: now.toISOString(),
            },
      )
      .eq('org_id', ctx.orgId)
      .eq('agent_key', agentKey)
      .in('nl_text', PRESET_TAGS)
      .select('id')
      .maybeSingle();
  // Update-first: the column-level grants make ON CONFLICT (upsert) 42501.
  const upd = await scope();
  if (upd.error) {
    console.error('[schedules] cadence sync failed:', upd.error.code);
    return FAILED;
  }
  if (upd.data || cadence === 'off') return { ok: true, data: null };
  const secs = CADENCE_SECONDS[cadence];
  const ins = await ctx.client
    .from('agent_schedules')
    .insert({
      org_id: ctx.orgId,
      agent_key: agentKey,
      nl_text: CADENCE_PRESET,
      interval_seconds: secs,
      next_run_at: firstRun(secs),
      status: 'active',
    })
    .select('id')
    .single();
  if (ins.error?.code === '23505') {
    // A concurrent sync already created the preset (partial unique index): update it instead.
    const retry = await scope();
    if (retry.error || !retry.data) {
      console.error('[schedules] cadence retry failed:', retry.error?.code);
      return FAILED;
    }
    return { ok: true, data: null };
  }
  if (ins.error || !ins.data) {
    console.error('[schedules] cadence insert failed:', ins.error?.code);
    return FAILED;
  }
  return { ok: true, data: null };
}
