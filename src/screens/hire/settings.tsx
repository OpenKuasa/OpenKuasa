import { ClipboardList } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard } from '@/components/bento/bento';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { applicationFormOf } from '@/lib/hire/application-form';
import { ApplicationFormCard, type ApplicationFormMode } from '@/screens/hire/application-form-card';
import { LOAD_FAILED, loadHire } from '@/screens/hire/parts';
import {
  EmailTemplatesPreview,
  HiringTeamPreview,
  JobBoardsPreview,
  NotificationsPreview,
  PipelinePreview,
  settingsGreeting,
} from '@/screens/hire/settings-previews';

export default async function SettingsScreen() {
  // Only the Application form card is real: it reads and saves the workspace's settings.
  // The other five cards are "Coming soon" previews (settings-previews.tsx): inert, no made-up data.
  const [{ model: settings, isDemo }, viewer] = await Promise.all([
    loadHire('settings', (data) => data.getSettings()),
    getViewer(),
  ]);
  const demo = isDemo || viewer.isDemo;
  const formMode: ApplicationFormMode = demo ? 'demo' : can(viewer.role, 'edit-data') ? 'edit' : 'view';

  return (
    <ScreenContainer>
      <PageHeader
        className="mb-4"
        title="Settings"
        subtitle={settingsGreeting(viewer.orgName, demo)}
      />

      <BentoGrid>
        <PipelinePreview />
        <JobBoardsPreview />
        <EmailTemplatesPreview />
        <HiringTeamPreview />

        {/* Application form */}
        <BentoCard
          title="Application form"
          subtitle="What candidates must provide"
          icon={ClipboardList}
          className="col-span-2 md:col-span-6"
        >
          {settings ? <ApplicationFormCard saved={applicationFormOf(settings)} mode={formMode} /> : LOAD_FAILED}
        </BentoCard>

        <NotificationsPreview />
      </BentoGrid>
    </ScreenContainer>
  );
}
