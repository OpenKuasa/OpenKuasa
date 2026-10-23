/**
 * Who is calling the MCP server: the request's bearer credential turned into that person, on their own token.
 *
 * Two credentials are accepted. A personal API key (`okk_…`), which `resolveApiKey` checks and exchanges for the
 * person's access token, bound to the key's workspace. Or a Supabase OAuth 2.1 access token, checked with the auth
 * server on every call and bound to the workspace the person had open when the client first used it.
 *
 * Every call then reads, as the person: their role in the credential's workspace (none means removed), and the
 * workspace they now have open; a different one is refused rather than acted on behind their back.
 *
 * The client handed back carries the person's JWT and the anon key, never the service key. Nothing here logs or
 * returns a token.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currentOrgFor, type OrgRole } from '@/lib/auth/current-org';
import { resolveApiKey } from '@/lib/mcp/keys';
import { logFailure as sharedLogFailure, userClient } from '@/lib/mcp/shared';

export type McpCaller = {
  supabase: SupabaseClient;
  userId: string;
  orgId: string;
  orgName: string;
  role: OrgRole;
  credentialId: string;
  clientName: string;
};

export type CallerResult = { ok: true; caller: McpCaller } | { ok: false; status: 401 | 403 | 503; message: string };

export const SIGN_IN = 'Sign in to OpenKuasa or use an API key.';
export const CREDENTIAL_REFUSED =
  'That API key or sign-in is not valid any more. Sign in to OpenKuasa again, or make a new API key.';
export const REMOVED = 'You are no longer a member of this workspace, so this connection cannot act in it.';
export const NO_WORKSPACE = 'Open a workspace in OpenKuasa, then try again.';
export const FAILED = 'Your access could not be checked just now. Try again.';

const OTHER_WORKSPACE = 'your other workspace';
const ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'viewer'];
/** One bearer token: no spaces, a sane length. */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

/** Process-wide: OAuth credential id → the workspace it was bound to at first use. Lost on restart, re-learned. */
const bound = new Map<string, string>();

function bearerOf(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer (\S+)$/i.exec(header.trim());
  if (!match || !TOKEN_SHAPE.test(match[1])) return null;
  return match[1];
}

/** A JWT's claims, read only after the auth server has accepted the token. */
function claimsOf(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const logFailure = (operation: string, error: unknown) => sharedLogFailure('mcp-caller', operation, error);

async function nameOf(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await supabase.from('orgs').select('name').eq('id', orgId).maybeSingle();
  const name = (data as { name?: unknown } | null)?.name;
  return !error && typeof name === 'string' && name.trim() ? name : null;
}

/** An API key: its person and workspace, as `resolveApiKey` checked them. */
async function fromApiKey(key: string) {
  const resolved = await resolveApiKey(key);
  if (!resolved.ok) return null;
  return {
    credentialId: `key:${resolved.id}`,
    userId: resolved.userId,
    orgId: resolved.orgId as string | null,
    accessToken: resolved.accessToken,
  };
}

/** An OAuth access token: accepted by the auth server, its subject that user, issued to a named client. */
async function fromOAuth(token: string, supabase: SupabaseClient) {
  const { data, error } = await supabase.auth.getUser(token);
  const userId = data?.user?.id;
  if (error || !userId) return null;
  const claims = claimsOf(token);
  const clientId = claims?.client_id;
  if (!claims || claims.sub !== userId || typeof clientId !== 'string' || !clientId) return null;
  const credentialId = `oauth:${clientId}:${userId}`;
  return { credentialId, userId, orgId: bound.get(credentialId) ?? null, accessToken: token };
}

/**
 * The person behind the request's `Authorization: Bearer …`, acting in the workspace the credential is bound to,
 * with their role read now. 401 when there is no valid credential or the person left the workspace; 403 when they
 * now have another workspace open in OpenKuasa.
 */
export async function resolveCaller(request: Request, clientName: string): Promise<CallerResult> {
  const token = bearerOf(request);
  if (!token) return { ok: false, status: 401, message: SIGN_IN };
  try {
    const isKey = token.startsWith('okk_');
    const oauthClient = isKey ? null : userClient(token);
    const credential = oauthClient ? await fromOAuth(token, oauthClient) : await fromApiKey(token);
    if (!credential) return { ok: false, status: 401, message: CREDENTIAL_REFUSED };
    const { credentialId, userId, accessToken } = credential;
    const supabase = oauthClient ?? userClient(accessToken);

    // The workspace the person has open, by the app's own rule (a read error throws: 503 below).
    const current = await currentOrgFor(supabase, userId);

    let orgId = credential.orgId;
    if (!orgId) {
      // An OAuth credential's first use on this server: it takes the workspace the person has open.
      if (!current) return { ok: false, status: 403, message: NO_WORKSPACE };
      orgId = current.orgId;
    }

    const { data: member, error: memberError } = await supabase
      .from('org_members')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();
    const role = (member as { role?: unknown } | null)?.role;
    if (memberError) {
      logFailure('read role', memberError);
      return { ok: false, status: 503, message: FAILED };
    }
    if (!ROLES.includes(role as OrgRole)) return { ok: false, status: 401, message: REMOVED };

    // A member here but no current workspace cannot happen with consistent data; treat it as removed.
    if (!current) return { ok: false, status: 401, message: REMOVED };

    const orgName = await nameOf(supabase, orgId);
    if (current.orgId !== orgId) {
      const other = await nameOf(supabase, current.orgId);
      return {
        ok: false,
        status: 403,
        message: `Switch back to ${orgName ?? OTHER_WORKSPACE} in OpenKuasa, or connect again for ${other ?? OTHER_WORKSPACE}.`,
      };
    }

    if (!isKey && !bound.has(credentialId)) bound.set(credentialId, orgId);
    return {
      ok: true,
      caller: { supabase, userId, orgId, orgName: orgName ?? 'your workspace', role: role as OrgRole, credentialId, clientName },
    };
  } catch (error) {
    logFailure('resolve', error);
    return { ok: false, status: 503, message: FAILED };
  }
}
