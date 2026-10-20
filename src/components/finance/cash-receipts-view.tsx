'use client';

import { useState } from 'react';
import { Ban, Banknote, Download, FileCheck, Landmark, Pencil, PieChart, Plus, Search, Trash2, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { type CashReceiptFormActions, CashReceiptFormCard } from '@/components/finance/cash-receipt-form-card';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { downloadCsv } from '@/components/finance/download-csv';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLocalToday } from '@/components/finance/use-local-today';
import { localIsoDate } from '@/lib/finance/bill-math';
import { type CashReceiptRow, cashBookCurrency, cashBookRinggit } from '@/lib/finance/cash-book';
import {
  CASH_BOOK_PERIODS,
  CASH_BOOK_PERIOD_LABELS,
  CASH_RECEIPT_STATUS_LABELS,
  type CashBookPeriod,
  type CashReceiptAction,
  cashBookCountLine,
  cashReceiptActions,
  emptyPeriodText,
  inPeriod,
  nothingInPeriod,
  type CashReceiptFilter,
  type WrittenReceipt,
  cashReceiptsCsv,
  cashReceiptsInPeriod,
  cashReceiptsView,
  filterCashReceipts,
  receiptDeleteEffect,
  receiptFor,
  receiptHiddenNote,
  receiptName,
  receiptVoidEffect,
} from '@/lib/finance/cash-book-views';
import type { IncomeCategory } from '@/lib/finance/cash-receipts';
import { csvFileName } from '@/lib/finance/csv';
import { money, rm } from '@/lib/finance/format';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { type FinanceAccount, PAYMENT_METHOD_LABELS, type PaymentInRow } from '@/lib/finance/money';
import type { FinResult } from '@/lib/finance/result';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type CashReceiptActions = CashReceiptFormActions & {
  post: (input: unknown) => Promise<FinResult<{ id: string; number: string }>>;
  voidReceipt: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What only a person who may edit is given: the actions, whether they may sign off, and what the receipt form offers. */
export type CashReceiptsWriter = {
  actions: CashReceiptActions;
  /** True for an owner or admin: they may post a draft and void a posted receipt. */
  canSignOff: boolean;
  /** The invoices that can still take money, and the payment rows that hold part of one without being posted: all the form reads. */
  invoices: InvoiceListRow[];
  payments: PaymentInRow[];
  accounts: FinanceAccount[];
  /** Active contacts, for who paid. */
  contacts: { id: string; name: string }[];
  categories: IncomeCategory[];
};

const RECEIVED_SERIES: Series[] = [
  { key: 'bank', label: 'Bank (RM k)', color: 'var(--chart-1)' },
  { key: 'cash', label: 'Cash (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<CashReceiptRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  draft: 'bg-muted text-muted-foreground',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
  void: 'bg-muted text-muted-foreground line-through',
};

/** One thing open at a time: the receipt form, new or for one draft, or a question in one row. */
type Open =
  | { kind: 'form'; today: string; editing?: CashReceiptRow }
  | { kind: 'post' | 'void' | 'delete'; row: CashReceiptRow }
  | null;

/**
 * Cash Receipts: every movement of money in, one row each. The chosen period
 * sets the figures, the charts and the rows of the table (drafts stay in every
 * period, as the Receipts card counts them), with search, a status filter,
 * "View all" and Export working on top of it; Export gives what the table
 * would show with "View all". A person who may edit (`writer`) also gets New
 * receipt, and Edit and Delete on a draft; an owner or admin also gets Post on
 * a draft and Void on a posted receipt.
 */
export function CashReceiptsView({
  rows,
  today: serverToday,
  followClock = true,
  writer,
}: {
  /** Every receipt, newest first; drafts and void ones included. */
  rows: CashReceiptRow[];
  /** The date the figures are worked out for, YYYY-MM-DD, until the browser's own date takes over. */
  today: string;
  /** False for sample data, which keeps its own fixed date. */
  followClock?: boolean;
  writer?: CashReceiptsWriter;
}) {
  const today = useLocalToday(serverToday, followClock);
  const [period, setPeriod] = useState<CashBookPeriod>('month');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CashReceiptFilter>('open');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  // The receipt just posted or voided; whether to say anything about it is decided at render, from the rows listed now.
  const [written, setWritten] = useState<WrittenReceipt | null>(null);
  const confirm = useFinanceAction();

  const view = cashReceiptsView(rows, today, period);
  const inPeriodRows = cashReceiptsInPeriod(rows, today, period);
  const matching = filterCashReceipts(inPeriodRows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const span = CASH_BOOK_PERIOD_LABELS[period];
  // Rows the table keeps from outside the period (drafts, money still waiting), earlier or later than it.
  const outside = inPeriodRows.filter((row) => !inPeriod(row.txn_date, today, period));
  const countLine = cashBookCountLine({
    noun: 'receipts',
    period,
    workspaceRows: rows.length,
    shown: shown.length,
    matching: matching.length,
    total: inPeriodRows.length,
    keptEarlier: outside.filter((row) => row.txn_date < today).length,
    keptLater: outside.filter((row) => row.txn_date >= today).length,
  });

  const hiddenNote = written
    ? receiptHiddenNote(
        written,
        today,
        period,
        filter,
        matching.some((r) => r.transaction_id === written.id),
        shown.some((r) => r.transaction_id === written.id),
      )
    : null;

  const columns = writer ? 9 : 8;
  const asking = open && open.kind !== 'form' ? open : null;
  // The form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const locked = confirm.pending || open?.kind === 'form';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((r) => r.transaction_id === asking.row.transaction_id) : false;

  /** Opens one thing, dropping whatever message the last question left behind. */
  const ask = (next: Exclude<Open, null>) => {
    confirm.clear();
    setWritten(null);
    setOpen(next);
  };
  /**
   * Forgets an earlier write when the list changes under a note that is not showing, so a note never turns up later
   * by itself. It would take the focus from the filter or the search being used: the Enter that chose a filter then
   * pressed the note's Close as well, and the letters typed next went to that button.
   */
  const listChanged = () => {
    if (!hiddenNote) setWritten(null);
  };
  /** Closes whatever is open, and the message that went with it. */
  const close = () => {
    confirm.clear();
    setOpen(null);
  };

  /** Closes, and keeps the receipt just written so the screen can say when it is not in the list. */
  const closeSaying = (receipt: WrittenReceipt) => {
    close();
    setWritten(receipt);
  };

  const menuItem = (row: CashReceiptRow, action: CashReceiptAction): RowMenuItem => {
    switch (action) {
      case 'edit':
        return {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => ask({ kind: 'form', today: localIsoDate(new Date()), editing: row }),
        };
      case 'post':
        return { label: 'Post', icon: FileCheck, opens: true, onSelect: () => ask({ kind: 'post', row }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', row }) };
      case 'void':
        return { label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', row }) };
    }
  };

  const question = (row: CashReceiptRow) => {
    if (!writer || !asking || asking.row.transaction_id !== row.transaction_id) return null;
    const { actions } = writer;
    const from = row.party_name ? (
      <>
        {' '}
        from <span className="font-medium">{row.party_name}</span>
      </>
    ) : null;
    if (asking.kind === 'post') {
      return (
        <ConfirmRow
          key={row.transaction_id}
          colSpan={columns}
          tone="default"
          icon={FileCheck}
          label={`Post ${receiptName(row)}`}
          confirmLabel="Post"
          pendingLabel="Posting…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() =>
            confirm.run(
              () => actions.post({ id: row.transaction_id }),
              (posted) => closeSaying({ id: row.transaction_id, kind: 'posted', number: posted.number, date: row.txn_date }),
            )
          }
          onCancel={close}
        >
          Post this receipt of <span className="font-medium">{money(row.amount, cashBookCurrency(row))}</span>
          {from}, dated {displayDate(row.txn_date)}? It gets its number and can no longer be edited, only voided.
        </ConfirmRow>
      );
    }
    if (asking.kind === 'void') {
      return (
        <ConfirmRow
          key={row.transaction_id}
          colSpan={columns}
          icon={Ban}
          label={`Void ${receiptName(row)}`}
          confirmLabel="Void receipt"
          pendingLabel="Voiding…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() =>
            confirm.run(
              () => actions.voidReceipt({ id: row.transaction_id }),
              () => closeSaying({ id: row.transaction_id, kind: 'voided', number: row.number ?? '—', date: row.txn_date }),
            )
          }
          onCancel={close}
        >
          Void receipt <span className="font-medium">{row.number}</span> of{' '}
          <span className="font-medium">{money(row.amount, cashBookCurrency(row))}</span>
          {from}? {receiptVoidEffect(row)} It stays in the list as Void and keeps its number. This cannot be undone.
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={row.transaction_id}
        colSpan={columns}
        label={`Delete ${receiptName(row)}`}
        confirmLabel="Delete draft"
        pendingLabel="Deleting…"
        pending={confirm.pending}
        error={confirm.error}
        onConfirm={() => confirm.run(() => actions.remove({ id: row.transaction_id }), close)}
        onCancel={close}
      >
        Delete the draft receipt of <span className="font-medium">{money(row.amount, cashBookCurrency(row))}</span>
        {from}? {receiptDeleteEffect(row)}This cannot be undone.
      </ConfirmRow>
    );
  };

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Cash Receipts"
        subtitle="Money received into cash and bank, Saudara."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={period}
              onValueChange={(v) => {
                listChanged();
                setPeriod(v as CashBookPeriod);
              }}
            >
              <SelectTrigger className="w-40" aria-label="Period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CASH_BOOK_PERIODS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {CASH_BOOK_PERIOD_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {writer ? (
              <Button
                size="sm"
                aria-expanded={open?.kind === 'form'}
                disabled={locked}
                onClick={() => ask({ kind: 'form', today: localIsoDate(new Date()) })}
              >
                <Plus className="size-4" />
                New receipt
              </Button>
            ) : null}
          </div>
        }
      />

      <BentoGrid>
        {writer && open?.kind === 'form' ? (
          <CashReceiptFormCard
            // A different draft is a different form.
            key={open.editing?.transaction_id ?? 'new'}
            editing={open.editing}
            invoices={writer.invoices}
            payments={writer.payments}
            accounts={writer.accounts}
            contacts={writer.contacts}
            categories={writer.categories}
            today={open.today}
            canSignOff={writer.canSignOff}
            actions={writer.actions}
            onClose={(posted) => (posted ? closeSaying({ kind: 'posted', ...posted }) : close())}
          />
        ) : null}
        {written && hiddenNote ? (
          <SavedNoteCard
            title={written.kind === 'posted' ? 'Receipt posted' : 'Receipt voided'}
            subtitle="It is not in the list below"
            onClose={() => setWritten(null)}
          >
            {hiddenNote}
          </SavedNoteCard>
        ) : null}

        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Receipts over time" subtitle="Bank and cash · last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={RECEIVED_SERIES} height={240} stacked showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing received in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="By account" subtitle={`Received · ${span.toLowerCase()}`} icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReceived ? (
            <DonutStat data={view.byAccount} height={240} centerValue={view.received} centerLabel="received" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">{nothingInPeriod('received', period)}</p>
          )}
        </BentoCard>

        <BentoCard
          title="Receipts"
          subtitle="Every payment in, against invoices or not"
          icon={Banknote}
          flush
          action={
            matching.length > LATEST_ROWS ? (
              <Button
                variant="outline"
                size="sm"
                aria-pressed={showAll}
                onClick={() => {
                  listChanged();
                  setShowAll((v) => !v);
                }}
              >
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
                aria-label="Search receipts by payer, number, invoice or category"
                placeholder="Search payers, numbers or invoices…"
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
                setFilter(v as CashReceiptFilter);
              }}
            >
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="posted">Posted</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('cash-receipts', localIsoDate(new Date())), cashReceiptsCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
            {/* The question's own message shows in its row; here only while its row is out of view. */}
            {confirm.error && asking && !askingInView ? (
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
                  <TableHead>Received from</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Method</TableHead>
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
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                        {writer
                          ? 'No receipts yet. Record one with New receipt. A payment recorded on Payments In shows here too.'
                          : 'No receipts yet. A payment recorded on Payments In shows here too.'}
                      </TableCell>
                    </TableRow>
                  ) : inPeriodRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                        {emptyPeriodText('receipts', period)}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((r) => {
                  const asked = question(r);
                  if (asked) return asked;
                  const items = writer ? cashReceiptActions(r, writer.canSignOff).map((action) => menuItem(r, action)) : [];
                  return (
                    <TableRow key={r.transaction_id} className={cn(r.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(r.txn_date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{r.number ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.party_name ?? '—'}</TableCell>
                      <TableCell className="max-w-64 truncate text-muted-foreground" title={receiptFor(r)}>{receiptFor(r)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          {r.account_kind === 'cash' ? <Banknote className="size-3.5" /> : <Landmark className="size-3.5" />}
                          {r.account_name}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{PAYMENT_METHOD_LABELS[r.method]}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {money(r.amount, cashBookCurrency(r))}
                        {/* Stage 5b: on an account in another currency, its ringgit under it. */}
                        {cashBookCurrency(r) === 'MYR' ? null : (
                          <span className="block text-xs text-muted-foreground">≈ {rm(cashBookRinggit(r))}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={r.status === 'posted'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[r.status],
                            )}
                          >
                            {CASH_RECEIPT_STATUS_LABELS[r.status]}
                          </span>
                        </span>
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or the form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={receiptName(r)} items={items} />
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
          {countLine ? <div className="border-t px-4 py-3 text-sm text-muted-foreground">{countLine}</div> : null}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
