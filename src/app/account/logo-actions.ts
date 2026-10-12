'use server';

import { revalidatePath } from 'next/cache';
import { isLogoPath } from '@/lib/account/logo';
import { clearLogo, discardLogoUpload, setLogo } from '@/lib/account/logo-server';
import { LOGO_DEMO, LOGO_REFUSALS } from '@/lib/account/logo-refusals';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { type CapResult, refuse, writeOutcome } from '@/lib/people/capabilities';
import { createClient } from '@/lib/supabase/server';

// The logo is changed in the database by two functions that record their own activity entry: nothing here does.
// The demo is refused first and a member or viewer second, both before any read or call; the database checks the
// role and the second factor again. The workspace is always the session's, never the input's, and the old file is
// removed on the server after the database has let go of it.

async function guard(): Promise<{ ok: true; orgId: string } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (viewer.isDemo) return refuse(LOGO_DEMO);
  if (!can(viewer.role, 'manage-company')) return refuse(LOGO_REFUSALS.LOGO_NOT_ALLOWED);
  return { ok: true, orgId: viewer.orgId };
}

/**
 * Points the workspace at a file the browser has just uploaded (`uploadLogoFile`). When the database definitely
 * refuses, the unattached upload is removed. When the outcome is unknown, it is kept: the change may have gone through.
 */
export async function setLogoAction(path: unknown): Promise<CapResult<{ logo_path: string }>> {
  const allowed = await guard();
  if (!allowed.ok) return allowed;
  // The path must be of the shape in the session's workspace before any session or database is touched.
  if (typeof path !== 'string' || !isLogoPath(path, allowed.orgId)) return refuse(LOGO_REFUSALS.LOGO_BAD_FILE);
  const ctx = { client: await createClient(), orgId: allowed.orgId };
  const result = await setLogo(ctx, path);
  if (!result.ok) {
    if (writeOutcome(result) === 'refused') await discardLogoUpload(ctx, path);
    return result;
  }
  revalidatePath('/', 'layout');
  return result;
}

/** Removes the workspace's logo (the second step is the screen's). */
export async function clearLogoAction(): Promise<CapResult<{ cleared: true }>> {
  const allowed = await guard();
  if (!allowed.ok) return allowed;
  const result = await clearLogo({ client: await createClient(), orgId: allowed.orgId });
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}
