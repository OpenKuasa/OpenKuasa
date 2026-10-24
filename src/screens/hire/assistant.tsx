import {
  Bot,
  CalendarCheck,
  Filter,
  Gauge,
  PieChart,
  Star,
  TrendingUp,
  UserCheck,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  DonutStat,
  FunnelFlow,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { buildHireOverviewModel } from '@/lib/hire/overview';
import { AskLekirHero } from '@/screens/hire/ask-lekir-hero';
import { FUNNEL_COLOR, LOAD_FAILED, Muted, NOT_AVAILABLE, loadHire, topSlices } from '@/screens/hire/parts';
import { loadServerGreeting } from '@/lib/greeting/server';

/* ---- static config ------------------------------------------------ */

const APPS_SERIES: Series[] = [
  { key: 'applied', label: 'Applied', color: 'var(--chart-1)' },
  { key: 'shortlisted', label: 'Shortlisted', color: 'var(--chart-2)' },
];

const SOURCE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

/** Sample crew, shown to demo visitors only. */
const AGENTS = [
  { name: 'Resume Screener', active: true },
  { name: 'Interview Scheduler', active: true },
  { name: 'JD Writer', active: true },
  { name: 'Sourcing Bot', active: false },
];

const PROMPTS = [
  'Who to interview next?',
  'Pipeline for Sales Exec',
  'Time to hire',
  'Draft a JD for Software Engineer',
];

const initials = (name: string) =>
  name
    .split(' ')
    .map((w) => w[0])
    .join('');

/* ------------------------------------------------------------------ */

export default async function OverviewScreen() {
  // Started first so the greeting loads alongside the screen's own reads.
  const greetingPromise = loadServerGreeting('hire');
  void greetingPromise.catch(() => {});
  const { model, isDemo } = await loadHire('overview', buildHireOverviewModel);
  const applications = model?.totals.applications ?? 0;
  const noApplications = applications === 0;
  const sourceMix: Slice[] = topSlices(
    model?.sources ?? [],
    (r) => r.applications,
    (r) => r.source,
  ).map((row, index) => ({
    ...row,
    color: SOURCE_COLORS[index],
  }));
  const pipeline: Slice[] = (model?.funnel ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    value: f.value,
    color: FUNNEL_COLOR[f.key],
  }));

  return (
    <ScreenContainer>
      <BentoGrid>
        {/* Ask-Lekir hero */}
        <BentoCard tone="primary" className="col-span-2 md:col-span-12">
          <AskLekirHero prompts={PROMPTS} isDemo={isDemo} greeting={await greetingPromise} />
        </BentoCard>

        {/* KPI row: headline figures only, the tables hold no history to chart */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Open roles"
            value={model ? String(model.totals.open_jobs) : '—'}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Applications" value={model ? String(applications) : '—'} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Interviews · next 7 days"
            value={model ? String(model.totals.interviews_next_7_days) : '—'}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Offers out" value={model ? String(model.totals.offers_out) : '—'} />
        </BentoCard>

        {/* Applications trend + source mix */}
        <BentoCard
          title="Applications over time"
          subtitle="Last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {!model ? LOAD_FAILED : noApplications ? (
            <Muted>No applications yet</Muted>
          ) : (
            <AreaTrend data={model.trend} series={APPS_SERIES} height={240} showLegend />
          )}
        </BentoCard>
        <BentoCard
          title="Applications by source"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : noApplications ? (
            <Muted>No applications yet</Muted>
          ) : (
            <DonutStat
              data={sourceMix}
              height={240}
              centerValue={String(applications)}
              centerLabel="applications"
            />
          )}
        </BentoCard>

        {/* Pipeline + AI recruiters + offer-accept */}
        <BentoCard
          title="Hiring pipeline"
          subtitle="Applied → hired"
          icon={Filter}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : noApplications ? (
            <Muted>No applications yet</Muted>
          ) : (
            <FunnelFlow data={pipeline} height={200} />
          )}
        </BentoCard>
        <BentoCard
          title="AI recruiters"
          subtitle="Your always-on crew"
          icon={Bot}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? (
            <div className="grid grid-cols-1 gap-2">
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
            NOT_AVAILABLE
          )}
        </BentoCard>
        <BentoCard
          title="Offer-accept rate"
          subtitle="Last 90 days"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          {NOT_AVAILABLE}
        </BentoCard>

        {/* Upcoming interviews + top candidates */}
        <BentoCard
          title="Upcoming interviews"
          subtitle="Next on your calendar"
          icon={CalendarCheck}
          className="col-span-2 md:col-span-6"
        >
          {!model ? LOAD_FAILED : model.interviews.length === 0 ? (
            <Muted>No interviews scheduled</Muted>
          ) : (
            <ul className="space-y-2">
              {model.interviews.map((i, index) => (
                <li
                  key={`${i.name}-${index}`}
                  className="flex items-center gap-3 rounded-lg border bg-background/50 px-3 py-2"
                >
                  <LiveDot active={i.soon} />
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {initials(i.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{i.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{i.role}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs font-medium">{i.when}</p>
                    <p className="text-xs text-muted-foreground">{i.via}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>
        <BentoCard
          title="Top candidates"
          subtitle="Highest rated"
          icon={UserCheck}
          className="col-span-2 md:col-span-6"
        >
          {!model ? LOAD_FAILED : model.top.length === 0 ? (
            <Muted>No rated candidates yet</Muted>
          ) : (
            <ul className="divide-y">
              {model.top.map((c, index) => (
                <li key={`${c.name}-${index}`} className="flex items-center gap-3 py-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {initials(c.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.role} · {c.source}
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    <Star className="size-3" />
                    {c.rating}/5
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
