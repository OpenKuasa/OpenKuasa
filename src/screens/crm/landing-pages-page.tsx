import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import type { CrmFormState } from '@/lib/crm/form-state';
import {
  createLandingPage,
  deleteLandingPage,
  listLandingPageForms,
  listLandingPages,
  parseLandingPageForm,
  readLandingPageId,
  updateLandingPage,
  type LandingPage,
  type LandingPageFormChoice,
} from '@/lib/crm/landing-pages';
import { runCrmWrite } from '@/lib/crm/run-write';
import { createClient } from '@/lib/supabase/server';
import SampleLandingPageScreen from './landing-page';
import { LandingPagesView } from './landing-pages-view';

const PAGES_PATH = '/crm/landing-page';

async function saveLandingPageAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(PAGES_PATH, formData, 'Could not save the page.', async () => {
    if (formData.has('pageId')) {
      await updateLandingPage(supabase, orgId, readLandingPageId(formData), parseLandingPageForm(formData));
    } else {
      await createLandingPage(supabase, orgId, parseLandingPageForm(formData), userId);
    }
  });
}

async function deleteLandingPageAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(PAGES_PATH, formData, 'Could not delete the page.', () =>
    deleteLandingPage(supabase, orgId, readLandingPageId(formData)),
  );
}

const ACTIONS = { save: saveLandingPageAction, remove: deleteLandingPageAction };

/**
 * Kasturi's Landing Page screen: the workspace's public pages, each a headline
 * and some text over one of its lead forms. Falls back to the sample screen
 * when no database is configured.
 */
export default async function LandingPagesPage() {
  if (!hasSupabaseEnv()) return <SampleLandingPageScreen />;

  // The layout already loaded the viewer for this request; this reuses it.
  const { orgId, role } = await getViewer();
  const supabase = await createClient();

  let live: { pages: LandingPage[]; forms: LandingPageFormChoice[] } | null = null;
  try {
    const forms = await listLandingPageForms(supabase, orgId);
    live = { pages: await listLandingPages(supabase, orgId, forms), forms };
  } catch (error) {
    // The migration is applied to a database separately from a deploy, so the
    // table can be missing for a while. Keep the page up meanwhile.
    console.error('[crm/landing-page] could not load pages', error);
  }

  if (!live) return <SampleLandingPageScreen />;
  return (
    <LandingPagesView
      pages={live.pages}
      forms={live.forms}
      // Viewers can read pages but the database refuses their writes.
      actions={role === 'viewer' ? undefined : ACTIONS}
    />
  );
}
