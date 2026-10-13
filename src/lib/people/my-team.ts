import type { SupabaseClient } from '@supabase/supabase-js';

/** What `hr_my_team` returns: a list of employee ids. Anything else reads as nobody. */
export function parseTeam(data: unknown): string[] {
  return Array.isArray(data) ? data.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * The ids of the signed-in person's direct reports they have access to (empty for most people). It runs in the
 * viewer lookup and the app layout, so it never throws: any failure reads as "no team", and a log line carries
 * the database's code and nothing else.
 */
export async function readMyTeam(client: SupabaseClient, orgId: string): Promise<string[]> {
  try {
    const { data, error } = await client.rpc('hr_my_team', { p_org: orgId });
    if (error) {
      console.error('[people-layout] team read failed:', error.code ?? 'no-code');
      return [];
    }
    return parseTeam(data);
  } catch (error) {
    console.error('[people-layout] team read failed:', error instanceof Error ? error.name : 'error');
    return [];
  }
}
