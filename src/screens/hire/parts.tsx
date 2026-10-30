import type { ReactNode } from 'react';
import { isLiveChatAllowed } from '@/lib/ai/access';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { createSeedHireData } from '@/lib/hire/seed';
import { getHireData } from '@/lib/hire/supabase';
import type { HireData } from '@/lib/hire/types';
import { createClient } from '@/lib/supabase/server';

export function Muted({ children }: { children: ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export const LOAD_FAILED = <Muted>Couldn&apos;t load your hiring data — please refresh</Muted>;
export const NOT_AVAILABLE = <Muted>Not available yet</Muted>;

/** Chart colour for each pipeline stage, shared by every Lekir screen that draws the funnel. */
export const FUNNEL_COLOR: Record<string, string> = {
  applied: 'var(--chart-1)',
  screening: 'var(--chart-2)',
  interview: 'var(--chart-3)',
  offer: 'var(--chart-4)',
  hired: 'var(--chart-1)',
};

/**
 * Loads one Lekir screen's model for the signed-in viewer. `model` is null when
 * the read failed, so the screen can say so on its cards instead of crashing.
 * `isDemo` is true for a demo or signed-out visitor, who sees the sample look
 * on the few widgets that have no real source yet.
 */
export async function loadHire<T>(
  tag: string,
  build: (data: HireData, now: Date) => Promise<T>,
): Promise<{ model: T | null; isDemo: boolean }> {
  if (!hasSupabaseEnv()) {
    try {
      return { model: await build(createSeedHireData(), new Date()), isDemo: true };
    } catch (error) {
      console.error(`[hire/${tag}] data error:`, error);
      return { model: null, isDemo: true };
    }
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let model: T | null = null;
  try {
    model = await build(await getHireData(supabase), new Date());
  } catch (error) {
    console.error(`[hire/${tag}] data error:`, error);
  }
  return { model, isDemo: !isLiveChatAllowed(user) };
}

/** At most `max` slices: the biggest rows, with the rest folded into 'Other' so the slices sum to the total. */
export function topSlices<T>(
  rows: T[],
  valueOf: (row: T) => number,
  labelOf: (row: T) => string,
  max = 4,
): { key: string; label: string; value: number }[] {
  const slices = rows.map((r) => ({ key: labelOf(r), label: labelOf(r), value: valueOf(r) }));
  if (slices.length <= max) return slices;
  const rest = slices.slice(max - 1).reduce((sum, r) => sum + r.value, 0);
  return [...slices.slice(0, max - 1), { key: 'other', label: 'Other', value: rest }];
}
