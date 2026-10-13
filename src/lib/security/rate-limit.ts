import 'server-only';
import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '@/lib/supabase/service';

/**
 * Counting attempts, in the database, so that every replica and every restart
 * sees the same count. One call counts one event against each limit it is
 * given and answers whether all of them still have room.
 *
 * Only the server asks: the database function is granted to the service role
 * alone. What is counted against (an address, an email) never leaves this
 * file as itself; the database is sent, and stores, a keyed hash.
 *
 * When the counter cannot be asked (the function is not there yet, the service
 * role is not configured, the database is not answering) the request goes
 * through as it did before there was a counter, and the reason is logged. A
 * limit that failed closed would turn any database hiccup into "nobody can
 * sign in".
 */

/** One limit to count an event against. */
export type RateLimitCheck = {
  /** Which limit this is: lower-case letters, digits and underscores. */
  bucket: string;
  /** Who or what is counted. Hashed before it is sent. */
  value: string;
  /** How many events the window allows. */
  limit: number;
  windowSeconds: number;
};

export type RateLimitVerdict =
  /** `enforced` is false when the counter could not be asked and the request was let through uncounted. */
  | { allowed: true; enforced: boolean }
  | { allowed: false; retryAfterSeconds: number };

/** Keeps these hashes apart from any other use of the same pepper, and is the whole key when there is none. */
const NAMESPACE = 'openkuasa:rate-limit:v1';

/**
 * The stored form of what is counted: HMAC-SHA-256 over bucket and value,
 * keyed with `RATE_LIMIT_PEPPER` when the host sets one. Without the pepper
 * the hash still keeps raw addresses and emails out of the table, but someone
 * holding the table could test guesses against it.
 */
export function hashKey(bucket: string, value: string): string {
  const pepper = process.env.RATE_LIMIT_PEPPER?.trim() ?? '';
  return createHmac('sha256', `${NAMESPACE}:${pepper}`).update(`${bucket}\n${value}`).digest('hex');
}

/** Seconds as the whole minutes a person is told to wait: never zero. */
export function retryMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

const UNENFORCED: RateLimitVerdict = { allowed: true, enforced: false };

type Answer = { allowed?: unknown; retry_after_seconds?: unknown };

/**
 * Counts one event against every check, in one round trip, and says whether
 * all of them had room. Every check is counted even when another refuses.
 */
export async function consumeRateLimits(
  checks: readonly RateLimitCheck[],
  client?: Pick<SupabaseClient, 'rpc'>,
): Promise<RateLimitVerdict> {
  if (checks.length === 0) return { allowed: true, enforced: true };
  try {
    const db = client ?? serviceClient();
    const { data, error } = await db.rpc('consume_rate_limits', {
      p_checks: checks.map((check) => ({
        bucket: check.bucket,
        key: hashKey(check.bucket, check.value),
        limit: check.limit,
        window_seconds: check.windowSeconds,
      })),
    });
    if (error) {
      // The code only: it says which of "not deployed yet" and "broken" this is, and names nobody.
      console.error('[rate-limit] not enforced, consume_rate_limits failed:', { code: error.code });
      return UNENFORCED;
    }
    const row = (Array.isArray(data) ? data[0] : data) as Answer | null | undefined;
    if (!row || typeof row.allowed !== 'boolean') {
      console.error('[rate-limit] not enforced, consume_rate_limits gave no answer');
      return UNENFORCED;
    }
    if (row.allowed) return { allowed: true, enforced: true };
    const retry = Number(row.retry_after_seconds);
    return { allowed: false, retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60 };
  } catch (error) {
    const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
    console.error('[rate-limit] not enforced:', { code: code ?? name });
    return UNENFORCED;
  }
}
