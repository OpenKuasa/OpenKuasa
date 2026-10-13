import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Proof that this browser's session came from a password-recovery link.
 *
 * `/auth/confirm` sets it when a recovery link verifies; the "set a new
 * password" action requires it and then removes it. Without it, that action
 * would let any signed-in session set a password without knowing the current
 * one, which the change-password form deliberately does not allow.
 *
 * Why a cookie and not the session's `amr` claim: the claim describes the
 * session for as long as it lives, where this should last minutes and be used
 * once; and the verified link type is known for certain in `/auth/confirm`,
 * so that is where the proof is minted.
 *
 * The value is signed, so it cannot be made up in the browser, and it is tied
 * to the user it was issued for.
 */
export const RECOVERY_COOKIE = 'ok_pw_recovery';
export const RECOVERY_MAX_AGE_SECONDS = 15 * 60;

const MIN_SECRET_LENGTH = 32;
const PURPOSE = 'openkuasa:password-recovery-marker:v1';
const FALLBACK_KEY = Symbol.for('openkuasa.recoveryMarkerKey');

type EnvLike = Record<string, string | undefined>;

/**
 * Signing key, in order of preference:
 *  1. `AUTH_COOKIE_SECRET`, when the host sets one;
 *  2. the server's existing `AI_KEYS_ENCRYPTION_SECRET`. It is only ever used
 *     as HMAC key material under a purpose label of its own, so nothing
 *     signed here can stand in for anything sealed with it elsewhere;
 *  3. a random key made when the server process starts. Good for a single
 *     long-running server; a host with several instances (or one that
 *     restarts between the link and the form) needs one of the two above.
 */
function signingKey(env: EnvLike): Buffer {
  const usable = (value: string | undefined) => {
    const secret = value?.trim() ?? '';
    return secret.length >= MIN_SECRET_LENGTH ? secret : null;
  };
  const secret =
    usable(env.AUTH_COOKIE_SECRET) ?? usable(env.AI_KEYS_ENCRYPTION_SECRET);
  // Never the secret itself: a key derived from it for this purpose alone.
  if (secret) return createHmac('sha256', secret).update(PURPOSE).digest();

  // Kept on globalThis so every server bundle in the process shares it.
  const store = globalThis as { [FALLBACK_KEY]?: Buffer };
  store[FALLBACK_KEY] ??= randomBytes(32);
  return store[FALLBACK_KEY];
}

function sign(userId: string, issuedAt: number, env: EnvLike): string {
  return createHmac('sha256', signingKey(env))
    .update(`${PURPOSE}\n${userId}\n${issuedAt}`)
    .digest('base64url');
}

/** The cookie value for a user whose recovery link has just been verified. */
export function issueRecoveryMarker(
  userId: string,
  now: number = Date.now(),
  env: EnvLike = process.env,
): string {
  return `${now}.${sign(userId, now, env)}`;
}

/** True when the value was issued by this server, for this user, recently. */
export function isRecoveryMarkerValid(
  value: string | null | undefined,
  userId: string,
  now: number = Date.now(),
  env: EnvLike = process.env,
): boolean {
  if (!value) return false;
  const [stamp, signature, ...extra] = value.split('.');
  if (!signature || extra.length > 0 || !/^\d{1,16}$/.test(stamp)) return false;

  const issuedAt = Number(stamp);
  const age = now - issuedAt;
  // A small allowance for clocks; nothing issued "in the future" beyond it.
  if (age > RECOVERY_MAX_AGE_SECONDS * 1000 || age < -60_000) return false;

  const expected = Buffer.from(sign(userId, issuedAt, env));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Options for setting the cookie; it never needs to be read by scripts. */
export function recoveryCookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: RECOVERY_MAX_AGE_SECONDS,
  };
}
