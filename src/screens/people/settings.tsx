import { Bell, CalendarClock, Clock, Plane } from 'lucide-react';
import type { ReactNode } from 'react';
import { BentoCard, BentoGrid } from '@/components/bento/bento';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { AttendanceSettingsForm } from '@/components/people/attendance-settings-form';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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

  return (
    <ScreenContainer>
      <PageHeader title="Settings" subtitle="These are the workspace's HR defaults." />

      <BentoGrid>
        <BentoCard
          title="Leave entitlements"
          subtitle="Default for new balances"
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
          subtitle="Pay multiplier by kind of day"
          icon={Clock}
          className="col-span-2 md:col-span-12"
        >
          {!settings ? (
            LOAD_FAILED
          ) : (
            <div className="grid gap-x-8 md:grid-cols-3">
              {settings.overtime.map((rate) => (
                <ValueRow key={rate.label} label={rate.label}>
                  {rate.value}
                </ValueRow>
              ))}
            </div>
          )}
        </BentoCard>

        <BentoCard
          title="Notifications"
          subtitle="Keep the team in the loop"
          icon={Bell}
          className="col-span-2 md:col-span-12"
        >
          {!settings ? (
            LOAD_FAILED
          ) : (
            <div className="grid gap-x-8 md:grid-cols-2">
              {settings.notifications.map((row) => (
                <div key={row.key} className="flex items-start justify-between gap-4 py-2">
                  <div className="space-y-0.5">
                    <Label htmlFor={`notify-${row.key}`} className="font-medium">
                      {row.label}
                    </Label>
                    <p className="text-sm text-muted-foreground">{row.description}</p>
                  </div>
                  <Switch id={`notify-${row.key}`} checked={row.on} disabled />
                </div>
              ))}
            </div>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
