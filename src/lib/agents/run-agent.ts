import type { SupabaseClient } from '@supabase/supabase-js';
import { webSearch, writeDigest } from '@/lib/agents/openrouter-media';
import { TEXT_ESTIMATE_CENTS, costOr } from '@/lib/agents/costs';
import { proposeChanges } from '@/lib/agents/proposer';
import { RunInProgressError, type AgentRunStatus, type AgentRunTrigger } from '@/lib/agents/types';
import type { AgentDefinition } from '@/lib/agents/definition';
import { readWorkspaceKey } from '@/lib/ai/workspace-key';

const DEFAULT_MAX_COST_CENTS = 200;

export type AgentRunResult = { runId: string; status: AgentRunStatus };

/**
 * Runs one org's agent `def` for one run and persists it as an agent_runs row. The
 * run-row insert/claim, finish, reserve, key open, cap read and cost accounting are the
 * generic framework mechanism; the per-product steps — context, research/digest prompts,
 * media, and the proposer's allow-list/scan — come from the definition.
 *
 * `service` MUST be the service-role client; `orgId` is a TRUSTED argument the caller has
 * already authorized and gated (`startRefusal` in runner.ts). Throws {@link RunInProgressError}
 * when the workspace already has a run in progress. Never logs or returns the key or ciphertext.
 */
export async function runAgent(
  service: SupabaseClient,
  orgId: string,
  trigger: AgentRunTrigger,
  def: AgentDefinition,
): Promise<AgentRunResult> {
  const { data: run, error: insertErr } = await service
    .from('agent_runs')
    .insert({ org_id: orgId, agent_key: def.agentKey, status: 'running', trigger })
    .select()
    .single();
  // This insert is also the claim. The database keeps at most one 'running' row per
  // workspace (agent_runs_one_running_uniq), so of any number of concurrent starts
  // exactly one gets a row; the rest are refused here, before anything is spent.
  if (insertErr?.code === '23505') throw new RunInProgressError();
  if (insertErr || !run) {
    // The insert is a DB write (no API key involved), so its SQLSTATE and message
    // are safe to log and are the only trace of why a run never started -- e.g. a
    // missing service_role grant surfaces here as code '42501' / "permission denied".
    console.error(`[agent ${def.agentKey}] agent_runs insert failed:`, insertErr?.code, insertErr?.message);
    throw new Error('Could not start the agent run.');
  }
  const runId = run.id as string;

  const finish = async (
    status: 'done' | 'failed',
    patch: { digest_md?: string; cost_cents?: number; error?: string },
  ): Promise<AgentRunResult> => {
    const base = { status, finished_at: new Date().toISOString(), ...patch };
    const write = (row: Record<string, unknown>) =>
      service.from('agent_runs').update(row).eq('org_id', orgId).eq('id', runId);
    const { cost_cents: cost, ...withoutCost } = base;
    const { error } = await write(
      typeof cost === 'number' ? { ...withoutCost, cost_cents: Math.round(cost) } : withoutCost,
    );
    // supabase-js returns { error } rather than throwing. If the cost column write
    // was rejected, retry without it so the run never stays stuck at 'running'.
    if (error && typeof cost === 'number') await write(withoutCost);
    return { runId, status };
  };

  // What this run has spent so far, as far as it is known: each paid step adds the
  // provider's figure, or the step's estimate when the provider gave none.
  let cost = 0;
  // Before each paid step, write the run's spend so far plus that step's estimate as the
  // ABSOLUTE total. A run that is cut off mid-step (and later reaped as timed out) then
  // still shows what it had spent and was about to spend, instead of zero. Bookkeeping
  // only: a failed write must never abort the run.
  const reserve = async (totalCents: number) => {
    const { error } = await service
      .from('agent_runs')
      .update({ cost_cents: Math.round(totalCents) })
      .eq('org_id', orgId)
      .eq('id', runId)
      .eq('status', 'running');
    void error;
  };

  try {
    // The key opens only for the workspace this run belongs to.
    const stored = await readWorkspaceKey(service, orgId);
    const apiKey = stored.status === 'ok' ? stored.apiKey : null;
    if (!apiKey) return await finish('failed', { error: 'no AI key' });

    const { data: capRow } = await service
      .from('agent_configs')
      .select('max_cost_cents')
      .eq('org_id', orgId)
      .eq('agent_key', def.agentKey)
      .maybeSingle();
    const maxCost =
      typeof capRow?.max_cost_cents === 'number' ? capRow.max_cost_cents : DEFAULT_MAX_COST_CENTS;

    const { context, raw } = await def.buildContext(service, orgId);

    let researchText: string | null = null;
    if (def.research) {
      await reserve(cost + TEXT_ESTIMATE_CENTS);
      const search = await webSearch(apiKey, def.research.prompt(context));
      cost += costOr(search.cost_cents, TEXT_ESTIMATE_CENTS);
      researchText = search.text;
    }

    await reserve(cost + TEXT_ESTIMATE_CENTS);
    const digest = await writeDigest(apiKey, def.digest.prompt(context, researchText));
    cost += costOr(digest.cost_cents, TEXT_ESTIMATE_CENTS);

    // Optional poster/hero/video. The step tracks its own running cost from `cost` and
    // reserves absolute totals via the same `reserve`; it returns the real cost it added.
    if (def.media) {
      const media = await def.media({
        apiKey,
        context,
        maxCost,
        costSoFar: cost,
        reserve,
        service,
        orgId,
        runId,
      });
      cost += media.cost_cents;
    }

    // Autonomous proposals (5b/5c): suggest non-destructive changes for the owner to approve.
    await reserve(cost + TEXT_ESTIMATE_CENTS);
    try {
      const prop = await proposeChanges(
        service,
        orgId,
        runId,
        apiKey,
        { context, raw, trend: researchText ?? undefined },
        maxCost,
        cost,
        def,
      );
      cost += prop.cost_cents;
    } catch {
      // Deliberately drop the exception: it may carry request details or a key.
    }

    return await finish('done', { digest_md: digest.text, cost_cents: cost });
  } catch {
    // Deliberately drop the exception: it may carry request details or a key.
    // The steps that completed before the failure were still paid for.
    return finish('failed', { error: 'digest failed', cost_cents: cost });
  }
}
