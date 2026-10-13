'use client';

import { useState } from 'react';
import { Ban, Banknote, ChartColumn, Download, FileCheck, FileText, Pencil, PieChart, Plus, Search, Trash2 } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, DonutStat, type Series } from '@/components/charts';
import { BillFormCard, type BillFormActions } from '@/components/finance/bill-form-card';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { PaymentFormCard, type RecordPayment } from '@/components/finance/payment-form-card';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { type AttachedReceiptLinkOf, AttachedReceipts } from '@/components/finance/attached-receipts';
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
import type { BillOrderOption } from '@/lib/finance/bill-form';
import type { BillDetail, BillDisplayStatus, BillListRow } from '@/lib/finance/bills';
import type { FinanceContact } from '@/lib/finance/contacts';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { FinanceAccount, PaymentOutRow } from '@/lib/finance/money';
import { payableBills } from '@/lib/finance/payment-form';
import type { FinanceProduct } from '@/lib/finance/products';
import {
  BILL_STATUS_LABELS,
  type BillFilter,
  type BillsViewData,
  LATEST_ROWS,
  billsCsv,
  displayDate,
  filterBills,
} from '@/lib/finance/purchase-views';
import type { ReceiptsByDocument } from '@/lib/finance/receipt-match';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

export type BillActions = BillFormActions & {
  post: (input: unknown) => Promise<FinResult<{ id: string; bill_no: string }>>;
  voidBill: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Reads one draft with its lines, for the Edit form. */
  get: (input: unknown) => Promise<FinResult<BillDetail>>;
  recordPayment: RecordPayment;
};

/** What only a person who may edit is given: the actions, and what the two forms offer. */
export type BillsWriter = {
  actions: BillActions;
  /** Active suppliers, by name. */
  suppliers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  /** Approved purchase orders, and those the drafts are linked to, for the bill form's picker. */
  orders: BillOrderOption[];
  /** Active expense categories for the bill form's picker. */
  categories: { id: string; name: string }[];
  /** The category a new bill starts in. */
  defaultCategoryId: string;
  accounts: FinanceAccount[];
  /** Every payment row, to know what scheduled payments already hold of each bill. */
  payments: PaymentOutRow[];
};

const SUPPLIER_SERIES: Series[] = [{ key: 'value', label: 'Outstanding (RM)', color: 'var(--chart-1)' }];

const STATUS_STYLES: Record<BillDisplayStatus, string> = {
  paid: 'bg-emerald-500/15 text-emerald-600',
  pending: 'bg-amber-500/15 text-amber-600',
  overdue: 'bg-red-500/15 text-red-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

/** One thing open at a time: a form card, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  /** `detail` is null while the draft's lines are being read. */
  | { kind: 'edit'; bill: BillListRow; detail: BillDetail | null; today: string }
  | { kind: 'pay'; bill: BillListRow; today: string }
  | { kind: 'post'; bill: BillListRow }
  | { kind: 'void'; bill: BillListRow }
  | { kind: 'delete'; bill: BillListRow }
  | null;

const billName = (bill: BillListRow) => `${bill.bill_no ?? 'the draft bill'} from ${bill.supplier_name}`;

export function BillsView({
  rows,
  view,
  held,
  receipts,
  receiptLinkOf,
  writer,
}: {
  /** Every bill, newest first; drafts and void ones included. */
  rows: BillListRow[];
  /** The receipts tied to each bill, by the bill's id, from the Receipts Inbox. Absent with no database. */
  receipts?: ReceiptsByDocument;
  /** Makes a one-minute link to a receipt's file, for anyone who can see it. */
  receiptLinkOf?: AttachedReceiptLinkOf;
  view: BillsViewData;
  /** What payments not yet paid already hold of each bill, by bill id, from `heldByBill`. */
  held: Record<string, number>;
  writer?: BillsWriter;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BillFilter>('open');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();
  const loader = useFinanceAction('read');

  const matching = filterBills(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 10 : 9;
  const billCount = view.byStatus.reduce((n, s) => n + s.value, 0);
  const payable = writer ? payableBills(rows, writer.payments) : [];
  const asking = open && (open.kind === 'post' || open.kind === 'void' || open.kind === 'delete') ? open : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen = open !== null && !asking;
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((b) => b.id === asking.bill.id) : false;
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

  const menu = (bill: BillListRow, actions: BillActions): RowMenuItem[] => {
    const voidItem: RowMenuItem = {
      label: 'Void',
      icon: Ban,
      destructive: true,
      opens: true,
      onSelect: () => ask({ kind: 'void', bill }),
    };
    if (bill.display_status === 'draft') {
      return [
        {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'edit', bill, detail: null, today: now() });
            loader.run(
              () => actions.get({ id: bill.id }),
              // Still waiting on this bill? Something else may have been opened meanwhile.
              (detail) => setOpen((cur) => (cur?.kind === 'edit' && cur.bill.id === bill.id ? { ...cur, detail } : cur)),
            );
          },
        },
        {
          label: 'Post',
          icon: FileCheck,
          opens: true,
          onSelect: () => ask({ kind: 'post', bill }),
        },
        {
          label: 'Delete',
          icon: Trash2,
          destructive: true,
          opens: true,
          onSelect: () => ask({ kind: 'delete', bill }),
        },
      ];
    }
    if (bill.display_status === 'pending' || bill.display_status === 'overdue') {
      // A bill whose balance is already covered by scheduled payments can take no more.
      const canPay = payable.some((b) => b.id === bill.id);
      return [
        ...(canPay
          ? [{ label: 'Pay', icon: Banknote, opens: true, onSelect: () => ask({ kind: 'pay', bill, today: now() }) }]
          : []),
        voidItem,
      ];
    }
    // Voiding a paid bill is refused while its payments stand; the choice stays, and the refusal says why.
    if (bill.display_status === 'paid') return [voidItem];
    return [];
  };

  const question = (bill: BillListRow) => {
    if (!writer || !asking || asking.bill.id !== bill.id) return null;
    const { actions } = writer;
    if (asking.kind === 'post') {
      return (
        <ConfirmRow
          key={bill.id}
          colSpan={columns}
          tone="default"
          icon={FileCheck}
          label={`Post ${billName(bill)}`}
          confirmLabel="Post"
          pendingLabel="Posting…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => confirm.run(() => actions.post({ id: bill.id }), close)}
          onCancel={close}
        >
          Post this bill? It gets its number and can no longer be edited, only voided.
        </ConfirmRow>
      );
    }
    if (asking.kind === 'void') {
      return (
        <ConfirmRow
          key={bill.id}
          colSpan={columns}
          icon={Ban}
          label={`Void ${billName(bill)}`}
          confirmLabel="Void bill"
          pendingLabel="Voiding…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => confirm.run(() => actions.voidBill({ id: bill.id }), close)}
          onCancel={close}
        >
          Void <span className="font-medium">{bill.bill_no}</span> from{' '}
          <span className="font-medium">{bill.supplier_name}</span> ({rm(bill.total)})? It stays in the list as Void and
          nothing more is owed on it. This cannot be undone. A bill that has payments cannot be voided until they are
          voided or deleted.
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={bill.id}
        colSpan={columns}
        label={`Delete ${billName(bill)}`}
        confirmLabel="Delete draft"
        pendingLabel="Deleting…"
        pending={confirm.pending}
        error={confirm.error}
        onConfirm={() => confirm.run(() => actions.remove({ id: bill.id }), close)}
        onCancel={close}
      >
        Delete the draft bill from <span className="font-medium">{bill.supplier_name}</span> ({rm(bill.total)})? This
        cannot be undone.
      </ConfirmRow>
    );
  };

  const card = () => {
    if (!writer || !open) return null;
    const { actions } = writer;
    if (open.kind === 'new') {
      return (
        <BillFormCard
          key={open.nonce}
          suppliers={writer.suppliers}
          products={writer.products}
          orders={writer.orders}
          categories={writer.categories}
          defaultCategoryId={writer.defaultCategoryId}
          rows={rows}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      );
    }
    if (open.kind === 'edit') {
      return open.detail ? (
        <BillFormCard
          // A different draft gets a fresh form.
          key={open.detail.id}
          editing={open.detail}
          suppliers={writer.suppliers}
          products={writer.products}
          orders={writer.orders}
          categories={writer.categories}
          defaultCategoryId={writer.defaultCategoryId}
          rows={rows}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      ) : (
        <BentoCard title="Edit bill" subtitle={`The draft from ${open.bill.supplier_name}`} icon={FileText} className="col-span-2 md:col-span-12">
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
        <PaymentFormCard
          key={open.bill.id}
          payable={payable}
          accounts={writer.accounts}
          today={open.today}
          preselect={{ supplierId: open.bill.supplier_id, billId: open.bill.id }}
          record={actions.recordPayment}
          onClose={close}
        />
      );
    }
    return null;
  };

  // The question's own message shows in its row; beside the filters only while its row is out of view.
  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Supplier Bills"
        subtitle="Bills payable to your suppliers, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New Bill
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
          title="Payable by supplier"
          subtitle="Outstanding balance · RM"
          icon={ChartColumn}
          className="col-span-2 md:col-span-8"
        >
          {view.bySupplier.length ? (
            <BarGroup data={view.bySupplier} series={SUPPLIER_SERIES} horizontal height={220} />
          ) : (
            <p className="grid h-55 place-items-center text-sm text-muted-foreground">No open balances.</p>
          )}
        </BentoCard>
        <BentoCard title="Bills by status" subtitle="Current book" icon={PieChart} className="col-span-2 md:col-span-4">
          {billCount === 0 ? (
            <p className="grid h-55 place-items-center text-sm text-muted-foreground">No bills yet.</p>
          ) : (
            <DonutStat data={view.byStatus} height={220} centerValue={String(billCount)} centerLabel="bills" />
          )}
        </BentoCard>

        <BentoCard
          title="Bills"
          subtitle="What your suppliers have billed you"
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
                aria-label="Search bills by number or supplier"
                placeholder="Search bills or suppliers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as BillFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('supplier-bills', now()), billsCsv(matching))}
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
                  <TableHead>Supplier</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Purchase order</TableHead>
                  <TableHead className="hidden 2xl:table-cell">Category</TableHead>
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
                        No supplier bills yet.{writer ? ' Add the first one with New Bill.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((b) => {
                  const asked = question(b);
                  if (asked) return asked;
                  const items = writer ? menu(b, writer.actions) : [];
                  // A balance that scheduled payments already hold says so: such a bill may have no Pay choice.
                  const scheduled = b.display_status === 'pending' || b.display_status === 'overdue' ? (held[b.id] ?? 0) : 0;
                  return (
                    <TableRow key={b.id} className={cn(b.display_status === 'void' && 'opacity-60')}>
                      <TableCell className="min-w-36 font-medium">
                        <span className="whitespace-nowrap">{b.bill_no ?? '—'}</span>
                        <AttachedReceipts receipts={receipts?.[b.id]} linkOf={receiptLinkOf} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(b.bill_date)}</TableCell>
                      <TableCell className="whitespace-nowrap">{b.supplier_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(b.due_date)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(b.total)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {rm(b.balance)}
                        {scheduled > 0 ? (
                          <span className="block text-xs text-muted-foreground">{rm(scheduled)} in payments not yet paid</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={b.display_status === 'paid'} />
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[b.display_status],
                            )}
                          >
                            {BILL_STATUS_LABELS[b.display_status]}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{b.purchase_order_no ?? '—'}</TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground 2xl:table-cell">{b.category_name ?? '—'}</TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={billName(b)} items={items} />
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
            Showing {shown.length} of {matching.length} bills
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
