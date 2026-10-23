/**
 * Who is calling the MCP server: the request's bearer credential turned into that person, on their own token.
 *
 * Two credentials are accepted. A personal API key (`okk_…`), which `resolveApiKey` checks and exchanges for the
 * person's access token, bound to the key's workspace. Or a Supabase OAuth 2.1 access token, checked with the auth
 * server on every call and bound to the workspace recorded for it in `mcp_oauth_bindings`: the one the person allowed
 * on the consent screen (`/oauth/consent`), or, when the auth server skipped that screen and nothing is recorded, the
 * one they have open at first use, recorded then as them. A person with a second factor is refused an OAuth token that
 * was not raised to aal2 (not supported yet; they use a key).
 *
 * Every call then reads, as the person: their role in the credential's workspace (none means removed), and the
 * workspace they now have open; a different one is refused rather than acted on behind their back.
 *
 * The client handed back carries the person's JWT and the anon key, never the service key. Nothing here logs or
 * returns a token.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currentOrgFor, type CurrentOrg, type OrgRole } from '@/lib/auth/current-org';
import { jwtClaims } from '@/lib/auth/oauth-token';
import { signInEnabled } from '@/lib/mcp/flags';
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
export const CONNECT_AGAIN = 'Connect OpenKuasa again from your AI tool.';
export const FAILED = 'Your access could not be checked just now. Try again.';
export const SIGN_IN_OFF = "Sign-in connections aren't available yet. Use an API key from Account → Developers.";
export const MFA_NOT_SUPPORTED =
  "Sign-in connections don't work with two-step sign-in yet. Use an API key from Account → Developers instead.";

const OTHER_WORKSPACE = 'your other workspace';
/** The workspace a removed person can no longer read the name of. */
const THAT_WORKSPACE = 'that workspace';
const ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'viewer'];
/** One bearer token: no spaces, a sane length. */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

function bearerOf(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer (\S+)$/i.exec(header.trim());
  if (!match || !TOKEN_SHAPE.test(match[1])) return null;
  return match[1];
}

const logFailure = (operation: string, error: unknown) => sharedLogFailure('mcp-caller', operation, error);

async function nameOf(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await supabase.from('orgs').select('name').eq('id', orgId).maybeSingle();
  const name = (data as { name?: unknown } | null)?.name;
  return !error && typeof name === 'string' && name.trim() ? name : null;
}

/** What a sign-in connection whose person left its workspace is told; the name only when they can still read it. */
async function removedFrom(supabase: SupabaseClient, orgId: string): Promise<string> {
  const name = await nameOf(supabase, orgId).catch(() => null);
  return `You are no longer a member of ${name ?? THAT_WORKSPACE}. Disconnect this connection in Account → Developers.`;
}

/** An API key: its person and workspace, as `resolveApiKey` checked them. */
async function fromApiKey(key: string) {
  const resolved = await resolveApiKey(key);
  if (!resolved.ok) return null;
  return {
    credentialId: `key:${resolved.id}`,
    userId: resolved.userId,
    clientId: null,
    orgId: resolved.orgId as string | null,
    accessToken: resolved.accessToken,
  };
}

/** The workspace recorded for this person's client, read as them; null when none. A read error throws (503). */
async function bindingOf(supabase: SupabaseClient, userId: string, clientId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('mcp_oauth_bindings')
    .select('org_id')
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  const orgId = (data as { org_id?: unknown } | null)?.org_id;
  return typeof orgId === 'string' && orgId ? orgId : null;
}

/**
 * First use of a connection with nothing recorded (the auth server skipped the consent screen): record, as the
 * person, the workspace they have open. Losing a race to another first use keeps the row that won. Null when there
 * is no workspace or the row cannot be written.
 */
async function bindOnFirstUse(
  supabase: SupabaseClient,
  userId: string,
  clientId: string,
  current: CurrentOrg | null,
): Promise<string | null> {
  if (!current) return null;
  const { error } = await supabase
    .from('mcp_oauth_bindings')
    .insert({ user_id: userId, client_id: clientId, org_id: current.orgId });
  if (!error) return current.orgId;
  if ((error as { code?: unknown }).code === '23505') return bindingOf(supabase, userId, clientId);
  logFailure('bind on first use', error);
  return null;
}

/**
 * An OAuth access token: accepted by the auth server, its subject that user, issued to a named client, acting in the
 * workspace recorded for that client; null when nothing is recorded (bound on first use in `resolveCaller`).
 * 'mfa' when the person uses a second factor and the token was not raised to aal2 (not supported yet).
 */
async function fromOAuth(token: string, supabase: SupabaseClient) {
  const { data, error } = await supabase.auth.getUser(token);
  const userId = data?.user?.id;
  if (error || !userId) return null;
  // Read only after the auth server has accepted the token.
  const claims = jwtClaims(token);
  const clientId = claims?.client_id;
  if (!claims || claims.sub !== userId || typeof clientId !== 'string' || !clientId) return null;
  // The user the auth server returned carries their factors; a missing aal claim counts as below aal2.
  const hasFactor = (data.user.factors ?? []).some((f) => f.status === 'verified');
  if (hasFactor && claims.aal !== 'aal2') return 'mfa' as const;
  const orgId = await bindingOf(supabase, userId, clientId);
  return { credentialId: `oauth:${clientId}:${userId}`, userId, clientId, orgId, accessToken: token };
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
    // Sign-in connections stay off until switched on: only keys are accepted, and nothing else is looked up.
    if (!isKey && !signInEnabled()) return { ok: false, status: 401, message: SIGN_IN_OFF };
    const oauthClient = isKey ? null : userClient(token);
    const credential = oauthClient ? await fromOAuth(token, oauthClient) : await fromApiKey(token);
    if (!credential) return { ok: false, status: 401, message: CREDENTIAL_REFUSED };
    if (credential === 'mfa') return { ok: false, status: 401, message: MFA_NOT_SUPPORTED };
    const { credentialId, userId, clientId, accessToken } = credential;
    const supabase = oauthClient ?? userClient(accessToken);

    // The workspace the person has open, by the app's own rule (a read error throws: 503 below).
    const current = await currentOrgFor(supabase, userId);

    // An OAuth connection with nothing recorded binds to that workspace now; a recorded one never moves.
    const orgId = credential.orgId ?? (clientId ? await bindOnFirstUse(supabase, userId, clientId, current) : null);
    // Could not be bound (no workspace, or the record could not be written).
    if (!orgId) return { ok: false, status: 401, message: CONNECT_AGAIN };

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
    if (!ROLES.includes(role as OrgRole)) return { ok: false, status: 401, message: clientId ? await removedFrom(supabase, orgId) : REMOVED };

    // A member here but no current workspace cannot happen with consistent data; treat it as removed.
    if (!current) return { ok: false, status: 401, message: REMOVED };

    const orgName = await nameOf(supabase, orgId);
    if (current.orgId !== orgId) {
      const here = orgName ?? OTHER_WORKSPACE;
      const other = (await nameOf(supabase, current.orgId)) ?? OTHER_WORKSPACE;
      // A sign-in connection is moved by disconnecting it and connecting again; a key by making another.
      const message = clientId
        ? `This connection works in ${here}. Switch back to ${here} in OpenKuasa, or disconnect it in Account → Developers and connect again for ${other}.`
        : `Switch back to ${here} in OpenKuasa, or connect again for ${other}.`;
      return { ok: false, status: 403, message };
    }

    return {
      ok: true,
      caller: { supabase, userId, orgId, orgName: orgName ?? 'your workspace', role: role as OrgRole, credentialId, clientName },
    };
  } catch (error) {
    logFailure('resolve', error);
    return { ok: false, status: 503, message: FAILED };
  }
}
