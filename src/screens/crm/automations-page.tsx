import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  automationStats,
  createAutomation,
  deleteAutomation,
  listAutomations,
  listRecentRuns,
  listRunsSince,
  parseAutomationForm,
  readAutomationId,
  runsSince,
  setAutomationEnabled,
  updateAutomation,
  type Automation,
  type AutomationChoice,
  type AutomationRun,
  type AutomationStats,
} from '@/lib/crm/automations';
import type { CrmFormState } from '@/lib/crm/form-state';
import { listLandingPageForms } from '@/lib/crm/landing-pages';
import { listCrmPipelines } from '@/lib/crm/pipelines';
import { runCrmWrite } from '@/lib/crm/run-write';
import { createClient } from '@/lib/supabase/server';
import SampleAutomationsScreen from './automations';
import { AutomationsView } from './automations-view';

const AUTOMATIONS_PATH = '/crm/automations';

async function saveAutomationAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(AUTOMATIONS_PATH, formData, 'Could not save the automation.', async () => {
    if (formData.has('automationId')) {
      await updateAutomation(supabase, orgId, readAutomationId(formData), parseAutomationForm(formData));
    } else {
      await createAutomation(supabase, orgId, parseAutomationForm(formData), userId);
    }
  });
}

async function switchAutomationAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(AUTOMATIONS_PATH, formData, 'Could not switch the automation.', () =>
    setAutomationEnabled(supabase, orgId, readAutomationId(formData), formData.get('enabled') === 'on'),
  );
}

async function deleteAutomationAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(AUTOMATIONS_PATH, formData, 'Could not delete the automation.', () =>
    deleteAutomation(supabase, orgId, readAutomationId(formData)),
  );
}

const ACTIONS = {
  save: saveAutomationAction,
  switch: switchAutomationAction,
  remove: deleteAutomationAction,
};

/**
 * Kasturi's Automations screen: rules of the form "when this happens, do
 * that", which the database runs by itself. Falls back to the sample screen
 * when no database is configured.
 */
export default async function AutomationsPage() {
  if (!hasSupabaseEnv()) return <SampleAutomationsScreen />;

  // The layout already loaded the viewer for this request; this reuses it.
  const { orgId, role } = await getViewer();
  const supabase = await createClient();
  const now = new Date();

  let live: {
    automations: Automation[];
    stages: AutomationChoice[];
    forms: AutomationChoice[];
    recent: AutomationRun[];
    stats: AutomationStats;
    runsComplete: boolean;
  } | null = null;
  try {
    // Fetched together: each trip to the database costs about the same.
    const [automations, pipelines, forms, runs] = await Promise.all([
      listAutomations(supabase, orgId),
      listCrmPipelines(supabase, orgId),
      listLandingPageForms(supabase, orgId),
      listRunsSince(supabase, orgId, runsSince(now)),
    ]);
    const recent = await listRecentRuns(supabase, orgId, automations);
    // A stage is named with its pipeline when the workspace has more than one.
    const many = pipelines.length > 1;
    live = {
      automations,
      stages: pipelines.flatMap((pipeline) =>
        pipeline.stages.map((stage) => ({
          id: stage.id,
          label: many ? `${stage.name} (${pipeline.name})` : stage.name,
        })),
      ),
      forms: forms.map((form) => ({ id: form.id, label: form.name })),
      recent,
      stats: automationStats(automations, runs.runs, now),
      runsComplete: runs.complete,
    };
  } catch (error) {
    // The migration is applied to a database separately from a deploy, so the
    // tables can be missing for a while. Keep the page up meanwhile.
    console.error('[crm/automations] could not load automations', error);
  }

  if (!live) return <SampleAutomationsScreen />;
  return (
    <AutomationsView
      {...live}
      // Viewers can read automations but the database refuses their writes.
      actions={role === 'viewer' ? undefined : ACTIONS}
    />
  );
}
