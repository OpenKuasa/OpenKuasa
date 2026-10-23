import { CalendarClock, Clock, Plane } from 'lucide-react';
import type { ReactNode } from 'react';
import { BentoCard, BentoGrid } from '@/components/bento/bento';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { AttendanceSettingsForm } from '@/components/people/attendance-settings-form';
import { WorkspaceCard } from '@/components/settings/workspace-card';
import { loadWorkspaceOverview } from '@/lib/account/workspace-overview';
import { loadSettingsModel } from '@/lib/people/documents';
import { HrOnlyScreen, LOAD_FAILED, loadPeople } from './parts';

function ValueRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2.5 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm font-medium tabular-nums">{children}</span>
    </div>
  );
}

/** The workspace's HR defaults, read-only. Owners and admins only; nobody else's request reads them. */
export default async function SettingsScreen() {
  const { model, viewer } = await loadPeople('settings', (data, _now, ctx) => loadSettingsModel(data, ctx.viewer));

  if (model?.hr_only) return <HrOnlyScreen title="Settings" />;
  const settings = model && !model.hr_only ? model : null;
  const workspace = await loadWorkspaceOverview();

  return (
    <ScreenContainer>
      <PageHeader title="Settings" subtitle="These are the workspace's HR defaults." />

      <BentoGrid>
        <WorkspaceCard overview={workspace} />

        <BentoCard
          title="Leave entitlements"
          subtitle="Default for new balances · changing them is coming soon"
          icon={Plane}
          className="col-span-2 md:col-span-6"
        >
          {!settings ? (
            LOAD_FAILED
          ) : (
            <>
              <ValueRow label="Annual leave (days)">{settings.annual_leave_days}</ValueRow>
              <ValueRow label="Medical leave (days)">{settings.medical_leave_days}</ValueRow>
              <ValueRow label="Emergency leave (days)">{settings.emergency_leave_days}</ValueRow>
            </>
          )}
        </BentoCard>

        <BentoCard
          title="Working days and attendance"
          subtitle={settings ? `The team week is ${settings.working_days}` : 'How the team week is structured'}
          icon={CalendarClock}
          className="col-span-2 md:col-span-6"
        >
          {!settings ? (
            LOAD_FAILED
          ) : (
            <AttendanceSettingsForm
              initial={settings.attendance}
              disabled={viewer.isDemo}
            />
          )}
        </BentoCard>

        <BentoCard
          title="Overtime rates"
          subtitle="Pay multiplier by kind of day · changing them is coming soon"
          icon={Clock}
          className="col-span-2 md:col-span-6"
        >
          {!settings ? (
            LOAD_FAILED
          ) : (
            <div>
              {settings.overtime.map((rate) => (
                <ValueRow key={rate.label} label={rate.label}>
                  {rate.value}
                </ValueRow>
              ))}
            </div>
          )}
        </BentoCard>

      </BentoGrid>
    </ScreenContainer>
  );
}
