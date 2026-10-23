/** One activity entry for a change made through MCP, for owners and admins (public.log_mcp_change builds the text). */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logFailure } from '@/lib/mcp/shared';

/**
 * Records the change on the person's own client, in `org`: the workspace the credential belongs to. Never throws;
 * false when the entry was not written (refused, or nothing to write for a viewer). Only the operation, the display
 * name and the client name go in: never arguments or results.
 */
export async function logMcpChange(
  supabase: SupabaseClient,
  args: { org: string; operation: string; target: string; client: string },
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('log_mcp_change', {
      p_org: args.org,
      p_operation: args.operation,
      p_target: args.target,
      p_client: args.client,
    });
    if (error) {
      logFailure('mcp', 'log_mcp_change', error);
      return false;
    }
    return data === true;
  } catch (error) {
    logFailure('mcp', 'log_mcp_change', error);
    return false;
  }
}
