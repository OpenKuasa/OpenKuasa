'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { Archive, ArchiveRestore, CircleCheck, Download, ListTree, Pencil, Plus, Search, Trash2, ShieldAlert } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AccountFormCard, type AccountFormActions } from '@/components/finance/account-form-card';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { AccountType, LedgerAccount } from '@/lib/finance/ledger';
import { STANDS_FOR_LABELS, accountActions, accountsCsv, groupAccounts, toolbarError, trialBalance } from '@/lib/finance/ledger-views';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

export type AccountActions = AccountFormActions & {
  setActive: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What only an owner or admin is given: the actions. A member reads the chart and exports it. */
export type AccountsWriter = { actions: AccountActions };

/** The accounts matching the search text (in the code or the name), archived ones only when asked for. */
export function filterAccounts(accounts: LedgerAccount[], query: string, showArchived: boolean): LedgerAccount[] {
  const q = query.trim().toLowerCase();
  return accounts.filter((a) => (showArchived || a.active) && `${a.code} ${a.name}`.toLowerCase().includes(q));
}

type Open = { kind: 'new' } | { kind: 'edit'; account: LedgerAccount } | { kind: 'delete'; account: LedgerAccount } | null;

/**
 * The chart of accounts: accounts by kind with their balances, whether the books balance, search, archived
 * accounts on request and Export. An owner or admin (`writer`) also gets New account and a menu on each row.
 */
export function AccountsView({
  accounts,
  writer,
  initialShowArchived = false,
}: {
  accounts: LedgerAccount[];
  writer?: AccountsWriter;
  initialShowArchived?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(initialShowArchived);
  const [open, setOpen] = useState<Open>(null);
  const rowAction = useFinanceAction();
  const deleteAction = useFinanceAction();

  const shown = filterAccounts(accounts, query, showArchived);
  const groups = groupAccounts(shown);
  const all = groupAccounts(accounts);
  // Totals are over every account of the kind, shown or not, so a heading and the headline always agree.
  const totalOf = (type: AccountType) => all.find((g) => g.type === type)?.total ?? 0;
  const books = trialBalance(accounts);
  const columns = writer ? 5 : 4;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen = open?.kind === 'new' || open?.kind === 'edit';
  // A row that is gone after a refresh takes its delete question with it; the message still has to be seen.
  const askingInView = open?.kind === 'delete' ? shown.some((a) => a.id === open.account.id) : false;
  const tableError = toolbarError(deleteAction.error, open?.kind === 'delete', askingInView);
  const locked = rowAction.pending || formOpen;
  const now = () => localIsoDate(new Date());
  const close = () => {
    deleteAction.clear();
    setOpen(null);
  };

  const menu = (account: LedgerAccount, w: AccountsWriter): RowMenuItem[] =>
    accountActions(account, true).map((action): RowMenuItem => {
      switch (action) {
        case 'edit':
          return {
            label: 'Edit',
            icon: Pencil,
            opens: true,
            onSelect: () => {
              rowAction.clear();
              setOpen({ kind: 'edit', account });
            },
          };
        case 'archive':
          return {
            label: 'Archive',
            icon: Archive,
            onSelect: () => rowAction.run(() => w.actions.setActive({ id: account.id, active: false })),
          };
        case 'unarchive':
          return {
            label: 'Unarchive',
            icon: ArchiveRestore,
            onSelect: () => rowAction.run(() => w.actions.setActive({ id: account.id, active: true })),
          };
        case 'delete':
          return {
            label: 'Delete',
            icon: Trash2,
            destructive: true,
            opens: true,
            onSelect: () => {
              rowAction.clear();
              deleteAction.clear();
              setOpen({ kind: 'delete', account });
            },
          };
      }
    });

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Chart of Accounts"
        subtitle="Your double-entry account structure, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => {
                rowAction.clear();
                setOpen({ kind: 'new' });
              }}
            >
              <Plus className="size-4" />
              New account
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {writer && open?.kind === 'new' ? <AccountFormCard key="new" actions={writer.actions} onClose={close} /> : null}
        {writer && open?.kind === 'edit' ? (
          <AccountFormCard key={open.account.id} editing={open.account} actions={writer.actions} onClose={close} />
        ) : null}

        <BentoCard tone="primary" className="col-span-1 md:col-span-4">
          <BentoStat label="Total assets" value={rm(totalOf('asset'))} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat label="Total liabilities" value={rm(totalOf('liability'))} />
        </BentoCard>
        <BentoCard
          title={books.balanced ? 'Books balance' : `Out of balance by ${rm(Math.abs(books.debit - books.credit))}`}
          subtitle={`${rm(books.debit)} debit and ${rm(books.credit)} credit`}
          icon={books.balanced ? CircleCheck : ShieldAlert}
          className="col-span-2 md:col-span-4"
        />

        <BentoCard
          title="Accounts"
          subtitle="Code, name, what it stands for and balance"
          icon={ListTree}
          flush
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2 px-4">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search accounts by code or name"
                placeholder="Search accounts…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Label className="flex items-center gap-2 text-sm font-normal">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </Label>
            <Button
              variant="outline"
              size="sm"
              disabled={shown.length === 0}
              onClick={() => downloadCsv(csvFileName('chart-of-accounts', now()), accountsCsv(shown))}
            >
              <Download className="size-4" />
              Export
            </Button>
            {rowAction.error || tableError ? (
              <p role="alert" className="text-sm text-destructive">
                {rowAction.error ?? tableError}
              </p>
            ) : null}
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Stands for</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  {writer ? (
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (accounts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                        No accounts yet.{writer ? ' Add the first one with New account.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {groups.map((g) => (
                  <Fragment key={g.type}>
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell colSpan={columns} className="font-semibold">
                        <span className="flex items-center justify-between gap-3">
                          <span>{g.label}</span>
                          <span className="tabular-nums">{rm(totalOf(g.type))}</span>
                        </span>
                      </TableCell>
                    </TableRow>
                    {g.accounts.map((a) => {
                      if (writer && open?.kind === 'delete' && open.account.id === a.id) {
                        return (
                          <ConfirmRow
                            key={a.id}
                            colSpan={columns}
                            label={`Delete ${a.name}`}
                            confirmLabel="Delete account"
                            pendingLabel="Deleting…"
                            pending={deleteAction.pending}
                            error={deleteAction.error}
                            onConfirm={() => deleteAction.run(() => writer.actions.remove({ id: a.id }), close)}
                            onCancel={close}
                          >
                            Delete <span className="font-medium">{a.code} {a.name}</span>? This cannot be undone. An
                            account with journal lines cannot be deleted; archive it instead.
                          </ConfirmRow>
                        );
                      }
                      const items = writer ? menu(a, writer) : [];
                      const href = `/finance/journals?account=${a.id}`;
                      return (
                        <TableRow key={a.id} className={cn(!a.active && 'opacity-60')}>
                          <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{a.code}</TableCell>
                          <TableCell className="whitespace-nowrap font-medium">
                            <Link href={href} className="underline-offset-4 hover:underline">
                              {a.name}
                            </Link>
                            {a.active ? null : (
                              <Badge variant="secondary" className="ml-2">
                                Archived
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{STANDS_FOR_LABELS[a.stands_for]}</TableCell>
                          <TableCell className="whitespace-nowrap text-right tabular-nums">
                            <Link href={href} className="underline-offset-4 hover:underline">
                              {rm(a.balance)}
                            </Link>
                          </TableCell>
                          {writer ? (
                            <TableCell>
                              {items.length ? (
                                // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                                <span inert={locked} className={cn(locked && 'opacity-50')}>
                                  <RowMenu label={`${a.code} ${a.name}`} items={items} />
                                </span>
                              ) : null}
                            </TableCell>
                          ) : null}
                        </TableRow>
                      );
                    })}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {accounts.length} accounts
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
