'use client';

import { type FormEvent, useId, useState } from 'react';
import { Wallet } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { OrderNotes } from '@/components/finance/order-notes';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ticked, tickedAll } from '@/lib/finance/allocation-form';
import type { ExpenseCategory } from '@/lib/finance/expenses';
import { rm } from '@/lib/finance/format';
import { type FinanceAccount, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/lib/finance/money';
import { type PayableBill, billsOf, paymentSuppliers } from '@/lib/finance/payment-form';
import { type OrderBilling, orderNotesForBills } from '@/lib/finance/purchase-views';
import type { FinResult } from '@/lib/finance/result';
import { displayDate } from '@/lib/finance/view-helpers';
import {
  TYPED_PAYEE,
  type VoucherForm,
  type VoucherFormKind,
  chooseVoucherKind,
  chooseVoucherSupplier,
  keepVoucherBills,
  newVoucherForm,
  voucherBillOwed,
  voucherDateLabel,
  voucherDraftLabel,
  voucherFirstWrite,
  voucherFormError,
  voucherPayload,
  voucherPaysNow,
  voucherSaveHint,
  voucherSavePayload,
  voucherSubmitLabel,
  voucherTotal,
} from '@/lib/finance/voucher-form';
import type { RecordedVoucher } from '@/lib/finance/vouchers';

export type VoucherFormActions = {
  /** Records a new voucher for a category at once: approved, or paid when asked, for an owner or admin; waiting for anyone else. */
  record: (input: unknown) => Promise<FinResult<RecordedVoucher>>;
  /** Saves a draft, new or changed, and sends it for approval in the same call when asked. */
  save: (input: unknown) => Promise<FinResult<RecordedVoucher>>;
};

/** What the card hands back after a save: the voucher, how the database left it, and what was typed, for the screen's note. */
export type RecordedVoucherNote = RecordedVoucher & { payee: string; amount: number; date: string };

/**
 * One payment voucher, new or a draft being edited (`draft`). It is for an
 * expense category (who is paid, a category, an amount) or for one supplier's
 * bills (the supplier, the bills ticked and what each takes; the amount is
 * their sum). Either can be saved as a draft. A voucher for bills, and any
 * draft, is sent for approval by the first button, whoever presses it; a new
 * voucher for a category is recorded at once, which approves it when the
 * person is an owner or admin (`canDecide`), who may also record it as paid
 * now. The card says which before the save. No supplier payment is scheduled
 * or paid here: one that needs no approval is recorded on Payments Out. The
 * rules are in src/lib/finance/voucher-form.ts.
 */
export function VoucherFormCard({
  accounts,
  contacts,
  categories,
  payable,
  orders,
  today,
  canDecide,
  draft,
  actions,
  onClose,
}: {
  /** Active accounts, contacts and expense categories. */
  accounts: FinanceAccount[];
  contacts: { id: string; name: string }[];
  categories: ExpenseCategory[];
  /** Every bill that can still take a payment (`voucherPayableBills`: the draft being edited does not count against them). */
  payable: PayableBill[];
  /** The purchase orders the bills may be raised against, to advise on the bills ticked. */
  orders: OrderBilling[];
  /** The default date, YYYY-MM-DD: the person's own local date. */
  today: string;
  /** True for an owner or admin: a new category voucher they save is approved, and they may record it as paid now. */
  canDecide: boolean;
  /** The draft being edited, as a form (`draftVoucherForm`); absent for a new voucher. */
  draft?: VoucherForm;
  actions: VoucherFormActions;
  /** Called when the card should go: after a save (told what was recorded), or Cancel. */
  onClose: (recorded?: RecordedVoucherNote) => void;
}) {
  const id = useId();
  const [typedForm, setForm] = useState<VoucherForm>(() => draft ?? newVoucherForm(accounts, categories, today));
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };
  // A ticked bill that was paid off since a refresh is dropped from everything below.
  const form = keepVoucherBills(typedForm, payable);
  const typed = form.payee === TYPED_PAYEE;
  const forBills = form.kind === 'bills';
  // "When" is offered where the first button records: a new voucher for a category, to someone who may sign off.
  const offersWhen = canDecide && voucherFirstWrite(form) === 'record';
  const paysNow = voucherPaysNow(canDecide, form);
  const suppliers = paymentSuppliers(payable);
  const offered = billsOf(payable, form.supplierId);
  const tickedCount = Object.keys(form.amounts).length;
  const orderNotes = forBills
    ? orderNotesForBills(
        offered.filter((b) => b.id in form.amounts),
        orders,
      )
    : [];

  /** `send` is the first button (record, or save and send for approval); otherwise the draft is saved and stays a draft. */
  const write = (send: boolean) => {
    const problem = voucherFormError(form, payable);
    if (problem) {
      save.fail(problem);
      return;
    }
    const payee = forBills
      ? (suppliers.find((s) => s.id === form.supplierId)?.name ?? '—')
      : typed
        ? form.payeeName.trim()
        : (contacts.find((c) => c.id === form.payee)?.name ?? '—');
    const note = { payee, amount: voucherTotal(form), date: form.date };
    const call =
      send && voucherFirstWrite(form) === 'record'
        ? () => actions.record(voucherPayload(form, paysNow))
        : () => actions.save(voucherSavePayload(form, send));
    save.run(call, (recorded) => onClose({ ...recorded, ...note }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    write(true);
  };

  return (
    <BentoCard
      title={form.id ? 'Edit draft voucher' : 'New voucher'}
      subtitle={forBills ? 'A payment for a supplier’s bills, saved as a draft or sent for approval' : 'Money paid out that settles no bill and no expense'}
      icon={Wallet}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-kind`}>What it is for</Label>
          <Select value={form.kind} onValueChange={(v) => edit((f) => chooseVoucherKind(f, v as VoucherFormKind))}>
            {/* The first field takes focus when the card opens. */}
            <SelectTrigger id={`${id}-kind`} className="w-full" autoFocus data-finance-focus>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="category">An expense category</SelectItem>
              <SelectItem value="bills">A supplier’s bills</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {forBills ? (
          <>
            <div className="space-y-1.5 md:col-span-5">
              <Label htmlFor={`${id}-supplier`}>Supplier</Label>
              {/* The key keeps this select apart from "Paid to" (the first child of the other branch): React would otherwise reuse one Radix select across a change of kind, and it answers the change with an empty value. */}
              <Select key="supplier" value={form.supplierId} onValueChange={(v) => edit((f) => chooseVoucherSupplier(f, v))}>
                <SelectTrigger id={`${id}-supplier`} className="w-full min-w-0">
                  <SelectValue placeholder={suppliers.length ? 'Choose a supplier' : 'No supplier has a bill to pay'} />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} ({s.bills} open)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <fieldset className="space-y-1.5 md:col-span-12">
              <legend className="text-sm font-medium leading-none">Bills to pay</legend>
              {suppliers.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  There is no bill to pay. A bill can be paid once it is posted, and until payments and vouchers cover it in full.
                </p>
              ) : offered.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  Choose a supplier to see their open bills.
                </p>
              ) : (
                // Twenty open bills scroll inside the card rather than pushing the buttons off the page.
                <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
                  {offered.map((b) => {
                    const isTicked = b.id in form.amounts;
                    return (
                      <li key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
                        <label className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 shrink-0 accent-primary"
                            checked={isTicked}
                            onChange={(e) => edit((f) => ticked(f, b, e.target.checked))}
                          />
                          <span className="min-w-0">
                            <span className="font-medium">{b.bill_no}</span>
                            <span className={b.overdue ? 'ml-2 text-red-600' : 'ml-2 text-muted-foreground'}>
                              {b.overdue ? 'Overdue since' : 'Due'} {displayDate(b.due_date)}
                            </span>
                            <span className="block text-xs text-muted-foreground tabular-nums">{voucherBillOwed(b)}</span>
                          </span>
                        </label>
                        {isTicked ? (
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-muted-foreground" aria-hidden>
                              RM
                            </span>
                            <Input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              step="0.01"
                              aria-label={`Amount to pay on ${b.bill_no}`}
                              className="w-32 text-right tabular-nums"
                              onWheel={(e) => e.currentTarget.blur()}
                              // Enter in an amount box does not send the voucher half typed.
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.preventDefault();
                              }}
                              value={form.amounts[b.id]}
                              onChange={(e) => edit((f) => ({ ...f, amounts: { ...f.amounts, [b.id]: e.target.value } }))}
                            />
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {/* The same advice, in the same words, as the Payments Out form gives under its ticked bills. */}
              <OrderNotes notes={orderNotes} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm" aria-live="polite">
                  Total <span className="font-semibold tabular-nums">{rm(voucherTotal(form))}</span>
                  {tickedCount ? (
                    <span className="text-muted-foreground">
                      {' '}
                      across {tickedCount} {tickedCount === 1 ? 'bill' : 'bills'}
                    </span>
                  ) : null}
                </p>
                {offered.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => edit((f) => tickedAll(f, offered, tickedCount < offered.length))}
                  >
                    {tickedCount < offered.length ? 'Tick all' : 'Clear all'}
                  </Button>
                ) : null}
              </div>
            </fieldset>
          </>
        ) : (
          <>
            <div className="space-y-1.5 md:col-span-3">
              <Label htmlFor={`${id}-payee`}>Paid to</Label>
              <Select key="payee" value={form.payee} onValueChange={(v) => edit((f) => ({ ...f, payee: v }))}>
                <SelectTrigger id={`${id}-payee`} className="w-full min-w-0">
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
          </>
        )}

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
          <Label htmlFor={`${id}-date`}>{voucherDateLabel(paysNow)}</Label>
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

        {offersWhen ? (
          <fieldset className="space-y-1.5 md:col-span-12">
            <legend className="text-sm font-medium leading-none">When</legend>
            <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-when`}
                  className="size-4 accent-primary"
                  checked={!form.paidNow}
                  onChange={() => edit((f) => ({ ...f, paidNow: false }))}
                />
                To be paid
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-when`}
                  className="size-4 accent-primary"
                  checked={form.paidNow === true}
                  onChange={() => edit((f) => ({ ...f, paidNow: true }))}
                />
                Paid now
              </label>
            </div>
          </fieldset>
        ) : null}

        <div className="space-y-1 md:col-span-12">
          {voucherSaveHint(canDecide, form).map((line) => (
            <p key={line} className="text-xs text-muted-foreground">
              {line}
            </p>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : voucherSubmitLabel(canDecide, form)}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => write(false)} disabled={save.pending}>
            {voucherDraftLabel(form)}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onClose()} disabled={save.pending}>
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
