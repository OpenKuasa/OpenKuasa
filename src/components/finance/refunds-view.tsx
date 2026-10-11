'use client';

import { useState } from 'react';
import { Banknote, Download, PieChart, Search, TrendingUp } from 'lucide-react';
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
import { localIsoDate } from '@/lib/finance/bill-math';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import { REFUND_REASON_LABELS, type RefundRow } from '@/lib/finance/refunds';
import {
  REFUND_STATUS_LABELS,
  type RefundFilter,
  type RefundsViewData,
  filterRefunds,
  refundsCsv,
} from '@/lib/finance/sales-followon-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const REFUNDED_SERIES: Series[] = [{ key: 'refunded', label: 'Refunded (RM k)', color: 'var(--chart-3)' }];

const STATUS_STYLES: Record<RefundRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-muted text-muted-foreground',
  rejected: 'bg-red-500/15 text-red-600',
  void: 'bg-muted text-muted-foreground line-through',
};

const COLUMNS = 8;

/**
 * Refunds, read-only: figures, charts and the table, with search, a status
 * filter, "View all" and Export. Nothing here writes; the form and the row
 * actions (mark paid out, delete, void) come with the next stage.
 */
export function RefundsView({
  rows,
  view,
}: {
  /** Every refund, newest first; pending and void ones included. */
  rows: RefundRow[];
  view: RefundsViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RefundFilter>('open');
  const [showAll, setShowAll] = useState(false);

  const matching = filterRefunds(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Refunds" subtitle="Money paid back to customers who are in credit, Saudara." />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Refunded over time" subtitle="Last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={REFUNDED_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing refunded in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Refunds by reason" subtitle="This year" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReasons ? (
            <DonutStat data={view.byReason} height={240} centerValue={view.refundedYtd} centerLabel="refunded" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing refunded this year.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Refunds"
          subtitle="What you have paid back, and what is waiting to be paid"
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
                aria-label="Search refunds by customer, invoice, credit note or number"
                placeholder="Search customers, invoices or numbers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as RefundFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="posted">Refunded</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('refunds', localIsoDate(new Date())), refundsCsv(matching))}
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
                  <TableHead>Credit note</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                        No refunds yet. Recording refunds comes in the next update.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={COLUMNS} />
                  ))}
                {shown.map((r) => (
                  <TableRow key={r.allocation_id} className={cn(r.status === 'void' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(r.txn_date)}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{r.number ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.customer_name}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{r.invoice_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{r.credit_note_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{REFUND_REASON_LABELS[r.reason]}</TableCell>
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
                          {REFUND_STATUS_LABELS[r.status]}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} refunds
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
