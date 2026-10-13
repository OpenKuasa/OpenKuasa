import type { SupabaseClient } from '@supabase/supabase-js';
import { safeCount } from './documents-screens';

/** Requests waiting for the signed-in person to decide, by kind: the figures on the four approval nav badges. */
export type WaitingCounts = { leave: number; time_off: number; claims: number; overtime: number };

export const ZERO_WAITING: WaitingCounts = { leave: 0, time_off: 0, claims: 0, overtime: 0 };

/** What `hr_waiting_counts` returns, each figure a whole number from 0 up; anything else reads as zeros. */
export function parseWaitingCounts(data: unknown): WaitingCounts {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ...ZERO_WAITING };
  const row = data as Record<string, unknown>;
  return {
    leave: safeCount(row.leave),
    time_off: safeCount(row.time_off),
    claims: safeCount(row.claims),
    overtime: safeCount(row.overtime),
  };
}

export function waitingTotal(counts: WaitingCounts): number {
  return counts.leave + counts.time_off + counts.claims + counts.overtime;
}

/**
 * A signed-in member of a real workspace. Not narrower: the database answers zeros for anyone who can decide
 * nothing, in one call.
 */
export function shouldReadWaiting(input: { isDemo: boolean; orgId: string | null | undefined }): boolean {
  return !input.isDemo && Boolean(input.orgId);
}

/**
 * The four counts, read so that a failure is a failure. (`readWaitingCounts` turns one into zeros, which is right for a
 * navigation badge and wrong for a sentence: "nothing is waiting" must never be what a broken read says.)
 */
export async function readWaitingCountsStrict(ctx: { client: SupabaseClient; orgId: string }): Promise<WaitingCounts> {
  const { data, error } = await ctx.client.rpc('hr_waiting_counts', { p_org: ctx.orgId });
  if (error) throw new Error(`hr_waiting_counts failed: ${error.code ?? 'no-code'}`);
  return parseWaitingCounts(data);
}

/**
 * The four counts in one database call. It runs on every Lekiu page load, so it never throws: any failure reads as
 * zeros, and a log line carries the database's code and nothing else.
 */
export async function readWaitingCounts(ctx: { client: SupabaseClient; orgId: string }): Promise<WaitingCounts> {
  try {
    const { data, error } = await ctx.client.rpc('hr_waiting_counts', { p_org: ctx.orgId });
    if (error) {
      console.error('[people-layout] waiting counts failed:', error.code ?? 'no-code');
      return { ...ZERO_WAITING };
    }
    return parseWaitingCounts(data);
  } catch (error) {
    console.error('[people-layout] waiting counts failed:', error instanceof Error ? error.name : 'error');
    return { ...ZERO_WAITING };
  }
}
