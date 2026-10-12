import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv, type Viewer } from '@/lib/auth/viewer';
import { hasKeySecret } from '@/lib/ai/key-crypto';
import { resumeBroadcast, sendBroadcast, sendTestEmail, type SendContext } from '@/lib/crm/broadcast-send';
import {
  createBroadcast,
  deleteBroadcast,
  listAudienceContacts,
  listBroadcasts,
  listEmailOptOuts,
  parseBroadcastForm,
  readBroadcastId,
  readBroadcastRevision,
  retryState,
  updateBroadcast,
  type AudienceContact,
  type Broadcast,
} from '@/lib/crm/broadcasts';
import { CrmContactFormError } from '@/lib/crm/contacts';
import {
  EmailSettingsError,
  emailKeyHint,
  getEmailKeyStatus,
  parseEmailSettings,
  sealEmailKey,
  type EmailKeyStatus,
} from '@/lib/crm/email-key';
import { checkResendKey, resendProvider } from '@/lib/crm/email-provider';
import type { CrmFormState } from '@/lib/crm/form-state';
import { runCrmWrite } from '@/lib/crm/run-write';
import { originFromHeaders } from '@/lib/reach/form-submissions';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import SampleBroadcastScreen from './broadcast';
import { BroadcastsView } from './broadcasts-view';

const BROADCAST_PATH = '/crm/broadcast';

const DEMO_ERROR = 'The demo workspace is read-only. Sign up to send broadcasts.';
const KEY_ROLE_ERROR = 'Only owners and admins can manage the email settings.';
const SEND_ROLE_ERROR = 'Only owners and admins can send a broadcast.';
const KEY_SAVE_ERROR = 'Could not save the email settings. Please try again.';

/**
 * The address written into unsubscribe links. They sit in people's inboxes
 * for years, so a site can name its one lasting address in `PUBLIC_SITE_URL`;
 * without it, the address this request came in on is used.
 */
function siteOrigin(get: (name: string) => string | null): string | null {
  const configured = process.env.PUBLIC_SITE_URL?.trim();
  if (configured && /^https?:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(configured)) return configured;
  return originFromHeaders(get);
}

/** A refusal shown beside the form; what was typed is not handed back (it may hold a key). */
function refused(error: string): CrmFormState {
  return { ok: false, error, values: {} };
}

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

/**
 * Stores the workspace's Resend key and sender. The server is the only writer
 * of a sealed key: it seals for the workspace of the verified session (never
 * an id from the form) and stores through a service-role-only function, which
 * checks again that this person is an owner or admin there. The key is never
 * logged and never handed back to the form.
 */
async function saveEmailSettingsAction(_prev: CrmFormState, formData: FormData): Promise<CrmFormState> {
  'use server';
  const viewer = await getViewer();
  if (viewer.isDemo) return refused(DEMO_ERROR);
  if (!can(viewer.role, 'manage-email-key')) return refused(KEY_ROLE_ERROR);

  let settings;
  try {
    settings = parseEmailSettings(formData);
  } catch (error) {
    if (error instanceof EmailSettingsError) return refused(error.message);
    return refused(KEY_SAVE_ERROR);
  }
  if (!hasKeySecret()) {
    return refused('This server is not set up to store keys yet (AI_KEYS_ENCRYPTION_SECRET is missing).');
  }

  const check = await checkResendKey(settings.apiKey);
  if (check === 'invalid') return refused('Resend rejected that key. Check it and try again.');
  if (check === 'unreachable') return refused('Could not reach Resend to check the key. Please try again.');

  try {
    const { error } = await serviceClient().rpc('set_org_email_key', {
      p_org: viewer.orgId,
      p_actor: viewer.userId,
      p_ciphertext: sealEmailKey(settings.apiKey, viewer.orgId),
      p_hint: emailKeyHint(settings.apiKey),
      p_sender_email: settings.senderEmail,
      p_sender_name: settings.senderName,
    });
    if (error) return refused(KEY_SAVE_ERROR);
  } catch {
    // No service role on this host. Never surface or log the key.
    return refused(KEY_SAVE_ERROR);
  }

  revalidatePath(BROADCAST_PATH);
  return { ok: true, message: 'Email settings saved.' };
}

async function removeEmailSettingsAction(_prev: CrmFormState, _formData: FormData): Promise<CrmFormState> {
  'use server';
  void _formData;
  const viewer = await getViewer();
  if (viewer.isDemo) return refused(DEMO_ERROR);
  if (!can(viewer.role, 'manage-email-key')) return refused(KEY_ROLE_ERROR);

  const supabase = await createClient();
  const { error } = await supabase.rpc('clear_org_email_key');
  if (error) return refused('Could not remove the email settings. Please try again.');

  revalidatePath(BROADCAST_PATH);
  return { ok: true, message: 'Email settings removed.' };
}

/** What a send or a test needs from the request, or why this person may not send. */
async function sendContext(): Promise<{ denied: string } | { viewer: Viewer; ctx: SendContext }> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { denied: DEMO_ERROR };
  // The database checks this again when the send is claimed.
  if (!can(viewer.role, 'send-broadcasts')) return { denied: SEND_ROLE_ERROR };
  let service;
  try {
    service = serviceClient();
  } catch {
    return { denied: 'This server is not set up to send broadcasts yet.' };
  }
  const requestHeaders = await headers();
  return {
    viewer,
    ctx: {
      session: await createClient(),
      service,
      provider: resendProvider,
      orgId: viewer.orgId,
      orgName: viewer.orgName,
      origin: siteOrigin((name) => requestHeaders.get(name)),
    },
  };
}

async function sendBroadcastAction(_prev: CrmFormState, formData: FormData): Promise<CrmFormState> {
  'use server';
  const context = await sendContext();
  if ('denied' in context) return refused(context.denied);

  let broadcastId: string;
  let revision: number;
  try {
    broadcastId = readBroadcastId(formData);
    revision = readBroadcastRevision(formData);
  } catch (error) {
    return refused(error instanceof CrmContactFormError ? error.message : 'Could not send the broadcast.');
  }

  try {
    const outcome = await sendBroadcast(context.ctx, broadcastId, revision);
    // Whatever happened, the broadcast's state may have changed.
    revalidatePath(BROADCAST_PATH);
    if (!outcome.ok) return refused(outcome.error);
    return {
      ok: true,
      message:
        outcome.failed > 0
          ? `Sent to ${outcome.sent}. ${outcome.failed} could not be sent.`
          : `Sent to ${outcome.sent}.`,
    };
  } catch (error) {
    console.error('[crm/broadcast] a send failed:', (error as { code?: unknown } | null)?.code ?? 'error');
    revalidatePath(BROADCAST_PATH);
    return refused('The send did not finish. Check the broadcast before trying anything again.');
  }
}

/** Finishes a send that was cut short, or tries again for recipients the provider did not take. */
async function resumeBroadcastAction(_prev: CrmFormState, formData: FormData): Promise<CrmFormState> {
  'use server';
  const context = await sendContext();
  if ('denied' in context) return refused(context.denied);

  let broadcastId: string;
  try {
    broadcastId = readBroadcastId(formData);
  } catch (error) {
    return refused(error instanceof CrmContactFormError ? error.message : 'Could not retry the broadcast.');
  }

  try {
    const outcome = await resumeBroadcast(context.ctx, broadcastId);
    revalidatePath(BROADCAST_PATH);
    if (!outcome.ok) return refused(outcome.error);
    return {
      ok: true,
      message:
        outcome.failed > 0
          ? `${outcome.sent} sent in all. ${outcome.failed} still could not be sent.`
          : `All ${outcome.sent} sent.`,
    };
  } catch (error) {
    console.error('[crm/broadcast] a retry failed:', (error as { code?: unknown } | null)?.code ?? 'error');
    revalidatePath(BROADCAST_PATH);
    return refused('The retry did not finish. Check the broadcast before trying again.');
  }
}

async function sendTestAction(_prev: CrmFormState, formData: FormData): Promise<CrmFormState> {
  'use server';
  const context = await sendContext();
  if ('denied' in context) return refused(context.denied);

  let broadcastId: string;
  try {
    broadcastId = readBroadcastId(formData);
  } catch (error) {
    return refused(error instanceof CrmContactFormError ? error.message : 'Could not send the test.');
  }

  try {
    const outcome = await sendTestEmail(context.ctx, broadcastId, context.viewer.email);
    if (!outcome.ok) return refused(outcome.error);
    return { ok: true, message: `Test sent to ${outcome.to}.` };
  } catch {
    return refused('The test could not be sent.');
  }
}

/**
 * Kasturi's Broadcast screen: messages written for a chosen set of contacts,
 * sent by email through the workspace's own Resend key. Falls back to the
 * sample screen when no database is configured.
 */
export default async function BroadcastsPage() {
  if (!hasSupabaseEnv()) return <SampleBroadcastScreen />;

  // The layout already loaded the viewer for this request; this reuses it.
  const viewer = await getViewer();
  const { orgId, role } = viewer;
  const supabase = await createClient();

  let live: {
    broadcasts: Broadcast[];
    contacts: AudienceContact[];
    complete: boolean;
    optOuts: string[];
    emailKey: EmailKeyStatus | null;
  } | null = null;
  try {
    // Fetched together: each trip to the database costs about the same.
    const [broadcasts, audience, optOuts, emailKey] = await Promise.all([
      listBroadcasts(supabase, orgId),
      listAudienceContacts(supabase, orgId),
      listEmailOptOuts(supabase, orgId),
      getEmailKeyStatus(supabase),
    ]);
    live = { broadcasts, ...audience, optOuts, emailKey };
  } catch (error) {
    // The migration is applied to a database separately from a deploy, so the
    // tables can be missing for a while. Keep the page up meanwhile.
    console.error('[crm/broadcast] could not load broadcasts', error);
  }

  if (!live) return <SampleBroadcastScreen />;

  const now = new Date();
  const canWrite = role !== 'viewer';
  const mayManageKey = !viewer.isDemo && can(role, 'manage-email-key');
  const maySend = !viewer.isDemo && can(role, 'send-broadcasts');
  return (
    <BroadcastsView
      broadcasts={live.broadcasts}
      contacts={live.contacts}
      contactsComplete={live.complete}
      optOuts={live.optOuts}
      emailKey={live.emailKey}
      testAddress={viewer.email}
      // Viewers can read broadcasts but the database refuses their writes.
      actions={canWrite ? { save: saveBroadcastAction, remove: deleteBroadcastAction } : undefined}
      keyActions={mayManageKey ? { save: saveEmailSettingsAction, remove: removeEmailSettingsAction } : undefined}
      sendActions={
        maySend ? { send: sendBroadcastAction, test: sendTestAction, resume: resumeBroadcastAction } : undefined
      }
      // Worked out here, once, so the server and the browser agree on "now".
      retry={Object.fromEntries(live.broadcasts.map((broadcast) => [broadcast.id, retryState(broadcast, now)]))}
    />
  );
}
