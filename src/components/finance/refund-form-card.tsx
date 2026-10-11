'use client';

import { type FormEvent, useId, useState } from 'react';
import { Banknote } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { rm } from '@/lib/finance/format';
import { type FinanceAccount, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/lib/finance/money';
import {
  type RefundSaved,
  type RefundTarget,
  chooseRefundTarget,
  keepRefundTarget,
  newRefundForm,
  refundFormError,
  refundPayload,
  refundSaved,
  refundTargetLabel,
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
 * document with a reason, so it has its own card. The rules are in
 * src/lib/finance/refund-form.ts.
 */
export function RefundFormCard({
  targets,
  accounts,
  today,
  preselect,
  record,
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
              {targets.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {refundTargetLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {chosen
              ? `Up to ${rm(chosen.refundable)}: what the customer is in credit on ${chosen.invoice_no}, less refunds that are pending${chosen.kind === 'credit_note' ? `, and no more than is left of ${chosen.number}` : ''}.`
              : 'An invoice whose customer is in credit, or one of its issued credit notes.'}
          </p>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-amount`}>Amount (RM)</Label>
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

        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-account`}>Paid from</Label>
          <Select value={form.accountId} onValueChange={(v) => edit((f) => ({ ...f, accountId: v }))}>
            <SelectTrigger id={`${id}-account`} className="w-full">
              <SelectValue placeholder="Choose an account" />
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
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-when`}
                className="size-4 accent-primary"
                checked={form.scheduled}
                onChange={() => edit((f) => ({ ...f, scheduled: true }))}
              />
              Leave pending
            </label>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : form.scheduled ? 'Save as pending' : 'Record refund'}
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
