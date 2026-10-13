'use client';

import { useState } from 'react';
import {
  Ban,
  Check,
  ClipboardCheck,
  Download,
  FilePlus,
  Lock,
  PackageCheck,
  PackageX,
  Pencil,
  Plus,
  Search,
  Send,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { PurchaseOrderApproveCard } from '@/components/finance/purchase-order-approve-card';
import { downloadCsv } from '@/components/finance/download-csv';
import { PurchaseOrderFormCard, type PurchaseOrderFormActions } from '@/components/finance/purchase-order-form-card';
import { type ReceivePurchaseOrder, PurchaseOrderReceiveCard } from '@/components/finance/purchase-order-receive-card';
import { type DecidePurchaseOrder, PurchaseOrderRejectCard } from '@/components/finance/purchase-order-reject-card';
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
import type { FinanceContact } from '@/lib/finance/contacts';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { FinanceProduct } from '@/lib/finance/products';
import {
  PO_DELIVERY_LABELS,
  PO_STATUS_LABELS,
  type PurchaseOrderAction,
  type PurchaseOrderFilter,
  filterPurchaseOrders,
  purchaseOrderActions,
  purchaseOrderName,
  purchaseOrdersCsv,
  purchaseOrdersView,
} from '@/lib/finance/purchase-views';
import type { PurchaseOrderDetail, PurchaseOrderListRow, PurchaseOrderStatus } from '@/lib/finance/purchase-orders';
import type { FinResult } from '@/lib/finance/result';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type PurchaseOrderActions = PurchaseOrderFormActions & {
  submit: (input: unknown) => Promise<FinResult<{ id: string; po_no: string }>>;
  /** Approve, or reject with a reason. */
  decide: DecidePurchaseOrder;
  withdraw: (input: unknown) => Promise<FinResult<{ id: string }>>;
  receive: ReceivePurchaseOrder;
  close: (input: unknown) => Promise<FinResult<{ id: string }>>;
  cancel: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Makes a draft bill against an approved order, dated `bill_date`. */
  billFrom: (input: unknown) => Promise<FinResult<{ id: string; bill_id: string }>>;
  /** Reads one draft with its lines, for the Edit form. */
  get: (input: unknown) => Promise<FinResult<PurchaseOrderDetail>>;
  /** Reads one approved order with its lines, for Record delivery. */
  getApproved: (input: unknown) => Promise<FinResult<PurchaseOrderDetail>>;
  /** Reads one order awaiting approval with its lines, for Approve and Reject. */
  getPending: (input: unknown) => Promise<FinResult<PurchaseOrderDetail>>;
};

/** What only a person who may edit is given: who they are, the actions, and what the form offers. */
export type PurchaseOrdersWriter = {
  /** Decides which actions each row's menu offers. */
  viewer: { userId: string; canSignOff: boolean; isOwner: boolean };
  actions: PurchaseOrderActions;
  /** Active suppliers, by name. */
  suppliers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
};

const STATUS_STYLES: Record<PurchaseOrderStatus, string> = {
  approved: 'bg-emerald-500/15 text-emerald-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  cancelled: 'bg-red-500/15 text-red-600',
  closed: 'bg-muted text-muted-foreground line-through',
  draft: 'bg-muted text-muted-foreground',
};

/** A question asked in an order's own row. The rest open a card, or (Create bill, with nothing billed yet) just happen. */
type Question = Extract<PurchaseOrderAction, 'submit' | 'delete' | 'withdraw' | 'close' | 'cancel' | 'createBill'>;

/** One thing open at a time: a form card, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  /** `detail` is null while the draft's lines are being read. */
  | { kind: 'edit'; order: PurchaseOrderListRow; detail: PurchaseOrderDetail | null; today: string }
  /** `detail` is null while the approved order's lines are being read. */
  | { kind: 'receive'; order: PurchaseOrderListRow; detail: PurchaseOrderDetail | null }
  /** `detail` is null while the order's lines are being read, for the person deciding. */
  | { kind: 'approve' | 'reject'; order: PurchaseOrderListRow; detail: PurchaseOrderDetail | null }
  /** A draft bill has just been made from this order, dated `date`. */
  | { kind: 'billed'; order: PurchaseOrderListRow; date: string }
  | { kind: Question; order: PurchaseOrderListRow }
  | null;

/**
 * What to ask before making a bill from an order that already has bills against it, or null when nothing is
 * billed and the bill is simply made.
 */
export function createBillQuestion(order: PurchaseOrderListRow): string | null {
  if (!(order.billed_total > 0)) return null;
  return `${order.po_no ?? 'This order'} already has ${rm(order.billed_total)} billed. Make another draft bill for the full order?`;
}

/**
 * Purchase orders: the figures and the table, with search, a status filter and
 * Export for everybody. A person who may edit (`writer`) also gets New purchase
 * order and a menu on each row that offers what its status, and they, may do.
 */
export function PurchaseOrdersView({ rows, writer }: { rows: PurchaseOrderListRow[]; writer?: PurchaseOrdersWriter }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PurchaseOrderFilter>('open');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();
  const loader = useFinanceAction('read');

  const view = purchaseOrdersView(rows);
  const matching = filterPurchaseOrders(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 10 : 9;
  const asking =
    open &&
    open.kind !== 'new' &&
    open.kind !== 'edit' &&
    open.kind !== 'receive' &&
    open.kind !== 'approve' &&
    open.kind !== 'reject' &&
    open.kind !== 'billed'
      ? open
      : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen =
    open?.kind === 'new' || open?.kind === 'edit' || open?.kind === 'receive' || open?.kind === 'approve' || open?.kind === 'reject';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((r) => r.id === asking.order.id) : false;
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

  /** Opens Approve or Reject, then reads the order's lines into it. */
  const decide = (kind: 'approve' | 'reject', order: PurchaseOrderListRow, actions: PurchaseOrderActions) => {
    loader.clear();
    ask({ kind, order, detail: null });
    loader.run(
      () => actions.getPending({ id: order.id }),
      (detail) => setOpen((cur) => (cur?.kind === kind && cur.order.id === order.id ? { ...cur, detail } : cur)),
    );
  };

  const menuItem = (order: PurchaseOrderListRow, action: PurchaseOrderAction, actions: PurchaseOrderActions): RowMenuItem => {
    switch (action) {
      case 'edit':
        return {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'edit', order, detail: null, today: now() });
            loader.run(
              () => actions.get({ id: order.id }),
              // Still waiting on this order? Something else may have been opened meanwhile.
              (detail) => setOpen((cur) => (cur?.kind === 'edit' && cur.order.id === order.id ? { ...cur, detail } : cur)),
            );
          },
        };
      case 'receive':
        return {
          label: 'Record delivery',
          icon: PackageCheck,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'receive', order, detail: null });
            loader.run(
              () => actions.getApproved({ id: order.id }),
              (detail) => setOpen((cur) => (cur?.kind === 'receive' && cur.order.id === order.id ? { ...cur, detail } : cur)),
            );
          },
        };
      case 'reject':
        return { label: 'Reject', icon: X, opens: true, onSelect: () => decide('reject', order, actions) };
      case 'createBill':
        return {
          label: 'Create bill',
          icon: FilePlus,
          opens: true,
          onSelect: () => (createBillQuestion(order) ? ask({ kind: 'createBill', order }) : makeBill(order)),
        };
      case 'submit':
        return { label: 'Submit for approval', icon: Send, opens: true, onSelect: () => ask({ kind: 'submit', order }) };
      case 'approve':
        return { label: 'Approve', icon: Check, opens: true, onSelect: () => decide('approve', order, actions) };
      case 'withdraw':
        return { label: 'Withdraw', icon: Undo2, opens: true, onSelect: () => ask({ kind: 'withdraw', order }) };
      case 'close':
        return { label: 'Close order', icon: Lock, opens: true, onSelect: () => ask({ kind: 'close', order }) };
      case 'cancel':
        return { label: 'Cancel order', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'cancel', order }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', order }) };
    }
  };

  /** The bill is a draft, dated the person's own today (the database's is UTC, a day behind until 08:00 in Malaysia). */
  const makeBill = (order: PurchaseOrderListRow, fromQuestion = false) => {
    if (!writer) return;
    const date = now();
    // Asked in its row, the row stays up while it works so a refusal is read there.
    if (!fromQuestion) close();
    confirm.run(
      () => writer.actions.billFrom({ id: order.id, bill_date: date }),
      // The note at the top of the page says where the bill is.
      () => setOpen({ kind: 'billed', order, date }),
    );
  };

  const question = (order: PurchaseOrderListRow) => {
    if (!writer || !asking || asking.order.id !== order.id) return null;
    const { actions } = writer;
    const id = { id: order.id };
    const name = purchaseOrderName(order);
    const who = <span className="font-medium">{order.supplier_name}</span>;
    const number = <span className="font-medium">{order.po_no ?? 'This draft'}</span>;
    const shared = { colSpan: columns, pending: confirm.pending, error: confirm.error, onCancel: close };
    switch (asking.kind) {
      case 'createBill':
        return (
          <ConfirmRow
            key={order.id}
            {...shared}
            tone="default"
            icon={FilePlus}
            label={`Create a bill from ${name}`}
            confirmLabel="Create bill"
            pendingLabel="Creating…"
            onConfirm={() => makeBill(order, true)}
          >
            {createBillQuestion(order)}
          </ConfirmRow>
        );
      case 'submit':
        return (
          <ConfirmRow
            key={order.id}
            {...shared}
            tone="default"
            icon={Send}
            label={`Submit ${name} for approval`}
            confirmLabel="Submit for approval"
            pendingLabel="Submitting…"
            onConfirm={() => confirm.run(() => actions.submit(id), close)}
          >
            Submit the order to {who} ({rm(order.total)}) for approval? It gets its number, and an owner or admin other than
            you has to approve it before anything is bought.
          </ConfirmRow>
        );
      case 'withdraw':
        return (
          <ConfirmRow
            key={order.id}
            {...shared}
            tone="default"
            icon={Undo2}
            label={`Withdraw ${name}`}
            confirmLabel="Withdraw"
            pendingLabel="Withdrawing…"
            onConfirm={() => confirm.run(() => actions.withdraw(id), close)}
          >
            Withdraw {number} to {who} from approval? It goes back to a draft that can be changed and submitted again.
          </ConfirmRow>
        );
      case 'close':
        return (
          <ConfirmRow
            key={order.id}
            {...shared}
            tone="default"
            icon={Lock}
            label={`Close ${name}`}
            confirmLabel="Close order"
            pendingLabel="Closing…"
            onConfirm={() => confirm.run(() => actions.close(id), close)}
          >
            Close {number} to {who}? Use this once the order is fully dealt with. A closed order cannot be changed or reopened.
          </ConfirmRow>
        );
      case 'cancel':
        return (
          <ConfirmRow
            key={order.id}
            {...shared}
            icon={Ban}
            label={`Cancel ${name}`}
            confirmLabel="Cancel order"
            pendingLabel="Cancelling…"
            onConfirm={() => confirm.run(() => actions.cancel(id), close)}
          >
            Cancel {number} to {who}? A cancelled order cannot be changed or reopened, and its number is not used again.
          </ConfirmRow>
        );
      case 'delete':
        return (
          <ConfirmRow
            key={order.id}
            {...shared}
            label={`Delete ${name}`}
            confirmLabel="Delete draft"
            pendingLabel="Deleting…"
            onConfirm={() => confirm.run(() => actions.remove(id), close)}
          >
            Delete the draft purchase order to {who}? This cannot be undone.
          </ConfirmRow>
        );
    }
  };

  /** The card that stands in while an order is read, or says it could not be. */
  const loading = (title: string, subtitle: string) => (
    <BentoCard title={title} subtitle={subtitle} icon={ClipboardCheck} className="col-span-2 md:col-span-12">
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
    const { actions } = writer;
    if (open.kind === 'new') {
      return (
        <PurchaseOrderFormCard
          key={open.nonce}
          suppliers={writer.suppliers}
          products={writer.products}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      );
    }
    if (open.kind === 'edit') {
      return open.detail ? (
        <PurchaseOrderFormCard
          // A different draft gets a fresh form.
          key={open.detail.id}
          editing={open.detail}
          suppliers={writer.suppliers}
          products={writer.products}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      ) : (
        loading('Edit purchase order', `The draft to ${open.order.supplier_name}`)
      );
    }
    if (open.kind === 'receive') {
      return open.detail ? (
        <PurchaseOrderReceiveCard key={open.detail.id} order={open.detail} receive={actions.receive} onClose={close} />
      ) : (
        loading('Record delivery', `${open.order.po_no ?? 'The order'} from ${open.order.supplier_name}`)
      );
    }
    if (open.kind === 'approve') {
      return open.detail ? (
        <PurchaseOrderApproveCard key={open.detail.id} order={open.detail} decide={actions.decide} onClose={close} />
      ) : (
        loading('Approve purchase order', `${open.order.po_no ?? 'The order'} to ${open.order.supplier_name}`)
      );
    }
    if (open.kind === 'reject') {
      return open.detail ? (
        <PurchaseOrderRejectCard key={open.detail.id} order={open.detail} decide={actions.decide} onClose={close} />
      ) : (
        loading('Reject purchase order', `${open.order.po_no ?? 'The order'} to ${open.order.supplier_name}`)
      );
    }
    if (open.kind === 'billed') {
      return (
        <SavedNoteCard
          title="Draft bill made"
          subtitle={`From ${open.order.po_no ?? 'the purchase order'} to ${open.order.supplier_name}`}
          href="/finance/supplier-bills"
          linkLabel="Supplier Bills"
          onClose={close}
        >
          It has the order’s supplier and lines, and is dated {displayDate(open.date)}. It is a draft: check it, then post it, on
        </SavedNoteCard>
      );
    }
    return null;
  };

  // The question's own message shows in its row; beside the filters while its row is out of view, and for Create bill, which has no row of its own.
  const tableError = confirm.error && !(asking && askingInView) ? confirm.error : null;

  const stats = [
    { label: 'Awaiting approval', value: view.awaitingApproval },
    { label: 'Approved and open', value: view.approvedOpen },
    { label: 'Billed over the order', value: view.overBilled },
  ];

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Purchase Orders"
        subtitle="Orders to your suppliers, from approval to delivery and billing, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New purchase order
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {card()}

        {stats.map((s, i) => (
          <BentoCard
            key={s.label}
            tone={i === 0 ? 'primary' : 'default'}
            // Three cards on a two-column phone grid: the last takes the whole row rather than sitting alone at half width.
            className={i === stats.length - 1 ? 'col-span-2 md:col-span-4' : 'col-span-1 md:col-span-4'}
          >
            <BentoStat label={s.label} value={String(s.value)} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard
          title="Purchase orders"
          subtitle="What you have ordered from your suppliers"
          icon={ClipboardCheck}
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
                aria-label="Search purchase orders by number, supplier or RFQ number"
                placeholder="Search orders or suppliers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as PurchaseOrderFilter)}>
              <SelectTrigger className="w-44" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="pending_approval">Awaiting approval</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('purchase-orders', now()), purchaseOrdersCsv(matching))}
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
                  <TableHead>Supplier</TableHead>
                  <TableHead>Order date</TableHead>
                  <TableHead className="hidden 2xl:table-cell">Expected</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead className="text-right">Billed</TableHead>
                  <TableHead className="hidden 2xl:table-cell">RFQ</TableHead>
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
                        No purchase orders yet.{writer ? ' Add the first one with New purchase order.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((r) => {
                  const asked = question(r);
                  if (asked) return asked;
                  const items = writer ? purchaseOrderActions(r, writer.viewer).map((action) => menuItem(r, action, writer.actions)) : [];
                  return (
                    <TableRow key={r.id} className={cn((r.status === 'closed' || r.status === 'cancelled') && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap font-medium">{r.po_no ?? 'Draft'}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.supplier_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(r.po_date)}</TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground 2xl:table-cell">
                        {r.expected_date ? displayDate(r.expected_date) : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(r.total)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={r.status === 'approved'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[r.status],
                            )}
                          >
                            {PO_STATUS_LABELS[r.status]}
                          </span>
                        </span>
                        {r.status === 'draft' && r.rejection_reason ? (
                          <span className="mt-1 block max-w-64 whitespace-normal text-xs text-muted-foreground">
                            Rejected: {r.rejection_reason}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {r.status === 'approved' || r.status === 'closed' ? PO_DELIVERY_LABELS[r.delivery] : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        <span className="inline-flex items-center justify-end gap-1.5">
                          {r.over_billed ? (
                            <span title="Billed more than the order" className="text-amber-600">
                              <TriangleAlert className="size-4" aria-hidden />
                              <span className="sr-only">Billed more than the order</span>
                            </span>
                          ) : null}
                          {r.billed_over_received ? (
                            <span title="Billed more than has been received" className="text-amber-600">
                              <PackageX className="size-4" aria-hidden />
                              <span className="sr-only">Billed more than has been received</span>
                            </span>
                          ) : null}
                          {rm(r.billed_total)}
                        </span>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground 2xl:table-cell">{r.rfq_no ?? '—'}</TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={purchaseOrderName(r)} items={items} />
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
            Showing {shown.length} of {matching.length} purchase orders
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
