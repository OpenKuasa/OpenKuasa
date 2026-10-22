import { ClipboardList } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard } from '@/components/bento/bento';
import { getTeam, type TeamMember } from '@/lib/account/data';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { applicationFormOf } from '@/lib/hire/application-form';
import { buildSettingsModel } from '@/lib/hire/settings-model';
import { ApplicationFormCard, type ApplicationFormMode } from '@/screens/hire/application-form-card';
import { LOAD_FAILED, loadHire } from '@/screens/hire/parts';
import { CareersBoardCard, HiringTeamCard, PipelineCard, settingsGreeting } from '@/screens/hire/settings-cards';

/** The workspace's members, or null when they could not be read (the card says so). */
async function readTeam(): Promise<TeamMember[] | null> {
  try {
    return await getTeam();
  } catch (error) {
    console.error('[hire/settings] team error:', error);
    return null;
  }
}

export default async function SettingsScreen() {
  // Every card reads the workspace's own data. The Application form saves here; the
  // other cards link to the screen where their part is changed.
  const [{ model, isDemo }, viewer] = await Promise.all([loadHire('settings', buildSettingsModel), getViewer()]);
  const demo = isDemo || viewer.isDemo;
  // A demo visitor shares one workspace with every other visitor: no one is listed.
  const team = demo ? null : await readTeam();
  const formMode: ApplicationFormMode = demo ? 'demo' : can(viewer.role, 'edit-data') ? 'edit' : 'view';

  return (
    <ScreenContainer>
      <PageHeader className="mb-4" title="Settings" subtitle={settingsGreeting(viewer.orgName, demo)} />

      <BentoGrid>
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
        <HiringTeamCard team={team} demo={demo} />
      </BentoGrid>
    </ScreenContainer>
  );
}
