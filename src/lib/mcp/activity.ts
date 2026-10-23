/** One activity entry for a change made through MCP, for owners and admins (public.log_mcp_change builds the text). */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logFailure } from '@/lib/mcp/shared';

/**
 * Records the change on the person's own client. Never throws; false when the entry could not be written. Only the
 * operation, the display name and the client name go in: never arguments or results.
 */
export async function logMcpChange(
  supabase: SupabaseClient,
  args: { operation: string; target: string; client: string },
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('log_mcp_change', {
      p_operation: args.operation,
      p_target: args.target,
      p_client: args.client,
    });
    if (error) {
      logFailure('mcp', 'log_mcp_change', error);
      return false;
    }
    return true;
  } catch (error) {
    logFailure('mcp', 'log_mcp_change', error);
    return false;
  }
}
