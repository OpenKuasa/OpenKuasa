'use client';

import { useState } from 'react';
import { Ban, Banknote, Download, PieChart, Plus, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import type { RecordPayment } from '@/components/finance/allocation-form-card';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { ReceiptFormCard } from '@/components/finance/receipt-form-card';
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
import { csvFileName } from '@/lib/finance/csv';
import { money, rm } from '@/lib/finance/format';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { type FinanceAccount, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentInRow } from '@/lib/finance/money';
import { receivableInvoices } from '@/lib/finance/receipt-form';
import type { FinResult } from '@/lib/finance/result';
import type { FxRateLookup } from '@/components/finance/movement-rate-fields';
import {
  PAYMENT_IN_STATUS_LABELS,
  type PaymentInMethodFilter,
  type PaymentInStatusFilter,
  type PaymentsInViewData,
  alsoCoversInvoices,
  filterPaymentsIn,
  paymentInActions,
  paymentsInCsv,
} from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type PaymentInActions = {
  record: RecordPayment;
  voidPayment: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Bank Negara's selling rate, for a payment on an account in another currency (stage 5b). */
  fxRate?: FxRateLookup;
};

/** What only a person who may edit is given: the actions, and what the payment form offers. */
export type PaymentsInWriter = {
  actions: PaymentInActions;
  /** Every invoice, to find the ones that can still take a payment. */
  invoices: InvoiceListRow[];
  accounts: FinanceAccount[];
};

const RECEIVED_SERIES: Series[] = [{ key: 'received', label: 'Received (RM k)', color: 'var(--chart-2)' }];

const STATUS_STYLES: Record<PaymentInRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-muted text-muted-foreground',
  rejected: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

/** One thing open at a time: the payment form, or the void question in one row. */
type Open = { kind: 'form'; today: string } | { kind: 'void'; row: PaymentInRow } | null;

/**
 * Payments In: figures, charts and the table, with search, filters, "View
 * all" and Export for everybody. A person who may edit (`writer`) also gets
 * Record Payment and, on a received payment, Void. There is no edit and no
 * delete: money in is posted the moment it is recorded.
 */
export function PaymentsInView({
  rows,
  view,
  writer,
}: {
  /** One row per invoice a payment pays, newest first; void ones included. */
  rows: PaymentInRow[];
  view: PaymentsInViewData;
  writer?: PaymentsInWriter;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<PaymentInStatusFilter>('posted');
  const [method, setMethod] = useState<PaymentInMethodFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();

  const matching = filterPaymentsIn(rows, query, status, method);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 9 : 8;
  const asking = open?.kind === 'void' ? open : null;
  // The form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const locked = confirm.pending || open?.kind === 'form';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((r) => r.allocation_id === asking.row.allocation_id) : false;

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

  const menu = (row: PaymentInRow): RowMenuItem[] =>
    paymentInActions(row).map(() => ({
      label: 'Void',
      icon: Ban,
      destructive: true,
      opens: true,
      onSelect: () => ask({ kind: 'void', row }),
    }));

  const question = (row: PaymentInRow) => {
    if (!writer || !asking || asking.row.allocation_id !== row.allocation_id) return null;
    const { actions } = writer;
    return (
      <ConfirmRow
        key={row.allocation_id}
        colSpan={columns}
        icon={Ban}
        label={`Void payment ${row.number ?? ''} from ${row.customer_name}`}
        confirmLabel="Void payment"
        pendingLabel="Voiding…"
        pending={confirm.pending}
        error={confirm.error}
        // Sent the payment's own id, so the whole payment is voided whichever of its rows was used.
        onConfirm={() => confirm.run(() => actions.voidPayment({ id: row.transaction_id }), close)}
        onCancel={close}
      >
        Void payment <span className="font-medium">{row.number}</span> of{' '}
        <span className="font-medium">{money(row.transaction_amount, row.transaction_currency ?? 'MYR')}</span> from{' '}
        <span className="font-medium">{row.customer_name}</span>? The invoices it paid will owe that amount again. This
        cannot be undone. {alsoCoversInvoices(rows, row)}
      </ConfirmRow>
    );
  };

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Payments In"
        subtitle="Payments received from your customers, Saudara."
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
          <ReceiptFormCard
            receivable={receivableInvoices(writer.invoices, rows)}
            accounts={writer.accounts}
            today={open.today}
            record={writer.actions.record}
            fxRate={writer.actions.fxRate}
            onClose={close}
          />
        ) : null}

        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Received over time" subtitle="Last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={RECEIVED_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing received in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Received by method" subtitle="Month to date · RM" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReceived ? (
            <DonutStat data={view.byMethod} height={240} centerValue={view.receivedMtd} centerLabel="received" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing received yet this month.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Payments"
          subtitle="One row for each invoice a payment pays"
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
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search payments by customer, invoice, receipt number or reference"
                placeholder="Search payments…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={status} onValueChange={(v) => setStatus(v as PaymentInStatusFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="posted">Received</SelectItem>
                <SelectItem value="void">Void</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentInMethodFilter)}>
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
              onClick={() => downloadCsv(csvFileName('payments-in', localIsoDate(new Date())), paymentsInCsv(matching))}
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
                  <TableHead>Customer</TableHead>
                  <TableHead>Invoice</TableHead>
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
                        No payments yet.{writer ? ' Record one against a posted invoice.' : ''}
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
                    // A payment split across invoices is several rows; the allocation is what each row is.
                    <TableRow key={p.allocation_id} className={cn(p.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(p.txn_date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{p.number ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{p.customer_name}</TableCell>
                      <TableCell className="whitespace-nowrap">{p.invoice_no ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{p.account_name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="whitespace-nowrap">
                          {PAYMENT_METHOD_LABELS[p.method]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {(p.currency ?? 'MYR') === 'MYR' ? (
                          rm(p.amount)
                        ) : (
                          // An invoice in another currency: the part it settled, the ringgit it brought, and the
                          // realised difference when there is one.
                          <>
                            {money(p.amount, p.currency)}
                            {p.amount_myr !== null && p.amount_myr !== undefined ? ` · ${rm(p.amount_myr)}` : ''}
                            {p.realised_myr ? (
                              <span className="block text-xs text-muted-foreground">
                                Realised {p.realised_myr > 0 ? 'gain' : 'loss'} {rm(Math.abs(p.realised_myr))}
                              </span>
                            ) : null}
                          </>
                        )}
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
                            {PAYMENT_IN_STATUS_LABELS[p.status]}
                          </span>
                        </span>
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or the form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={`${p.number ?? 'the payment'} from ${p.customer_name}`} items={items} />
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
            Showing {shown.length} of {matching.length} rows
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
