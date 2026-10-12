'use client';

import { useState } from 'react';
import { Download, FileText, PieChart, Receipt, Search } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { DonutStat } from '@/components/charts';
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
import {
  INBOX_READING_NOTES,
  INBOX_STATUS_LABELS,
  INBOX_TYPE_LABELS,
  type InboxReceiptFilter,
  type ReceiptsInboxViewData,
  fileSizeLabel,
  filterInboxReceipts,
  inboxDocument,
  inboxReadingNote,
  inboxReceiptsCsv,
} from '@/lib/finance/receipt-views';
import type { InboxReceiptRow, InboxReceiptStatus } from '@/lib/finance/receipts';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<InboxReceiptStatus, string> = {
  matched: 'bg-emerald-500/15 text-emerald-600',
  review: 'bg-amber-500/15 text-amber-600',
  unmatched: 'bg-red-500/15 text-red-600',
};

/**
 * Receipts Inbox: the three counts, the donut and the table, with search, a
 * status filter, "View all" and Export. Nothing here changes data yet:
 * uploading, reviewing, matching and deleting arrive later. A file name is
 * whatever the uploader's device called the file, so it is only ever drawn as
 * text. A row says "Read by AI" only when the database says a model read it,
 * and what a failed reading says is this screen's own sentence, never the
 * stored message.
 */
export function ReceiptsInboxView({
  rows,
  view,
}: {
  /** Every receipt, newest upload first. */
  rows: InboxReceiptRow[];
  view: ReceiptsInboxViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InboxReceiptFilter>('all');
  const [showAll, setShowAll] = useState(false);

  const matching = filterInboxReceipts(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Receipts Inbox" subtitle="Receipts waiting to be reviewed and matched, Saudara." />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}
        <BentoCard title="By status" subtitle="Every receipt" icon={PieChart} className="col-span-1 md:col-span-3">
          {view.hasReceipts ? (
            <DonutStat data={view.byStatus} height={220} centerValue={view.total} centerLabel="receipts" />
          ) : (
            <p className="grid h-[220px] place-items-center text-sm text-muted-foreground">Nothing to chart yet.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Receipt inbox"
          subtitle="What was uploaded, what was read from it, and what it is matched to"
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
                aria-label="Search receipts by file name, vendor or document"
                placeholder="Search files or vendors…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as InboxReceiptFilter)}>
              <SelectTrigger className="w-44" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All receipts</SelectItem>
                <SelectItem value="review">To review</SelectItem>
                <SelectItem value="matched">Matched</SelectItem>
                <SelectItem value="unmatched">Unmatched</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('receipts-inbox', localIsoDate(new Date())), inboxReceiptsCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Receipt</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Matched to</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        No receipts yet. Uploading receipts is not available yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={6} />
                  ))}
                {shown.map((r) => {
                  const note = inboxReadingNote(r);
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="grid size-8 shrink-0 place-items-center rounded bg-muted">
                            <Receipt className="size-4 text-muted-foreground" />
                          </div>
                          <div className="min-w-0">
                            <p className="max-w-56 whitespace-normal break-words font-medium">
                              {r.file_name}
                            </p>
                            <p className="whitespace-normal text-xs text-muted-foreground">
                              {r.has_file
                                ? `${INBOX_TYPE_LABELS[r.mime_type]} · ${fileSizeLabel(r.size_bytes)}`
                                : 'Sample receipt, no file'}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <p className="max-w-64 whitespace-normal break-words">{r.vendor ?? '—'}</p>
                        {note && (
                          <p className="max-w-64 whitespace-normal text-xs text-muted-foreground">
                            {INBOX_READING_NOTES[note]}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {r.receipt_date ? displayDate(r.receipt_date) : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                        {r.amount === null ? '—' : rm(r.amount)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{inboxDocument(r)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={r.status === 'matched'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[r.status],
                            )}
                          >
                            {INBOX_STATUS_LABELS[r.status]}
                          </span>
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} receipts
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
