'use client';

import { useState } from 'react';
import { Ban, Banknote, CircleCheck, Download, PieChart, Plus, Search, Trash2, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { RefundFormCard, type RecordRefund } from '@/components/finance/refund-form-card';
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
import { localIsoDate } from '@/lib/finance/bill-math';
import type { CreditNoteRow } from '@/lib/finance/credit-notes';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { type FinanceAccount, markPaymentPaidInput } from '@/lib/finance/money';
import { refundTargets } from '@/lib/finance/refund-form';
import { REFUND_REASON_LABELS, type RefundRow } from '@/lib/finance/refunds';
import type { FinResult } from '@/lib/finance/result';
import {
  REFUND_STATUS_LABELS,
  type RefundAction,
  type RefundFilter,
  type RefundsViewData,
  filterRefunds,
  refundActions,
  refundName,
  refundsCsv,
} from '@/lib/finance/sales-followon-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type RefundActions = {
  record: RecordRefund;
  markPaid: (input: unknown) => Promise<FinResult<{ id: string; number: string }>>;
  voidRefund: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What only a person who may edit is given: the actions, and what the refund form offers. */
export type RefundsWriter = {
  actions: RefundActions;
  /** Every invoice, to find the ones whose customer is in credit. */
  invoices: InvoiceListRow[];
  /** Every credit note, so a refund can be put against an issued one. */
  creditNotes: CreditNoteRow[];
  accounts: FinanceAccount[];
};

const REFUNDED_SERIES: Series[] = [{ key: 'refunded', label: 'Refunded (RM k)', color: 'var(--chart-3)' }];

/** A refund still being written (`draft`) is worded "Pending" and counted as pending, so it is amber as one is. */
const STATUS_STYLES: Record<RefundRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
  void: 'bg-muted text-muted-foreground line-through',
};

/** One thing open at a time: the refund form, or a question in one row. */
type Open =
  | { kind: 'form'; today: string; nonce: number }
  | { kind: 'markPaid'; row: RefundRow; paidOn: string }
  | { kind: 'void'; row: RefundRow }
  | { kind: 'delete'; row: RefundRow }
  | null;

/**
 * Refunds: figures, charts and the table, with search, a status filter,
 * "View all" and Export for everybody. A person who may edit (`writer`) also
 * gets New Refund and a menu on each row that offers what its status allows.
 */
export function RefundsView({
  rows,
  view,
  writer,
}: {
  /** Every refund, newest first; pending and void ones included. */
  rows: RefundRow[];
  view: RefundsViewData;
  writer?: RefundsWriter;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RefundFilter>('open');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();

  const matching = filterRefunds(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 9 : 8;
  const asking = open && open.kind !== 'form' ? open : null;
  // The form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const locked = confirm.pending || open?.kind === 'form';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((r) => r.allocation_id === asking.row.allocation_id) : false;
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

  const menuItem = (row: RefundRow, action: RefundAction): RowMenuItem => {
    switch (action) {
      case 'markPaid':
        return {
          label: 'Mark as paid',
          icon: CircleCheck,
          opens: true,
          onSelect: () => ask({ kind: 'markPaid', row, paidOn: now() }),
        };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', row }) };
      case 'void':
        return { label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', row }) };
    }
  };

  const question = (row: RefundRow) => {
    if (!writer || !asking || asking.row.allocation_id !== row.allocation_id) return null;
    const { actions } = writer;
    const id = row.transaction_id;
    const name = refundName(row);
    const who = <span className="font-medium">{row.customer_name}</span>;
    const amount = <span className="font-medium">{rm(row.amount)}</span>;
    const invoice = <span className="font-medium">{row.invoice_no ?? 'the invoice'}</span>;
    const shared = { colSpan: columns, pending: confirm.pending, error: confirm.error, onCancel: close };
    const confirmPaid = () => {
      if (asking.kind !== 'markPaid' || confirm.pending) return;
      const parsed = markPaymentPaidInput.safeParse({ id, paid_on: asking.paidOn });
      if (!parsed.success) {
        confirm.fail(parsed.error.issues[0]?.message ?? 'Enter a valid date.');
        return;
      }
      confirm.run(() => actions.markPaid(parsed.data), close);
    };

    if (asking.kind === 'markPaid') {
      const paidOn = asking.paidOn;
      return (
        <ConfirmRow
          key={row.allocation_id}
          {...shared}
          tone="default"
          icon={CircleCheck}
          label={`Mark ${name} as paid`}
          confirmLabel="Mark as paid"
          pendingLabel="Saving…"
          onConfirm={confirmPaid}
        >
          <label className="flex flex-wrap items-center gap-2">
            <span>
              The refund of {amount} to {who} on {invoice} was paid out on
            </span>
            <Input
              type="date"
              className="w-40"
              value={paidOn}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                confirmPaid();
              }}
              onChange={(e) => setOpen({ kind: 'markPaid', row, paidOn: e.target.value })}
            />
          </label>
          <p className="mt-1 text-muted-foreground">
            It gets its payment voucher number and can then only be voided. The customer’s credit is looked at again
            first.
          </p>
        </ConfirmRow>
      );
    }
    if (asking.kind === 'void') {
      return (
        <ConfirmRow
          key={row.allocation_id}
          {...shared}
          icon={Ban}
          label={`Void refund ${name}`}
          confirmLabel="Void refund"
          pendingLabel="Voiding…"
          onConfirm={() => confirm.run(() => actions.voidRefund({ id }), close)}
        >
          Void refund <span className="font-medium">{row.number}</span> of {amount} to {who}? The customer is in credit
          by that amount on {invoice} again. It stays in the list as Void, and this cannot be undone.
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={row.allocation_id}
        {...shared}
        label={`Delete ${name}`}
        confirmLabel="Delete refund"
        pendingLabel="Deleting…"
        onConfirm={() => confirm.run(() => actions.remove({ id }), close)}
      >
        Delete the pending refund of {amount} to {who}? Nothing has been paid out, so the customer stays in credit on{' '}
        {invoice}.
      </ConfirmRow>
    );
  };

  // The question's own message shows in its row; beside the filters only while its row is out of view.
  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Refunds"
        subtitle="Money paid back to customers who are in credit, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'form'}
              disabled={locked}
              onClick={() => ask({ kind: 'form', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New Refund
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {writer && open?.kind === 'form' ? (
          <RefundFormCard
            key={open.nonce}
            targets={refundTargets(writer.invoices, writer.creditNotes, rows)}
            accounts={writer.accounts}
            today={open.today}
            record={writer.actions.record}
            onClose={close}
          />
        ) : null}

        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Refunded over time" subtitle="Last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={REFUNDED_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing refunded in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Refunds by reason" subtitle="This year" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReasons ? (
            <DonutStat data={view.byReason} height={240} centerValue={view.refundedYtd} centerLabel="refunded" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing refunded this year.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Refunds"
          subtitle="What you have paid back, and what is waiting to be paid"
          icon={Banknote}
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
                aria-label="Search refunds by customer, invoice, credit note or number"
                placeholder="Search customers, invoices or numbers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as RefundFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="posted">Refunded</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('refunds', now()), refundsCsv(matching))}
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
                  <TableHead>Date</TableHead>
                  <TableHead>No.</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Credit note</TableHead>
                  <TableHead>Reason</TableHead>
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
                        No refunds yet.{writer ? ' Record the first one with New Refund, once a customer is in credit.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((r) => {
                  const asked = question(r);
                  if (asked) return asked;
                  const items = writer ? refundActions(r).map((action) => menuItem(r, action)) : [];
                  return (
                    <TableRow key={r.allocation_id} className={cn(r.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(r.txn_date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{r.number ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.customer_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{r.invoice_no ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{r.credit_note_no ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{REFUND_REASON_LABELS[r.reason]}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(r.amount)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={r.status === 'posted'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[r.status],
                            )}
                          >
                            {REFUND_STATUS_LABELS[r.status]}
                          </span>
                        </span>
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={refundName(r)} items={items} />
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
            Showing {shown.length} of {matching.length} refunds
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
