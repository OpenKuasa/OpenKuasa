/**
 * The workspace logo, client-safe half. One logo per workspace, in the public `org-logos` bucket, at
 * `<org id>/<random uuid>.<png|jpg|webp>`. This file holds what is allowed, what a path looks like, how the public
 * address is formed, and the browser's upload (as the signed-in user). Pointing the workspace at a file and removing
 * a file need the server: see `logo-server.ts`. The byte check here is a courtesy to the person (a wrong file is
 * refused before it is uploaded); the server makes the same check on the uploaded file, with the same function
 * (`logo-bytes.ts`), and that one decides.
 *
 * A path is always built here from the file's TYPE, never taken from a form or from a file name, and the
 * database checks it again. Nothing here logs a file name or a path.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { type CapResult, refuse } from '@/lib/people/capabilities';
import { LOGO_EXTENSION, LOGO_HEAD_BYTES, LOGO_MAX_BYTES, LOGO_TYPES, logoTypeOfBytes } from './logo-bytes';
import { LOGO_NOT_IMAGE, LOGO_TOO_BIG, LOGO_UPLOAD_FAILED } from './logo-refusals';

import { DEMO_LOGO_PATH, LOGO_BUCKET, LOGO_PATH, isLogoPath, logoUrl } from './logo-url';

// The read-only half lives in a leaf module (`logo-url.ts`) so a member's page can import it without the upload.
export { DEMO_LOGO_PATH, LOGO_BUCKET, LOGO_PATH, isLogoPath, logoUrl };
// The limits and the byte check live in a leaf module too (`logo-bytes.ts`), which the server imports as well.
export { LOGO_MAX_BYTES, LOGO_TYPES, logoTypeOfBytes };

const EXTENSION_OF = LOGO_EXTENSION;
/**
 * How long storage may cache an uploaded logo, in seconds. The storage client's own default is an hour (3600);
 * a logo that was removed or replaced would keep answering at its old address for that long. Every logo has its
 * own random address, so a new logo never waits on a cache: only the old one's address lingers, for this long.
 */
export const LOGO_CACHE_SECONDS = '60';

type Converted<T> = { ok: true; input: T } | { ok: false; error: string };

const typeOf = (file: { type: string }): string => file.type.trim().toLowerCase();

/** The file when it can be a logo by its DECLARED type and size, else the sentence to show. Checked again by storage. */
export function pickLogoFile(file: File): Converted<File> {
  if (!LOGO_TYPES.includes(typeOf(file)) || !(file.size > 0)) return { ok: false, error: LOGO_NOT_IMAGE };
  if (file.size > LOGO_MAX_BYTES) return { ok: false, error: LOGO_TOO_BIG };
  return { ok: true, input: file };
}

/**
 * What a screen calls on a chosen file. The type is decided from the file's leading bytes (a browser may report an
 * empty or odd type for a valid image, or a wrong one); a file that does not begin like a PNG, JPEG or WebP is
 * refused whatever it says it is. The file returned carries that type, so the path's extension, the upload's type
 * and the type storage records are one value.
 */
export async function prepareLogoFile(file: File): Promise<Converted<File>> {
  if (!(file.size > 0)) return { ok: false, error: LOGO_NOT_IMAGE };
  let type: string | null = null;
  try {
    type = logoTypeOfBytes(new Uint8Array(await file.slice(0, LOGO_HEAD_BYTES).arrayBuffer()));
  } catch {
    // Unreadable: the same as not an image.
  }
  if (!type) return { ok: false, error: LOGO_NOT_IMAGE };
  if (file.size > LOGO_MAX_BYTES) return { ok: false, error: LOGO_TOO_BIG };
  return { ok: true, input: new File([file], file.name, { type }) };
}

/** `<org>/<random uuid>.<ext>`, the extension from the file's TYPE. Throws for a type that is not allowed. */
export function logoPath(orgId: string, file: File): string {
  const type = typeOf(file);
  if (!Object.hasOwn(EXTENSION_OF, type)) throw new Error('Not a logo type.');
  return `${orgId.toLowerCase()}/${crypto.randomUUID()}.${EXTENSION_OF[type]}`;
}

/**
 * Uploads a file to `path` (made by {@link logoPath}) as the signed-in user. Type, size, the path's shape and that
 * the path's extension is the type's are checked first, so the rule holds even if a screen skipped it. Never
 * `upsert`: the bucket has no update policy, so a path is only ever written once. The caller then points the
 * workspace at it (`setLogoAction`), which reads the uploaded bytes again on the server; a refusal there removes the
 * upload. Storage is asked to cache the file for {@link LOGO_CACHE_SECONDS} seconds. Nothing is logged but a fixed
 * sentence.
 */
export async function uploadLogoFile(client: SupabaseClient, path: string, file: File): Promise<CapResult<{ path: string }>> {
  const prepared = await prepareLogoFile(file);
  if (!prepared.ok) return refuse(prepared.error);
  const type = typeOf(prepared.input);
  if (!LOGO_PATH.test(path) || !path.endsWith(`.${EXTENSION_OF[type]}`)) return refuse(LOGO_UPLOAD_FAILED);
  try {
    // storage-js ignores `contentType` for a File body and records the body's own `.type`, which must be the very
    // type the path's extension stands for (the database compares the two).
    const body = new File([prepared.input], prepared.input.name, { type });
    const { error } = await client.storage
      .from(LOGO_BUCKET)
      .upload(path, body, { cacheControl: LOGO_CACHE_SECONDS, contentType: type, upsert: false });
    if (!error) return { ok: true, data: { path } };
  } catch {
    // Reported the same way as a refused upload.
  }
  console.error('[account/logo] a logo could not be uploaded.');
  return refuse(LOGO_UPLOAD_FAILED);
}
