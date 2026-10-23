import {
  BarChart3,
  Gauge,
  Megaphone,
  PieChart,
  Plus,
  TrendingUp,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LiveDot } from '@/components/ui/live-dot';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/* ---- mock data (Rimba Ventures Sdn Bhd) --------------------------- */

/* KPI sparkline trends (last 8 weeks) --------------------------------- */
const SPARK_SENT = [480, 560, 520, 720, 660, 840, 790, 906];
const SPARK_DELIVERED = [96.4, 96.9, 97.2, 97.5, 97.6, 97.9, 98.0, 98.1];
const SPARK_OPEN = [54, 56, 57, 59, 58, 60, 61, 61];
const SPARK_REPLIES = [120, 138, 129, 152, 148, 170, 159, 186];

/* Sends over time ----------------------------------------------------- */
const SENDS_TREND = [
  { label: 'Wk1', sent: 480, delivered: 470 },
  { label: 'Wk2', sent: 560, delivered: 548 },
  { label: 'Wk3', sent: 520, delivered: 508 },
  { label: 'Wk4', sent: 720, delivered: 702 },
  { label: 'Wk5', sent: 660, delivered: 642 },
  { label: 'Wk6', sent: 840, delivered: 820 },
  { label: 'Wk7', sent: 790, delivered: 770 },
  { label: 'Wk8', sent: 906, delivered: 888 },
];
const SENDS_SERIES: Series[] = [
  { key: 'sent', label: 'Sent', color: 'var(--chart-1)' },
  { key: 'delivered', label: 'Delivered', color: 'var(--chart-2)' },
];

/* Messages by channel (last 30 days) ---------------------------------- */
const CHANNEL_MIX: Slice[] = [
  { key: 'whatsapp', label: 'WhatsApp', value: 2980, color: 'var(--chart-1)' },
  { key: 'email', label: 'Email', value: 1760, color: 'var(--chart-2)' },
  { key: 'sms', label: 'SMS', value: 736, color: 'var(--chart-5)' },
];

/* Engagement by broadcast — open rate % of each sent blast ------------ */
const ENGAGEMENT = [
  { label: 'Salam Aidilfitri', open: 71 },
  { label: 'Ramadan Promo', open: 64 },
  { label: 'Hari Merdeka', open: 58 },
  { label: 'Newsletter #42', open: 52 },
  { label: 'Flash Sale', open: 44 },
];
const ENGAGEMENT_SERIES: Series[] = [
  { key: 'open', label: 'Open rate %', color: 'var(--chart-2)' },
];

/* Broadcasts table ---------------------------------------------------- */
type BroadcastStatus = 'Sent' | 'Sending' | 'Scheduled' | 'Draft';

type Broadcast = {
  name: string;
  channel: 'WhatsApp' | 'Email' | 'SMS';
  audience: string;
  sent: string;
  delivered: string;
  opened: string;
  status: BroadcastStatus;
};

const BROADCASTS: Broadcast[] = [
  {
    name: 'Salam Aidilfitri 2026',
    channel: 'WhatsApp',
    audience: 'All contacts',
    sent: '1,284',
    delivered: '98%',
    opened: '71%',
    status: 'Sent',
  },
  {
    name: 'Ramadan Promo Blast',
    channel: 'WhatsApp',
    audience: 'Customers',
    sent: '612',
    delivered: '99%',
    opened: '64%',
    status: 'Sent',
  },
  {
    name: 'Weekly Newsletter #42',
    channel: 'Email',
    audience: 'Subscribers',
    sent: '1,860',
    delivered: '96%',
    opened: '52%',
    status: 'Sent',
  },
  {
    name: 'Hari Merdeka Greeting',
    channel: 'Email',
    audience: 'All contacts',
    sent: '1,240',
    delivered: '97%',
    opened: '58%',
    status: 'Sent',
  },
  {
    name: 'Flash Sale Jumaat',
    channel: 'WhatsApp',
    audience: 'New Leads',
    sent: '480',
    delivered: '97%',
    opened: '44%',
    status: 'Sending',
  },
  {
    name: 'Win-back: Pelanggan Lama',
    channel: 'Email',
    audience: 'Churned (90d)',
    sent: '—',
    delivered: '—',
    opened: '—',
    status: 'Scheduled',
  },
  {
    name: 'Peringatan Bayaran',
    channel: 'SMS',
    audience: 'Invois tertunggak',
    sent: '—',
    delivered: '—',
    opened: '—',
    status: 'Scheduled',
  },
  {
    name: 'Produk Baharu Teaser',
    channel: 'WhatsApp',
    audience: 'VIP customers',
    sent: '—',
    delivered: '—',
    opened: '—',
    status: 'Draft',
  },
];

const STATUS_STYLES: Record<BroadcastStatus, string> = {
  Sent: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  Sending: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  Scheduled: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  Draft: 'bg-muted text-muted-foreground',
};

/* ------------------------------------------------------------------ */

export default function BroadcastScreen() {
  return (
    <ScreenContainer>
      <PageHeader
        title="Broadcast"
        subtitle="WhatsApp, email & SMS campaigns to your contacts."
        actions={
          <Button size="sm">
            <Plus className="size-4" />
            New Broadcast
          </Button>
        }
      />

      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Messages sent"
            value="5,476"
            delta="+18%"
            onPrimary
            chart={
              <Sparkline
                data={SPARK_SENT}
                color="var(--primary-foreground)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Delivered"
            value="98%"
            delta="+0.6pt"
            deltaTone="up"
            chart={
              <Sparkline data={SPARK_DELIVERED} color="var(--chart-2)" height={36} />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Open rate"
            value="61%"
            delta="+3pt"
            deltaTone="up"
            chart={<Sparkline data={SPARK_OPEN} color="var(--chart-1)" height={36} />}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Replies"
            value="1,042"
            delta="+9%"
            deltaTone="up"
            chart={<Sparkline data={SPARK_REPLIES} color="var(--chart-3)" height={36} />}
          />
        </BentoCard>

        {/* Sends trend + channel mix */}
        <BentoCard
          title="Sends over time"
          subtitle="Last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          <AreaTrend data={SENDS_TREND} series={SENDS_SERIES} height={240} showLegend />
        </BentoCard>
        <BentoCard
          title="By channel"
          subtitle="Messages, last 30 days"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          <DonutStat
            data={CHANNEL_MIX}
            height={240}
            centerValue="5,476"
            centerLabel="messages"
          />
        </BentoCard>

        {/* Engagement + delivery health */}
        <BentoCard
          title="Engagement by broadcast"
          subtitle="Open rate of each sent blast"
          icon={BarChart3}
          className="col-span-2 md:col-span-8"
        >
          <BarGroup
            data={ENGAGEMENT}
            series={ENGAGEMENT_SERIES}
            horizontal
            height={220}
          />
        </BentoCard>
        <BentoCard
          title="Delivery rate"
          subtitle="Across all channels"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          <RadialGauge
            value={98}
            valueLabel="98%"
            label="delivered"
            color="var(--chart-2)"
            height={220}
          />
        </BentoCard>

        {/* Broadcasts table */}
        <BentoCard
          title="Recent broadcasts"
          subtitle="Most recent first"
          icon={Megaphone}
          className="col-span-2 md:col-span-12"
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="whitespace-nowrap">Name</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead className="whitespace-nowrap">Audience</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Delivered</TableHead>
                  <TableHead className="text-right">Opened</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {BROADCASTS.map((b) => (
                  <TableRow key={b.name}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {b.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{b.channel}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {b.audience}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{b.sent}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {b.delivered}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{b.opened}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={b.status === 'Sending'} />
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                            STATUS_STYLES[b.status],
                          )}
                        >
                          {b.status}
                        </span>
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
