import type { SupabaseClient } from '@supabase/supabase-js';
import { runProposalAction, type ApplyResult } from '@/lib/agents/apply-proposal';
import { agentForProduct, type AgentRegistry } from '@/lib/agents/definition';
import { AGENTS } from '@/lib/agents/registry';

export type DecideResult = { ok: boolean; error?: string; screenPath?: string };

/** Screens to refresh after a decision: the result's own, else (already handled) every agent screen. */
export function screensToRefresh(
  result: { screenPath?: string },
  registry: AgentRegistry = AGENTS,
): string[] {
  if (result.screenPath) return [result.screenPath];
  return [...new Set([...registry.values()].map((def) => def.ui.screenPath))];
}

const HANDLED = 'That suggestion has already been handled.';

/**
 * Where a claimed proposal goes when its action says the target no longer matches (`stale`):
 * dismissed, like a person's rejection, so the proposer's cooldown keeps it from coming back.
 * The proposal guard (v5) allows approved -> rejected only with `result.stale = true`, and only
 * status and result may change.
 */
const STALE_STATUS = 'rejected';

/**
 * Approve a queued proposal, claim-first: atomically flip pending -> approved (pending and
 * unexpired only), and only the caller that wins the claim runs the capability, under the
 * OWNER's session (never the service-role worker), through the agent that owns the proposal's
 * product. Postgres serializes concurrent approvals on the row, so the change is applied
 * exactly once. If the apply fails after the claim, the row is corrected approved -> failed.
 */
export async function approveProposal(
  client: SupabaseClient,
  orgId: string,
  userId: string,
  id: string,
  registry: AgentRegistry = AGENTS,
): Promise<DecideResult> {
  const { data: claimed } = await client
    .from('agent_proposals')
    .update({ status: 'approved', decided_at: new Date().toISOString(), decided_by: userId })
    .eq('id', id)
    .eq('org_id', orgId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .select('action, input, product')
    .maybeSingle();
  if (!claimed) return { ok: false, error: HANDLED };

  const product = claimed.product as string;
  const def = agentForProduct(product, registry);
  const screenPath = def?.ui.screenPath;
  const writeContext = (d: NonNullable<typeof def>) => {
    const ctx = d.buildWriteContext(client, orgId, userId);
    return d.writeContextTakesProposal ? { ...(ctx as object), proposalId: id } : ctx;
  };
  const applied = def
    ? await runProposalAction(
        product,
        writeContext(def),
        claimed.action as string,
        claimed.input,
        registry,
      )
    : ({ ok: false, error: 'No agent handles this suggestion.' } as ApplyResult);

  if (!applied.ok && applied.stale) {
    // Only status and result change: who decided it, and when, stay as the claim wrote them.
    const result = { error: applied.error, stale: true } as never;
    const { error } = await client
      .from('agent_proposals')
      .update({ status: STALE_STATUS, result })
      .eq('id', id)
      .eq('org_id', orgId);
    // Never leave a row approved that applied nothing: if the dismissal is refused, mark it failed.
    if (error) await client.from('agent_proposals').update({ status: 'failed', result }).eq('id', id).eq('org_id', orgId);
    return { ok: false, error: applied.error, screenPath };
  }
  if (!applied.ok) {
    await client
      .from('agent_proposals')
      .update({ status: 'failed', result: { error: applied.error } as never })
      .eq('id', id)
      .eq('org_id', orgId);
    return { ok: false, error: 'The change could not be applied.', screenPath };
  }
  // Record what the apply produced on the now-approved row (informational, best-effort:
  // the change already landed, so a failed stamp must not fail the action).
  try {
    await client
      .from('agent_proposals')
      .update({ result: applied.result as never })
      .eq('id', id)
      .eq('org_id', orgId);
  } catch (e) {
    // the apply succeeded; the result column is informational. Log for ops only.
    console.error('[agent-proposals] result stamp failed', e);
  }
  return { ok: true, screenPath };
}

/** Dismiss a queued proposal: mark it rejected, apply nothing. */
export async function rejectProposal(
  client: SupabaseClient,
  orgId: string,
  userId: string,
  id: string,
  registry: AgentRegistry = AGENTS,
): Promise<DecideResult> {
  const { data } = await client
    .from('agent_proposals')
    .update({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: userId })
    .eq('id', id)
    .eq('org_id', orgId)
    .eq('status', 'pending')
    .select('id, product')
    .maybeSingle();
  if (!data) return { ok: false, error: HANDLED };
  const screenPath = agentForProduct(data.product as string, registry)?.ui.screenPath;
  return { ok: true, screenPath };
}
