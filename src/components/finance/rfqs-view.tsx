'use client';

import { useState } from 'react';
import { ClipboardCheck, Copy, Download, Lock, MessageSquare, Pencil, Plus, Scale, Search, Send, Tag, Trash2 } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { RfqCompareCard } from '@/components/finance/rfq-compare-card';
import { RfqFormCard, type RfqFormActions } from '@/components/finance/rfq-form-card';
import { type QuoteRfq, RfqPricesCard } from '@/components/finance/rfq-prices-card';
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
import type { FinanceContact } from '@/lib/finance/contacts';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { FinanceProduct } from '@/lib/finance/products';
import {
  RFQ_STATUS_LABELS,
  type RfqAction,
  type RfqFilter,
  filterRfqs,
  rfqActions,
  rfqDisplayStatus,
  rfqName,
  rfqsCsv,
  rfqsView,
} from '@/lib/finance/purchase-views';
import type { FinResult } from '@/lib/finance/result';
import { comparableRfqIds, rfqDeleteWarning } from '@/lib/finance/rfq-compare';
import type { RfqDetail, RfqDisplayStatus, RfqListRow } from '@/lib/finance/rfqs';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { localIsoDate } from '@/lib/finance/bill-math';
import { cn } from '@/lib/utils';

export type RfqActions = RfqFormActions & {
  send: (input: unknown) => Promise<FinResult<{ id: string; rfq_no: string }>>;
  quote: QuoteRfq;
  close: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Makes a draft purchase order from a quoted RFQ. */
  convert: (input: unknown) => Promise<FinResult<unknown>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Reads one draft with its lines, for the Edit form. */
  get: (input: unknown) => Promise<FinResult<RfqDetail>>;
  /** Reads one sent RFQ with its lines, for Record prices. */
  getSent: (input: unknown) => Promise<FinResult<RfqDetail>>;
  /** Reads one RFQ in any status with its lines, to start a new RFQ from it. */
  getForCopy: (input: unknown) => Promise<FinResult<RfqDetail>>;
  /** Reads the RFQs of one RFQ's group that have gone to their supplier, with their lines, for Compare quotes. */
  getComparison: (input: unknown) => Promise<FinResult<RfqDetail[]>>;
};

/** What only a person who may edit is given: the actions, and what the form offers. */
export type RfqsWriter = {
  actions: RfqActions;
  /** Active suppliers, by name. */
  suppliers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
};

const STATUS_STYLES: Record<RfqDisplayStatus, string> = {
  quoted: 'bg-emerald-500/15 text-emerald-600',
  sent: 'bg-amber-500/15 text-amber-600',
  overdue: 'bg-red-500/15 text-red-600',
  closed: 'bg-muted text-muted-foreground line-through',
  draft: 'bg-muted text-muted-foreground',
};

/** A question asked in an RFQ's own row. `edit`, `recordPrices`, `copy` and `compare` are not: they open a card. */
type Question = Exclude<RfqAction, 'edit' | 'recordPrices' | 'copy' | 'compare'>;

/** One thing open at a time: a form card, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  /** `detail` is null while the draft's lines are being read. */
  | { kind: 'edit'; rfq: RfqListRow; detail: RfqDetail | null; today: string }
  /** `detail` is null while the sent RFQ's lines are being read. */
  | { kind: 'prices'; rfq: RfqListRow; detail: RfqDetail | null }
  /** `detail` is null while the RFQ to copy is being read. */
  | { kind: 'copy'; rfq: RfqListRow; detail: RfqDetail | null; today: string; nonce: number }
  /** `group` is null while the RFQs to compare are being read. */
  | { kind: 'compare'; rfq: RfqListRow; group: RfqDetail[] | null }
  /** A draft purchase order has just been made from this RFQ. */
  | { kind: 'converted'; rfq: RfqListRow }
  | { kind: Question; rfq: RfqListRow }
  | null;

/**
 * RFQs: the figures and the table, with search, a status filter and Export for
 * everybody. A person who may edit (`writer`) also gets New RFQ and a menu on
 * each row that offers what its status allows.
 */
export function RfqsView({
  rows,
  today: serverToday,
  followClock = true,
  writer,
}: {
  /** Every RFQ, newest first; drafts included. */
  rows: RfqListRow[];
  /** The date overdue replies are worked out from, YYYY-MM-DD. */
  today: string;
  /** False for the sample, whose day is fixed. */
  followClock?: boolean;
  writer?: RfqsWriter;
}) {
  const today = useLocalToday(serverToday, followClock);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RfqFilter>('open');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();
  const loader = useFinanceAction('read');

  const view = rfqsView(rows, today);
  const matching = filterRfqs(rows, query, filter, today);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 9 : 8;
  const asking =
    open && open.kind !== 'new' && open.kind !== 'edit' && open.kind !== 'prices' && open.kind !== 'copy' && open.kind !== 'compare' && open.kind !== 'converted' ? open : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen = open?.kind === 'new' || open?.kind === 'edit' || open?.kind === 'prices' || open?.kind === 'copy';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((r) => r.id === asking.rfq.id) : false;
  // Compare quotes is not a form, but it can make an order, so the rows wait while it is open too.
  const locked = confirm.pending || formOpen || open?.kind === 'compare';
  const comparable = comparableRfqIds(rows);
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

  const menuItem = (rfq: RfqListRow, action: RfqAction, actions: RfqActions): RowMenuItem => {
    switch (action) {
      case 'edit':
        return {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'edit', rfq, detail: null, today: now() });
            loader.run(
              () => actions.get({ id: rfq.id }),
              // Still waiting on this RFQ? Something else may have been opened meanwhile.
              (detail) => setOpen((cur) => (cur?.kind === 'edit' && cur.rfq.id === rfq.id ? { ...cur, detail } : cur)),
            );
          },
        };
      case 'recordPrices':
        return {
          label: 'Record prices',
          icon: Tag,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'prices', rfq, detail: null });
            loader.run(
              () => actions.getSent({ id: rfq.id }),
              (detail) => setOpen((cur) => (cur?.kind === 'prices' && cur.rfq.id === rfq.id ? { ...cur, detail } : cur)),
            );
          },
        };
      case 'copy':
        return {
          label: 'Copy to another supplier',
          icon: Copy,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'copy', rfq, detail: null, today: now(), nonce: Date.now() });
            loader.run(
              () => actions.getForCopy({ id: rfq.id }),
              (detail) => setOpen((cur) => (cur?.kind === 'copy' && cur.rfq.id === rfq.id ? { ...cur, detail } : cur)),
            );
          },
        };
      case 'compare':
        return {
          label: 'Compare quotes',
          icon: Scale,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'compare', rfq, group: null });
            loader.run(
              () => actions.getComparison({ id: rfq.id }),
              (group) => setOpen((cur) => (cur?.kind === 'compare' && cur.rfq.id === rfq.id ? { ...cur, group } : cur)),
            );
          },
        };
      case 'send':
        return { label: 'Mark as sent', icon: Send, opens: true, onSelect: () => ask({ kind: 'send', rfq }) };
      case 'convert':
        return { label: 'Make purchase order', icon: ClipboardCheck, opens: true, onSelect: () => ask({ kind: 'convert', rfq }) };
      case 'close':
        return { label: 'Close RFQ', icon: Lock, opens: true, onSelect: () => ask({ kind: 'close', rfq }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', rfq }) };
    }
  };

  const question = (rfq: RfqListRow) => {
    if (!writer || !asking || asking.rfq.id !== rfq.id) return null;
    const { actions } = writer;
    const id = { id: rfq.id };
    const name = rfqName(rfq);
    const who = <span className="font-medium">{rfq.supplier_name}</span>;
    const number = <span className="font-medium">{rfq.rfq_no}</span>;
    const shared = { colSpan: columns, pending: confirm.pending, error: confirm.error, onCancel: close };
    // Deleting the first RFQ of a group ends the comparison for its copies; the question says so.
    const copiesWarning = rfqDeleteWarning(rows, rfq);
    switch (asking.kind) {
      case 'send':
        return (
          <ConfirmRow
            key={rfq.id}
            {...shared}
            tone="default"
            icon={Send}
            label={`Mark ${name} as sent`}
            confirmLabel="Mark as sent"
            pendingLabel="Marking…"
            onConfirm={() => confirm.run(() => actions.send(id), close)}
          >
            Mark this RFQ to {who} as sent? It gets its number and can no longer be edited or deleted: after this, only the
            supplier’s answer is recorded. Nothing is emailed from here.
          </ConfirmRow>
        );
      case 'convert':
        return (
          <ConfirmRow
            key={rfq.id}
            {...shared}
            tone="default"
            icon={ClipboardCheck}
            label={`Make a purchase order from ${name}`}
            confirmLabel="Make purchase order"
            pendingLabel="Making…"
            onConfirm={() =>
              confirm.run(
                () => actions.convert(id),
                // The row's question goes; the note at the top of the page says where the order is.
                () => ask({ kind: 'converted', rfq }),
              )
            }
          >
            Make a draft purchase order from {number} to {who} ({rm(rfq.total)})? It gets the same supplier and lines, at the
            prices quoted, and stays a draft on Purchase Orders until it is submitted for approval.
          </ConfirmRow>
        );
      case 'close':
        return (
          <ConfirmRow
            key={rfq.id}
            {...shared}
            tone="default"
            icon={Lock}
            label={`Close ${name}`}
            confirmLabel="Close RFQ"
            pendingLabel="Closing…"
            onConfirm={() => confirm.run(() => actions.close(id), close)}
          >
            Close {number} to {who}? Use this for an RFQ that is no longer wanted, or one that has been dealt with. A closed
            RFQ cannot be changed or reopened.
          </ConfirmRow>
        );
      case 'delete':
        return (
          <ConfirmRow
            key={rfq.id}
            {...shared}
            label={`Delete ${name}`}
            confirmLabel="Delete draft"
            pendingLabel="Deleting…"
            onConfirm={() => confirm.run(() => actions.remove(id), close)}
          >
            Delete the draft RFQ to {who}? {copiesWarning ? `${copiesWarning} ` : ''}This cannot be undone.
          </ConfirmRow>
        );
    }
  };

  /** The card that stands in while a draft or a sent RFQ is read, or says it could not be. */
  const loading = (title: string, subtitle: string) => (
    <BentoCard title={title} subtitle={subtitle} icon={MessageSquare} className="col-span-2 md:col-span-12">
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
        <RfqFormCard
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
        <RfqFormCard
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
        loading('Edit RFQ', `The draft to ${open.rfq.supplier_name}`)
      );
    }
    if (open.kind === 'copy') {
      return open.detail ? (
        <RfqFormCard
          // Copying again, even from the same RFQ, starts a fresh form.
          key={open.nonce}
          copyOf={open.detail}
          suppliers={writer.suppliers}
          products={writer.products}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      ) : (
        loading('New RFQ', `Copying ${open.rfq.rfq_no ?? 'the draft'} to ${open.rfq.supplier_name}`)
      );
    }
    if (open.kind === 'compare') {
      const { rfq } = open;
      return open.group ? (
        <RfqCompareCard
          key={rfq.id}
          rfqs={open.group}
          convert={actions.convert}
          // After a refused order: the same read that opened the card. If it is refused too, the card keeps what it had.
          reload={async () => {
            const again = await actions.getComparison({ id: rfq.id });
            if (again.ok) setOpen((cur) => (cur?.kind === 'compare' && cur.rfq.id === rfq.id ? { ...cur, group: again.data } : cur));
          }}
          onConverted={(rfq) => ask({ kind: 'converted', rfq })}
          onClose={close}
        />
      ) : (
        loading('Compare quotes', `The quotes asked for with ${open.rfq.rfq_no ?? 'this RFQ'}`)
      );
    }
    if (open.kind === 'prices') {
      return open.detail ? (
        <RfqPricesCard key={open.detail.id} rfq={open.detail} quote={actions.quote} onClose={close} />
      ) : (
        loading('Record prices', `${open.rfq.rfq_no ?? 'The RFQ'} to ${open.rfq.supplier_name}`)
      );
    }
    if (open.kind === 'converted') {
      return (
        <SavedNoteCard
          title="Draft purchase order made"
          subtitle={`From ${open.rfq.rfq_no ?? 'the RFQ'} to ${open.rfq.supplier_name}`}
          href="/finance/purchase-orders"
          linkLabel="Purchase Orders"
          onClose={close}
        >
          It has the RFQ’s supplier and lines, at the prices quoted. It is a draft: check it, then submit it for approval, on
        </SavedNoteCard>
      );
    }
    return null;
  };

  // The question's own message shows in its row; beside the filters only while its row is out of view.
  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;

  const stats = [
    { label: 'Awaiting reply', value: view.awaitingReply },
    { label: 'Reply overdue', value: view.overdue },
    { label: 'Quoted', value: view.counts.quoted },
  ];

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="RFQs"
        subtitle="Requests for quotation sent to your suppliers, and their prices, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New RFQ
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
          title="RFQs"
          subtitle="What you have asked your suppliers to quote"
          icon={MessageSquare}
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
                aria-label="Search RFQs by number, supplier or supplier reference"
                placeholder="Search RFQs or suppliers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as RfqFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="overdue">Reply overdue</SelectItem>
                <SelectItem value="quoted">Quoted</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('rfqs', now()), rfqsCsv(matching, today))}
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
                  <TableHead>RFQ date</TableHead>
                  <TableHead>Reply by</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Quoted total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Purchase order</TableHead>
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
                        No RFQs yet.{writer ? ' Add the first one with New RFQ.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((r) => {
                  const asked = question(r);
                  if (asked) return asked;
                  const items = writer ? rfqActions(r, comparable.has(r.id)).map((action) => menuItem(r, action, writer.actions)) : [];
                  const status = rfqDisplayStatus(r, today);
                  return (
                    <TableRow key={r.id} className={cn(r.status === 'closed' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap font-medium">{r.rfq_no ?? 'Draft'}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.supplier_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(r.rfq_date)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {r.reply_by ? displayDate(r.reply_by) : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{r.line_count}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {r.quoted_at ? rm(r.total) : '—'}
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={status === 'quoted'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[status],
                            )}
                          >
                            {RFQ_STATUS_LABELS[status]}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{r.purchase_order_no ?? '—'}</TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={rfqName(r)} items={items} />
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
            Showing {shown.length} of {matching.length} RFQs
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
