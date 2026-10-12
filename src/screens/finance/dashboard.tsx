import {
  ArrowLeftRight,
  ChartColumn,
  Coins,
  Download,
  Gauge,
  Landmark,
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
  RadialGauge,
  Sparkline,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/* ---- mock data (Rimba Ventures Sdn Bhd · FY2026) ------------------ */

/** Monthly closing bank balance + net cash (RM k). Distinct from the
 *  Overview's weekly cash-in/out view. */
const CASH_TREND = [
  { label: 'Mar', balance: 62.0, net: 4.2 },
  { label: 'Apr', balance: 66.0, net: 4.0 },
  { label: 'May', balance: 68.5, net: 2.5 },
  { label: 'Jun', balance: 72.0, net: 3.5 },
  { label: 'Jul', balance: 75.5, net: 3.5 },
  { label: 'Aug', balance: 78.0, net: 2.5 },
  { label: 'Sep', balance: 81.6, net: 3.6 },
  { label: 'Oct', balance: 84.2, net: 2.6 },
];
const CASH_SERIES: Series[] = [
  { key: 'balance', label: 'Closing balance (RM k)', color: 'var(--chart-1)' },
  { key: 'net', label: 'Net cash (RM k)', color: 'var(--chart-2)' },
];

/** Income vs expense, monthly (RM k). Oct ties to Revenue 42.8 / Expense 18.4. */
const PL_TREND = [
  { label: 'Mar', income: 36.0, expense: 20.0 },
  { label: 'Apr', income: 40.0, expense: 21.0 },
  { label: 'May', income: 38.0, expense: 22.0 },
  { label: 'Jun', income: 44.0, expense: 23.0 },
  { label: 'Jul', income: 46.0, expense: 22.0 },
  { label: 'Aug', income: 42.0, expense: 21.0 },
  { label: 'Sep', income: 48.0, expense: 24.0 },
  { label: 'Oct', income: 42.8, expense: 18.4 },
];
const PL_SERIES: Series[] = [
  { key: 'income', label: 'Income', color: 'var(--chart-2)' },
  { key: 'expense', label: 'Expense', color: 'var(--chart-4)' },
];

/** Expense breakdown, this month (RM k) — sums to 18.4 = Expenses MTD. */
const EXPENSE_BREAKDOWN: Slice[] = [
  { key: 'payroll', label: 'Payroll', value: 8.4, color: 'var(--chart-1)' },
  { key: 'rent', label: 'Rent', value: 3.6, color: 'var(--chart-2)' },
  { key: 'supplies', label: 'Supplies', value: 2.8, color: 'var(--chart-5)' },
  { key: 'utilities', label: 'Utilities', value: 1.9, color: 'var(--chart-3)' },
  { key: 'marketing', label: 'Marketing', value: 1.7, color: 'var(--chart-4)' },
];

/** AR/AP ageing buckets (RM k). AR sums to 16.9, AP to 9.3. */
const AGEING = [
  { label: 'Current', ar: 9.7, ap: 5.1 },
  { label: '1–30d', ar: 4.2, ap: 2.2 },
  { label: '31–60d', ar: 2.0, ap: 1.4 },
  { label: '60d+', ar: 1.0, ap: 0.6 },
];
const AGEING_SERIES: Series[] = [
  { key: 'ar', label: 'Receivable', color: 'var(--chart-2)' },
  { key: 'ap', label: 'Payable', color: 'var(--chart-3)' },
];

type Account = { name: string; type: string; balance: string };
/** Bank & cash accounts — sum to RM 84,200 = Cash Position. */
const ACCOUNTS: Account[] = [
  { name: 'Maybank Current', type: 'Bank', balance: 'RM 60,400' },
  { name: 'CIMB Business', type: 'Bank', balance: 'RM 12,000' },
  { name: 'Petty Cash', type: 'Cash', balance: 'RM 11,800' },
];

type TxnTone = 'in' | 'out' | 'flat';
type TxnStatus = 'Paid' | 'Cleared' | 'Sent' | 'To be paid' | 'Overdue';
type Txn = {
  date: string;
  description: string;
  reference: string;
  amount: string;
  tone: TxnTone;
  status: TxnStatus;
};

const TRANSACTIONS: Txn[] = [
  { date: '09 Oct', description: 'Payment received', reference: 'Aisyah Trading · INV-1042', amount: '+RM 1,240', tone: 'in', status: 'Paid' },
  { date: '08 Oct', description: 'Supplier bill', reference: 'Lim Hardware · BILL-304', amount: '−RM 3,300', tone: 'out', status: 'To be paid' },
  { date: '07 Oct', description: 'Invoice sent', reference: 'Zaki Enterprise · INV-1041', amount: 'RM 3,500', tone: 'flat', status: 'Sent' },
  { date: '05 Oct', description: 'Expense · utilities', reference: 'TNB · Maybank Current', amount: '−RM 1,900', tone: 'out', status: 'Cleared' },
  { date: '03 Oct', description: 'Payment received', reference: 'Lim Hardware · INV-1039', amount: '+RM 2,100', tone: 'in', status: 'Paid' },
  { date: '01 Oct', description: 'Invoice overdue', reference: 'Nurul Boutique · INV-1040', amount: 'RM 4,200', tone: 'flat', status: 'Overdue' },
];

const STATUS_PILL: Record<TxnStatus, string> = {
  Paid: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  Cleared: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  Sent: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  'To be paid': 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  Overdue: 'bg-red-500/15 text-red-600 dark:text-red-400',
};

const TONE_CLASS: Record<TxnTone, string> = {
  in: 'text-emerald-600 dark:text-emerald-400',
  out: 'text-red-600 dark:text-red-400',
  flat: '',
};

/* ------------------------------------------------------------------ */

export default function DashboardScreen() {
  return (
    <ScreenContainer>
      <PageHeader
        title="Dashboard"
        subtitle="Your financial overview · FY2026, Saudara."
        actions={
          <>
            <Select defaultValue="mtd">
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mtd">This month</SelectItem>
                <SelectItem value="qtd">This quarter</SelectItem>
                <SelectItem value="ytd">Financial year</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm">
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
            label="Cash position"
            value="RM 84,200"
            delta="+6%"
            onPrimary
            chart={
              <Sparkline
                data={[62, 66, 68.5, 72, 75.5, 78, 81.6, 84.2]}
                color="var(--primary-foreground)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Revenue · MTD"
            value="RM 42,800"
            delta="+14%"
            deltaTone="up"
            chart={<Sparkline data={[36, 40, 38, 44, 46, 42, 48, 42.8]} height={36} />}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Expenses · MTD"
            value="RM 18,400"
            delta="−8%"
            deltaTone="up"
            chart={
              <Sparkline
                data={[20, 21, 22, 23, 22, 21, 24, 18.4]}
                color="var(--chart-4)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Net profit · MTD"
            value="RM 24,400"
            delta="+22%"
            deltaTone="up"
            chart={
              <Sparkline
                data={[16, 19, 16, 21, 24, 21, 24, 24.4]}
                color="var(--chart-2)"
                height={36}
              />
            }
          />
        </BentoCard>

        {/* Cash flow + expense breakdown */}
        <BentoCard
          title="Cash flow"
          subtitle="Closing balance & net cash · FY2026"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          <AreaTrend data={CASH_TREND} series={CASH_SERIES} height={240} showLegend />
        </BentoCard>
        <BentoCard
          title="Expense breakdown"
          subtitle="This month"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          <DonutStat
            data={EXPENSE_BREAKDOWN}
            height={240}
            centerValue="RM 18.4k"
            centerLabel="expenses"
          />
        </BentoCard>

        {/* P&L bars + profit-margin gauge */}
        <BentoCard
          title="Profit & loss"
          subtitle="Income vs expense (RM k)"
          icon={ChartColumn}
          className="col-span-2 md:col-span-8"
        >
          <BarGroup data={PL_TREND} series={PL_SERIES} height={240} showLegend />
        </BentoCard>
        <BentoCard
          title="Profit margin"
          subtitle="Net profit of revenue"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          <RadialGauge value={57} label="margin" valueLabel="57%" color="var(--chart-2)" height={240} />
        </BentoCard>

        {/* AR/AP ageing + accounts */}
        <BentoCard
          title="AR / AP ageing"
          subtitle="Receivable vs payable (RM k)"
          icon={Coins}
          className="col-span-2 md:col-span-6"
        >
          <BarGroup data={AGEING} series={AGEING_SERIES} height={220} showLegend />
        </BentoCard>
        <BentoCard
          title="Bank & cash accounts"
          subtitle="Owed to suppliers · RM 9,300"
          icon={Landmark}
          className="col-span-2 md:col-span-6"
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Account</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ACCOUNTS.map((a) => (
                  <TableRow key={a.name}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {a.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.type}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {a.balance}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2">
                  <TableCell className="font-semibold">Cash position</TableCell>
                  <TableCell />
                  <TableCell className="text-right font-semibold tabular-nums">
                    RM 84,200
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </BentoCard>

        {/* Recent transactions */}
        <BentoCard
          title="Recent transactions"
          subtitle="Latest cash book activity"
          icon={ArrowLeftRight}
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
                  <TableHead className="whitespace-nowrap">Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount (RM)</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {TRANSACTIONS.map((t) => (
                  <TableRow key={`${t.date}-${t.reference}`}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {t.date}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-medium">
                      {t.description}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {t.reference}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'whitespace-nowrap text-right font-semibold tabular-nums',
                        TONE_CLASS[t.tone],
                      )}
                    >
                      {t.amount}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                          STATUS_PILL[t.status],
                        )}
                      >
                        {t.status}
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
