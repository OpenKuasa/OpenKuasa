import type { SupabaseClient } from '@supabase/supabase-js';
import { CV_BUCKET } from '@/lib/hire/cv-store';

/**
 * Removes stored CV files whose applications were deleted. Service-role client
 * only. Paths are personal data: never logged; only an error's code is.
 * On any failure the queued rows stay, so the next run retries.
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

  const removal = await service.storage.from(CV_BUCKET).remove(paths);
  if (removal.error) {
    console.error('cv cleanup: remove failed', (removal.error as { code?: string }).code);
    return { removed: 0, failed: true };
  }

  const done = await service.rpc('hire_cv_deletions_done', { p_paths: paths });
  if (done.error) {
    console.error('cv cleanup: mark done failed', done.error.code);
    return { removed: 0, failed: true };
  }
  return { removed: paths.length, failed: false };
}
