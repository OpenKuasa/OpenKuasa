/** One activity entry for a change made through MCP, for owners and admins (public.log_mcp_change_as builds the text). */

import 'server-only';
import { logFailure } from '@/lib/mcp/shared';
import { serviceClient } from '@/lib/supabase/service';

/**
 * Records the change made by `actor` in `org`: the workspace the credential belongs to. Only the server writes these
 * entries, so this is the one call the MCP server makes with the service role; the function itself checks that the
 * actor is a member of that workspace who is not a viewer. Never throws; false when the entry was not written. Only
 * the operation, the display name and the client name go in: never arguments or results.
 */
export async function logMcpChange(args: {
  actor: string;
  org: string;
  operation: string;
  target: string;
  client: string;
}): Promise<boolean> {
  try {
    const { data, error } = await serviceClient().rpc('log_mcp_change_as', {
      p_actor: args.actor,
      p_org: args.org,
      p_operation: args.operation,
      p_target: args.target,
      p_client: args.client,
    });
    if (error) {
      logFailure('mcp', 'log_mcp_change_as', error);
      return false;
    }
    return data === true;
  } catch (error) {
    logFailure('mcp', 'log_mcp_change_as', error);
    return false;
  }
}
