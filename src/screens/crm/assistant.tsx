import {
  Activity,
  Filter,
  Flame,
  Gauge,
  ListChecks,
  PieChart,
  TrendingUp,
  Users,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  DonutStat,
  RadialGauge,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { createClient } from '@/lib/supabase/server';
import { isLiveChatAllowed } from '@/lib/ai/access';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { formatRM, formatWinRate } from '@/lib/crm/deal-stats';
import { loadCrmOverview, type CrmOverviewModel } from '@/lib/crm/overview';
import { cn } from '@/lib/utils';
import { AskKasturiHero } from './ask-kasturi-hero';
import { loadServerGreeting } from '@/lib/greeting/server';

/* ---- sample data (Rimba Ventures Sdn Bhd), shown when no database is configured ---- */

const SAMPLE_OVERVIEW: CrmOverviewModel = {
  isEmpty: false,
  kpis: { pipelineValue: 486_000, openDeals: 38, winRate: 32, wonThisMonth: 128_000 },
  trend: [
    { label: '16 Aug', created: 11, won: 2 },
    { label: '23 Aug', created: 9, won: 3 },
    { label: '30 Aug', created: 12, won: 2 },
    { label: '6 Sep', created: 10, won: 4 },
    { label: '13 Sep', created: 14, won: 3 },
    { label: '20 Sep', created: 12, won: 5 },
    { label: '27 Sep', created: 15, won: 4 },
    { label: '4 Oct', created: 13, won: 6 },
  ],
  pipelineName: 'Sales pipeline',
  stages: [
    { key: 'lead', label: 'Lead', count: 12, value: 120_000 },
    { key: 'qualified', label: 'Qualified', count: 9, value: 98_000 },
    { key: 'proposal', label: 'Proposal', count: 8, value: 132_000 },
    { key: 'negotiation', label: 'Negotiation', count: 6, value: 94_000 },
    { key: 'won', label: 'Won', count: 3, value: 42_000 },
  ],
  owners: [
    { label: 'Aisyah', deals: 12 },
    { label: 'Faiz', deals: 9 },
    { label: 'Zaki', deals: 9 },
    { label: 'Nurul', deals: 8 },
  ],
  closingSoon: [
    { id: 's1', name: 'Lim Hardware — Fitout', stage: 'Negotiation', value: 15000, closes: '12 Oct' },
    { id: 's2', name: 'Aisyah Trading — Bulk order', stage: 'Proposal', value: 12000, closes: '13 Oct' },
    { id: 's3', name: 'Nurul Boutique — POS setup', stage: 'Qualified', value: 8900, closes: '14 Oct' },
    { id: 's4', name: 'Siti Decor — Event', stage: 'Proposal', value: 7200, closes: '15 Oct' },
    { id: 's5', name: 'Faiz Studio — Branding', stage: 'Qualified', value: 5400, closes: '16 Oct' },
  ],
  closingSoonTotal: 5,
  followUps: [
    { id: 'f1', title: 'Follow up with Aisyah Trading on bulk order', due: '9 Oct', overdue: true },
    { id: 'f2', title: 'Send revised quote to Lim Hardware', due: 'Today', overdue: false },
    { id: 'f3', title: 'Call Nurul Huda re: POS setup', due: 'Today', overdue: false },
    { id: 'f4', title: 'Prepare proposal for Siti Decor event', due: '12 Oct', overdue: false },
  ],
  activity: [
    { text: 'Aisyah Rahim added via Lead form', when: '8m' },
    { text: 'WhatsApp logged: Sent price list to Lim Hardware', when: '1h' },
    { text: 'Follow-up done: Call Nurul Huda', when: '3h' },
    { text: 'New deal: Zaki Enterprise — Renovation', when: '5h' },
    { text: 'Won Rahman Logistics — Fleet tracking · RM 24,000', when: '1d' },
  ],
};

const TREND_SERIES: Series[] = [
  { key: 'created', label: 'Created', color: 'var(--chart-1)' },
  { key: 'won', label: 'Won', color: 'var(--chart-2)' },
];
const OWNER_SERIES: Series[] = [
  { key: 'deals', label: 'Open deals', color: 'var(--chart-2)' },
];
const VALUE_SERIES: Series[] = [
  { key: 'value', label: 'Open value (RM)', color: 'var(--chart-1)' },
];
const STAGE_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-5)',
  'var(--chart-3)',
  'var(--chart-4)',
];

// Each is answered by a lookup Kasturi has, on the workspace's own data.
const PROMPTS = [
  'How much is my pipeline worth?',
  'Which stage holds the most deals?',
  'Show my newest contacts',
];

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ */

export default async function OverviewScreen() {
  // Started first so the greeting loads alongside the screen's own reads.
  const greetingPromise = loadServerGreeting('crm');
  void greetingPromise.catch(() => {});
  // The workspace's own figures. With no database configured the screen shows
  // the sample; a workspace whose figures could not be read shows that instead.
  const isSample = !hasSupabaseEnv();
  let model: CrmOverviewModel | null = isSample ? SAMPLE_OVERVIEW : null;
  // Without a database there is nobody signed in, so the chat stays a demo.
  let isDemo = true;
  if (!isSample) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    isDemo = !isLiveChatAllowed(user);
    try {
      const org = await getCurrentOrg(supabase);
      if (org) model = await loadCrmOverview(supabase, org.orgId, new Date());
    } catch (e) {
      console.error('[crm/overview] data error:', e);
    }
  }

  const failed = <Muted>Couldn&apos;t load your dashboard — please refresh</Muted>;
  const noDeals = <Muted>No deals yet</Muted>;
  const hasDeals = model ? model.trend.some((w) => w.created > 0 || w.won > 0) : false;
  const stageCounts: Slice[] = (model?.stages ?? [])
    .map((stage, i) => ({
      key: stage.key,
      label: stage.label,
      value: stage.count,
      color: STAGE_COLORS[i % STAGE_COLORS.length],
    }))
    .filter((slice) => slice.value > 0);
  const stageValues = (model?.stages ?? []).map((stage) => ({ label: stage.label, value: stage.value }));
  const hasStageValue = stageValues.some((stage) => stage.value > 0);
  const stageSubtitle = model?.pipelineName ? `Open deals · ${model.pipelineName}` : 'Open deals';

  return (
    <ScreenContainer>
      <BentoGrid>
        {/* Ask-Kasturi hero */}
        <BentoCard tone="primary" className="col-span-2 md:col-span-12">
          <AskKasturiHero prompts={PROMPTS} isDemo={isDemo} greeting={await greetingPromise} />
        </BentoCard>

        {/* KPI row: headline figures only, there is no history to compare them with */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Pipeline value"
            value={model ? formatRM(model.kpis.pipelineValue) : '—'}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Open deals" value={model ? String(model.kpis.openDeals) : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Win rate" value={model ? formatWinRate(model.kpis.winRate) : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Revenue won · this month"
            value={model ? formatRM(model.kpis.wonThisMonth) : '—'}
          />
        </BentoCard>

        {/* Deals trend + stage mix */}
        <BentoCard
          title="Deals over time"
          subtitle="Created and won · last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {!model ? failed : !hasDeals ? (
            <Muted>No deals in the last 8 weeks</Muted>
          ) : (
            <AreaTrend data={model.trend} series={TREND_SERIES} height={240} showLegend />
          )}
        </BentoCard>
        <BentoCard
          title="Deals by stage"
          subtitle={stageSubtitle}
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? failed : stageCounts.length === 0 ? (
            <Muted>No open deals yet</Muted>
          ) : (
            <DonutStat
              data={stageCounts}
              height={240}
              centerValue={String(stageCounts.reduce((n, s) => n + s.value, 0))}
              centerLabel="open"
            />
          )}
        </BentoCard>

        {/* Pipeline value + owners + win rate */}
        <BentoCard
          title="Pipeline value"
          subtitle="Open deals by stage (RM)"
          icon={Filter}
          className="col-span-2 md:col-span-4"
        >
          {!model ? failed : !hasStageValue ? (
            <Muted>No open deals yet</Muted>
          ) : (
            <BarGroup data={stageValues} series={VALUE_SERIES} horizontal height={200} />
          )}
        </BentoCard>
        <BentoCard
          title="Deals by owner"
          subtitle="Open deals per person"
          icon={Users}
          className="col-span-2 md:col-span-4"
        >
          {!model ? failed : model.owners.length === 0 ? (
            <Muted>No open deals yet</Muted>
          ) : (
            <BarGroup data={model.owners} series={OWNER_SERIES} horizontal height={200} />
          )}
        </BentoCard>
        <BentoCard
          title="Win rate"
          subtitle="Won out of deals closed"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          {!model ? failed : model.kpis.winRate === null ? (
            <Muted>No deal has closed yet</Muted>
          ) : (
            <RadialGauge
              value={model.kpis.winRate}
              label="won"
              valueLabel={`${model.kpis.winRate}%`}
              height={200}
            />
          )}
        </BentoCard>

        {/* Deals closing soon + recent activity */}
        <BentoCard
          title="Deals closing soon"
          subtitle="Next 7 days"
          icon={Flame}
          className="col-span-2 md:col-span-8"
        >
          {!model ? failed : model.isEmpty ? noDeals : model.closingSoon.length === 0 ? (
            <Muted>No open deal is due to close in the next 7 days</Muted>
          ) : (
            <>
              <ul className="divide-y">
                {model.closingSoon.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 py-2.5">
                    <LiveDot active />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</span>
                    {d.stage && (
                      <span className="hidden shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary sm:inline-block">
                        {d.stage}
                      </span>
                    )}
                    <span className="hidden w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:inline-block">
                      {d.closes}
                    </span>
                    <span className="w-24 shrink-0 text-right text-sm font-semibold tabular-nums">
                      {formatRM(d.value)}
                    </span>
                  </li>
                ))}
              </ul>
              {model.closingSoonTotal > model.closingSoon.length && (
                <p className="pt-2 text-xs text-muted-foreground">
                  and {model.closingSoonTotal - model.closingSoon.length} more on the Deals screen
                </p>
              )}
            </>
          )}
        </BentoCard>
        <BentoCard
          title="Recent activity"
          subtitle="Across your deals"
          icon={Activity}
          className="col-span-2 md:col-span-4"
        >
          {!model ? failed : model.activity.length === 0 ? (
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

        {/* Follow-ups */}
        <BentoCard
          title="Follow-ups"
          subtitle="Open, soonest first"
          icon={ListChecks}
          className="col-span-2 md:col-span-12"
        >
          {!model ? failed : model.followUps.length === 0 ? (
            <Muted>No open follow-ups</Muted>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {model.followUps.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center gap-3 rounded-lg border bg-background/50 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                  <span
                    className={cn(
                      'shrink-0 text-xs tabular-nums',
                      t.overdue ? 'font-medium text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    {t.overdue ? `Overdue · ${t.due}` : t.due}
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
