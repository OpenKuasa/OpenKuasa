'use client';

import { type FormEvent, useId, useState } from 'react';
import { Wallet } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  type BankAccountForm,
  bankAccountFormError,
  bankAccountOpeningChange,
  bankAccountPayload,
  bankAccountSavedNote,
  editBankAccountForm,
  newBankAccountForm,
} from '@/lib/finance/bank-account-form';
import { BANK_ACCOUNT_BANK_MAX, BANK_ACCOUNT_NAME_MAX, BANK_ACCOUNT_NUMBER_MAX, type BankAccountKind, type SavedBankAccount } from '@/lib/finance/bank-accounts';
import type { BankAccountRow } from '@/lib/finance/banking';
import { rm } from '@/lib/finance/format';
import type { FinResult } from '@/lib/finance/result';
import { displayDate } from '@/lib/finance/view-helpers';

export type BankAccountFormActions = {
  create: (input: unknown) => Promise<FinResult<SavedBankAccount>>;
  update: (input: unknown) => Promise<FinResult<SavedBankAccount>>;
};

/**
 * Adds a bank or cash account, or changes one. Bank or cash is chosen when
 * the account is added and only shown after that. The opening balance and
 * its date are an owner's or admin's (`canSignOff`): anyone else is not given
 * the two boxes, is told who sets them, and sends neither.
 */
export function BankAccountFormCard({
  editing,
  accountNo,
  today,
  canSignOff,
  actions,
  onClose,
  onSaved,
}: {
  /** The account being changed, or null for a new one. */
  editing: BankAccountRow | null;
  /** The number of the account being changed; only someone who may write is given it. */
  accountNo?: string;
  /** The person's own date when the form was opened, YYYY-MM-DD: what a new opening balance is dated. */
  today: string;
  canSignOff: boolean;
  actions: BankAccountFormActions;
  onClose: () => void;
  /** Called with the sentence to show once the account is saved; the form is then closed by the caller. */
  onSaved: (note: string) => void;
}) {
  const id = useId();
  const [form, setForm] = useState<BankAccountForm>(() =>
    editing ? editBankAccountForm(editing, accountNo, today) : newBankAccountForm(today),
  );
  const save = useFinanceAction();
  const set = (patch: Partial<BankAccountForm>) => setForm((f) => ({ ...f, ...patch }));
  const atBank = form.kind === 'bank';

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = bankAccountFormError(form, canSignOff);
    if (problem) {
      save.fail(problem);
      return;
    }
    const payload = bankAccountPayload(form, canSignOff);
    const change = bankAccountOpeningChange(form, editing, canSignOff);
    save.run(
      () => (editing ? actions.update(payload) : actions.create(payload)),
      (saved) => onSaved(bankAccountSavedNote(saved.name, !editing, change)),
    );
  };

  return (
    <BentoCard
      title={editing ? 'Edit account' : 'Add account'}
      subtitle={editing ? `Changing ${editing.name}` : 'A bank account, or cash you keep'}
      icon={Wallet}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            value={form.name}
            maxLength={BANK_ACCOUNT_NAME_MAX}
            placeholder="Main Bank"
            autoComplete="off"
            autoFocus
            data-finance-focus
            required
            aria-describedby={editing ? `${id}-name-help` : undefined}
            onChange={(e) => set({ name: e.target.value })}
          />
          {editing ? (
            <p id={`${id}-name-help`} className="text-xs text-muted-foreground">
              Renaming it also renames its account in the Chart of Accounts, unless that one was renamed there.
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label id={`${id}-kind-label`} htmlFor={editing ? undefined : `${id}-kind`}>
            Kind
          </Label>
          {editing ? (
            <p role="group" aria-labelledby={`${id}-kind-label`} className="flex h-9 items-center text-sm text-muted-foreground">
              {atBank ? 'Bank account' : 'Cash'} · set when it was added
            </p>
          ) : (
            <Select value={form.kind} onValueChange={(v) => set({ kind: v as BankAccountKind })}>
              <SelectTrigger id={`${id}-kind`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bank">Bank account</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        {atBank ? (
          <>
            <div className="space-y-1.5 md:col-span-4">
              <Label htmlFor={`${id}-bank`}>Bank</Label>
              <Input
                id={`${id}-bank`}
                value={form.bankName}
                maxLength={BANK_ACCOUNT_BANK_MAX}
                placeholder="Maybank"
                autoComplete="off"
                onChange={(e) => set({ bankName: e.target.value })}
              />
            </div>
            <div className="space-y-1.5 md:col-span-4">
              <Label htmlFor={`${id}-number`}>Account number</Label>
              <Input
                id={`${id}-number`}
                value={form.accountNo}
                maxLength={BANK_ACCOUNT_NUMBER_MAX}
                autoComplete="off"
                className="font-mono"
                onChange={(e) => set({ accountNo: e.target.value })}
              />
            </div>
          </>
        ) : null}
        {canSignOff ? (
          <>
            <div className="space-y-1.5 md:col-span-4">
              <Label htmlFor={`${id}-opening`}>Opening balance (RM)</Label>
              {/* A text box, not a number box: a number box hands back nothing at all for "1,500", so the form could not say what is wrong. No inputMode: a phone's decimal keypad has no minus sign, and an overdraft needs one. */}
              <Input
                id={`${id}-opening`}
                value={form.opening}
                placeholder="0.00"
                autoComplete="off"
                aria-describedby={`${id}-opening-help`}
                onChange={(e) => set({ opening: e.target.value })}
              />
            </div>
            <div className="space-y-1.5 md:col-span-4">
              <Label htmlFor={`${id}-date`}>As at</Label>
              <Input id={`${id}-date`} type="date" value={form.openingDate} onChange={(e) => set({ openingDate: e.target.value })} />
            </div>
            <p id={`${id}-opening-help`} className="text-sm text-muted-foreground md:col-span-12">
              What the account held before anything was recorded here. Leave it empty for none; use a minus sign for an
              overdraft. Every balance and the books change with it.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground md:col-span-12">
            {editing && editing.opening_balance !== 0
              ? `Opening balance ${rm(editing.opening_balance)} as at ${displayDate(editing.opening_date)}. `
              : ''}
            An owner or admin sets an opening balance.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : editing ? 'Save changes' : 'Add account'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}
