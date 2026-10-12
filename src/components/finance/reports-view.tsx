'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { BookOpen, ChartColumn, ChartPie, CircleCheck, Clock, Download, Hourglass, ListChecks, Scale, ShieldAlert, TrendingUp, Wallet } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, DonutStat, type Series, type Slice } from '@/components/charts';
import { downloadCsv } from '@/components/finance/download-csv';
import { useLocalToday } from '@/components/finance/use-local-today';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { csvFileName } from '@/lib/finance/csv';
import { rm, rmShort } from '@/lib/finance/format';
import {
  AGE_BUCKETS,
  type Aged,
  type BalanceSheet,
  type CashFlow,
  type CashMovement,
  type MonthlyTotals,
  type OpenDocument,
  type Period,
  type PeriodKey,
  type ProfitAndLoss,
  type ReportAccount,
  type StatementLine,
  type TrialBalance,
  aged,
  agedCsv,
  balanceSheet,
  balanceSheetCsv,
  cashFlow,
  cashFlowCsv,
  chartState,
  creditSummary,
  dateLabel,
  expenseBreakdown,
  isValidPeriod,
  monthEndLabel,
  monthlySeries,
  periodFor,
  periodLabel,
  profitAndLoss,
  profitAndLossCsv,
  rangeMessage,
  sliceTotal,
  trialBalance,
  trialBalanceCsv,
} from '@/lib/finance/reports';
import { round2 } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const PERIOD_CHOICES: { key: PeriodKey; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'this_quarter', label: 'This quarter' },
  { key: 'this_year', label: 'This year' },
  { key: 'last_year', label: 'Last year' },
  { key: 'all_time', label: 'All time' },
  { key: 'custom', label: 'Custom' },
];

const RANGE_ERROR_ID = 'reports-range-error';

const SERIES: Series[] = [
  { key: 'revenue', label: 'Revenue (RM)', color: 'var(--chart-1)' },
  { key: 'expenses', label: 'Expenses (RM)', color: 'var(--chart-4)' },
];

/** Five chart colours for the largest categories; the sixth slice, and "Other", are muted. */
const SLICE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

const money = 'whitespace-nowrap text-right tabular-nums';

/** A line of a statement: the code, then the account's name linking to its entries in the ledger. */
function AccountCell({ line }: { line: StatementLine }) {
  return (
    <TableCell className="whitespace-nowrap font-medium">
      <span className="mr-2 font-mono text-xs tabular-nums text-muted-foreground">{line.code}</span>
      <Link href={`/finance/journals?account=${line.account_id}`} className="underline-offset-4 hover:underline">
        {line.name}
      </Link>
    </TableCell>
  );
}

function SectionRow({ children }: { children: string }) {
  return (
    <TableRow className="bg-muted/20 hover:bg-muted/20">
      <TableCell colSpan={2} className="font-semibold">
        {children}
      </TableCell>
    </TableRow>
  );
}

function NoLinesRow({ children }: { children: string }) {
  return (
    <TableRow>
      <TableCell colSpan={2} className="text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

function TotalRow({ label, amount, strong = false }: { label: string; amount: number; strong?: boolean }) {
  return (
    <TableRow className={cn('hover:bg-transparent', strong && 'border-t-2')}>
      <TableCell className="font-semibold">{label}</TableCell>
      <TableCell className={cn(money, 'font-semibold')}>{rm(amount)}</TableCell>
    </TableRow>
  );
}

/** A line with no account behind it, such as the current earnings under equity. */
type ExtraLine = { label: string; amount: number };

function Section({ title, lines, empty, extra }: { title: string; lines: StatementLine[]; empty: string; extra?: ExtraLine }) {
  return (
    <Fragment>
      <SectionRow>{title}</SectionRow>
      {lines.length === 0 && !extra ? <NoLinesRow>{empty}</NoLinesRow> : null}
      {lines.map((l) => (
        <TableRow key={l.account_id}>
          <AccountCell line={l} />
          <TableCell className={money}>{rm(l.amount)}</TableCell>
        </TableRow>
      ))}
      {extra ? (
        <TableRow>
          <TableCell className="font-medium text-muted-foreground">{extra.label}</TableCell>
          <TableCell className={money}>{rm(extra.amount)}</TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

function BooksBalance({ balanced, difference, what }: { balanced: boolean; difference: number; what: string }) {
  return balanced ? (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
      Balances
    </p>
  ) : (
    <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
      <ShieldAlert className="size-4" />
      Out of balance by {rm(Math.abs(difference))}
      <span className="sr-only"> ({what})</span>
    </p>
  );
}

function ProfitAndLossCard({ pl, period, today }: { pl: ProfitAndLoss; period: Period; today: string }) {
  const empty = pl.income.length === 0 && pl.expenses.length === 0;
  return (
    <BentoCard
      title="Profit & Loss"
      subtitle={periodLabel(period)}
      icon={TrendingUp}
      flush
      className="col-span-2 md:col-span-6"
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={empty}
          onClick={() => downloadCsv(csvFileName('profit-and-loss', today), profitAndLossCsv(pl, period))}
        >
          <Download className="size-4" />
          Export CSV
        </Button>
      }
    >
      <div className="overflow-x-auto">
        <Table aria-label="Profit and loss">
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <Section title="Income" lines={pl.income} empty="No income in this period." />
            <TotalRow label="Total income" amount={pl.totalIncome} />
            <Section title="Expenses" lines={pl.expenses} empty="No expenses in this period." />
            <TotalRow label="Total expenses" amount={pl.totalExpenses} />
            <TotalRow label="Net profit" amount={pl.netProfit} strong />
          </TableBody>
        </Table>
      </div>
    </BentoCard>
  );
}

function BalanceSheetCard({ bs, today }: { bs: BalanceSheet; today: string }) {
  const empty = bs.assets.length === 0 && bs.liabilities.length === 0 && bs.equity.length === 0 && bs.currentEarnings === 0;
  const liabilitiesAndEquity = round2(bs.totalLiabilities + bs.totalEquity);
  return (
    <BentoCard
      title="Balance Sheet"
      subtitle={`As at ${monthEndLabel(bs.asAt)}`}
      icon={Scale}
      flush
      className="col-span-2 md:col-span-6"
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={empty}
          onClick={() => downloadCsv(csvFileName('balance-sheet', today), balanceSheetCsv(bs))}
        >
          <Download className="size-4" />
          Export CSV
        </Button>
      }
    >
      <div className="overflow-x-auto">
        <Table aria-label="Balance sheet">
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <Section title="Assets" lines={bs.assets} empty="No assets yet." />
            <TotalRow label="Total assets" amount={bs.totalAssets} />
            <Section title="Liabilities" lines={bs.liabilities} empty="No liabilities yet." />
            <TotalRow label="Total liabilities" amount={bs.totalLiabilities} />
            <Section
              title="Equity"
              lines={bs.equity}
              empty=""
              extra={{ label: 'Current earnings', amount: bs.currentEarnings }}
            />
            <TotalRow label="Total equity" amount={bs.totalEquity} />
            <TotalRow label="Total liabilities and equity" amount={liabilitiesAndEquity} strong />
          </TableBody>
        </Table>
      </div>
      <div className="border-t px-4 py-3">
        <BooksBalance balanced={bs.balanced} difference={round2(bs.totalAssets - liabilitiesAndEquity)} what="assets against liabilities and equity" />
      </div>
    </BentoCard>
  );
}

function TrialBalanceCard({ tb, period, today }: { tb: TrialBalance; period: Period; today: string }) {
  return (
    <BentoCard
      title="Trial Balance"
      subtitle={`Debits and credits in ${periodLabel(period)}`}
      icon={ListChecks}
      flush
      className="col-span-2 md:col-span-8"
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={tb.rows.length === 0}
          onClick={() => downloadCsv(csvFileName('trial-balance', today), trialBalanceCsv(tb, period))}
        >
          <Download className="size-4" />
          Export CSV
        </Button>
      }
    >
      <div className="overflow-x-auto">
        <Table aria-label="Trial balance">
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Code</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tb.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                  Nothing was posted in this period.
                </TableCell>
              </TableRow>
            ) : null}
            {tb.rows.map((r) => (
              <TableRow key={r.account_id}>
                <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{r.code}</TableCell>
                <TableCell className="whitespace-nowrap font-medium">
                  <Link href={`/finance/journals?account=${r.account_id}`} className="underline-offset-4 hover:underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell className={money}>{r.debit > 0 ? rm(r.debit) : ''}</TableCell>
                <TableCell className={money}>{r.credit > 0 ? rm(r.credit) : ''}</TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2 hover:bg-transparent">
              <TableCell />
              <TableCell className="font-semibold">Total</TableCell>
              <TableCell className={cn(money, 'font-semibold')}>{rm(tb.totalDebit)}</TableCell>
              <TableCell className={cn(money, 'font-semibold')}>{rm(tb.totalCredit)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <div className="border-t px-4 py-3">
        {tb.balanced ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
            Debits and credits are equal
          </p>
        ) : (
          <BooksBalance balanced={false} difference={round2(tb.totalDebit - tb.totalCredit)} what="debits against credits" />
        )}
      </div>
    </BentoCard>
  );
}

function CashFlowCard({ cf, period, today }: { cf: CashFlow; period: Period; today: string }) {
  return (
    <BentoCard
      title="Cash Flow"
      subtitle={periodLabel(period)}
      icon={Wallet}
      flush
      className="col-span-2 md:col-span-12"
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={cf.lines.length === 0 && cf.opening === 0}
          onClick={() => downloadCsv(csvFileName('cash-flow', today), cashFlowCsv(cf, period))}
        >
          <Download className="size-4" />
          Export CSV
        </Button>
      }
    >
      <div className="overflow-x-auto">
        <Table aria-label="Cash flow">
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Line</TableHead>
              <TableHead className="text-right">In</TableHead>
              <TableHead className="text-right">Out</TableHead>
              <TableHead className="text-right">Net</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-semibold">Opening cash</TableCell>
              <TableCell />
              <TableCell />
              <TableCell className={cn(money, 'font-semibold')}>{rm(cf.opening)}</TableCell>
            </TableRow>
            {cf.lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                  No money moved in this period.
                </TableCell>
              </TableRow>
            ) : null}
            {cf.lines.map((l) => (
              <TableRow key={l.key}>
                <TableCell className="font-medium">{l.label}</TableCell>
                <TableCell className={money}>{l.in > 0 ? rm(l.in) : ''}</TableCell>
                <TableCell className={money}>{l.out > 0 ? rm(l.out) : ''}</TableCell>
                <TableCell className={money}>{rm(l.net)}</TableCell>
              </TableRow>
            ))}
            {cf.lines.length > 0 ? (
              <TableRow className="border-t-2 hover:bg-transparent">
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell className={cn(money, 'font-semibold')}>{rm(cf.totalIn)}</TableCell>
                <TableCell className={cn(money, 'font-semibold')}>{rm(cf.totalOut)}</TableCell>
                <TableCell className={cn(money, 'font-semibold')}>{rm(cf.net)}</TableCell>
              </TableRow>
            ) : null}
            <TableRow className="border-t-2 hover:bg-transparent">
              <TableCell className="font-semibold">Closing cash</TableCell>
              <TableCell />
              <TableCell />
              <TableCell className={cn(money, 'font-semibold')}>{rm(cf.closing)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </BentoCard>
  );
}

/** An aged table for one side of the books: who owes the workspace, or whom it owes, by how late each amount is. */
function AgedCard({
  title,
  receivable,
  partyHeading,
  href,
  empty,
  a,
  today,
  fileName,
  note,
  owes,
  unavailable,
}: {
  title: string;
  /** True for what customers owe, false for what the workspace owes. */
  receivable: boolean;
  partyHeading: 'Customer' | 'Supplier';
  href: string;
  empty: string;
  /** Null when the documents could not be read. */
  a: Aged | null;
  today: string;
  fileName: string;
  note?: string | null;
  /** How the headline says what is owed: "owed" for money owed to the workspace, "you owe" for money it owes. */
  owes: string;
  /** What to say in place of the table when `a` is null. */
  unavailable: string;
}) {
  return (
    <BentoCard
      title={title}
      subtitle={`As at ${dateLabel(today)}`}
      icon={receivable ? Clock : Hourglass}
      flush
      className="col-span-2 md:col-span-12"
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={a === null || a.rows.length === 0}
          onClick={() => a && downloadCsv(csvFileName(fileName, today), agedCsv(a, today, partyHeading))}
        >
          <Download className="size-4" />
          Export CSV
        </Button>
      }
    >
      {a === null ? (
        <p role="alert" className="px-4 pb-4 text-sm text-destructive">
          {unavailable}
        </p>
      ) : (
        <AgedTable a={a} title={title} partyHeading={partyHeading} href={href} empty={empty} owes={owes} />
      )}
      {a !== null && note ? <p className="border-t px-4 py-3 text-sm text-muted-foreground">{note}</p> : null}
    </BentoCard>
  );
}

function AgedTable({
  a,
  title,
  partyHeading,
  href,
  empty,
  owes,
}: {
  a: Aged;
  title: string;
  partyHeading: 'Customer' | 'Supplier';
  href: string;
  empty: string;
  owes: string;
}) {
  return (
    <>
      {a.rows.length > 0 ? (
        <p className="px-4 pb-3 text-sm font-medium">
          {rm(a.overdue)} overdue of {rm(a.total)} {owes}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <Table aria-label={title}>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>{partyHeading}</TableHead>
              {AGE_BUCKETS.map((b) => (
                <TableHead key={b.key} className="whitespace-nowrap text-right">
                  {b.label}
                </TableHead>
              ))}
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {a.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={AGE_BUCKETS.length + 2} className="py-6 text-center text-muted-foreground">
                  {empty}
                </TableCell>
              </TableRow>
            ) : null}
            {a.rows.map((r) => (
              <TableRow key={r.party_id}>
                <TableCell className="whitespace-nowrap font-medium">
                  <Link href={href} className="underline-offset-4 hover:underline">
                    {r.party_name}
                  </Link>
                </TableCell>
                {AGE_BUCKETS.map((b) => (
                  <TableCell key={b.key} className={money}>
                    {r.buckets[b.key] > 0 ? rm(r.buckets[b.key]) : ''}
                  </TableCell>
                ))}
                <TableCell className={cn(money, 'font-semibold')}>{rm(r.total)}</TableCell>
              </TableRow>
            ))}
            {a.rows.length > 0 ? (
              <TableRow className="border-t-2 hover:bg-transparent">
                <TableCell className="font-semibold">Total</TableCell>
                {AGE_BUCKETS.map((b) => (
                  <TableCell key={b.key} className={cn(money, 'font-semibold')}>
                    {rm(a.totals[b.key])}
                  </TableCell>
                ))}
                <TableCell className={cn(money, 'font-semibold')}>{rm(a.total)}</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/**
 * Reports: the profit and loss, balance sheet, trial balance and cash flow worked out from the ledger for a period,
 * with the month-by-month revenue and expenses, the expense categories and a CSV file of each statement, and the
 * aged receivables and payables as at today, which the period does not change. It is read
 * only. The server sends the accounts and the books added up by account and month, never the ledger's lines;
 * the period is chosen here, so changing it asks the server for nothing.
 */
export function ReportsView({
  accounts,
  totals,
  cash,
  receivables,
  payables,
  unassigned = 0,
  today: serverToday,
  followClock = true,
}: {
  accounts: ReportAccount[];
  /** Every account's debits and credits by month (monthlyTotals). */
  totals: MonthlyTotals;
  /** The money into and out of the bank and cash accounts by month and source (cashMovements). */
  cash: CashMovement[];
  /** What each posted invoice still owes the workspace; one in credit has a balance below zero. As at today, not the period. Null when they could not be read. */
  receivables: OpenDocument[] | null;
  /** What each posted supplier bill still owes. As at today, not the period. Null when they could not be read. */
  payables: OpenDocument[] | null;
  /** Ledger lines left out because their account could not be found. */
  unassigned?: number;
  /** The date the periods are worked out from, YYYY-MM-DD. */
  today: string;
  /** False for the sample, whose day is fixed. */
  followClock?: boolean;
}) {
  const today = useLocalToday(serverToday, followClock);
  const [key, setKey] = useState<PeriodKey>('this_year');
  // The months typed under Custom, and the last range of them that was valid: a bad one keeps that on screen.
  const [custom, setCustom] = useState<Period>({ from: '', to: '' });
  const [applied, setApplied] = useState<Period>(() => periodFor('this_year', serverToday, totals));

  const period = key === 'custom' ? applied : periodFor(key, today, totals);
  const rangeError = key === 'custom' ? rangeMessage(custom) : null;

  const choose = (next: PeriodKey) => {
    if (next === 'custom') {
      // Start from the period that is on screen, so the two boxes show what the figures are for.
      setCustom(period);
      setApplied(period);
    }
    setKey(next);
  };
  const type = (change: Partial<Period>) => {
    const next = { ...custom, ...change };
    setCustom(next);
    if (isValidPeriod(next)) setApplied(next);
  };

  const pl = profitAndLoss(accounts, totals, period);
  const bs = balanceSheet(accounts, totals, period);
  const tb = trialBalance(accounts, totals, period);
  const series = monthlySeries(accounts, totals, period);
  const slices: Slice[] = expenseBreakdown(pl).map((s, i) => ({
    ...s,
    color: s.key === 'other' ? 'var(--muted-foreground)' : (SLICE_COLORS[i] ?? 'var(--muted-foreground)'),
  }));
  const chart = chartState(pl, period);
  const cf = cashFlow(cash, period);
  const receivable = receivables === null ? null : aged(receivables, today);
  const payable = payables === null ? null : aged(payables, today);
  const credit = creditSummary(receivables ?? []);
  const creditNote =
    credit.count > 0
      ? `${credit.count === 1 ? '1 customer is' : `${credit.count} customers are`} in credit by ${rm(credit.total)} in total, which is not counted above.`
      : null;

  return (
    <ScreenContainer>
      <PageHeader
        title="Financial Reports"
        subtitle={periodLabel(period)}
        actions={
          <>
            {key === 'custom' ? (
              <>
                <Label className="flex items-center gap-2 text-sm font-normal">
                  From
                  <Input type="month" className="w-40" value={custom.from} max={custom.to || undefined} aria-invalid={rangeError ? true : undefined} aria-describedby={rangeError ? RANGE_ERROR_ID : undefined} onChange={(e) => type({ from: e.target.value })} />
                </Label>
                <Label className="flex items-center gap-2 text-sm font-normal">
                  To
                  <Input type="month" className="w-40" value={custom.to} min={custom.from || undefined} aria-invalid={rangeError ? true : undefined} aria-describedby={rangeError ? RANGE_ERROR_ID : undefined} onChange={(e) => type({ to: e.target.value })} />
                </Label>
              </>
            ) : null}
            <Select value={key} onValueChange={(v) => choose(v as PeriodKey)}>
              <SelectTrigger className="w-44" aria-label="Period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_CHOICES.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      {rangeError ? (
        <p id={RANGE_ERROR_ID} role="alert" className="mb-4 text-sm text-destructive">
          {rangeError}
        </p>
      ) : null}

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Revenue" value={rm(pl.totalIncome)} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Expenses" value={rm(pl.totalExpenses)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Net profit" value={rm(pl.netProfit)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Profit margin" value={pl.margin === null ? '—' : `${(pl.margin * 100).toFixed(1)}%`} />
        </BentoCard>

        <BentoCard
          title="Revenue and expenses"
          subtitle={chart.subtitle}
          icon={ChartColumn}
          className="col-span-2 md:col-span-8"
        >
          {chart.quiet ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No revenue or expenses in this period.</p>
          ) : (
            <BarGroup
              data={series.map((p) => ({ label: p.label, revenue: p.revenue, expenses: p.expenses }))}
              series={SERIES}
              height={240}
              showLegend
            />
          )}
        </BentoCard>
        <BentoCard
          title="Expenses by category"
          subtitle={periodLabel(period)}
          icon={ChartPie}
          className="col-span-2 md:col-span-4"
        >
          {slices.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No expenses in this period.</p>
          ) : (
            <DonutStat data={slices} height={240} centerValue={rmShort(sliceTotal(slices))} centerLabel="expenses" />
          )}
        </BentoCard>

        <ProfitAndLossCard pl={pl} period={period} today={today} />
        <BalanceSheetCard bs={bs} today={today} />
        <TrialBalanceCard tb={tb} period={period} today={today} />

        <BentoCard title="General ledger" icon={BookOpen} className="col-span-2 md:col-span-4">
          <p className="text-sm text-muted-foreground">Every entry behind these figures, newest first.</p>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <Link href="/finance/journals">Open the general ledger</Link>
          </Button>
        </BentoCard>

        <CashFlowCard cf={cf} period={period} today={today} />
        <AgedCard
          title="Aged Receivables"
          receivable
          partyHeading="Customer"
          href="/finance/invoices"
          empty="Nobody owes you anything."
          a={receivable}
          today={today}
          fileName="aged-receivables"
          owes="owed"
          unavailable="Aged receivables could not be loaded. Please try again."
          note={creditNote}
        />
        <AgedCard
          title="Aged Payables"
          receivable={false}
          partyHeading="Supplier"
          href="/finance/supplier-bills"
          empty="You owe nothing on supplier bills."
          a={payable}
          today={today}
          fileName="aged-payables"
          owes="you owe"
          unavailable="Aged payables could not be loaded. Please try again."
        />
      </BentoGrid>

      {unassigned > 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {unassigned === 1 ? '1 ledger line is' : `${unassigned} ledger lines are`} not shown in the statements because{' '}
          {unassigned === 1 ? 'its account' : 'their accounts'} could not be found.
        </p>
      ) : null}
    </ScreenContainer>
  );
}
