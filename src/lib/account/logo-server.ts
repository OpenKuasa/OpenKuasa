import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type CapResult, refuse, writeFailed } from '@/lib/people/capabilities';
import { serviceClient } from '@/lib/supabase/service';
import { LOGO_BUCKET, LOGO_PATH, isLogoPath } from './logo';
import { LOGO_REFUSALS } from './logo-refusals';

/**
 * The server half of the workspace logo. The two database functions (`set_org_logo`, `clear_org_logo`) decide who
 * may change it, check the file and record the activity entry themselves: nothing here records one. Both hand back
 * the path they replaced; that file is then removed with the service client (the bucket lets no signed-in user
 * delete). A removal that fails never fails the change: the row no longer points at the file, so it is unreachable,
 * it is left behind (a known gap: no sweep covers the `org-logos` bucket). Nothing typed and no path is logged, only fixed sentences and the database's code.
 */

type Ctx = { client: SupabaseClient; orgId: string };
type DbError = { code?: string; message?: string } | null | undefined;

const bareCode = (message: string | undefined): string | null => /^[A-Z][A-Z_]+$/.exec(message ?? '')?.[0] ?? null;

function failed(fn: string, error: DbError): CapResult<never> {
  const code = bareCode(error?.message);
  if (code && Object.hasOwn(LOGO_REFUSALS, code)) return refuse(LOGO_REFUSALS[code]);
  return writeFailed(fn, { code: error?.code });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Removes a logo file with the service client. Never throws. Only a path of the exact shape is ever passed to the
 * service role; callers pass only a path the database handed back, or an unattached upload they made (see
 * {@link discardLogoUpload}).
 */
export async function removeLogoFile(path: string): Promise<void> {
  if (typeof path !== 'string' || !LOGO_PATH.test(path)) {
    console.error('[account/logo] a logo file could not be removed.');
    return;
  }
  try {
    const { error } = await serviceClient().storage.from(LOGO_BUCKET).remove([path]);
    if (!error) return;
  } catch {
    // Not configured, or the call itself failed: the same outcome.
  }
  console.error('[account/logo] a logo file could not be removed.');
}

/** After a change, removes the file the database says it replaced: this workspace's, of the shape, and not the new one. */
async function removeReplaced(orgId: string, old: unknown, keep: string | null): Promise<void> {
  if (old === null || old === undefined) return;
  if (typeof old !== 'string' || !isLogoPath(old, orgId) || old === keep) return;
  await removeLogoFile(old);
}

/**
 * Points the workspace at an uploaded file. The path is checked to be of the exact shape in this workspace's
 * folder before the database is asked; the database checks it again, with the object in storage. On success the
 * file it replaced (if any) is removed.
 */
export async function setLogo(ctx: Ctx, path: unknown): Promise<CapResult<{ logo_path: string }>> {
  if (typeof path !== 'string' || !isLogoPath(path, ctx.orgId)) return refuse(LOGO_REFUSALS.LOGO_BAD_FILE);
  const { data, error } = await ctx.client.rpc('set_org_logo', { p_org: ctx.orgId, p_path: path });
  if (error) return failed('setLogo', error);
  if (!isObject(data) || typeof data.logo_path !== 'string' || !(data.old_path === null || typeof data.old_path === 'string')) {
    return writeFailed('setLogo', { message: 'unexpected reply' });
  }
  await removeReplaced(ctx.orgId, data.old_path, data.logo_path);
  return { ok: true, data: { logo_path: data.logo_path } };
}

/** Removes the workspace's logo. The file it pointed at is removed after the database has let go of it. */
export async function clearLogo(ctx: Ctx): Promise<CapResult<{ cleared: true }>> {
  const { data, error } = await ctx.client.rpc('clear_org_logo', { p_org: ctx.orgId });
  if (error) return failed('clearLogo', error);
  if (!isObject(data) || !(data.old_path === null || typeof data.old_path === 'string')) {
    return writeFailed('clearLogo', { message: 'unexpected reply' });
  }
  await removeReplaced(ctx.orgId, data.old_path, null);
  return { ok: true, data: { cleared: true } };
}

/**
 * An upload the database refused is left unattached: remove it. It is the one file removed without the database
 * handing its path back, so it is guarded: the path must be of the shape in THIS workspace's folder, and the
 * workspace's logo is read first and the file kept if it is that very path (a smuggled current path can never
 * delete the live logo). If that read fails or finds no row, the file is kept. Quiet.
 */
export async function discardLogoUpload(ctx: Ctx, path: string): Promise<void> {
  if (!isLogoPath(path, ctx.orgId)) return;
  try {
    const { data, error } = await ctx.client.from('orgs').select('logo_path').eq('id', ctx.orgId).maybeSingle();
    if (error || !data) throw new Error('unreadable');
    if ((data as { logo_path: string | null }).logo_path === path) return;
  } catch {
    console.error('[account/logo] an unattached logo upload was kept.');
    return;
  }
  await removeLogoFile(path);
}
