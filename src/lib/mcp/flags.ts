/**
 * Switches for the MCP server, read on the server per call.
 *
 * `MCP_SIGN_IN_ENABLED`: "Sign in with OpenKuasa" connections (Supabase OAuth tokens on /api/mcp, the consent screen,
 * Connected apps). On only when exactly `true`; off by default, so AI tools connect with API keys.
 */

import 'server-only';

export function signInEnabled(): boolean {
  return process.env.MCP_SIGN_IN_ENABLED === 'true';
}
