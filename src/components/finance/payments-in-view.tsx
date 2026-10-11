'use client';

import { useState } from 'react';
import { Banknote, Download, PieChart, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { downloadCsv } from '@/components/finance/download-csv';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentInRow } from '@/lib/finance/money';
import {
  PAYMENT_IN_STATUS_LABELS,
  type PaymentInMethodFilter,
  type PaymentInStatusFilter,
  type PaymentsInViewData,
  filterPaymentsIn,
  paymentsInCsv,
} from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const RECEIVED_SERIES: Series[] = [{ key: 'received', label: 'Received (RM k)', color: 'var(--chart-2)' }];

const STATUS_STYLES: Record<PaymentInRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-muted text-muted-foreground',
  rejected: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

const COLUMNS = 8;

/**
 * Payments In, read-only: figures, charts and the table, with search,
 * filters, "View all" and Export. Nothing here writes; recording and voiding
 * a payment come with the next stage.
 */
export function PaymentsInView({
  rows,
  view,
}: {
  /** One row per invoice a payment pays, newest first; void ones included. */
  rows: PaymentInRow[];
  view: PaymentsInViewData;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<PaymentInStatusFilter>('posted');
  const [method, setMethod] = useState<PaymentInMethodFilter>('all');
  const [showAll, setShowAll] = useState(false);

  const matching = filterPaymentsIn(rows, query, status, method);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Payments In" subtitle="Payments received from your customers, Saudara." />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Received over time" subtitle="Last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={RECEIVED_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing received in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Received by method" subtitle="Month to date · RM" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReceived ? (
            <DonutStat data={view.byMethod} height={240} centerValue={view.receivedMtd} centerLabel="received" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing received yet this month.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Payments"
          subtitle="One row for each invoice a payment pays"
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
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search payments by customer, invoice, receipt number or reference"
                placeholder="Search payments…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={status} onValueChange={(v) => setStatus(v as PaymentInStatusFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="posted">Received</SelectItem>
                <SelectItem value="void">Void</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentInMethodFilter)}>
              <SelectTrigger className="w-40" aria-label="Method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All methods</SelectItem>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('payments-in', localIsoDate(new Date())), paymentsInCsv(matching))}
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
                  <TableHead>Customer</TableHead>
                  <TableHead>Invoice</TableHead>
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
                      <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                        No payments yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={COLUMNS} />
                  ))}
                {shown.map((p) => (
                  // A payment split across invoices is several rows; the allocation is what each row is.
                  <TableRow key={p.allocation_id} className={cn(p.status === 'void' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(p.txn_date)}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{p.number ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{p.customer_name}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.invoice_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{p.account_name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="whitespace-nowrap">
                        {PAYMENT_METHOD_LABELS[p.method]}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(p.amount)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={p.status === 'posted'} />
                        <span
                          className={cn(
                            'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_STYLES[p.status],
                          )}
                        >
                          {PAYMENT_IN_STATUS_LABELS[p.status]}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} rows
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
