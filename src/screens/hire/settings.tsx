import { ClipboardList } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard } from '@/components/bento/bento';
import { WorkspaceCard } from '@/components/settings/workspace-card';
import { loadWorkspaceOverview } from '@/lib/account/workspace-overview';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { applicationFormOf } from '@/lib/hire/application-form';
import { buildSettingsModel } from '@/lib/hire/settings-model';
import { ApplicationFormCard, type ApplicationFormMode } from '@/screens/hire/application-form-card';
import { LOAD_FAILED, loadHire } from '@/screens/hire/parts';
import { CareersBoardCard, PipelineCard, settingsGreeting } from '@/screens/hire/settings-cards';

export default async function SettingsScreen() {
  // Every card reads the workspace's own data. The Application form saves here; the
  // other cards link to the screen where their part is changed.
  const [{ model, isDemo }, viewer, workspace] = await Promise.all([
    loadHire('settings', buildSettingsModel),
    getViewer(),
    loadWorkspaceOverview(),
  ]);
  const demo = isDemo || viewer.isDemo;
  const formMode: ApplicationFormMode = demo ? 'demo' : can(viewer.role, 'edit-data') ? 'edit' : 'view';

  return (
    <ScreenContainer>
      <PageHeader className="mb-4" title="Settings" subtitle={settingsGreeting(viewer.orgName, demo)} />

      <BentoGrid>
        <WorkspaceCard overview={workspace} />

        <BentoCard
          title="Application form"
          subtitle="What candidates must provide"
          icon={ClipboardList}
          className="col-span-2 md:col-span-6"
        >
          {model ? <ApplicationFormCard saved={applicationFormOf(model.settings)} mode={formMode} /> : LOAD_FAILED}
        </BentoCard>

        <PipelineCard stages={model?.stages ?? null} failed={LOAD_FAILED} />
        <CareersBoardCard board={model?.board ?? null} failed={LOAD_FAILED} />
      </BentoGrid>
    </ScreenContainer>
  );
}
