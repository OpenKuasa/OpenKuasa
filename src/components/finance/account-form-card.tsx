'use client';

import { type FormEvent, useId, useState } from 'react';
import { ListTree, Plus } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { FinResult } from '@/lib/finance/result';
import type { AccountType, LedgerAccount } from '@/lib/finance/ledger';
import { accountFormError, accountFormFrom, accountPayload, newAccountForm } from '@/lib/finance/ledger-form';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_ORDER } from '@/lib/finance/ledger-views';

export type AccountFormActions = {
  create: (input: unknown) => Promise<FinResult<{ id: string }>>;
  update: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/**
 * A new account of the workspace's own (code, name and kind), or a saved account being renamed (code and name:
 * its kind is shown, not changed). The rules are in src/lib/finance/ledger-form.ts.
 */
export function AccountFormCard({
  editing,
  actions,
  onClose,
}: {
  editing?: LedgerAccount;
  actions: AccountFormActions;
  onClose: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState(() => (editing ? accountFormFrom(editing) : newAccountForm()));
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit = (next: Partial<typeof form>) => {
    save.clear();
    setForm((f) => ({ ...f, ...next }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const problem = accountFormError(form);
    if (problem) {
      save.fail(problem);
      return;
    }
    const payload = accountPayload(form);
    save.run(() => (form.id ? actions.update(payload) : actions.create(payload)), onClose);
  };

  return (
    <BentoCard
      title={editing ? 'Edit account' : 'New account'}
      subtitle={editing ? `Changing ${editing.name}` : 'An account of your own'}
      icon={editing ? ListTree : Plus}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-code`}>Code</Label>
          <Input
            id={`${id}-code`}
            value={form.code}
            maxLength={10}
            placeholder="6400"
            autoComplete="off"
            autoFocus
            data-finance-focus
            required
            className="font-mono tabular-nums"
            onChange={(e) => edit({ code: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 md:col-span-6">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            value={form.name}
            maxLength={200}
            placeholder="Staff Training"
            autoComplete="off"
            required
            onChange={(e) => edit({ name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          {editing ? (
            <>
              <span className="block text-sm font-medium leading-none">Type</span>
              <p className="flex h-8 items-center text-sm text-muted-foreground">
                {ACCOUNT_TYPE_LABELS[editing.type]}
                <span className="sr-only">, which cannot be changed</span>
              </p>
            </>
          ) : (
            <>
              <Label htmlFor={`${id}-type`}>Type</Label>
              <Select value={form.type} onValueChange={(v) => edit({ type: v as AccountType })}>
                <SelectTrigger id={`${id}-type`} className="w-full">
                  <SelectValue placeholder="Choose a type" />
                </SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPE_ORDER.map((type) => (
                    <SelectItem key={type} value={type}>
                      {ACCOUNT_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
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
