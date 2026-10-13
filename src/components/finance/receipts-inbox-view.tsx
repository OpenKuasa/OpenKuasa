'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FilePlus, FileText, Link2, Link2Off, Pencil, PieChart, Receipt, Search, Sparkles, Trash2, Wallet } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { DonutStat } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { type MatchOpen, ReceiptMatchCard, type ReceiptMatchData } from '@/components/finance/receipt-match-cards';
import { ReceiptReadCard, type ReceiptReadingData } from '@/components/finance/receipt-read-card';
import { type ReceiptLinkOf, ReceiptReviewCard, type ReviewReceipt } from '@/components/finance/receipt-review-card';
import { ReceiptUploadCard, type RegisterReceipt } from '@/components/finance/receipt-upload-card';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { useReceiptDownload } from '@/components/finance/use-receipt-download';
import { useLocalToday } from '@/components/finance/use-local-today';
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
import { canPreview } from '@/lib/finance/receipt-files';
import { type InboxWritten, RECEIPT_INBOX_MESSAGES, inboxHiddenNote } from '@/lib/finance/receipt-inbox';
import {
  type MatchWritten,
  type MatchedDocument,
  type ReceiptMatchAction,
  UNTIE_NEEDS_DECIDER,
  matchHiddenNote,
  matchNote,
  receiptMatchActions,
} from '@/lib/finance/receipt-match';
import { type SuggestedCategory, canOfferReading, readAnswerFate, reviewCardKey, standingSuggestion } from '@/lib/finance/receipt-reading';
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
import type { FinResult } from '@/lib/finance/result';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<InboxReceiptStatus, string> = {
  matched: 'bg-emerald-500/15 text-emerald-600',
  review: 'bg-amber-500/15 text-amber-600',
  unmatched: 'bg-red-500/15 text-red-600',
};

export type ReceiptInboxActions = {
  register: RegisterReceipt;
  review: ReviewReceipt;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/**
 * Receipts Inbox: the three counts, the donut and the table, with search, a
 * status filter, "View all" and Export. Someone who may edit also gets the
 * upload area, and on each receipt that is tied to nothing "Review",
 * "Create expense", "Create draft bill", "Attach to expense or bill" and
 * "Delete", and on a matched one "Untie" (from an approved expense or a posted
 * bill, an owner or admin only); on a receipt still in review that has a file,
 * "Read with AI" opens a card that asks before anything is sent, and after a
 * reading the review card opens on what was read. Anyone who can see a receipt
 * that has a file can download it. Under "Matched to" a second line says how the document
 * stands. A
 * viewer and the demo workspace change nothing, and the demo is told why it
 * has no upload area. A file name is whatever the uploader's device called
 * the file, so it is only ever drawn as text. A row says "Read by AI" only
 * when the database says a model read it, and what a failed reading says is
 * this screen's own sentence, never the stored message.
 */
export function ReceiptsInboxView({
  rows,
  view,
  today,
  followClock = true,
  linkOf,
  documents,
  writer,
  demo = false,
}: {
  /** Every receipt, newest upload first. */
  rows: InboxReceiptRow[];
  view: ReceiptsInboxViewData;
  /** The server's date; the person's own date takes over in the browser. */
  today: string;
  followClock?: boolean;
  /** Makes a one-minute link to a receipt's file. Absent when there is no database behind the screen. */
  linkOf?: ReceiptLinkOf;
  /** For each matched receipt, by its id: the document it is tied to and how that stands. Absent with no database. */
  documents?: Record<string, MatchedDocument>;
  /**
   * Present only for someone who may add, review, match and delete receipts. `match` is what matching needs,
   * `reading` what having a receipt read by AI needs.
   */
  writer?: { orgId: string; actions: ReceiptInboxActions; match?: ReceiptMatchData; reading?: ReceiptReadingData };
  /** The shared demo workspace: it is told why there is no upload area. */
  demo?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InboxReceiptFilter>('all');
  const [showAll, setShowAll] = useState(false);
  // The receipt being reviewed as it was when the card opened: kept, so the card can stay if someone else deletes it.
  const [reviewing, setReviewing] = useState<InboxReceiptRow | null>(null);
  const [deleted, setDeleted] = useState<InboxReceiptRow | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [written, setWritten] = useState<InboxWritten | null>(null);
  // Matching: the card that is open for one receipt, the receipt being asked about untying, and what was last matched or untied.
  const [matchOpen, setMatchOpen] = useState<MatchOpen | null>(null);
  const [untying, setUntying] = useState<string | null>(null);
  const [matched, setMatched] = useState<MatchWritten | null>(null);
  // Reading with AI: the receipt the question is open for, and, by receipt id, what a reading made from this screen
  // suggested as its category (null for none). Kept here only: a reload forgets it.
  const [asking, setAsking] = useState<InboxReceiptRow | null>(null);
  const [readHere, setReadHere] = useState<Record<string, SuggestedCategory | null>>({});
  // Which receipt's question is the open thing, for an answer that arrives later; and a refusal that arrived after
  // the question had gone, so that it is said and not lost.
  const askingId = useRef<string | null>(null);
  useEffect(() => {
    // Whatever closes or opens the question (a menu action, Cancel, the answer) changes `asking`; this follows it.
    askingId.current = asking?.id ?? null;
  }, [asking]);
  const [readRefusal, setReadRefusal] = useState<{ fileName: string; message: string } | null>(null);
  const localToday = useLocalToday(today, followClock);
  const remove = useFinanceAction();
  const untie = useFinanceAction();
  // The download has its own state, so a slow file does not hold the page's other actions in "pending".
  const open = useReceiptDownload(async (input) => (linkOf ? linkOf(input) : { ok: false, error: '' }));

  const matching = filterInboxReceipts(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const live = reviewing ? rows.find((r) => r.id === reviewing.id) : undefined;
  const reviewed = reviewing ? (live ?? reviewing) : undefined;
  // Someone else deleted or matched it while the card was open: the card stays, says so, and keeps what was typed.
  const blocked = reviewing ? (!live ? RECEIPT_INBOX_MESSAGES.gone : live.status === 'matched' ? RECEIPT_INBOX_MESSAGES.matched : null) : null;
  const hiddenNote = written ? inboxHiddenNote(written, rows, shown, filter) : null;
  const matchedNote = matched ? matchNote(matched) : null;
  const matchedHidden = matched ? matchHiddenNote(matched, rows, shown) : null;
  const match = writer?.match;
  /** What matching offers on a receipt; nothing for someone who may not edit. */
  const offeredFor = (r: InboxReceiptRow): ReceiptMatchAction[] => (match ? receiptMatchActions(r, documents?.[r.id], match.canDecide) : []);
  // Said once, above the table, when a matched receipt on screen is one this person may not untie.
  const untieNote = match && !match.canDecide && shown.some((r) => r.status === 'matched' && offeredFor(r).length === 0);
  /** The category a reading suggested for a receipt, while it still stands; null otherwise. */
  const suggestionFor = (id: string) =>
    standingSuggestion(rows.find((r) => r.id === id), readHere[id] ?? undefined, match?.categories ?? []);
  /** One thing open at a time: whatever card, question or note is up goes before the next opens. */
  const closeAll = () => {
    remove.clear();
    untie.clear();
    setReviewing(null);
    setDeleting(null);
    setDeleted(null);
    setMatchOpen(null);
    setUntying(null);
    setMatched(null);
    setAsking(null);
    setReadRefusal(null);
  };
  // Someone who cannot change anything has a menu only where a file can be downloaded: the demo's sample receipts have none.
  const columns = writer || (linkOf && rows.some((r) => r.has_file)) ? 7 : 6;

  const added = useCallback((id: string) => {
    setWritten((was) => ({ kind: 'added', ids: was?.kind === 'added' ? [...was.ids, id] : [id] }));
  }, []);

  const menuFor = (r: InboxReceiptRow): RowMenuItem[] => {
    const items: RowMenuItem[] = [];
    if (linkOf && r.has_file) {
      items.push({
        label: canPreview(r.mime_type) ? 'Download' : 'Download to view',
        icon: Download,
        onSelect: () => void open.start(r.id, r.file_name),
      });
    }
    if (!writer) return items;
    const tied = r.status === 'matched';
    // A matched receipt is its document's evidence: it is untied before it is changed or deleted.
    if (!tied) {
      items.push({
        label: r.status === 'review' ? 'Review' : 'Edit details',
        icon: Pencil,
        opens: true,
        onSelect: () => {
          closeAll();
          setReviewing(r);
        },
      });
    }
    // Opens the question only: nothing is sent until the card's own button is pressed.
    if (writer.reading && canOfferReading(r)) {
      items.push({
        label: 'Read with AI',
        icon: Sparkles,
        opens: true,
        onSelect: () => {
          closeAll();
          setAsking(r);
        },
      });
    }
    const offered = offeredFor(r);
    const openMatch = (kind: MatchOpen['kind']) => () => {
      closeAll();
      setMatchOpen({ kind, row: r, today: localToday });
    };
    if (offered.includes('expense')) items.push({ label: 'Create expense', icon: Wallet, opens: true, onSelect: openMatch('expense') });
    if (offered.includes('bill')) items.push({ label: 'Create draft bill', icon: FilePlus, opens: true, onSelect: openMatch('bill') });
    if (offered.includes('attach')) items.push({ label: 'Attach to expense or bill', icon: Link2, opens: true, onSelect: openMatch('attach') });
    if (offered.includes('untie')) {
      items.push({
        label: 'Untie',
        icon: Link2Off,
        opens: true,
        onSelect: () => {
          closeAll();
          setUntying(r.id);
        },
      });
    }
    if (!tied) {
      items.push({
        label: 'Delete',
        icon: Trash2,
        destructive: true,
        opens: true,
        onSelect: () => {
          closeAll();
          setDeleting(r.id);
        },
      });
    }
    return items;
  };

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Receipts Inbox" subtitle="Receipts waiting to be reviewed and matched, Saudara." />

      <BentoGrid>
        {writer && linkOf && reviewed ? (
          <ReceiptReviewCard
            // A fresh card, with fresh boxes, for each receipt, and again when a reading made here arrives.
            key={reviewCardKey(reviewed, reviewed.id in readHere)}
            row={reviewed}
            suggestion={suggestionFor(reviewed.id)}
            blocked={blocked}
            today={localToday}
            review={writer.actions.review}
            linkOf={linkOf}
            onClose={() => setReviewing(null)}
            onSaved={(id) => {
              setReviewing(null);
              setWritten({ kind: 'reviewed', ids: [id] });
            }}
          />
        ) : null}
        {writer?.reading && asking ? (
          <ReceiptReadCard
            key={asking.id}
            // The receipt as the list has it now, so the question is about what would be replaced now.
            row={rows.find((r) => r.id === asking.id) ?? asking}
            reading={writer.reading}
            onClose={() => setAsking(null)}
            onRefused={(message) => {
              if (readAnswerFate(askingId.current, asking.id) === 'drop') setReadRefusal({ fileName: asking.file_name, message });
            }}
            onRead={(read) => {
              // The person opened something else while the file was being read: nothing opens beside it.
              // What was stored shows on the row.
              if (readAnswerFate(askingId.current, read.id) === 'drop') return;
              setReadHere((was) => ({ ...was, [read.id]: read.category }));
              setAsking(null);
              // What was read is a suggestion: it opens in the review card, for the person to check.
              setReviewing(asking);
            }}
          />
        ) : null}
        {match && matchOpen ? (
          <ReceiptMatchCard
            // A fresh card for each receipt and each way of matching it.
            key={`${matchOpen.kind}-${matchOpen.row.id}`}
            open={matchOpen}
            match={match}
            suggestion={suggestionFor(matchOpen.row.id)}
            onClose={() => setMatchOpen(null)}
            onDone={(done) => {
              setMatchOpen(null);
              setMatched(done);
            }}
          />
        ) : null}
        {matched && matchedNote ? (
          <SavedNoteCard
            // A second match gets a note of its own, which takes focus again.
            key={`${matched.kind}-${matched.receiptId}`}
            title={matchedNote.title}
            subtitle={matched.fileName}
            onClose={() => setMatched(null)}
          >
            {matchedNote.body}
            {matchedHidden ? ` ${matchedHidden}` : ''}
          </SavedNoteCard>
        ) : null}
        {readRefusal ? (
          <SavedNoteCard title="Receipt not read" subtitle={readRefusal.fileName} onClose={() => setReadRefusal(null)}>
            {readRefusal.message}
          </SavedNoteCard>
        ) : null}
        {deleted ? (
          <SavedNoteCard title="Receipt deleted" subtitle={deleted.file_name} onClose={() => setDeleted(null)}>
            {deleted.has_file ? 'The receipt and its file were deleted.' : 'The receipt was deleted.'}
          </SavedNoteCard>
        ) : null}
        {writer ? <ReceiptUploadCard orgId={writer.orgId} register={writer.actions.register} onAdded={added} /> : null}
        {demo ? (
          <p className="col-span-2 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground md:col-span-12">
            Uploading is switched off in the demo workspace, because everyone who tries the demo shares it. These are
            sample receipts with no files. In a workspace of your own you can add photos and PDFs here.
          </p>
        ) : null}
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className={i === 0 ? 'col-span-2 md:col-span-4' : 'col-span-1 md:col-span-4'}>
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}
        <BentoCard title="By status" subtitle="Every receipt" icon={PieChart} className="col-span-2 md:col-span-4 md:self-start">
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
          className="col-span-2 md:col-span-8"
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
          {hiddenNote ? (
            <p role="status" className="mt-2 px-4 text-sm text-muted-foreground">
              {hiddenNote}
            </p>
          ) : null}
          {untieNote ? <p className="mt-2 px-4 text-sm text-muted-foreground">{UNTIE_NEEDS_DECIDER}</p> : null}
          {open.busyWith !== null ? (
            <p role="status" className="mt-2 px-4 text-sm text-muted-foreground">
              Preparing the download of {open.busyWith}…
            </p>
          ) : null}
          {open.error ? (
            <p role="alert" className="mt-2 px-4 text-sm text-destructive">
              {open.error}
            </p>
          ) : null}
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
                  {columns === 7 ? (
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                        {writer ? 'No receipts yet. Add the first one above.' : 'No receipts yet.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((r) => {
                  const note = inboxReadingNote(r);
                  if (writer && deleting === r.id) {
                    return (
                      <ConfirmRow
                        key={r.id}
                        colSpan={columns}
                        label={`Delete ${r.file_name}`}
                        confirmLabel="Delete"
                        pendingLabel="Deleting…"
                        pending={remove.pending}
                        error={remove.error}
                        onConfirm={() =>
                          remove.run(
                            () => writer.actions.remove({ id: r.id }),
                            () => {
                              setDeleting(null);
                              setDeleted(r);
                            },
                          )
                        }
                        onCancel={() => {
                          remove.clear();
                          setDeleting(null);
                        }}
                      >
                        Delete <span className="break-words font-medium">{r.file_name}</span>
                        {r.has_file ? ' and its file' : ''}? This cannot be undone.
                      </ConfirmRow>
                    );
                  }
                  if (match && untying === r.id) {
                    return (
                      <ConfirmRow
                        key={r.id}
                        colSpan={columns}
                        label={`Untie ${r.file_name}`}
                        confirmLabel="Untie"
                        pendingLabel="Untying…"
                        tone="default"
                        pending={untie.pending}
                        error={untie.error}
                        onConfirm={() =>
                          untie.run(
                            () => match.actions.detach({ id: r.id }),
                            () => {
                              setUntying(null);
                              setMatched({ kind: 'untied', receiptId: r.id, fileName: r.file_name });
                            },
                          )
                        }
                        onCancel={() => {
                          untie.clear();
                          setUntying(null);
                        }}
                      >
                        Untie <span className="break-words font-medium">{r.file_name}</span> from{' '}
                        {r.document_kind ? inboxDocument(r) : 'its expense or bill'}? The receipt goes back to Unmatched. The
                        expense or bill is not changed.
                      </ConfirmRow>
                    );
                  }
                  const menu = menuFor(r);
                  const document = documents?.[r.id];
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="grid size-8 shrink-0 place-items-center rounded bg-muted">
                            <Receipt className="size-4 text-muted-foreground" />
                          </div>
                          <div className="min-w-36">
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
                      <TableCell className="min-w-44">
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
                      <TableCell className="text-muted-foreground">
                        <p className="whitespace-nowrap">{inboxDocument(r)}</p>
                        {r.status === 'matched' && document?.label ? <p className="whitespace-nowrap text-xs">{document.label}</p> : null}
                      </TableCell>
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
                      {columns === 7 ? (
                        <TableCell className="w-10">{menu.length > 0 ? <RowMenu label={r.file_name} items={menu} /> : null}</TableCell>
                      ) : null}
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
