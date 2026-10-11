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
import { CREDIT_NOTE_REASON_LABELS, type CreditNoteRow, type CreditNoteStatus } from '@/lib/finance/credit-notes';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import {
  CREDIT_NOTE_STATUS_LABELS,
  type CreditNoteFilter,
  type CreditNotesViewData,
  creditNotesCsv,
  filterCreditNotes,
  refundedOnNote,
} from '@/lib/finance/sales-followon-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const CREDITED_SERIES: Series[] = [{ key: 'credited', label: 'Credited (RM k)', color: 'var(--chart-3)' }];

const STATUS_STYLES: Record<CreditNoteStatus, string> = {
  issued: 'bg-emerald-500/15 text-emerald-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

const COLUMNS = 8;

/** A draft or a void credit note has refunded nothing: a dash, as a draft's number is. */
const formatRefunded = (amount: number | null) => (amount === null ? '—' : rm(amount));

/**
 * Credit Notes, read-only: figures, charts and the table, with search, a
 * status filter, "View all" and Export. Nothing here writes; the form and the
 * row actions (issue, refund, void) come with the next stage.
 */
export function CreditNotesView({
  rows,
  view,
}: {
  /** Every credit note, newest first; drafts and void ones included. */
  rows: CreditNoteRow[];
  view: CreditNotesViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CreditNoteFilter>('open');
  const [showAll, setShowAll] = useState(false);

  const matching = filterCreditNotes(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Credit Notes" subtitle="Credits issued against customer invoices, Saudara." />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Credited over time" subtitle="Last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={CREDITED_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing credited in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Credits by reason" subtitle="This year" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReasons ? (
            <DonutStat data={view.byReason} height={240} centerValue={view.creditedYtd} centerLabel="credited" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing credited this year.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Credit notes"
          subtitle="What you have credited your customers"
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
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search credit notes by number, customer or invoice"
                placeholder="Search credit notes, customers or invoices…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as CreditNoteFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="issued">Issued</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('credit-notes', localIsoDate(new Date())), creditNotesCsv(matching))}
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
                  <TableHead>Against invoice</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Refunded</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                        No credit notes yet. Issuing credit notes comes in the next update.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={COLUMNS} />
                  ))}
                {shown.map((n) => (
                  <TableRow key={n.id} className={cn(n.status === 'void' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap font-medium">{n.credit_note_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(n.credit_date)}</TableCell>
                    <TableCell className="whitespace-nowrap">{n.customer_name}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{n.invoice_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{CREDIT_NOTE_REASON_LABELS[n.reason]}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(n.amount)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{formatRefunded(refundedOnNote(n))}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={n.status === 'issued'} />
                        <span
                          className={cn(
                            'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_STYLES[n.status],
                          )}
                        >
                          {CREDIT_NOTE_STATUS_LABELS[n.status]}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} credit notes
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
