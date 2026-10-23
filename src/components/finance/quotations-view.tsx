'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChartColumn, Check, Download, FilePlus, FileText, Pencil, Plus, Search, Send, Trash2, TrendingUp, X } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, FunnelFlow, type Series } from '@/components/charts';
import { AgentNoteMarker } from '@/components/finance/agent-note-marker';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { QuotationFormCard, type QuotationFormActions } from '@/components/finance/quotation-form-card';
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
import type { NoteCounts } from '@/lib/finance/agent/notes';
import { localIsoDate } from '@/lib/finance/bill-math';
import type { FinanceContact } from '@/lib/finance/contacts';
import { csvFileName } from '@/lib/finance/csv';
import { money, rm } from '@/lib/finance/format';
import type { FinanceProduct } from '@/lib/finance/products';
import { longDate } from '@/lib/finance/fx-rates';
import {
  type ConvertedInvoice,
  type QuotationDetail,
  type QuotationDisplayStatus,
  type QuotationListRow,
  convertedInvoiceNote,
} from '@/lib/finance/quotations';
import type { FinResult } from '@/lib/finance/result';
import {
  QUOTATION_STATUS_LABELS,
  type QuotationAction,
  type QuotationFilter,
  type QuotationsViewData,
  customersOf,
  filterQuotations,
  quotationActions,
  quotationInvoice,
  quotationName,
  quotationsCsv,
  quotationsHaveForeign,
} from '@/lib/finance/sales-followon-views';
import { customerChoice } from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type QuotationActions = QuotationFormActions & {
  send: (input: unknown) => Promise<FinResult<{ id: string; quotation_no: string }>>;
  accept: (input: unknown) => Promise<FinResult<{ id: string }>>;
  decline: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Reads one draft with its lines, for the Edit form. */
  get: (input: unknown) => Promise<FinResult<QuotationDetail>>;
  convert: (input: unknown) => Promise<FinResult<{ id: string; invoice_id: string; invoice: ConvertedInvoice }>>;
};

/** What only a person who may edit is given: the actions, and what the form offers. */
export type QuotationsWriter = {
  actions: QuotationActions;
  /** Active customers, by name. */
  customers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
};

const TREND_SERIES: Series[] = [
  { key: 'quoted', label: 'Quoted (RM k)', color: 'var(--chart-1)' },
  { key: 'accepted', label: 'Accepted (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<QuotationDisplayStatus, string> = {
  accepted: 'bg-emerald-500/15 text-emerald-600',
  sent: 'bg-amber-500/15 text-amber-600',
  expired: 'bg-red-500/15 text-red-600',
  declined: 'bg-muted text-muted-foreground line-through',
  draft: 'bg-muted text-muted-foreground',
};

/** A question asked in a quotation's own row. `edit` is not one: it opens the form card. */
type Question = Exclude<QuotationAction, 'edit'>;

/** One thing open at a time: the form card, the note that an invoice was made, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  /** `detail` is null while the draft's lines are being read. */
  | { kind: 'edit'; quotation: QuotationListRow; detail: QuotationDetail | null; today: string }
  /** A draft invoice has just been made from this quotation, dated `date`. */
  | { kind: 'converted'; quotation: QuotationListRow; date: string; invoice: ConvertedInvoice }
  | { kind: Question; quotation: QuotationListRow }
  | null;

/**
 * Quotations: figures, charts and the table, with search, filters, "View all"
 * and Export for everybody. A person who may edit (`writer`) also gets New
 * Quotation and a menu on each row that offers what its status allows.
 */
export function QuotationsView({
  rows,
  view,
  writer,
  agentNotes,
}: {
  /** Every quotation, newest first; drafts included. */
  rows: QuotationListRow[];
  view: QuotationsViewData;
  writer?: QuotationsWriter;
  /** Notes the agent left, by document id, for the ids shown. Absent with no database or when they could not be read. */
  agentNotes?: NoteCounts;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<QuotationFilter>('all');
  const [chosenCustomer, setCustomer] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();
  const loader = useFinanceAction('read');
  const invoicesLink = useRef<HTMLAnchorElement>(null);
  // The note that an invoice was made opens at the top of the page, away from the row that was used:
  // its link takes focus once, when the note opens, which also scrolls it into view.
  const converted = open?.kind === 'converted' ? open.quotation.id : null;
  useEffect(() => {
    if (converted) invoicesLink.current?.focus();
  }, [converted]);

  const customers = customersOf(rows);
  // A refresh can take the chosen customer's last quotation away: the filter then goes back to everyone, and stays there.
  const customer = customerChoice(chosenCustomer, customers);
  if (customer !== chosenCustomer) setCustomer(customer);
  const matching = filterQuotations(rows, query, filter, customer);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 8 : 7;
  // Only once a quotation is in another currency does a total carry its ringgit beside it.
  const foreign = quotationsHaveForeign(rows);
  const asking = open && open.kind !== 'new' && open.kind !== 'edit' && open.kind !== 'converted' ? open : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen = open?.kind === 'new' || open?.kind === 'edit';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((q) => q.id === asking.quotation.id) : false;
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

  const menuItem = (quotation: QuotationListRow, action: QuotationAction, actions: QuotationActions): RowMenuItem => {
    switch (action) {
      case 'edit':
        return {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'edit', quotation, detail: null, today: now() });
            loader.run(
              () => actions.get({ id: quotation.id }),
              // Still waiting on this quotation? Something else may have been opened meanwhile.
              (detail) =>
                setOpen((cur) => (cur?.kind === 'edit' && cur.quotation.id === quotation.id ? { ...cur, detail } : cur)),
            );
          },
        };
      case 'send':
        return { label: 'Mark as sent', icon: Send, opens: true, onSelect: () => ask({ kind: 'send', quotation }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', quotation }) };
      case 'accept':
        return { label: 'Mark accepted', icon: Check, opens: true, onSelect: () => ask({ kind: 'accept', quotation }) };
      case 'decline':
        return { label: 'Mark declined', icon: X, opens: true, onSelect: () => ask({ kind: 'decline', quotation }) };
      case 'convert':
        return { label: 'Make invoice', icon: FilePlus, opens: true, onSelect: () => ask({ kind: 'convert', quotation }) };
    }
  };

  const question = (quotation: QuotationListRow) => {
    if (!writer || !asking || asking.quotation.id !== quotation.id) return null;
    const { actions } = writer;
    const id = { id: quotation.id };
    const name = quotationName(quotation);
    const who = <span className="font-medium">{quotation.customer_name}</span>;
    const number = <span className="font-medium">{quotation.quotation_no}</span>;
    const shared = { colSpan: columns, pending: confirm.pending, error: confirm.error, onCancel: close };
    switch (asking.kind) {
      case 'send':
        return (
          <ConfirmRow
            key={quotation.id}
            {...shared}
            tone="default"
            icon={Send}
            label={`Mark ${name} as sent`}
            confirmLabel="Mark as sent"
            pendingLabel="Marking…"
            onConfirm={() => confirm.run(() => actions.send(id), close)}
          >
            Mark this quotation to {who} ({money(quotation.total, quotation.currency)}) as sent? It gets its number and can no longer be edited or
            deleted: after this, only the customer’s answer is recorded. Nothing is emailed from here.
          </ConfirmRow>
        );
      case 'accept':
        return (
          <ConfirmRow
            key={quotation.id}
            {...shared}
            tone="default"
            icon={Check}
            label={`Mark ${name} as accepted`}
            confirmLabel="Mark accepted"
            pendingLabel="Saving…"
            onConfirm={() => confirm.run(() => actions.accept(id), close)}
          >
            Record that {who} accepted {number} ({money(quotation.total, quotation.currency)})?
            {quotation.display_status === 'expired' ? ' It is past its valid-until date; accepting it is still your call.' : ''}{' '}
            The answer can be changed until an invoice is made from the quotation.
          </ConfirmRow>
        );
      case 'decline':
        return (
          <ConfirmRow
            key={quotation.id}
            {...shared}
            tone="default"
            icon={X}
            label={`Mark ${name} as declined`}
            confirmLabel="Mark declined"
            pendingLabel="Saving…"
            onConfirm={() => confirm.run(() => actions.decline(id), close)}
          >
            Record {number} to {who} ({money(quotation.total, quotation.currency)}) as declined? Use this too for a quotation that is no longer
            wanted: a quotation cannot be voided. The answer can be changed until an invoice is made from the quotation.
          </ConfirmRow>
        );
      case 'convert':
        return (
          <ConfirmRow
            key={quotation.id}
            {...shared}
            tone="default"
            icon={FilePlus}
            label={`Make an invoice from ${name}`}
            confirmLabel="Make invoice"
            pendingLabel="Making…"
            onConfirm={() => {
              // The person's own date, as the forms take it: the database's is UTC, a day behind until 08:00 in Malaysia.
              const date = now();
              confirm.run(
                () => actions.convert({ ...id, invoice_date: date }),
                // The row's question goes; the note at the top of the page says where the invoice is.
                (made) => ask({ kind: 'converted', quotation, date, invoice: made.invoice }),
              );
            }}
          >
            Make a draft invoice from {number} to {who} ({money(quotation.total, quotation.currency)})? It gets the same customer, notes and
            lines, is dated today, and stays a draft on Invoices until it is posted.
          </ConfirmRow>
        );
      case 'delete':
        return (
          <ConfirmRow
            key={quotation.id}
            {...shared}
            label={`Delete ${name}`}
            confirmLabel="Delete draft"
            pendingLabel="Deleting…"
            onConfirm={() => confirm.run(() => actions.remove(id), close)}
          >
            Delete the draft quotation to {who} ({money(quotation.total, quotation.currency)})? This cannot be undone.
          </ConfirmRow>
        );
    }
  };

  const card = () => {
    if (!writer || !open) return null;
    const { actions } = writer;
    if (open.kind === 'new') {
      return (
        <QuotationFormCard
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
        <QuotationFormCard
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
          title="Edit quotation"
          subtitle={`The draft to ${open.quotation.customer_name}`}
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
    if (open.kind === 'converted') {
      const currencyNote = convertedInvoiceNote(open.invoice, longDate);
      return (
        <BentoCard
          title="Draft invoice made"
          subtitle={`From ${open.quotation.quotation_no ?? 'the quotation'} to ${open.quotation.customer_name}`}
          icon={FileText}
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-3">
            <p id="converted-note" role="status" className="text-sm text-muted-foreground">
              {currencyNote ? `${currencyNote} ` : ''}It has the quotation’s customer, notes and lines, and is dated{' '}
              {displayDate(open.date)}. It is a draft:
              check it, then post it, on{' '}
              <Link
                ref={invoicesLink}
                href="/finance/invoices"
                aria-describedby="converted-note"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Invoices
              </Link>
              .
            </p>
            <Button type="button" variant="outline" size="sm" onClick={close}>
              Close
            </Button>
          </div>
        </BentoCard>
      );
    }
    return null;
  };

  // The question's own message shows in its row; beside the filters only while its row is out of view.
  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Quotations"
        subtitle="Quotes you have given your customers, and their answers."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New Quotation
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
          title="Quoted value over time"
          subtitle="Quoted vs accepted · last 8 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={TREND_SERIES} height={240} showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">
              Nothing quoted or accepted in the last 8 months.
            </p>
          )}
        </BentoCard>
        <BentoCard title="Acceptance funnel" subtitle="This quarter" icon={ChartColumn} className="col-span-2 md:col-span-4">
          {view.funnelCount === 0 ? (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">No quotations this quarter.</p>
          ) : (
            <FunnelFlow data={view.funnel} height={240} />
          )}
        </BentoCard>

        <BentoCard
          title="Quotations"
          subtitle="What you have quoted your customers"
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
                aria-label="Search quotations by number, customer or invoice"
                placeholder="Search quotations, customers or invoices…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as QuotationFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="accepted">Accepted</SelectItem>
                <SelectItem value="declined">Declined</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
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
              onClick={() => downloadCsv(csvFileName('quotations', now()), quotationsCsv(matching))}
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
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Valid until</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Invoice</TableHead>
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
                        No quotations yet.{writer ? ' Add the first one with New Quotation.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((q) => {
                  const asked = question(q);
                  if (asked) return asked;
                  const items = writer ? quotationActions(q).map((action) => menuItem(q, action, writer.actions)) : [];
                  const invoice = quotationInvoice(q);
                  return (
                    <TableRow key={q.id} className={cn(q.display_status === 'declined' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {q.quotation_no ?? '—'}
                        <AgentNoteMarker note={agentNotes?.[q.id]} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(q.quote_date)}</TableCell>
                      <TableCell className="whitespace-nowrap">{q.customer_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {money(q.total, q.currency)}
                        {foreign && q.currency !== 'MYR' ? (
                          <span className="block text-xs text-muted-foreground">
                            {q.total_myr === null ? 'No rate yet' : `≈ ${rm(q.total_myr)}`}
                            {q.fx_rate_source === 'manual' ? ', rate typed' : ''}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(q.valid_until)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={q.display_status === 'accepted'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[q.display_status],
                            )}
                          >
                            {QUOTATION_STATUS_LABELS[q.display_status]}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {invoice ? (
                          // The invoice made from this quotation is on Invoices; this only goes there.
                          <Link href="/finance/invoices" className="underline underline-offset-4">
                            {invoice}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={quotationName(q)} items={items} />
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
            Showing {shown.length} of {matching.length} quotations
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
