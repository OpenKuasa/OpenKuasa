// src/lib/hire/cv-store.ts
import 'server-only';
/**
 * The private bucket that holds applicants' CVs. Every write and delete goes
 * through the service-role client; a CV is a stranger's personal data, so
 * nothing here logs a path, a file name or a byte: only an error's code.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CV_MAX_BYTES } from './application-fields';

export const CV_BUCKET = 'hire-cvs';
/** How long a signed link to a CV stays good. */
export const CV_LINK_SECONDS = 300;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** True when the first five bytes are `%PDF-`: what the name or the declared type says proves nothing. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((byte, i) => bytes[i] === byte);
}

/** A fresh, random place for one CV. The upload's own file name is never used. */
export function cvPath(orgId: string, jobId: string): string {
  // Lowercase, as the database writes an id: the path is checked there against the ids as text.
  return `${orgId.toLowerCase()}/${jobId.toLowerCase()}/${randomUUID()}.pdf`;
}

/** The code of a storage failure, and nothing else about it. */
function failureCode(error: unknown): { code?: unknown } {
  const { statusCode, code, name } = (error ?? {}) as { statusCode?: unknown; code?: unknown; name?: unknown };
  return { code: statusCode ?? code ?? name };
}

/** Stores one PDF and answers its path, or null when it is not a PDF, is too big, or storage refused. */
export async function storeCv(
  service: SupabaseClient,
  orgId: string,
  jobId: string,
  bytes: Uint8Array,
): Promise<string | null> {
  if (bytes.length < 1 || bytes.length > CV_MAX_BYTES || !isPdf(bytes)) return null;
  const path = cvPath(orgId, jobId);
  try {
    const { error } = await service.storage.from(CV_BUCKET).upload(path, bytes, {
      contentType: 'application/pdf',
      upsert: false,
    });
    if (!error) return path;
    console.error('[cv-store] upload failed:', failureCode(error));
  } catch (error) {
    console.error('[cv-store] upload failed:', failureCode(error));
  }
  return null;
}

/** Whether a file is in the bucket: true, false, or null when storage could not say. */
async function cvThere(service: SupabaseClient, path: string): Promise<boolean | null> {
  const cut = path.lastIndexOf('/');
  const name = path.slice(cut + 1);
  try {
    const { data, error } = await service.storage.from(CV_BUCKET).list(path.slice(0, cut), { limit: 1, search: name });
    if (!error && Array.isArray(data)) return data.some((object) => object.name === name);
    console.error('[cv-store] look failed:', failureCode(error));
  } catch (error) {
    console.error('[cv-store] look failed:', failureCode(error));
  }
  return null;
}

/**
 * Removes stored CVs and answers the paths that are certainly gone. Storage
 * answers without an error when it removed nothing, so a path it did not name
 * counts only when a look in the bucket finds no such file.
 */
export async function removeCvs(service: SupabaseClient, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const named = new Set<string>();
  try {
    const { data, error } = await service.storage.from(CV_BUCKET).remove(paths);
    if (error) {
      console.error('[cv-store] remove failed:', failureCode(error));
      return [];
    }
    for (const object of Array.isArray(data) ? data : []) {
      if (typeof object?.name === 'string') named.add(object.name);
    }
  } catch (error) {
    console.error('[cv-store] remove failed:', failureCode(error));
    return [];
  }
  const gone: string[] = [];
  for (const path of paths) {
    if (named.has(path) || (await cvThere(service, path)) === false) gone.push(path);
  }
  return gone;
}

/** Removes one stored CV. True when it is certainly gone. */
export async function removeCv(service: SupabaseClient, path: string): Promise<boolean> {
  return (await removeCvs(service, [path])).length === 1;
}

/** A link that downloads the CV for five minutes, or null when it cannot be signed. */
export async function signedCvUrl(client: SupabaseClient, path: string): Promise<string | null> {
  try {
    const { data, error } = await client.storage.from(CV_BUCKET).createSignedUrl(path, CV_LINK_SECONDS, {
      download: 'cv.pdf',
    });
    if (!error && data?.signedUrl) return data.signedUrl;
    if (error) console.error('[cv-store] sign failed:', failureCode(error));
  } catch (error) {
    console.error('[cv-store] sign failed:', failureCode(error));
  }
  return null;
}
