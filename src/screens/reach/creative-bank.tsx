import {
  ChartColumn,
  Layers,
  PieChart,
  Sparkles,
  TrendingUp,
  Trophy,
  Upload,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  DonutStat,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CreativeBankGrid } from '@/components/reach/creative-bank-grid';
import { createClient } from '@/lib/supabase/server';
import { getReachData } from '@/lib/reach/supabase';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import type { Channel, Creative, CreativeType } from '@/lib/reach/types';

/* ---- demo-only values: no live source yet (shown only to demo viewers) ---- */

const PRODUCED = [
  { label: 'Mar', produced: 5, ai: 2 },
  { label: 'Apr', produced: 6, ai: 3 },
  { label: 'May', produced: 4, ai: 2 },
  { label: 'Jun', produced: 7, ai: 4 },
  { label: 'Jul', produced: 6, ai: 3 },
  { label: 'Aug', produced: 8, ai: 5 },
  { label: 'Sep', produced: 10, ai: 7 },
  { label: 'Oct', produced: 14, ai: 12 },
];
const PRODUCED_SERIES: Series[] = [
  { key: 'produced', label: 'Produced', color: 'var(--chart-1)' },
  { key: 'ai', label: 'AI-generated', color: 'var(--chart-5)' },
];

const CTR_SERIES: Series[] = [
  { key: 'ctr', label: 'Avg CTR %', color: 'var(--chart-2)' },
];

const TYPE_LABEL: Record<CreativeType, string> = {
  image: 'Image',
  video: 'Video',
  copy: 'Copy',
};
const TYPE_COLOR: Record<CreativeType, string> = {
  image: 'var(--chart-1)',
  video: 'var(--chart-5)',
  copy: 'var(--chart-3)',
};
const CHANNEL_LABEL: Record<Channel, string> = {
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};
const TYPES: readonly CreativeType[] = ['image', 'video', 'copy'];

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function avg(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, v) => a + v, 0) / values.length;
}

/* ------------------------------------------------------------------ */

export default async function CreativeBankScreen() {
  const supabase = await createClient();
  const [data, viewer] = await Promise.all([getReachData(supabase), getViewer()]);
  const creatives: Creative[] = await data.listCreatives();
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  const isDemo = viewer.isDemo;
  const na = <Muted>Not available yet</Muted>;

  const withCtr = creatives.filter((c): c is Creative & { ctr: number } => c.ctr !== null);
  const avgCtr = avg(withCtr.map((c) => c.ctr));
  const counts = TYPES.map((t) => ({ t, n: creatives.filter((c) => c.type === t).length }));
  const best = counts.reduce((m, c) => (c.n > m.n ? c : m), counts[0]);
  const typeMix: Slice[] = counts
    .filter((c) => c.n > 0)
    .map((c) => ({ key: c.t, label: TYPE_LABEL[c.t], value: c.n, color: TYPE_COLOR[c.t] }));
  const ctrByFormat = TYPES.map((t) => ({
    label: TYPE_LABEL[t],
    ctr: avg(withCtr.filter((c) => c.type === t).map((c) => c.ctr)),
  }))
    .filter((r): r is { label: string; ctr: number } => r.ctr !== null)
    .map((r) => ({ label: r.label, ctr: Number(r.ctr.toFixed(2)) }));
  const topCreatives = [...withCtr].sort((a, b) => b.ctr - a.ctr).slice(0, 5);
  const channelCount = new Set(creatives.map((c) => c.channel)).size;

  return (
    <ScreenContainer>
      <PageHeader
        className="mb-4"
        title="Creative Bank"
        subtitle="Your library of ad creatives and copy."
        actions={
          <>
            <Button variant="outline" size="sm">
              <Upload className="size-4" />
              Upload
            </Button>
            <Button size="sm">
              <Sparkles className="size-4 animate-twinkle" />
              Generate with AI
            </Button>
          </>
        }
      />

      <BentoGrid>
        {/* KPI row — total / avg CTR / best format are live; generated has no source yet */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Total creatives" value={String(creatives.length)} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Avg CTR"
            value={avgCtr === null ? 'Not available yet' : `${avgCtr.toFixed(1)}%`}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Best format"
            value={creatives.length === 0 ? '—' : TYPE_LABEL[best.t]}
            delta={
              creatives.length === 0
                ? undefined
                : `${Math.round((best.n / creatives.length) * 100)}% of mix`
            }
            deltaTone={creatives.length === 0 ? undefined : 'flat'}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Generated this month"
            value={isDemo ? '12' : 'Not available yet'}
            delta={isDemo ? '+45%' : undefined}
            deltaTone={isDemo ? 'up' : undefined}
            chart={
              isDemo ? (
                <Sparkline
                  data={[2, 3, 2, 4, 3, 5, 7, 12]}
                  color="var(--chart-1)"
                  height={36}
                />
              ) : undefined
            }
          />
        </BentoCard>

        {/* Production trend + type mix */}
        <BentoCard
          title="Creatives produced"
          subtitle="Last 8 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {isDemo ? (
            <AreaTrend data={PRODUCED} series={PRODUCED_SERIES} height={240} showLegend />
          ) : (
            na
          )}
        </BentoCard>
        <BentoCard
          title="Creatives by type"
          subtitle="Whole bank"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {typeMix.length === 0 ? (
            <Muted>No creatives yet</Muted>
          ) : (
            <DonutStat
              data={typeMix}
              height={240}
              centerValue={String(creatives.length)}
              centerLabel="creatives"
            />
          )}
        </BentoCard>

        {/* CTR by format + top performers */}
        <BentoCard
          title="Avg CTR by format"
          subtitle="Creatives with a CTR"
          icon={ChartColumn}
          className="col-span-2 md:col-span-4"
        >
          {ctrByFormat.length === 0 ? (
            <Muted>No CTR data yet</Muted>
          ) : (
            <BarGroup data={ctrByFormat} series={CTR_SERIES} horizontal height={200} />
          )}
        </BentoCard>
        <BentoCard
          title="Top performing creatives"
          subtitle="By click-through rate"
          icon={Trophy}
          className="col-span-2 md:col-span-8"
        >
          {topCreatives.length === 0 ? (
            <Muted>No CTR data yet</Muted>
          ) : (
            <ul className="divide-y">
              {topCreatives.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2.5">
                  <LiveDot active={c.status === 'active'} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {c.name}
                  </span>
                  <Badge variant="secondary" className="shrink-0">
                    {TYPE_LABEL[c.type]}
                  </Badge>
                  <span className="hidden w-24 shrink-0 text-right text-sm text-muted-foreground sm:block">
                    {CHANNEL_LABEL[c.channel] ?? c.channel}
                  </span>
                  <span className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums">
                    {c.ctr.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>

        {/* Library */}
        <BentoCard
          title="Creative library"
          subtitle={`${creatives.length} ${creatives.length === 1 ? 'creative' : 'creatives'} · ${channelCount} ${channelCount === 1 ? 'channel' : 'channels'}`}
          icon={Layers}
          className="col-span-2 md:col-span-12"
        >
          <CreativeBankGrid creatives={creatives} canEdit={canEdit} />
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
