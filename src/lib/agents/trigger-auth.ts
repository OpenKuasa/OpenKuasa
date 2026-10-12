import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';

/** A `CRON_SECRET` shorter than this is treated as unset. */
export const CRON_SECRET_MIN_LENGTH = 32;

/**
 * Transition switch. While it is on, a scheduler that still sends the
 * service-role key is accepted and each such call logs a deprecation warning.
 * On unless `CRON_ALLOW_LEGACY_KEY` is `false`, `0`, `off` or `no`. Once the
 * scheduler sends `CRON_SECRET`, set it to `false`; a follow-up then removes the
 * legacy path and this switch.
 */
function legacyKeyAllowed(): boolean {
  const flag = (process.env.CRON_ALLOW_LEGACY_KEY ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(flag);
}

/** Constant-time equality. Digests have one length, so unequal inputs never throw. */
function sameSecret(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function pathOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return 'unknown';
  }
}

/**
 * Authorizes a scheduler (cron) request.
 *
 * The credential is the dedicated `CRON_SECRET`, sent as
 * `Authorization: Bearer <secret>`. It fails closed: an unset, empty or
 * too-short `CRON_SECRET` accepts nothing on this path.
 *
 * Transition (see `legacyKeyAllowed`): the service-role key is still accepted,
 * as `x-service-key: <key>` or as a bearer token, exactly as before, so a
 * deploy without `CRON_SECRET` keeps existing schedulers working.
 *
 * Never logs a header value, the secret or the key.
 */
export function isTriggerAuthorized(req: Request): boolean {
  const bearer = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';

  // Trimmed: a pasted value can end in a newline, which a request header never carries.
  const secret = (process.env.CRON_SECRET ?? '').trim();
  if (bearer && secret.length >= CRON_SECRET_MIN_LENGTH && sameSecret(bearer, secret)) return true;

  if (!legacyKeyAllowed()) return false;
  const legacyKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!legacyKey) return false;
  const candidates = [bearer, req.headers.get('x-service-key') ?? ''].filter(Boolean);
  if (!candidates.some((candidate) => sameSecret(candidate, legacyKey))) return false;

  console.warn(
    `[cron] ${pathOf(req)} was authorized with the service-role key, which is deprecated: send "Authorization: Bearer <CRON_SECRET>" instead, then set CRON_ALLOW_LEGACY_KEY=false.`,
  );
  return true;
}
