import Link from 'next/link';
import { ArrowLeftRight, ChartColumn, Coins, Gauge, Landmark, PieChart, TrendingUp } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { AreaTrend, BarGroup, DonutStat, RadialGauge, Sparkline, type Series, type Slice } from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { createClient } from '@/lib/supabase/server';
import { todayInMalaysia } from '@/lib/people/dates';
import { rm, rmShort } from '@/lib/finance/format';
import { displayDate } from '@/lib/finance/view-helpers';
import { AGE_BUCKETS } from '@/lib/finance/reports';
import {
  DASHBOARD_PERIODS,
  TREND_MONTHS,
  buildDashboardModel,
  deltaChip,
  parseDashboardPeriod,
  type DashboardInputs,
  type DashboardModel,
} from '@/lib/finance/dashboard';
import { loadDashboardInputs } from '@/lib/finance/dashboard-data';
import { DEFAULT_FINANCE_SETTINGS, financeSettingsOrDefault } from '@/lib/finance/settings';
import { cn } from '@/lib/utils';
import { SAMPLE_BANK_ACCOUNTS, SAMPLE_BANK_TRANSACTIONS } from './banking-sample';
import { SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES, SAMPLE_PAYABLES, SAMPLE_RECEIVABLES } from './ledger-sample';
import { SAMPLE_TODAY } from './sales-sample';

const CASH_SERIES: Series[] = [
  { key: 'balance', label: 'Closing balance (RM)', color: 'var(--chart-1)' },
  { key: 'net', label: 'Net cash (RM)', color: 'var(--chart-2)' },
];
const PL_SERIES: Series[] = [
  { key: 'income', label: 'Income', color: 'var(--chart-2)' },
  { key: 'expense', label: 'Expense', color: 'var(--chart-4)' },
];
const SLICE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-5)', 'var(--chart-3)', 'var(--chart-4)', 'var(--muted-foreground)'];

const CANT_LOAD = "Couldn't load";

function Unavailable() {
  return <p className="text-sm text-muted-foreground">{CANT_LOAD}</p>;
}

/**
 * The reads, today's date and the month the financial year ends; null when the ledger could not be read. Without
 * a database: the sample books and a December year end. A settings read that fails falls back to December.
 */
async function loadInputs(): Promise<{ inputs: DashboardInputs; today: string; yearEndMonth: number } | null> {
  if (!hasSupabaseEnv()) {
    return {
      inputs: {
        lines: SAMPLE_LEDGER_LINES,
        accounts: SAMPLE_LEDGER_ACCOUNTS,
        receivables: SAMPLE_RECEIVABLES,
        payables: SAMPLE_PAYABLES,
        bankAccounts: SAMPLE_BANK_ACCOUNTS,
        bankTransactions: SAMPLE_BANK_TRANSACTIONS,
      },
      today: SAMPLE_TODAY,
      yearEndMonth: DEFAULT_FINANCE_SETTINGS.yearEndMonth,
    };
  }
  try {
    const viewer = await getViewer();
    const ctx = { client: await createClient(), orgId: viewer.orgId };
    const [inputs, settings] = await Promise.all([loadDashboardInputs(ctx), financeSettingsOrDefault(ctx, 'DashboardScreen')]);
    return { inputs, today: todayInMalaysia(new Date()), yearEndMonth: settings.yearEndMonth };
  } catch (error) {
    console.error('[finance] the dashboard could not be read:', error);
    return null;
  }
}

function PeriodLinks({ current }: { current: string }) {
  return (
    <nav aria-label="Period" className="flex flex-wrap gap-1 rounded-lg border p-0.5">
      {DASHBOARD_PERIODS.map((p) => (
        <Link
          key={p.key}
          href={`?period=${p.key}`}
          aria-current={p.key === current ? 'page' : undefined}
          className={cn(
            'rounded-md px-2.5 py-1 text-sm whitespace-nowrap',
            p.key === current ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}

function Header({ periodKey, label }: { periodKey: string; label: string }) {
  return (
    <PageHeader title="Dashboard" subtitle={`Your financial overview · ${label}`} actions={<PeriodLinks current={periodKey} />} />
  );
}

export default async function DashboardScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const params = searchParams ? await searchParams : {};
  const periodKey = parseDashboardPeriod(params.period);
  const label = DASHBOARD_PERIODS.find((p) => p.key === periodKey)!.label;

  const loaded = await loadInputs();
  if (!loaded) {
    return (
      <ScreenContainer>
        <Header periodKey={periodKey} label={label} />
        <BentoGrid>
          <BentoCard tone="muted" className="col-span-2 md:col-span-12">
            <p className="text-sm text-muted-foreground">Couldn&apos;t load your dashboard — please refresh.</p>
          </BentoCard>
        </BentoGrid>
      </ScreenContainer>
    );
  }

  const m = buildDashboardModel(loaded.inputs, loaded.today, periodKey, loaded.yearEndMonth);
  return (
    <ScreenContainer>
      <Header periodKey={periodKey} label={label} />
      <BentoGrid>
        {m.isEmpty ? (
          <BentoCard tone="muted" className="col-span-2 md:col-span-12">
            <p className="text-sm text-muted-foreground">
              Nothing is recorded yet. Raise your first sale in{' '}
              <Link className="underline" href="/finance/invoices">
                Invoices
              </Link>{' '}
              or connect an account in{' '}
              <Link className="underline" href="/finance/banking">
                Banking
              </Link>
              , and your figures appear here.
            </p>
          </BentoCard>
        ) : null}
        <Cards m={m} label={label} />
      </BentoGrid>
    </ScreenContainer>
  );
}

function Cards({ m, label }: { m: DashboardModel; label: string }) {
  const revenue = deltaChip(m.deltas.revenue, 'up');
  const expenses = deltaChip(m.deltas.expenses, 'down');
  const net = deltaChip(m.deltas.net, 'up');
  const pl = m.pl;

  const plData = m.series.map((p) => ({ label: p.label, income: p.revenue, expense: p.expenses }));
  const slices: Slice[] = m.breakdown.map((b, i) => ({ ...b, color: SLICE_COLORS[i % SLICE_COLORS.length] }));

  const ageSeries: Series[] = [
    ...(m.receivable ? [{ key: 'ar', label: 'Receivable', color: 'var(--chart-2)' }] : []),
    ...(m.payable ? [{ key: 'ap', label: 'Payable', color: 'var(--chart-3)' }] : []),
  ];
  const ageData = AGE_BUCKETS.map((b) => ({
    label: b.label,
    ...(m.receivable ? { ar: m.receivable.totals[b.key] } : {}),
    ...(m.payable ? { ap: m.payable.totals[b.key] } : {}),
  }));

  return (
    <>
      {/* KPI row */}
      <BentoCard tone="primary" className="col-span-1 md:col-span-3">
        {m.cashPosition === null ? (
          <div>
            <p className="text-xs font-medium text-primary-foreground/70">Cash position</p>
            <p className="mt-1 text-sm">{CANT_LOAD}</p>
          </div>
        ) : (
          <BentoStat
            valueClassName="text-xl sm:text-2xl"
            label="Cash position"
            value={rm(m.cashPosition)}
            onPrimary
            chart={<Sparkline data={m.cashTrend.map((c) => c.balance)} color="var(--primary-foreground)" height={36} />}
          />
        )}
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat
          valueClassName="text-xl sm:text-2xl"
          label={`Revenue · ${label}`}
          value={rm(pl.totalIncome)}
          delta={revenue.delta}
          deltaTone={revenue.tone}
          chart={<Sparkline data={m.series.map((p) => p.revenue)} height={36} />}
        />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat
          valueClassName="text-xl sm:text-2xl"
          label={`Expenses · ${label}`}
          value={rm(pl.totalExpenses)}
          delta={expenses.delta}
          deltaTone={expenses.tone}
          chart={<Sparkline data={m.series.map((p) => p.expenses)} color="var(--chart-4)" height={36} />}
        />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat
          valueClassName="text-xl sm:text-2xl"
          label={`Net profit · ${label}`}
          value={rm(pl.netProfit)}
          delta={net.delta}
          deltaTone={net.tone}
          chart={<Sparkline data={m.series.map((p) => p.net)} color="var(--chart-2)" height={36} />}
        />
      </BentoCard>

      {/* Cash flow + expense breakdown */}
      <BentoCard
        title="Cash flow"
        subtitle={`Closing balance & net cash · last ${TREND_MONTHS} months`}
        icon={TrendingUp}
        className="col-span-2 md:col-span-8"
      >
        <AreaTrend data={m.cashTrend} series={CASH_SERIES} height={240} showLegend />
      </BentoCard>
      <BentoCard title="Expense breakdown" subtitle={label} icon={PieChart} className="col-span-2 md:col-span-4">
        {slices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No expenses in this period.</p>
        ) : (
          <DonutStat data={slices} height={240} centerValue={rmShort(pl.totalExpenses)} centerLabel="expenses" />
        )}
      </BentoCard>

      {/* P&L bars + profit-margin gauge */}
      <BentoCard title="Profit & loss" subtitle={`Income vs expense (RM) · last ${TREND_MONTHS} months`} icon={ChartColumn} className="col-span-2 md:col-span-8">
        <BarGroup data={plData} series={PL_SERIES} height={240} showLegend />
      </BentoCard>
      <BentoCard title="Profit margin" subtitle={`Net profit of revenue · ${label}`} icon={Gauge} className="col-span-2 md:col-span-4">
        {pl.margin === null ? (
          <p className="text-sm text-muted-foreground">No income in this period</p>
        ) : (
          <RadialGauge
            value={Math.max(0, Math.min(100, Math.round(pl.margin * 100)))}
            label="margin"
            valueLabel={`${Math.round(pl.margin * 100)}%`}
            color="var(--chart-2)"
            height={240}
          />
        )}
      </BentoCard>

      {/* AR/AP ageing + accounts */}
      <BentoCard title="AR / AP ageing" subtitle="Receivable vs payable (RM)" icon={Coins} className="col-span-2 md:col-span-6">
        {ageSeries.length === 0 ? (
          <Unavailable />
        ) : (
          <>
            <BarGroup data={ageData} series={ageSeries} height={220} showLegend />
            {!m.receivable || !m.payable ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {!m.receivable ? 'Receivable' : 'Payable'}: {CANT_LOAD}
              </p>
            ) : null}
          </>
        )}
      </BentoCard>
      <BentoCard title="Bank & cash accounts" icon={Landmark} className="col-span-2 md:col-span-6">
        {m.bankAccounts === null ? (
          <Unavailable />
        ) : m.bankAccounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bank or cash accounts yet.</p>
        ) : (
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
                {m.bankAccounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="whitespace-nowrap font-medium">{a.name}</TableCell>
                    <TableCell className="text-muted-foreground">{a.kind === 'bank' ? 'Bank' : 'Cash'}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(a.balance)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2">
                  <TableCell className="font-semibold">Cash position</TableCell>
                  <TableCell />
                  <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">
                    {m.cashPosition === null ? CANT_LOAD : rm(m.cashPosition)}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Owed to suppliers</TableCell>
                  <TableCell />
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {m.payable === null ? CANT_LOAD : rm(m.payable.total)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </BentoCard>

      {/* Latest cash book activity */}
      <BentoCard
        title="Latest cash book activity"
        subtitle="Money in and out, newest first"
        icon={ArrowLeftRight}
        action={
          <Button variant="outline" size="sm" asChild>
            <Link href="/finance/banking">View all</Link>
          </Button>
        }
        className="col-span-2 md:col-span-12"
      >
        {m.recentCash === null ? (
          <Unavailable />
        ) : m.recentCash.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cash movements yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="whitespace-nowrap">Date</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead>Documents</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {m.recentCash.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(t.date.slice(0, 10))}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{t.party || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{t.documents ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{t.accountName}</TableCell>
                    <TableCell
                      className={cn(
                        'whitespace-nowrap text-right font-semibold tabular-nums',
                        t.direction === 'in' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
                      )}
                    >
                      {t.direction === 'in' ? '+' : '−'}
                      {rm(t.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </BentoCard>
    </>
  );
}
