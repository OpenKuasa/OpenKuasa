import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentProposal } from '@/lib/agents/types';

const COLS =
  'id,org_id,run_id,agent_key,product,action,input,title,detail,rationale,check_key,status,result,created_at,decided_at,decided_by,expires_at';

/**
 * The org's pending proposals, newest first. Read with the session client (RLS scopes it).
 * Pass `product` to show only that product's queue (reach's screen passes 'reach'); omit it
 * for the unified inbox.
 */
export async function listPendingProposals(
  client: SupabaseClient,
  orgId: string,
  product?: string,
): Promise<AgentProposal[]> {
  let q = client.from('agent_proposals').select(COLS).eq('org_id', orgId).eq('status', 'pending');
  if (product) q = q.eq('product', product);
  const { data } = await q.order('created_at', { ascending: false });
  return (data ?? []) as unknown as AgentProposal[];
}

/**
 * How many proposals are waiting for a decision. Session client (RLS scopes it). Omit
 * `product` for the unified nav-badge count; pass it to scope to one product.
 */
export async function countPendingProposals(
  client: SupabaseClient,
  orgId: string,
  product?: string,
): Promise<number> {
  let q = client
    .from('agent_proposals')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('status', 'pending');
  if (product) q = q.eq('product', product);
  const { count } = await q;
  return count ?? 0;
}

/**
 * The org's most recently decided proposals (approved/rejected/failed/expired), newest
 * first. Expired rows have no `decided_at`, so they sort after the human decisions. Pass
 * `product` to scope to one product's history.
 */
export async function listRecentlyDecided(
  client: SupabaseClient,
  orgId: string,
  limit = 5,
  product?: string,
): Promise<AgentProposal[]> {
  let q = client.from('agent_proposals').select(COLS).eq('org_id', orgId).neq('status', 'pending');
  if (product) q = q.eq('product', product);
  const { data } = await q
    .order('decided_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as unknown as AgentProposal[];
}
