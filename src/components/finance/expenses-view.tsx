'use client';

import { useState } from 'react';
import { Download, FileText, PieChart, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { downloadCsv } from '@/components/finance/download-csv';
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
  type ExpensesViewData,
  expenseCategories,
  expenseMethod,
  expensesCsv,
  filterExpenses,
} from '@/lib/finance/cash-book-views';
import { csvFileName } from '@/lib/finance/csv';
import type { ExpenseDisplayStatus, ExpenseRow } from '@/lib/finance/expenses';
import { rm } from '@/lib/finance/format';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

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

/**
 * Expenses: figures, charts and the table, with search, category and status
 * filters, "View all" and Export. Nothing here changes data yet: the expense
 * form, approve and reject, and "mark paid" arrive later.
 */
export function ExpensesView({
  rows,
  view,
}: {
  /** Every expense, newest first; pending and rejected ones included. */
  rows: ExpenseRow[];
  view: ExpensesViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ExpenseFilter>('open');
  const [category, setCategory] = useState('all');
  const [showAll, setShowAll] = useState(false);

  const categories = expenseCategories(rows);
  // A category that is no longer among the rows after a refresh would leave the table empty with nothing to say why.
  const chosen = category === 'all' || categories.some((c) => c.id === category) ? category : 'all';
  const matching = filterExpenses(rows, query, filter, chosen);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Expenses" subtitle="Business expenses and spending, Saudara." />

      <BentoGrid>
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
                aria-label="Search expenses by vendor, category or notes"
                placeholder="Search vendors or categories…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={chosen} onValueChange={setCategory}>
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
            <Select value={filter} onValueChange={(v) => setFilter(v as ExpenseFilter)}>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        No expenses yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={6} />
                  ))}
                {shown.map((e) => (
                  <TableRow key={e.id} className={cn(e.display_status === 'rejected' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(e.expense_date)}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{e.category_name}</TableCell>
                    <TableCell className="whitespace-nowrap">{e.vendor_name}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(e.amount)}</TableCell>
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
                          {EXPENSE_STATUS_LABELS[e.display_status]}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
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
