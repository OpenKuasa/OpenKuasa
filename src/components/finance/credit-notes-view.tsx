'use client';

import { useState } from 'react';
import { Ban, Download, FileCheck, FileText, Pencil, PieChart, Plus, Search, Trash2, TrendingUp, Undo2 } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { CreditNoteFormCard, type CreditNoteFormActions } from '@/components/finance/credit-note-form-card';
import { downloadCsv } from '@/components/finance/download-csv';
import { RefundFormCard, type RecordRefund } from '@/components/finance/refund-form-card';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { useFinanceAction } from '@/components/finance/use-finance-action';
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
import { money, rm } from '@/lib/finance/format';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { FinanceAccount } from '@/lib/finance/money';
import { type RefundSaved, noteTargetKey, refundSavedNote, refundTargets } from '@/lib/finance/refund-form';
import type { RefundRow } from '@/lib/finance/refunds';
import type { FinResult } from '@/lib/finance/result';
import type { FxRateLookup } from '@/components/finance/movement-rate-fields';
import {
  CREDIT_NOTE_STATUS_LABELS,
  type CreditNoteAction,
  type CreditNoteFilter,
  type CreditNotesViewData,
  creditNoteActions,
  creditNoteName,
  creditNotesCsv,
  filterCreditNotes,
  refundedOnNote,
} from '@/lib/finance/sales-followon-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type CreditNoteActions = CreditNoteFormActions & {
  issue: (input: unknown) => Promise<FinResult<{ id: string; credit_note_no: string }>>;
  voidNote: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Records a refund against a credit note, from its row. */
  recordRefund: RecordRefund;
  /** Bank Negara's selling rate, for a refund from an account in another currency (stage 5b). */
  fxRate?: FxRateLookup;
};

/** What only a person who may edit is given: the actions, and what the two forms offer. */
export type CreditNotesWriter = {
  actions: CreditNoteActions;
  /** Every invoice, to find the ones that can take a credit note and the ones whose customer is in credit. */
  invoices: InvoiceListRow[];
  /** Every refund, to know what refunds that are pending already hold. */
  refunds: RefundRow[];
  accounts: FinanceAccount[];
};

const CREDITED_SERIES: Series[] = [{ key: 'credited', label: 'Credited (RM k)', color: 'var(--chart-3)' }];

const STATUS_STYLES: Record<CreditNoteStatus, string> = {
  issued: 'bg-emerald-500/15 text-emerald-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

/** A draft or a void credit note has refunded nothing: a dash, as a draft's number is. */
const formatRefunded = (amount: number | null, currency = 'MYR') => (amount === null ? '—' : money(amount, currency));

/** A question asked in a credit note's own row. `edit` and `refund` are not questions: they open a form card. */
type Question = Exclude<CreditNoteAction, 'edit' | 'refund'>;

/** One thing open at a time: a form card, the note that a refund was recorded, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  | { kind: 'edit'; note: CreditNoteRow; today: string }
  | { kind: 'refund'; note: CreditNoteRow; today: string }
  /** A refund has just been recorded from a credit note's row: what the form recorded, not the row. */
  | { kind: 'refunded'; saved: RefundSaved }
  | { kind: Question; note: CreditNoteRow }
  | null;

/**
 * Credit Notes: figures, charts and the table, with search, a status filter,
 * "View all" and Export for everybody. A person who may edit (`writer`) also
 * gets New Credit Note and a menu on each row that offers what its status
 * allows.
 */
export function CreditNotesView({
  rows,
  view,
  writer,
}: {
  /** Every credit note, newest first; drafts and void ones included. */
  rows: CreditNoteRow[];
  view: CreditNotesViewData;
  writer?: CreditNotesWriter;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CreditNoteFilter>('open');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();

  const matching = filterCreditNotes(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 9 : 8;
  const targets = writer ? refundTargets(writer.invoices, rows, writer.refunds) : [];
  const asking = open && (open.kind === 'issue' || open.kind === 'void' || open.kind === 'delete') ? open : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen = open?.kind === 'new' || open?.kind === 'edit' || open?.kind === 'refund';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((n) => n.id === asking.note.id) : false;
  const locked = confirm.pending || formOpen;
  const now = () => localIsoDate(new Date());
  /** Opens one thing, dropping whatever message the last question left behind. */
  const ask = (next: Exclude<Open, null>) => {
    confirm.clear();
    setOpen(next);
  };
  /** Closes whatever is open, and the message that went with it. */
  const close = () => {
    confirm.clear();
    setOpen(null);
  };

  const menuItem = (note: CreditNoteRow, action: CreditNoteAction): RowMenuItem => {
    switch (action) {
      case 'edit':
        return { label: 'Edit', icon: Pencil, opens: true, onSelect: () => ask({ kind: 'edit', note, today: now() }) };
      case 'issue':
        return { label: 'Issue', icon: FileCheck, opens: true, onSelect: () => ask({ kind: 'issue', note }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', note }) };
      case 'refund':
        return { label: 'Refund', icon: Undo2, opens: true, onSelect: () => ask({ kind: 'refund', note, today: now() }) };
      case 'void':
        return { label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', note }) };
    }
  };

  const menu = (note: CreditNoteRow): RowMenuItem[] =>
    creditNoteActions(
      note,
      targets.some((t) => t.key === noteTargetKey(note.id)),
    ).map((action) => menuItem(note, action));

  const question = (note: CreditNoteRow) => {
    if (!writer || !asking || asking.note.id !== note.id) return null;
    const { actions } = writer;
    const id = { id: note.id };
    const name = creditNoteName(note);
    const who = <span className="font-medium">{note.customer_name}</span>;
    const invoice = <span className="font-medium">{note.invoice_no ?? 'its invoice'}</span>;
    const amount = <span className="font-medium">{money(note.amount, note.currency)}</span>;
    const shared = { colSpan: columns, pending: confirm.pending, error: confirm.error, onCancel: close };
    switch (asking.kind) {
      case 'issue':
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            tone="default"
            icon={FileCheck}
            label={`Issue ${name}`}
            confirmLabel="Issue"
            pendingLabel="Issuing…"
            onConfirm={() => confirm.run(() => actions.issue(id), close)}
          >
            Issue this credit note of {amount} to {who}? It gets its number, and {invoice} owes that much less from
            then on; if that is more than is still owed, the customer is in credit and can be refunded. After this it
            can no longer be edited or deleted, only voided.
          </ConfirmRow>
        );
      case 'void':
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            icon={Ban}
            label={`Void ${name}`}
            confirmLabel="Void credit note"
            pendingLabel="Voiding…"
            onConfirm={() => confirm.run(() => actions.voidNote(id), close)}
          >
            Void <span className="font-medium">{note.credit_note_no}</span> of {amount} to {who}? After this, {invoice}{' '}
            owes that amount again. It stays in the list as Void, and this cannot be undone. A credit note cannot be voided
            while a refund depends on it: void or delete that refund on Refunds first.
          </ConfirmRow>
        );
      case 'delete':
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            label={`Delete ${name}`}
            confirmLabel="Delete draft"
            pendingLabel="Deleting…"
            onConfirm={() => confirm.run(() => actions.remove(id), close)}
          >
            Delete the draft credit note of {amount} against {invoice} to {who}? This cannot be undone.
          </ConfirmRow>
        );
    }
  };

  const card = () => {
    if (!writer || !open) return null;
    const { actions } = writer;
    if (open.kind === 'new') {
      return <CreditNoteFormCard key={open.nonce} invoices={writer.invoices} today={open.today} actions={actions} onClose={close} />;
    }
    if (open.kind === 'edit') {
      return (
        <CreditNoteFormCard
          // A different draft gets a fresh form.
          key={open.note.id}
          editing={open.note}
          invoices={writer.invoices}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      );
    }
    if (open.kind === 'refund') {
      const { note } = open;
      return (
        <RefundFormCard
          key={note.id}
          targets={targets}
          accounts={writer.accounts}
          today={open.today}
          preselect={noteTargetKey(note.id)}
          record={actions.recordRefund}
          fxRate={actions.fxRate}
          onClose={close}
          // The refund is on Refunds; this row's Refunded figure moves only once it is paid out.
          // The note says what the form recorded: the person may have picked something other than this row.
          onSaved={(saved) => ask({ kind: 'refunded', saved })}
        />
      );
    }
    if (open.kind === 'refunded') {
      const said = refundSavedNote(open.saved);
      return (
        <SavedNoteCard title="Refund recorded" subtitle={said.subtitle} href="/finance/refunds" linkLabel="Refunds" onClose={close}>
          {said.lead}
        </SavedNoteCard>
      );
    }
    return null;
  };

  // The question's own message shows in its row; beside the filters only while its row is out of view.
  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Credit Notes"
        subtitle="Credits issued against customer invoices."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New Credit Note
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {card()}

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
              onClick={() => downloadCsv(csvFileName('credit-notes', now()), creditNotesCsv(matching))}
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
                  {writer ? (
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
                        No credit notes yet.{writer ? ' Add the first one with New Credit Note.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((n) => {
                  const asked = question(n);
                  if (asked) return asked;
                  const items = writer ? menu(n) : [];
                  return (
                    <TableRow key={n.id} className={cn(n.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap font-medium">{n.credit_note_no ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(n.credit_date)}</TableCell>
                      <TableCell className="whitespace-nowrap">{n.customer_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{n.invoice_no ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{CREDIT_NOTE_REASON_LABELS[n.reason]}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {(n.currency ?? 'MYR') === 'MYR' ? (
                          rm(n.amount)
                        ) : (
                          // A credit note on an invoice in another currency: its amount, and what it took off in ringgit
                          // once issued (it makes no exchange difference).
                          <>
                            {money(n.amount, n.currency)}
                            {n.amount_myr !== null && n.amount_myr !== undefined ? (
                              <span className="block text-xs text-muted-foreground">≈ {rm(n.amount_myr)}</span>
                            ) : null}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{formatRefunded(refundedOnNote(n), n.currency)}</TableCell>
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
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={creditNoteName(n)} items={items} />
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
            Showing {shown.length} of {matching.length} credit notes
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
