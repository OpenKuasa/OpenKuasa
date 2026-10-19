'use client';

import { type FormEvent, useId, useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  type CreditNoteSaved,
  creditNoteAmountLabel,
  creditNoteFormError,
  creditNoteFormFromRow,
  creditNotePayload,
  creditNoteRinggitNote,
  creditNoteSaved,
  creditNoteSavedNotIssued,
  creditableInvoices,
  creditableLabel,
  newCreditNoteForm,
} from '@/lib/finance/credit-note-form';
import {
  CREDIT_NOTE_REASONS,
  CREDIT_NOTE_REASON_LABELS,
  type CreditNoteReason,
  type CreditNoteRow,
  type SaveAndIssueCreditNoteResult,
} from '@/lib/finance/credit-notes';
import { money } from '@/lib/finance/format';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { FinResult } from '@/lib/finance/result';

export type CreditNoteFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Saves the draft, then issues it. When only the issue was refused, the answer carries the draft's id. */
  saveAndIssue: (input: unknown) => Promise<SaveAndIssueCreditNoteResult>;
};

/**
 * A new credit note against one posted invoice, or a draft being changed
 * (`editing`). Saved as a draft, or saved and issued in one go. Used on
 * Credit Notes, and on Invoices from an invoice's Credit note choice
 * (`invoiceId`). A credit note is one amount with a reason: it has no lines
 * and moves no money, so it has its own card. The rules are in
 * src/lib/finance/credit-note-form.ts.
 */
export function CreditNoteFormCard({
  editing,
  invoices,
  today,
  invoiceId,
  actions,
  onClose,
  onSaved,
}: {
  /** The draft being changed; absent for a new credit note. */
  editing?: CreditNoteRow;
  /** Every invoice of the workspace; the card offers the ones that can still take a credit note. */
  invoices: InvoiceListRow[];
  /** The default credit note date, YYYY-MM-DD. */
  today: string;
  /** Opened from an invoice's row: that invoice chosen. */
  invoiceId?: string;
  actions: CreditNoteFormActions;
  onClose: () => void;
  /**
   * Called instead of `onClose` once the credit note is saved, where the page has something to say about it.
   * It is handed what was saved: the picker is open, so that need not be the invoice the card was opened from.
   */
  onSaved?: (saved: CreditNoteSaved) => void;
}) {
  const id = useId();
  const [form, setForm] = useState(() =>
    editing ? creditNoteFormFromRow(editing) : newCreditNoteForm(creditableInvoices(invoices), today, invoiceId),
  );
  const [issuing, setIssuing] = useState(false);
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  // The form's own invoice stays offered with nothing left, so the form can say that is why.
  const offered = creditableInvoices(invoices, form.invoiceId);
  const chosen = offered.find((i) => i.id === form.invoiceId);
  // An invoice in another currency: the amount is in its currency, and the form says about what it takes in ringgit.
  const ringgitNote = creditNoteRinggitNote(form, offered);

  const send = (issue: boolean) => {
    const problem = creditNoteFormError(form, offered);
    if (problem) {
      save.fail(problem);
      return;
    }
    const payload = creditNotePayload(form);
    // Taken now, from the form that is sent: after the refresh this invoice may no longer be offered.
    const what = creditNoteSaved(form, offered, issue);
    const saved = () => (onSaved && what ? onSaved(what) : onClose());
    setIssuing(issue);
    if (!issue) {
      save.run(() => actions.save(payload), saved);
      return;
    }
    save.run(async () => {
      const result = await actions.saveAndIssue(payload);
      // Saved but not issued: go on editing that draft, so a second try does not save a second credit note.
      if (!result.ok && result.draftId) {
        const draftId = result.draftId;
        setForm((f) => ({ ...f, id: draftId }));
        return { ...result, error: creditNoteSavedNotIssued(result.error) };
      }
      return result;
    }, saved);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    send(false);
  };

  const title = form.id ? 'Edit credit note' : 'New credit note';
  const subtitle = form.id ? 'A draft: it gets its number when it is issued' : 'Saved as a draft until it is issued';

  if (offered.length === 0) {
    return (
      <BentoCard title={title} subtitle={subtitle} icon={Plus} className="col-span-2 md:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            There is no invoice to credit. A credit note goes against a posted invoice, for no more than its total less
            what has already been credited.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onClose} autoFocus data-finance-focus>
            Close
          </Button>
        </div>
      </BentoCard>
    );
  }

  return (
    <BentoCard title={title} subtitle={subtitle} icon={form.id ? FileText : Plus} className="col-span-2 md:col-span-12">
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-6">
          <Label htmlFor={`${id}-invoice`}>Against invoice</Label>
          {/* A draft whose invoice is no longer posted is not in the list: the box shows its placeholder, not a blank. */}
          <Select value={chosen ? form.invoiceId : ''} onValueChange={(v) => edit((f) => ({ ...f, invoiceId: v }))}>
            <SelectTrigger id={`${id}-invoice`} className="w-full" autoFocus data-finance-focus>
              <SelectValue placeholder="Choose an invoice" />
            </SelectTrigger>
            <SelectContent>
              {offered.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {creditableLabel(i)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {chosen
              ? `Total ${money(chosen.total, chosen.currency)} · ${money(chosen.credited, chosen.currency)} already credited · ${money(chosen.creditable, chosen.currency)} left to credit`
              : 'A posted invoice. What has been paid on it does not limit a credit note.'}
          </p>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>Credit note date</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={form.date}
            required
            onChange={(e) => edit((f) => ({ ...f, date: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-amount`}>{creditNoteAmountLabel(form, offered)}</Label>
          <Input
            id={`${id}-amount`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            className="text-right tabular-nums"
            onWheel={(e) => e.currentTarget.blur()}
            // Enter in the amount box does not save the credit note half typed.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            value={form.amount}
            aria-describedby={ringgitNote ? `${id}-amount-ringgit` : undefined}
            onChange={(e) => edit((f) => ({ ...f, amount: e.target.value }))}
          />
          {ringgitNote ? (
            <p id={`${id}-amount-ringgit`} className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {ringgitNote}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-reason`}>Reason</Label>
          <Select value={form.reason} onValueChange={(v) => edit((f) => ({ ...f, reason: v as CreditNoteReason }))}>
            <SelectTrigger id={`${id}-reason`} className="w-full">
              <SelectValue placeholder="Choose a reason" />
            </SelectTrigger>
            <SelectContent>
              {CREDIT_NOTE_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {CREDIT_NOTE_REASON_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-8">
          <Label htmlFor={`${id}-notes`}>Notes</Label>
          <Input
            id={`${id}-notes`}
            value={form.notes}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" variant="outline" disabled={save.pending}>
            {save.pending && !issuing ? 'Saving…' : 'Save draft'}
          </Button>
          <Button type="button" size="sm" disabled={save.pending} onClick={() => send(true)}>
            {save.pending && issuing ? 'Issuing…' : 'Save and issue'}
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
