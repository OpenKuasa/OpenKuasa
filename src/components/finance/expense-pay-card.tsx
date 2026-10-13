'use client';

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Banknote } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  type ExpensePaidNote,
  type ExpensePayForm,
  type PaidExpense,
  expensePayError,
  expensePayHint,
  expensePayPayload,
  newExpensePayForm,
} from '@/lib/finance/expense-payment';
import type { ExpenseRow } from '@/lib/finance/expenses';
import { rm } from '@/lib/finance/format';
import { type FinanceAccount, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/lib/finance/money';
import type { FinResult } from '@/lib/finance/result';
import { displayDate } from '@/lib/finance/view-helpers';

export type ExpensePayAction = (input: unknown) => Promise<FinResult<PaidExpense>>;

/**
 * Marks one approved expense paid: the account the money leaves, the date
 * paid, the method, a reference, and the amount, which starts as all that is
 * left of the expense and may be lowered to pay part of it. Who is paid is
 * the expense's vendor and is not a field. It records a payment voucher,
 * paid now; the card says so, and where it shows. Given only to an owner or
 * admin, by the Expenses screen; the rules are in
 * src/lib/finance/expense-payment.ts.
 */
export function ExpensePayCard({
  row,
  gone = false,
  accounts,
  today,
  pay,
  onClose,
}: {
  /** The expense, as the screen has it now: it follows a refresh. */
  row: ExpenseRow;
  /** True when the list no longer holds the expense: the hint says so and nothing is sent. */
  gone?: boolean;
  /** Active bank and cash accounts. */
  accounts: FinanceAccount[];
  /** The default date paid, YYYY-MM-DD: the person's own local date. */
  today: string;
  pay: ExpensePayAction;
  /** Called when the card should go: after a payment (told what was paid), or Cancel. */
  onClose: (paid?: ExpensePaidNote) => void;
}) {
  const id = useId();
  const [form, setForm] = useState<ExpensePayForm>(() => newExpensePayForm(row, accounts, today));
  const save = useFinanceAction();
  const alert = useRef<HTMLParagraphElement>(null);
  // The card can be taller than a phone's window and the refusal sits beside the buttons at its foot: bring it into view.
  useEffect(() => {
    if (save.error) alert.current?.scrollIntoView?.({ block: 'nearest' });
  }, [save.error]);
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const problem = expensePayError(row, form, accounts, gone);
    if (problem) {
      save.fail(problem);
      return;
    }
    const payload = expensePayPayload(row, form);
    const account = accounts.find((a) => a.id === form.accountId)?.name ?? '—';
    save.run(
      () => pay(payload),
      (paid) =>
        onClose({
          amount: payload.amount,
          vendor: row.vendor_name,
          account,
          number: paid.number,
          expenseId: row.id,
          paidBefore: row.paid,
        }),
    );
  };

  return (
    <BentoCard title="Mark expense paid" subtitle="Record the payment of an approved expense" icon={Banknote} className="col-span-2 md:col-span-12">
      <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-3 md:grid-cols-12">
        {/* The expense being paid, in words that wrap: a long vendor or category is never cut off. */}
        <p className="min-w-0 [overflow-wrap:anywhere] text-sm md:col-span-12">
          <span className="font-medium">{rm(row.amount)}</span> to <span className="font-medium">{row.vendor_name}</span>, dated{' '}
          {displayDate(row.expense_date)} · {row.category_name}
        </p>
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-account`}>Paid from</Label>
          <Select value={form.accountId} onValueChange={(v) => edit((f) => ({ ...f, accountId: v }))}>
            <SelectTrigger id={`${id}-account`} className="w-full" autoFocus data-finance-focus>
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
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-date`}>Date paid</Label>
          <Input id={`${id}-date`} type="date" value={form.date} required onChange={(e) => edit((f) => ({ ...f, date: e.target.value }))} />
        </div>
        <div className="space-y-1.5 md:col-span-4">
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
        <div className="space-y-1.5 md:col-span-8">
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
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-amount`}>Amount paid (RM)</Label>
          {/* A text box, as on the expense form: a number box hands back nothing for "1,200.50", and the card could not say why. */}
          <Input
            id={`${id}-amount`}
            type="text"
            inputMode="decimal"
            className="text-right tabular-nums"
            placeholder="0.00"
            autoComplete="off"
            value={form.amount}
            onChange={(e) => edit((f) => ({ ...f, amount: e.target.value }))}
          />
        </div>

        <p className="text-xs text-muted-foreground md:col-span-12">{expensePayHint(row, gone)}</p>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : 'Mark paid'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onClose()} disabled={save.pending}>
            Cancel
          </Button>
          {save.error ? (
            <p ref={alert} role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}
