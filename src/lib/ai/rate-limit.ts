/**
 * Per-user daily limit on chat turns that run on a workspace's own AI key,
 * backed by the Postgres `consume_ai_quota` function (see supabase/migrations).
 *
 * A workspace key has no platform allowance, so without this one signed-in
 * member (or one stolen session) could spend the workspace's credit without
 * bound. This is a backstop against a runaway, not a product quota: the number
 * is set well above what a person asks in a day.
 *
 * Fail closed: when the counter cannot be read, the turn is refused. Chat on a
 * workspace key therefore depends on `consume_ai_quota` being deployed
 * (20261030113000_ai_chat_daily_quota.sql re-declares it).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Chat turns one user may run per UTC day on a workspace key.
 *
 * Why 200: a turn is one request to a chat endpoint, and approving a change
 * the assistant proposed sends a second request, so a working conversation
 * uses up to two per question. 200 leaves a person asking something every
 * few minutes through a full working day untouched, while a script or a
 * leaked session stops after a couple of hundred model runs rather than
 * thousands. The count is per user (not per workspace) and resets at 00:00 UTC.
 */
export const WORKSPACE_KEY_TURNS_PER_DAY = 200;

export type QuotaResult =
  | { allowed: true; remaining: number }
  /** `limit`: over today's allowance. `unavailable`: the counter could not be read. */
  | { allowed: false; reason: 'limit' | 'unavailable' };

/**
 * Counts one turn for the signed-in caller and says whether it may run.
 * `supabase` must be the caller's own session client: the function counts for
 * `auth.uid()`.
 */
export async function consumeDailyQuota(
  supabase: SupabaseClient,
  limit: number = WORKSPACE_KEY_TURNS_PER_DAY,
): Promise<QuotaResult> {
  try {
    const { data, error } = await supabase.rpc('consume_ai_quota', { daily_limit: limit });
    if (error || typeof data !== 'number') {
      console.error('[chat] daily limit unavailable:', error?.message ?? 'unexpected answer');
      return { allowed: false, reason: 'unavailable' };
    }
    return data >= 0 ? { allowed: true, remaining: data } : { allowed: false, reason: 'limit' };
  } catch {
    console.error('[chat] daily limit unavailable: the call failed');
    return { allowed: false, reason: 'unavailable' };
  }
}
