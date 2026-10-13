import type { SupabaseClient } from '@supabase/supabase-js';

export const proposalsTableSkipReason =
  'agent_proposals migration not yet applied to the dev database — skipping RLS tests.';

/** True until 20261022090000_agent_proposals.sql is applied (PostgREST reports the table missing). */
export async function proposalsTableMissing(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.from('agent_proposals').select('id').limit(1);
  // PGRST205 = table not found in the schema cache; 42P01 = undefined_table.
  return error?.code === 'PGRST205' || error?.code === '42P01';
}
