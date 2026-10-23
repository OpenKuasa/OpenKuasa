import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Calculator,
  CalendarClock,
  Clock,
  Gauge,
  History,
  Inbox,
  NotebookPen,
  Plus,
  Radar,
  ScanLine,
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
import { CouldntLoad } from '@/components/crm/couldnt-load';
import { FinanceAgentFocus } from '@/components/finance/agent-focus';
import { AgentNotesList } from '@/components/finance/agent-notes-list';
import { FinanceAgentSchedule } from '@/components/finance/agent-schedule';
import { listPendingProposals, listRecentlyDecided } from '@/lib/agents/proposals';
import { workspaceSpendCents } from '@/lib/agents/spend';
import { FINANCE_FOCUS, type AgentRunStatus } from '@/lib/agents/types';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { FINANCE_MAX_FOCUS_CHARS, FINANCE_STARTER_EXAMPLES } from '@/lib/finance/agent/checks';
import { listAgentNotes } from '@/lib/finance/agent/notes';
import { rm } from '@/lib/reach/format';
import { listSchedules } from '@/lib/reach/schedule-capabilities';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import {
  buildFinanceAgentsView,
  type FinanceAgentConfigRow,
  type FinanceAgentRunRow,
  type FinanceAgentsSection,
  type FinanceAgentsView,
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
    name: 'Invoice Chaser',
    role: 'Chases overdue invoices',
    description: 'Sends polite RM reminders to customers with overdue invoices.',
    icon: Clock,
    active: true,
    lastRun: '4 min ago',
    tasks: 312,
    trend: [36, 40, 38, 44, 48, 50, 54],
    color: 'var(--chart-1)',
  },
  {
    name: 'Receipt Reader',
    role: 'Extracts data from receipts',
    description: 'Reads supplier receipts and bills straight into draft expenses.',
    icon: ScanLine,
    active: true,
    lastRun: '12 min ago',
    tasks: 428,
    trend: [48, 52, 46, 60, 58, 64, 72],
    color: 'var(--chart-2)',
  },
  {
    name: 'Reconciler',
    role: 'Matches bank transactions',
    description: 'Matches Maybank & CIMB lines to invoices, bills and FPX payouts.',
    icon: ArrowLeftRight,
    active: true,
    lastRun: '9 min ago',
    tasks: 386,
    trend: [40, 44, 42, 50, 52, 58, 62],
    color: 'var(--chart-5)',
  },
  {
    name: 'e-Invoice Submitter',
    role: 'Files to LHDN MyInvois',
    description: 'Validates and submits e-Invois to LHDN MyInvois, then stores the UUID.',
    icon: BadgeCheck,
    active: true,
    lastRun: '26 min ago',
    tasks: 204,
    trend: [22, 26, 24, 30, 28, 34, 36],
    color: 'var(--chart-4)',
  },
  {
    name: 'Cashflow Forecaster',
    role: 'Projects your runway',
    description: 'Projects a 90-day cash runway from AR, AP and payroll commitments.',
    icon: TrendingUp,
    active: false,
    lastRun: '2 days ago',
    tasks: 72,
    trend: [14, 12, 11, 9, 8, 7, 6],
    color: 'var(--chart-3)',
  },
  {
    name: 'Tax Estimator',
    role: 'Estimates SST & tax',
    description: 'Estimates SST payable and sets aside provisions before each filing.',
    icon: Calculator,
    active: false,
    lastRun: '3 days ago',
    tasks: 58,
    trend: [10, 9, 10, 8, 9, 8, 7],
    color: 'var(--chart-3)',
  },
];

const AUTOMATION_TREND = [
  { label: 'Wk1', automated: 96, manual: 84 },
  { label: 'Wk2', automated: 118, manual: 78 },
  { label: 'Wk3', automated: 134, manual: 71 },
  { label: 'Wk4', automated: 152, manual: 64 },
  { label: 'Wk5', automated: 168, manual: 58 },
  { label: 'Wk6', automated: 184, manual: 52 },
  { label: 'Wk7', automated: 201, manual: 47 },
  { label: 'Wk8', automated: 218, manual: 41 },
];
const AUTOMATION_SERIES: Series[] = [
  { key: 'automated', label: 'Automated', color: 'var(--chart-1)' },
  { key: 'manual', label: 'Manual', color: 'var(--chart-3)' },
];

const TASKS_BY_AGENT = [
  { label: 'Receipt Reader', tasks: 428 },
  { label: 'Reconciler', tasks: 386 },
  { label: 'Invoice Chaser', tasks: 312 },
  { label: 'e-Invoice', tasks: 204 },
  { label: 'Forecaster', tasks: 72 },
  { label: 'Tax Estimator', tasks: 58 },
];
const TASKS_SERIES: Series[] = [
  { key: 'tasks', label: 'Tasks', color: 'var(--chart-1)' },
];

const AGENT_STRENGTHS = [
  { label: 'Speed', reconciler: 92, submitter: 80 },
  { label: 'Accuracy', reconciler: 95, submitter: 97 },
  { label: 'Volume', reconciler: 88, submitter: 70 },
  { label: 'Coverage', reconciler: 76, submitter: 84 },
  { label: 'Compliance', reconciler: 82, submitter: 98 },
];
const STRENGTHS_SERIES: Series[] = [
  { key: 'reconciler', label: 'Reconciler', color: 'var(--chart-1)' },
  { key: 'submitter', label: 'e-Invoice Submitter', color: 'var(--chart-2)' },
];

/* ------------------------------------------------------------------ */

/** The sample screen, for the no-database preview and the demo workspace. */
export function AgentsSample() {
  return (
    <ScreenContainer>
      <PageHeader
        title="AI Agents"
        subtitle="Your always-on finance crew."
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
            value="4 / 6"
            delta="+1"
            onPrimary
            chart={
              <Sparkline
                data={[2, 3, 3, 4, 4, 5, 4]}
                color="var(--primary-foreground)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Tasks automated"
            value="1,460"
            delta="+19%"
            deltaTone="up"
            chart={<Sparkline data={[96, 118, 134, 152, 168, 184, 218]} height={36} />}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Hours saved"
            value="42h"
            delta="+11%"
            deltaTone="up"
            chart={
              <Sparkline
                data={[22, 26, 29, 32, 36, 39, 42]}
                color="var(--chart-2)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Avg success rate"
            value="96%"
            delta="+2pt"
            deltaTone="up"
            chart={
              <Sparkline
                data={[91, 92, 93, 94, 95, 95, 96]}
                color="var(--chart-5)"
                height={36}
              />
            }
          />
        </BentoCard>

        {/* Automation trend + coverage gauge */}
        <BentoCard
          title="Automated vs manual"
          subtitle="Finance tasks handled · last 8 weeks"
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
          subtitle="Bookkeeping on autopilot"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          <RadialGauge value={81} label="covered" valueLabel="81%" height={240} />
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
          subtitle="Speed · accuracy · compliance"
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
const SUBTITLE = 'Watches your books for what you ask, and suggests notes for you to approve.';

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

async function loadView(orgId: string): Promise<FinanceAgentsView | null> {
  const supabase = await createClient();
  // An unreadable spend shows as such on the strip (never as RM 0.00); the run gate refuses.
  const spentSince = (ms: number) =>
    workspaceSpendCents(supabase, orgId, isoAgo(ms), FINANCE_FOCUS).catch((): number | null => {
      console.error('[finance/agents] workspace spend could not be read');
      return null;
    });
  try {
    const [configRes, runsRes, pending, decided, schedules, key, daySpent, weekSpent, notes] = await Promise.all([
      supabase.from('agent_configs').select(CONFIG_COLS).eq('org_id', orgId).eq('agent_key', FINANCE_FOCUS).maybeSingle(),
      supabase
        .from('agent_runs')
        .select('id,status,cost_cents,started_at')
        .eq('org_id', orgId)
        .eq('agent_key', FINANCE_FOCUS)
        .in('trigger', ['schedule', 'manual'])
        .order('started_at', { ascending: false })
        .limit(10),
      listPendingProposals(supabase, orgId, 'finance'),
      listRecentlyDecided(supabase, orgId, 5, 'finance'),
      listSchedules(supabase, orgId, FINANCE_FOCUS),
      supabase.rpc('org_ai_key_status'),
      spentSince(24 * 3600_000),
      spentSince(7 * 24 * 3600_000),
      // A failed notes read shows in the notes list only, never as the whole screen failing.
      listAgentNotes({ client: supabase, orgId }).catch((): null => null),
    ]);
    if (configRes.error || runsRes.error) {
      console.error('[finance/agents] could not load the agent', configRes.error?.code ?? runsRes.error?.code);
      return null;
    }
    const runs = (runsRes.data ?? []) as FinanceAgentRunRow[];

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

    return buildFinanceAgentsView({
      config: (configRes.data as FinanceAgentConfigRow | null) ?? null,
      hasActiveSchedule: schedules.some((s) => s.status === 'active'),
      pending,
      decided,
      runs,
      suggestionsByRun,
      spentTodayCents: daySpent,
      spentWeekCents: weekSpent,
      // A failed read is unknown, not "no key": the server still refuses a run or save without one.
      hasKey: key.error ? null : Array.isArray(key.data) ? key.data.length > 0 : Boolean(key.data),
      notes,
    });
  } catch (error) {
    console.error('[finance/agents] could not load the agent', (error as { code?: string } | null)?.code ?? 'unknown');
    return null;
  }
}

/**
 * Bendahara's AI Agents screen: the focus the workspace wrote, the notes the agent suggests from
 * it, when it runs and what it may spend, and the notes approved so far. The sample shows when no
 * database is configured and in the demo workspace.
 */
export default async function AgentsScreen() {
  if (!hasSupabaseEnv()) return <AgentsSample />;
  const viewer = await getViewer();
  if (viewer.isDemo) return <AgentsSample />;

  // Focus, schedule and limits decide what the workspace key spends: owner/admin only.
  const canManage = can(viewer.role, 'manage-agents');
  // Run now, Approve/Dismiss and deleting a note: anyone who edits the workspace's data.
  const canEdit = can(viewer.role, 'edit-data');

  const view = await loadView(viewer.orgId);
  if (!view) return <CouldntLoad title={TITLE} subtitle={SUBTITLE} thing="agent" />;

  const cards: Record<FinanceAgentsSection, ReactNode> = {
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
        <FinanceAgentFocus
          key={`${view.focus.state}:${view.focus.text}`}
          focus={view.focus}
          starters={FINANCE_STARTER_EXAMPLES}
          maxChars={FINANCE_MAX_FOCUS_CHARS}
          canManage={canManage}
          hasKey={view.hasKey !== false}
        />
      </BentoCard>
    ),
    schedule: (
      <BentoCard key="schedule" title="Schedule and limits" icon={CalendarClock} className="col-span-2 md:col-span-12">
        <FinanceAgentSchedule
          settings={view.settings}
          spend={view.spend}
          needsSchedule={view.needsSchedule}
          canManage={canManage}
          canRun={canEdit}
          hasKey={view.hasKey !== false}
        />
      </BentoCard>
    ),
    notes: (
      <BentoCard key="notes" title="Notes from the agent" icon={NotebookPen} className="col-span-2 md:col-span-12">
        <AgentNotesList notes={view.notes} canEdit={canEdit} />
      </BentoCard>
    ),
    history: (
      <BentoCard key="history" title="Recent history" icon={History} className="col-span-2 md:col-span-12">
        <div className="space-y-4">
          {view.history.length === 0 ? (
            <p className="grid min-h-16 place-items-center text-center text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {view.history.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span className="font-medium">{RUN_STATUS[run.status] ?? run.status}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatWhen(run.startedAt)}
                    {run.suggestions !== null && ` · ${run.suggestions} suggestion${run.suggestions === 1 ? '' : 's'}`}
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
