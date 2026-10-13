/**
 * What the public form page does, for a visitor who is not signed in. Server
 * only: used by the page and its server action under `src/app/f/`, never by a
 * client component.
 *
 * A visitor has no access to any table. Each call here goes through one of the
 * three database functions made for the purpose (`get_public_form`,
 * `record_form_view`, `submit_public_form`), which decide for themselves what a
 * stranger may see and do. Reading is done with a client that carries no
 * session; the two that write are called by the server as itself, which is the
 * only caller the database allows them.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type SubmissionInput,
  type SubmissionOutcome,
  submissionOutcome,
} from './form-submissions';

/** Everything the public page knows about a form. */
export type PublicForm =
  | { accepting: true; name: string; orgName: string }
  /** A draft or paused form: nothing about it or its workspace is given out. */
  | { accepting: false };

export { createAnonymousClient } from '@/lib/supabase/anonymous';

type PublicFormRow = {
  form_name: string | null;
  org_name: string | null;
  accepting: boolean | null;
};

/**
 * The form behind a public link, or null when there is none. A lookup that
 * fails is also null (and logged): the visitor is told the page does not exist
 * rather than shown an error they can do nothing about.
 */
export async function getPublicForm(
  client: SupabaseClient,
  formId: string,
): Promise<PublicForm | null> {
  const { data, error } = await client.rpc('get_public_form', { p_form_id: formId });
  if (error) {
    console.error('[public-forms] get_public_form failed:', error);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as PublicFormRow | null | undefined;
  if (!row) return null;
  if (row.accepting !== true || !row.form_name || !row.org_name) return { accepting: false };
  return { accepting: true, name: row.form_name, orgName: row.org_name };
}

/** Who is looking, when the server counts a view as itself. */
export type FormViewer = {
  /** The signed-in visitor's id, or null: the database leaves out members of the form's workspace. */
  viewerId: string | null;
  /**
   * The client carrying the visitor's own session. Used once, to count the way
   * views were counted before, when the database answers that it has not been
   * moved on to the server-only function yet.
   */
  legacy?: SupabaseClient;
};

/** The database has no such function (yet), or does not let this caller run it (yet). */
const NOT_MOVED_ON = new Set(['PGRST202', '42501']);

/**
 * Counts one view. With `viewer`, `client` is the server's own and the visitor
 * is named; without it, `client` carries the visitor's session and the
 * database reads who they are from that. A count that fails never fails the
 * page.
 */
export async function recordFormView(
  client: SupabaseClient,
  formId: string,
  viewer?: FormViewer,
): Promise<void> {
  try {
    const { error } = await client.rpc(
      'record_form_view',
      viewer ? { p_form_id: formId, p_viewer: viewer.viewerId } : { p_form_id: formId },
    );
    if (!error) return;
    // Only these two: after any other failure the view may have been counted.
    if (viewer?.legacy && NOT_MOVED_ON.has(String(error.code))) {
      await recordFormView(viewer.legacy, formId);
      return;
    }
    console.error('[public-forms] record_form_view failed:', error);
  } catch (error) {
    console.error('[public-forms] record_form_view failed:', error);
  }
}

/**
 * Sends one checked submission. `honeypot` is what the hidden field held; the
 * database thanks and discards a submission that filled it.
 */
export async function submitPublicForm(
  client: SupabaseClient,
  formId: string,
  input: SubmissionInput,
  honeypot = '',
): Promise<SubmissionOutcome> {
  const { data, error } = await client.rpc('submit_public_form', {
    p_form_id: formId,
    p_name: input.name,
    p_email: input.email,
    p_phone: input.phone,
    p_message: input.message,
    p_honeypot: honeypot,
  });
  if (error) {
    console.error('[public-forms] submit_public_form failed:', error);
    return { kind: 'failed' };
  }
  return submissionOutcome(data);
}
