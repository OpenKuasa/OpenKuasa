'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { BookOpen, CircleCheck, ClipboardList, Download, ExternalLink, Pencil, Plus, Search, Send, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { JournalFormCard, type JournalFormActions } from '@/components/finance/journal-form-card';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { JournalDetail, JournalRow, LedgerAccount, LedgerLine, LedgerSource } from '@/lib/finance/ledger';
import {
  type EntryFilter,
  type LedgerEntry,
  SOURCE_LABELS,
  SOURCE_PATHS,
  accountFromParam,
  entriesCsv,
  filterEntries,
  groupEntries,
  journalActions,
  toolbarError,
} from '@/lib/finance/ledger-views';
import type { FinResult } from '@/lib/finance/result';
import { displayDate, round2, sum } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type JournalActions = JournalFormActions & {
  post: (input: unknown) => Promise<FinResult<{ id: string; journal_no: string }>>;
  /** Makes the draft that undoes a posted journal, dated `reversal_date`. */
  reverse: (input: unknown) => Promise<FinResult<{ id: string; reversal_id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Reads one draft with its lines, for the Edit form. */
  get: (input: unknown) => Promise<FinResult<JournalDetail>>;
};

/** What only an owner or admin is given: the actions. A member reads the ledger, filters it and exports it. */
export type JournalsWriter = { actions: JournalActions };

/** Entries put on screen at a time; "Show more" adds another lot. */
export const ENTRIES_PAGE_SIZE = 50;

/** The screen each automatic entry comes from, for "Open in …". */
const SOURCE_SCREENS: Record<LedgerSource, string> = {
  invoice: 'Invoices',
  credit_note: 'Credit Notes',
  payment_in: 'Cash Receipts',
  refund: 'Refunds',
  bill: 'Supplier Bills',
  payment_out: 'Payment Vouchers',
  expense: 'Expenses',
  transfer: 'Banking',
  opening: 'Banking',
  journal: 'Journals',
};

const ALL_SOURCES = Object.keys(SOURCE_LABELS) as LedgerSource[];

/** One thing open at a time: a form card, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  /** `detail` is null while the draft's lines are being read. */
  | { kind: 'edit'; draft: JournalRow; detail: JournalDetail | null; today: string }
  | { kind: 'post'; draft: JournalRow }
  | { kind: 'delete'; draft: JournalRow }
  | { kind: 'reverse'; journal: JournalRow }
  /** The draft that undoes `journal` has just been made, dated `date`. */
  | { kind: 'reversed'; journal: JournalRow; date: string }
  | null;

const draftName = (d: JournalRow) => `${d.description} of ${displayDate(d.journal_date)}`;

/**
 * Journals: every line the books hold, grouped into entries, with search, source, date and account filters and
 * Export for everybody. An owner or admin (`writer`) also gets New journal, the drafts with Edit, Post and
 * Delete, and Reverse on a posted manual journal. `journals` is read only for them.
 */
export function JournalsView({
  lines,
  accounts,
  journals = [],
  writer,
}: {
  lines: LedgerLine[];
  accounts: LedgerAccount[];
  journals?: JournalRow[];
  writer?: JournalsWriter;
}) {
  // A link such as /finance/journals?account=<id> (from Chart of Accounts) opens filtered to that account.
  const accountParam = useSearchParams()?.get('account') ?? null;
  const [filter, setFilterState] = useState<EntryFilter>(() => ({
    query: '',
    source: 'all',
    from: '',
    to: '',
    account: accountFromParam(accountParam, accounts),
  }));
  // The account filter follows the address: when the address changes (the nav's "Journals" link drops the
  // parameter, a Chart of Accounts link sets it) the filter is set to match. Adjusted while rendering, not in an
  // effect, so there is no flash of the old filter. A choice in the picker is left alone until the address changes.
  const [seenParam, setSeenParam] = useState(accountParam);
  if (seenParam !== accountParam) {
    setSeenParam(accountParam);
    setFilterState((f) => ({ ...f, account: accountFromParam(accountParam, accounts) }));
  }
  const [pageSize, setPageSize] = useState(ENTRIES_PAGE_SIZE);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();
  const loader = useFinanceAction('read');

  const setFilter = (next: Partial<EntryFilter>) => {
    setFilterState((f) => ({ ...f, ...next }));
    setPageSize(ENTRIES_PAGE_SIZE);
  };

  const entries = useMemo(() => groupEntries(lines, accounts), [lines, accounts]);
  // The filters apply to every entry, not only the ones on screen.
  const matching = useMemo(() => filterEntries(entries, filter), [entries, filter]);
  const shown = matching.slice(0, pageSize);
  const debit = sum(matching, (e) => e.debit);
  const credit = sum(matching, (e) => e.credit);
  const journalById = new Map(journals.map((j) => [j.id, j]));
  const drafts = journals.filter((j) => j.status === 'draft');
  const sorted = [...accounts].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));

  const formOpen = open?.kind === 'new' || open?.kind === 'edit';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const questionInView =
    open?.kind === 'post' || open?.kind === 'delete'
      ? Boolean(writer) && drafts.some((d) => d.id === open.draft.id)
      : open?.kind === 'reverse'
        ? shown.some((e) => e.source === 'journal' && e.source_id === open.journal.id)
        : false;
  const questionOpen = open?.kind === 'post' || open?.kind === 'delete' || open?.kind === 'reverse';
  const tableError = toolbarError(confirm.error, questionOpen, questionInView);
  const locked = confirm.pending || formOpen;
  const now = () => localIsoDate(new Date());
  const ask = (next: Exclude<Open, null>) => {
    confirm.clear();
    setOpen(next);
  };
  const close = () => {
    confirm.clear();
    setOpen(null);
  };

  const draftMenu = (draft: JournalRow, w: JournalsWriter): RowMenuItem[] =>
    journalActions(draft, true).flatMap((action): RowMenuItem[] => {
      switch (action) {
        case 'edit':
          return [
            {
              label: 'Edit',
              icon: Pencil,
              opens: true,
              onSelect: () => {
                loader.clear();
                ask({ kind: 'edit', draft, detail: null, today: now() });
                loader.run(
                  () => w.actions.get({ id: draft.id }),
                  // Still waiting on this draft? Something else may have been opened meanwhile.
                  (detail) => setOpen((cur) => (cur?.kind === 'edit' && cur.draft.id === draft.id ? { ...cur, detail } : cur)),
                );
              },
            },
          ];
        case 'post':
          return [{ label: 'Post', icon: Send, opens: true, onSelect: () => ask({ kind: 'post', draft }) }];
        case 'delete':
          return [{ label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', draft }) }];
        default:
          return [];
      }
    });

  const draftQuestion = (draft: JournalRow, w: JournalsWriter) => {
    if (!open || (open.kind !== 'post' && open.kind !== 'delete') || open.draft.id !== draft.id) return null;
    const shared = { colSpan: 4, pending: confirm.pending, error: confirm.error, onCancel: close };
    return open.kind === 'post' ? (
      <ConfirmRow
        key={draft.id}
        {...shared}
        tone="default"
        icon={Send}
        label={`Post ${draftName(draft)}`}
        confirmLabel="Post journal"
        pendingLabel="Posting…"
        onConfirm={() => confirm.run(() => w.actions.post({ id: draft.id }), close)}
      >
        Post <span className="font-medium">{draft.description}</span>? It gets its number and enters the books, and cannot be
        edited afterwards; a posted journal is undone by reversing it.
      </ConfirmRow>
    ) : (
      <ConfirmRow
        key={draft.id}
        {...shared}
        label={`Delete ${draftName(draft)}`}
        confirmLabel="Delete draft"
        pendingLabel="Deleting…"
        onConfirm={() => confirm.run(() => w.actions.remove({ id: draft.id }), close)}
      >
        Delete the draft <span className="font-medium">{draft.description}</span>? This cannot be undone.
      </ConfirmRow>
    );
  };

  /** Reversing dates the new draft the person's own today (the database's is UTC, a day behind until 08:00 in Malaysia). */
  const reverse = (journal: JournalRow, w: JournalsWriter) => {
    const date = now();
    confirm.run(
      () => w.actions.reverse({ id: journal.id, reversal_date: date }),
      // The note at the top of the page says where the reversal is.
      () => setOpen({ kind: 'reversed', journal, date }),
    );
  };

  const loading = (title: string) => (
    <BentoCard title={title} subtitle="Reading the draft" icon={BookOpen} className="col-span-2 md:col-span-12">
      <div className="flex flex-wrap items-center gap-3">
        {loader.error ? (
          <p role="alert" className="text-sm text-destructive">
            {loader.error}
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        )}
        <Button type="button" variant="outline" size="sm" onClick={close} autoFocus data-finance-focus>
          {loader.error ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </BentoCard>
  );

  const card = () => {
    if (!writer || !open) return null;
    if (open.kind === 'new') {
      return <JournalFormCard key={open.nonce} accounts={accounts} today={open.today} actions={writer.actions} onClose={close} />;
    }
    if (open.kind === 'edit') {
      return open.detail ? (
        <JournalFormCard key={open.detail.id} editing={open.detail} accounts={accounts} today={open.today} actions={writer.actions} onClose={close} />
      ) : (
        loading('Edit journal')
      );
    }
    if (open.kind === 'reversed') {
      return (
        <SavedNoteCard
          title="Reversal made"
          subtitle={`Undoes ${open.journal.journal_no ?? 'the journal'}`}
          onClose={close}
        >
          The reversal is a draft dated {displayDate(open.date)}, in Draft journals below. Check it, then post it to put the
          reversal in the books.
        </SavedNoteCard>
      );
    }
    return null;
  };

  const entryBlock = (entry: LedgerEntry) => {
    const journal = entry.source === 'journal' ? journalById.get(entry.source_id) : undefined;
    const canReverse = writer && journal ? journalActions(journal, true).includes('reverse') : false;
    const asking = writer && journal && open?.kind === 'reverse' && open.journal.id === journal.id;
    const path = SOURCE_PATHS[entry.source];
    return (
      <section key={entry.key} aria-label={`${entry.source_no ?? 'Entry'} ${entry.description}`} className="rounded-lg border">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-2 text-sm">
          <span className="whitespace-nowrap text-muted-foreground">{displayDate(entry.date)}</span>
          <span className="whitespace-nowrap font-medium">{entry.source_no ?? '—'}</span>
          <Badge variant="secondary">{SOURCE_LABELS[entry.source]}</Badge>
          <span className="min-w-40 flex-1">{entry.description}</span>
          {path ? (
            <Link href={path} className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-primary underline-offset-4 hover:underline">
              Open in {SOURCE_SCREENS[entry.source]}
              <ExternalLink className="size-3" aria-hidden />
            </Link>
          ) : null}
          {canReverse && journal ? (
            <span inert={locked} className={cn(locked && 'opacity-50')}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Reverse ${journal.journal_no ?? 'journal'}`}
                onClick={() => ask({ kind: 'reverse', journal })}
              >
                <Undo2 className="size-4" />
                Reverse
              </Button>
            </span>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entry.lines.map((l, i) => (
                <TableRow key={`${l.entry_key}-${i}`}>
                  <TableCell className={cn('whitespace-nowrap', l.debit === 0 && 'pl-8')}>
                    {l.account_code ? (
                      <>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">{l.account_code}</span> {l.account_name}
                      </>
                    ) : (
                      <span className="text-muted-foreground">Unknown account</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">{l.debit > 0 ? rm(l.debit) : ''}</TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">{l.credit > 0 ? rm(l.credit) : ''}</TableCell>
                </TableRow>
              ))}
              {asking && writer && journal ? (
                <ConfirmRow
                  colSpan={3}
                  tone="default"
                  icon={Undo2}
                  label={`Reverse ${journal.journal_no ?? 'journal'}`}
                  confirmLabel="Reverse journal"
                  pendingLabel="Reversing…"
                  pending={confirm.pending}
                  error={confirm.error}
                  onConfirm={() => reverse(journal, writer)}
                  onCancel={close}
                >
                  Reverse <span className="font-medium">{journal.journal_no}</span>? This makes a draft dated today with the debits and
                  credits swapped. It reaches the books when you post it, and a journal can be reversed once.
                </ConfirmRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </section>
    );
  };

  const balanced = round2(debit - credit) === 0;

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Journals"
        subtitle="General ledger entries, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New journal
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {card()}

        <BentoCard tone="primary" className="col-span-1 md:col-span-4">
          <BentoStat label="Entries shown" value={String(matching.length)} delta={`of ${entries.length}`} deltaTone="flat" onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat label="Total debits" value={rm(debit)} />
        </BentoCard>
        <BentoCard
          className="col-span-2 md:col-span-4"
        >
          <BentoStat
            label="Total credits"
            value={rm(credit)}
            delta={
              balanced ? (
                <span className="inline-flex items-center gap-1">
                  <CircleCheck className="size-3" aria-hidden />
                  equal
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <TriangleAlert className="size-3" aria-hidden />
                  Out of balance by {rm(Math.abs(round2(debit - credit)))}
                </span>
              )
            }
            deltaTone={balanced ? 'flat' : 'down'}
          />
        </BentoCard>

        {writer && drafts.length > 0 ? (
          <BentoCard
            title="Draft journals"
            subtitle="Not in the books until posted"
            icon={ClipboardList}
            flush
            className="col-span-2 md:col-span-12"
          >
            {loader.error && open?.kind !== 'edit' ? (
              <p role="alert" className="px-4 pb-2 text-sm text-destructive">
                {loader.error}
              </p>
            ) : null}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drafts.map((d) => {
                    const asked = draftQuestion(d, writer);
                    if (asked) return asked;
                    return (
                      <TableRow key={d.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(d.journal_date)}</TableCell>
                        <TableCell className="font-medium">{d.description}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">Draft</Badge>
                        </TableCell>
                        <TableCell>
                          {/* RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open. */}
                          <span inert={locked} className={cn(locked && 'opacity-50')}>
                            <RowMenu label={draftName(d)} items={draftMenu(d, writer)} />
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </BentoCard>
        ) : null}

        <BentoCard
          title="Ledger"
          subtitle="Every entry in the books, newest first"
          icon={BookOpen}
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search the ledger by number, description or account"
                placeholder="Search entries…"
                className="pl-8"
                value={filter.query}
                onChange={(e) => setFilter({ query: e.target.value })}
              />
            </div>
            <Select value={filter.source} onValueChange={(v) => setFilter({ source: v as EntryFilter['source'] })}>
              <SelectTrigger className="w-44" aria-label="Source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {ALL_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filter.account || 'all'} onValueChange={(v) => setFilter({ account: v === 'all' ? '' : v })}>
              <SelectTrigger className="w-56" aria-label="Account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {sorted.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              aria-label="From date"
              className="w-40"
              value={filter.from}
              max={filter.to || undefined}
              onChange={(e) => setFilter({ from: e.target.value })}
            />
            <Input
              type="date"
              aria-label="To date"
              className="w-40"
              value={filter.to}
              min={filter.from || undefined}
              onChange={(e) => setFilter({ to: e.target.value })}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('journals', now()), entriesCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
            {tableError ? (
              <p role="alert" className="text-sm text-destructive">
                {tableError}
              </p>
            ) : null}
          </div>

          <div className="mt-3 space-y-3">
            {shown.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {entries.length === 0 ? 'No ledger entries yet.' : 'No matches. Try a different search or filter.'}
              </p>
            ) : (
              shown.map(entryBlock)
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3 text-sm text-muted-foreground">
            <span>
              Showing {shown.length} of {matching.length} entries
              {matching.length !== entries.length ? ` (${entries.length} in all)` : ''}
            </span>
            {matching.length > shown.length ? (
              <Button variant="outline" size="sm" onClick={() => setPageSize((n) => n + ENTRIES_PAGE_SIZE)}>
                Show more
              </Button>
            ) : null}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
