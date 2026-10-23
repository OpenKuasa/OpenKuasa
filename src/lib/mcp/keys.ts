/**
 * Personal API keys for the MCP server: the credential an outside AI client pastes into its config to act as
 * one person in one workspace.
 *
 * A key is `okk_` and 32 random bytes. Only its SHA-256 is stored. Behind it is a Supabase session of the
 * person who made it, opened with a magic-link token the server mints and redeems itself (no email is sent),
 * raised to aal2 with the person's own code when they use a second factor. The session's refresh token is kept
 * sealed (`AI_KEYS_ENCRYPTION_SECRET`, bound to the workspace) and rotated as it is used; every call then runs
 * on that person's access token, under their own row-level security.
 *
 * The service role is used for the auth admin calls, the row's insert, the lookup by hash, and `session_secret`
 * and `last_used_at`. Never for anything a key's caller does: that runs on the person's token.
 *
 * Nothing here logs a key, a token, a hash or an email.
 */

import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { decryptApiKey, encryptApiKey } from '@/lib/ai/key-crypto';
import { serviceClient } from '@/lib/supabase/service';

const TABLE = 'mcp_api_keys';
const PURPOSE = 'mcp-refresh-token' as const;
const KEY_PREFIX = 'okk_';
/** `okk_` and 32 bytes as unpadded base64url. */
const KEY_SHAPE = /^okk_[A-Za-z0-9_-]{43}$/;
/** An access token is refreshed once it is this close to expiring. */
const REFRESH_MARGIN_MS = 60 * 1000;
/** `last_used_at` is written at most this often per key. */
const TOUCH_EVERY_MS = 60 * 1000;

export const KEY_NOT_ALLOWED = 'You can only make a key for yourself, in a workspace you belong to.';
export const KEY_NAME_INVALID = 'Give the key a name of 1 to 60 characters.';
export const KEY_CODE_NEEDED = 'Enter the 6-digit code from your authenticator app to make a key.';
export const KEY_CODE_WRONG = 'That code did not work. Check your authenticator app and try again.';
export const KEY_FAILED = 'The key could not be made just now. Try again.';

const CreateArgs = z.object({
  orgId: z.guid(),
  userId: z.guid(),
  name: z.string().trim().min(1).max(60),
  totp: z.string().trim().regex(/^\d{6}$/).optional(),
});

type KeyRow = {
  id: string;
  org_id: string;
  user_id: string;
  session_secret: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};
type Session = { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number; user?: { id?: string } | null };
type Cached = { userId: string; accessToken: string; expiresAt: number };

/** Process-wide: key id → its current access token. Checked against the row on every use. */
const cache = new Map<string, Cached>();
/** Process-wide: key id → the refresh in flight, so a key never refreshes twice at once. */
const inflight = new Map<string, Promise<Cached | null>>();
/** Process-wide: key id → when this server last wrote `last_used_at`. */
const touched = new Map<string, number>();

const ROW_COLUMNS = 'id, org_id, user_id, session_secret, revoked_at, last_used_at';

/** A client of no one; with a token, a client of that token's person. One per use, so no session is shared. */
function anonClient(accessToken?: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('Supabase is not configured.');
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const hashKey = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');
const seal = (refreshToken: string, orgId: string) => encryptApiKey(refreshToken, orgId, process.env, PURPOSE);
const unseal = (sealed: string, orgId: string) => decryptApiKey(sealed, orgId, process.env, PURPOSE);

function expiryOf(session: Session): number {
  if (typeof session.expires_at === 'number') return session.expires_at * 1000;
  return Date.now() + (session.expires_in ?? 0) * 1000;
}

/** Ends one session only (not the person's other sign-ins). Best effort. */
async function endSession(accessToken: string): Promise<void> {
  try {
    await serviceClient().auth.admin.signOut(accessToken, 'local');
  } catch {
    // The caller has already refused the key; a session it could not end lapses on its own.
  }
}

async function isMember(accessToken: string, orgId: string, userId: string): Promise<boolean> {
  const { data, error } = await anonClient(accessToken)
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  return !error && !!data;
}

/**
 * Makes a key for the signed-in person behind `supabase`, in `orgId`. `userId` and `orgId` come from the
 * caller's verified session; the person must be that session's user and a member of the workspace. A person
 * with a second factor gives their current code. The key is returned once and never again.
 */
export async function createApiKey(
  supabase: SupabaseClient,
  args: { orgId: string; userId: string; name: string; totp?: string },
): Promise<{ ok: true; key: string; id: string } | { ok: false; error: string }> {
  const parsed = CreateArgs.safeParse(args);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === 'name') return { ok: false, error: KEY_NAME_INVALID };
    if (field === 'totp') return { ok: false, error: KEY_CODE_WRONG };
    return { ok: false, error: KEY_NOT_ALLOWED };
  }
  const { orgId, userId, name, totp } = parsed.data;
  let opened: string | null = null;
  try {
    const { data: who, error: whoError } = await supabase.auth.getUser();
    const user = who?.user;
    if (whoError || !user || user.id !== userId || !user.email) return { ok: false, error: KEY_NOT_ALLOWED };

    const { data: member, error: memberError } = await supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();
    if (memberError || !member) return { ok: false, error: KEY_NOT_ALLOWED };

    // A person with a second factor raises the key's session with their code, as signing in would.
    const { data: factors, error: factorError } = await supabase.auth.mfa.listFactors();
    if (factorError) return { ok: false, error: KEY_FAILED };
    const verified = (factors?.all ?? []).filter((f) => f.status === 'verified');
    const totpFactor = verified.find((f) => f.factor_type === 'totp');
    if (verified.length > 0 && !totpFactor) return { ok: false, error: KEY_FAILED };
    if (totpFactor && !totp) return { ok: false, error: KEY_CODE_NEEDED };

    const service = serviceClient();
    const { data: link, error: linkError } = await service.auth.admin.generateLink({ type: 'magiclink', email: user.email });
    const tokenHash = link?.properties?.hashed_token;
    if (linkError || !tokenHash) return { ok: false, error: KEY_FAILED };

    const keyClient = anonClient();
    const { data: otp, error: otpError } = await keyClient.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
    let session: Session | null = otp?.session ?? null;
    if (otpError || !session) return { ok: false, error: KEY_FAILED };
    opened = session.access_token;
    if (session.user?.id !== userId) {
      await endSession(opened);
      return { ok: false, error: KEY_FAILED };
    }

    if (totpFactor && totp) {
      const { data: challenge, error: challengeError } = await keyClient.auth.mfa.challenge({ factorId: totpFactor.id });
      if (challengeError || !challenge) {
        await endSession(opened);
        return { ok: false, error: KEY_FAILED };
      }
      const { data: raised, error: verifyError } = await keyClient.auth.mfa.verify({
        factorId: totpFactor.id,
        challengeId: challenge.id,
        code: totp,
      });
      if (verifyError || !raised?.access_token || !raised.refresh_token) {
        await endSession(opened);
        return { ok: false, error: KEY_CODE_WRONG };
      }
      session = raised as Session;
      opened = session.access_token;
    }

    const key = KEY_PREFIX + randomBytes(32).toString('base64url');
    const { data: row, error: insertError } = await service
      .from(TABLE)
      .insert({ org_id: orgId, user_id: userId, name, key_hash: hashKey(key), session_secret: seal(session.refresh_token, orgId) })
      .select('id')
      .single();
    if (insertError || !row) {
      await endSession(opened);
      return { ok: false, error: KEY_FAILED };
    }
    const id = String((row as { id: string }).id);
    cache.set(id, { userId, accessToken: session.access_token, expiresAt: expiryOf(session) });
    return { ok: true, key, id };
  } catch {
    if (opened) await endSession(opened);
    return { ok: false, error: KEY_FAILED };
  }
}

async function loadById(service: SupabaseClient, id: string): Promise<KeyRow | null> {
  const { data, error } = await service.from(TABLE).select(ROW_COLUMNS).eq('id', id).maybeSingle();
  return error || !data ? null : (data as KeyRow);
}

/**
 * Turns the stored refresh token into a fresh session and stores the rotated refresh token before handing the
 * access token out. When another server rotated it first ("Already Used"), reads the newer one and tries once more.
 */
async function refresh(service: SupabaseClient, row: KeyRow): Promise<Cached | null> {
  let sealed = row.session_secret;
  for (let attempt = 0; attempt < 2 && sealed; attempt += 1) {
    const refreshToken = unseal(sealed, row.org_id);
    if (!refreshToken) return null;
    const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
    const session = data?.session as Session | null | undefined;
    if (!error && session?.access_token && session.refresh_token) {
      if (session.user?.id !== row.user_id) return null;
      const { data: saved, error: saveError } = await service
        .from(TABLE)
        .update({ session_secret: seal(session.refresh_token, row.org_id) })
        .eq('id', row.id)
        .eq('session_secret', sealed)
        .is('revoked_at', null)
        .select('id');
      if (saveError) return null;
      if (!saved || saved.length !== 1) {
        // Not stored: revoked meanwhile, or another server stored a newer token first. Only the latter may go on.
        const now = await loadById(service, row.id);
        if (!now || now.revoked_at || !now.session_secret) return null;
      }
      const next = { userId: row.user_id, accessToken: session.access_token, expiresAt: expiryOf(session) };
      cache.set(row.id, next);
      return next;
    }
    const now = await loadById(service, row.id);
    if (!now || now.revoked_at || now.user_id !== row.user_id || now.session_secret === sealed) return null;
    sealed = now.session_secret;
  }
  return null;
}

/** The key's access token: the cached one while it has more than a minute left, else one refresh shared by all callers. */
async function accessTokenFor(service: SupabaseClient, row: KeyRow): Promise<Cached | null> {
  const cached = cache.get(row.id);
  if (cached && cached.userId === row.user_id && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached;
  let running = inflight.get(row.id);
  if (!running) {
    running = refresh(service, row)
      .catch(() => null)
      .finally(() => inflight.delete(row.id));
    inflight.set(row.id, running);
  }
  return running;
}

async function touch(service: SupabaseClient, row: KeyRow): Promise<void> {
  const now = Date.now();
  const last = Math.max(touched.get(row.id) ?? 0, row.last_used_at ? Date.parse(row.last_used_at) : 0);
  if (now - last < TOUCH_EVERY_MS) return;
  touched.set(row.id, now);
  try {
    await service.from(TABLE).update({ last_used_at: new Date(now).toISOString() }).eq('id', row.id);
  } catch {
    // Bookkeeping only.
  }
}

function forget(id: string): void {
  cache.delete(id);
  touched.delete(id);
}

/**
 * Who a key acts as, and a current access token to act with. Refused for an unknown or revoked key, and when
 * the person is no longer in the key's workspace; both are checked on every call, cached token or not.
 */
export async function resolveApiKey(
  key: string,
): Promise<{ ok: true; id: string; userId: string; orgId: string; accessToken: string } | { ok: false }> {
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return { ok: false };
  try {
    const service = serviceClient();
    const { data, error } = await service.from(TABLE).select(ROW_COLUMNS).eq('key_hash', hashKey(key)).maybeSingle();
    if (error || !data) return { ok: false };
    const row = data as KeyRow;
    if (row.revoked_at || !row.session_secret) {
      forget(row.id);
      return { ok: false };
    }
    const token = await accessTokenFor(service, row);
    if (!token) return { ok: false };
    if (!(await isMember(token.accessToken, row.org_id, row.user_id))) return { ok: false };
    await touch(service, row);
    return { ok: true, id: row.id, userId: row.user_id, orgId: row.org_id, accessToken: token.accessToken };
  } catch {
    return { ok: false };
  }
}

/**
 * Revokes a key, as the signed-in person behind `supabase`: their own key, or any key in a workspace they own or
 * administer (the table's RLS decides). Then ends the key's session and drops its refresh token. True when this
 * call revoked it.
 */
export async function revokeApiKey(supabase: SupabaseClient, id: string): Promise<boolean> {
  if (!z.guid().safeParse(id).success) return false;
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .is('revoked_at', null)
      .select('id');
    if (error || !data || data.length !== 1) return false;
  } catch {
    return false;
  }

  // Revoked: from here on every server refuses the key. What follows only ends its session early.
  await inflight.get(id)?.catch(() => null);
  const cached = cache.get(id);
  forget(id);
  try {
    const service = serviceClient();
    const row = await loadById(service, id);
    let accessToken = cached && cached.expiresAt > Date.now() ? cached.accessToken : null;
    if (!accessToken && row?.session_secret) {
      const refreshToken = unseal(row.session_secret, row.org_id);
      if (refreshToken) {
        const { data } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
        accessToken = data?.session?.access_token ?? null;
      }
    }
    if (accessToken) await endSession(accessToken);
    await service.from(TABLE).update({ session_secret: null }).eq('id', id);
  } catch {
    // Best effort; the key is already refused.
  }
  return true;
}
