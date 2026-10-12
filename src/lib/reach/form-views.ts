import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formViewCounts } from '@/lib/security/limits';
import { serviceClient } from '@/lib/supabase/service';
import { recordFormView } from './public-forms';

/**
 * Counts this request as a view of the form, if it is one to count: the first
 * by this client in the window, and (the database's rule) not a member of the
 * form's workspace previewing it. `session` is the client that carries the
 * visitor's own session, if they have one; it says who they are. The count is
 * made by the server as itself. Never fails the page.
 */
export async function countFormView(session: SupabaseClient, formId: string): Promise<void> {
  try {
    if (!(await formViewCounts(formId))) return;

    let service: SupabaseClient;
    try {
      service = serviceClient();
    } catch {
      // A host without the service key counts as it did before, as the visitor.
      await recordFormView(session, formId);
      return;
    }
    // Answers from the session's cookies alone when nobody is signed in.
    const { data } = await session.auth.getUser();
    await recordFormView(service, formId, { viewerId: data.user?.id ?? null, legacy: session });
  } catch (error) {
    const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
    console.error('[form-views] a view was not counted:', { code: code ?? name });
  }
}
