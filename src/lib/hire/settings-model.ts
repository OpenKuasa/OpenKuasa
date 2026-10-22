// src/lib/hire/settings-model.ts
/**
 * What the hiring Settings screen shows: the stages with their live counts, the
 * careers page's state, and the settings the application form card edits.
 */

import { STAGE_LABEL, boardCounts } from './applications-view';
import { isListedOnBoard } from './lists';
import { APPLICATION_STAGES, type ApplicationStage, type HireData, type HireSettings } from './types';

export type SettingsModel = {
  settings: HireSettings;
  /** The five stages in order, each with how many live applications sit in it now. */
  stages: { stage: ApplicationStage; label: string; count: number }[];
  board: {
    /** Whether the careers page is on. */
    enabled: boolean;
    /** The workspace the page belongs to; null only for the sample data. */
    orgId: string | null;
    /** Jobs the page shows while it is on: open, with a description. */
    listed: number;
    /** Open jobs the page leaves out because they have no description. */
    hiddenOpen: number;
  };
};

export async function buildSettingsModel(data: HireData): Promise<SettingsModel> {
  const [settings, jobs, apps] = await Promise.all([data.getSettings(), data.listJobs(), data.listApplications()]);
  const counts = boardCounts(apps);
  const open = jobs.filter((j) => j.status === 'open');
  const listed = open.filter(isListedOnBoard).length;
  return {
    settings,
    stages: APPLICATION_STAGES.map((stage) => ({ stage, label: STAGE_LABEL[stage], count: counts[stage] })),
    board: { enabled: settings.careers_enabled, orgId: settings.org_id, listed, hiddenOpen: open.length - listed },
  };
}
