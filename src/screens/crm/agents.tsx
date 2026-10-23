import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  BarChart3,
  CalendarClock,
  DatabaseZap,
  Gauge,
  History,
  Inbox,
  MessageSquare,
  NotebookPen,
  Plus,
  Radar,
  ShieldAlert,
  Target,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  RadarSpread,
  RadialGauge,
  Sparkline,
  type Series,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Button } from '@/components/ui/button';
import { PendingApprovals } from '@/components/agents/pending-approvals';
import { RecentlyDecided } from '@/components/agents/recently-decided';
import { AgentFocus } from '@/components/crm/agent-focus';
import { AgentSchedule } from '@/components/crm/agent-schedule';
import { CouldntLoad } from '@/components/crm/couldnt-load';
import { listPendingProposals, listRecentlyDecided } from '@/lib/agents/proposals';
import { workspaceSpendCents } from '@/lib/agents/spend';
import { CRM_FOCUS, type AgentRunStatus } from '@/lib/agents/types';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { CRM_MAX_FOCUS_CHARS, CRM_STARTER_EXAMPLES } from '@/lib/crm/agent/checks';
import { rm } from '@/lib/reach/format';
import { listSchedules } from '@/lib/reach/schedule-capabilities';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import {
  buildCrmAgentsView,
  type CrmAgentConfigRow,
  type CrmAgentRunRow,
  type CrmAgentsSection,
  type CrmAgentsView,
} from './agents-view';

/* ---- mock data (Rimba Ventures Sdn Bhd) --------------------------- */

type Agent = {
  name: string;
  role: string;
  description: string;
  icon: LucideIcon;
  active: boolean;
  lastRun: string;
  tasks: number;
  trend: number[];
  color: string;
};

const AGENTS: Agent[] = [
  {
    name: 'Deal Scorer',
    role: 'Scores & prioritises deals',
    description: 'Ranks every deal by buying intent so Aisyah calls the best first.',
    icon: Target,
    active: true,
    lastRun: '4 min ago',
    tasks: 512,
    trend: [52, 58, 54, 66, 62, 70, 78],
    color: 'var(--chart-1)',
  },
  {
    name: 'Follow-up Writer',
    role: 'Drafts WhatsApp & email replies',
    description: 'Writes warm, on-brand follow-ups for deals that went quiet.',
    icon: MessageSquare,
    active: true,
    lastRun: '12 min ago',
    tasks: 384,
    trend: [40, 44, 42, 50, 54, 58, 62],
    color: 'var(--chart-2)',
  },
  {
    name: 'Churn Predictor',
    role: 'Spots at-risk customers',
    description: 'Watches engagement dips and warns Faiz before customers leave.',
    icon: ShieldAlert,
    active: true,
    lastRun: '26 min ago',
    tasks: 268,
    trend: [30, 34, 32, 38, 40, 44, 46],
    color: 'var(--chart-5)',
  },
  {
    name: 'Meeting Summarizer',
    role: 'Turns calls into CRM notes',
    description: 'Summarises every call into tidy notes and clear next steps.',
    icon: NotebookPen,
    active: true,
    lastRun: '1h ago',
    tasks: 196,
    trend: [22, 26, 24, 30, 28, 32, 34],
    color: 'var(--chart-4)',
  },
  {
    name: 'Pipeline Forecaster',
    role: 'Projects month-end revenue',
    description: 'Forecasts closed-won revenue in RM from live pipeline momentum.',
    icon: TrendingUp,
    active: true,
    lastRun: '2h ago',
    tasks: 142,
    trend: [18, 20, 22, 24, 26, 28, 30],
    color: 'var(--chart-3)',
  },
  {
    name: 'Data Enricher',
    role: 'Fills missing contact details',
    description: 'Finds company, role and WhatsApp details for every new contact.',
    icon: DatabaseZap,
    active: false,
    lastRun: '2 days ago',
    tasks: 88,
    trend: [14, 12, 11, 10, 9, 8, 7],
    color: 'var(--chart-3)',
  },
];

const AUTOMATION_TREND = [
  { label: 'Wk1', automated: 142, manual: 104 },
  { label: 'Wk2', automated: 168, manual: 96 },
  { label: 'Wk3', automated: 184, manual: 88 },
  { label: 'Wk4', automated: 206, manual: 79 },
  { label: 'Wk5', automated: 228, manual: 70 },
  { label: 'Wk6', automated: 251, manual: 62 },
  { label: 'Wk7', automated: 274, manual: 55 },
  { label: 'Wk8', automated: 298, manual: 48 },
];
const AUTOMATION_SERIES: Series[] = [
  { key: 'automated', label: 'Automated', color: 'var(--chart-1)' },
  { key: 'manual', label: 'Manual', color: 'var(--chart-3)' },
];

const TASKS_BY_AGENT = [
  { label: 'Deal Scorer', tasks: 512 },
  { label: 'Follow-up Writer', tasks: 384 },
  { label: 'Churn Predictor', tasks: 268 },
  { label: 'Meeting Summarizer', tasks: 196 },
  { label: 'Pipeline Forecaster', tasks: 142 },
  { label: 'Data Enricher', tasks: 88 },
];
const TASKS_SERIES: Series[] = [
  { key: 'tasks', label: 'Tasks', color: 'var(--chart-1)' },
];

const AGENT_STRENGTHS = [
  { label: 'Speed', scorer: 94, writer: 80 },
  { label: 'Accuracy', scorer: 90, writer: 96 },
  { label: 'Volume', scorer: 96, writer: 70 },
  { label: 'Coverage', scorer: 76, writer: 84 },
  { label: 'Reliability', scorer: 92, writer: 88 },
];
const STRENGTHS_SERIES: Series[] = [
  { key: 'scorer', label: 'Deal Scorer', color: 'var(--chart-1)' },
  { key: 'writer', label: 'Follow-up Writer', color: 'var(--chart-2)' },
];

/* ------------------------------------------------------------------ */

/** The sample screen, for the no-database preview and the demo workspace. */
export function AgentsSample() {
  return (
    <ScreenContainer>
      <PageHeader
        title="AI Agents"
        subtitle="Your always-on sales crew."
        actions={
          <Button size="sm">
            <Plus className="size-4" />
            New Agent
          </Button>
        }
      />
      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Active agents"
            value="5 / 6"
            delta="+1"
            onPrimary
            chart={
              <Sparkline
                data={[3, 4, 4, 5, 5, 6, 5]}
                color="var(--primary-foreground)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Tasks automated"
            value="1,590"
            delta="+22%"
            deltaTone="up"
            chart={<Sparkline data={[140, 170, 185, 205, 228, 251, 298]} height={36} />}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Hours saved"
            value="48h"
            delta="+11%"
            deltaTone="up"
            chart={
              <Sparkline
                data={[26, 30, 34, 38, 42, 45, 48]}
                color="var(--chart-2)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Avg success rate"
            value="93%"
            delta="+2pt"
            deltaTone="up"
            chart={
              <Sparkline
                data={[88, 89, 90, 91, 92, 92, 93]}
                color="var(--chart-5)"
                height={36}
              />
            }
          />
        </BentoCard>

        {/* Automation trend + coverage gauge */}
        <BentoCard
          title="Automated vs manual"
          subtitle="Tasks handled · last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          <AreaTrend
            data={AUTOMATION_TREND}
            series={AUTOMATION_SERIES}
            height={240}
            showLegend
          />
        </BentoCard>
        <BentoCard
          title="Automation coverage"
          subtitle="Pipeline on autopilot"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          <RadialGauge value={82} label="covered" valueLabel="82%" height={240} />
        </BentoCard>

        {/* Tasks by agent + strengths radar */}
        <BentoCard
          title="Tasks by agent"
          subtitle="Completed this month"
          icon={BarChart3}
          className="col-span-2 md:col-span-7"
        >
          <BarGroup data={TASKS_BY_AGENT} series={TASKS_SERIES} horizontal height={240} />
        </BentoCard>
        <BentoCard
          title="Agent strengths"
          subtitle="Speed · accuracy · volume"
          icon={Radar}
          className="col-span-2 md:col-span-5"
        >
          <RadarSpread data={AGENT_STRENGTHS} series={STRENGTHS_SERIES} height={240} />
        </BentoCard>

        {/* Agent roster */}
        {AGENTS.map((agent) => {
          const Icon = agent.icon;
          return (
            <BentoCard key={agent.name} className="col-span-2 md:col-span-4">
              <div className="flex h-full flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold leading-tight">
                        {agent.name}
                      </h3>
                      <p className="truncate text-xs text-muted-foreground">
                        {agent.role}
                      </p>
                    </div>
                  </div>
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
                      agent.active
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    <LiveDot active={agent.active} />
                    {agent.active ? 'Active' : 'Paused'}
                  </span>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {agent.description}
                </p>
                <div className="mt-auto rounded-lg bg-muted/40 p-2">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>7-day activity</span>
                    <span className="tabular-nums">{agent.tasks} tasks</span>
                  </div>
                  <Sparkline
                    data={agent.trend}
                    color={agent.active ? agent.color : 'var(--muted-foreground)'}
                    height={34}
                  />
                </div>
                <div className="flex items-center justify-between pt-0.5 text-xs text-muted-foreground">
                  <span>Last run · {agent.lastRun}</span>
                  <Button variant="ghost" size="sm">
                    Configure
                  </Button>
                </div>
              </div>
            </BentoCard>
          );
        })}
      </BentoGrid>
    </ScreenContainer>
  );
}

/* ---- live screen ---------------------------------------------------- */

const TITLE = 'AI Agents';
const SUBTITLE = 'Watches your pipeline for what you ask, and suggests follow-ups and notes for you to approve.';

const CONFIG_COLS =
  'enabled,cadence,max_cost_cents,daily_cap_cents,weekly_cap_cents,focus_text,focus_plan,focus_cannot,focus_confirmed_at';

const RUN_STATUS: Record<AgentRunStatus, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** ISO timestamp `ms` before now (kept out of the component body for render purity). */
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-MY', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Asia/Kuala_Lumpur',
      });
}

type Loaded = { view: CrmAgentsView };

async function loadView(orgId: string): Promise<Loaded | null> {
  const supabase = await createClient();
  // An unreadable spend shows as such on the strip (never as RM 0.00); the run gate refuses.
  const spentSince = (ms: number) =>
    workspaceSpendCents(supabase, orgId, isoAgo(ms), CRM_FOCUS).catch((): number | null => {
      console.error('[crm/agents] workspace spend could not be read');
      return null;
    });
  try {
    const [configRes, runsRes, pending, decided, schedules, key, daySpent, weekSpent] = await Promise.all([
      supabase.from('agent_configs').select(CONFIG_COLS).eq('org_id', orgId).eq('agent_key', CRM_FOCUS).maybeSingle(),
      supabase
        .from('agent_runs')
        .select('id,status,cost_cents,started_at')
        .eq('org_id', orgId)
        .eq('agent_key', CRM_FOCUS)
        .in('trigger', ['schedule', 'manual'])
        .order('started_at', { ascending: false })
        .limit(10),
      listPendingProposals(supabase, orgId, 'crm'),
      listRecentlyDecided(supabase, orgId, 5, 'crm'),
      listSchedules(supabase, orgId, CRM_FOCUS),
      supabase.rpc('org_ai_key_status'),
      spentSince(24 * 3600_000),
      spentSince(7 * 24 * 3600_000),
    ]);
    // The focus columns arrive in a migration applied separately from a deploy.
    if (configRes.error || runsRes.error) {
      console.error('[crm/agents] could not load the agent', configRes.error?.code ?? runsRes.error?.code);
      return null;
    }
    const runs = (runsRes.data ?? []) as CrmAgentRunRow[];

    // Suggestions made per run: one small read of run ids. Left out if it fails.
    let suggestionsByRun: Record<string, number> | null = {};
    if (runs.length > 0) {
      const { data, error } = await supabase
        .from('agent_proposals')
        .select('run_id')
        .eq('org_id', orgId)
        .in(
          'run_id',
          runs.map((r) => r.id),
        );
      if (error) suggestionsByRun = null;
      else {
        for (const row of (data ?? []) as { run_id: string | null }[]) {
          if (row.run_id) suggestionsByRun[row.run_id] = (suggestionsByRun[row.run_id] ?? 0) + 1;
        }
      }
    }

    return {
      view: buildCrmAgentsView({
        config: (configRes.data as CrmAgentConfigRow | null) ?? null,
        hasActiveSchedule: schedules.some((s) => s.status === 'active'),
        pending,
        decided,
        runs,
        suggestionsByRun,
        spentTodayCents: daySpent,
        spentWeekCents: weekSpent,
        // Same reading as the AI Chatbot screen: a stored key shows as a row. A failed read is
        // unknown, not "no key": the server still refuses a run or save without one.
        hasKey: key.error ? null : Array.isArray(key.data) ? key.data.length > 0 : Boolean(key.data),
      }),
    };
  } catch (error) {
    console.error('[crm/agents] could not load the agent', (error as { code?: string } | null)?.code ?? 'unknown');
    return null;
  }
}

/**
 * Kasturi's AI Agents screen: the focus the workspace wrote, what the agent suggests from
 * it, when it runs and what it may spend. The sample shows when no database is configured
 * and in the demo workspace.
 */
export default async function AgentsScreen() {
  if (!hasSupabaseEnv()) return <AgentsSample />;
  const viewer = await getViewer();
  if (viewer.isDemo) return <AgentsSample />;

  // Focus, schedule and limits decide what the workspace key spends: owner/admin only.
  const canManage = can(viewer.role, 'manage-agents');
  // Run now and Approve/Dismiss: anyone who edits the workspace's data.
  const canEdit = can(viewer.role, 'edit-data');

  const loaded = await loadView(viewer.orgId);
  if (!loaded) return <CouldntLoad title={TITLE} subtitle={SUBTITLE} thing="agent" />;
  const { view } = loaded;

  const cards: Record<CrmAgentsSection, ReactNode> = {
    waiting: (
      <BentoCard key="waiting" title="Waiting for you" icon={Inbox} className="col-span-2 md:col-span-12">
        <PendingApprovals
          proposals={view.pending}
          canEdit={canEdit}
          heading="Suggestions"
          emptyText="Nothing waiting"
          rejectLabel="Dismiss"
          views={view.suggestions}
        />
      </BentoCard>
    ),
    focus: (
      <BentoCard
        key="focus"
        title="Focus"
        subtitle="Tell the agent what to watch for, in your own words"
        icon={Target}
        className="col-span-2 md:col-span-12"
      >
        <AgentFocus
          key={`${view.focus.state}:${view.focus.text}`}
          focus={view.focus}
          starters={CRM_STARTER_EXAMPLES}
          maxChars={CRM_MAX_FOCUS_CHARS}
          canManage={canManage}
          hasKey={view.hasKey !== false}
        />
      </BentoCard>
    ),
    schedule: (
      <BentoCard key="schedule" title="Schedule and limits" icon={CalendarClock} className="col-span-2 md:col-span-12">
        <AgentSchedule
          settings={view.settings}
          spend={view.spend}
          needsSchedule={view.needsSchedule}
          canManage={canManage}
          canRun={canEdit}
          hasKey={view.hasKey !== false}
        />
      </BentoCard>
    ),
    history: (
      <BentoCard key="history" title="Recent history" icon={History} className="col-span-2 md:col-span-12">
        <div className="space-y-4">
          {view.history.length === 0 ? (
            <p className="grid min-h-16 place-items-center text-center text-sm text-muted-foreground">
              No runs yet.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {view.history.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span className="font-medium">{RUN_STATUS[run.status] ?? run.status}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatWhen(run.startedAt)}
                    {run.suggestions !== null &&
                      ` · ${run.suggestions} suggestion${run.suggestions === 1 ? '' : 's'}`}
                    {` · ${rm(run.costCents)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <RecentlyDecided decided={view.decided} />
        </div>
      </BentoCard>
    ),
  };

  return (
    <ScreenContainer>
      <PageHeader title={TITLE} subtitle={SUBTITLE} />
      {view.hasKey === false && (
        <p className="mb-4 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          The agent runs on your workspace&rsquo;s own AI key.{' '}
          <Link href="/account/ai" className="font-medium text-primary underline-offset-4 hover:underline">
            Add an OpenRouter key
          </Link>{' '}
          to use it.
        </p>
      )}
      <BentoGrid>{view.sections.map((s) => cards[s])}</BentoGrid>
    </ScreenContainer>
  );
}
