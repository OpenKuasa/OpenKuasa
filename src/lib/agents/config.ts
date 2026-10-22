import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { agentKeySchema } from './agent-keys';
import type { AgentConfig } from './types';

export { AGENT_KEYS, agentKeySchema } from './agent-keys';

export type AgentWriteContext = { client: SupabaseClient; orgId: string };
export type AgentCapResult<T> = { ok: true; data: T } | { ok: false; error: string };

const agentKey = agentKeySchema;
const cadence = z.enum(['off', 'daily', 'weekly']);
export const setAgentEnabledInput = z.object({ agent_key: agentKey, enabled: z.boolean() });
export const setAgentCadenceInput = z.object({ agent_key: agentKey, cadence });
export const setAgentCapInput = z.object({ agent_key: agentKey, max_cost_cents: z.number().int().min(0).max(10000) });
const COLS =
  'id,org_id,agent_key,enabled,cadence,max_cost_cents,daily_cap_cents,weekly_cap_cents,last_run_at,created_at,updated_at';

export async function listAgentConfigs(client: SupabaseClient, orgId: string): Promise<AgentConfig[]> {
  const { data } = await client.from('agent_configs').select(COLS).eq('org_id', orgId);
  return (data ?? []) as unknown as AgentConfig[];
}

// Update-first-then-insert (mirrors updateAdSettings in reach/capabilities.ts).
// An UPDATE must never SET org_id/agent_key — they are not in the column grant,
// so `.upsert()` (INSERT ... ON CONFLICT DO UPDATE) fails 42501 from the session
// client. Scope the update by BOTH org_id and agent_key; insert only if no row yet.
async function writeConfig(ctx: AgentWriteContext, agent_key: string, patch: Record<string, unknown>): Promise<AgentCapResult<AgentConfig>> {
  const upd = await ctx.client
    .from('agent_configs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('org_id', ctx.orgId)
    .eq('agent_key', agent_key)
    .select(COLS)
    .maybeSingle();
  if (upd.error) { console.error('[agent-config] update failed:', upd.error); return { ok: false, error: 'That change could not be saved.' }; }
  if (upd.data) return { ok: true, data: upd.data as unknown as AgentConfig };
  const ins = await ctx.client
    .from('agent_configs')
    .insert({ org_id: ctx.orgId, agent_key, ...patch })
    .select(COLS)
    .single();
  if (ins.error || !ins.data) { console.error('[agent-config] insert failed:', ins.error); return { ok: false, error: 'That change could not be saved.' }; }
  return { ok: true, data: ins.data as unknown as AgentConfig };
}

export async function setAgentEnabled(ctx: AgentWriteContext, input: z.infer<typeof setAgentEnabledInput>) {
  const { agent_key, enabled } = setAgentEnabledInput.parse(input);
  return writeConfig(ctx, agent_key, { enabled });
}
export async function setAgentCadence(ctx: AgentWriteContext, input: z.infer<typeof setAgentCadenceInput>) {
  const { agent_key, cadence } = setAgentCadenceInput.parse(input);
  return writeConfig(ctx, agent_key, { cadence });
}
export async function setAgentCap(ctx: AgentWriteContext, input: z.infer<typeof setAgentCapInput>) {
  const { agent_key, max_cost_cents } = setAgentCapInput.parse(input);
  return writeConfig(ctx, agent_key, { max_cost_cents });
}
