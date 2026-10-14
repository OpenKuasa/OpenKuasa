import {
  Bot,
  CalendarDays,
  Coins,
  Filter,
  HeartPulse,
  Megaphone,
  PieChart,
  TrendingUp,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  DonutStat,
  FunnelFlow,
  HeatGrid,
  RadialGauge,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { AskJebatHero } from '@/components/reach/ask-jebat-hero';
import { createClient } from '@/lib/supabase/server';
import { isLiveChatAllowed } from '@/lib/ai/access';
import { getReachData } from '@/lib/reach/supabase';
import { buildOverviewModel, type OverviewModel } from '@/lib/reach/overview';

/* ---- mock data (Rimba Ventures Sdn Bhd) --------------------------- */

const LEADS_SERIES: Series[] = [
  { key: 'leads', label: 'Leads', color: 'var(--chart-1)' },
  { key: 'qualified', label: 'Qualified', color: 'var(--chart-2)' },
];

const SPEND_SERIES: Series[] = [
  { key: 'spend', label: 'Spend (RM)', color: 'var(--chart-2)' },
];

const HEAT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HEAT_SLOTS = ['6a', '9a', '12p', '3p', '6p', '9p'];
const HEAT_VALUES = [
  [1, 3, 5, 4, 8, 6],
  [2, 4, 6, 5, 9, 7],
  [1, 3, 5, 6, 8, 6],
  [2, 5, 7, 6, 10, 8],
  [3, 6, 8, 7, 11, 9],
  [4, 7, 9, 10, 12, 11],
  [3, 6, 8, 9, 11, 10],
];

const AGENTS = [
  { name: 'Lead Qualifier', active: true },
  { name: 'Ad Optimizer', active: true },
  { name: 'Follow-up Writer', active: true },
  { name: 'Audience Finder', active: false },
];

const PROMPTS = [
  'Draft a Raya promo campaign',
  'Which ad is performing best?',
  'Lower my cost per lead',
];

const CHANNEL_COLOR: Record<string, string> = {
  whatsapp: 'var(--chart-1)',
  facebook: 'var(--chart-2)',
  instagram: 'var(--chart-5)',
  tiktok: 'var(--chart-3)',
  web: 'var(--chart-4)',
};
const FUNNEL_COLOR: Record<string, string> = {
  lead: 'var(--chart-1)',
  contacted: 'var(--chart-2)',
  qualified: 'var(--chart-5)',
  booked: 'var(--chart-3)',
  won: 'var(--chart-4)',
};

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ */

export default async function OverviewScreen() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isDemo = !isLiveChatAllowed(user);

  let model: OverviewModel | null = null;
  try {
    model = await buildOverviewModel(await getReachData(supabase), new Date());
  } catch (e) {
    console.error('[reach/overview] data error:', e);
  }
  const empty = model?.isEmpty ?? false;
  const failed = (
    <Muted>Couldn&apos;t load your dashboard — please refresh</Muted>
  );
  const na = <Muted>Not available yet</Muted>;
  const channelMix: Slice[] = (model?.channelMix ?? []).map((c) => ({
    key: c.key,
    label: c.label,
    value: c.value,
    color: CHANNEL_COLOR[c.key],
  }));
  const funnel: Slice[] = (model?.funnel ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    value: f.value,
    color: FUNNEL_COLOR[f.key],
  }));
  const hasSpend = (model?.spendByChannel ?? []).some((c) => c.spend > 0);

  return (
    <ScreenContainer>
      <BentoGrid>
        {/* Ask-Jebat hero */}
        <BentoCard tone="primary" className="col-span-2 md:col-span-12">
          <AskJebatHero prompts={PROMPTS} isDemo={isDemo} />
        </BentoCard>

        {/* KPI row — only leads has a weekly series; the rest are headline-only */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Total leads"
            value={model ? String(model.kpis.leads.value) : '—'}
            onPrimary
            chart={
              model && model.kpis.leads.spark.length > 0 ? (
                <Sparkline
                  data={model.kpis.leads.spark}
                  color="var(--primary-foreground)"
                  height={36}
                />
              ) : undefined
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Ad spend" value={model ? model.kpis.spendRm : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Cost / lead" value={model ? model.kpis.cplRm : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Conversion"
            value={model ? `${model.kpis.conversionPct}%` : '—'}
          />
        </BentoCard>

        {/* Leads over time + channel mix */}
        <BentoCard
          title="Leads over time"
          subtitle="Last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {!model ? failed : empty ? (
            <Muted>No leads yet</Muted>
          ) : (
            <AreaTrend data={model.leadsTrend} series={LEADS_SERIES} height={240} showLegend />
          )}
        </BentoCard>
        <BentoCard
          title="Leads by channel"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? failed : empty ? (
            <Muted>No leads yet</Muted>
          ) : (
            <DonutStat
              data={channelMix}
              height={240}
              centerValue={String(model.kpis.leads.value)}
              centerLabel="leads"
            />
          )}
        </BentoCard>

        {/* Spend + funnel + health */}
        <BentoCard
          title="Spend by channel"
          subtitle="All campaigns (RM)"
          icon={Coins}
          className="col-span-2 md:col-span-4"
        >
          {!model ? failed : !hasSpend ? (
            <Muted>No campaigns yet</Muted>
          ) : (
            <BarGroup
              data={model.spendByChannel}
              series={SPEND_SERIES}
              horizontal
              height={200}
            />
          )}
        </BentoCard>
        <BentoCard
          title="Lead funnel"
          subtitle="Lead → won"
          icon={Filter}
          className="col-span-2 md:col-span-4"
        >
          {!model ? failed : empty ? (
            <Muted>No leads yet</Muted>
          ) : (
            <FunnelFlow data={funnel} height={200} />
          )}
        </BentoCard>
        <BentoCard
          title="Ad engine health"
          subtitle="Setup & delivery"
          icon={HeartPulse}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? (
            <RadialGauge value={86} label="healthy" valueLabel="86%" height={200} />
          ) : (
            na
          )}
        </BentoCard>

        {/* Campaigns + best time */}
        <BentoCard
          title="Top campaigns"
          subtitle="By cost per lead"
          icon={Megaphone}
          className="col-span-2 md:col-span-8"
        >
          {!model ? failed : model.topCampaigns.length === 0 ? (
            <Muted>No campaigns yet</Muted>
          ) : (
            <ul className="divide-y">
              {model.topCampaigns.map((c, i) => (
                <li key={i} className="flex items-center gap-3 py-2.5">
                  <LiveDot active={c.status === 'Active'} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {c.name}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    {c.leads} leads
                  </span>
                  <span className="w-20 shrink-0 text-right text-sm tabular-nums">
                    {c.cpl}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>
        <BentoCard
          title="Best time to engage"
          subtitle="Lead replies by slot"
          icon={CalendarDays}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? (
            <HeatGrid xLabels={HEAT_SLOTS} yLabels={HEAT_DAYS} values={HEAT_VALUES} />
          ) : (
            na
          )}
        </BentoCard>

        {/* Agents + appointments */}
        <BentoCard
          title="AI agents"
          subtitle="Your always-on crew"
          icon={Bot}
          className="col-span-2 md:col-span-6"
        >
          {isDemo ? (
            <div className="grid grid-cols-2 gap-2">
              {AGENTS.map((a) => (
                <div
                  key={a.name}
                  className="flex items-center gap-2 rounded-lg border bg-background/50 px-3 py-2"
                >
                  <LiveDot active={a.active} />
                  <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {a.active ? 'Active' : 'Paused'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            na
          )}
        </BentoCard>
        <BentoCard
          title="Upcoming appointments"
          icon={CalendarDays}
          className="col-span-2 md:col-span-6"
        >
          {!model ? failed : model.appointments.length === 0 ? (
            <Muted>No upcoming appointments</Muted>
          ) : (
            <ul className="space-y-2">
              {model.appointments.map((a, i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 rounded-lg border bg-background/50 px-3 py-2"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {a.name
                      .split(' ')
                      .map((w) => w[0])
                      .join('')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{a.kind}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs font-medium">{a.when}</p>
                    <p className="text-xs text-muted-foreground">{a.via}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
