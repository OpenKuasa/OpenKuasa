import {
  ChartColumn,
  Copy,
  ExternalLink,
  FileText,
  Filter,
  MonitorSmartphone,
  Pencil,
  PieChart,
  Plus,
  Search,
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
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/* ---- mock data (Rimba Ventures Sdn Bhd) --------------------------- */

const VIEWS_TREND = [
  { label: 'Wk1', views: 980, signups: 168 },
  { label: 'Wk2', views: 1120, signups: 196 },
  { label: 'Wk3', views: 1340, signups: 222 },
  { label: 'Wk4', views: 1280, signups: 214 },
  { label: 'Wk5', views: 1560, signups: 268 },
  { label: 'Wk6', views: 1720, signups: 296 },
  { label: 'Wk7', views: 1880, signups: 324 },
  { label: 'Wk8', views: 2100, signups: 372 },
];
const VIEWS_SERIES: Series[] = [
  { key: 'views', label: 'Views', color: 'var(--chart-1)' },
  { key: 'signups', label: 'Signups', color: 'var(--chart-2)' },
];

const TRAFFIC_SOURCE: Slice[] = [
  { key: 'whatsapp', label: 'WhatsApp', value: 4820, color: 'var(--chart-1)' },
  { key: 'facebook', label: 'Facebook', value: 3180, color: 'var(--chart-2)' },
  { key: 'instagram', label: 'Instagram', value: 2260, color: 'var(--chart-5)' },
  { key: 'google', label: 'Google', value: 1420, color: 'var(--chart-3)' },
  { key: 'direct', label: 'Direct', value: 800, color: 'var(--chart-4)' },
];

const FUNNEL: Slice[] = [
  { key: 'views', label: 'Views', value: 12480, color: 'var(--chart-1)' },
  { key: 'signups', label: 'Signups', value: 2140, color: 'var(--chart-2)' },
  { key: 'leads', label: 'Leads', value: 824, color: 'var(--chart-5)' },
];

const VIEWS_BY_PAGE = [
  { label: 'Raya Sale', views: 3420 },
  { label: 'Ramadan', views: 2180 },
  { label: 'Series X', views: 1960 },
  { label: 'eBook SME', views: 1540 },
  { label: 'Webinar', views: 1120 },
];
const PAGE_VIEWS_SERIES: Series[] = [
  { key: 'views', label: 'Views', color: 'var(--chart-2)' },
];

type PageRow = {
  title: string;
  slug: string;
  views: number;
  conversion: string;
  leads: number;
  active: boolean;
};

const PAGES: PageRow[] = [
  {
    title: 'Raya Mega Sale',
    slug: '/raya-sale',
    views: 3420,
    conversion: '7.4%',
    leads: 253,
    active: true,
  },
  {
    title: 'Ramadan Bazaar Preorder',
    slug: '/ramadan-bazaar',
    views: 2180,
    conversion: '6.8%',
    leads: 148,
    active: true,
  },
  {
    title: 'Product Launch — Series X',
    slug: '/series-x',
    views: 1960,
    conversion: '5.1%',
    leads: 100,
    active: true,
  },
  {
    title: 'Panduan SME Digital (eBook)',
    slug: '/ebook-sme',
    views: 1540,
    conversion: '9.2%',
    leads: 142,
    active: true,
  },
  {
    title: 'Webinar: Jualan WhatsApp',
    slug: '/webinar-whatsapp',
    views: 1120,
    conversion: '6.0%',
    leads: 67,
    active: true,
  },
  {
    title: 'Hari Raya Hamper Preorder',
    slug: '/raya-hamper',
    views: 980,
    conversion: '5.6%',
    leads: 55,
    active: true,
  },
  {
    title: 'Merdeka Promo',
    slug: '/merdeka',
    views: 740,
    conversion: '3.8%',
    leads: 28,
    active: false,
  },
  {
    title: 'Konsultasi Percuma',
    slug: '/konsultasi',
    views: 540,
    conversion: '5.7%',
    leads: 31,
    active: false,
  },
];

/* ------------------------------------------------------------------ */

export default function LandingPageScreen() {
  return (
    <ScreenContainer>
      <PageHeader
        title="Landing Pages"
        badge={
          <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-600">
            BETA
          </span>
        }
        subtitle="Build and manage AI-generated landing pages."
        actions={
          <Button size="sm">
            <Plus className="size-4" />
            New Page
          </Button>
        }
      />

      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Total pages"
            value="8"
            delta="+2"
            onPrimary
            chart={
              <Sparkline
                data={[4, 4, 5, 6, 6, 7, 7, 8]}
                color="var(--primary-foreground)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Total views"
            value="12,480"
            delta="+22%"
            deltaTone="up"
            chart={
              <Sparkline
                data={[980, 1120, 1340, 1280, 1560, 1720, 1880, 2100]}
                color="var(--chart-1)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Avg conversion"
            value="6.2%"
            delta="+0.8pt"
            deltaTone="up"
            chart={
              <Sparkline
                data={[5.1, 5.3, 5.5, 5.6, 5.8, 5.9, 6.1, 6.2]}
                color="var(--chart-2)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Leads captured"
            value="824"
            delta="+16%"
            deltaTone="up"
            chart={
              <Sparkline
                data={[168, 196, 222, 214, 268, 296, 324, 372]}
                color="var(--chart-5)"
                height={36}
              />
            }
          />
        </BentoCard>

        {/* Views trend + traffic source */}
        <BentoCard
          title="Views over time"
          subtitle="Last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          <AreaTrend data={VIEWS_TREND} series={VIEWS_SERIES} height={240} showLegend />
        </BentoCard>
        <BentoCard
          title="Traffic source"
          subtitle="This period"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          <DonutStat
            data={TRAFFIC_SOURCE}
            height={240}
            centerValue="12,480"
            centerLabel="views"
          />
        </BentoCard>

        {/* Funnel + views by page + preview */}
        <BentoCard
          title="Views → signups → leads"
          subtitle="Conversion flow"
          icon={Filter}
          className="col-span-2 md:col-span-4"
        >
          <FunnelFlow data={FUNNEL} height={200} />
        </BentoCard>
        <BentoCard
          title="Views by page"
          subtitle="Top 5 pages"
          icon={ChartColumn}
          className="col-span-2 md:col-span-4"
        >
          <BarGroup
            data={VIEWS_BY_PAGE}
            series={PAGE_VIEWS_SERIES}
            horizontal
            height={200}
          />
        </BentoCard>
        <BentoCard
          title="Live preview"
          subtitle="Raya Mega Sale"
          icon={MonitorSmartphone}
          className="col-span-2 md:col-span-4"
        >
          <div className="flex h-[200px] items-center justify-center">
            <div className="w-full max-w-[220px] overflow-hidden rounded-xl border bg-background shadow-sm">
              <div className="flex items-center gap-1.5 border-b bg-muted/40 px-3 py-2">
                <span className="size-2 rounded-full bg-red-400/70" />
                <span className="size-2 rounded-full bg-amber-400/70" />
                <span className="size-2 rounded-full bg-emerald-400/70" />
                <span className="ml-2 truncate text-[10px] text-muted-foreground">
                  rimba.my/raya-sale
                </span>
              </div>
              <div className="flex flex-col items-center gap-2 bg-gradient-to-br from-primary/10 to-muted px-4 py-5 text-center">
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                  Jualan Raya
                </span>
                <p className="text-sm font-bold leading-tight">
                  Diskaun sehingga 50%
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Tempahan terhad · hingga 20 Apr
                </p>
                <span className="mt-1 w-full rounded-md bg-primary px-3 py-1.5 text-[10px] font-semibold text-primary-foreground">
                  Tempah Sekarang
                </span>
              </div>
            </div>
          </div>
        </BentoCard>

        {/* Pages table */}
        <BentoCard
          title="My pages"
          subtitle="8 pages · 6 active"
          icon={FileText}
          action={
            <div className="relative hidden sm:block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search pages…"
                className="h-8 w-44 pl-8 text-sm"
              />
            </div>
          }
          className="col-span-2 md:col-span-12"
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Page</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                  <TableHead className="text-right">Conversion</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PAGES.map((p) => (
                  <TableRow key={p.slug}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {p.title}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {p.slug}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.views.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.conversion}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.leads}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2 text-sm">
                        <LiveDot active={p.active} />
                        {p.active ? 'Active' : 'Paused'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" aria-label="View live">
                          <ExternalLink className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Edit">
                          <Pencil className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Duplicate">
                          <Copy className="size-4" />
                        </Button>
                      </div>
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
