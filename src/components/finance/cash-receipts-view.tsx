'use client';

import { useState } from 'react';
import { Banknote, Download, Landmark, PieChart, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { downloadCsv } from '@/components/finance/download-csv';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLocalToday } from '@/components/finance/use-local-today';
import { localIsoDate } from '@/lib/finance/bill-math';
import type { CashReceiptRow } from '@/lib/finance/cash-book';
import {
  CASH_BOOK_PERIODS,
  CASH_BOOK_PERIOD_LABELS,
  CASH_RECEIPT_STATUS_LABELS,
  type CashBookPeriod,
  cashBookCountLine,
  emptyPeriodText,
  inPeriod,
  nothingInPeriod,
  type CashReceiptFilter,
  cashReceiptsCsv,
  cashReceiptsInPeriod,
  cashReceiptsView,
  filterCashReceipts,
  receiptFor,
} from '@/lib/finance/cash-book-views';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import { PAYMENT_METHOD_LABELS } from '@/lib/finance/money';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const RECEIVED_SERIES: Series[] = [
  { key: 'bank', label: 'Bank (RM k)', color: 'var(--chart-1)' },
  { key: 'cash', label: 'Cash (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<CashReceiptRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  draft: 'bg-muted text-muted-foreground',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
  void: 'bg-muted text-muted-foreground line-through',
};

/**
 * Cash Receipts: every movement of money in, one row each. The chosen period
 * sets the figures, the charts and the rows of the table (drafts stay in every
 * period, as the Receipts card counts them), with search, a status filter,
 * "View all" and Export working on top of it; Export gives what the table
 * would show with "View all". Nothing here changes data yet: a payment against invoices is
 * recorded and voided on Payments In, and the receipt form arrives later.
 */
export function CashReceiptsView({
  rows,
  today: serverToday,
  followClock = true,
}: {
  /** Every receipt, newest first; drafts and void ones included. */
  rows: CashReceiptRow[];
  /** The date the figures are worked out for, YYYY-MM-DD, until the browser's own date takes over. */
  today: string;
  /** False for sample data, which keeps its own fixed date. */
  followClock?: boolean;
}) {
  const today = useLocalToday(serverToday, followClock);
  const [period, setPeriod] = useState<CashBookPeriod>('month');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CashReceiptFilter>('open');
  const [showAll, setShowAll] = useState(false);

  const view = cashReceiptsView(rows, today, period);
  const inPeriodRows = cashReceiptsInPeriod(rows, today, period);
  const matching = filterCashReceipts(inPeriodRows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const span = CASH_BOOK_PERIOD_LABELS[period];
  // Rows the table keeps from outside the period (drafts, money still waiting), earlier or later than it.
  const outside = inPeriodRows.filter((row) => !inPeriod(row.txn_date, today, period));
  const countLine = cashBookCountLine({
    noun: 'receipts',
    period,
    workspaceRows: rows.length,
    shown: shown.length,
    matching: matching.length,
    total: inPeriodRows.length,
    keptEarlier: outside.filter((row) => row.txn_date < today).length,
    keptLater: outside.filter((row) => row.txn_date >= today).length,
  });

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Cash Receipts"
        subtitle="Money received into cash and bank, Saudara."
        actions={
          <Select value={period} onValueChange={(v) => setPeriod(v as CashBookPeriod)}>
            <SelectTrigger className="w-40" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CASH_BOOK_PERIODS.map((p) => (
                <SelectItem key={p} value={p}>
                  {CASH_BOOK_PERIOD_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Receipts over time" subtitle="Bank and cash · last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={RECEIVED_SERIES} height={240} stacked showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing received in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="By account" subtitle={`Received · ${span.toLowerCase()}`} icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReceived ? (
            <DonutStat data={view.byAccount} height={240} centerValue={view.received} centerLabel="received" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">{nothingInPeriod('received', period)}</p>
          )}
        </BentoCard>

        <BentoCard
          title="Receipts"
          subtitle="Every payment in, against invoices or not"
          icon={Banknote}
          flush
          action={
            matching.length > LATEST_ROWS ? (
              <Button variant="outline" size="sm" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show latest' : 'View all'}
              </Button>
            ) : undefined
          }
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2 px-4">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search receipts by payer, number, invoice or category"
                placeholder="Search payers, numbers or invoices…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as CashReceiptFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="posted">Posted</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('cash-receipts', localIsoDate(new Date())), cashReceiptsCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Date</TableHead>
                  <TableHead>No.</TableHead>
                  <TableHead>Received from</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                        No receipts yet. A payment recorded on Payments In shows here too.
                      </TableCell>
                    </TableRow>
                  ) : inPeriodRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                        {emptyPeriodText('receipts', period)}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={8} />
                  ))}
                {shown.map((r) => (
                  <TableRow key={r.transaction_id} className={cn(r.status === 'void' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(r.txn_date)}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{r.number ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.party_name ?? '—'}</TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground" title={receiptFor(r)}>{receiptFor(r)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        {r.account_kind === 'cash' ? <Banknote className="size-3.5" /> : <Landmark className="size-3.5" />}
                        {r.account_name}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{PAYMENT_METHOD_LABELS[r.method]}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(r.amount)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={r.status === 'posted'} />
                        <span
                          className={cn(
                            'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_STYLES[r.status],
                          )}
                        >
                          {CASH_RECEIPT_STATUS_LABELS[r.status]}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {countLine ? <div className="border-t px-4 py-3 text-sm text-muted-foreground">{countLine}</div> : null}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
