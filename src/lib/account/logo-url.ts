/**
 * The read-only half of the workspace logo: the bucket name, the shape of a path and the public address. A leaf
 * with no imports, so a member's page (the letter view) can show a logo without reaching the upload or any write.
 * `logo.ts` re-exports everything here.
 */

export const LOGO_BUCKET = 'org-logos';
/** The static sample logo the demo workspace shows wherever it has none of its own. */
export const DEMO_LOGO_PATH = '/demo-logo.png';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Exactly what the app makes and the database accepts: lower case throughout, JPEG as `.jpg`. */
export const LOGO_PATH = new RegExp(`^${UUID}/${UUID}\\.(png|jpg|webp)$`);

/** True when `path` has the exact shape and sits in this workspace's folder. */
export function isLogoPath(path: string, orgId: string): boolean {
  if (typeof path !== 'string' || !LOGO_PATH.test(path)) return false;
  return path.split('/')[0] === orgId.toLowerCase();
}

/**
 * The address of a logo anyone may fetch: the public URL of the path (formed as the avatars' is), or, for the demo
 * workspace with no logo of its own, the sample asset shipped with the app. A path of any other shape, or no project
 * configured, gives null, and a null path outside the demo gives null.
 */
export function logoUrl(path: string | null, opts: { isDemo: boolean }): string | null {
  if (path === null) return opts.isDemo ? DEMO_LOGO_PATH : null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base || !LOGO_PATH.test(path)) return null;
  return `${base.replace(/\/+$/, '')}/storage/v1/object/public/${LOGO_BUCKET}/${path}`;
}
