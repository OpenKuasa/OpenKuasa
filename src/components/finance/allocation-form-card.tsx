'use client';

import { type FormEvent, useId, useState } from 'react';
import { Banknote } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { type FxRateLookup, MovementRateFields, accountLabel } from '@/components/finance/movement-rate-fields';
import { OrderNotes } from '@/components/finance/order-notes';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AllocationFormKind, AllocationFormState, Payable } from '@/lib/finance/allocation-form';
import { withRateAnswer, withRateTyped } from '@/lib/finance/document-currency';
import { money } from '@/lib/finance/format';
import { type FinanceAccount, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/lib/finance/money';
import type { FinResult } from '@/lib/finance/result';
import { displayDate } from '@/lib/finance/view-helpers';

export type RecordPayment = (input: unknown) => Promise<FinResult<{ id: string }>>;

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Records one payment to a supplier or from a customer, split across their
 * open bills or invoices. `kind` says which it is and carries its rules,
 * which are in src/lib/finance/payment-form.ts and receipt-form.ts.
 */
export function AllocationFormCard<F extends AllocationFormState, D extends Payable>({
  kind,
  documents,
  accounts,
  today,
  preselect,
  notes,
  record,
  fxRate,
  onClose,
}: {
  kind: AllocationFormKind<F, D>;
  /** Every bill or invoice that can still take a payment. */
  documents: D[];
  accounts: FinanceAccount[];
  /** The default payment date, YYYY-MM-DD. */
  today: string;
  /** Opened from a document's row: that party chosen and that document ticked. */
  preselect?: { partyId: string; documentId: string };
  /** Advice on the documents ticked, as sentences shown under them; never a refusal. Absent for no advice. */
  notes?: (form: F) => string[];
  record: RecordPayment;
  /** Bank Negara's selling rate for a date, for a payment on an account in another currency (stage 5b). */
  fxRate?: FxRateLookup;
  onClose: () => void;
}) {
  const id = useId();
  const [typed, setForm] = useState(() => kind.newForm(documents, accounts, today, preselect));
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  const { words } = kind;
  const parties = kind.parties(documents);
  // A ticked document that was paid off since a refresh is dropped from everything below.
  const form = kind.keep(typed, documents);
  // One currency at a time when documents may be in another (money in): the ticked ones' currency.
  const offered = kind.currency ? kind.currency.offered(form, documents) : kind.documentsOf(documents, kind.partyId(form));
  const code = kind.currency?.of(form) ?? 'MYR';
  const ringgit = kind.currency?.ringgit;
  const askRinggit = ringgit?.needed(form) ?? false;
  const tickedCount = Object.keys(form.amounts).length;
  // A payment that cannot wait (a bill in another currency) is offered no "Schedule for later".
  const schedule = kind.schedule && (kind.schedule.offered?.(form) ?? true) ? kind.schedule : undefined;
  const scheduled = schedule?.is(form) ?? false;
  // Stage 5b: the accounts offered as the form stands, and the rate when the one chosen is in another currency.
  const account = kind.account;
  const offeredAccounts = account ? account.offered(form, accounts) : accounts;
  const fx = account?.fx(form);
  const rateAsked = account !== undefined && fx !== undefined && fx.currency !== 'MYR';

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const problem = kind.error(form, documents);
    if (problem) {
      save.fail(problem);
      return;
    }
    save.run(() => record(kind.payload(form)), onClose);
  };

  if (parties.length === 0) {
    return (
      <BentoCard title="Record payment" subtitle={words.subtitle} icon={Banknote} className="col-span-2 md:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">{words.nothing}</p>
          <Button type="button" variant="outline" size="sm" onClick={onClose} autoFocus data-finance-focus>
            Close
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </BentoCard>
    );
  }

  return (
    <BentoCard title="Record payment" subtitle={words.subtitle} icon={Banknote} className="col-span-2 md:col-span-12">
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-5">
          <Label htmlFor={`${id}-party`}>{capital(words.party)}</Label>
          <Select value={kind.partyId(form)} onValueChange={(v) => edit((f) => kind.chooseParty(f, v))}>
            <SelectTrigger id={`${id}-party`} className="w-full" autoFocus data-finance-focus>
              <SelectValue placeholder={`Choose a ${words.party}`} />
            </SelectTrigger>
            <SelectContent>
              {parties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} ({p.open} open)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <fieldset className="space-y-1.5 md:col-span-12">
          <legend className="text-sm font-medium leading-none">{words.documents}</legend>
          {offered.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
              Choose a {words.party} to see their open {words.document}s.
            </p>
          ) : (
            // Twenty open documents scroll inside the card rather than pushing the buttons off the page.
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
                        onChange={(e) => edit((f) => kind.toggle(f, d, e.target.checked))}
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{kind.number(d)}</span>
                        <span className={d.overdue ? 'ml-2 text-red-600' : 'ml-2 text-muted-foreground'}>
                          {d.overdue ? 'Overdue since' : 'Due'} {displayDate(d.due_date)}
                        </span>
                        <span className="block text-xs text-muted-foreground tabular-nums">{kind.owed(d)}</span>
                      </span>
                    </label>
                    {ticked ? (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground" aria-hidden>
                          {code === 'MYR' ? 'RM' : code}
                        </span>
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.01"
                          aria-label={kind.amountLabel(d)}
                          className="w-32 text-right tabular-nums"
                          onWheel={(e) => e.currentTarget.blur()}
                          // Enter in an amount box does not record the payment half typed.
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
          {notes ? <OrderNotes notes={notes(form)} /> : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm" aria-live="polite">
              Total <span className="font-semibold tabular-nums">{money(kind.total(form), code)}</span>
              {tickedCount ? (
                <span className="text-muted-foreground">
                  {' '}
                  across {tickedCount} {tickedCount === 1 ? words.document : `${words.document}s`}
                </span>
              ) : null}
            </p>
            {offered.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => edit((f) => kind.toggleAll(f, offered, tickedCount < offered.length))}
              >
                {tickedCount < offered.length ? 'Tick all' : 'Clear all'}
              </Button>
            ) : null}
          </div>
        </fieldset>

        {ringgit && askRinggit ? (
          <div className="space-y-1.5 md:col-span-12">
            <Label htmlFor={`${id}-ringgit`}>{ringgit.label}</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground" aria-hidden>
                RM
              </span>
              <Input
                id={`${id}-ringgit`}
                inputMode="decimal"
                autoComplete="off"
                className="w-40 text-right tabular-nums"
                aria-describedby={`${id}-ringgit-hint`}
                // Enter in the box does not record the payment half typed.
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                value={ringgit.value(form)}
                onChange={(e) => edit((f) => ringgit.set(f, e.target.value))}
              />
            </div>
            <p id={`${id}-ringgit-hint`} className="text-xs text-muted-foreground">
              {ringgit.hint}
            </p>
            {ringgit.notes(form, documents).map((note) => (
              <p key={note} className="text-sm text-muted-foreground" aria-live="polite">
                {note}
              </p>
            ))}
          </div>
        ) : null}

        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-account`}>{words.account}</Label>
          <Select
            value={form.accountId}
            onValueChange={(v) =>
              edit((f) => {
                const chosen = accounts.find((a) => a.id === v);
                return chosen && account ? account.choose(f, chosen) : { ...f, accountId: v };
              })
            }
          >
            <SelectTrigger id={`${id}-account`} className="w-full">
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {offeredAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {accountLabel(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>{scheduled ? 'Planned date' : words.date}</Label>
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
        {rateAsked && account && fx ? (
          <MovementRateFields
            id={id}
            className="space-y-1.5 md:col-span-12"
            fx={fx}
            date={form.date}
            fxRate={fxRate}
            onAnswer={(key, answer) =>
              setForm((f) => account.setFx(f, withRateAnswer(account.fx(f), f.date, key, answer, true)))
            }
            onTyped={(text) => edit((f) => account.setFx(f, withRateTyped(account.fx(f), text)))}
            notes={account.notes(form, documents)}
          />
        ) : null}
        <div className={schedule ? 'space-y-1.5 md:col-span-7' : 'space-y-1.5 md:col-span-12'}>
          <Label htmlFor={`${id}-notes`}>Notes</Label>
          <Input
            id={`${id}-notes`}
            value={form.notes}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>
        {schedule ? (
          <fieldset className="space-y-1.5 md:col-span-5">
            <legend className="text-sm font-medium leading-none">When</legend>
            <div className="flex h-8 flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-when`}
                  className="size-4 accent-primary"
                  checked={!scheduled}
                  onChange={() => edit((f) => schedule.set(f, false))}
                />
                Pay now
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-when`}
                  className="size-4 accent-primary"
                  checked={scheduled}
                  onChange={() => edit((f) => schedule.set(f, true))}
                />
                Schedule for later
              </label>
            </div>
          </fieldset>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : scheduled ? 'Schedule payment' : words.submit}
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
