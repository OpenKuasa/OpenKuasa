'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeftRight, Ban, Banknote, ChartColumn, Download, Landmark, Plus, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, RadialGauge, type Series } from '@/components/charts';
import { BankAccountFormCard, type BankAccountFormActions } from '@/components/finance/bank-account-form-card';
import { BankAccountsCard } from '@/components/finance/bank-accounts-card';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { FxRatesCard } from '@/components/finance/fx-rates-card';
import { downloadCsv } from '@/components/finance/download-csv';
import { RowMenu } from '@/components/finance/row-menu';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { TransferFormCard } from '@/components/finance/transfer-form-card';
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
import type { BankAccountRow, BankTransactionRow } from '@/lib/finance/banking';
import type { FxLatestRate } from '@/lib/finance/fx-rates';
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
import {
  type RecordedTransferNote,
  bankRowActions,
  transferName,
  transferRecordedNote,
  transferVoidedNote,
  voidTransferEffect,
} from '@/lib/finance/transfer-form';
import type { RecordedTransfer } from '@/lib/finance/transfers';
import {
  type BankingOpen as Open,
  VOID_REFUSED_TITLE,
  accountsLocked,
  bankingOffers,
  closeOwnVoid,
  visibleOpen,
  voidMenuWaits,
  voidPayload,
  voidQuestionGone,
} from '@/lib/finance/banking-open';
import { cn } from '@/lib/utils';

export type BankingActions = BankAccountFormActions & {
  setActive: (input: unknown) => Promise<FinResult<SavedBankAccount>>;
};

/** Recording and voiding a transfer between accounts. */
export type TransferActions = {
  record: (input: unknown) => Promise<FinResult<RecordedTransfer>>;
  void: (input: unknown) => Promise<FinResult<{ transfer_id: string }>>;
};

/** What only a person who may edit is given: the actions, whether they may sign off, and the account numbers. */
export type BankingWriter = {
  actions: BankingActions;
  /** True for an owner or admin: they set and change an opening balance. Decided on the server. */
  canSignOff: boolean;
  /** Present for an owner or admin only, decided on the server: nobody else is offered "Transfer" or "Void transfer". */
  transfers?: TransferActions;
  /** Account numbers by account id, read with finance_account_numbers; an account with none is absent. */
  numbers: Record<string, string>;
};

/** What was just done, said at the top of the page until it is closed or something else opens. */
type Note = { kind: 'text'; title: string; text: string } | { kind: 'recorded'; written: RecordedTransferNote } | null;

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
 * balance in the account form is an owner's or admin's. An owner or admin
 * (`writer.transfers`) also gets "Transfer" and, on either side of a
 * transfer in the table, "Void transfer". One thing is open at a time: a
 * form or a question. Statements get their forms later, and any other
 * payment is changed on the screen that recorded it.
 */
export function BankingView({
  accounts,
  rows,
  today: serverToday,
  followClock = true,
  writer,
  initialOpen = null,
  fxRates,
  fxToday,
}: {
  /**
   * Bank Negara Malaysia's newest rates, for the read-only card at the foot of the screen; null when they could
   * not be read. Absent (the sample) draws no card.
   */
  fxRates?: FxLatestRate[] | null;
  /** The Malaysian date, which BNM dates its rates by, for the card's "not updated since" note; defaults to `today`. */
  fxToday?: string;
  /** What is open when the screen first draws. Only the tests set it: a person always starts with nothing open. */
  initialOpen?: Open;
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
  const [opened, setOpened] = useState<Open>(initialOpen);
  const [note, setNote] = useState<Note>(null);
  const voiding = useFinanceAction();

  const view = bankingView(accounts, rows, today);
  const ledger = withRunningBalance(accounts, rows);
  const matching = filterLedger(ledger, query, accountId, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  const shownIds = shown.map((r) => r.transaction_id);
  // A question whose row has left the screen (a filter changed, or someone else voided or removed it) is not open.
  const open: Open = visibleOpen(
    opened,
    shownIds,
    accounts.map((a) => a.id),
  );
  // A refused void closes its question as the answer arrives, and its sentence is said at the top of the page: the
  // refresh that follows a refusal takes a row that was already voided away. A void question whose row a search or
  // a filter has hidden is closed for good too, so it does not come back, or take the focus, when that is cleared.
  const gone = voidQuestionGone(opened, shownIds, voiding.pending, voiding.error);
  if (gone.close) {
    setOpened(null);
    if (gone.refusal) setNote({ kind: 'text', title: VOID_REFUSED_TITLE, text: gone.refusal });
    voiding.clear();
  }
  const formOpen = open?.kind === 'account' || open?.kind === 'transfer';
  /** Opens a form or a question in place of whatever was open, and takes the last note away. */
  const openOnly = (next: Open) => {
    voiding.clear();
    setNote(null);
    setOpened(next);
  };
  const transfers = writer?.transfers;
  const offers = bankingOffers({ hasWriter: !!writer, hasTransfers: !!transfers, accounts, open, voidPending: voiding.pending });
  const columns = offers.actionsColumn ? 9 : 8;
  const noteText =
    note?.kind === 'recorded'
      ? transferRecordedNote(
          note.written,
          shown.filter((r) => r.transfer_id === note.written.transferId).length,
          ledger.filter((r) => r.transfer_id === note.written.transferId).length,
        )
      : note?.text;

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
              {offers.transfer ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-expanded={open?.kind === 'transfer'}
                  disabled={offers.headerDisabled}
                  // The date is the person's own, taken when the form opens, never the server's.
                  onClick={() => openOnly({ kind: 'transfer', today: localIsoDate(new Date()) })}
                >
                  <ArrowLeftRight className="size-4" />
                  Transfer
                </Button>
              ) : null}
              <Button
                size="sm"
                aria-expanded={open?.kind === 'account' && open.editing === null}
                // Nothing else opens over a form, which holds what was typed, or over a question that is being asked.
                disabled={offers.headerDisabled}
                // The date is the person's own, taken when the form opens, never the server's.
                onClick={() => openOnly({ kind: 'account', today: localIsoDate(new Date()), editing: null })}
              >
                <Plus className="size-4" />
                Add account
              </Button>
            </>
          ) : undefined
        }
      />

      <BentoGrid>
        {writer && open?.kind === 'account' ? (
          <BankAccountFormCard
            key={open.editing?.id ?? 'new'}
            editing={open.editing}
            accountNo={open.editing ? writer.numbers[open.editing.id] : undefined}
            today={open.today}
            canSignOff={writer.canSignOff}
            actions={writer.actions}
            onClose={() => setOpened(null)}
            onSaved={(text) => {
              setNote({ kind: 'text', title: open.editing ? 'Account saved' : 'Account added', text });
              setOpened(null);
            }}
          />
        ) : null}
        {transfers && open?.kind === 'transfer' ? (
          <TransferFormCard
            accounts={accounts}
            today={open.today}
            record={transfers.record}
            onClose={() => setOpened(null)}
            onRecorded={(written) => {
              setNote({ kind: 'recorded', written });
              setOpened(null);
            }}
          />
        ) : null}
        {writer && !formOpen && note && noteText ? (
          <SavedNoteCard title={note.kind === 'recorded' ? 'Transfer recorded' : note.title} subtitle="Banking" onClose={() => setNote(null)}>
            {noteText}
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
                  onEdit: (account) => openOnly({ kind: 'account', today: localIsoDate(new Date()), editing: account }),
                  archiving: open?.kind === 'archive' ? open.accountId : null,
                  onArchiving: (id) => (id ? openOnly({ kind: 'archive', accountId: id }) : setOpened(null)),
                  // Its menus wait while a form is open, or while a question is being asked in the other table.
                  locked: accountsLocked(open, voiding.pending),
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
                  {offers.actionsColumn ? (
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (ledger.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                        No money has moved yet. A payment recorded on any finance screen shows here.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((r) => {
                  const status = reconcileLabel(r);
                  const description = bankDescription(r);
                  if (transfers && open?.kind === 'void' && open.transactionId === r.transaction_id) {
                    return (
                      <ConfirmRow
                        key={r.transaction_id}
                        colSpan={columns}
                        label={`Void transfer ${transferName(r)}`}
                        confirmLabel="Void transfer"
                        pendingLabel="Voiding…"
                        pending={voiding.pending}
                        error={voiding.error}
                        icon={Ban}
                        onConfirm={() =>
                          voiding.run(
                            () => transfers.void(voidPayload(r)),
                            () => {
                              // Only its own question: a form opened since is left as it is.
                              setOpened((o) => closeOwnVoid(o, r.transaction_id));
                              setNote({ kind: 'text', title: 'Transfer voided', text: transferVoidedNote(r) });
                            },
                          )
                        }
                        onCancel={() => {
                          voiding.clear();
                          setOpened(null);
                        }}
                      >
                        Void transfer <span className="font-medium">{transferName(r)}</span>, dated {displayDate(r.txn_date)}?{' '}
                        {voidTransferEffect(r, rows)}
                      </ConfirmRow>
                    );
                  }
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
                      {offers.actionsColumn ? (
                        <TableCell>
                          {/* Its menus wait while a form is open, a void is under way, or a question is being asked in the other table. */}
                          {bankRowActions(r, true).length === 0 || voidMenuWaits(open, voiding.pending) ? null : (
                            <RowMenu
                              label={transferName(r)}
                              items={[
                                {
                                  label: 'Void transfer',
                                  icon: Ban,
                                  destructive: true,
                                  opens: true,
                                  onSelect: () => openOnly({ kind: 'void', transactionId: r.transaction_id }),
                                },
                              ]}
                            />
                          )}
                        </TableCell>
                      ) : null}
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
        {fxRates !== undefined ? <FxRatesCard rates={fxRates} today={fxToday ?? today} /> : null}
      </BentoGrid>
    </ScreenContainer>
  );
}
