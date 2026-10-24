import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  CalendarClock,
  Clock,
  FileWarning,
  Gauge,
  Hourglass,
  Inbox,
  ReceiptText,
  ScrollText,
  Target,
  TrendingUp,
  UserX,
  type LucideIcon,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { AreaTrend, RadialGauge, Sparkline, type Series } from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { PendingApprovals } from '@/components/agents/pending-approvals';
import { RecentlyDecided } from '@/components/agents/recently-decided';
import { CouldntLoad } from '@/components/crm/couldnt-load';
import { PeopleAgentFocus } from '@/components/people/agent-focus';
import { PeopleAgentNotesList } from '@/components/people/agent-notes-list';
import { PeopleAgentSchedule } from '@/components/people/agent-schedule';
import { listPendingProposals, listRecentlyDecided } from '@/lib/agents/proposals';
import { workspaceSpendCents } from '@/lib/agents/spend';
import { PEOPLE_FOCUS, type AgentRunStatus } from '@/lib/agents/types';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { PEOPLE_MAX_FOCUS_CHARS, PEOPLE_STARTER_EXAMPLES } from '@/lib/people/agent/checks';
import { listAgentNotes } from '@/lib/people/agent/notes';
import { rm } from '@/lib/reach/format';
import { listSchedules } from '@/lib/reach/schedule-capabilities';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import { HrOnlyScreen } from './parts';
import {
  buildPeopleAgentsView,
  type PeopleAgentConfigRow,
  type PeopleAgentRunRow,
  type PeopleAgentsSection,
  type PeopleAgentsView,
} from './agents-view';

/* ---- sample data (a fictional company) ---------------------------- */

type SampleAgent = {
  name: string;
  role: string;
  description: string;
  icon: LucideIcon;
  active: boolean;
  lastRun: string;
  notes: number;
  trend: number[];
  color: string;
};

const SAMPLE_AGENTS: SampleAgent[] = [
  {
    name: 'Leave Watcher',
    role: 'Leave waiting for a decision',
    description: 'Notes leave requests that have waited too long, or start soon and are still undecided.',
    icon: Hourglass,
    active: true,
    lastRun: 'Today, 7:00 am',
    notes: 18,
    trend: [2, 3, 2, 4, 3, 2, 2],
    color: 'var(--chart-1)',
  },
  {
    name: 'Document Checker',
    role: 'Contracts and permits expiring',
    description: 'Notes employee documents expiring within 30 days, or already expired.',
    icon: FileWarning,
    active: true,
    lastRun: 'Today, 7:00 am',
    notes: 9,
    trend: [1, 1, 2, 1, 2, 1, 1],
    color: 'var(--chart-2)',
  },
  {
    name: 'Claims Reminder',
    role: 'Claims and overtime waiting',
    description: 'Notes claims and overtime that have waited more than a week for a decision.',
    icon: ReceiptText,
    active: true,
    lastRun: 'Today, 7:00 am',
    notes: 14,
    trend: [3, 2, 2, 3, 1, 2, 1],
    color: 'var(--chart-5)',
  },
  {
    name: 'Attendance Check',
    role: 'Absent days in a row',
    description: 'Notes anyone marked absent three working days in a row.',
    icon: UserX,
    active: false,
    lastRun: 'Mon, 7:00 am',
    notes: 3,
    trend: [0, 1, 0, 0, 1, 0, 1],
    color: 'var(--chart-3)',
  },
];

const FOLLOW_UPS = [
  { label: 'Wk1', noted: 6, open: 11 },
  { label: 'Wk2', noted: 8, open: 9 },
  { label: 'Wk3', noted: 7, open: 8 },
  { label: 'Wk4', noted: 10, open: 6 },
  { label: 'Wk5', noted: 9, open: 5 },
  { label: 'Wk6', noted: 12, open: 4 },
];
const FOLLOW_UP_SERIES: Series[] = [
  { key: 'noted', label: 'Noted for HR', color: 'var(--chart-1)' },
  { key: 'open', label: 'Still waiting', color: 'var(--chart-3)' },
];

/* ------------------------------------------------------------------ */

/** The sample screen, for the no-database preview and the demo workspace. */
export function PeopleAgentsSample() {
  return (
    <ScreenContainer>
      <PageHeader title="AI Agents" subtitle="Watches your team records and suggests notes for HR." />
      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-4">
          <BentoStat
            label="Active checks"
            value="3 / 4"
            onPrimary
            chart={<Sparkline data={[2, 2, 3, 3, 3, 4, 3]} color="var(--primary-foreground)" height={36} />}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat
            label="Notes approved"
            value="44"
            delta="+6"
            deltaTone="up"
            chart={<Sparkline data={[30, 32, 35, 37, 40, 42, 44]} height={36} />}
          />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-4">
          <BentoStat
            label="Waiting for HR"
            value="4"
            delta="-2"
            deltaTone="up"
            chart={<Sparkline data={[11, 9, 8, 6, 5, 4, 4]} color="var(--chart-2)" height={36} />}
          />
        </BentoCard>

        <BentoCard
          title="Follow-ups"
          subtitle="Noted for HR vs still waiting · last 6 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          <AreaTrend data={FOLLOW_UPS} series={FOLLOW_UP_SERIES} height={240} showLegend />
        </BentoCard>
        <BentoCard title="On time" subtitle="Requests decided within a week" icon={Gauge} className="col-span-2 md:col-span-4">
          <RadialGauge value={86} label="on time" valueLabel="86%" height={240} />
        </BentoCard>

        {SAMPLE_AGENTS.map((agent) => {
          const Icon = agent.icon;
          return (
            <BentoCard key={agent.name} className="col-span-2 md:col-span-6">
              <div className="flex h-full flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold leading-tight">{agent.name}</h3>
                      <p className="truncate text-xs text-muted-foreground">{agent.role}</p>
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
                    {agent.active ? 'On' : 'Off'}
                  </span>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">{agent.description}</p>
                <div className="mt-auto rounded-lg bg-muted/40 p-2">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>7-day notes</span>
                    <span className="tabular-nums">{agent.notes} approved</span>
                  </div>
                  <Sparkline
                    data={agent.trend}
                    color={agent.active ? agent.color : 'var(--muted-foreground)'}
                    height={34}
                  />
                </div>
                <p className="pt-0.5 text-xs text-muted-foreground">Last run · {agent.lastRun}</p>
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
const SUBTITLE = 'Watches your team records for what you ask, and suggests notes for HR to approve.';

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

async function loadView(orgId: string): Promise<PeopleAgentsView | null> {
  const supabase = await createClient();
  // An unreadable spend shows as such on the strip (never as RM 0.00); the run gate refuses.
  const spentSince = (ms: number) =>
    workspaceSpendCents(supabase, orgId, isoAgo(ms), PEOPLE_FOCUS).catch((): number | null => {
      console.error('[people/agents] workspace spend could not be read');
      return null;
    });
  try {
    const [configRes, runsRes, pending, decided, schedules, key, daySpent, weekSpent, notes] = await Promise.all([
      supabase.from('agent_configs').select(CONFIG_COLS).eq('org_id', orgId).eq('agent_key', PEOPLE_FOCUS).maybeSingle(),
      supabase
        .from('agent_runs')
        .select('id,status,cost_cents,started_at')
        .eq('org_id', orgId)
        .eq('agent_key', PEOPLE_FOCUS)
        .in('trigger', ['schedule', 'manual'])
        .order('started_at', { ascending: false })
        .limit(10),
      listPendingProposals(supabase, orgId, 'people'),
      listRecentlyDecided(supabase, orgId, 5, 'people'),
      listSchedules(supabase, orgId, PEOPLE_FOCUS),
      supabase.rpc('org_ai_key_status'),
      spentSince(24 * 3600_000),
      spentSince(7 * 24 * 3600_000),
      // A failed notes read shows in the notes list only, never as the whole screen failing.
      listAgentNotes({ client: supabase, orgId }).catch((): null => null),
    ]);
    if (configRes.error || runsRes.error) {
      console.error('[people/agents] could not load the agent', configRes.error?.code ?? runsRes.error?.code);
      return null;
    }
    const runs = (runsRes.data ?? []) as PeopleAgentRunRow[];

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

    return buildPeopleAgentsView({
      config: (configRes.data as PeopleAgentConfigRow | null) ?? null,
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
    console.error('[people/agents] could not load the agent', (error as { code?: string } | null)?.code ?? 'unknown');
    return null;
  }
}

/**
 * Lekiu's AI Agents screen, for HR only (owner and admin): the focus HR wrote, the notes the agent
 * suggests from it, when it runs and what it may spend, and the notes approved so far. Anyone else
 * gets the same "for owners and admins" page as the other HR-only screens, before anything is read.
 * The sample shows when no database is configured and in the demo workspace.
 */
export default async function PeopleAgentsScreen() {
  if (!hasSupabaseEnv()) return <PeopleAgentsSample />;
  const viewer = await getViewer();
  if (viewer.isDemo) return <PeopleAgentsSample />;
  if (!can(viewer.role, 'approve')) return <HrOnlyScreen title={TITLE} />;

  const view = await loadView(viewer.orgId);
  if (!view) return <CouldntLoad title={TITLE} subtitle={SUBTITLE} thing="agent" />;

  const cards: Record<PeopleAgentsSection, ReactNode> = {
    waiting: (
      <BentoCard key="waiting" title="Waiting for you" icon={Inbox} className="col-span-2 md:col-span-12">
        <PendingApprovals
          proposals={view.pending}
          canEdit
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
        subtitle="Tell the agent what to watch for in your team records, in your own words"
        icon={Target}
        className="col-span-2 md:col-span-12"
      >
        <PeopleAgentFocus
          key={`${view.focus.state}:${view.focus.text}`}
          focus={view.focus}
          starters={PEOPLE_STARTER_EXAMPLES}
          maxChars={PEOPLE_MAX_FOCUS_CHARS}
          canManage
          hasKey={view.hasKey !== false}
        />
      </BentoCard>
    ),
    schedule: (
      <BentoCard key="schedule" title="Schedule and limits" icon={CalendarClock} className="col-span-2 md:col-span-12">
        <PeopleAgentSchedule
          settings={view.settings}
          spend={view.spend}
          needsSchedule={view.needsSchedule}
          canManage
          canRun
          hasKey={view.hasKey !== false}
        />
      </BentoCard>
    ),
    notes: (
      <BentoCard key="notes" title="Notes from the agent" icon={ScrollText} className="col-span-2 md:col-span-12">
        <PeopleAgentNotesList notes={view.notes} canEdit />
      </BentoCard>
    ),
    history: (
      <BentoCard key="history" title="Recent history" icon={Clock} className="col-span-2 md:col-span-12">
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
          <RecentlyDecided decided={view.decided} labels={view.labels} />
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
