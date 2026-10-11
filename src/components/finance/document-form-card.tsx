'use client';

import { type FormEvent, useId, useState } from 'react';
import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { LineItemsEditor } from '@/components/finance/line-items-editor';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type DocumentFormKind, type DocumentFormState, type DocumentParty, documentFormWords } from '@/lib/finance/document-form';
import type { FinanceProduct } from '@/lib/finance/products';
import type { FinResult } from '@/lib/finance/result';

export type DocumentFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** When the draft was saved but posting it was refused, the answer carries the draft's id. */
  saveAndPost: (input: unknown) => Promise<FinResult<unknown> & { draftId?: string }>;
};

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A new bill, invoice or quotation, or a draft being changed. Saved as a
 * draft, or saved and posted (a quotation: marked as sent) in one go. `kind`
 * says which document it is and carries its words and its rules, which are in
 * src/lib/finance/bill-form.ts, invoice-form.ts and quotation-form.ts.
 */
export function DocumentFormCard<F extends DocumentFormState>({
  kind,
  initial,
  parties,
  products,
  actions,
  onClose,
}: {
  kind: DocumentFormKind<F>;
  /** What the form holds when it opens: a new document, or the draft being changed. */
  initial: () => F;
  /** The suppliers or customers to choose from, by name. */
  parties: DocumentParty[];
  /** Active products and services. */
  products: FinanceProduct[];
  actions: DocumentFormActions;
  onClose: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState(initial);
  const [posting, setPosting] = useState(false);
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  const { noun, party, reference, secondDate } = kind;
  const words = documentFormWords(kind);
  const terms = parties.find((p) => p.id === kind.partyId(form))?.payment_terms_days;

  const send = (post: boolean) => {
    const problem = kind.error(form, post);
    if (problem) {
      save.fail(problem);
      return;
    }
    const payload = kind.payload(form);
    setPosting(post);
    if (!post) {
      save.run(() => actions.save(payload), onClose);
      return;
    }
    save.run(async () => {
      const result = await actions.saveAndPost(payload);
      // Saved but not posted: go on editing that draft, so a second try does not save a second document.
      if (!result.ok && result.draftId) {
        const draftId = result.draftId;
        setForm((f) => ({ ...f, id: draftId }));
        return { ...result, error: kind.savedNotPosted(result.error) };
      }
      return result;
    }, onClose);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    send(false);
  };

  const title = form.id ? `Edit ${noun}` : `New ${noun}`;
  const subtitle = form.id ? words.draftSubtitle : words.newSubtitle;

  if (parties.length === 0) {
    return (
      <BentoCard title={title} subtitle={subtitle} icon={Plus} className="col-span-2 md:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            Add a {party} under{' '}
            <Link href="/finance/customers-suppliers" className="font-medium text-primary underline-offset-4 hover:underline">
              Customers &amp; Suppliers
            </Link>{' '}
            first.
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
        <div className={reference ? 'space-y-1.5 md:col-span-4' : 'space-y-1.5 md:col-span-6'}>
          <Label htmlFor={`${id}-party`}>{capital(party)}</Label>
          <Select
            value={kind.partyId(form)}
            onValueChange={(v) => {
              const chosen = parties.find((p) => p.id === v);
              if (chosen) edit((f) => kind.withParty(f, chosen));
            }}
          >
            <SelectTrigger id={`${id}-party`} className="w-full" autoFocus data-finance-focus>
              <SelectValue placeholder={`Choose a ${party}`} />
            </SelectTrigger>
            <SelectContent>
              {parties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {reference ? (
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor={`${id}-ref`}>{reference.label}</Label>
            <Input
              id={`${id}-ref`}
              value={reference.get(form)}
              maxLength={200}
              placeholder={reference.placeholder}
              autoComplete="off"
              onChange={(e) => edit((f) => reference.set(f, e.target.value))}
            />
          </div>
        ) : null}
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>{kind.dateLabel}</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={kind.date(form)}
            required
            onChange={(e) => edit((f) => kind.withDate(f, e.target.value, terms))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-due`}>{secondDate.label}</Label>
          <Input
            id={`${id}-due`}
            type="date"
            value={secondDate.get(form)}
            min={kind.date(form) || undefined}
            required
            onChange={(e) => edit((f) => secondDate.set(f, e.target.value))}
          />
        </div>

        <fieldset
          className="space-y-2 md:col-span-12"
          // Enter in a line's box moves on like any other key; it does not save the document half typed.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
          }}
        >
          <legend className="text-sm font-medium leading-none">Lines</legend>
          <LineItemsEditor
            lines={form.lines}
            products={products}
            withProduct={kind.withProduct}
            onChange={(lines) => edit((f) => ({ ...f, lines }))}
          />
        </fieldset>

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

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" variant="outline" disabled={save.pending}>
            {save.pending && !posting ? 'Saving…' : 'Save draft'}
          </Button>
          <Button type="button" size="sm" disabled={save.pending} onClick={() => send(true)}>
            {save.pending && posting ? words.posting : words.post}
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
