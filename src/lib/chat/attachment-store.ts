/**
 * Keeps the files sent with chat questions, so a chat opened again later
 * still shows them and Tuah can still read them. Server only. Every call runs
 * as the signed-in user, and storage policies keep each person to the folder
 * named after them.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { dataUrlBytes, isFilePart, sniffAttachment } from '@/lib/chat/attachments';
import { errorCodeOf } from '@/lib/ai/call-log';
import type { StoredFileRef } from '@/lib/chat/stored-parts';

const BUCKET = 'chat-attachments';
const SIGNED_FOR_SECONDS = 60 * 60;
/** Most a request may pull back out of storage for the model, in bytes. */
const RESOLVE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Uploads the files of a question. Resolves to what to save in their place:
 * a pointer for each file kept, and the names of any that could not be.
 */
export async function storeQuestionFiles(
  supabase: SupabaseClient,
  userId: string,
  threadId: string,
  parts: unknown,
): Promise<{ kept: StoredFileRef[]; lost: string[] }> {
  const kept: StoredFileRef[] = [];
  const lost: string[] = [];
  if (!Array.isArray(parts)) return { kept, lost };

  for (const part of parts) {
    if (!isFilePart(part)) continue;
    const name = part.filename?.trim() || 'a file';
    const bytes = dataUrlBytes(part.url);
    // Kept under the type its bytes say it is, never the label it arrived with.
    const type = bytes ? sniffAttachment(bytes, part) : null;
    if (!bytes || !type) {
      lost.push(name);
      continue;
    }
    const path = `${userId}/${threadId}/${crypto.randomUUID()}`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: type, upsert: false });
    if (error) {
      console.error('[chat] could not keep an attachment:', errorCodeOf(error));
      lost.push(name);
      continue;
    }
    kept.push({
      type: 'file',
      // Text files keep a text type so they are read as text when sent again.
      mediaType: type,
      path,
      ...(part.filename ? { filename: part.filename } : {}),
    });
  }
  return { kept, lost };
}

/** Short-lived links for showing stored files, by path. Missing ones are left out. */
export async function signStoredFiles(
  supabase: SupabaseClient,
  paths: string[],
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  if (paths.length === 0) return links;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_FOR_SECONDS);
  if (error) {
    console.error('[chat] could not open attachments:', errorCodeOf(error));
    return links;
  }
  for (const row of data ?? []) {
    if (row.path && row.signedUrl && !row.error) links.set(row.path, row.signedUrl);
  }
  return links;
}

/** The storage path a link from `signStoredFiles` points at, or null for any other URL. */
export function storedPathOf(url: string, userId: string): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  const prefix = `${base.replace(/\/$/, '')}/storage/v1/object/sign/${BUCKET}/`;
  if (!url.startsWith(prefix)) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.slice(prefix.length).split('?')[0]);
  } catch {
    return null;
  }
  // Only ever the asker's own folder; storage policies say the same.
  return /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(path) &&
    path.startsWith(`${userId}/`)
    ? path
    : null;
}

/**
 * A chat opened again sends its stored files back as links. Before the model
 * sees the conversation, each link to our own storage is swapped for the file
 * itself, so pictures, PDFs and text files are read exactly as when first
 * sent. Links to anywhere else are never fetched.
 */
export async function resolveStoredFiles(
  supabase: SupabaseClient,
  userId: string,
  messages: unknown[],
): Promise<unknown[]> {
  let budget = RESOLVE_MAX_BYTES;
  const resolved: unknown[] = [];

  for (const message of messages) {
    const parts = (message as { parts?: unknown } | null)?.parts;
    if (!Array.isArray(parts) || !parts.some((p) => isFilePart(p) && !p.url.startsWith('data:'))) {
      resolved.push(message);
      continue;
    }
    const next: unknown[] = [];
    for (const part of parts) {
      if (!isFilePart(part) || part.url.startsWith('data:')) {
        next.push(part);
        continue;
      }
      const name = part.filename?.trim() || 'a file';
      const path = storedPathOf(part.url, userId);
      const file = path ? await supabase.storage.from(BUCKET).download(path) : null;
      const bytes = file?.data ? Buffer.from(await file.data.arrayBuffer()) : null;
      // A stored file is checked like a new one: what it is comes from its bytes.
      const mediaType = bytes ? sniffAttachment(bytes, part) : null;
      if (!bytes || !mediaType || bytes.length > budget) {
        next.push({ type: 'text', text: `\n\n[Attached earlier, no longer available: ${name}]` });
        continue;
      }
      budget -= bytes.length;
      next.push({
        ...part,
        mediaType,
        url: `data:${mediaType};base64,${bytes.toString('base64')}`,
      });
    }
    resolved.push({ ...(message as object), parts: next });
  }
  return resolved;
}

/** Removes a deleted thread's files. Best effort: a failure leaves them behind. */
export async function removeThreadFiles(
  supabase: SupabaseClient,
  userId: string,
  threadId: string,
): Promise<void> {
  const folder = `${userId}/${threadId}`;
  const { data, error } = await supabase.storage.from(BUCKET).list(folder, { limit: 1000 });
  if (error) console.error('[chat] could not list attachments:', errorCodeOf(error));
  if (error || !data || data.length === 0) return;
  const { error: removeErr } = await supabase.storage
    .from(BUCKET)
    .remove(data.map((file) => `${folder}/${file.name}`));
  if (removeErr) console.error('[chat] could not remove attachments:', errorCodeOf(removeErr));
}
