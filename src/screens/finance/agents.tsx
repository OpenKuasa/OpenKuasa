import {
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Calculator,
  Clock,
  Gauge,
  Plus,
  Radar,
  ScanLine,
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
import { cn } from '@/lib/utils';

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

export default function AgentsScreen() {
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
