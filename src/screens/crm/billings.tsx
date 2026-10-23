import {
  ChartColumn,
  Download,
  Gauge,
  PieChart,
  Plus,
  Receipt,
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
  RadialGauge,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

const REVENUE_TREND = [
  { label: 'Mar', billed: 32, collected: 28 },
  { label: 'Apr', billed: 36, collected: 31 },
  { label: 'May', billed: 34, collected: 33 },
  { label: 'Jun', billed: 41, collected: 36 },
  { label: 'Jul', billed: 44, collected: 39 },
  { label: 'Aug', billed: 46, collected: 42 },
  { label: 'Sep', billed: 52, collected: 45 },
  { label: 'Oct', billed: 49, collected: 41 },
];
const REVENUE_SERIES: Series[] = [
  { key: 'billed', label: 'Billed (RM k)', color: 'var(--chart-1)' },
  { key: 'collected', label: 'Collected (RM k)', color: 'var(--chart-2)' },
];

/** Revenue by source (RM k) — sums to 486. */
const REVENUE_BY_SOURCE: Slice[] = [
  { key: 'retainer', label: 'Retainer', value: 182, color: 'var(--chart-1)' },
  { key: 'project', label: 'Project', value: 148, color: 'var(--chart-2)' },
  { key: 'subscription', label: 'Subscription', value: 96, color: 'var(--chart-5)' },
  { key: 'oneoff', label: 'One-off', value: 60, color: 'var(--chart-3)' },
];

/** Whole-book invoice counts, same taxonomy as the table below. */
const INVOICES_BY_STATUS = [
  { label: 'Paid', count: 128 },
  { label: 'Pending', count: 22 },
  { label: 'Overdue', count: 14 },
  { label: 'Refunded', count: 5 },
];
const STATUS_SERIES: Series[] = [
  { key: 'count', label: 'Invoices', color: 'var(--chart-2)' },
];

type TopCustomer = { name: string; revenue: string; active: boolean };

const TOP_CUSTOMERS: TopCustomer[] = [
  { name: 'Rahim Motors', revenue: 'RM 86,400', active: true },
  { name: 'Zaki Enterprise', revenue: 'RM 62,100', active: true },
  { name: 'Nurul Boutique', revenue: 'RM 41,800', active: true },
  { name: 'Lestari Group', revenue: 'RM 38,200', active: false },
  { name: 'Ahmad F&B', revenue: 'RM 29,500', active: true },
];

type InvoiceStatus = 'Paid' | 'Pending' | 'Overdue' | 'Refunded';

type Invoice = {
  id: string;
  customer: string;
  amount: string;
  due: string;
  status: InvoiceStatus;
};

const INVOICES: Invoice[] = [
  { id: 'INV-1042', customer: 'Aisyah Trading', amount: 'RM 1,240', due: '07 Oct', status: 'Paid' },
  { id: 'INV-1041', customer: 'Zaki Enterprise', amount: 'RM 3,500', due: '05 Oct', status: 'Paid' },
  { id: 'INV-1040', customer: 'Nurul Boutique', amount: 'RM 8,900', due: '12 Oct', status: 'Pending' },
  { id: 'INV-1039', customer: 'Ahmad F&B', amount: 'RM 4,200', due: '01 Oct', status: 'Paid' },
  { id: 'INV-1038', customer: 'Faiz Studio', amount: 'RM 2,100', due: '28 Sep', status: 'Refunded' },
  { id: 'INV-1037', customer: 'Hakim Logistics', amount: 'RM 6,750', due: '22 Sep', status: 'Overdue' },
  { id: 'INV-1036', customer: 'Huda Catering', amount: 'RM 3,180', due: '15 Oct', status: 'Pending' },
  { id: 'INV-1035', customer: 'Rahim Motors', amount: 'RM 12,400', due: '18 Sep', status: 'Overdue' },
  { id: 'INV-1034', customer: 'Lestari Group', amount: 'RM 5,600', due: '30 Sep', status: 'Paid' },
];

const STATUS_PILL: Record<InvoiceStatus, string> = {
  Paid: 'bg-emerald-500/15 text-emerald-600',
  Pending: 'bg-amber-500/15 text-amber-600',
  Overdue: 'bg-red-500/15 text-red-600',
  Refunded: 'bg-muted text-muted-foreground',
};

function StatusPill({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
        STATUS_PILL[status],
      )}
    >
      {status}
    </span>
  );
}

/* ------------------------------------------------------------------ */

export default function BillingsScreen() {
  return (
    <ScreenContainer>
      <PageHeader
        title="Billings"
        subtitle="Invoices, revenue and collections."
        actions={
          <>
            <Select defaultValue="30d">
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm">
              <Download className="size-4" />
              Export
            </Button>
            <Button size="sm">
              <Plus className="size-4" />
              New invoice
            </Button>
          </>
        }
      />

      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Revenue (MTD)"
            value="RM 48.6k"
            delta="+14%"
            onPrimary
            chart={
              <Sparkline
                data={[32, 36, 34, 41, 44, 46, 52, 49]}
                color="var(--primary-foreground)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Outstanding"
            value="RM 31.2k"
            delta="+RM 4.1k"
            deltaTone="down"
            chart={
              <Sparkline
                data={[22, 24, 26, 25, 28, 29, 30, 31]}
                color="var(--chart-3)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Paid this month"
            value="RM 42.2k"
            delta="+9%"
            deltaTone="up"
            chart={
              <Sparkline
                data={[28, 31, 33, 36, 39, 42, 45, 42]}
                color="var(--chart-2)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Overdue"
            value="RM 19.2k"
            delta="+2 invoices"
            deltaTone="down"
            chart={
              <Sparkline
                data={[9, 11, 10, 13, 12, 15, 17, 19]}
                color="var(--chart-4)"
                height={36}
              />
            }
          />
        </BentoCard>

        {/* Revenue trend + source mix */}
        <BentoCard
          title="Revenue over time"
          subtitle="Billed vs collected · last 8 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          <AreaTrend
            data={REVENUE_TREND}
            series={REVENUE_SERIES}
            height={240}
            showLegend
          />
        </BentoCard>
        <BentoCard
          title="Revenue by source"
          subtitle="Billed YTD"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          <DonutStat
            data={REVENUE_BY_SOURCE}
            height={240}
            centerValue="RM 486k"
            centerLabel="billed"
          />
        </BentoCard>

        {/* Status bars + collection gauge + top customers */}
        <BentoCard
          title="Invoices by status"
          subtitle="Current book"
          icon={ChartColumn}
          className="col-span-2 md:col-span-4"
        >
          <BarGroup
            data={INVOICES_BY_STATUS}
            series={STATUS_SERIES}
            horizontal
            height={200}
          />
        </BentoCard>
        <BentoCard
          title="Collection rate"
          subtitle="Collected of billed YTD"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          <RadialGauge
            value={82}
            valueLabel="82%"
            label="collected"
            color="var(--chart-2)"
            height={200}
          />
        </BentoCard>
        <BentoCard
          title="Top customers"
          subtitle="By revenue YTD"
          icon={Users}
          className="col-span-2 md:col-span-4"
        >
          <ul className="divide-y">
            {TOP_CUSTOMERS.map((c) => (
              <li key={c.name} className="flex items-center gap-3 py-2.5">
                <LiveDot active={c.active} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {c.name}
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {c.revenue}
                </span>
              </li>
            ))}
          </ul>
        </BentoCard>

        {/* Invoices table */}
        <BentoCard
          title="Recent invoices"
          subtitle="Latest activity across your book"
          icon={Receipt}
          action={
            <Button variant="outline" size="sm">
              View all
            </Button>
          }
          className="col-span-2 md:col-span-12"
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Amount (RM)</TableHead>
                  <TableHead className="whitespace-nowrap">Due</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {INVOICES.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {inv.id}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{inv.customer}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {inv.amount}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {inv.due}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={inv.status === 'Paid'} />
                        <StatusPill status={inv.status} />
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
