import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { CrmContactFormError } from '@/lib/crm/contacts';
import { getEmailKeyStatus } from '@/lib/crm/email-key';
import type { CrmFormState } from '@/lib/crm/form-state';
import { listCrmPipelines } from '@/lib/crm/pipelines';
import { runCrmWrite } from '@/lib/crm/run-write';
import {
  loadCrmSettings,
  loadMyKasturiNotifications,
  parseCrmSettingsForm,
  parseMyNotificationsForm,
  saveCrmSettings,
  saveMyKasturiNotifications,
} from '@/lib/crm/settings';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import SampleSettingsScreen from './settings';
import { CrmSettingsView, type CrmSettingsOverview } from './settings-view';

const SETTINGS_PATH = '/crm/settings';
// Matches the live view's header, so a failed load still reads as this screen.
const SUBTITLE = "Kasturi's own rules and notifications, and where the rest of your workspace is set.";

async function saveRulesAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(SETTINGS_PATH, formData, 'Could not save the deal rule.', () =>
    saveCrmSettings(supabase, orgId, parseCrmSettingsForm(formData), userId),
  );
}

async function saveNotificationsAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { userId, isDemo } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(SETTINGS_PATH, formData, 'Could not save your notifications.', async () => {
    // A demo guest's preferences are not theirs to keep, whatever the screen offered.
    if (isDemo) throw new CrmContactFormError('The demo workspace is read-only. Sign up to save changes.');
    await saveMyKasturiNotifications(supabase, userId, parseMyNotificationsForm(formData));
  });
}

/** The counts the screen shows beside its links. A count that cannot be read is shown as unknown, not as zero. */
async function count(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  const { count: total, error } = await query;
  return error ? null : (total ?? 0);
}

/**
 * Kasturi's Settings screen: the workspace's deal rule, the signed-in
 * person's Kasturi notifications, the contacts export, and where everything
 * else about the workspace is set. Falls back to the sample screen only when
 * no database is configured; once one is, a failed load says so instead.
 */
export default async function CrmSettingsPage() {
  if (!hasSupabaseEnv()) return <SampleSettingsScreen />;

  // The layout already loaded the viewer for this request; this reuses it.
  const { orgId, userId, role, isDemo, orgName } = await getViewer();
  const supabase = await createClient();

  let live: {
    settings: Awaited<ReturnType<typeof loadCrmSettings>>;
    notifications: Awaited<ReturnType<typeof loadMyKasturiNotifications>>;
    overview: CrmSettingsOverview;
  } | null = null;
  try {
    // Fetched together: each trip to the database costs about the same.
    const [settings, notifications, pipelines, org, members, contacts, pagesWithChat, automationsOn, aiKey, emailKey] =
      await Promise.all([
        loadCrmSettings(supabase, orgId),
        loadMyKasturiNotifications(supabase, userId),
        listCrmPipelines(supabase, orgId),
        supabase.from('orgs').select('name,registration_no').eq('id', orgId).maybeSingle(),
        count(supabase.from('org_members').select('user_id', { count: 'exact', head: true }).eq('org_id', orgId)),
        count(supabase.from('crm_contacts').select('id', { count: 'exact', head: true }).eq('org_id', orgId)),
        count(
          supabase
            .from('crm_landing_pages')
            .select('id', { count: 'exact', head: true })
            .eq('org_id', orgId)
            .eq('chat_enabled', true)
            .eq('status', 'published'),
        ),
        count(
          supabase
            .from('crm_automations')
            .select('id', { count: 'exact', head: true })
            .eq('org_id', orgId)
            .eq('enabled', true),
        ),
        supabase.rpc('org_ai_key_status'),
        getEmailKeyStatus(supabase),
      ]);
    // A failed check is not an answer: "Not set" could lead an owner to
    // replace a working key, and a missing name would show the wrong company.
    if (aiKey.error) throw aiKey.error;
    if (org.error) throw org.error;
    const company = org.data as { name?: string; registration_no?: string | null } | null;
    live = {
      settings,
      notifications,
      overview: {
        companyName: company?.name ?? orgName,
        registrationNo: company?.registration_no ?? '',
        members,
        contacts,
        pipelines: pipelines.map((pipeline) => ({
          id: pipeline.id,
          name: pipeline.name,
          isDefault: pipeline.isDefault,
          stages: pipeline.stages.length,
        })),
        hasAiKey: Array.isArray(aiKey.data) ? aiKey.data.length > 0 : Boolean(aiKey.data),
        emailSender: emailKey?.senderEmail ?? null,
        pagesWithChat,
        automationsOn,
      },
    };
  } catch (error) {
    // The page stays up, but never with made-up settings in place of the
    // workspace's own.
    console.error('[crm/settings] could not load the settings', error);
  }

  if (!live) {
    return (
      <ScreenContainer>
        <PageHeader title="Settings" subtitle={SUBTITLE} />
        <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
          Couldn&apos;t load your settings — please refresh
        </p>
      </ScreenContainer>
    );
  }
  const admin = role === 'owner' || role === 'admin';
  return (
    <CrmSettingsView
      {...live}
      // The deal rule is the workspace's: owners and admins change it.
      saveRules={admin ? saveRulesAction : undefined}
      // A demo guest's preferences are not theirs to keep.
      saveNotifications={isDemo ? undefined : saveNotificationsAction}
      canExport={admin}
    />
  );
}
