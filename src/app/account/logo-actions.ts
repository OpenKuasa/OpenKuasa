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
// The demo is refused first and a member or viewer second, both before any read or call. `getViewer` sends a
// session that owes a second factor to the verify page and reads the role through `org_members`, whose
// `mfa_required` policy hides every row from such a session: for SETTING, that is the only place the second factor
// is asked (the function runs as the service role and sees no session); the database checks the acting user's role
// again. The workspace and the acting user are always the session's, never the input's, and the old file is removed
// on the server after the database has let go of it.

async function guard(): Promise<{ ok: true; orgId: string; userId: string } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (viewer.isDemo) return refuse(LOGO_DEMO);
  if (!can(viewer.role, 'manage-company')) return refuse(LOGO_REFUSALS.LOGO_NOT_ALLOWED);
  return { ok: true, orgId: viewer.orgId, userId: viewer.userId };
}

/**
 * Points the workspace at a file the browser has just uploaded (`uploadLogoFile`). The server reads the uploaded
 * bytes itself before the database is asked (`setLogo`). When the file is refused (not an image, too big, or
 * refused by the database) the unattached upload is removed. When the outcome is unknown it is kept: the change may
 * have gone through, and if it did not the sweep removes the file after a day.
 */
export async function setLogoAction(path: unknown): Promise<CapResult<{ logo_path: string }>> {
  const allowed = await guard();
  if (!allowed.ok) return allowed;
  // The path must be of the shape in the session's workspace before any session or database is touched.
  if (typeof path !== 'string' || !isLogoPath(path, allowed.orgId)) return refuse(LOGO_REFUSALS.LOGO_BAD_FILE);
  const ctx = { client: await createClient(), orgId: allowed.orgId, actorId: allowed.userId };
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
