'use client';

import { type FormEvent, useId, useState } from 'react';
import { Wallet } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ExpenseCategory } from '@/lib/finance/expenses';
import { type FinanceAccount, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/lib/finance/money';
import type { FinResult } from '@/lib/finance/result';
import {
  TYPED_PAYEE,
  type VoucherForm,
  newVoucherForm,
  voucherFormError,
  voucherPayload,
  voucherSaveHint,
  voucherSubmitLabel,
} from '@/lib/finance/voucher-form';
import type { RecordedVoucher } from '@/lib/finance/vouchers';

export type VoucherFormActions = {
  record: (input: unknown) => Promise<FinResult<RecordedVoucher>>;
};

/** What the card hands back after a save: the voucher, how the database left it, and what was typed, for the screen's note. */
export type RecordedVoucherNote = RecordedVoucher & { payee: string; amount: number; date: string };

/**
 * One new payment voucher for money that settles no document: who is paid (a
 * contact or a typed name), an expense category, an amount, the account it
 * leaves, the date, the method, a reference and notes. There is one button:
 * the database approves the voucher when the person recording it is an owner
 * or admin (`canDecide`) and makes it wait for approval otherwise, and the
 * card says which it will be before the save. Nothing is paid here. A card
 * of its own, opened by the Payment Vouchers screen; the rules are in
 * src/lib/finance/voucher-form.ts.
 */
export function VoucherFormCard({
  accounts,
  contacts,
  categories,
  today,
  canDecide,
  actions,
  onClose,
}: {
  /** Active accounts, contacts and expense categories. */
  accounts: FinanceAccount[];
  contacts: { id: string; name: string }[];
  categories: ExpenseCategory[];
  /** The default date, YYYY-MM-DD: the person's own local date. */
  today: string;
  /** True for an owner or admin: what they save is approved. */
  canDecide: boolean;
  actions: VoucherFormActions;
  /** Called when the card should go: after a save (told what was recorded), or Cancel. */
  onClose: (recorded?: RecordedVoucherNote) => void;
}) {
  const id = useId();
  const [form, setForm] = useState<VoucherForm>(() => newVoucherForm(accounts, categories, today));
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };
  const typed = form.payee === TYPED_PAYEE;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const problem = voucherFormError(form);
    if (problem) {
      save.fail(problem);
      return;
    }
    const payload = voucherPayload(form);
    const payee = typed ? form.payeeName.trim() : (contacts.find((c) => c.id === form.payee)?.name ?? '—');
    save.run(
      () => actions.record(payload),
      (recorded) => onClose({ ...recorded, payee, amount: payload.amount, date: payload.txn_date }),
    );
  };

  return (
    <BentoCard
      title="New voucher"
      subtitle="Money paid out that settles no bill and no expense"
      icon={Wallet}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-payee`}>Paid to</Label>
          <Select value={form.payee} onValueChange={(v) => edit((f) => ({ ...f, payee: v }))}>
            {/* The first field takes focus when the card opens. */}
            <SelectTrigger id={`${id}-payee`} className="w-full" autoFocus data-finance-focus>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Radix refuses an empty value, so "not a contact" has one of its own. */}
              <SelectItem value={TYPED_PAYEE}>Not a contact</SelectItem>
              {contacts.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {typed ? (
          <div className="space-y-1.5 md:col-span-3">
            <Label htmlFor={`${id}-payee-name`}>Name</Label>
            <Input
              id={`${id}-payee-name`}
              value={form.payeeName}
              maxLength={200}
              placeholder="Who is paid"
              autoComplete="off"
              onChange={(e) => edit((f) => ({ ...f, payeeName: e.target.value }))}
            />
          </div>
        ) : null}
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-category`}>Expense category</Label>
          <Select value={form.categoryId} onValueChange={(v) => edit((f) => ({ ...f, categoryId: v }))}>
            <SelectTrigger id={`${id}-category`} className="w-full">
              <SelectValue placeholder={categories.length ? 'Choose a category' : 'No expense category'} />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-amount`}>Amount (RM)</Label>
          <Input
            id={`${id}-amount`}
            // A text box, as on the expense form: a number box hands back nothing for "1,200.50", and the form could not say why.
            type="text"
            inputMode="decimal"
            className="text-right tabular-nums"
            placeholder="0.00"
            autoComplete="off"
            value={form.amount}
            onChange={(e) => edit((f) => ({ ...f, amount: e.target.value }))}
          />
        </div>

        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-account`}>Paid from</Label>
          <Select value={form.accountId} onValueChange={(v) => edit((f) => ({ ...f, accountId: v }))}>
            <SelectTrigger id={`${id}-account`} className="w-full">
              <SelectValue placeholder={accounts.length ? 'Choose an account' : 'No account'} />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  {a.bank_name ? ` · ${a.bank_name}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>Date to pay</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={form.date}
            required
            onChange={(e) => edit((f) => ({ ...f, date: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-method`}>Method</Label>
          <Select value={form.method} onValueChange={(v) => edit((f) => ({ ...f, method: v as PaymentMethod }))}>
            <SelectTrigger id={`${id}-method`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYMENT_METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-reference`}>Reference</Label>
          <Input
            id={`${id}-reference`}
            value={form.reference}
            maxLength={200}
            placeholder="Bank reference or cheque no."
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, reference: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-12">
          <Label htmlFor={`${id}-notes`}>Notes</Label>
          <Input
            id={`${id}-notes`}
            value={form.notes}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>

        <p className="text-xs text-muted-foreground md:col-span-12">{voucherSaveHint(canDecide)}</p>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : voucherSubmitLabel(canDecide)}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onClose()} disabled={save.pending}>
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
