/**
 * OAuth protected-resource metadata (RFC 9728) for the MCP endpoint: what MCP clients read, after a 401 from
 * /api/mcp, to find the server that signs a person in. That is the Supabase project's auth server.
 */

import { originFromHeaders } from '@/lib/reach/form-submissions';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
  if (!supabaseUrl) return Response.json({ error: 'Sign-in is not configured.' }, { status: 503 });
  const origin = originFromHeaders((name) => request.headers.get(name)) ?? 'https://openkuasa.com';
  return Response.json(
    { resource: `${origin}/api/mcp`, authorization_servers: [`${supabaseUrl}/auth/v1`] },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
