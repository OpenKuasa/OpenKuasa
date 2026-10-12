import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type CapResult, refuse, writeFailed } from '@/lib/people/capabilities';
import { serviceClient } from '@/lib/supabase/service';
import { LOGO_HEAD_BYTES, logoBytesRefusal } from './logo-bytes';
import { LOGO_REFUSALS, LOGO_UPLOAD_FAILED } from './logo-refusals';
import { LOGO_BUCKET, LOGO_PATH, isLogoPath } from './logo-url';

/**
 * The server half of the workspace logo.
 *
 * SETTING a logo is the server's alone. The database function `set_org_logo(p_org, p_actor, p_path)` can be called
 * by the service role only: no signed-in user can point a workspace at a file themselves. Before it is called the
 * uploaded file is downloaded here with the service client and its size and leading bytes are checked with the
 * function the browser uses (`logo-bytes.ts`): the browser's check is a courtesy, this one decides. `p_actor` is the
 * user of the session the caller verified (`getViewer`), never anything from the request; the function checks that
 * they are an owner or admin of the workspace, which is not the demo, and records the activity entry in their name.
 * A session that owes a second factor never gets here: `getViewer` sends it to the verify page.
 *
 * CLEARING stays the signed-in user's call (`clear_org_logo`): it needs no look at any file.
 *
 * Both hand back the path they replaced; that file is then removed with the service client (the bucket lets no
 * signed-in user delete). A removal that fails never fails the change: the row no longer points at the file, and the
 * sweep (`POST /api/maintenance/sweep-files`, `scripts/sweep-document-files.mjs`) removes it once it is a day old.
 * Nothing typed and no path is logged, only fixed sentences and the database's code.
 */

type Ctx = { client: SupabaseClient; orgId: string };
/** For setting: `actorId` is the user of the verified session. */
type SetCtx = Ctx & { actorId: string };
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
 * Removes a logo file with the service client. Never throws. A removed logo's public address can keep answering
 * for as long as the upload asked storage to cache it (`LOGO_CACHE_SECONDS` in `logo.ts`); the file itself is gone. Only a path of the exact shape is ever passed to the
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

/** True only when storage says the object is not there, by status (never by the words of the message). */
function isNotFound(error: unknown): boolean {
  if (!isObject(error)) return false;
  return error.status === 404 || error.statusCode === '404' || error.statusCode === 404;
}

/**
 * Looks at the uploaded file itself, with the service client (the bucket has no read policy for signed-in users).
 * The path has already passed the shape and own-workspace guard. A file is written once and never changed (the
 * bucket has no update policy and the upload never upserts), so what is read here is what the path keeps holding.
 * Gives null when the bytes are a PNG, JPEG or WebP of at most 1 MB and of the type the path ends in; else the
 * refusal. A file that is not there is a refusal; a look that could not be made (a network failure, a 5xx, a throw)
 * is an unknown outcome, so the upload is kept.
 */
async function refusalOfUpload(service: SupabaseClient, path: string): Promise<CapResult<never> | null> {
  let stored: Blob | null = null;
  try {
    const { data, error } = await service.storage.from(LOGO_BUCKET).download(path);
    // storage-js hands failures back as `{ error }` (it does not throw). A missing object answers status 404, or 400
    // with statusCode '404' (storage's own code); any other failure says nothing about the file.
    if (error) return isNotFound(error) ? refuse(LOGO_UPLOAD_FAILED) : writeFailed('setLogo', { message: 'download' });
    if (!data) return writeFailed('setLogo', { message: 'download' });
    stored = data;
  } catch {
    return writeFailed('setLogo', { message: 'download' });
  }
  let head: Uint8Array;
  try {
    head = new Uint8Array(await stored.slice(0, LOGO_HEAD_BYTES).arrayBuffer());
  } catch {
    return writeFailed('setLogo', { message: 'read' });
  }
  const refusal = logoBytesRefusal({ size: stored.size, head, path });
  return refusal ? refuse(refusal) : null;
}

/**
 * Points the workspace at an uploaded file, for the acting user. In order: the path must be of the exact shape in
 * this workspace's folder; the uploaded file's bytes must be an image of the type the path ends in, at most 1 MB
 * ({@link refusalOfUpload}); then the database is asked, as the service role, and checks the acting user, the path
 * and the stored object again. On success the file it replaced (if any) is removed. The signed-in user's own client
 * is not used: they may not call the function.
 */
export async function setLogo(ctx: SetCtx, path: unknown): Promise<CapResult<{ logo_path: string }>> {
  if (typeof ctx.actorId !== 'string' || ctx.actorId === '') return refuse(LOGO_REFUSALS.LOGO_NOT_ALLOWED);
  if (typeof path !== 'string' || !isLogoPath(path, ctx.orgId)) return refuse(LOGO_REFUSALS.LOGO_BAD_FILE);
  let service: SupabaseClient;
  try {
    service = serviceClient();
  } catch {
    return writeFailed('setLogo', { message: 'service' });
  }
  const refused = await refusalOfUpload(service, path);
  if (refused) return refused;
  let reply: { data: unknown; error: DbError };
  try {
    reply = await service.rpc('set_org_logo', { p_org: ctx.orgId, p_actor: ctx.actorId, p_path: path });
  } catch {
    return writeFailed('setLogo', { message: 'call' });
  }
  const { data, error } = reply;
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
 * An upload that was refused (its bytes by the server, or the path by the database) is left unattached: remove it. It is the one file removed without the database
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
