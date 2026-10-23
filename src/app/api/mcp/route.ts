/**
 * /api/mcp — OpenKuasa's MCP server, for Claude, Cursor, Codex and any other MCP client.
 *
 * Stateless: every POST gets its own server and transport, after the bearer credential has been turned into the
 * person (see `resolveCaller`). A request without a valid credential is refused before its body is read. There is
 * nothing to stream to a client between calls, so GET is not offered.
 *
 * Nothing here logs the body, a token or a key.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { resolveCaller } from '@/lib/mcp/caller';
import { createMcpServer, memoryRateLimiter } from '@/lib/mcp/server';
import { logFailure } from '@/lib/mcp/shared';
import { originFromHeaders } from '@/lib/reach/form-submissions';

export const dynamic = 'force-dynamic';
// Hint for serverless hosts; a no-op on a persistent server.
export const maxDuration = 60;

/** The transport's own default bound, applied here because the body is read before it is handed over. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_CLIENT = 'MCP client';
const MAX_NAMES = 1000;
const TOO_MANY_REQUESTS = 'Too many requests just now. Wait a minute and try again.';

/** Process-wide: every request a credential sends, at most 120 a minute (tool calls have their own, tighter limit). */
const requests = memoryRateLimiter({ callsPerMinute: 120 });

/** Process-wide: credential id → the name its client gave at initialize. The oldest is dropped past the cap. */
const names = new Map<string, string>();

/** At most 60 printable characters (code points, so an emoji is never cut in half), or null when none are left. */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const printable = raw.replace(/\p{C}+/gu, '').replace(/\s+/g, ' ').trim();
  const name = Array.from(printable).slice(0, 60).join('').trim();
  return name || null;
}

/** The first product token of a User-Agent: `claude-code/2.0 (darwin)` → `claude-code`. */
function agentName(agent: string | null): string | null {
  return cleanName(agent?.trim().split(/\s+/)[0]?.split('/')[0]);
}

function initializeName(body: unknown): string | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    const m = message as { method?: unknown; params?: { clientInfo?: { name?: unknown } } } | null;
    if (m && m.method === 'initialize') return cleanName(m.params?.clientInfo?.name);
  }
  return null;
}

function remember(credentialId: string, name: string): void {
  names.delete(credentialId);
  names.set(credentialId, name);
  while (names.size > MAX_NAMES) names.delete(names.keys().next().value as string);
}

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } },
  );
}

/** The body as text, or null when it is larger than the bound (declared or as it arrives). */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(request: Request): Promise<Response> {
  const origin = originFromHeaders((name) => request.headers.get(name));
  const fromAgent = agentName(request.headers.get('user-agent'));
  const resolved = await resolveCaller(request, fromAgent ?? DEFAULT_CLIENT);
  if (!resolved.ok) {
    const metadata = `${origin ?? 'https://openkuasa.com'}/.well-known/oauth-protected-resource`;
    return jsonRpcError(
      resolved.status,
      -32001,
      resolved.message,
      resolved.status === 401 ? { 'WWW-Authenticate': `Bearer resource_metadata="${metadata}"` } : {},
    );
  }

  if (!requests.take(resolved.caller.credentialId, 'read')) {
    return jsonRpcError(429, -32002, TOO_MANY_REQUESTS, { 'Retry-After': '60' });
  }

  let parsedBody: unknown;
  if (request.method === 'POST') {
    const raw = await readBody(request);
    if (raw === null) return jsonRpcError(413, -32600, 'The request is too large.');
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      return jsonRpcError(400, -32700, 'The request is not valid JSON.');
    }
  }

  const { credentialId } = resolved.caller;
  const given = initializeName(parsedBody);
  if (given) remember(credentialId, given);
  const clientName = given ?? names.get(credentialId) ?? fromAgent ?? DEFAULT_CLIENT;
  const server = createMcpServer({ ...resolved.caller, clientName }, { origin });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, parsedBody === undefined ? undefined : { parsedBody });
  } catch (error) {
    logFailure('mcp', request.method, error);
    return jsonRpcError(500, -32603, 'The server could not answer just now. Try again.');
  } finally {
    // The answer is complete once handleRequest returns (JSON responses, no stream): nothing is left to serve.
    await server.close().catch(() => {});
  }
}

export const POST = handle;
export const DELETE = handle;

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
}
