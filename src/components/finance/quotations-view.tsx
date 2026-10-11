'use client';

import { useState } from 'react';
import { ChartColumn, Download, FileText, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, FunnelFlow, type Series } from '@/components/charts';
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
import type { QuotationDisplayStatus, QuotationListRow } from '@/lib/finance/quotations';
import {
  QUOTATION_STATUS_LABELS,
  type QuotationFilter,
  type QuotationsViewData,
  customersOf,
  filterQuotations,
  quotationInvoice,
  quotationsCsv,
} from '@/lib/finance/sales-followon-views';
import { customerChoice } from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const TREND_SERIES: Series[] = [
  { key: 'quoted', label: 'Quoted (RM k)', color: 'var(--chart-1)' },
  { key: 'accepted', label: 'Accepted (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<QuotationDisplayStatus, string> = {
  accepted: 'bg-emerald-500/15 text-emerald-600',
  sent: 'bg-amber-500/15 text-amber-600',
  expired: 'bg-red-500/15 text-red-600',
  declined: 'bg-muted text-muted-foreground line-through',
  draft: 'bg-muted text-muted-foreground',
};

const COLUMNS = 7;

/**
 * Quotations, read-only: figures, charts and the table, with search, filters,
 * "View all" and Export. Nothing here writes; the form and the row actions
 * (send, mark accepted or declined, convert to invoice) come with the next stage.
 */
export function QuotationsView({
  rows,
  view,
}: {
  /** Every quotation, newest first; drafts included. */
  rows: QuotationListRow[];
  view: QuotationsViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<QuotationFilter>('all');
  const [chosenCustomer, setCustomer] = useState('all');
  const [showAll, setShowAll] = useState(false);

  const customers = customersOf(rows);
  // A refresh can take the chosen customer's last quotation away: the filter then goes back to everyone, and stays there.
  const customer = customerChoice(chosenCustomer, customers);
  if (customer !== chosenCustomer) setCustomer(customer);
  const matching = filterQuotations(rows, query, filter, customer);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Quotations" subtitle="Quotes you have given your customers, and their answers, Saudara." />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard
          title="Quoted value over time"
          subtitle="Quoted vs accepted · last 8 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={TREND_SERIES} height={240} showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">
              Nothing quoted or accepted in the last 8 months.
            </p>
          )}
        </BentoCard>
        <BentoCard title="Acceptance funnel" subtitle="This quarter" icon={ChartColumn} className="col-span-2 md:col-span-4">
          {view.funnelCount === 0 ? (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">No quotations this quarter.</p>
          ) : (
            <FunnelFlow data={view.funnel} height={240} />
          )}
        </BentoCard>

        <BentoCard
          title="Quotations"
          subtitle="What you have quoted your customers"
          icon={FileText}
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
                aria-label="Search quotations by number or customer"
                placeholder="Search quotations or customers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as QuotationFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="accepted">Accepted</SelectItem>
                <SelectItem value="declined">Declined</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
            <Select value={customer} onValueChange={setCustomer}>
              <SelectTrigger className="w-48" aria-label="Customer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All customers</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('quotations', localIsoDate(new Date())), quotationsCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>No.</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Valid until</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Invoice</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                        No quotations yet. Creating quotations comes in the next update.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={COLUMNS} />
                  ))}
                {shown.map((q) => (
                  <TableRow key={q.id} className={cn(q.display_status === 'declined' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap font-medium">{q.quotation_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(q.quote_date)}</TableCell>
                    <TableCell className="whitespace-nowrap">{q.customer_name}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(q.total)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(q.valid_until)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={q.display_status === 'accepted'} />
                        <span
                          className={cn(
                            'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_STYLES[q.display_status],
                          )}
                        >
                          {QUOTATION_STATUS_LABELS[q.display_status]}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{quotationInvoice(q) ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} quotations
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
