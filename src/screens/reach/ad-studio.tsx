import {
  BarChart3,
  Filter,
  Gauge,
  Megaphone,
  PieChart,
  TrendingUp,
  Users,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  DonutStat,
  FunnelFlow,
  RadialGauge,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { Button } from '@/components/ui/button';
import { AdStudioTable } from '@/components/reach/ad-studio-table';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { deriveAdsOverview, deriveSpendByChannel } from '@/lib/ai/tools';
import type { Campaign, Channel } from '@/lib/reach/types';
import { loadReachData } from './parts';

/* ---- demo-only values: no live source yet (shown only to demo viewers) ---- */

const SPEND_LEADS = [
  { label: 'Wk1', spend: 540, leads: 92 },
  { label: 'Wk2', spend: 620, leads: 101 },
  { label: 'Wk3', spend: 680, leads: 98 },
  { label: 'Wk4', spend: 760, leads: 128 },
  { label: 'Wk5', spend: 840, leads: 141 },
  { label: 'Wk6', spend: 840, leads: 150 },
];
const SPEND_LEADS_SERIES: Series[] = [
  { key: 'spend', label: 'Spend (RM)', color: 'var(--chart-2)' },
  { key: 'leads', label: 'Leads', color: 'var(--chart-1)' },
];

const CHANNEL_LABEL: Record<Channel, string> = {
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};
const CHANNEL_COLOR: Record<Channel, string> = {
  whatsapp: 'var(--chart-1)',
  facebook: 'var(--chart-2)',
  instagram: 'var(--chart-5)',
  tiktok: 'var(--chart-3)',
};

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

const LEADS_BY_CHANNEL_SERIES: Series[] = [
  { key: 'leads', label: 'Leads', color: 'var(--chart-1)' },
];

const AD_FUNNEL: Slice[] = [
  { key: 'impressions', label: 'Impressions', value: 420000, color: 'var(--chart-5)' },
  { key: 'reach', label: 'Reach', value: 128000, color: 'var(--chart-2)' },
  { key: 'clicks', label: 'Clicks', value: 9600, color: 'var(--chart-1)' },
  { key: 'leads', label: 'Leads', value: 700, color: 'var(--chart-3)' },
  { key: 'customers', label: 'Customers', value: 180, color: 'var(--chart-4)' },
];

/* ------------------------------------------------------------------ */

export default async function AdStudioScreen() {
  const [data, viewer] = await Promise.all([loadReachData(), getViewer()]);
  const campaigns: Campaign[] = await data.listCampaigns();
  const overview = deriveAdsOverview(campaigns);
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  const isDemo = viewer.isDemo;
  const na = <Muted>Not available yet</Muted>;

  const spendByChannel = deriveSpendByChannel(campaigns);
  const spendSlices: Slice[] = spendByChannel.by_channel
    .filter((c) => c.spend_cents > 0)
    .map((c) => ({
      key: c.channel,
      label: CHANNEL_LABEL[c.channel],
      value: c.spend_cents / 100,
      color: CHANNEL_COLOR[c.channel],
    }));
  const leadsByChannel = (Object.keys(CHANNEL_LABEL) as Channel[])
    .map((ch) => ({
      label: CHANNEL_LABEL[ch],
      leads: campaigns.filter((c) => c.channel === ch).reduce((a, c) => a + c.leads_count, 0),
    }))
    .filter((r) => r.leads > 0);

  return (
    <ScreenContainer>
      <PageHeader
        title="Ad Studio"
        subtitle="Create and manage AI-powered ad campaigns."
        actions={
          <Button variant="outline" size="sm">
            Connect Meta
          </Button>
        }
      />

      <BentoGrid>
        {/* Connect Meta promo banner */}
        <BentoCard className="col-span-2 border-primary/30 bg-primary/5 md:col-span-12">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
                  <path d="M13.5 21v-7h2.4l.4-2.8h-2.8V9.4c0-.8.2-1.4 1.4-1.4h1.5V5.5c-.3 0-1.1-.1-2.1-.1-2.1 0-3.5 1.3-3.5 3.6v2.2H8v2.8h2.7V21h2.8Z" />
                </svg>
              </div>
              <div>
                <p className="font-medium">Connect your Meta account</p>
                <p className="text-sm text-muted-foreground">
                  Link Meta to launch ads and sync leads straight into your pipeline.
                </p>
              </div>
            </div>
            <Button size="sm" className="shrink-0 self-start sm:self-auto">
              Login with Facebook
            </Button>
          </div>
        </BentoCard>

        {/* KPI row — active / spend / CPL are live; Reach has no source yet */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Active campaigns"
            value={String(overview.active_campaigns)}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Ad spend" value={overview.total_spend} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Reach"
            value={isDemo ? '128K' : 'Not available yet'}
            delta={isDemo ? '+9%' : undefined}
            deltaTone={isDemo ? 'up' : undefined}
            chart={
              isDemo ? (
                <Sparkline data={[88, 96, 104, 112, 121, 128]} color="var(--chart-5)" height={36} />
              ) : undefined
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Cost / lead" value={overview.blended_cpl} />
        </BentoCard>

        {/* Spend & leads trend + spend mix */}
        <BentoCard
          title="Spend & leads"
          subtitle="Last 6 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {isDemo ? (
            <AreaTrend data={SPEND_LEADS} series={SPEND_LEADS_SERIES} height={240} showLegend />
          ) : (
            na
          )}
        </BentoCard>
        <BentoCard
          title="Spend by channel"
          subtitle="All campaigns (RM)"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {spendSlices.length === 0 ? (
            <Muted>No campaigns yet</Muted>
          ) : (
            <DonutStat
              data={spendSlices}
              height={240}
              centerValue={(spendByChannel.total_spend_cents / 100).toLocaleString('en-MY', {
                maximumFractionDigits: 0,
              })}
              centerLabel="RM spend"
            />
          )}
        </BentoCard>

        {/* Leads by channel + ad funnel + budget */}
        <BentoCard
          title="Leads by channel"
          subtitle="All campaigns"
          icon={BarChart3}
          className="col-span-2 md:col-span-4"
        >
          {leadsByChannel.length === 0 ? (
            <Muted>No leads yet</Muted>
          ) : (
            <BarGroup
              data={leadsByChannel}
              series={LEADS_BY_CHANNEL_SERIES}
              horizontal
              height={200}
            />
          )}
        </BentoCard>
        <BentoCard
          title="Ad funnel"
          subtitle="Impression → customer"
          icon={Filter}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? <FunnelFlow data={AD_FUNNEL} height={200} /> : na}
        </BentoCard>
        <BentoCard
          title="Budget used"
          subtitle={isDemo ? 'RM 4,280 of RM 6,000' : undefined}
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? (
            <RadialGauge
              value={71}
              valueLabel="71%"
              label="of budget"
              color="var(--chart-2)"
              height={200}
            />
          ) : (
            na
          )}
        </BentoCard>

        {/* Campaigns table */}
        <BentoCard
          title="Campaigns"
          subtitle="Live & paused"
          icon={Megaphone}
          action={
            <Button variant="outline" size="sm">
              <Users className="size-4" />
              Audiences
            </Button>
          }
          className="col-span-2 md:col-span-12"
        >
          <AdStudioTable campaigns={campaigns} canEdit={canEdit} />
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
