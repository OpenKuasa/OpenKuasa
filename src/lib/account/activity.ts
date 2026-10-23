import { cache } from 'react';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getViewer, hasSupabaseEnv, initialsOf } from '@/lib/auth/viewer';

export const ACTIVITY_CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'auth', label: 'Sign-ins' },
  { value: 'team', label: 'Team' },
  { value: 'data', label: 'Data' },
  { value: 'security', label: 'Security' },
  { value: 'billing', label: 'Billing' },
  { value: 'mcp', label: 'AI tools' },
] as const;

export const ACTIVITY_PERIODS = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All time', days: null },
] as const;

export type ActivityCategoryFilter = (typeof ACTIVITY_CATEGORIES)[number]['value'];
export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number]['value'];

export type ActivityFilters = {
  category: ActivityCategoryFilter;
  period: ActivityPeriod;
  /** Cursor: only rows created before this timestamp. */
  before?: string;
};

export type ActivityEntry = {
  id: string;
  actorName: string;
  actorInitials: string;
  action: string;
  target: string | null;
  category: string;
  createdAt: string;
};

export type ActivityPage = {
  entries: ActivityEntry[];
  /** Cursor for the next (older) page, when there is one. */
  nextBefore: string | null;
};

export const ACTIVITY_PAGE_SIZE = 50;

const DEFAULT_FILTERS = { category: 'all', period: '30d' } as const;

// Each field falls back on its own, so one bad value (or a repeated param,
// which arrives as an array) does not reset the others.
const filtersSchema = z.object({
  category: z
    .enum(ACTIVITY_CATEGORIES.map((c) => c.value))
    .catch(DEFAULT_FILTERS.category),
  period: z
    .enum(ACTIVITY_PERIODS.map((p) => p.value))
    .catch(DEFAULT_FILTERS.period),
  before: z.iso.datetime({ offset: true }).optional().catch(undefined),
});

export function parseActivityFilters(
  searchParams: Record<string, string | string[] | undefined>,
): ActivityFilters {
  return filtersSchema.parse({
    category: searchParams.category,
    period: searchParams.period,
    before: searchParams.before,
  });
}

/** Start of the period as an ISO timestamp, or null for "all time". */
export function periodStart(
  period: ActivityPeriod,
  now: number = Date.now(),
): string | null {
  const days = ACTIVITY_PERIODS.find((p) => p.value === period)?.days;
  if (!days) return null;
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Link to the activity log with these filters; defaults are left out. */
export function activityHref(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.category !== DEFAULT_FILTERS.category) {
    params.set('category', filters.category);
  }
  if (filters.period !== DEFAULT_FILTERS.period) {
    params.set('period', filters.period);
  }
  if (filters.before) params.set('before', filters.before);
  const query = params.toString();
  return query ? `/account/activity?${query}` : '/account/activity';
}

/** One page of the viewer's workspace activity, newest first. */
export const getActivity = cache(
  async (
    category: ActivityCategoryFilter,
    period: ActivityPeriod,
    before?: string,
  ): Promise<ActivityPage> => {
    const viewer = await getViewer();
    if (!hasSupabaseEnv()) return { entries: [], nextBefore: null };

    const supabase = await createClient();
    let query = supabase
      .from('activity_log')
      .select('id, actor_name, action, target, category, created_at')
      .eq('org_id', viewer.orgId);
    if (category !== 'all') query = query.eq('category', category);
    const since = periodStart(period);
    if (since) query = query.gte('created_at', since);
    if (before) query = query.lt('created_at', before);

    // One extra row tells us whether an older page exists.
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(ACTIVITY_PAGE_SIZE + 1);
    if (error) throw error;

    const rows = (data ?? []).slice(0, ACTIVITY_PAGE_SIZE);
    const hasMore = (data?.length ?? 0) > ACTIVITY_PAGE_SIZE;
    return {
      entries: rows.map((r) => {
        const actorName = r.actor_name?.trim() || 'System';
        return {
          id: r.id,
          actorName,
          actorInitials: initialsOf(actorName),
          action: r.action,
          target: r.target ?? null,
          category: r.category,
          createdAt: r.created_at,
        };
      }),
      // The raw database timestamp keeps its microseconds, so the next page
      // starts exactly after this row.
      nextBefore: hasMore ? rows[rows.length - 1].created_at : null,
    };
  },
);
