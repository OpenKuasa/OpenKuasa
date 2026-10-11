import { Bot } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard } from '@/components/bento/bento';
import { AgentsPanel } from '@/components/reach/agents-panel';
import { createClient } from '@/lib/supabase/server';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { listAgentConfigs } from '@/lib/agents/config';
import { listSchedules } from '@/lib/reach/schedule-capabilities';
import { listPendingProposals, listRecentlyDecided } from '@/lib/agents/proposals';
import {
  WEEKLY_STUDIO,
  type AgentConfig,
  type AgentProposal,
  type AgentRun,
  type AgentRunAsset,
  type AgentSchedule,
} from '@/lib/agents/types';

/** Shown when the org has no saved config yet. Never written on read. */
function defaultConfig(orgId: string): AgentConfig {
  return {
    id: '',
    org_id: orgId,
    agent_key: WEEKLY_STUDIO,
    enabled: false,
    cadence: 'weekly',
    max_cost_cents: 200,
    last_run_at: null,
    created_at: '',
    updated_at: '',
    daily_cap_cents: 500,
    weekly_cap_cents: 2000,
  };
}

/** ISO timestamp `ms` before now (kept out of the component body for render purity). */
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export default async function AgentsScreen() {
  const viewer = await getViewer();
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');

  let config: AgentConfig = defaultConfig(viewer.orgId ?? '');
  let runs: AgentRun[] = [];
  let assets: AgentRunAsset[] = [];
  const assetUrls: Record<string, string> = {};
  let schedules: AgentSchedule[] = [];
  let spentTodayCents = 0;
  let spentWeekCents = 0;
  let proposals: AgentProposal[] = [];
  let decided: AgentProposal[] = [];

  if (!viewer.isDemo && viewer.orgId) {
    const supabase = await createClient();
    const sumCost = (rows: { cost_cents: number | null }[] | null) =>
      (rows ?? []).reduce((n, r) => n + (r.cost_cents ?? 0), 0);
    const [configs, scheduleRows, proposalRows, decidedRows, dayRes, weekRes, runsRes] = await Promise.all([
      listAgentConfigs(supabase, viewer.orgId),
      listSchedules(supabase, viewer.orgId),
      listPendingProposals(supabase, viewer.orgId),
      listRecentlyDecided(supabase, viewer.orgId),
      // Same basis as the runner's ceiling: only runs that actually cost something.
      supabase
        .from('agent_runs')
        .select('cost_cents')
        .eq('org_id', viewer.orgId)
        .gt('cost_cents', 0)
        .gte('started_at', isoAgo(24 * 3600_000)),
      supabase
        .from('agent_runs')
        .select('cost_cents')
        .eq('org_id', viewer.orgId)
        .gt('cost_cents', 0)
        .gte('started_at', isoAgo(7 * 24 * 3600_000)),
      supabase
        .from('agent_runs')
        .select('*')
        .eq('org_id', viewer.orgId)
        .order('started_at', { ascending: false })
        .limit(10),
    ]);
    config = configs.find((c) => c.agent_key === WEEKLY_STUDIO) ?? config;
    schedules = scheduleRows;
    proposals = proposalRows;
    decided = decidedRows;
    spentTodayCents = sumCost(dayRes.data);
    spentWeekCents = sumCost(weekRes.data);
    runs = (runsRes.data ?? []) as AgentRun[];
    if (runs.length > 0) {
      const { data } = await supabase
        .from('agent_run_assets')
        .select('*')
        .in(
          'run_id',
          runs.map((r) => r.id),
        );
      assets = (data ?? []) as AgentRunAsset[];
      // Private bucket: sign a short-lived URL per finished asset (org-member SELECT policy).
      await Promise.all(
        assets
          .filter((a) => a.status === 'done' && a.storage_path)
          .map(async (a) => {
            const { data: signed } = await supabase.storage
              .from('agent-assets')
              .createSignedUrl(a.storage_path as string, 3600);
            if (signed?.signedUrl) assetUrls[a.id] = signed.signedUrl;
          }),
      );
    }
  }

  return (
    <ScreenContainer>
      <PageHeader
        title="AI Agents"
        subtitle="Set up your autonomous Weekly Studio agent and review what it has made."
      />

      <BentoGrid>
        <BentoCard
          title="Weekly Studio"
          subtitle="Drafts a weekly content digest with poster ideas"
          icon={Bot}
          className="col-span-2 md:col-span-12"
        >
          <AgentsPanel
            config={config}
            runs={runs}
            assets={assets}
            assetUrls={assetUrls}
            canEdit={canEdit}
            schedules={schedules}
            proposals={proposals}
            decided={decided}
            dailyCapCents={config.daily_cap_cents}
            weeklyCapCents={config.weekly_cap_cents}
            spentTodayCents={spentTodayCents}
            spentWeekCents={spentWeekCents}
          />
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
