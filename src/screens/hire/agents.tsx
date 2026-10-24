import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  BarChart3,
  CalendarCheck,
  CalendarClock,
  ClipboardCheck,
  Gauge,
  History,
  Inbox,
  MessageSquareText,
  NotebookPen,
  Plus,
  Radar,
  Target,
  TrendingUp,
  UserSearch,
  Users,
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
import { HireAgentFocus } from '@/components/hire/agent-focus';
import { AgentNotesList } from '@/components/hire/agent-notes-list';
import { HireAgentSchedule } from '@/components/hire/agent-schedule';
import { listPendingProposals, listRecentlyDecided } from '@/lib/agents/proposals';
import { workspaceSpendCents } from '@/lib/agents/spend';
import { HIRE_FOCUS, type AgentRunStatus } from '@/lib/agents/types';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { HIRE_MAX_FOCUS_CHARS, HIRE_STARTER_EXAMPLES } from '@/lib/hire/agent/checks';
import { listAgentNotes } from '@/lib/hire/agent/notes';
import { rm } from '@/lib/reach/format';
import { listSchedules } from '@/lib/reach/schedule-capabilities';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import {
  buildHireAgentsView,
  type HireAgentConfigRow,
  type HireAgentRunRow,
  type HireAgentsSection,
  type HireAgentsView,
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
    name: 'Screening Assistant',
    role: 'Flags applications waiting to be screened',
    description: 'Notes applications still at Applied after five days, so nobody waits unheard.',
    icon: ClipboardCheck,
    active: true,
    lastRun: '6 min ago',
    tasks: 214,
    trend: [24, 28, 26, 32, 34, 38, 41],
    color: 'var(--chart-1)',
  },
  {
    name: 'Interview Tracker',
    role: 'Keeps interviews up to date',
    description: 'Notes interviews still marked Scheduled after their time, and ones with no feedback.',
    icon: CalendarCheck,
    active: true,
    lastRun: '18 min ago',
    tasks: 138,
    trend: [14, 16, 15, 19, 21, 22, 24],
    color: 'var(--chart-2)',
  },
  {
    name: 'Offer Follow-up',
    role: 'Watches offers with no answer',
    description: 'Notes offers made more than a week ago with no answer recorded yet.',
    icon: MessageSquareText,
    active: true,
    lastRun: '1 hour ago',
    tasks: 46,
    trend: [4, 5, 5, 6, 7, 7, 8],
    color: 'var(--chart-5)',
  },
  {
    name: 'Job Watch',
    role: 'Watches open roles',
    description: 'Notes jobs open more than 45 days, and ones closing soon with few applications.',
    icon: TrendingUp,
    active: true,
    lastRun: '3 hours ago',
    tasks: 62,
    trend: [6, 7, 8, 8, 9, 10, 11],
    color: 'var(--chart-4)',
  },
  {
    name: 'Talent Pool Keeper',
    role: 'Revisits the talent pool',
    description: 'Notes pool candidates idle for months who are not in any current application.',
    icon: UserSearch,
    active: false,
    lastRun: '2 days ago',
    tasks: 28,
    trend: [6, 5, 5, 4, 4, 3, 3],
    color: 'var(--chart-3)',
  },
  {
    name: 'Pipeline Reviewer',
    role: 'Spots quiet applications',
    description: 'Notes applications at Interview or Offer with no activity for two weeks.',
    icon: Users,
    active: false,
    lastRun: '4 days ago',
    tasks: 19,
    trend: [4, 4, 3, 3, 3, 2, 2],
    color: 'var(--chart-3)',
  },
];

const AUTOMATION_TREND = [
  { label: 'Wk1', automated: 22, manual: 40 },
  { label: 'Wk2', automated: 28, manual: 37 },
  { label: 'Wk3', automated: 33, manual: 34 },
  { label: 'Wk4', automated: 39, manual: 31 },
  { label: 'Wk5', automated: 44, manual: 28 },
  { label: 'Wk6', automated: 50, manual: 25 },
  { label: 'Wk7', automated: 55, manual: 23 },
  { label: 'Wk8', automated: 61, manual: 20 },
];
const AUTOMATION_SERIES: Series[] = [
  { key: 'automated', label: 'Flagged by agents', color: 'var(--chart-1)' },
  { key: 'manual', label: 'Found by hand', color: 'var(--chart-3)' },
];

const TASKS_BY_AGENT = [
  { label: 'Screening', tasks: 214 },
  { label: 'Interviews', tasks: 138 },
  { label: 'Job Watch', tasks: 62 },
  { label: 'Offers', tasks: 46 },
  { label: 'Talent Pool', tasks: 28 },
  { label: 'Pipeline', tasks: 19 },
];
const TASKS_SERIES: Series[] = [
  { key: 'tasks', label: 'Notes', color: 'var(--chart-1)' },
];

const AGENT_STRENGTHS = [
  { label: 'Speed', screening: 90, interviews: 78 },
  { label: 'Accuracy', screening: 94, interviews: 92 },
  { label: 'Volume', screening: 86, interviews: 70 },
  { label: 'Coverage', screening: 80, interviews: 84 },
  { label: 'Follow-through', screening: 76, interviews: 90 },
];
const STRENGTHS_SERIES: Series[] = [
  { key: 'screening', label: 'Screening Assistant', color: 'var(--chart-1)' },
  { key: 'interviews', label: 'Interview Tracker', color: 'var(--chart-2)' },
];

/* ------------------------------------------------------------------ */

/** The sample screen, for the no-database preview and the demo workspace. Names no candidate. */
export function AgentsSample() {
  return (
    <ScreenContainer>
      <PageHeader
        title="AI Agents"
        subtitle="Your always-on hiring crew."
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
                data={[2, 2, 3, 3, 4, 4, 4]}
                color="var(--primary-foreground)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Notes suggested"
            value="507"
            delta="+14%"
            deltaTone="up"
            chart={<Sparkline data={[22, 28, 33, 39, 44, 50, 61]} height={36} />}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Hours saved"
            value="18h"
            delta="+9%"
            deltaTone="up"
            chart={
              <Sparkline
                data={[8, 10, 11, 13, 15, 16, 18]}
                color="var(--chart-2)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Notes approved"
            value="88%"
            delta="+3pt"
            deltaTone="up"
            chart={
              <Sparkline
                data={[80, 82, 83, 85, 86, 87, 88]}
                color="var(--chart-5)"
                height={36}
              />
            }
          />
        </BentoCard>

        {/* Trend + coverage gauge */}
        <BentoCard
          title="Flagged by agents vs by hand"
          subtitle="Follow-ups found · last 8 weeks"
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
          title="Pipeline coverage"
          subtitle="Open applications watched"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          <RadialGauge value={74} label="covered" valueLabel="74%" height={240} />
        </BentoCard>

        {/* Notes by agent + strengths radar */}
        <BentoCard
          title="Notes by agent"
          subtitle="Suggested this month"
          icon={BarChart3}
          className="col-span-2 md:col-span-7"
        >
          <BarGroup data={TASKS_BY_AGENT} series={TASKS_SERIES} horizontal height={240} />
        </BentoCard>
        <BentoCard
          title="Agent strengths"
          subtitle="Speed · accuracy · follow-through"
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
                    <span className="tabular-nums">{agent.tasks} notes</span>
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
const SUBTITLE = 'Watches your hiring for what you ask, and suggests notes for you to approve.';

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

async function loadView(orgId: string): Promise<HireAgentsView | null> {
  const supabase = await createClient();
  // An unreadable spend shows as such on the strip (never as RM 0.00); the run gate refuses.
  const spentSince = (ms: number) =>
    workspaceSpendCents(supabase, orgId, isoAgo(ms), HIRE_FOCUS).catch((): number | null => {
      console.error('[hire/agents] workspace spend could not be read');
      return null;
    });
  try {
    const [configRes, runsRes, pending, decided, schedules, key, daySpent, weekSpent, notes] = await Promise.all([
      supabase.from('agent_configs').select(CONFIG_COLS).eq('org_id', orgId).eq('agent_key', HIRE_FOCUS).maybeSingle(),
      supabase
        .from('agent_runs')
        .select('id,status,cost_cents,started_at')
        .eq('org_id', orgId)
        .eq('agent_key', HIRE_FOCUS)
        .in('trigger', ['schedule', 'manual'])
        .order('started_at', { ascending: false })
        .limit(10),
      listPendingProposals(supabase, orgId, 'hire'),
      listRecentlyDecided(supabase, orgId, 5, 'hire'),
      listSchedules(supabase, orgId, HIRE_FOCUS),
      supabase.rpc('org_ai_key_status'),
      spentSince(24 * 3600_000),
      spentSince(7 * 24 * 3600_000),
      // A failed notes read shows in the notes list only, never as the whole screen failing.
      listAgentNotes({ client: supabase, orgId }).catch((): null => null),
    ]);
    if (configRes.error || runsRes.error) {
      console.error('[hire/agents] could not load the agent', configRes.error?.code ?? runsRes.error?.code);
      return null;
    }
    const runs = (runsRes.data ?? []) as HireAgentRunRow[];

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

    return buildHireAgentsView({
      config: (configRes.data as HireAgentConfigRow | null) ?? null,
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
    console.error('[hire/agents] could not load the agent', (error as { code?: string } | null)?.code ?? 'unknown');
    return null;
  }
}

/**
 * Lekir's AI Agents screen: the focus the workspace wrote, the notes the agent suggests from it,
 * when it runs and what it may spend, and the notes approved so far. Suggestions and notes name
 * only the candidate, the job, the stage, dates and counts: never contact details. The sample shows when no
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

  const cards: Record<HireAgentsSection, ReactNode> = {
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
        <HireAgentFocus
          key={`${view.focus.state}:${view.focus.text}`}
          focus={view.focus}
          starters={HIRE_STARTER_EXAMPLES}
          maxChars={HIRE_MAX_FOCUS_CHARS}
          canManage={canManage}
          hasKey={view.hasKey !== false}
        />
      </BentoCard>
    ),
    schedule: (
      <BentoCard key="schedule" title="Schedule and limits" icon={CalendarClock} className="col-span-2 md:col-span-12">
        <HireAgentSchedule
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
