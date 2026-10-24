import 'server-only';
import { getViewer } from '@/lib/auth/viewer';
import { todayInMalaysia } from '@/lib/people/dates';
import { createClient } from '@/lib/supabase/server';
import { assembleServerGreeting } from './assemble';
import { readAllCounts, readProductCounts, withTimeout, type CountsCtx } from './counts';
import type { NudgeCounts, ServerGreeting, Surface } from './types';

type Holiday = { date: string; name: string };

const TUAH_COUNTS_TIMEOUT_MS = 1500;

async function readCounts(ctx: CountsCtx, surface: Surface): Promise<NudgeCounts> {
  try {
    if (surface === 'tuah') {
      return await withTimeout<NudgeCounts>(readAllCounts(ctx), TUAH_COUNTS_TIMEOUT_MS, {});
    }
    return await readProductCounts(ctx, surface);
  } catch {
    return {};
  }
}

async function readHolidays(ctx: CountsCtx): Promise<Holiday[]> {
  try {
    const { data, error } = await ctx.client
      .from('hr_public_holidays')
      .select('name, holiday_date')
      .eq('org_id', ctx.orgId)
      .eq('holiday_date', todayInMalaysia(ctx.now));
    if (error || !data) return [];
    return data.map((row: { name: string; holiday_date: string }) => ({
      date: row.holiday_date,
      name: row.name,
    }));
  } catch {
    return [];
  }
}

/** The greeting for a surface, computed on the server. Never throws on a failed read. */
export async function loadServerGreeting(surface: Surface): Promise<ServerGreeting> {
  const viewer = await getViewer();
  const now = new Date();
  const base = { now, surface, role: viewer.role, userId: viewer.userId };

  if (viewer.isDemo) {
    return assembleServerGreeting({ ...base, isDemo: true, counts: {}, workspaceHolidays: [] });
  }

  let client: CountsCtx['client'];
  try {
    client = await createClient();
  } catch {
    return assembleServerGreeting({ ...base, isDemo: false, counts: {}, workspaceHolidays: [] });
  }
  const ctx: CountsCtx = { client, orgId: viewer.orgId, userId: viewer.userId, now };
  const [counts, workspaceHolidays] = await Promise.all([
    readCounts(ctx, surface),
    readHolidays(ctx),
  ]);
  return assembleServerGreeting({ ...base, isDemo: false, counts, workspaceHolidays });
}
