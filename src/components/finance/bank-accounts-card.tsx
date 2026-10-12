'use client';

import { useState } from 'react';
import { Archive, ArchiveRestore, Banknote, Landmark, Pencil, Wallet } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type BankAccountAction, bankAccountActions, bankAccountRows, bankAccountArchiveEffect, bankAccountArchivedNote, bankAccountRestoredNote } from '@/lib/finance/bank-account-form';
import type { SavedBankAccount } from '@/lib/finance/bank-accounts';
import type { BankAccountRow } from '@/lib/finance/banking';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

/** What only a person who may write is given: the account numbers, and the archive action. */
export type BankAccountsCardWriter = {
  /** Account numbers by account id; an account with none is absent. */
  numbers: Record<string, string>;
  setActive: (input: unknown) => Promise<FinResult<SavedBankAccount>>;
  /** Opens the account form for this account. */
  onEdit: (account: BankAccountRow) => void;
  /** True while the account form is open: it holds what was typed, so nothing else opens over it. */
  locked: boolean;
};

/**
 * Every account of the workspace, archived ones included: the one place an
 * archived account with nothing in it can be seen and restored. Everyone
 * reads it. A person who may write (`writer`) also sees the end of each
 * account number and gets a menu: Edit, and Archive or Restore. Archive is
 * asked in the row; Restore loses nothing and is done at once.
 */
export function BankAccountsCard({ accounts, writer }: { accounts: BankAccountRow[]; writer?: BankAccountsCardWriter }) {
  const [archiving, setArchiving] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const archive = useFinanceAction();
  const restore = useFinanceAction();

  const rows = bankAccountRows(accounts, writer?.numbers);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const columns = writer ? 6 : 5;

  const menuItem = (account: BankAccountRow, action: BankAccountAction): RowMenuItem => {
    switch (action) {
      case 'edit':
        return {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => {
            setArchiving(null);
            setNote(null);
            writer?.onEdit(account);
          },
        };
      case 'archive':
        return {
          label: 'Archive',
          icon: Archive,
          opens: true,
          onSelect: () => {
            archive.clear();
            restore.clear();
            setNote(null);
            setArchiving(account.id);
          },
        };
      case 'restore':
        return {
          label: 'Restore',
          icon: ArchiveRestore,
          onSelect: () => {
            setNote(null);
            restore.run(
              () => writer!.setActive({ id: account.id, active: true }),
              (saved) => setNote(bankAccountRestoredNote(saved.name)),
            );
          },
        };
    }
  };

  return (
    <BentoCard
      title="Accounts"
      subtitle="Bank accounts and cash, archived ones included"
      icon={Wallet}
      flush
      className="col-span-2 md:col-span-12"
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Account</TableHead>
              <TableHead>Bank</TableHead>
              <TableHead>Opening balance</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead>Status</TableHead>
              {writer ? (
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                  No accounts yet.{writer ? ' Add the bank account or cash your money moves through.' : ''}
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((row) => {
              const account = byId.get(row.id)!;
              if (writer && archiving === row.id) {
                return (
                  <ConfirmRow
                    key={row.id}
                    colSpan={columns}
                    label={`Archive ${row.name}`}
                    confirmLabel="Archive account"
                    pendingLabel="Archiving…"
                    pending={archive.pending}
                    error={archive.error}
                    tone="default"
                    icon={Archive}
                    onConfirm={() =>
                      archive.run(
                        () => writer.setActive({ id: row.id, active: false }),
                        (saved) => {
                          setArchiving(null);
                          setNote(bankAccountArchivedNote(saved.name));
                        },
                      )
                    }
                    onCancel={() => {
                      archive.clear();
                      setArchiving(null);
                    }}
                  >
                    Archive <span className="font-medium">{row.name}</span>? {bankAccountArchiveEffect(account)}
                  </ConfirmRow>
                );
              }
              return (
                <TableRow key={row.id} className={cn(!row.active && 'opacity-60')}>
                  <TableCell className="min-w-36 max-w-64 whitespace-normal break-words font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {row.kind === 'cash' ? <Banknote className="size-3.5 shrink-0" /> : <Landmark className="size-3.5 shrink-0" />}
                      {row.name}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-32 max-w-64 whitespace-normal break-words text-muted-foreground">{row.bank}</TableCell>
                  <TableCell className="min-w-40 whitespace-normal text-muted-foreground">{row.opening}</TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">{row.balance}</TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
                        row.active ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {row.active ? 'Active' : 'Archived'}
                    </span>
                  </TableCell>
                  {writer ? (
                    <TableCell>
                      {writer.locked || archive.pending || restore.pending ? null : (
                        <RowMenu label={row.name} items={bankAccountActions(row).map((action) => menuItem(account, action))} />
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {restore.error ? (
        <p role="alert" className="border-t px-4 py-3 text-sm text-destructive">
          {restore.error}
        </p>
      ) : null}
      {note ? (
        <p role="status" className="border-t px-4 py-3 text-sm text-muted-foreground">
          {note}
        </p>
      ) : null}
    </BentoCard>
  );
}
