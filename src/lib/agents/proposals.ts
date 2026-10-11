import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentProposal } from '@/lib/agents/types';

const COLS =
  'id,org_id,run_id,agent_key,product,action,input,title,detail,rationale,status,result,created_at,decided_at,decided_by,expires_at';

/** The org's pending proposals, newest first. Read with the session client (RLS scopes it). */
export async function listPendingProposals(client: SupabaseClient, orgId: string): Promise<AgentProposal[]> {
  const { data } = await client
    .from('agent_proposals')
    .select(COLS)
    .eq('org_id', orgId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  return (data ?? []) as unknown as AgentProposal[];
}
