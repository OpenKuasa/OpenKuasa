import {
  ChartColumn,
  Gauge,
  PieChart,
  Plus,
  TrendingUp,
  Workflow,
  Zap,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  DonutStat,
  RadialGauge,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/* ---- mock data (Rimba Ventures Sdn Bhd) --------------------------- */

const RUNS_TREND = [
  { label: 'Wk1', runs: 132, success: 130 },
  { label: 'Wk2', runs: 148, success: 146 },
  { label: 'Wk3', runs: 141, success: 138 },
  { label: 'Wk4', runs: 163, success: 162 },
  { label: 'Wk5', runs: 158, success: 156 },
  { label: 'Wk6', runs: 176, success: 174 },
  { label: 'Wk7', runs: 169, success: 168 },
  { label: 'Wk8', runs: 197, success: 195 },
];
const RUNS_SERIES: Series[] = [
  { key: 'runs', label: 'Runs', color: 'var(--chart-1)' },
  { key: 'success', label: 'Successful', color: 'var(--chart-2)' },
];

const BY_TRIGGER: Slice[] = [
  { key: 'timed', label: 'Time-based', value: 688, color: 'var(--chart-1)' },
  { key: 'newlead', label: 'New lead', value: 312, color: 'var(--chart-2)' },
  { key: 'dealstage', label: 'Deal stage', value: 188, color: 'var(--chart-5)' },
  { key: 'event', label: 'Date / event', value: 96, color: 'var(--chart-3)' },
];

const RUNS_BY_WORKFLOW = [
  { label: 'Appt reminder', runs: 540 },
  { label: 'Lead welcome', runs: 312 },
  { label: 'Deal follow-up', runs: 204 },
  { label: 'Re-engage', runs: 148 },
  { label: 'Quote nudge', runs: 132 },
];
const WORKFLOW_SERIES: Series[] = [
  { key: 'runs', label: 'Runs this month', color: 'var(--chart-2)' },
];

type WorkflowRow = {
  name: string;
  trigger: string;
  action: string;
  runs: number;
  active: boolean;
};

const WORKFLOWS: WorkflowRow[] = [
  {
    name: 'New lead welcome',
    trigger: 'New lead created',
    action: 'WhatsApp welcome + tag',
    runs: 312,
    active: true,
  },
  {
    name: 'Deal-stage follow-up',
    trigger: 'Deal → Proposal',
    action: 'Email + create task',
    runs: 204,
    active: true,
  },
  {
    name: 'Dormant re-engage',
    trigger: 'No activity · 30 days',
    action: 'WhatsApp offer',
    runs: 148,
    active: true,
  },
  {
    name: 'Appointment reminder',
    trigger: '24h before meeting',
    action: 'SMS + WhatsApp reminder',
    runs: 540,
    active: true,
  },
  {
    name: 'Quotation follow-up',
    trigger: 'Quote sent · 2 days',
    action: 'WhatsApp nudge',
    runs: 132,
    active: true,
  },
  {
    name: 'Birthday message',
    trigger: 'Contact birthday',
    action: 'WhatsApp greeting + voucher',
    runs: 96,
    active: true,
  },
  {
    name: 'Review request',
    trigger: 'Deal won',
    action: 'Email review link',
    runs: 88,
    active: false,
  },
  {
    name: 'Win-back offer',
    trigger: 'Churned · 60 days',
    action: 'Email voucher',
    runs: 74,
    active: false,
  },
];

/* ------------------------------------------------------------------ */

export default function AutomationsScreen() {
  return (
    <ScreenContainer>
      <PageHeader
        title="Automations"
        subtitle="Trigger-based workflows that close deals while you sleep."
        actions={
          <Button size="sm">
            <Plus className="size-4" />
            New Automation
          </Button>
        }
      />

      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Active automations"
            value="6"
            delta="+1"
            onPrimary
            chart={
              <Sparkline
                data={[3, 3, 4, 4, 5, 5, 6, 6]}
                color="var(--primary-foreground)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Runs this month"
            value="1,284"
            delta="+18%"
            deltaTone="up"
            chart={
              <Sparkline
                data={[132, 148, 141, 163, 158, 176, 169, 197]}
                color="var(--chart-1)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Success rate"
            value="99.2%"
            delta="+0.4pt"
            deltaTone="up"
            chart={
              <Sparkline
                data={[98.4, 98.6, 98.7, 98.9, 99.0, 99.1, 99.1, 99.2]}
                color="var(--chart-2)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Time saved"
            value="42h"
            delta="+6h"
            deltaTone="up"
            chart={
              <Sparkline
                data={[22, 26, 28, 31, 34, 37, 39, 42]}
                color="var(--chart-5)"
                height={36}
              />
            }
          />
        </BentoCard>

        {/* Runs over time + trigger mix */}
        <BentoCard
          title="Runs over time"
          subtitle="Last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          <AreaTrend data={RUNS_TREND} series={RUNS_SERIES} height={240} showLegend />
        </BentoCard>
        <BentoCard
          title="By trigger type"
          subtitle="Runs this month"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          <DonutStat
            data={BY_TRIGGER}
            height={240}
            centerValue="1,284"
            centerLabel="runs"
          />
        </BentoCard>

        {/* Runs by workflow + success gauge */}
        <BentoCard
          title="Runs by workflow"
          subtitle="Top 5 this month"
          icon={ChartColumn}
          className="col-span-2 md:col-span-8"
        >
          <BarGroup
            data={RUNS_BY_WORKFLOW}
            series={WORKFLOW_SERIES}
            horizontal
            height={200}
          />
        </BentoCard>
        <BentoCard
          title="Success rate"
          subtitle="Completed without error"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          <RadialGauge
            value={99}
            valueLabel="99.2%"
            label="success"
            color="var(--chart-2)"
            height={200}
          />
        </BentoCard>

        {/* Workflows table */}
        <BentoCard
          title="Workflows"
          subtitle="8 automations · 6 active"
          icon={Workflow}
          action={
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Zap className="size-3.5" />
              <span className="hidden sm:inline">auto-running</span>
            </span>
          }
          className="col-span-2 md:col-span-12"
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Name</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Actions</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {WORKFLOWS.map((w) => (
                  <TableRow key={w.name}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {w.name}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {w.trigger}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {w.action}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{w.runs}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2 text-sm">
                        <LiveDot active={w.active} />
                        {w.active ? 'Active' : 'Paused'}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
