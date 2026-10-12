'use client';

import { useState } from 'react';
import { Ban, Check, Download, FileText, Pencil, PieChart, Plus, Search, Trash2, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { type ExpenseFormActions, ExpenseFormCard } from '@/components/finance/expense-form-card';
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
import { localIsoDate } from '@/lib/finance/bill-math';
import {
  EXPENSE_STATUS_LABELS,
  type ExpenseFilter,
  expenseCategories,
  expenseMethod,
  expensesCsv,
  expensesView,
  filterExpenses,
} from '@/lib/finance/cash-book-views';
import { csvFileName } from '@/lib/finance/csv';
import {
  type ExpenseAction,
  type QuestionPart,
  type WrittenExpense,
  expenseActions,
  expenseControls,
  decisionIsStale,
  expenseDecisionPayload,
  expenseHiddenNote,
  expenseName,
  expensePaymentNote,
  expenseQuestion,
  isPartPaid,
  writtenExpenseTitle,
} from '@/lib/finance/expense-form';
import type { ExpenseCategory, ExpenseDisplayStatus, ExpenseRow } from '@/lib/finance/expenses';
import { rm } from '@/lib/finance/format';
import type { FinResult } from '@/lib/finance/result';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type ExpenseActions = ExpenseFormActions & {
  approve: (input: unknown) => Promise<FinResult<{ id: string }>>;
  reject: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What only a person who may edit is given: the actions, whether they may decide, and what the expense form offers. */
export type ExpensesWriter = {
  actions: ExpenseActions;
  /** True for an owner or admin: they approve and reject, and what they save is approved. */
  canDecide: boolean;
  /** Active contacts, for the vendor. */
  contacts: { id: string; name: string }[];
  /** Active expense categories. */
  categories: ExpenseCategory[];
};

const SPEND_SERIES: Series[] = [
  { key: 'entered', label: 'Entered (RM k)', color: 'var(--chart-1)' },
  { key: 'approved', label: 'Approved (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<ExpenseDisplayStatus, string> = {
  paid: 'bg-emerald-500/15 text-emerald-600',
  approved: 'bg-sky-500/15 text-sky-600',
  pending: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
};

/** One thing open at a time: the expense form, new or for one expense, or a question in one row. */
type Open =
  | { kind: 'form'; today: string; editing?: ExpenseRow }
  | { kind: 'approve' | 'reject' | 'delete'; row: ExpenseRow }
  | null;

/**
 * Expenses: figures, charts and the table, with search, category and status
 * filters, "View all" and Export. A person who may edit (`writer`) also gets
 * New expense, and Edit and Delete on a pending or rejected expense; an owner
 * or admin also gets Approve and Reject on a pending one, and Reject on an
 * approved one that no payment stands against. Each row's menu holds only
 * what the database will let that person do (`expenseActions`).
 */
export function ExpensesView({
  rows,
  today: serverToday,
  followClock = true,
  writer,
}: {
  /** Every expense, newest first; pending and rejected ones included. */
  rows: ExpenseRow[];
  /** The date the figures are worked out for, YYYY-MM-DD, until the browser's own date takes over. */
  today: string;
  /** False for sample data, which keeps its own fixed date. */
  followClock?: boolean;
  writer?: ExpensesWriter;
}) {
  const today = useLocalToday(serverToday, followClock);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ExpenseFilter>('open');
  const [category, setCategory] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  // The expense just saved, approved or rejected; whether to say anything about it is decided at render, from the rows listed now.
  const [written, setWritten] = useState<WrittenExpense | null>(null);
  const confirm = useFinanceAction();

  const view = expensesView(rows, today);
  const categories = expenseCategories(rows);
  // A category that is no longer among the rows after a refresh would leave the table empty with nothing to say why.
  const chosen = category === 'all' || categories.some((c) => c.id === category) ? category : 'all';
  const matching = filterExpenses(rows, query, filter, chosen);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  const hiddenNote = written
    ? expenseHiddenNote(written, matching.some((e) => e.id === written.id), shown.some((e) => e.id === written.id))
    : null;

  const { newButton, actionsColumn, columns } = expenseControls(Boolean(writer));
  const asking = open && open.kind !== 'form' ? open : null;
  // The form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const locked = confirm.pending || open?.kind === 'form';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((e) => e.id === asking.row.id) : false;

  /** Opens one thing, dropping whatever message the last question left behind. */
  const ask = (next: Exclude<Open, null>) => {
    confirm.clear();
    setWritten(null);
    setOpen(next);
  };
  /** Forgets an earlier write when the list changes under a note that is not showing, so a note never turns up later by itself. */
  const listChanged = () => {
    if (!hiddenNote) setWritten(null);
  };
  /** Closes whatever is open, and the message that went with it. */
  const close = () => {
    confirm.clear();
    setOpen(null);
  };
  /** Closes, and keeps the expense just written so the screen can say when it is not in the list. */
  const closeSaying = (expense: WrittenExpense) => {
    close();
    setWritten(expense);
  };
  const decided = (row: ExpenseRow, status: 'approved' | 'rejected'): WrittenExpense => ({
    id: row.id,
    status,
    vendor: row.vendor_name,
    amount: row.amount,
    date: row.expense_date,
  });

  const menuItem = (row: ExpenseRow, action: ExpenseAction): RowMenuItem => {
    switch (action) {
      case 'edit':
        return {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => ask({ kind: 'form', today: localIsoDate(new Date()), editing: row }),
        };
      case 'approve':
        return { label: 'Approve', icon: Check, opens: true, onSelect: () => ask({ kind: 'approve', row }) };
      case 'reject':
        return { label: 'Reject', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'reject', row }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', row }) };
    }
  };

  /** Runs a decision on the expense as the row shows it now. If it was changed or decided since, the question closes and the refreshed row says what it holds. */
  const decide = (row: ExpenseRow, call: (input: unknown) => Promise<FinResult<{ id: string }>>, status: 'approved' | 'rejected') =>
    confirm.run(
      async () => {
        const result = await call(expenseDecisionPayload(row));
        if (!result.ok && decisionIsStale(result.error)) setOpen(null);
        return result;
      },
      () => closeSaying(decided(row, status)),
    );

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

  const question = (row: ExpenseRow) => {
    if (!writer || !asking || asking.row.id !== row.id) return null;
    const { actions } = writer;
    if (asking.kind === 'approve') {
      return (
        <ConfirmRow
          key={row.id}
          colSpan={columns}
          tone="default"
          icon={Check}
          label={`Approve ${expenseName(row)}`}
          confirmLabel="Approve"
          pendingLabel="Approving…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => decide(row, actions.approve, 'approved')}
          onCancel={close}
        >
          {words(expenseQuestion('approve', row))}
        </ConfirmRow>
      );
    }
    if (asking.kind === 'reject') {
      return (
        <ConfirmRow
          key={row.id}
          colSpan={columns}
          icon={Ban}
          label={`Reject ${expenseName(row)}`}
          confirmLabel="Reject"
          pendingLabel="Rejecting…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => decide(row, actions.reject, 'rejected')}
          onCancel={close}
        >
          {words(expenseQuestion('reject', row))}
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={row.id}
        colSpan={columns}
        label={`Delete ${expenseName(row)}`}
        confirmLabel="Delete expense"
        pendingLabel="Deleting…"
        pending={confirm.pending}
        error={confirm.error}
        onConfirm={() => confirm.run(() => actions.remove({ id: row.id }), close)}
        onCancel={close}
      >
        {words(expenseQuestion('delete', row))}
      </ConfirmRow>
    );
  };

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Expenses"
        subtitle="Business expenses and spending, Saudara."
        actions={
          newButton ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'form'}
              disabled={locked}
              onClick={() => ask({ kind: 'form', today: localIsoDate(new Date()) })}
            >
              <Plus className="size-4" />
              New expense
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {writer && open?.kind === 'form' ? (
          <ExpenseFormCard
            // A different expense is a different form.
            key={open.editing?.id ?? 'new'}
            editing={open.editing}
            contacts={writer.contacts}
            categories={writer.categories}
            today={open.today}
            canDecide={writer.canDecide}
            actions={writer.actions}
            onClose={(saved) => (saved ? closeSaying(saved) : close())}
          />
        ) : null}
        {written && hiddenNote ? (
          <SavedNoteCard title={writtenExpenseTitle(written)} subtitle="It is not in the list below" onClose={() => setWritten(null)}>
            {hiddenNote}
          </SavedNoteCard>
        ) : null}

        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Expenses over time" subtitle="Entered and approved · last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={SPEND_SERIES} height={240} showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">No expenses in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Spend by category" subtitle="Approved · this year" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasSpend ? (
            <DonutStat data={view.byCategory} height={240} centerValue={view.spendYtd} centerLabel="spend" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing approved this year.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Expenses"
          subtitle="What was spent, and what is waiting for approval"
          icon={FileText}
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
                aria-label="Search expenses by vendor, category or notes"
                placeholder="Search vendors or categories…"
                className="pl-8"
                value={query}
                onChange={(e) => {
                  listChanged();
                  setQuery(e.target.value);
                }}
              />
            </div>
            <Select
              value={chosen}
              onValueChange={(v) => {
                listChanged();
                setCategory(v);
              }}
            >
              <SelectTrigger className="w-44" aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filter}
              onValueChange={(v) => {
                listChanged();
                setFilter(v as ExpenseFilter);
              }}
            >
              <SelectTrigger className="w-44" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except rejected</SelectItem>
                <SelectItem value="pending">Pending approval</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('expenses', localIsoDate(new Date())), expensesCsv(matching))}
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
                  <TableHead>Category</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Method</TableHead>
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
                        {writer ? 'No expenses yet. Enter one with New expense.' : 'No expenses yet.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((e) => {
                  const asked = question(e);
                  if (asked) return asked;
                  const items = writer ? expenseActions(e, writer.canDecide).map((action) => menuItem(e, action)) : [];
                  const payments = expensePaymentNote(e);
                  return (
                    <TableRow key={e.id} className={cn('group/row', e.display_status === 'rejected' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(e.expense_date)}</TableCell>
                      <TableCell className="min-w-24 whitespace-normal break-words font-medium">{e.category_name}</TableCell>
                      {/* A long vendor name wraps; it is never cut off behind a tooltip. */}
                      <TableCell className="min-w-28 max-w-72 whitespace-normal break-words">{e.vendor_name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="whitespace-nowrap">{rm(e.amount)}</span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{expenseMethod(e)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={e.display_status === 'paid'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[e.display_status],
                            )}
                          >
                            {isPartPaid(e) ? 'Part paid' : EXPENSE_STATUS_LABELS[e.display_status]}
                          </span>
                        </span>
                        {/* Under the chip, and no wider than the column the chip makes: it wraps there and adds no width. */}
                        {payments ? <span className="block w-0 min-w-full whitespace-normal text-xs text-muted-foreground">{payments}</span> : null}
                      </TableCell>
                      {actionsColumn ? (
                        <TableCell className="sticky right-0 border-l bg-card group-hover/row:bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))] group-has-aria-expanded/row:bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))]">
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or the form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={expenseName(e)} items={items} />
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
            Showing {shown.length} of {matching.length} expenses
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
