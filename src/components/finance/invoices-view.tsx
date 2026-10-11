'use client';

import { useState } from 'react';
import { Download, FileText, PieChart, Search, TrendingUp } from 'lucide-react';
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
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import {
  EINVOICE_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  type InvoiceFilter,
  type InvoicesViewData,
  filterInvoices,
  invoiceCustomers,
  invoicesCsv,
  owed,
} from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const TREND_SERIES: Series[] = [
  { key: 'invoiced', label: 'Invoiced (RM k)', color: 'var(--chart-1)' },
  { key: 'received', label: 'Received (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<InvoiceDisplayStatus, string> = {
  paid: 'bg-emerald-500/15 text-emerald-600',
  sent: 'bg-amber-500/15 text-amber-600',
  overdue: 'bg-red-500/15 text-red-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

const EINVOICE_STYLES: Record<Exclude<EInvoiceStatus, 'none'>, string> = {
  validated: 'bg-emerald-500/15 text-emerald-600',
  pending: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
};

/** A draft or void invoice owes nothing: a dash, as a draft's number is. */
const formatOwed = (balance: number | null) => (balance === null ? '—' : rm(balance));

const COLUMNS = 8;

/**
 * Invoices, read-only: figures, charts and the table, with search, filters,
 * "View all" and Export. Nothing here writes; the forms and row actions come
 * with the next stage.
 */
export function InvoicesView({
  rows,
  view,
}: {
  /** Every invoice, newest first; drafts and void ones included. */
  rows: InvoiceListRow[];
  view: InvoicesViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InvoiceFilter>('open');
  const [chosenCustomer, setCustomer] = useState('all');
  const [showAll, setShowAll] = useState(false);

  const customers = invoiceCustomers(rows);
  // A refresh can remove the chosen customer; fall back to everyone rather than show a blank select.
  const customer = customers.some((c) => c.id === chosenCustomer) ? chosenCustomer : 'all';
  const matching = filterInvoices(rows, query, filter, customer);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Invoices" subtitle="Sales invoices and their e-Invois status, Saudara." />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard
          title="Invoiced over time"
          subtitle="Invoiced vs received · last 8 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={TREND_SERIES} height={240} showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">
              Nothing invoiced or received in the last 8 months.
            </p>
          )}
        </BentoCard>
        <BentoCard title="Invoices by status" subtitle="Current book" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.invoiceCount === 0 ? (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">
              {rows.length === 0 ? 'No invoices yet.' : 'No open invoices.'}
            </p>
          ) : (
            <DonutStat data={view.byStatus} height={240} centerValue={String(view.invoiceCount)} centerLabel="invoices" />
          )}
        </BentoCard>

        <BentoCard
          title="Invoices"
          subtitle="What you have billed your customers"
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
                aria-label="Search invoices by number or customer"
                placeholder="Search invoices or customers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as InvoiceFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="void">Void</SelectItem>
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
              onClick={() => downloadCsv(csvFileName('invoices', localIsoDate(new Date())), invoicesCsv(matching))}
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
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>e-Invois</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                        No invoices yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={COLUMNS} />
                  ))}
                {shown.map((i) => (
                  <TableRow key={i.id} className={cn(i.display_status === 'void' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap font-medium">{i.invoice_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(i.invoice_date)}</TableCell>
                    <TableCell className="whitespace-nowrap">{i.customer_name}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(i.due_date)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(i.total)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{formatOwed(owed(i))}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={i.display_status === 'paid'} />
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_STYLES[i.display_status],
                          )}
                        >
                          {INVOICE_STATUS_LABELS[i.display_status]}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {i.einvoice_status === 'none' ? (
                        <span className="text-sm text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                            EINVOICE_STYLES[i.einvoice_status],
                          )}
                        >
                          {EINVOICE_STATUS_LABELS[i.einvoice_status]}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} invoices
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
