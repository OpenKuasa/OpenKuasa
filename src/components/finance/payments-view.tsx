'use client';

import { useState } from 'react';
import { Ban, CircleCheck, Download, PieChart, Plus, Search, Trash2, TrendingUp, TriangleAlert, Wallet } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { OrderNotes } from '@/components/finance/order-notes';
import { PaymentFormCard, type RecordPayment } from '@/components/finance/payment-form-card';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import type { BillListRow } from '@/lib/finance/bills';
import { csvFileName } from '@/lib/finance/csv';
import { money, rm } from '@/lib/finance/format';
import {
  type FinanceAccount,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type PaymentOutRow,
  markPaymentPaidInput,
} from '@/lib/finance/money';
import { payableBills } from '@/lib/finance/payment-form';
import {
  LATEST_ROWS,
  PAYMENT_STATUS_LABELS,
  type PaymentMethodFilter,
  type OrderBilling,
  type PaymentStatusFilter,
  type PaymentsViewData,
  alsoCovers,
  displayDate,
  filterPayments,
  orderNotesForBills,
  paymentRowsAgainstFlaggedOrders,
  paymentsCsv,
} from '@/lib/finance/purchase-views';
import type { FinResult } from '@/lib/finance/result';
import type { FxRateLookup } from '@/components/finance/movement-rate-fields';
import { cn } from '@/lib/utils';

export type PaymentActions = {
  record: RecordPayment;
  markPaid: (input: unknown) => Promise<FinResult<{ id: string; number: string }>>;
  voidPayment: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Bank Negara's selling rate, for a payment on an account in another currency (stage 5b). */
  fxRate?: FxRateLookup;
};

/** What only a person who may edit is given: the actions, and what the payment form offers. */
export type PaymentsWriter = {
  actions: PaymentActions;
  /** Every bill, to find the ones that can still be paid. */
  bills: BillListRow[];
  accounts: FinanceAccount[];
  /** Approved and closed purchase orders, to say when a bill being paid is over its order. */
  orders: OrderBilling[];
};

const PAID_SERIES: Series[] = [
  { key: 'electronic', label: 'Electronic (RM k)', color: 'var(--chart-1)' },
  { key: 'cash', label: 'Cash / cheque (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<PaymentOutRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-muted text-muted-foreground',
  rejected: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

/** One thing open at a time: the payment form, or a question in one row. */
type Open =
  | { kind: 'form'; today: string }
  | { kind: 'markPaid'; row: PaymentOutRow; paidOn: string }
  | { kind: 'void'; row: PaymentOutRow }
  | { kind: 'delete'; row: PaymentOutRow }
  | null;

export function PaymentsView({
  rows,
  view,
  writer,
}: {
  /** One row per bill a payment pays, newest first; void ones included. */
  rows: PaymentOutRow[];
  view: PaymentsViewData;
  writer?: PaymentsWriter;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<PaymentStatusFilter>('current');
  const [method, setMethod] = useState<PaymentMethodFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();

  const matching = filterPayments(rows, query, status, method);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 9 : 8;
  const asking = open && open.kind !== 'form' ? open : null;
  // The form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const locked = confirm.pending || open?.kind === 'form';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((r) => r.allocation_id === asking.row.allocation_id) : false;

  // Only a person who may pay is given the orders, so a reader sees no marks.
  const flagged = writer ? paymentRowsAgainstFlaggedOrders(rows, writer.bills, writer.orders) : new Set<string>();

  const ask = (next: Exclude<Open, null>) => {
    confirm.clear();
    setOpen(next);
  };

  const menu = (row: PaymentOutRow): RowMenuItem[] => {
    if (row.status === 'scheduled') {
      return [
        {
          label: 'Mark as paid',
          icon: CircleCheck,
          opens: true,
          onSelect: () => ask({ kind: 'markPaid', row, paidOn: localIsoDate(new Date()) }),
        },
        { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', row }) },
      ];
    }
    if (row.status === 'posted') {
      return [{ label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', row }) }];
    }
    return [];
  };

  const question = (row: PaymentOutRow) => {
    if (!writer || !asking || asking.row.allocation_id !== row.allocation_id) return null;
    const { actions } = writer;
    const id = row.transaction_id;
    // The whole payment, in its account's currency (stage 5b).
    const whole = money(row.transaction_amount, row.transaction_currency ?? 'MYR');
    const also = alsoCovers(rows, row);
    // The bills this payment settles are the rows that share its transaction.
    const settled = rows.filter((r) => r.transaction_id === row.transaction_id).map((r) => r.bill_id);
    const orderNotes = orderNotesForBills(
      writer.bills.filter((b) => settled.includes(b.id)),
      writer.orders,
    );
    const close = () => {
      confirm.clear();
      setOpen(null);
    };
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
          colSpan={columns}
          tone="default"
          icon={CircleCheck}
          label={`Mark the payment to ${row.supplier_name} as paid`}
          confirmLabel="Mark as paid"
          pendingLabel="Saving…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={confirmPaid}
          onCancel={close}
        >
          <label className="flex flex-wrap items-center gap-2">
            <span>
              The payment of <span className="font-medium">{whole}</span> to{' '}
              <span className="font-medium">{row.supplier_name}</span> was made on
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
          {also ? <p className="mt-1 text-muted-foreground">{also}</p> : null}
          {orderNotes.length ? (
            <div className="mt-1">
              <OrderNotes notes={orderNotes} />
            </div>
          ) : null}
        </ConfirmRow>
      );
    }
    if (asking.kind === 'void') {
      return (
        <ConfirmRow
          key={row.allocation_id}
          colSpan={columns}
          icon={Ban}
          label={`Void payment ${row.number ?? ''} to ${row.supplier_name}`}
          confirmLabel="Void payment"
          pendingLabel="Voiding…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => confirm.run(() => actions.voidPayment({ id }), close)}
          onCancel={close}
        >
          Void payment <span className="font-medium">{row.number}</span> of <span className="font-medium">{whole}</span> to{' '}
          <span className="font-medium">{row.supplier_name}</span>? The bills it paid will owe that amount again. This
          cannot be undone. {also}
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={row.allocation_id}
        colSpan={columns}
        label={`Delete the payment still to be paid to ${row.supplier_name}`}
        confirmLabel="Delete payment"
        pendingLabel="Deleting…"
        pending={confirm.pending}
        error={confirm.error}
        onConfirm={() => confirm.run(() => actions.remove({ id }), close)}
        onCancel={close}
      >
        Delete the payment of <span className="font-medium">{whole}</span> to{' '}
        <span className="font-medium">{row.supplier_name}</span> that is still to be paid? Nothing has been paid yet, so the bills stay as they
        are. {also}
      </ConfirmRow>
    );
  };

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Payments Out"
        subtitle="Payments made to suppliers."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'form'}
              disabled={locked}
              onClick={() => ask({ kind: 'form', today: localIsoDate(new Date()) })}
            >
              <Plus className="size-4" />
              Record Payment
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {writer && open?.kind === 'form' ? (
          <PaymentFormCard
            payable={payableBills(writer.bills, rows)}
            orders={writer.orders}
            accounts={writer.accounts}
            today={open.today}
            record={writer.actions.record}
            fxRate={writer.actions.fxRate}
            onClose={() => setOpen(null)}
          />
        ) : null}

        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard
          title="Payments over time"
          subtitle="Electronic vs cash · last 8 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={PAID_SERIES} height={240} showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">No payments in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Paid by method" subtitle="Month to date · RM" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.byMethod.every((slice) => slice.value === 0) ? (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing paid yet this month.</p>
          ) : (
            <DonutStat data={view.byMethod} height={240} centerValue={view.paidMtd} centerLabel="paid" />
          )}
        </BentoCard>

        <BentoCard
          title="Payments"
          subtitle="One row for each bill a payment pays"
          icon={Wallet}
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
                aria-label="Search payments by supplier, bill, voucher number or reference"
                placeholder="Search payments…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={status} onValueChange={(v) => setStatus(v as PaymentStatusFilter)}>
              <SelectTrigger className="w-44" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Paid and to be paid</SelectItem>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="posted">Paid</SelectItem>
                <SelectItem value="scheduled">To be paid</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethodFilter)}>
              <SelectTrigger className="w-40" aria-label="Method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All methods</SelectItem>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('payments-out', localIsoDate(new Date())), paymentsCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
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
                  <TableHead>Supplier</TableHead>
                  <TableHead>Bill</TableHead>
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
                        No payments yet.{writer ? ' Record one against a posted bill.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((p) => {
                  const asked = question(p);
                  if (asked) return asked;
                  const items = writer ? menu(p) : [];
                  return (
                    <TableRow key={p.allocation_id} className={cn(p.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(p.txn_date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{p.number ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{p.supplier_name}</TableCell>
                      <TableCell className="whitespace-nowrap">{p.bill_no ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{p.account_name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="whitespace-nowrap">
                          {PAYMENT_METHOD_LABELS[p.method]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        <span className="inline-flex items-center justify-end gap-1.5">
                          {flagged.has(p.allocation_id) ? (
                            <span title="This bill’s purchase order is billed over its total or for more than has been received" className="text-amber-600">
                              <TriangleAlert className="size-4" aria-hidden />
                              <span className="sr-only">This bill’s purchase order is billed over its total or for more than has been received</span>
                            </span>
                          ) : null}
                          {(p.currency ?? 'MYR') === 'MYR' ? (
                            rm(p.amount)
                          ) : (
                            // A bill in another currency: the part it settled, the ringgit paid out for it, and the
                            // realised difference when there is one.
                            <span>
                              {money(p.amount, p.currency)}
                              {p.amount_myr !== null && p.amount_myr !== undefined ? ` · ${rm(p.amount_myr)}` : ''}
                              {p.realised_myr ? (
                                <span className="block text-xs text-muted-foreground">
                                  Realised {p.realised_myr > 0 ? 'gain' : 'loss'} {rm(Math.abs(p.realised_myr))}
                                </span>
                              ) : null}
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={p.status === 'posted'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[p.status],
                            )}
                          >
                            {PAYMENT_STATUS_LABELS[p.status]}
                          </span>
                        </span>
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or the form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={`${p.number ?? 'the payment still to be paid'} to ${p.supplier_name}`} items={items} />
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
            Showing {shown.length} of {matching.length} payments
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
