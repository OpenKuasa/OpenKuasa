import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { serviceClient } from '@/lib/supabase/service';
import { type CapResult, refuse } from './capabilities';
import { DOCUMENT_BUCKET, DOCUMENT_PATH, isDocumentPathShape } from './document-files';
import { DOCUMENT_REFUSALS, FILE_UNAVAILABLE } from './documents-refusals';

/** How long a link to a document's file works. */
const LINK_SECONDS = 60;

/**
 * A one-minute link to a document's file, made with the CALLER's own session: the document is read first under
 * the row rule, and storage's read rule (the object is the path of a document the caller may read) decides again
 * when the link is signed. The path is read here, on the server, and goes no further: only the link is returned.
 * Nothing is logged but a fixed sentence: a path begins with the workspace's id.
 */
export async function documentLink(
  ctx: { client: SupabaseClient; orgId: string },
  documentId: string,
): Promise<CapResult<{ url: string }>> {
  if (!z.guid().safeParse(documentId).success) return refuse(DOCUMENT_REFUSALS.DOC_NOT_FOUND);
  let path: string | null;
  try {
    const { data, error } = await ctx.client
      .from('hr_documents')
      .select('file_path')
      .eq('id', documentId)
      .eq('org_id', ctx.orgId)
      .maybeSingle();
    if (error) throw error;
    path = (data as { file_path: string | null } | null)?.file_path ?? null;
    if (!data) return refuse(DOCUMENT_REFUSALS.DOC_NOT_FOUND);
  } catch {
    console.error('[people/documents] a document could not be read for a link.');
    return refuse(FILE_UNAVAILABLE);
  }
  // A document with no file (the sample company's) has nothing to open.
  if (path === null) return refuse(DOCUMENT_REFUSALS.DOC_NOT_FOUND);
  if (!isDocumentPathShape(path)) {
    console.error('[people/documents] a document link could not be made.');
    return refuse(FILE_UNAVAILABLE);
  }
  try {
    const { data, error } = await ctx.client.storage.from(DOCUMENT_BUCKET).createSignedUrl(path, LINK_SECONDS);
    if (!error && data?.signedUrl) return { ok: true, data: { url: data.signedUrl } };
  } catch {
    // Reported the same way as a refused link.
  }
  console.error('[people/documents] a document link could not be made.');
  return refuse(FILE_UNAVAILABLE);
}

/**
 * Asks the database whether an upload can go: `hr_release_document_file` answers true only when the caller could
 * have uploaded it, no document carries it, and it has been marked so none ever will. The app does not decide
 * that. Anything but exactly `true` (false, an error, a throw) means keep the file, and the answer is false.
 * Logs a fixed sentence, never the path.
 */
export async function releaseDocumentFile(ctx: { client: SupabaseClient }, path: string): Promise<boolean> {
  try {
    const { data, error } = await ctx.client.rpc('hr_release_document_file', { p_path: path });
    if (!error) return data === true;
  } catch {
    // Reported the same way as a refused call.
  }
  console.error('[people/documents] a document file could not be released.');
  return false;
}

/**
 * Removes a document file with the service client (the bucket lets no signed-in user delete). Never throws: the
 * row no longer points at the file, so a leftover is unreachable and the change stands, and the sweep will find
 * it. Logs one fixed sentence on failure, and never the path, which begins with a workspace's id.
 * Only the paths the database returned or released are ever passed here.
 */
export async function removeDocumentFile(path: string): Promise<void> {
  // The delete runs with the service role: only a path of the exact shape we make is ever passed to it.
  if (!DOCUMENT_PATH.test(path)) {
    console.error('[people/documents] a document file could not be removed.');
    return;
  }
  try {
    const { error } = await serviceClient().storage.from(DOCUMENT_BUCKET).remove([path]);
    if (!error) return;
  } catch {
    // Not configured, or the call itself failed: the same outcome.
  }
  console.error('[people/documents] a document file could not be removed.');
}

/** Removes each path on its own, in order, one call each; a failure on one does not stop the rest. */
export async function removeDocumentFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) await removeDocumentFile(path);
}
