import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { createSeedReachData } from '@/lib/reach/seed';
import { getReachData } from '@/lib/reach/supabase';
import type { ReachData } from '@/lib/reach/types';
import { createClient } from '@/lib/supabase/server';

/** Reach data for a server-rendered screen, with sample data when no project is configured. */
export async function loadReachData(): Promise<ReachData> {
  if (!hasSupabaseEnv()) return createSeedReachData();
  return getReachData(await createClient());
}
