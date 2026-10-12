/**
 * What the public landing page does, for a visitor who is not signed in.
 * Server only: used by the page and its server action under `src/app/p/`,
 * never by a client component.
 *
 * A visitor has no access to the table. Reading goes through
 * `get_public_landing_page`, which decides what a stranger may see. Which form
 * a page shows, and the two counters, are the server's alone: it asks and
 * counts as itself, the only caller the database allows.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formViewCounts } from '@/lib/security/limits';
import { serviceClient } from '@/lib/supabase/service';

/** Everything the public page knows about a landing page. */
export type PublicLandingPage =
  | {
      available: true;
      orgName: string;
      headline: string;
      subheadline: string | null;
      body: string | null;
      buttonLabel: string | null;
    }
  /** A draft, or a page whose form is not taking responses: nothing about it is given out. */
  | { available: false };

type PublicLandingPageRow = {
  available: boolean | null;
  org_name: string | null;
  headline: string | null;
  subheadline: string | null;
  body: string | null;
  button_label: string | null;
};

/**
 * The page behind a public link, or null when there is none. A lookup that
 * fails is also null (and logged): the visitor is told the page does not exist
 * rather than shown an error they can do nothing about.
 */
export async function getPublicLandingPage(
  client: SupabaseClient,
  pageId: string,
): Promise<PublicLandingPage | null> {
  const { data, error } = await client.rpc('get_public_landing_page', { p_page_id: pageId });
  if (error) {
    console.error('[public-landing-pages] get_public_landing_page failed:', error);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as PublicLandingPageRow | null | undefined;
  if (!row) return null;
  if (row.available !== true || !row.org_name || !row.headline) return { available: false };
  return {
    available: true,
    orgName: row.org_name,
    headline: row.headline,
    subheadline: row.subheadline,
    body: row.body,
    buttonLabel: row.button_label,
  };
}

/**
 * The lead form an available page shows, or null when the page is not there or
 * not available. Asked by the server as itself: a visitor is never told which
 * form sits behind a page. A lookup that fails is also null (and logged).
 */
export async function landingPageFormId(pageId: string): Promise<string | null> {
  try {
    const { data, error } = await serviceClient().rpc('landing_page_form', { p_page_id: pageId });
    if (error) {
      logged('the page\'s form could not be looked up', error);
      return null;
    }
    return typeof data === 'string' && data ? data : null;
  } catch (error) {
    logged('the page\'s form could not be looked up', error);
    return null;
  }
}

function logged(what: string, error: unknown) {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  console.error(`[public-landing-pages] ${what}:`, { code: code ?? name });
}

/**
 * Counts this request as a view of the page, if it is one to count: the first
 * by this client in the window, and (the database's rule) not a member of the
 * page's workspace previewing it. `session` carries the visitor's own session,
 * if they have one; it says who they are. Never fails the page.
 */
export async function countLandingPageView(session: SupabaseClient, pageId: string): Promise<void> {
  try {
    // The same one-per-client-per-window rule as a lead form's views, keyed by the page.
    if (!(await formViewCounts(pageId))) return;
    const { data } = await session.auth.getUser();
    const { error } = await serviceClient().rpc('record_landing_page_view', {
      p_page_id: pageId,
      p_viewer: data.user?.id ?? null,
    });
    if (error) logged('a view was not counted', error);
  } catch (error) {
    logged('a view was not counted', error);
  }
}

/** Counts one lead taken through the page. Never fails the submission it follows. */
export async function countLandingPageLead(pageId: string, formId: string): Promise<void> {
  try {
    const { error } = await serviceClient().rpc('record_landing_page_lead', {
      p_page_id: pageId,
      p_form_id: formId,
    });
    if (error) logged('a lead was not counted', error);
  } catch (error) {
    logged('a lead was not counted', error);
  }
}
