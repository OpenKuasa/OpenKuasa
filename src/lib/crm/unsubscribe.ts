/**
 * Unsubscribe links for broadcasts. Server only.
 *
 * A link is `/u/<recipient id>.<signature>`, where the recipient id is the
 * row recording that one address was sent one broadcast. The signature is an
 * HMAC of that id under the server's secret, so a link can only be made by
 * this server, and it opts out exactly the address that was mailed, in the
 * workspace that mailed it, whatever has happened to the contact since.
 * Opening the link changes nothing; the page asks, and the
 * opt-out is recorded when the visitor confirms (or when their mail program
 * sends the one-click request the email's headers describe).
 *
 * The opt-out is kept by address for the workspace, by the server as itself:
 * no signed-in session, and no visitor, writes it directly.
 */
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { serviceClient } from '@/lib/supabase/service';

type EnvLike = Record<string, string | undefined>;

const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A SHA-256 HMAC as base64url. */
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

/** True when the server can make and check unsubscribe links. */
export function canSignUnsubscribe(env: EnvLike = process.env): boolean {
  return (env.AI_KEYS_ENCRYPTION_SECRET?.trim().length ?? 0) >= MIN_SECRET_LENGTH;
}

function sign(recipientId: string, env: EnvLike): Buffer {
  const secret = env.AI_KEYS_ENCRYPTION_SECRET?.trim() ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error('AI_KEYS_ENCRYPTION_SECRET is not set (32+ characters).');
  }
  // The purpose is part of what is signed, so this can never double as any other token.
  return createHmac('sha256', secret).update(`openkuasa:unsubscribe:v1:${recipientId}`, 'utf8').digest();
}

/** The token for one recipient's unsubscribe link. Throws when the server has no secret. */
export function unsubscribeToken(recipientId: string, env: EnvLike = process.env): string {
  const id = recipientId.trim().toLowerCase();
  if (!UUID.test(id)) throw new Error('A recipient id is required to make an unsubscribe link.');
  return `${id}.${sign(id, env).toString('base64url')}`;
}

/** A path segment as the browser sent it, decoded; null when it is not valid encoding. */
export function decodeToken(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The recipient a token was made for, or null when it is not one of ours. */
export function verifyUnsubscribeToken(token: string, env: EnvLike = process.env): string | null {
  const [id, signature, ...rest] = String(token).split('.');
  if (rest.length > 0 || !id || !signature || !UUID.test(id) || !SIGNATURE.test(signature)) return null;
  try {
    const given = Buffer.from(signature, 'base64url');
    const expected = sign(id, env);
    return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
  } catch {
    return null;
  }
}

export function unsubscribePath(token: string): string {
  return `/u/${token}`;
}

/** Where a mail program posts a one-click unsubscribe (RFC 8058). */
export function oneClickUnsubscribePath(token: string): string {
  return `/u/${token}/one-click`;
}

/** What the unsubscribe page shows for a checked link. */
export type UnsubscribeTarget = { orgName: string; already: boolean };

/**
 * Whose emails a checked link is about. `gone` when there is no such send on
 * record any more; `failed` when it could not be looked up, which is not the
 * same thing and must not be shown as it.
 */
export async function unsubscribeTarget(
  recipientId: string,
): Promise<{ status: 'ok'; target: UnsubscribeTarget } | { status: 'gone' } | { status: 'failed' }> {
  try {
    const { data, error } = await serviceClient().rpc('email_unsubscribe_target', { p_recipient_id: recipientId });
    if (error) {
      console.error('[unsubscribe] target could not be read:', error.code);
      return { status: 'failed' };
    }
    const row = (Array.isArray(data) ? data[0] : data) as { org_name?: unknown; already?: unknown } | null | undefined;
    if (!row || typeof row.org_name !== 'string') return { status: 'gone' };
    return { status: 'ok', target: { orgName: row.org_name, already: row.already === true } };
  } catch {
    console.error('[unsubscribe] target could not be read.');
    return { status: 'failed' };
  }
}

/**
 * Records the opt-out for a checked link. `recorded` only when the address is
 * out afterwards. `failed` means nothing was stored: the caller must say so,
 * never thank the visitor.
 */
export async function recordUnsubscribe(recipientId: string): Promise<'recorded' | 'gone' | 'failed'> {
  try {
    const { data, error } = await serviceClient().rpc('email_unsubscribe', { p_recipient_id: recipientId });
    if (error) {
      console.error('[unsubscribe] could not be recorded:', error.code);
      return 'failed';
    }
    return data === true ? 'recorded' : 'gone';
  } catch {
    console.error('[unsubscribe] could not be recorded.');
    return 'failed';
  }
}
