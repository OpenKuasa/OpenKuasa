import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  createBroadcast,
  deleteBroadcast,
  listAudienceContacts,
  listBroadcasts,
  parseBroadcastForm,
  readBroadcastId,
  updateBroadcast,
  type AudienceContact,
  type Broadcast,
} from '@/lib/crm/broadcasts';
import type { CrmFormState } from '@/lib/crm/form-state';
import { runCrmWrite } from '@/lib/crm/run-write';
import { createClient } from '@/lib/supabase/server';
import SampleBroadcastScreen from './broadcast';
import { BroadcastsView } from './broadcasts-view';

const BROADCAST_PATH = '/crm/broadcast';

async function saveBroadcastAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(BROADCAST_PATH, formData, 'Could not save the broadcast.', async () => {
    if (formData.has('broadcastId')) {
      await updateBroadcast(supabase, orgId, readBroadcastId(formData), parseBroadcastForm(formData));
    } else {
      await createBroadcast(supabase, orgId, parseBroadcastForm(formData), userId);
    }
  });
}

async function deleteBroadcastAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(BROADCAST_PATH, formData, 'Could not delete the broadcast.', () =>
    deleteBroadcast(supabase, orgId, readBroadcastId(formData)),
  );
}

const ACTIONS = { save: saveBroadcastAction, remove: deleteBroadcastAction };

/**
 * Kasturi's Broadcast screen: messages written for a chosen set of contacts.
 * Nothing is sent from here yet; a broadcast's recipients can be exported and
 * its message copied. Falls back to the sample screen when no database is
 * configured.
 */
export default async function BroadcastsPage() {
  if (!hasSupabaseEnv()) return <SampleBroadcastScreen />;

  // The layout already loaded the viewer for this request; this reuses it.
  const { orgId, role } = await getViewer();
  const supabase = await createClient();

  let live: { broadcasts: Broadcast[]; contacts: AudienceContact[]; complete: boolean } | null = null;
  try {
    // Fetched together: each trip to the database costs about the same.
    const [broadcasts, audience] = await Promise.all([
      listBroadcasts(supabase, orgId),
      listAudienceContacts(supabase, orgId),
    ]);
    live = { broadcasts, ...audience };
  } catch (error) {
    // The migration is applied to a database separately from a deploy, so the
    // table can be missing for a while. Keep the page up meanwhile.
    console.error('[crm/broadcast] could not load broadcasts', error);
  }

  if (!live) return <SampleBroadcastScreen />;
  return (
    <BroadcastsView
      broadcasts={live.broadcasts}
      contacts={live.contacts}
      contactsComplete={live.complete}
      // Viewers can read broadcasts but the database refuses their writes.
      actions={role === 'viewer' ? undefined : ACTIONS}
    />
  );
}
