import { Filter, Gauge, MapPin, PieChart, TrendingUp, Users } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  DonutStat,
  FunnelFlow,
  RadialGauge,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { ReportsControls } from '@/components/reach/reports-controls';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { createClient } from '@/lib/supabase/server';
import { getReachData } from '@/lib/reach/supabase';
import { deriveReportsModel, type ReportRange } from '@/lib/reach/reports';
import { LEAD_STAGES, type LeadChannel, type LeadStage } from '@/lib/reach/types';

const RANGES: readonly ReportRange[] = ['7d', '30d', '90d'];
const RANGE_LABEL: Record<ReportRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};
const CHANNEL_LABEL: Record<LeadChannel, string> = {
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  web: 'Website',
};
const CHANNEL_COLOR: Record<LeadChannel, string> = {
  whatsapp: 'var(--chart-1)',
  facebook: 'var(--chart-2)',
  instagram: 'var(--chart-5)',
  tiktok: 'var(--chart-3)',
  web: 'var(--chart-4)',
};
const STAGE_LABEL: Record<LeadStage, string> = {
  lead: 'Leads',
  contacted: 'Contacted',
  qualified: 'Qualified',
  booked: 'Booked',
  won: 'Won',
};
const STAGE_COLOR: Record<LeadStage, string> = {
  lead: 'var(--chart-1)',
  contacted: 'var(--chart-2)',
  qualified: 'var(--chart-5)',
  booked: 'var(--chart-3)',
  won: 'var(--chart-4)',
};
const LEADS_SERIES: Series[] = [
  { key: 'leads', label: 'Leads', color: 'var(--chart-1)' },
  { key: 'qualified', label: 'Qualified', color: 'var(--chart-2)' },
];

function parseRange(value: string | string[] | undefined): ReportRange {
  const v = Array.isArray(value) ? value[0] : value;
  return RANGES.find((r) => r === v) ?? '30d';
}

function EmptyPanel({ children }: { children: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

const NO_DATA = 'No data for this range yet';

export default async function ReportsScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const range = parseRange(sp.range);

  const data = await getReachData(await createClient());
  const [campaigns, leads, appts] = await Promise.all([
    data.listCampaigns(),
    data.listLeads(),
    data.listAppointments(),
  ]);
  const model = deriveReportsModel(leads, campaigns, appts, range, new Date());

  const hasLeads = model.totalLeads > 0;
  const funnel: Slice[] = LEAD_STAGES.map((stage) => ({
    key: stage,
    label: STAGE_LABEL[stage],
    value: model.funnel[stage],
    color: STAGE_COLOR[stage],
  }));
  const bySource: Slice[] = model.leadsByChannel.map((r) => ({
    key: r.channel,
    label: CHANNEL_LABEL[r.channel],
    value: r.leads,
    color: CHANNEL_COLOR[r.channel],
  }));
  const qualifiedCount = model.funnel.qualified;
  const qualRate = hasLeads ? Math.round((qualifiedCount / model.totalLeads) * 100) : 0;
  const winRate = hasLeads
    ? `${Math.round((model.funnel.won / model.totalLeads) * 1000) / 10}%`
    : '—';
  const { appointmentStats: ap } = model;
  const trendLeads = model.leadsTrend.map((p) => p.leads);
  const trendQualified = model.leadsTrend.map((p) => p.qualified);

  return (
    <ScreenContainer>
      <PageHeader
        title="Reports"
        subtitle="Lead, conversion and pipeline analytics."
        actions={<ReportsControls range={range} />}
      />

      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Total leads"
            value={String(model.totalLeads)}
            onPrimary
            chart={
              hasLeads ? (
                <Sparkline data={trendLeads} color="var(--primary-foreground)" height={36} />
              ) : undefined
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Win rate"
            value={winRate}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Show rate"
            value={ap.show_rate_pct === null ? '—' : `${ap.show_rate_pct}%`}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Qualified"
            value={String(qualifiedCount)}
            chart={
              hasLeads ? (
                <Sparkline data={trendQualified} color="var(--chart-5)" height={36} />
              ) : undefined
            }
          />
        </BentoCard>

        {/* Trend + source mix */}
        <BentoCard
          title="Leads vs qualified"
          subtitle={RANGE_LABEL[range]}
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {hasLeads ? (
            <AreaTrend data={model.leadsTrend} series={LEADS_SERIES} height={240} showLegend />
          ) : (
            <EmptyPanel>{NO_DATA}</EmptyPanel>
          )}
        </BentoCard>
        <BentoCard title="Leads by source" icon={PieChart} className="col-span-2 md:col-span-4">
          {bySource.length > 0 ? (
            <DonutStat
              data={bySource}
              height={240}
              centerValue={String(model.totalLeads)}
              centerLabel="leads"
            />
          ) : (
            <EmptyPanel>{NO_DATA}</EmptyPanel>
          )}
        </BentoCard>

        {/* Funnel + geography + qualification */}
        <BentoCard
          title="Lead → won"
          subtitle="Pipeline conversion"
          icon={Filter}
          className="col-span-2 md:col-span-4"
        >
          {hasLeads ? (
            <FunnelFlow data={funnel} height={200} />
          ) : (
            <EmptyPanel>{NO_DATA}</EmptyPanel>
          )}
        </BentoCard>
        <BentoCard
          title="Leads by state"
          subtitle={RANGE_LABEL[range]}
          icon={MapPin}
          className="col-span-2 md:col-span-4"
        >
          <EmptyPanel>Not available yet</EmptyPanel>
        </BentoCard>
        <BentoCard
          title="Qualification rate"
          subtitle="Qualified of all leads"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          {hasLeads ? (
            <RadialGauge
              value={qualRate}
              valueLabel={`${qualRate}%`}
              label="qualified"
              color="var(--chart-2)"
              height={200}
            />
          ) : (
            <EmptyPanel>{NO_DATA}</EmptyPanel>
          )}
        </BentoCard>

        {/* Top sources table */}
        <BentoCard
          title="Top sources"
          subtitle={`By leads, ${RANGE_LABEL[range].toLowerCase()}`}
          icon={Users}
          className="col-span-2 md:col-span-12"
        >
          {model.topChannels.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Qualified</TableHead>
                    <TableHead className="text-right">Qualified %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.topChannels.map((r) => (
                    <TableRow key={r.channel}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {CHANNEL_LABEL[r.channel]}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.leads}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.qualified}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.conv_pct}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyPanel>{NO_DATA}</EmptyPanel>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
