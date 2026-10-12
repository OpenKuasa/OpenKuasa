/**
 * What makes a file a logo by its BYTES: the limits, the three signatures and the one check built on them. A leaf
 * module with no client and no server in it, so the browser (before it uploads, `logo.ts`) and the server (before it
 * points the workspace at the upload, `logo-server.ts`) read a file with the very same function. The server's look is
 * the one that counts: a crafted client can skip the browser's.
 */
import { LOGO_NOT_IMAGE, LOGO_TOO_BIG } from './logo-refusals';

export const LOGO_MAX_BYTES = 1_048_576;
/** The only types the bucket takes. SVG is never one of them. */
export const LOGO_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
/** The extension a path carries for each type. JPEG is always `.jpg`. */
export const LOGO_EXTENSION: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/** How many leading bytes {@link logoTypeOfBytes} needs to tell the three types apart. */
export const LOGO_HEAD_BYTES = 12;

/** The image type a file's first bytes announce (PNG, JPEG or WebP), else null. */
export function logoTypeOfBytes(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return 'image/png';
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  // "RIFF" + 4 size bytes + "WEBP".
  if (
    bytes.length >= 12 &&
    [0x52, 0x49, 0x46, 0x46].every((b, i) => at(i) === b) &&
    [0x57, 0x45, 0x42, 0x50].every((b, i) => at(8 + i) === b)
  ) {
    return 'image/webp';
  }
  return null;
}

/** The type a path's extension stands for (`.png`, `.jpg`, `.webp`, in small letters), else null. */
export function logoTypeOfPath(path: string): string | null {
  const extension = /\.([a-z]+)$/.exec(path)?.[1];
  return Object.keys(LOGO_EXTENSION).find((type) => LOGO_EXTENSION[type] === extension) ?? null;
}

/**
 * Why a stored file may not be a logo, as the sentence to show, or null when it may. `head` is the file's first
 * {@link LOGO_HEAD_BYTES} bytes and `size` its whole length. In the order the browser's check uses: not an image
 * (empty, or bytes that begin like none of the three), then too big, then an image of another type than its path
 * ends in.
 */
export function logoBytesRefusal(file: { size: number; head: Uint8Array; path: string }): string | null {
  if (!(file.size > 0)) return LOGO_NOT_IMAGE;
  const type = logoTypeOfBytes(file.head);
  if (!type) return LOGO_NOT_IMAGE;
  if (file.size > LOGO_MAX_BYTES) return LOGO_TOO_BIG;
  if (type !== logoTypeOfPath(file.path)) return LOGO_NOT_IMAGE;
  return null;
}
