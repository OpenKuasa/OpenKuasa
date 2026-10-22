import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * What the workspace's agent runs have cost since `sinceIso`, in cents, summed in
 * the database (`agent_spend_cents`): no row limit can shorten the sum, and a run
 * still in progress counts at its per-run cap. The runner's budget gate and the
 * Agents screen's budget strip both read this one figure.
 *
 * Throws when the sum cannot be read, so an unreadable spend never reads as
 * "nothing spent". Pass `agentKey` to sum one agent's runs only. With a member's session client the database returns only
 * their own workspace's runs; the runner passes the service-role client.
 */
export async function workspaceSpendCents(
  client: SupabaseClient,
  orgId: string,
  sinceIso: string,
  agentKey?: string,
): Promise<number> {
  const { data, error } = await client.rpc('agent_spend_cents', {
    p_org_id: orgId,
    p_since: sinceIso,
    ...(agentKey !== undefined ? { p_agent_key: agentKey } : {}),
  });
  if (error || typeof data !== 'number' || !Number.isFinite(data)) {
    throw new Error('spend query failed');
  }
  return data;
}
