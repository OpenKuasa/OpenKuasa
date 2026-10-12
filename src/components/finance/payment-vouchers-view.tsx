'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Download, PieChart, Search, TrendingUp, Wallet } from 'lucide-react';
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
import type { PaymentVoucherKind, PaymentVoucherRow } from '@/lib/finance/cash-book';
import {
  CASH_BOOK_PERIODS,
  CASH_BOOK_PERIOD_LABELS,
  PAYMENT_VOUCHER_KIND_LABELS,
  PAYMENT_VOUCHER_STATUS_LABELS,
  type CashBookPeriod,
  cashBookCountLine,
  emptyPeriodText,
  inPeriod,
  nothingInPeriod,
  type PaymentVoucherFilter,
  filterPaymentVouchers,
  paymentVouchersCsv,
  paymentVouchersInPeriod,
  paymentVouchersView,
  voucherCategory,
  voucherHome,
} from '@/lib/finance/cash-book-views';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const PAID_SERIES: Series[] = [{ key: 'paid', label: 'Paid out (RM k)', color: 'var(--chart-1)' }];

const KINDS: PaymentVoucherKind[] = ['bill', 'refund', 'expense', 'other'];

const STATUS_STYLES: Record<PaymentVoucherRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-sky-500/15 text-sky-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-muted text-muted-foreground',
  rejected: 'bg-red-500/15 text-red-600',
  void: 'bg-muted text-muted-foreground line-through',
};

/**
 * Payment Vouchers: every movement of money out, one row each. The chosen
 * period sets the figures, the charts and the rows of the table (vouchers
 * waiting for approval or still to be paid stay in every period, as their
 * cards count them), with search, status and kind filters, "View all" and
 * Export working on top of it; Export gives what the table would show with
 * "View all". Nothing here changes data yet. A payment to a supplier is
 * changed on Payments Out and a refund on Refunds, and each such row links
 * there; the voucher form and the approve and reject buttons arrive later.
 */
export function PaymentVouchersView({
  rows,
  today: serverToday,
  followClock = true,
}: {
  /** Every voucher, newest first; waiting, rejected and void ones included. */
  rows: PaymentVoucherRow[];
  /** The date the figures are worked out for, YYYY-MM-DD, until the browser's own date takes over. */
  today: string;
  /** False for sample data, which keeps its own fixed date. */
  followClock?: boolean;
}) {
  const today = useLocalToday(serverToday, followClock);
  const [period, setPeriod] = useState<CashBookPeriod>('month');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PaymentVoucherFilter>('open');
  const [kind, setKind] = useState<'all' | PaymentVoucherKind>('all');
  const [showAll, setShowAll] = useState(false);

  const view = paymentVouchersView(rows, today, period);
  const inPeriodRows = paymentVouchersInPeriod(rows, today, period);
  const matching = filterPaymentVouchers(inPeriodRows, query, filter, kind);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const span = CASH_BOOK_PERIOD_LABELS[period];
  // Rows the table keeps from outside the period (drafts, money still waiting), earlier or later than it.
  const outside = inPeriodRows.filter((row) => !inPeriod(row.txn_date, today, period));
  const countLine = cashBookCountLine({
    noun: 'vouchers',
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
        title="Payment Vouchers"
        subtitle="Money paid out to suppliers, customers and expenses, Saudara."
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

        <BentoCard title="Payments over time" subtitle="Paid out · last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={PAID_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing paid out in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="By category" subtitle={`Paid · ${span.toLowerCase()}`} icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasPaid ? (
            <DonutStat data={view.byCategory} height={240} centerValue={view.paid} centerLabel="paid" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">{nothingInPeriod('paid out', period)}</p>
          )}
        </BentoCard>

        <BentoCard
          title="Vouchers"
          subtitle="Every payment out: suppliers, refunds, expenses and the rest"
          icon={Wallet}
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
                aria-label="Search vouchers by payee, number, document or category"
                placeholder="Search payees, numbers or categories…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as PaymentVoucherFilter)}>
              <SelectTrigger className="w-44" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All but void and rejected</SelectItem>
                <SelectItem value="waiting">Pending approval</SelectItem>
                <SelectItem value="scheduled">To be paid</SelectItem>
                <SelectItem value="posted">Paid</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={(v) => setKind(v as 'all' | PaymentVoucherKind)}>
              <SelectTrigger className="w-44" aria-label="Kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {PAYMENT_VOUCHER_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('payment-vouchers', localIsoDate(new Date())), paymentVouchersCsv(matching))}
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
                  <TableHead>Paid to</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                        No vouchers yet. A payment recorded on Payments Out or Refunds shows here too.
                      </TableCell>
                    </TableRow>
                  ) : inPeriodRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                        {emptyPeriodText('vouchers', period)}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={8} />
                  ))}
                {shown.map((v) => {
                  const home = voucherHome(v.kind);
                  return (
                    <TableRow key={v.transaction_id} className={cn(v.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(v.txn_date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{v.number ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap">{v.party_name ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {home ? (
                          <Link
                            href={home.href}
                            title={`Managed on ${home.label}`}
                            aria-label={`${PAYMENT_VOUCHER_KIND_LABELS[v.kind]}: open ${home.label}`}
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            {PAYMENT_VOUCHER_KIND_LABELS[v.kind]}
                          </Link>
                        ) : (
                          PAYMENT_VOUCHER_KIND_LABELS[v.kind]
                        )}
                        {v.documents ? <span className="ml-1.5">· {v.documents}</span> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{voucherCategory(v)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{v.account_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(v.amount)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={v.status === 'posted'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[v.status],
                            )}
                          >
                            {PAYMENT_VOUCHER_STATUS_LABELS[v.status]}
                          </span>
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {countLine ? <div className="border-t px-4 py-3 text-sm text-muted-foreground">{countLine}</div> : null}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
