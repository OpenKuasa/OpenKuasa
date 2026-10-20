'use client';

import { type FormEvent, useId, useState } from 'react';
import { Banknote } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { type FxRateLookup, MovementRateFields, accountLabel } from '@/components/finance/movement-rate-fields';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CashReceiptKind, CashReceiptRow } from '@/lib/finance/cash-book';
import {
  type CashReceiptForm,
  TYPED_PAYER,
  afterRefusedReceiptSave,
  cashReceiptAccounts,
  cashReceiptFormError,
  cashReceiptPayload,
  cashReceiptRateNotes,
  cashReceiptTotal,
  chooseCashReceiptAccount,
  chooseCashReceiptKind,
  chooseReceiptCustomer,
  editCashReceiptForm,
  keepReceiptInvoices,
  leftOutInvoicesNote,
  newCashReceiptForm,
  receiptOnForeignAccount,
  receiptSavedNotPosted,
  receivableFor,
  recordCashReceiptPayload,
  toggleAllReceiptInvoices,
  toggleReceiptInvoice,
  withCashReceiptFx,
  withCurrent,
} from '@/lib/finance/cash-receipt-form';
import { CASH_RECEIPT_MESSAGES, type IncomeCategory, type SaveAndPostCashReceiptResult } from '@/lib/finance/cash-receipts';
import { ringgitFields, withRateAnswer, withRateTyped } from '@/lib/finance/document-currency';
import { rm } from '@/lib/finance/format';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import {
  type FinanceAccount,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type PaymentInRow,
  type PaymentMethod,
} from '@/lib/finance/money';
import { PAYMENT_IN_KIND, invoicesOf, receiptCustomers } from '@/lib/finance/receipt-form';
import { type FinResult, WRITE_FAILED } from '@/lib/finance/result';
import { displayDate } from '@/lib/finance/view-helpers';

export type CashReceiptFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  saveAndPost: (input: unknown) => Promise<SaveAndPostCashReceiptResult>;
  /** Records income into an account in another currency and posts it at once, with its rate (stage 5b). */
  record?: (input: unknown) => Promise<FinResult<{ id: string; number: string }>>;
  /** Bank Negara's selling rate, for that rate. */
  fxRate?: FxRateLookup;
};

const KIND_LABELS: Record<CashReceiptKind, string> = {
  income: 'Other income',
  invoice: 'A customer’s invoices',
};

/**
 * One cash receipt, new or a draft being changed: for one customer's posted
 * invoices, split across them, or for an income category, with an amount and
 * whoever paid. "Save draft" is for anyone who may write. "Post receipt" is
 * shown to an owner or admin only (`canSignOff`): the database refuses the
 * post to anyone else, so a member is told who posts it instead. A card of
 * its own, opened by the Cash Receipts screen; the rules are in
 * src/lib/finance/cash-receipt-form.ts.
 */
export function CashReceiptFormCard({
  editing,
  invoices,
  payments,
  accounts,
  contacts,
  categories,
  today,
  canSignOff,
  actions,
  onClose,
}: {
  /** The draft being changed; absent for a new receipt. */
  editing?: CashReceiptRow;
  /** Every invoice, and every payment in (one row per invoice paid), to find what can still take a receipt. */
  invoices: InvoiceListRow[];
  payments: PaymentInRow[];
  /** Active accounts, contacts and income categories. */
  accounts: FinanceAccount[];
  contacts: { id: string; name: string }[];
  categories: IncomeCategory[];
  /** The default date, YYYY-MM-DD: the person's own local date. */
  today: string;
  /** True for an owner or admin, who may post. */
  canSignOff: boolean;
  actions: CashReceiptFormActions;
  /** Called when the card should go: after a save, or Cancel. After a post it is told which receipt, and its date. */
  onClose: (posted?: { id: string; number: string; date: string }) => void;
}) {
  const id = useId();
  const [typed, setForm] = useState<CashReceiptForm>(() =>
    editing
      ? editCashReceiptForm(editing, payments)
      : newCashReceiptForm(accounts, categories, today, receivableFor(invoices, payments)),
  );
  const [posting, setPosting] = useState(false);
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  // What this draft itself holds of its invoices is not counted against it.
  const receivable = receivableFor(invoices, payments, typed.id);
  // A ticked invoice that was paid off since a refresh is dropped from everything below.
  const form = keepReceiptInvoices(typed, receivable);
  const forInvoices = form.kind === 'invoice';
  const offered = invoicesOf(receivable, form.customerId);
  const tickedCount = Object.keys(form.amounts).length;
  const leftOut = leftOutInvoicesNote(typed, receivable);
  // Stage 5b: into an account in another currency, income only, recorded at once with its rate.
  const onAccount = receiptOnForeignAccount(form);
  const fx = form.fx ?? ringgitFields();

  // A draft may name an account, a contact, a category or a customer that is no longer offered: it stays the draft's.
  const accountChoices = withCurrent(
    accounts,
    // A draft is on a ringgit account: none is ever saved on one in another currency (FIN50).
    editing ? { id: editing.account_id, name: editing.account_name, kind: editing.account_kind, bank_name: null, currency: 'MYR' } : null,
  );
  const income = editing && editing.kind === 'income' ? editing : null;
  const payerChoices = withCurrent(
    contacts,
    income?.contact_id ? { id: income.contact_id, name: income.party_name ?? '—' } : null,
  );
  const categoryChoices = withCurrent(
    categories,
    income?.category_id ? { id: income.category_id, name: income.category_name ?? '—' } : null,
  );
  const customers = withCurrent(
    receiptCustomers(receivable),
    editing && editing.kind === 'invoice' && editing.contact_id
      ? { id: editing.contact_id, name: editing.party_name ?? '—', open: 0 }
      : null,
  );

  const send = (post: boolean) => {
    const problem = cashReceiptFormError(form, receivable, canSignOff);
    if (problem) {
      save.fail(problem);
      return;
    }
    const date = form.date;
    // Into an account in another currency: recorded and posted in one call, never a draft (stage 5b).
    if (onAccount) {
      const record = actions.record;
      if (!record) {
        save.fail(WRITE_FAILED);
        return;
      }
      setPosting(true);
      save.run(
        () => record(recordCashReceiptPayload(form)),
        (posted) => onClose({ id: posted.id, number: posted.number, date }),
      );
      return;
    }
    const payload = cashReceiptPayload(form);
    setPosting(post);
    // A draft that someone deleted meanwhile is offered again as a new receipt.
    const forgetGone = <R extends FinResult<unknown>>(result: R): R => {
      if (result.ok) return result;
      const after = afterRefusedReceiptSave(form, result.error);
      // Only the id is forgotten: anything typed while the save was pending is kept.
      if (after.form !== form) setForm((f) => ({ ...f, id: undefined }));
      return { ...result, error: after.error };
    };
    if (!post) {
      save.run(async () => forgetGone(await actions.save(payload)), () => onClose());
      return;
    }
    save.run(
      async () => {
        const result = await actions.saveAndPost(payload);
        // Saved but not posted: go on editing that draft, so a second try does not save a second receipt.
        if (!result.ok && result.draftId) {
          const draftId = result.draftId;
          setForm((f) => ({ ...f, id: draftId }));
          return { ...result, error: receiptSavedNotPosted(result.error) };
        }
        return forgetGone(result);
      },
      (posted) => onClose({ id: posted.id, number: posted.number, date }),
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed. Into an account in another
    // currency there is no draft: the one button records it.
    event.preventDefault();
    send(onAccount);
  };

  return (
    <BentoCard
      title={form.id ? 'Edit receipt' : 'New receipt'}
      subtitle={form.id ? 'A draft: it has no number until it is posted' : 'Money received into cash or bank'}
      icon={Banknote}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <fieldset className="space-y-1.5 md:col-span-12">
          <legend className="text-sm font-medium leading-none">What it is for</legend>
          <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1">
            {(['income', 'invoice'] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-kind`}
                  className="size-4 accent-primary"
                  checked={form.kind === kind}
                  onChange={() => edit((f) => chooseCashReceiptKind(f, kind))}
                  // The choice that is checked takes focus when a row's menu opens the card, so a key press does not change it.
                  autoFocus={form.kind === kind}
                  data-finance-focus={form.kind === kind ? '' : undefined}
                />
                {KIND_LABELS[kind]}
              </label>
            ))}
          </div>
          {onAccount ? (
            <p className="text-xs text-muted-foreground">{CASH_RECEIPT_MESSAGES.invoicesOnInvoices(fx.currency)}</p>
          ) : null}
        </fieldset>

        {forInvoices ? (
          <>
            <div className="space-y-1.5 md:col-span-5">
              <Label htmlFor={`${id}-customer`}>Received from</Label>
              <Select value={form.customerId} onValueChange={(v) => edit((f) => chooseReceiptCustomer(f, v))}>
                <SelectTrigger id={`${id}-customer`} className="w-full">
                  <SelectValue placeholder="Choose a customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} ({c.open} open)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <fieldset className="space-y-1.5 md:col-span-12">
              <legend className="text-sm font-medium leading-none">Invoices paid</legend>
              {customers.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  {PAYMENT_IN_KIND.words.nothing}
                </p>
              ) : offered.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  {form.customerId
                    ? 'This customer has no invoice that can take a payment now.'
                    : 'Choose a customer to see their open invoices.'}
                </p>
              ) : (
                // Twenty open invoices scroll inside the card rather than pushing the buttons off the page.
                <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
                  {offered.map((d) => {
                    const ticked = d.id in form.amounts;
                    return (
                      <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
                        <label className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 shrink-0 accent-primary"
                            checked={ticked}
                            onChange={(e) => edit((f) => toggleReceiptInvoice(f, d, e.target.checked))}
                          />
                          <span className="min-w-0">
                            <span className="font-medium">{d.invoice_no}</span>
                            <span className={d.overdue ? 'ml-2 text-red-600' : 'ml-2 text-muted-foreground'}>
                              {d.overdue ? 'Overdue since' : 'Due'} {displayDate(d.due_date)}
                            </span>
                            <span className="block text-xs text-muted-foreground tabular-nums">{PAYMENT_IN_KIND.owed(d)}</span>
                          </span>
                        </label>
                        {ticked ? (
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-muted-foreground" aria-hidden>
                              RM
                            </span>
                            <Input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              step="0.01"
                              aria-label={PAYMENT_IN_KIND.amountLabel(d)}
                              className="w-32 text-right tabular-nums"
                              onWheel={(e) => e.currentTarget.blur()}
                              // Enter in an amount box does not save the receipt half typed.
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.preventDefault();
                              }}
                              value={form.amounts[d.id]}
                              onChange={(e) => edit((f) => ({ ...f, amounts: { ...f.amounts, [d.id]: e.target.value } }))}
                            />
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {leftOut ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {leftOut}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm" aria-live="polite">
                  Total <span className="font-semibold tabular-nums">{rm(cashReceiptTotal(form))}</span>
                  {tickedCount ? (
                    <span className="text-muted-foreground">
                      {' '}
                      across {tickedCount} {tickedCount === 1 ? 'invoice' : 'invoices'}
                    </span>
                  ) : null}
                </p>
                {offered.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => edit((f) => toggleAllReceiptInvoices(f, offered, tickedCount < offered.length))}
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
              <Label htmlFor={`${id}-payer`}>Received from</Label>
              <Select value={form.payer} onValueChange={(v) => edit((f) => ({ ...f, payer: v }))}>
                <SelectTrigger id={`${id}-payer`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TYPED_PAYER}>Not a contact</SelectItem>
                  {payerChoices.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.payer === TYPED_PAYER ? (
              <div className="space-y-1.5 md:col-span-3">
                <Label htmlFor={`${id}-payer-name`}>Name</Label>
                <Input
                  id={`${id}-payer-name`}
                  value={form.payerName}
                  maxLength={200}
                  placeholder="Who paid (optional)"
                  autoComplete="off"
                  onChange={(e) => edit((f) => ({ ...f, payerName: e.target.value }))}
                />
              </div>
            ) : null}
            <div className="space-y-1.5 md:col-span-3">
              <Label htmlFor={`${id}-category`}>Income category</Label>
              <Select value={form.categoryId} onValueChange={(v) => edit((f) => ({ ...f, categoryId: v }))}>
                <SelectTrigger id={`${id}-category`} className="w-full">
                  <SelectValue placeholder={categoryChoices.length ? 'Choose a category' : 'No income category'} />
                </SelectTrigger>
                <SelectContent>
                  {categoryChoices.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 md:col-span-3">
              <Label htmlFor={`${id}-amount`}>Amount ({onAccount ? fx.currency : 'RM'})</Label>
              <Input
                id={`${id}-amount`}
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                className="text-right tabular-nums"
                onWheel={(e) => e.currentTarget.blur()}
                // Enter in the amount box does not save the receipt half typed.
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                value={form.amount}
                onChange={(e) => edit((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
          </>
        )}

        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-account`}>Paid into</Label>
          <Select
            value={form.accountId}
            onValueChange={(v) => {
              const chosen = accountChoices.find((a) => a.id === v);
              if (chosen) edit((f) => chooseCashReceiptAccount(f, chosen));
            }}
          >
            <SelectTrigger id={`${id}-account`} className="w-full">
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {cashReceiptAccounts(form, accountChoices).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {accountLabel(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>Date received</Label>
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
        {onAccount ? (
          <MovementRateFields
            id={id}
            className="space-y-1.5 md:col-span-12"
            fx={fx}
            date={form.date}
            fxRate={actions.fxRate}
            onAnswer={(key, answer) =>
              setForm((f) => withCashReceiptFx(f, withRateAnswer(f.fx ?? ringgitFields(), f.date, key, answer, true)))
            }
            onTyped={(text) => edit((f) => withCashReceiptFx(f, withRateTyped(f.fx ?? ringgitFields(), text)))}
            notes={cashReceiptRateNotes(form)}
          />
        ) : null}
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

        <p className="text-xs text-muted-foreground md:col-span-12">
          {onAccount
            ? canSignOff
              ? 'Income into an account in another currency is recorded as received and posted at once, at the rate above: there is no draft.'
              : CASH_RECEIPT_MESSAGES.postedByDecider
            : canSignOff
              ? 'A draft has no number and counts as nothing received until it is posted.'
              : 'You can save this as a draft. An owner or admin posts it: until then it has no number and counts as nothing received.'}
          {forInvoices ? ' While it is a draft it holds its part of each invoice, so nobody else can receive that part.' : ''}
        </p>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          {onAccount ? (
            canSignOff ? (
              <Button type="submit" size="sm" disabled={save.pending}>
                {save.pending ? 'Recording…' : 'Record receipt'}
              </Button>
            ) : null
          ) : (
            <Button type="submit" size="sm" variant={canSignOff ? 'outline' : 'default'} disabled={save.pending}>
              {save.pending && !posting ? 'Saving…' : 'Save draft'}
            </Button>
          )}
          {canSignOff && !onAccount ? (
            <Button type="button" size="sm" disabled={save.pending} onClick={() => send(true)}>
              {save.pending && posting ? 'Posting…' : 'Post receipt'}
            </Button>
          ) : null}
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
