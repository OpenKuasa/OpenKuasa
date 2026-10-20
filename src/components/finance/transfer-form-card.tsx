'use client';

import { type FormEvent, useId, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { BankAccountRow } from '@/lib/finance/banking';
import { BASE_CURRENCY, currencyLabel } from '@/lib/finance/currencies';
import { money } from '@/lib/finance/format';
import type { FinResult } from '@/lib/finance/result';
import {
  type RecordedTransferNote,
  type TransferForm,
  needsTwoAmounts,
  newTransferForm,
  recordedTransfer,
  transferAccounts,
  transferFormError,
  transferOverdrawNote,
  transferPayload,
  transferRateNote,
  transferToOptions,
  withTransferFrom,
} from '@/lib/finance/transfer-form';
import type { RecordedTransfer } from '@/lib/finance/transfers';

/**
 * Moves money between two of the workspace's active accounts. Only an owner
 * or admin is given this card. The transfer is recorded whole: both sides are
 * posted at once with one TR- number. A transfer for more than the account
 * holds is taken, with a line that says what it leaves the account at.
 *
 * Stage 5c: between a ringgit account and one in another currency the card
 * asks for both amounts, each in its own account's currency, and shows the
 * rate they say. "To" offers ringgit accounts only when "From" is in another
 * currency.
 */
export function TransferFormCard({
  accounts,
  today,
  record,
  onClose,
  onRecorded,
  initial,
}: {
  /** What the form starts with besides the date. Only the tests set it: a person always starts with an empty form. */
  initial?: Partial<TransferForm>;
  /** Every account; only the active ones are offered. */
  accounts: BankAccountRow[];
  /** The person's own date when the form was opened, YYYY-MM-DD. */
  today: string;
  record: (input: unknown) => Promise<FinResult<RecordedTransfer>>;
  onClose: () => void;
  /** Called with what was recorded; the form is then closed by the caller. */
  onRecorded: (written: RecordedTransferNote) => void;
}) {
  const id = useId();
  const [form, setForm] = useState<TransferForm>(() => ({ ...newTransferForm(today), ...initial }));
  const save = useFinanceAction();
  const set = (patch: Partial<TransferForm>) => setForm((f) => ({ ...f, ...patch }));
  const fromOptions = transferAccounts(accounts);
  const toOptions = transferToOptions(accounts, form.from);
  const overdraw = transferOverdrawNote(form, accounts);
  const twoAmounts = needsTwoAmounts(form, accounts);
  // One row of twelve columns: From and To narrow to 3 when the second amount box shows (3 + 3 + 2 + 2 + 2).
  const endsSpan = twoAmounts ? 'md:col-span-3' : 'md:col-span-4';
  const rateNote = transferRateNote(form, accounts);
  const currencyOf = (accountId: string) => accounts.find((a) => a.id === accountId)?.currency ?? BASE_CURRENCY;
  const fromCurrency = currencyOf(form.from);
  const toCurrency = currencyOf(form.to);
  const option = (a: BankAccountRow) => `${a.name} · ${money(a.balance, a.currency)}`;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = transferFormError(form, accounts);
    if (problem) {
      save.fail(problem);
      return;
    }
    save.run(
      () => record(transferPayload(form, accounts)),
      (saved) => onRecorded(recordedTransfer(form, accounts, saved)),
    );
  };

  return (
    <BentoCard title="Transfer" subtitle="Move money between two of your accounts" icon={ArrowLeftRight} className="col-span-2 md:col-span-12">
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className={`space-y-1.5 ${endsSpan}`}>
          <Label htmlFor={`${id}-from`}>From</Label>
          <Select value={form.from} onValueChange={(v) => setForm((f) => withTransferFrom(f, v, accounts))}>
            <SelectTrigger id={`${id}-from`} className="w-full" autoFocus data-finance-focus>
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {fromOptions.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {option(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className={`space-y-1.5 ${endsSpan}`}>
          <Label htmlFor={`${id}-to`}>To</Label>
          <Select value={form.to} onValueChange={(v) => set({ to: v })}>
            <SelectTrigger id={`${id}-to`} className="w-full">
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {toOptions.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {option(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`${id}-amount`}>{twoAmounts ? `Amount leaving (${currencyLabel(fromCurrency)})` : `Amount (${currencyLabel(fromCurrency)})`}</Label>
          {/* A text box, not a number box: a number box hands back nothing at all for "1,500", so the form could not say what is wrong. */}
          <Input
            id={`${id}-amount`}
            value={form.amount}
            inputMode="decimal"
            placeholder="0.00"
            autoComplete="off"
            aria-describedby={overdraw ? `${id}-overdraw` : undefined}
            onChange={(e) => set({ amount: e.target.value })}
          />
        </div>
        {twoAmounts ? (
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor={`${id}-to-amount`}>Amount arriving ({currencyLabel(toCurrency)})</Label>
            <Input
              id={`${id}-to-amount`}
              value={form.toAmount}
              inputMode="decimal"
              placeholder="0.00"
              autoComplete="off"
              aria-describedby={rateNote ? `${id}-rate` : undefined}
              onChange={(e) => set({ toAmount: e.target.value })}
            />
          </div>
        ) : null}
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`${id}-date`}>Date</Label>
          <Input id={`${id}-date`} type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} />
        </div>
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-reference`}>Reference</Label>
          <Input
            id={`${id}-reference`}
            value={form.reference}
            maxLength={200}
            autoComplete="off"
            placeholder="The bank’s reference, if any"
            onChange={(e) => set({ reference: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 md:col-span-8">
          <Label htmlFor={`${id}-notes`}>Notes</Label>
          <Input id={`${id}-notes`} value={form.notes} maxLength={200} autoComplete="off" onChange={(e) => set({ notes: e.target.value })} />
        </div>
        {twoAmounts ? (
          <p id={`${id}-rate`} className="text-sm text-muted-foreground md:col-span-12">
            {rateNote
              ? `That is ${rateNote}. Both accounts are booked at the ringgit amount; a transfer records no exchange gain or loss.`
              : `Enter what left, in ${currencyLabel(fromCurrency)}, and what arrived, in ${currencyLabel(toCurrency)}: the rate is what the two say.`}
          </p>
        ) : null}
        {overdraw ? (
          <p id={`${id}-overdraw`} role="status" className="text-sm text-amber-600 md:col-span-12">
            {overdraw}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground md:col-span-12">
          Both accounts change at once and the transfer gets a TR- number. It cannot be edited afterwards, only voided.
        </p>
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Recording…' : 'Record transfer'}
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
