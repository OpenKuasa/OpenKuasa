'use client';

import { type FormEvent, useId, useState } from 'react';
import { ArrowLeftRight, Pencil } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  CONTRA_FORM_MESSAGES,
  type ContraDocument,
  type ContraForm,
  type ContraParty,
  type ContraSide,
  type WrittenContra,
  amountFromSides,
  chooseContraContact,
  contraFormFromRow,
  contraFormSides,
  contraOwedLine,
  contraPartyLabel,
  contraSidesLine,
  droppedLinesNote,
  newContraForm,
  submitContra,
  toggleContraDocument,
  typedContraAmount,
} from '@/lib/finance/contra-form';
import type { ContraRow, SaveAndPostContraResult } from '@/lib/finance/contras';
import { typedNumber } from '@/lib/finance/format';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

export type ContraFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  saveAndPost: (input: unknown) => Promise<SaveAndPostContraResult>;
};

/**
 * A new contra entry, or a saved draft being changed (`editing`): one contact who is both a customer and a supplier,
 * a date, an amount, a reference and a note, and the contact's invoices and bills ticked with what each sets off.
 * The two sides are shown against the amount as they are typed; "Save and post" is refused while either differs.
 * The rules are in src/lib/finance/contra-form.ts.
 */
export function ContraFormCard({
  editing,
  parties,
  today,
  actions,
  onClose,
}: {
  editing?: ContraRow;
  /** The contacts the form offers, each with their invoices and bills that can be set off (`contraParties`). */
  parties: ContraParty[];
  /** The default date, YYYY-MM-DD. */
  today: string;
  actions: ContraFormActions;
  /** `written` is the contra entry just saved or posted; absent when the form was cancelled. */
  onClose: (written?: WrittenContra) => void;
}) {
  const id = useId();
  const [start] = useState(() => (editing ? contraFormFromRow(editing, parties) : { form: newContraForm(today, parties), dropped: [] }));
  const [form, setForm] = useState<ContraForm>(start.form);
  const [posting, setPosting] = useState(false);
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit = (next: (f: ContraForm) => ContraForm) => {
    save.clear();
    setForm(next);
  };

  const party = parties.find((p) => p.id === form.contactId);
  const sides = contraFormSides(form);
  const dropped = droppedLinesNote(start.dropped);
  const contactName = party?.name ?? editing?.contact_name ?? '';
  const written = (status: WrittenContra['status'], contraId: string): WrittenContra => ({
    id: contraId,
    status,
    contact: contactName,
    amount: typedNumber(form.amount) ?? 0,
  });

  const send = (post: boolean) => {
    const outcome = submitContra(form, parties, post);
    if ('error' in outcome) {
      save.fail(outcome.error);
      return;
    }
    setPosting(post);
    if (!post) {
      save.run(() => actions.save(outcome.payload), (data) => onClose(written('draft', data.id)));
      return;
    }
    save.run(async () => {
      const result = await actions.saveAndPost(outcome.payload);
      // Saved but not posted: go on editing that draft, so a second try does not save a second contra entry.
      if (!result.ok && result.draftId) {
        const draftId = result.draftId;
        setForm((f) => ({ ...f, id: draftId }));
        return { ...result, error: `Saved as a draft, but not posted. ${result.error}` };
      }
      return result;
    }, (data) => onClose(written('posted', data.id)));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    send(false);
  };

  const title = form.id ? 'Edit contra entry' : 'New contra entry';
  const subtitle = form.id
    ? 'A draft: nothing is set off until it is posted'
    : 'Set what a contact owes you against what you owe them';

  if (parties.length === 0) {
    return (
      <BentoCard title={title} subtitle={subtitle} icon={ArrowLeftRight} className="col-span-2 md:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">{CONTRA_FORM_MESSAGES.nobody}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => onClose()} autoFocus data-finance-focus>
            Close
          </Button>
        </div>
      </BentoCard>
    );
  }

  const documents = (side: ContraSide, offered: ContraDocument[], noun: 'invoice' | 'bill') => (
    <fieldset className="space-y-1.5 md:col-span-6">
      <legend className="text-sm font-medium leading-none">{noun === 'invoice' ? 'Invoices they owe you' : 'Bills you owe them'}</legend>
      {offered.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
          {party ? `${party.name} has no posted ${noun} that can be set off.` : `Choose a contact to see their ${noun}s.`}
        </p>
      ) : (
        // Many open documents scroll inside the card rather than pushing the buttons off the page.
        <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
          {offered.map((d) => {
            const ticked = d.id in form[side];
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
                <label className="flex min-w-0 flex-1 basis-48 items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                    checked={ticked}
                    onChange={(e) => edit((f) => toggleContraDocument(f, side, d, e.target.checked))}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{d.number}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums [overflow-wrap:anywhere]">{contraOwedLine(d, side)}</span>
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
                      aria-label={`Amount set off on ${d.number}`}
                      className="w-32 text-right tabular-nums"
                      onWheel={(e) => e.currentTarget.blur()}
                      // Enter in an amount box does not save the contra entry half typed.
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.preventDefault();
                      }}
                      value={form[side][d.id]}
                      onChange={(e) => edit((f) => typedContraAmount(f, side, d.id, e.target.value))}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );

  return (
    <BentoCard title={title} subtitle={subtitle} icon={form.id ? Pencil : ArrowLeftRight} className="col-span-2 md:col-span-12">
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        {dropped ? (
          <p role="status" className="text-sm text-amber-700 md:col-span-12 dark:text-amber-400">
            {dropped}
          </p>
        ) : null}
        <div className="space-y-1.5 md:col-span-5">
          <Label htmlFor={`${id}-contact`}>Contact</Label>
          <Select value={form.contactId} onValueChange={(v) => edit((f) => chooseContraContact(f, v))}>
            <SelectTrigger id={`${id}-contact`} className="w-full" autoFocus data-finance-focus>
              <SelectValue placeholder="Choose a contact" />
            </SelectTrigger>
            <SelectContent>
              {parties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {contraPartyLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>Date</Label>
          <Input id={`${id}-date`} type="date" value={form.date} required onChange={(e) => edit((f) => ({ ...f, date: e.target.value }))} />
        </div>
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-amount`}>Amount set off (RM)</Label>
          <Input
            id={`${id}-amount`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            placeholder="0.00"
            className="tabular-nums"
            onWheel={(e) => e.currentTarget.blur()}
            value={form.amount}
            onChange={(e) => edit((f) => ({ ...f, amount: e.target.value }))}
          />
        </div>

        {documents('invoices', party?.invoices ?? [], 'invoice')}
        {documents('bills', party?.bills ?? [], 'bill')}

        <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-12">
          <p className={cn('text-sm tabular-nums', !sides.ready && 'text-muted-foreground')} aria-live="polite">
            {contraSidesLine(form)}
          </p>
          {!form.amount.trim() && sides.invoiceSide > 0 && sides.billSide > 0 ? (
            <Button type="button" variant="ghost" size="xs" onClick={() => edit(amountFromSides)}>
              Use the smaller side as the amount
            </Button>
          ) : null}
        </div>

        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-reference`}>Reference</Label>
          <Input
            id={`${id}-reference`}
            value={form.reference}
            maxLength={100}
            placeholder="Their agreement or letter no."
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, reference: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-8">
          <Label htmlFor={`${id}-notes`}>Note</Label>
          <Input
            id={`${id}-notes`}
            value={form.notes}
            maxLength={1000}
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" variant="outline" disabled={save.pending}>
            {save.pending && !posting ? 'Saving…' : 'Save draft'}
          </Button>
          <Button type="button" size="sm" disabled={save.pending} onClick={() => send(true)}>
            {save.pending && posting ? 'Posting…' : 'Save and post'}
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
