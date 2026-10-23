'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Ban, Check, CircleCheck, Download, Pencil, PieChart, Plus, Search, Send, Trash2, TrendingUp, Wallet } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { OrderNotes } from '@/components/finance/order-notes';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { useLocalToday } from '@/components/finance/use-local-today';
import { type VoucherFormActions, VoucherFormCard } from '@/components/finance/voucher-form-card';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import type { BillListRow } from '@/lib/finance/bills';
import { type PaymentVoucherKind, type PaymentVoucherRow, cashBookCurrency, cashBookRinggit } from '@/lib/finance/cash-book';
import {
  CASH_BOOK_PERIODS,
  CASH_BOOK_PERIOD_LABELS,
  PAYMENT_VOUCHER_KIND_LABELS,
  PAYMENT_VOUCHER_STATUS_LABELS,
  type CashBookPeriod,
  cashBookCountLine,
  emptyPeriodText,
  inPeriod,
  nothingInPeriod,
  type PaymentVoucherFilter,
  filterPaymentVouchers,
  paymentVouchersCsv,
  paymentVouchersInPeriod,
  paymentVouchersView,
  voucherCategory,
} from '@/lib/finance/cash-book-views';
import { csvFileName } from '@/lib/finance/csv';
import type { ExpenseCategory } from '@/lib/finance/expenses';
import { money, rm } from '@/lib/finance/format';
import type { FinanceAccount, PaymentOutRow } from '@/lib/finance/money';
import type { OrderBilling } from '@/lib/finance/purchase-views';
import type { FinResult } from '@/lib/finance/result';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import {
  type QuestionPart,
  type VoucherAction,
  type WrittenVoucher,
  draftVoucherForm,
  voucherCategoryChoices,
  voucherActions,
  voucherAnswerIsStale,
  voucherControls,
  voucherDecisionPayload,
  voucherHiddenNote,
  voucherKindLink,
  voucherName,
  voucherDetailsLine,
  voucherPaidEffect,
  voucherPayableBills,
  voucherQuestion,
  writtenVoucherTitle,
} from '@/lib/finance/voucher-form';
import { markVoucherPaidInput } from '@/lib/finance/vouchers';
import { cn } from '@/lib/utils';

export type VoucherActions = VoucherFormActions & {
  submit: (input: unknown) => Promise<FinResult<{ id: string }>>;
  approve: (input: unknown) => Promise<FinResult<{ id: string }>>;
  reject: (input: unknown) => Promise<FinResult<{ id: string }>>;
  markPaid: (input: unknown) => Promise<FinResult<{ id: string; number: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  voidVoucher: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What only a person who may edit is given: the actions, whether they may decide, and what the voucher form offers. */
export type VouchersWriter = {
  actions: VoucherActions;
  /** True for an owner or admin: they approve, reject, mark paid and void, and what they save is approved. */
  canDecide: boolean;
  /** Active accounts, contacts and expense categories, for the form. */
  accounts: FinanceAccount[];
  contacts: { id: string; name: string }[];
  categories: ExpenseCategory[];
  /** Every bill, to find the ones a voucher can still pay. */
  bills: BillListRow[];
  /** One row per bill a payment out pays: what each bill has held against it, and the bills of a draft being edited. */
  payments: PaymentOutRow[];
  /** Approved and closed purchase orders, to advise on the bills ticked on the form. */
  orders: OrderBilling[];
  /**
   * By voucher id, the advice about the purchase orders behind the bills a waiting voucher pays
   * (`orderNotesByVoucher`). Empty for someone who may not decide: they are never asked to approve.
   */
  orderNotes: Record<string, string[]>;
};

const PAID_SERIES: Series[] = [{ key: 'paid', label: 'Paid out (RM k)', color: 'var(--chart-1)' }];

const KINDS: PaymentVoucherKind[] = ['bill', 'refund', 'expense', 'other'];

const STATUS_STYLES: Record<PaymentVoucherRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-sky-500/15 text-sky-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-muted text-muted-foreground',
  rejected: 'bg-red-500/15 text-red-600',
  void: 'bg-muted text-muted-foreground line-through',
};

/** One thing open at a time: the voucher form (new, or for the draft of one row), or a question in one row. */
type Open =
  | { kind: 'form'; today: string; draft?: PaymentVoucherRow }
  | { kind: Exclude<VoucherAction, 'edit' | 'markPaid'>; row: PaymentVoucherRow }
  // Marking paid asks the day it was paid, in the question itself.
  | { kind: 'markPaid'; row: PaymentVoucherRow; paidOn: string }
  | null;

/**
 * Payment Vouchers: every movement of money out, one row each. The chosen
 * period sets the figures, the charts and the rows of the table (vouchers
 * waiting for approval or still to be paid stay in every period, as their
 * cards count them), with search, status and kind filters, "View all" and
 * Export working on top of it; Export gives what the table would show with
 * "View all". A person who may edit (`writer`) also gets New voucher (for a
 * category or for a supplier's bills, saved as a draft or sent for approval),
 * Edit and Send for approval on a draft, and
 * Delete on a voucher that is not yet "To be paid", or that is and is of
 * a kind that belongs to this screen; an owner or
 * admin also gets Approve and Reject on one that is waiting, Mark as paid on
 * one of this screen's kinds that is "To be paid", and Void on a paid one of
 * those kinds. Each row's menu
 * holds only what the database will let that person do (`voucherActions`).
 * From "To be paid" on, a payment to a supplier is paid, voided and deleted on Payments Out and a
 * refund on Refunds, and each such row links there.
 */
export function PaymentVouchersView({
  rows,
  today: serverToday,
  followClock = true,
  writer,
  initialAsk,
}: {
  /** Every voucher, newest first; waiting, rejected and void ones included. */
  rows: PaymentVoucherRow[];
  /** The date the figures are worked out for, YYYY-MM-DD, until the browser's own date takes over. */
  today: string;
  /** False for sample data, which keeps its own fixed date. */
  followClock?: boolean;
  writer?: VouchersWriter;
  /** Opens a question on a row, or (`edit`) the form on a draft, at the start. Only for tests, which cannot press a menu item. */
  initialAsk?: { kind: VoucherAction; id: string };
}) {
  const today = useLocalToday(serverToday, followClock);
  const [period, setPeriod] = useState<CashBookPeriod>('month');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PaymentVoucherFilter>('open');
  const [kind, setKind] = useState<'all' | PaymentVoucherKind>('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(() => {
    const row = initialAsk ? rows.find((v) => v.transaction_id === initialAsk.id) : undefined;
    if (!initialAsk || !row) return null;
    if (initialAsk.kind === 'edit') return { kind: 'form', today: serverToday, draft: row };
    return initialAsk.kind === 'markPaid' ? { kind: 'markPaid', row, paidOn: serverToday } : { kind: initialAsk.kind, row };
  });
  // The voucher just recorded, approved, rejected, marked paid or voided; whether to say anything about it is decided at render, from the rows listed now.
  const [written, setWritten] = useState<WrittenVoucher | null>(null);
  const confirm = useFinanceAction();

  const view = paymentVouchersView(rows, today, period);
  const inPeriodRows = paymentVouchersInPeriod(rows, today, period);
  const matching = filterPaymentVouchers(inPeriodRows, query, filter, kind);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const span = CASH_BOOK_PERIOD_LABELS[period];
  // Rows the table keeps from outside the period (drafts, money still waiting), earlier or later than it.
  const outside = inPeriodRows.filter((row) => !inPeriod(row.txn_date, today, period));
  const countLine = cashBookCountLine({
    noun: 'vouchers',
    period,
    workspaceRows: rows.length,
    shown: shown.length,
    matching: matching.length,
    total: inPeriodRows.length,
    keptEarlier: outside.filter((row) => row.txn_date < today).length,
    keptLater: outside.filter((row) => row.txn_date >= today).length,
  });

  const hiddenNote = written
    ? voucherHiddenNote(
        written,
        today,
        period,
        filter,
        matching.some((v) => v.transaction_id === written.id),
        shown.some((v) => v.transaction_id === written.id),
      )
    : null;

  const { newButton, actionsColumn, columns } = voucherControls(Boolean(writer));
  const asking = open && open.kind !== 'form' ? open : null;
  // The form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const locked = confirm.pending || open?.kind === 'form';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((v) => v.transaction_id === asking.row.transaction_id) : false;

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
  /** Closes, and keeps the voucher just written so the screen can say when it is not in the list. */
  const closeSaying = (voucher: WrittenVoucher) => {
    close();
    setWritten(voucher);
  };

  const menuItem = (row: PaymentVoucherRow, action: VoucherAction): RowMenuItem => {
    switch (action) {
      case 'edit':
        return { label: 'Edit', icon: Pencil, opens: true, onSelect: () => ask({ kind: 'form', today: localIsoDate(new Date()), draft: row }) };
      case 'submit':
        return { label: 'Send for approval', icon: Send, opens: true, onSelect: () => ask({ kind: 'submit', row }) };
      case 'approve':
        return { label: 'Approve', icon: Check, opens: true, onSelect: () => ask({ kind: 'approve', row }) };
      case 'reject':
        return { label: 'Reject', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'reject', row }) };
      case 'markPaid':
        // The day it was paid starts as the person's own today.
        return { label: 'Mark as paid', icon: CircleCheck, opens: true, onSelect: () => ask({ kind: 'markPaid', row, paidOn: localIsoDate(new Date()) }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', row }) };
      case 'void':
        return { label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', row }) };
    }
  };

  /**
   * Runs a write on the voucher as the row shows it now. If it was decided, changed or deleted since, the
   * question closes and the refreshed row (or its absence) says what it holds; the sentence stays above the table.
   */
  const settle = <T extends { id: string }>(call: () => Promise<FinResult<T>>, done: () => void) =>
    confirm.run(async () => {
      const result = await call();
      if (!result.ok && voucherAnswerIsStale(result.error)) setOpen(null);
      return result;
    }, done);

  /** The voucher after a write from its row; `date` is given when the write moved it (the day it was paid). */
  const decided = (
    row: PaymentVoucherRow,
    status: 'pending_approval' | 'scheduled' | 'rejected' | 'posted' | 'void',
    date = row.txn_date,
  ): WrittenVoucher => ({
    id: row.transaction_id,
    status,
    recorded: false,
    payee: row.party_name,
    amount: row.amount,
    date,
  });

  const words = (parts: QuestionPart[]) =>
    parts.map((part, i) =>
      part.strong ? (
        <span key={i} className="font-medium">
          {part.text}
        </span>
      ) : (
        part.text
      ),
    );

  /** What sending and a decision are matched on and the table does not draw, as text that wraps. */
  const details = (row: PaymentVoucherRow) => (
    <p className="mt-1 break-words text-xs text-muted-foreground">{voucherDetailsLine(row)}</p>
  );

  const question = (row: PaymentVoucherRow) => {
    if (!writer || !asking || asking.row.transaction_id !== row.transaction_id) return null;
    const { actions } = writer;
    if (asking.kind === 'submit') {
      return (
        <ConfirmRow
          key={row.transaction_id}
          colSpan={columns}
          tone="default"
          icon={Send}
          label={`Send ${voucherName(row)} for approval`}
          confirmLabel="Send for approval"
          pendingLabel="Sending…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => settle(() => actions.submit(voucherDecisionPayload(row)), () => closeSaying(decided(row, 'pending_approval')))}
          onCancel={close}
        >
          {words(voucherQuestion('submit', row))}
          {details(row)}
        </ConfirmRow>
      );
    }
    if (asking.kind === 'approve') {
      // The same advice, in the same words, as Payments Out gives before a supplier payment is marked paid.
      const orderNotes = writer.orderNotes[row.transaction_id] ?? [];
      return (
        <ConfirmRow
          key={row.transaction_id}
          colSpan={columns}
          tone="default"
          icon={Check}
          label={`Approve ${voucherName(row)}`}
          confirmLabel="Approve"
          pendingLabel="Approving…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => settle(() => actions.approve(voucherDecisionPayload(row)), () => closeSaying(decided(row, 'scheduled')))}
          onCancel={close}
        >
          {words(voucherQuestion('approve', row))}
          {details(row)}
          {orderNotes.length ? (
            <div className="mt-1">
              <OrderNotes notes={orderNotes} />
            </div>
          ) : null}
        </ConfirmRow>
      );
    }
    if (asking.kind === 'reject') {
      return (
        <ConfirmRow
          key={row.transaction_id}
          colSpan={columns}
          icon={Ban}
          label={`Reject ${voucherName(row)}`}
          confirmLabel="Reject"
          pendingLabel="Rejecting…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => settle(() => actions.reject(voucherDecisionPayload(row)), () => closeSaying(decided(row, 'rejected')))}
          onCancel={close}
        >
          {words(voucherQuestion('reject', row))}
          {details(row)}
        </ConfirmRow>
      );
    }
    if (asking.kind === 'markPaid') {
      const paidOn = asking.paidOn;
      const confirmPaid = () => {
        if (confirm.pending) return;
        const parsed = markVoucherPaidInput.safeParse({ id: row.transaction_id, paid_on: paidOn });
        if (!parsed.success) {
          confirm.fail(parsed.error.issues[0]?.message ?? 'Enter the date it was paid.');
          return;
        }
        // Paying moves the voucher's date to the day it was paid, so that is the date the note names.
        settle(() => actions.markPaid(parsed.data), () => closeSaying(decided(row, 'posted', parsed.data.paid_on)));
      };
      return (
        <ConfirmRow
          key={row.transaction_id}
          colSpan={columns}
          tone="default"
          icon={CircleCheck}
          label={`Mark ${voucherName(row)} as paid`}
          confirmLabel="Mark as paid"
          pendingLabel="Saving…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={confirmPaid}
          onCancel={close}
        >
          <label className="flex flex-wrap items-center gap-2">
            <span>{words(voucherQuestion('markPaid', row))}</span>
            <Input
              type="date"
              className="w-40"
              value={paidOn}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                confirmPaid();
              }}
              onChange={(e) => {
                confirm.clear();
                setOpen({ kind: 'markPaid', row, paidOn: e.target.value });
              }}
            />
          </label>
          <p className="mt-1 text-muted-foreground">{voucherPaidEffect(row)}</p>
          {details(row)}
        </ConfirmRow>
      );
    }
    if (asking.kind === 'void') {
      return (
        <ConfirmRow
          key={row.transaction_id}
          colSpan={columns}
          icon={Ban}
          label={`Void ${voucherName(row)}`}
          confirmLabel="Void voucher"
          pendingLabel="Voiding…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => settle(() => actions.voidVoucher({ id: row.transaction_id }), () => closeSaying(decided(row, 'void')))}
          onCancel={close}
        >
          {words(voucherQuestion('void', row))}
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={row.transaction_id}
        colSpan={columns}
        label={`Delete ${voucherName(row)}`}
        confirmLabel="Delete voucher"
        pendingLabel="Deleting…"
        pending={confirm.pending}
        error={confirm.error}
        onConfirm={() => settle(() => actions.remove({ id: row.transaction_id, status: row.status }), close)}
        onCancel={close}
      >
        {words(voucherQuestion('delete', row))}
      </ConfirmRow>
    );
  };

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Payment Vouchers"
        subtitle="Money paid out to suppliers, customers and expenses."
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
            {newButton ? (
              <Button
                size="sm"
                aria-expanded={open?.kind === 'form'}
                disabled={locked}
                onClick={() => ask({ kind: 'form', today: localIsoDate(new Date()) })}
              >
                <Plus className="size-4" />
                New voucher
              </Button>
            ) : null}
          </div>
        }
      />

      <BentoGrid>
        {writer && open?.kind === 'form' ? (
          <VoucherFormCard
            // A different draft, or a new voucher after one, starts the card again.
            key={open.draft?.transaction_id ?? 'new'}
            accounts={writer.accounts}
            contacts={writer.contacts}
            categories={voucherCategoryChoices(writer.categories, open.draft ?? null)}
            // What the draft being edited holds of its bills is its own to take again.
            payable={voucherPayableBills(writer.bills, writer.payments, open.draft?.transaction_id ?? null)}
            orders={writer.orders}
            today={open.today}
            canDecide={writer.canDecide}
            draft={open.draft ? draftVoucherForm(open.draft, writer.payments, writer.bills, writer.accounts) : undefined}
            actions={writer.actions}
            onClose={(recorded) => (recorded ? closeSaying({ ...recorded, recorded: true }) : close())}
          />
        ) : null}
        {written && hiddenNote ? (
          <SavedNoteCard title={writtenVoucherTitle(written)} subtitle="It is not in the list below" onClose={() => setWritten(null)}>
            {hiddenNote}
          </SavedNoteCard>
        ) : null}

        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Payments over time" subtitle="Paid out · last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={PAID_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing paid out in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="By category" subtitle={`Paid · ${span.toLowerCase()}`} icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasPaid ? (
            <DonutStat data={view.byCategory} height={240} centerValue={view.paid} centerLabel="paid" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">{nothingInPeriod('paid out', period)}</p>
          )}
        </BentoCard>

        <BentoCard
          title="Vouchers"
          subtitle="Every payment out: suppliers, refunds, expenses and the rest"
          icon={Wallet}
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
                aria-label="Search vouchers by payee, number, document or category"
                placeholder="Search payees, numbers or categories…"
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
                setFilter(v as PaymentVoucherFilter);
              }}
            >
              <SelectTrigger className="w-44" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All but void and rejected</SelectItem>
                <SelectItem value="waiting">Pending approval</SelectItem>
                <SelectItem value="scheduled">To be paid</SelectItem>
                <SelectItem value="posted">Paid</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={kind}
              onValueChange={(v) => {
                listChanged();
                setKind(v as 'all' | PaymentVoucherKind);
              }}
            >
              <SelectTrigger className="w-44" aria-label="Kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {PAYMENT_VOUCHER_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('payment-vouchers', localIsoDate(new Date())), paymentVouchersCsv(matching))}
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
                  <TableHead>Paid to</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  {actionsColumn ? (
                    <TableHead className="sticky right-0 w-10 border-l bg-[color-mix(in_oklab,var(--muted)_40%,var(--card))]">
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
                          ? 'No vouchers yet. Record one with New voucher. A payment recorded on Payments Out or Refunds shows here too.'
                          : 'No vouchers yet. A payment recorded on Payments Out or Refunds shows here too.'}
                      </TableCell>
                    </TableRow>
                  ) : inPeriodRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                        {emptyPeriodText('vouchers', period)}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((v) => {
                  const asked = question(v);
                  if (asked) return asked;
                  const home = voucherKindLink(v);
                  const items = writer ? voucherActions(v, writer.canDecide).map((action) => menuItem(v, action)) : [];
                  return (
                    <TableRow key={v.transaction_id} className={cn('group/row', v.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(v.txn_date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{v.number ?? '—'}</TableCell>
                      {/* A long typed name wraps; it is never cut off behind a tooltip. */}
                      <TableCell className="min-w-28 max-w-72 whitespace-normal break-words">{v.party_name ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {home ? (
                          <Link
                            href={home.href}
                            title={home.title ?? undefined}
                            aria-label={`${PAYMENT_VOUCHER_KIND_LABELS[v.kind]}: open ${home.label}`}
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            {PAYMENT_VOUCHER_KIND_LABELS[v.kind]}
                          </Link>
                        ) : (
                          PAYMENT_VOUCHER_KIND_LABELS[v.kind]
                        )}
                        {v.documents ? <span className="ml-1.5">· {v.documents}</span> : null}
                      </TableCell>
                      <TableCell className="min-w-24 whitespace-normal break-words text-muted-foreground">{voucherCategory(v)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{v.account_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {money(v.amount, cashBookCurrency(v))}
                        {/* Stage 5b: on an account in another currency, its ringgit under it. */}
                        {cashBookCurrency(v) === 'MYR' ? null : (
                          <span className="block text-xs text-muted-foreground">≈ {rm(cashBookRinggit(v))}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={v.status === 'posted'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[v.status],
                            )}
                          >
                            {PAYMENT_VOUCHER_STATUS_LABELS[v.status]}
                          </span>
                        </span>
                      </TableCell>
                      {actionsColumn ? (
                        <TableCell className="sticky right-0 border-l bg-card group-hover/row:bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))] group-has-aria-expanded/row:bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))]">
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or the form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={voucherName(v)} items={items} />
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
