import { usesSampleData } from '@/lib/auth/viewer';
import { createSeedReachData } from '@/lib/reach/seed';
import { getReachData } from '@/lib/reach/supabase';
import type { ReachData } from '@/lib/reach/types';
import { createClient } from '@/lib/supabase/server';

/** Reach data for a server-rendered screen, with sample data in preview (no project configured). */
export async function loadReachData(): Promise<ReachData> {
  if (usesSampleData()) return createSeedReachData();
  return getReachData(await createClient());
}
