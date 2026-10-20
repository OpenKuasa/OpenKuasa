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
import { ringgitFields, withRateAnswer, withRateTyped } from '@/lib/finance/document-currency';
import { money } from '@/lib/finance/format';
import { type FinanceAccount, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/lib/finance/money';
import {
  type RefundSaved,
  type RefundTarget,
  chooseRefundAccount,
  chooseRefundTarget,
  foreignRefundTarget,
  keepRefundTarget,
  newRefundForm,
  offeredRefundTargets,
  refundAccounts,
  refundAmountLabel,
  refundFormError,
  refundFromForeignAccount,
  refundNeedsRinggit,
  refundPayload,
  refundPreviewNotes,
  refundSaved,
  refundTargetLabel,
  withRefundFx,
  withRefundRinggit,
} from '@/lib/finance/refund-form';
import { REFUND_REASONS, REFUND_REASON_LABELS, type RefundReason } from '@/lib/finance/refunds';
import type { FinResult } from '@/lib/finance/result';

export type RecordRefund = (input: unknown) => Promise<FinResult<{ id: string }>>;

const SUBTITLE = 'Money paid back to a customer who is in credit';

/**
 * Records one refund against one invoice whose customer is in credit, or
 * against one of its issued credit notes: paid out now, or left pending.
 * Used on Refunds, on Invoices from an invoice's Refund choice and on Credit
 * Notes from a credit note's (`preselect`). A refund is one payment for one
 * document with a reason, so it has its own card. On an invoice in another
 * currency the amount is in its currency, the ringgit that left the account
 * is asked for, and it is paid out now (no "Pay later"). From an account in that currency (stage 5b) the rate is
 * asked instead of the ringgit. The rules are in src/lib/finance/refund-form.ts.
 */
export function RefundFormCard({
  targets,
  accounts,
  today,
  preselect,
  record,
  fxRate,
  onClose,
  onSaved,
}: {
  /** Everything that can be refunded, from `refundTargets`. */
  targets: RefundTarget[];
  accounts: FinanceAccount[];
  /** The default refund date, YYYY-MM-DD. */
  today: string;
  /** Opened from a row: the key of that invoice or credit note. */
  preselect?: string;
  record: RecordRefund;
  /** Bank Negara's selling rate, for a refund from an account in another currency (stage 5b). */
  fxRate?: FxRateLookup;
  onClose: () => void;
  /**
   * Called instead of `onClose` once the refund is recorded, where the page has something to say about it.
   * It is handed what was recorded: the picker is open, so that need not be the row the card was opened from.
   */
  onSaved?: (saved: RefundSaved) => void;
}) {
  const id = useId();
  const [typed, setForm] = useState(() => newRefundForm(targets, accounts, today, preselect));
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  // A choice that was refunded in another tab since a refresh is dropped from everything below.
  const form = keepRefundTarget(typed, targets);
  const chosen = targets.find((t) => t.key === form.target);
  // An invoice in another currency: refunded in its currency, now; from a ringgit account the ringgit is asked.
  const foreign = foreignRefundTarget(form, targets);
  const asksRinggit = refundNeedsRinggit(form, targets);
  // Stage 5b: from an account in another currency, that currency's invoices, the rate, paid out now.
  const onAccount = refundFromForeignAccount(form);
  const fx = form.fx ?? ringgitFields();
  const offered = offeredRefundTargets(form, targets);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const problem = refundFormError(form, targets);
    if (problem) {
      save.fail(problem);
      return;
    }
    // Taken now, from the form that is sent: after the refresh this target may no longer be offered.
    const saved = refundSaved(form, targets);
    save.run(
      () => record(refundPayload(form, targets)),
      () => (onSaved && saved ? onSaved(saved) : onClose()),
    );
  };

  if (targets.length === 0) {
    return (
      <BentoCard title="Record refund" subtitle={SUBTITLE} icon={Banknote} className="col-span-2 md:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            There is nothing to refund. A refund pays out what a customer is in credit on a posted invoice: more paid
            and credited than the invoice came to, less any refund that is already waiting to be paid out.
          </p>
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
    <BentoCard title="Record refund" subtitle={SUBTITLE} icon={Banknote} className="col-span-2 md:col-span-12">
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-6">
          <Label htmlFor={`${id}-target`}>Refund for</Label>
          <Select
            value={form.target}
            onValueChange={(v) => {
              const target = targets.find((t) => t.key === v);
              if (target) edit((f) => chooseRefundTarget(f, target));
            }}
          >
            <SelectTrigger id={`${id}-target`} className="w-full" autoFocus data-finance-focus>
              <SelectValue placeholder="Choose an invoice or a credit note" />
            </SelectTrigger>
            <SelectContent>
              {offered.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {refundTargetLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {chosen
              ? `Up to ${money(chosen.refundable, chosen.currency)}: what the customer is in credit on ${chosen.invoice_no}, less refunds still to be paid${chosen.kind === 'credit_note' ? `, and no more than is left of ${chosen.number}` : ''}.`
              : 'An invoice whose customer is in credit, or one of its issued credit notes.'}
          </p>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-amount`}>{refundAmountLabel(form, targets)}</Label>
          <Input
            id={`${id}-amount`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            className="text-right tabular-nums"
            onWheel={(e) => e.currentTarget.blur()}
            // Enter in the amount box does not record the refund half typed.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            value={form.amount}
            onChange={(e) => edit((f) => ({ ...f, amount: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-reason`}>Reason</Label>
          <Select value={form.reason} onValueChange={(v) => edit((f) => ({ ...f, reason: v as RefundReason }))}>
            <SelectTrigger id={`${id}-reason`} className="w-full">
              <SelectValue placeholder="Choose a reason" />
            </SelectTrigger>
            <SelectContent>
              {REFUND_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {REFUND_REASON_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {foreign && asksRinggit ? (
          <div className="space-y-1.5 md:col-span-12">
            <Label htmlFor={`${id}-ringgit`}>Ringgit paid out</Label>
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
                // Enter in the box does not record the refund half typed.
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                value={form.ringgit}
                onChange={(e) => edit((f) => withRefundRinggit(f, e.target.value))}
              />
            </div>
            <p id={`${id}-ringgit-hint`} className="text-xs text-muted-foreground">
              What left the account, in RM. The amount above is in {foreign.currency}, the invoice’s currency.
            </p>
            {refundPreviewNotes(form, targets).map((note) => (
              <p key={note} className="text-sm text-muted-foreground" aria-live="polite">
                {note}
              </p>
            ))}
          </div>
        ) : null}

        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-account`}>Paid from</Label>
          <Select
            value={form.accountId}
            onValueChange={(v) => {
              const chosenAccount = accounts.find((a) => a.id === v);
              if (chosenAccount) edit((f) => chooseRefundAccount(f, chosenAccount, targets));
            }}
          >
            <SelectTrigger id={`${id}-account`} className="w-full">
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {refundAccounts(form, targets, accounts).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {accountLabel(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>{form.scheduled ? 'Planned date' : 'Date paid out'}</Label>
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
            fxRate={fxRate}
            onAnswer={(key, answer) =>
              setForm((f) => withRefundFx(f, withRateAnswer(f.fx ?? ringgitFields(), f.date, key, answer, true)))
            }
            onTyped={(text) => edit((f) => withRefundFx(f, withRateTyped(f.fx ?? ringgitFields(), text)))}
            notes={refundPreviewNotes(form, targets)}
          />
        ) : null}
        <div className="space-y-1.5 md:col-span-7">
          <Label htmlFor={`${id}-notes`}>Notes</Label>
          <Input
            id={`${id}-notes`}
            value={form.notes}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>
        <fieldset className="space-y-1.5 md:col-span-5">
          <legend className="text-sm font-medium leading-none">When</legend>
          <div className="flex h-8 flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-when`}
                className="size-4 accent-primary"
                checked={!form.scheduled}
                onChange={() => edit((f) => ({ ...f, scheduled: false }))}
              />
              Pay out now
            </label>
            {/* A refund on an invoice in another currency, or from an account in one, is paid out now: its exchange
                difference is decided then. */}
            {foreign || onAccount ? null : (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-when`}
                  className="size-4 accent-primary"
                  checked={form.scheduled}
                  onChange={() => edit((f) => ({ ...f, scheduled: true }))}
                />
                Pay later
              </label>
            )}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : form.scheduled ? 'Save to pay later' : 'Record refund'}
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
