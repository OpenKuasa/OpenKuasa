import {
  Activity,
  ChartColumn,
  Download,
  Filter,
  Gauge,
  PieChart,
  TrendingUp,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  DonutStat,
  FunnelFlow,
  type Series,
  type Slice,
} from '@/components/charts';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { buildHireDashboardModel } from '@/lib/hire/dashboard';
import { FUNNEL_COLOR, LOAD_FAILED, Muted, NOT_AVAILABLE, loadHire, topSlices } from '@/screens/hire/parts';

/* ---- static config ------------------------------------------------ */

const TIME_SERIES: Series[] = [
  { key: 'hire', label: 'Days to hire', color: 'var(--chart-1)' },
  { key: 'offer', label: 'Days to offer', color: 'var(--chart-2)' },
];

const APPS_BY_JOB_SERIES: Series[] = [
  { key: 'applications', label: 'Applications', color: 'var(--chart-2)' },
];

const SOURCE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

/* ------------------------------------------------------------------ */

export default async function DashboardScreen() {
  const { model } = await loadHire('dashboard', buildHireDashboardModel);
  const trendMonths = (model?.timeByMonth ?? [])
    .filter((m) => m.hire !== null || m.offer !== null)
    .map((m) => ({
      label: m.label,
      hire: m.hire ?? 0,
      offer: m.offer ?? 0,
    }));
  const sourceMix: Slice[] = topSlices(
    model?.hiresBySource ?? [],
    (r) => r.hires,
    (r) => r.source,
  ).map((row, index) => ({ ...row, color: SOURCE_COLORS[index] }));
  const pipeline: Slice[] = (model?.funnel ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    value: f.value,
    color: FUNNEL_COLOR[f.key],
  }));

  return (
    <ScreenContainer>
      <PageHeader
        title="Dashboard"
        subtitle="Your recruiting performance."
        actions={
          <>
            <Select defaultValue="all" disabled>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All time</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" disabled>
              <Download className="size-4" />
              Export
            </Button>
          </>
        }
      />

      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Time to hire"
            value={
              !model ? '—' : model.time.days_to_hire === null ? '—' : `${model.time.days_to_hire} days`
            }
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Applications" value={model ? String(model.totals.applications) : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Offers out" value={model ? String(model.totals.offers_out) : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Hires · last 30 days"
            value={model ? String(model.totals.hires_last_30_days) : '—'}
          />
        </BentoCard>

        {/* Time-to-hire trend + source effectiveness */}
        <BentoCard
          title="Time to hire"
          subtitle="Days to hire & offer"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {!model ? LOAD_FAILED : model.time.offers === 0 ? (
            <Muted>No offers or hires yet</Muted>
          ) : trendMonths.length < 2 ? (
            <Muted>Not enough history for a trend yet</Muted>
          ) : (
            <AreaTrend
              data={trendMonths}
              series={TIME_SERIES}
              height={240}
              showLegend
            />
          )}
        </BentoCard>
        <BentoCard
          title="Source effectiveness"
          subtitle="Hires by source"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : sourceMix.length === 0 ? (
            <Muted>No hires yet</Muted>
          ) : (
            <DonutStat
              data={sourceMix}
              height={240}
              centerValue={String(sourceMix.reduce((sum, row) => sum + row.value, 0))}
              centerLabel="hires"
            />
          )}
        </BentoCard>

        {/* Applications by job + offer-accept gauge */}
        <BentoCard
          title="Applications by job"
          subtitle="All time"
          icon={ChartColumn}
          className="col-span-2 md:col-span-8"
        >
          {!model ? LOAD_FAILED : model.byJob.length === 0 ? (
            <Muted>No applications yet</Muted>
          ) : (
            <BarGroup data={model.byJob} series={APPS_BY_JOB_SERIES} horizontal height={240} />
          )}
        </BentoCard>
        <BentoCard
          title="Offer-accept rate"
          subtitle="Accepted of offers made"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          {NOT_AVAILABLE}
        </BentoCard>

        {/* Pipeline funnel + recent activity */}
        <BentoCard
          title="Hiring pipeline"
          subtitle="Applied → hired"
          icon={Filter}
          className="col-span-2 md:col-span-6"
        >
          {!model ? LOAD_FAILED : model.totals.applications === 0 ? (
            <Muted>No applications yet</Muted>
          ) : (
            <FunnelFlow data={pipeline} height={220} />
          )}
        </BentoCard>
        <BentoCard
          title="Recent activity"
          subtitle="Across your pipeline"
          icon={Activity}
          className="col-span-2 md:col-span-6"
        >
          {!model ? LOAD_FAILED : model.activity.length === 0 ? (
            <Muted>Nothing yet</Muted>
          ) : (
            <ul className="space-y-2.5">
              {model.activity.map((a, index) => (
                <li key={`${a.text}-${index}`} className="flex items-start gap-2.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span className="min-w-0 flex-1 text-sm leading-snug">{a.text}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {a.when}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
