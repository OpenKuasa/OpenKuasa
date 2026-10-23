import {
  AlertTriangle,
  CircleCheck,
  HeartPulse,
  Megaphone,
  Plug,
  XCircle,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard } from '@/components/bento/bento';
import { RadialGauge } from '@/components/charts';
import { Badge } from '@/components/ui/badge';
import { AdSettingsForm } from '@/components/reach/ad-settings-form';
import { WorkspaceCard } from '@/components/settings/workspace-card';
import { loadWorkspaceOverview } from '@/lib/account/workspace-overview';
import { createClient } from '@/lib/supabase/server';
import { getReachData } from '@/lib/reach/supabase';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { cn } from '@/lib/utils';

type Status = 'Healthy' | 'Warning' | 'Action needed';

type Check = {
  name: string;
  description: string;
  status: Status;
};

const CHECKS: Check[] = [
  {
    name: 'Meta account connected',
    description: 'Link your Meta Business account',
    status: 'Action needed',
  },
  {
    name: 'Facebook Page linked',
    description: 'Select the Page to run ads from',
    status: 'Action needed',
  },
  {
    name: 'Lead forms configured',
    description: 'At least one active lead form',
    status: 'Warning',
  },
  {
    name: 'WhatsApp number verified',
    description: 'For auto follow-ups',
    status: 'Healthy',
  },
  {
    name: 'Billing method on file',
    description: 'Meta bills your card directly',
    status: 'Healthy',
  },
  {
    name: 'Conversions API / Pixel',
    description: 'Improves tracking accuracy',
    status: 'Warning',
  },
  {
    name: 'Domain verified',
    description: 'Required for some objectives',
    status: 'Healthy',
  },
];

const STATUS_PILL: Record<Status, string> = {
  Healthy: 'bg-emerald-500/15 text-emerald-600',
  Warning: 'bg-amber-500/15 text-amber-600',
  'Action needed': 'bg-red-500/15 text-red-600',
};

function StatusIcon({ status }: { status: Status }) {
  if (status === 'Healthy') {
    return <CircleCheck className="size-5 shrink-0 text-emerald-600" />;
  }
  if (status === 'Warning') {
    return <AlertTriangle className="size-5 shrink-0 text-amber-600" />;
  }
  return <XCircle className="size-5 shrink-0 text-red-600" />;
}

export default async function AdSettingsScreen() {
  const supabase = await createClient();
  const [data, viewer, workspace] = await Promise.all([getReachData(supabase), getViewer(), loadWorkspaceOverview()]);
  const settings = await data.getAdSettings();
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  const issues = CHECKS.filter((c) => c.status === 'Action needed').length;

  return (
    <ScreenContainer>
      <PageHeader
        className="mb-4"
        title="Ad Settings"
        subtitle="Your ad account, budgets and automation."
      />

      <BentoGrid>
        <WorkspaceCard overview={workspace} />

        {/* Connected account */}
        <BentoCard
          title="Connected account"
          subtitle="Link Meta to run and sync ads"
          icon={Plug}
          className="col-span-2 md:col-span-6"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <Megaphone className="size-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">Meta Business</p>
                  <Badge variant="secondary">Not connected</Badge>
                </div>
                <p className="text-sm text-muted-foreground">Connecting Meta is coming soon.</p>
              </div>
            </div>
          </div>
        </BentoCard>

        <AdSettingsForm settings={settings} canEdit={canEdit} />

        {/* Health check (absorbed) */}
        <BentoCard
          title="Health check"
          subtitle="Setup checklist for your ad engine"
          icon={HeartPulse}
          className="col-span-2 md:col-span-12"
        >
          {viewer.isDemo ? (
            <div className="grid gap-4 md:grid-cols-12">
              <div className="flex flex-col items-center justify-center gap-3 rounded-lg border bg-background/50 p-4 md:col-span-4">
                <RadialGauge value={71} label="healthy" valueLabel="71%" height={200} />
                <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  <AlertTriangle className="size-4 shrink-0 text-amber-600" />
                  <p className="text-sm font-medium">
                    {issues} issue{issues === 1 ? '' : 's'} need attention
                  </p>
                </div>
              </div>
              <div className="divide-y rounded-lg border bg-background/50 md:col-span-8">
                {CHECKS.map((check) => (
                  <div
                    key={check.name}
                    className="flex items-center justify-between gap-4 p-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <StatusIcon status={check.status} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{check.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {check.description}
                        </p>
                      </div>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
                        STATUS_PILL[check.status],
                      )}
                    >
                      {check.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
              Coming soon
            </p>
          )}
        </BentoCard>
      </BentoGrid>

    </ScreenContainer>
  );
}
