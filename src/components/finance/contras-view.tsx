'use client';

import { useState } from 'react';
import { ArrowLeftRight, Ban, Download, Pencil, Plus, Search, Send, Trash2 } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { ContraFormCard, type ContraFormActions } from '@/components/finance/contra-form-card';
import { downloadCsv } from '@/components/finance/download-csv';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { useFinanceAction } from '@/components/finance/use-finance-action';
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
import {
  CONTRA_STATUS_LABELS,
  type ContraFilter,
  type ContraParty,
  type WrittenContra,
  contraDeleteQuestion,
  contraDocuments,
  contraHiddenNote,
  contraAnswerIsStale,
  contraName,
  contraPostQuestion,
  contraStats,
  contraVoidQuestion,
  contrasCsv,
  filterContras,
  newContraParties,
} from '@/lib/finance/contra-form';
import { type ContraAction, type ContraRow, type ContraStatus, contraActions } from '@/lib/finance/contras';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { FinResult } from '@/lib/finance/result';
import { displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type ContraActions = ContraFormActions & {
  post: (input: unknown) => Promise<FinResult<{ id: string; contra_no: string }>>;
  voidContra: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What only an owner or admin is given: the actions, and the contacts with what the form can set off. */
export type ContrasWriter = { actions: ContraActions; parties: ContraParty[] };

/** Said under the header to a member: they read every contra entry, and are told who records them. */
export const CONTRA_MEMBER_NOTE = 'Only an owner or admin can record contra entries.';

const WRITTEN_TITLES: Record<ContraStatus, string> = {
  draft: 'Contra entry saved',
  posted: 'Contra entry posted',
  void: 'Contra entry voided',
};

const STATUS_STYLES: Record<ContraStatus, string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

/** One thing open at a time: the form (new, or a draft), or a question in one row. */
type Open =
  | { kind: 'form'; today: string; draft?: ContraRow; nonce: number }
  | { kind: Exclude<ContraAction, 'edit'>; row: ContraRow }
  | null;

/**
 * Contra Entries: every contra entry of the workspace, newest first, with search, a status filter and Export for
 * everybody. An owner or admin (`writer`) also gets New contra entry, and in each row's menu what its status allows
 * (`contraActions`): Edit, Post and Delete on a draft, Void on a posted one. A member is told who records them
 * (`memberNote`); a viewer and the demo workspace only read.
 */
export function ContrasView({
  rows,
  today: serverToday,
  followClock = true,
  writer,
  memberNote = false,
  initialAsk,
}: {
  rows: ContraRow[];
  /** The date the figures are worked out for, YYYY-MM-DD, until the browser's own date takes over. */
  today: string;
  /** False for sample data, which keeps its own fixed date. */
  followClock?: boolean;
  writer?: ContrasWriter;
  /** True for a member: the line under the header says who records contra entries. */
  memberNote?: boolean;
  /** Opens a question on a row, or (`edit`) the form on a draft, at the start. Only for tests, which cannot press a menu item. */
  initialAsk?: { kind: ContraAction; id: string };
}) {
  const today = useLocalToday(serverToday, followClock);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ContraFilter>('all');
  const [open, setOpen] = useState<Open>(() => {
    const row = initialAsk ? rows.find((r) => r.id === initialAsk.id) : undefined;
    if (!initialAsk || !row) return null;
    return initialAsk.kind === 'edit' ? { kind: 'form', today: serverToday, draft: row, nonce: 0 } : { kind: initialAsk.kind, row };
  });
  // The contra entry just written; whether to say anything about it is decided at render, from the rows listed now.
  const [written, setWritten] = useState<WrittenContra | null>(null);
  const confirm = useFinanceAction();

  const matching = filterContras(rows, query, filter);
  const stats = contraStats(rows, today);
  const hiddenNote = written ? contraHiddenNote(written, filter, matching.some((r) => r.id === written.id)) : null;
  const asking = open && open.kind !== 'form' ? open : null;
  const askingInView = asking ? matching.some((r) => r.id === asking.row.id) : false;
  // The form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const locked = confirm.pending || open?.kind === 'form';
  const columns = writer ? 8 : 7;

  const ask = (next: Exclude<Open, null>) => {
    confirm.clear();
    setWritten(null);
    setOpen(next);
  };
  /** Forgets an earlier write when the list changes under a note that is not showing, so a note never turns up later by itself. */
  const listChanged = () => {
    if (!hiddenNote) setWritten(null);
  };
  const close = () => {
    confirm.clear();
    setOpen(null);
  };
  const closeSaying = (contra?: WrittenContra) => {
    close();
    setWritten(contra ?? null);
  };
  const after = (row: ContraRow, status: ContraStatus): WrittenContra => ({ id: row.id, status, contact: row.contact_name, amount: row.amount });

  /**
   * Runs a write on the contra entry as the row shows it now. If it was posted, voided or deleted since, the question
   * closes and the refreshed row (or its absence) says what it holds; the sentence stays above the table.
   */
  const settle = <T,>(call: () => Promise<FinResult<T>>, done: () => void) =>
    confirm.run(async () => {
      const result = await call();
      if (!result.ok && contraAnswerIsStale(result.error)) setOpen(null);
      return result;
    }, done);

  const menuItem = (row: ContraRow, action: ContraAction): RowMenuItem => {
    switch (action) {
      case 'edit':
        return {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => ask({ kind: 'form', today: localIsoDate(new Date()), draft: row, nonce: Date.now() }),
        };
      case 'post':
        return { label: 'Post', icon: Send, opens: true, onSelect: () => ask({ kind: 'post', row }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', row }) };
      case 'void':
        return { label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', row }) };
    }
  };

  const question = (row: ContraRow) => {
    if (!writer || !asking || asking.row.id !== row.id) return null;
    const { actions } = writer;
    const shared = { colSpan: columns, pending: confirm.pending, error: confirm.error, onCancel: close };
    if (asking.kind === 'post') {
      return (
        <ConfirmRow
          key={row.id}
          {...shared}
          tone="default"
          icon={Send}
          label={`Post ${contraName(row)}`}
          confirmLabel="Post contra entry"
          pendingLabel="Posting…"
          onConfirm={() => settle(() => actions.post({ id: row.id }), () => closeSaying(after(row, 'posted')))}
        >
          {contraPostQuestion(row)}
        </ConfirmRow>
      );
    }
    if (asking.kind === 'void') {
      return (
        <ConfirmRow
          key={row.id}
          {...shared}
          icon={Ban}
          label={`Void ${contraName(row)}`}
          confirmLabel="Void contra entry"
          pendingLabel="Voiding…"
          onConfirm={() => settle(() => actions.voidContra({ id: row.id }), () => closeSaying(after(row, 'void')))}
        >
          {contraVoidQuestion(row)}
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={row.id}
        {...shared}
        label={`Delete ${contraName(row)}`}
        confirmLabel="Delete draft"
        pendingLabel="Deleting…"
        onConfirm={() => settle(() => actions.remove({ id: row.id }), close)}
      >
        {contraDeleteQuestion(row)}
      </ConfirmRow>
    );
  };

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Contra Entries"
        subtitle={
          memberNote
            ? `What contacts owe you set against what you owe them, Saudara. ${CONTRA_MEMBER_NOTE}`
            : 'What contacts owe you set against what you owe them, Saudara.'
        }
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'form' && !open.draft}
              disabled={locked}
              onClick={() => ask({ kind: 'form', today: localIsoDate(new Date()), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New contra entry
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {writer && open?.kind === 'form' ? (
          <ContraFormCard
            // A different draft, or a new contra entry after one, starts the card again.
            key={open.draft?.id ?? `new-${open.nonce}`}
            editing={open.draft}
            // A draft's Edit form also offers that draft's contact; the New form only contacts with something to set off.
            parties={open.draft ? writer.parties : newContraParties(writer.parties)}
            today={open.today}
            actions={writer.actions}
            onClose={closeSaying}
          />
        ) : null}
        {written && hiddenNote ? (
          <SavedNoteCard title={WRITTEN_TITLES[written.status]} subtitle="It is not in the list below" onClose={() => setWritten(null)}>
            {hiddenNote}
          </SavedNoteCard>
        ) : null}

        <BentoCard tone="primary" className="col-span-1 md:col-span-4">
          <BentoStat label="Posted this month" value={String(stats.postedThisMonth)} delta={`${stats.postedInAll} posted in all`} deltaTone="flat" onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat label="Set off this month" value={rm(stats.setOffThisMonth)} />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-4">
          <BentoStat label="Drafts" value={String(stats.drafts)} delta="not set off until posted" deltaTone="flat" />
        </BentoCard>

        <BentoCard
          title="Contra entries"
          subtitle="Each sets a contact's invoices off against their bills; no money moves"
          icon={ArrowLeftRight}
          flush
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2 px-4">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search contra entries by number, contact, reference, invoice or bill"
                placeholder="Search contacts, numbers or documents…"
                className="pl-8"
                value={query}
                onChange={(e) => {
                  listChanged();
                  setQuery(e.target.value);
                }}
              />
            </div>
            <Select
              value={filter}
              onValueChange={(v) => {
                listChanged();
                setFilter(v as ContraFilter);
              }}
            >
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="posted">Posted</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('contra-entries', localIsoDate(new Date())), contrasCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
            {/* The question's own message shows in its row; here when its row is out of view or the question has closed. */}
            {confirm.error && !(asking && askingInView) ? (
              <p role="alert" className="text-sm text-destructive">
                {confirm.error}
              </p>
            ) : null}
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Date</TableHead>
                  <TableHead>No.</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Invoices</TableHead>
                  <TableHead>Bills</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  {writer ? (
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {matching.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                        {writer ? 'No contra entries yet. Record one with New contra entry.' : 'No contra entries yet.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {matching.map((row) => {
                  const asked = question(row);
                  if (asked) return asked;
                  const items = writer ? contraActions(row.status, true).map((action) => menuItem(row, action)) : [];
                  return (
                    <TableRow key={row.id} className={cn(row.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(row.contra_date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{row.contra_no ?? '—'}</TableCell>
                      {/* A long name, reference or list of documents wraps; it is never cut off behind a tooltip. */}
                      <TableCell className="min-w-28 max-w-64 whitespace-normal break-words">
                        {row.contact_name || '—'}
                        {row.reference ? <span className="block text-xs text-muted-foreground">{row.reference}</span> : null}
                      </TableCell>
                      <TableCell className="min-w-24 max-w-56 whitespace-normal break-words text-muted-foreground">
                        {contraDocuments(row.invoices) || '—'}
                      </TableCell>
                      <TableCell className="min-w-24 max-w-56 whitespace-normal break-words text-muted-foreground">
                        {contraDocuments(row.bills) || '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(row.amount)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={row.status === 'posted'} />
                          <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold', STATUS_STYLES[row.status])}>
                            {CONTRA_STATUS_LABELS[row.status]}
                          </span>
                        </span>
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or the form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={contraName(row)} items={items} />
                            </span>
                          ) : null}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {matching.length} of {rows.length} contra {rows.length === 1 ? 'entry' : 'entries'}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
