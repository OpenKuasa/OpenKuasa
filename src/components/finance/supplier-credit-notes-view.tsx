'use client';

import { useId, useState } from 'react';
import { Ban, Download, FileCheck, FileText, Pencil, PieChart, Plus, Search, Trash2, TrendingUp, Undo2, Wallet } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { SupplierCreditNoteFormCard, type SupplierCreditFormActions } from '@/components/finance/supplier-credit-note-form-card';
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
import type { BillListRow } from '@/lib/finance/bills';
import { csvFileName } from '@/lib/finance/csv';
import { rm, typedNumber } from '@/lib/finance/format';
import type { FinResult } from '@/lib/finance/result';
import {
  SUPPLIER_CREDIT_STATUS_LABELS,
  type SupplierCreditFilter,
  type SupplierCreditViewData,
  appliedText,
  applyCreditError,
  creditTargets,
  defaultApplyAmount,
  filterSupplierCredits,
  supplierCreditActions,
  supplierCreditName,
  supplierCreditsCsv,
} from '@/lib/finance/supplier-credit-note-form';
import {
  SUPPLIER_CREDIT_REASON_LABELS,
  type SupplierCreditNoteRow,
  type SupplierCreditStatus,
  creditOnOtherBills,
} from '@/lib/finance/supplier-credit-notes';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

type Write<T> = (input: unknown) => Promise<FinResult<T>>;

export type SupplierCreditActions = SupplierCreditFormActions & {
  issue: Write<{ id: string; credit_note_no: string }>;
  voidNote: Write<{ id: string }>;
  remove: Write<{ id: string }>;
  apply: Write<{ credit_note_id: string; bill_id: string }>;
  unapply: Write<{ credit_note_id: string; bill_id: string }>;
};

/** What only a person who may edit is given. */
export type SupplierCreditsWriter = {
  actions: SupplierCreditActions;
  /** True for an owner or admin: they issue, void, apply and take off credit. Anyone else saves and deletes drafts. */
  canSignOff: boolean;
  /** Every bill, for the form's picker and the bills credit can go on. */
  bills: BillListRow[];
  /** What payments not yet posted hold of each bill, by bill id. */
  held: Record<string, number>;
};

const CREDITED_SERIES: Series[] = [{ key: 'credited', label: 'Credited (RM k)', color: 'var(--chart-3)' }];

const STATUS_STYLES: Record<SupplierCreditStatus, string> = {
  issued: 'bg-emerald-500/15 text-emerald-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

export const SUPPLIER_CREDIT_MEMBER_NOTE = 'An owner or admin issues them, voids them and applies their credit.';

/** One thing open at a time: a form card, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  | { kind: 'edit'; note: SupplierCreditNoteRow; today: string }
  | { kind: 'issue' | 'void' | 'delete' | 'apply'; note: SupplierCreditNoteRow }
  | { kind: 'unapply'; note: SupplierCreditNoteRow; billId: string }
  | null;

/**
 * Supplier Credit Notes: figures, charts and the table, with search, a status filter, "View all" and Export for
 * everybody. A person who may edit (`writer`) also gets New credit note and each row's menu: drafts are edited and
 * deleted by anyone who may write; issuing, voiding, applying credit and taking it off are an owner's or admin's.
 */
export function SupplierCreditNotesView({
  rows,
  view,
  writer,
}: {
  /** Every note, newest first; drafts and void ones included. */
  rows: SupplierCreditNoteRow[];
  view: SupplierCreditViewData;
  writer?: SupplierCreditsWriter;
}) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SupplierCreditFilter>('open');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  // The apply question's bill and amount, as chosen.
  const [applyBill, setApplyBill] = useState('');
  const [applyAmount, setApplyAmount] = useState('');
  const confirm = useFinanceAction();

  const matching = filterSupplierCredits(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 10 : 9;
  const asking = open && open.kind !== 'new' && open.kind !== 'edit' ? open : null;
  const formOpen = open?.kind === 'new' || open?.kind === 'edit';
  const askingInView = asking ? shown.some((n) => n.id === asking.note.id) : false;
  const locked = confirm.pending || formOpen;
  const now = () => localIsoDate(new Date());
  const targetsOf = (note: SupplierCreditNoteRow) => (writer ? creditTargets(note, writer.bills, writer.held) : []);

  const ask = (next: Exclude<Open, null>) => {
    confirm.clear();
    if (next.kind === 'apply') {
      const first = targetsOf(next.note)[0];
      setApplyBill(first?.id ?? '');
      setApplyAmount(defaultApplyAmount(next.note, first));
    }
    setOpen(next);
  };
  const close = () => {
    confirm.clear();
    setOpen(null);
  };

  const menu = (note: SupplierCreditNoteRow): RowMenuItem[] => {
    if (!writer) return [];
    return supplierCreditActions(note, writer.canSignOff, targetsOf(note).length > 0).flatMap((action): RowMenuItem[] => {
      switch (action) {
        case 'edit':
          return [{ label: 'Edit', icon: Pencil, opens: true, onSelect: () => ask({ kind: 'edit', note, today: now() }) }];
        case 'issue':
          return [{ label: 'Issue', icon: FileCheck, opens: true, onSelect: () => ask({ kind: 'issue', note }) }];
        case 'delete':
          return [{ label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', note }) }];
        case 'apply':
          return [{ label: 'Apply to a bill', icon: Wallet, opens: true, onSelect: () => ask({ kind: 'apply', note }) }];
        case 'unapply':
          return creditOnOtherBills(note).map((a) => ({
            label: `Take off ${a.bill_no ?? 'that bill'}`,
            icon: Undo2,
            opens: true,
            onSelect: () => ask({ kind: 'unapply', note, billId: a.bill_id }),
          }));
        case 'void':
          return [{ label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', note }) }];
      }
    });
  };

  const question = (note: SupplierCreditNoteRow) => {
    if (!writer || !asking || asking.note.id !== note.id) return null;
    const { actions } = writer;
    const id = { id: note.id };
    const name = supplierCreditName(note);
    const who = <span className="font-medium">{note.supplier_name}</span>;
    const bill = <span className="font-medium">{note.bill_no ?? 'its bill'}</span>;
    const amount = <span className="font-medium">{rm(note.amount)}</span>;
    const shared = { colSpan: columns, pending: confirm.pending, error: confirm.error, onCancel: close };
    switch (asking.kind) {
      case 'issue':
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            tone="default"
            icon={FileCheck}
            label={`Issue ${name}`}
            confirmLabel="Issue"
            pendingLabel="Issuing…"
            onConfirm={() => confirm.run(() => actions.issue(id), close)}
          >
            Issue this credit note of {amount} from {who}? It gets its number, goes in the books, and comes off what {bill}{' '}
            still owes. Whatever is left is open credit, to apply to a later bill. After this it can no longer be edited
            or deleted, only voided.
          </ConfirmRow>
        );
      case 'void': {
        const elsewhere = creditOnOtherBills(note);
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            icon={Ban}
            label={`Void ${name}`}
            confirmLabel="Void credit note"
            pendingLabel="Voiding…"
            onConfirm={() => confirm.run(() => actions.voidNote(id), close)}
          >
            Void <span className="font-medium">{note.credit_note_no}</span> of {amount} from {who}? Its entry is reversed
            today and {bill} owes what it took off again. It stays in the list as Void, and this cannot be undone.
            {elsewhere.length > 0
              ? ` Its credit is on ${elsewhere.map((a) => a.bill_no ?? 'a later bill').join(', ')}: take it off there first.`
              : ''}
          </ConfirmRow>
        );
      }
      case 'delete':
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            label={`Delete ${name}`}
            confirmLabel="Delete draft"
            pendingLabel="Deleting…"
            onConfirm={() => confirm.run(() => actions.remove(id), close)}
          >
            Delete the draft credit note of {amount} against {bill} from {who}? This cannot be undone.
          </ConfirmRow>
        );
      case 'unapply': {
        const on = note.applications.find((a) => a.bill_id === asking.billId);
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            tone="default"
            icon={Undo2}
            label={`Take ${name} off ${on?.bill_no ?? 'the bill'}`}
            confirmLabel="Take off"
            pendingLabel="Taking off…"
            onConfirm={() => confirm.run(() => actions.unapply({ credit_note_id: note.id, bill_id: asking.billId }), close)}
          >
            Take the {rm(on?.amount ?? 0)} of <span className="font-medium">{note.credit_note_no}</span> off{' '}
            <span className="font-medium">{on?.bill_no ?? 'that bill'}</span>? That bill owes it again, and the credit is
            open to apply elsewhere.
          </ConfirmRow>
        );
      }
      case 'apply': {
        const targets = targetsOf(note);
        const send = () => {
          const problem = applyCreditError(note, targets, applyBill, applyAmount);
          if (problem) {
            confirm.fail(problem);
            return;
          }
          // applyCreditError has checked it reads as a number; send what that check read.
          confirm.run(() => actions.apply({ credit_note_id: note.id, bill_id: applyBill, amount: typedNumber(applyAmount) ?? 0 }), close);
        };
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            tone="default"
            icon={Wallet}
            label={`Apply ${name} to a bill`}
            confirmLabel="Apply credit"
            pendingLabel="Applying…"
            onConfirm={send}
          >
            <span className="block">
              Put some of the {rm(note.open_amount)} open on <span className="font-medium">{note.credit_note_no}</span> on a
              bill from {who}? That bill owes that much less. It makes no new entry in the books.
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <Select
                value={applyBill}
                onValueChange={(v) => {
                  confirm.clear();
                  setApplyBill(v);
                  setApplyAmount(defaultApplyAmount(note, targets.find((t) => t.id === v)));
                }}
              >
                <SelectTrigger id={`${uid}-apply-bill`} className="w-72" aria-label="Bill">
                  <SelectValue placeholder="Choose a bill" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {`${t.bill_no} · due ${displayDate(t.due_date)} · owes ${rm(t.balance)}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                aria-label="Amount (RM)"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                className="w-32 text-right tabular-nums"
                onWheel={(e) => e.currentTarget.blur()}
                value={applyAmount}
                onChange={(e) => {
                  confirm.clear();
                  setApplyAmount(e.target.value);
                }}
              />
            </span>
          </ConfirmRow>
        );
      }
    }
  };

  const card = () => {
    if (!writer || !open) return null;
    if (open.kind === 'new') {
      return <SupplierCreditNoteFormCard key={open.nonce} bills={writer.bills} notes={rows} today={open.today} actions={writer.actions} onClose={close} />;
    }
    if (open.kind === 'edit') {
      return (
        <SupplierCreditNoteFormCard
          key={open.note.id}
          editing={open.note}
          bills={writer.bills}
          notes={rows}
          today={open.today}
          actions={writer.actions}
          onClose={close}
        />
      );
    }
    return null;
  };

  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;
  const subtitle = 'Credit your suppliers give you against their bills.';

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Supplier Credit Notes"
        subtitle={writer && !writer.canSignOff ? `${subtitle} ${SUPPLIER_CREDIT_MEMBER_NOTE}` : subtitle}
        actions={
          writer ? (
            <Button size="sm" aria-expanded={open?.kind === 'new'} disabled={locked} onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}>
              <Plus className="size-4" />
              New credit note
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

        <BentoCard title="Credited over time" subtitle="Last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={CREDITED_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing credited in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Credits by reason" subtitle="This year" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReasons ? (
            <DonutStat data={view.byReason} height={240} centerValue={view.creditedYtd} centerLabel="credited" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing credited this year.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Supplier credit notes"
          subtitle="What your suppliers have credited you, and where that credit went"
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
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search supplier credit notes by number, supplier, bill or reference"
                placeholder="Search credit notes, suppliers or bills…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as SupplierCreditFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="issued">Issued</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('supplier-credit-notes', now()), supplierCreditsCsv(matching))}
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
                  <TableHead>Against bill</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Applied</TableHead>
                  <TableHead className="text-right">Open</TableHead>
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
                        No supplier credit notes yet.{writer ? ' Add the first one with New credit note.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((n) => {
                  const asked = question(n);
                  if (asked) return asked;
                  const items = menu(n);
                  const where = n.status === 'issued' ? appliedText(n) : null;
                  return (
                    <TableRow key={n.id} className={cn(n.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {n.credit_note_no ?? '—'}
                        {n.supplier_ref ? <span className="block text-xs font-normal text-muted-foreground">Theirs: {n.supplier_ref}</span> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(n.credit_date)}</TableCell>
                      <TableCell className="whitespace-nowrap">{n.supplier_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{n.bill_no ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{SUPPLIER_CREDIT_REASON_LABELS[n.reason]}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(n.amount)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="whitespace-nowrap">{n.status === 'issued' ? rm(n.applied) : '—'}</span>
                        {/* Under the figure, no wider than the column: it wraps there and adds no width. */}
                        {where ? <span className="block w-0 min-w-full whitespace-normal text-xs text-muted-foreground">{where}</span> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{n.status === 'issued' ? rm(n.open_amount) : '—'}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={n.status === 'issued' && n.open_amount > 0} />
                          <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold', STATUS_STYLES[n.status])}>
                            {SUPPLIER_CREDIT_STATUS_LABELS[n.status]}
                          </span>
                        </span>
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={supplierCreditName(n)} items={items} />
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
            Showing {shown.length} of {matching.length} supplier credit notes
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
