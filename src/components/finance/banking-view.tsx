'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Banknote, ChartColumn, Download, Landmark, Plus, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, RadialGauge, type Series } from '@/components/charts';
import { BankAccountFormCard, type BankAccountFormActions } from '@/components/finance/bank-account-form-card';
import { BankAccountsCard } from '@/components/finance/bank-accounts-card';
import { downloadCsv } from '@/components/finance/download-csv';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { useLocalToday } from '@/components/finance/use-local-today';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { BankAccountRow, BankTransactionRow } from '@/lib/finance/banking';
import {
  type BankFilter,
  accountOptionLabel,
  bankDescription,
  bankingCsv,
  bankingView,
  filterLedger,
  reconcileLabel,
  withRunningBalance,
} from '@/lib/finance/banking-views';
import { localIsoDate } from '@/lib/finance/bill-math';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import type { SavedBankAccount } from '@/lib/finance/bank-accounts';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

export type BankingActions = BankAccountFormActions & {
  setActive: (input: unknown) => Promise<FinResult<SavedBankAccount>>;
};

/** What only a person who may edit is given: the actions, whether they may sign off, and the account numbers. */
export type BankingWriter = {
  actions: BankingActions;
  /** True for an owner or admin: they set and change an opening balance. Decided on the server. */
  canSignOff: boolean;
  /** Account numbers by account id, read with finance_account_numbers; an account with none is absent. */
  numbers: Record<string, string>;
};

/** The account form: for a new account, or for one being changed. `today` is the person's own date when it was opened. */
type OpenForm = { today: string; editing: BankAccountRow | null } | null;

const CASH_SERIES: Series[] = [{ key: 'balance', label: 'Cash position (RM k)', color: 'var(--chart-1)' }];

const STATUS_STYLES = {
  Reconciled: 'bg-emerald-500/15 text-emerald-600',
  Unreconciled: 'bg-amber-500/15 text-amber-600',
} as const;

/**
 * Banking: a balance per account, the cash position over eight months, how
 * much of this month is reconciled, and every posted movement of money with
 * the balance of its account after it. Search, an account filter, a
 * reconciliation filter, "View all" and Export. A person who may edit
 * (`writer`) also gets "Add account", a link to Cash Receipts for a new
 * receipt, and Edit, Archive and Restore on each account; the opening
 * balance in the account form is an owner's or admin's. Transfers and
 * statements get their forms later, and a payment is changed on the screen
 * that recorded it.
 */
export function BankingView({
  accounts,
  rows,
  today: serverToday,
  followClock = true,
  writer,
}: {
  /** Absent for a viewer, the demo workspace and the sample: then nothing here changes data. */
  writer?: BankingWriter;
  /** Every account, bank accounts first. */
  accounts: BankAccountRow[];
  /** Every movement of money, any status. */
  rows: BankTransactionRow[];
  /** The date the figures are worked out for, YYYY-MM-DD. */
  today: string;
  /** False for the sample, whose day is fixed. */
  followClock?: boolean;
}) {
  const today = useLocalToday(serverToday, followClock);
  const [query, setQuery] = useState('');
  const [accountId, setAccountId] = useState('all');
  const [filter, setFilter] = useState<BankFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState<OpenForm>(null);
  /** What was just saved on the account form, until it is closed or another form opens. */
  const [saved, setSaved] = useState<{ title: string; note: string } | null>(null);

  const view = bankingView(accounts, rows, today);
  const ledger = withRunningBalance(accounts, rows);
  const matching = filterLedger(ledger, query, accountId, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Banking"
        subtitle="Accounts, balances and reconciliation, Saudara."
        actions={
          writer ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href="/finance/cash-receipts">New receipt</Link>
              </Button>
              <Button
                size="sm"
                aria-expanded={form !== null && form.editing === null}
                disabled={form !== null}
                // The date is the person's own, taken when the form opens, never the server's.
                onClick={() => {
                  setSaved(null);
                  setForm({ today: localIsoDate(new Date()), editing: null });
                }}
              >
                <Plus className="size-4" />
                Add account
              </Button>
            </>
          ) : undefined
        }
      />

      <BentoGrid>
        {writer && form ? (
          <BankAccountFormCard
            key={form.editing?.id ?? 'new'}
            editing={form.editing}
            accountNo={form.editing ? writer.numbers[form.editing.id] : undefined}
            today={form.today}
            canSignOff={writer.canSignOff}
            actions={writer.actions}
            onClose={() => setForm(null)}
            onSaved={(note) => {
              setSaved({ title: form.editing ? 'Account saved' : 'Account added', note });
              setForm(null);
            }}
          />
        ) : null}
        {writer && !form && saved ? (
          <SavedNoteCard title={saved.title} subtitle="Banking" onClose={() => setSaved(null)}>
            {saved.note}
          </SavedNoteCard>
        ) : null}
        <BentoCard tone="primary" className="col-span-2 md:col-span-6 xl:col-span-3">
          <BentoStat label={view.total.label} value={view.total.value} delta={view.total.delta} deltaTone="flat" onPrimary />
        </BentoCard>
        {view.tiles.map((tile) => (
          <BentoCard key={tile.id} className="col-span-2 md:col-span-6 xl:col-span-3">
            <BentoStat
              label={
                <span className="inline-flex items-center gap-1.5">
                  {tile.kind === 'cash' ? <Banknote className="size-3.5" /> : <Landmark className="size-3.5" />}
                  {tile.name}
                </span>
              }
              value={tile.balance}
              delta={tile.note}
              deltaTone="flat"
            />
          </BentoCard>
        ))}

        <BentoCard title="Cash position" subtitle="All accounts · last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={CASH_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">No money has moved yet.</p>
          )}
        </BentoCard>
        <BentoCard title="Reconciliation" subtitle={view.gauge.label || undefined} icon={ChartColumn} className="col-span-2 md:col-span-4">
          {view.hasGauge ? (
            <RadialGauge value={view.gauge.percent} valueLabel={`${view.gauge.percent}%`} label="reconciled" color="var(--chart-2)" height={240} />
          ) : (
            <p className="grid h-60 place-items-center px-4 text-center text-sm text-muted-foreground">
              {view.gaugeEmpty}
            </p>
          )}
        </BentoCard>

        <BankAccountsCard
          accounts={accounts}
          writer={
            writer
              ? {
                  numbers: writer.numbers,
                  setActive: writer.actions.setActive,
                  onEdit: (account) => {
                    setSaved(null);
                    setForm({ today: localIsoDate(new Date()), editing: account });
                  },
                  locked: form !== null,
                }
              : undefined
          }
        />

        <BentoCard
          title="Transactions"
          subtitle="Every posted movement of money, with the balance after it"
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
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search transactions by description, number or reference"
                placeholder="Search descriptions or numbers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="w-44" aria-label="Account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {accountOptionLabel(a)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filter} onValueChange={(v) => setFilter(v as BankFilter)}>
              <SelectTrigger className="w-40" aria-label="Reconciliation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="reconciled">Reconciled</SelectItem>
                <SelectItem value="unreconciled">Unreconciled</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('banking', localIsoDate(new Date())), bankingCsv(matching))}
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
                  <TableHead>No.</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Money In</TableHead>
                  <TableHead className="text-right">Money Out</TableHead>
                  <TableHead className="text-right">Account balance</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (ledger.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                        No money has moved yet. A payment recorded on any finance screen shows here.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={8} />
                  ))}
                {shown.map((r) => {
                  const status = reconcileLabel(r);
                  const description = bankDescription(r);
                  return (
                    <TableRow key={r.transaction_id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(r.txn_date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{r.number ?? '—'}</TableCell>
                      <TableCell className="min-w-48 max-w-72 whitespace-normal break-words">
                        {description}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          {r.account_kind === 'cash' ? <Banknote className="size-3.5" /> : <Landmark className="size-3.5" />}
                          {r.account_name}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums text-emerald-600">
                        {r.direction === 'in' ? rm(r.amount) : ''}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums text-red-600">
                        {r.direction === 'out' ? rm(r.amount) : ''}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(r.balance)}</TableCell>
                      <TableCell>
                        {status ? (
                          <span className="flex items-center gap-2">
                            <LiveDot active={status === 'Reconciled'} />
                            <span
                              className={cn(
                                'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                                STATUS_STYLES[status],
                              )}
                            >
                              {status}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {ledger.length > 0 && (
            <div className="border-t px-4 py-3 text-sm text-muted-foreground">
              Showing {shown.length} of {matching.length} transactions
              {matching.length !== ledger.length ? ` (${ledger.length} in all)` : ''}
            </div>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
