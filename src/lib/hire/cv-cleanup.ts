import type { SupabaseClient } from '@supabase/supabase-js';
import { removeCvs } from '@/lib/hire/cv-store';

/**
 * Removes stored CV files whose applications were deleted. Service-role client
 * only. Paths are personal data: never logged; only an error's code is.
 * A row is cleared only when its file is certainly gone; the rest stay for the next run.
 */
export async function cleanCvFiles(
  service: SupabaseClient,
  limit = 100,
): Promise<{ removed: number; failed: boolean }> {
  const due = await service.rpc('hire_cv_deletions_due', { p_limit: limit });
  if (due.error) {
    console.error('cv cleanup: read failed', due.error.code);
    return { removed: 0, failed: true };
  }
  const paths = Array.isArray(due.data)
    ? due.data.filter((p): p is string => typeof p === 'string')
    : [];
  if (paths.length === 0) return { removed: 0, failed: false };

  const gone = await removeCvs(service, paths);
  if (gone.length === 0) return { removed: 0, failed: true };

  const done = await service.rpc('hire_cv_deletions_done', { p_paths: gone });
  if (done.error) {
    console.error('cv cleanup: mark done failed', done.error.code);
    return { removed: 0, failed: true };
  }
  return { removed: gone.length, failed: gone.length < paths.length };
}
