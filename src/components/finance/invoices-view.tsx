'use client';

import { useState } from 'react';
import {
  BadgeCheck,
  Ban,
  Banknote,
  Download,
  FileCheck,
  FileText,
  Pencil,
  PieChart,
  Plus,
  Search,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import type { RecordPayment } from '@/components/finance/allocation-form-card';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { EInvoiceCard } from '@/components/finance/einvoice-card';
import { InvoiceFormCard, type InvoiceFormActions } from '@/components/finance/invoice-form-card';
import { ReceiptFormCard } from '@/components/finance/receipt-form-card';
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
import type { FinanceContact } from '@/lib/finance/contacts';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { EInvoiceStatus, InvoiceDetail, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { FinanceAccount, PaymentInRow } from '@/lib/finance/money';
import type { FinanceProduct } from '@/lib/finance/products';
import { receivableInvoices } from '@/lib/finance/receipt-form';
import type { FinResult } from '@/lib/finance/result';
import {
  EINVOICE_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  type InvoiceAction,
  type InvoiceFilter,
  type InvoicesViewData,
  balanceText,
  customerChoice,
  filterInvoices,
  invoiceActions,
  invoiceCustomers,
  invoicesCsv,
} from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type InvoiceActions = InvoiceFormActions & {
  post: (input: unknown) => Promise<FinResult<{ id: string; invoice_no: string }>>;
  voidInvoice: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Reads one draft with its lines, for the Edit form. */
  get: (input: unknown) => Promise<FinResult<InvoiceDetail>>;
  recordPayment: RecordPayment;
  setEInvoice: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What only a person who may edit is given: the actions, and what the forms offer. */
export type InvoicesWriter = {
  actions: InvoiceActions;
  /** Active customers, by name. */
  customers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  accounts: FinanceAccount[];
  /** Every payment-in row, to know what an invoice can still take. */
  payments: PaymentInRow[];
};

const TREND_SERIES: Series[] = [
  { key: 'invoiced', label: 'Invoiced (RM k)', color: 'var(--chart-1)' },
  { key: 'received', label: 'Received (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<InvoiceDisplayStatus, string> = {
  paid: 'bg-emerald-500/15 text-emerald-600',
  sent: 'bg-amber-500/15 text-amber-600',
  overdue: 'bg-red-500/15 text-red-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

const EINVOICE_STYLES: Record<Exclude<EInvoiceStatus, 'none'>, string> = {
  validated: 'bg-emerald-500/15 text-emerald-600',
  pending: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
};

/** One thing open at a time: a form card, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  /** `detail` is null while the draft's lines are being read. */
  | { kind: 'edit'; invoice: InvoiceListRow; detail: InvoiceDetail | null; today: string }
  | { kind: 'pay'; invoice: InvoiceListRow; today: string }
  | { kind: 'einvoice'; invoice: InvoiceListRow }
  | { kind: 'post'; invoice: InvoiceListRow }
  | { kind: 'void'; invoice: InvoiceListRow }
  | { kind: 'delete'; invoice: InvoiceListRow }
  | null;

const invoiceName = (invoice: InvoiceListRow) => `${invoice.invoice_no ?? 'the draft invoice'} to ${invoice.customer_name}`;

/**
 * Invoices: figures, charts and the table, with search, filters, "View all"
 * and Export for everybody. A person who may edit (`writer`) also gets New
 * Invoice and a menu on each row that offers what its status allows.
 */
export function InvoicesView({
  rows,
  view,
  writer,
}: {
  /** Every invoice, newest first; drafts and void ones included. */
  rows: InvoiceListRow[];
  view: InvoicesViewData;
  writer?: InvoicesWriter;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InvoiceFilter>('open');
  const [chosenCustomer, setCustomer] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();
  const loader = useFinanceAction('read');

  const customers = invoiceCustomers(rows);
  const customer = customerChoice(chosenCustomer, customers);
  // The chosen customer has no invoice left after a refresh. The choice is dropped, not only hidden,
  // so it does not come back by itself when that customer is invoiced again.
  if (customer !== chosenCustomer) setCustomer(customer);
  const matching = filterInvoices(rows, query, filter, customer);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 9 : 8;
  const receivable = writer ? receivableInvoices(rows, writer.payments) : [];
  const asking = open && (open.kind === 'post' || open.kind === 'void' || open.kind === 'delete') ? open : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen = open !== null && !asking;
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((i) => i.id === asking.invoice.id) : false;
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

  const menuItem = (invoice: InvoiceListRow, action: InvoiceAction, actions: InvoiceActions): RowMenuItem => {
    switch (action) {
      case 'edit':
        return {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'edit', invoice, detail: null, today: now() });
            loader.run(
              () => actions.get({ id: invoice.id }),
              // Still waiting on this invoice? Something else may have been opened meanwhile.
              (detail) =>
                setOpen((cur) => (cur?.kind === 'edit' && cur.invoice.id === invoice.id ? { ...cur, detail } : cur)),
            );
          },
        };
      case 'post':
        return { label: 'Post', icon: FileCheck, opens: true, onSelect: () => ask({ kind: 'post', invoice }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', invoice }) };
      case 'pay':
        return { label: 'Record payment', icon: Banknote, opens: true, onSelect: () => ask({ kind: 'pay', invoice, today: now() }) };
      case 'einvoice':
        return { label: 'Set e-Invois', icon: BadgeCheck, opens: true, onSelect: () => ask({ kind: 'einvoice', invoice }) };
      case 'void':
        return { label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', invoice }) };
    }
  };

  const menu = (invoice: InvoiceListRow, actions: InvoiceActions): RowMenuItem[] =>
    invoiceActions(
      invoice,
      receivable.some((r) => r.id === invoice.id),
    ).map((action) => menuItem(invoice, action, actions));

  const question = (invoice: InvoiceListRow) => {
    if (!writer || !asking || asking.invoice.id !== invoice.id) return null;
    const { actions } = writer;
    if (asking.kind === 'post') {
      return (
        <ConfirmRow
          key={invoice.id}
          colSpan={columns}
          tone="default"
          icon={FileCheck}
          label={`Post ${invoiceName(invoice)}`}
          confirmLabel="Post"
          pendingLabel="Posting…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => confirm.run(() => actions.post({ id: invoice.id }), close)}
          onCancel={close}
        >
          Post this invoice to <span className="font-medium">{invoice.customer_name}</span> ({rm(invoice.total)})? It
          gets its number and can no longer be edited, only voided.
        </ConfirmRow>
      );
    }
    if (asking.kind === 'void') {
      return (
        <ConfirmRow
          key={invoice.id}
          colSpan={columns}
          icon={Ban}
          label={`Void ${invoiceName(invoice)}`}
          confirmLabel="Void invoice"
          pendingLabel="Voiding…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => confirm.run(() => actions.voidInvoice({ id: invoice.id }), close)}
          onCancel={close}
        >
          Void <span className="font-medium">{invoice.invoice_no}</span> to{' '}
          <span className="font-medium">{invoice.customer_name}</span> ({rm(invoice.total)})? It stays in the list as
          Void and nothing more is owed on it. This cannot be undone. An invoice cannot be voided while it has payments,
          refunds or credit notes: void payments on Payments In, and void or delete refunds and credit notes on their
          own screens.
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={invoice.id}
        colSpan={columns}
        label={`Delete ${invoiceName(invoice)}`}
        confirmLabel="Delete draft"
        pendingLabel="Deleting…"
        pending={confirm.pending}
        error={confirm.error}
        onConfirm={() => confirm.run(() => actions.remove({ id: invoice.id }), close)}
        onCancel={close}
      >
        Delete the draft invoice to <span className="font-medium">{invoice.customer_name}</span> ({rm(invoice.total)})?
        This cannot be undone.
      </ConfirmRow>
    );
  };

  const card = () => {
    if (!writer || !open) return null;
    const { actions } = writer;
    if (open.kind === 'new') {
      return (
        <InvoiceFormCard
          key={open.nonce}
          customers={writer.customers}
          products={writer.products}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      );
    }
    if (open.kind === 'edit') {
      return open.detail ? (
        <InvoiceFormCard
          // A different draft gets a fresh form.
          key={open.detail.id}
          editing={open.detail}
          customers={writer.customers}
          products={writer.products}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      ) : (
        <BentoCard
          title="Edit invoice"
          subtitle={`The draft to ${open.invoice.customer_name}`}
          icon={FileText}
          className="col-span-2 md:col-span-12"
        >
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
    }
    if (open.kind === 'pay') {
      return (
        <ReceiptFormCard
          key={open.invoice.id}
          receivable={receivable}
          accounts={writer.accounts}
          today={open.today}
          preselect={{ customerId: open.invoice.customer_id, invoiceId: open.invoice.id }}
          record={actions.recordPayment}
          onClose={close}
        />
      );
    }
    if (open.kind === 'einvoice') {
      return <EInvoiceCard key={open.invoice.id} invoice={open.invoice} save={actions.setEInvoice} onClose={close} />;
    }
    return null;
  };

  // The question's own message shows in its row; beside the filters only while its row is out of view.
  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Invoices"
        subtitle="Sales invoices and their e-Invois status, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New Invoice
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

        <BentoCard
          title="Invoiced over time"
          subtitle="Invoiced vs received · last 8 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={TREND_SERIES} height={240} showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">
              Nothing invoiced or received in the last 8 months.
            </p>
          )}
        </BentoCard>
        <BentoCard title="Invoices by status" subtitle="Current book" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.invoiceCount === 0 ? (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">
              {rows.length === 0 ? 'No invoices yet.' : 'No open invoices.'}
            </p>
          ) : (
            <DonutStat data={view.byStatus} height={240} centerValue={String(view.invoiceCount)} centerLabel="invoices" />
          )}
        </BentoCard>

        <BentoCard
          title="Invoices"
          subtitle="What you have billed your customers"
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
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search invoices by number or customer"
                placeholder="Search invoices or customers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as InvoiceFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Select value={customer} onValueChange={setCustomer}>
              <SelectTrigger className="w-48" aria-label="Customer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All customers</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('invoices', now()), invoicesCsv(matching))}
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
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>e-Invois</TableHead>
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
                        No invoices yet.{writer ? ' Add the first one with New Invoice.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((i) => {
                  const asked = question(i);
                  if (asked) return asked;
                  const items = writer ? menu(i, writer.actions) : [];
                  return (
                    <TableRow key={i.id} className={cn(i.display_status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap font-medium">{i.invoice_no ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(i.invoice_date)}</TableCell>
                      <TableCell className="whitespace-nowrap">{i.customer_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(i.due_date)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(i.total)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{balanceText(i)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={i.display_status === 'paid'} />
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[i.display_status],
                            )}
                          >
                            {INVOICE_STATUS_LABELS[i.display_status]}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        {i.einvoice_status === 'none' ? (
                          <span className="text-sm text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                              EINVOICE_STYLES[i.einvoice_status],
                            )}
                            // The UUID a person recorded, for whoever needs to quote it.
                            title={i.einvoice_uuid ?? undefined}
                          >
                            {EINVOICE_STATUS_LABELS[i.einvoice_status]}
                          </span>
                        )}
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={invoiceName(i)} items={items} />
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
            Showing {shown.length} of {matching.length} invoices
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
