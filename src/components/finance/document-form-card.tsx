'use client';

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { CurrencyFields } from '@/components/finance/currency-fields';
import { LineItemsEditor } from '@/components/finance/line-items-editor';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BASE_CURRENCY } from '@/lib/finance/currencies';
import {
  farRateQuestion,
  rateKey,
  ringgitTotalNote,
  withCurrency,
  withRateAnswer,
  withRateConfirmed,
  withRateProvider,
  withRateReference,
  withRateTyped,
} from '@/lib/finance/document-currency';
import { type DocumentFormKind, type DocumentFormState, type DocumentParty, documentFormWords } from '@/lib/finance/document-form';
import type { FxDefault } from '@/lib/finance/fx-rates';
import type { FinanceProduct } from '@/lib/finance/products';
import type { FinResult } from '@/lib/finance/result';

export type DocumentFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** When the draft was saved but posting it was refused, the answer carries the draft's id. */
  saveAndPost: (input: unknown) => Promise<FinResult<unknown> & { draftId?: string }>;
  /** Bank Negara's rate for `{ currency, date }`, for a kind that has `currency`; null when it has none. */
  fxRate?: (input: unknown) => Promise<FinResult<FxDefault | null>>;
};

/**
 * A choice tied to the chosen party, drawn after the dates: the bill form's purchase order. Held by the form
 * (`get`/`set`), offered by the caller (`options`), advised on by `notes` (sentences shown as a status, never
 * a refusal). Absent for every other form.
 */
export type PartyChoice<F> = {
  label: string;
  noneLabel: string;
  options: (form: F) => { id: string; label: string }[];
  get: (form: F) => string;
  set: (form: F, id: string) => F;
  notes: (form: F) => string[];
};

/** Radix Select has no empty value, so "none" is a word, as on a line's product. */
const NO_CHOICE = 'none';

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A new bill, invoice, quotation or RFQ, or a draft being changed. Saved as a
 * draft, or saved and posted (a quotation or RFQ: marked as sent) in one go. `kind`
 * says which document it is and carries its words and its rules, which are in
 * src/lib/finance/bill-form.ts, invoice-form.ts, quotation-form.ts and rfq-form.ts.
 */
export function DocumentFormCard<F extends DocumentFormState>({
  kind,
  initial,
  parties,
  products,
  partyChoice,
  extraChoices,
  draftOnly = false,
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
  partyChoice?: PartyChoice<F>;
  /** More choices drawn beside the first: the bill form's category. Absent for every other form. */
  extraChoices?: PartyChoice<F>[];
  /**
   * True for a form that only ever saves a draft: the second button (the kind's own word for posting or
   * sending) is not drawn and `actions.saveAndPost` is never called. The bill form opened from a receipt:
   * nothing made from a receipt leaves draft here.
   */
  draftOnly?: boolean;
  actions: DocumentFormActions;
  onClose: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState(initial);
  const [posting, setPosting] = useState(false);
  const save = useFinanceAction();
  const fx = kind.currency;
  /** The date the rate is for: the document's date, or (an invoice) its date of supply. */
  const rateDateOf = (f: F) => (kind.rateDate ? kind.rateDate(f) : kind.date(f));
  /** The currency and date Bank Negara's rate was last asked for: an answer for any other is dropped. */
  const asked = useRef<string | null>(null);

  /**
   * Asks for Bank Negara's rate when the currency or the date of `next` is not the one last asked about. With
   * `offer`, a rate box that still holds BNM's rate (or nothing) takes the answer; a typed rate is kept.
   */
  const askRate = (next: F, offer: boolean) => {
    const fetchRate = actions.fxRate;
    if (!fx || !fetchRate) return;
    const key = rateKey(fx.get(next), rateDateOf(next));
    if (key === null || key === asked.current) return;
    asked.current = key;
    const [currency, date] = key.split('|');
    const answered = (answer: { ok: true; rate: FxDefault | null } | { ok: false }) =>
      setForm((f) => fx.set(f, withRateAnswer(fx.get(f), rateDateOf(f), key, answer, offer)));
    fetchRate({ currency, date }).then(
      (result) => answered(result.ok ? { ok: true, rate: result.data } : { ok: false }),
      () => answered({ ok: false }),
    );
  };

  // A saved draft in another currency: note BNM's rate beside the one saved, without changing it.
  useEffect(() => {
    askRate(form, false);
    // Once, for the draft the form opened with; every later change asks from `edit`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A change by the person answers the last refusal, so its sentence goes. A new currency or date asks BNM.
  const edit = (change: (f: F) => F) => {
    save.clear();
    const next = change(form);
    setForm(next);
    askRate(next, true);
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
    // A rate far from Bank Negara's is asked about once; pressing the button again keeps it.
    const question = fx ? farRateQuestion(fx.get(form)) : null;
    if (fx && question) {
      setForm((f) => fx.set(f, withRateConfirmed(fx.get(f))));
      save.fail(question);
      return;
    }
    const payload = kind.payload(form);
    // A refusal may change what the form holds, so that the next try is not refused the same way.
    const refused = (error: string) => {
      const { afterRefusal } = kind;
      if (afterRefusal) setForm((f) => afterRefusal(f, error));
    };
    setPosting(post);
    if (!post) {
      save.run(async () => {
        const result = await actions.save(payload);
        if (!result.ok) refused(result.error);
        return result;
      }, onClose);
      return;
    }
    save.run(async () => {
      const result = await actions.saveAndPost(payload);
      if (!result.ok) refused(result.error);
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
            required={!secondDate.optional}
            onChange={(e) => edit((f) => secondDate.set(f, e.target.value))}
          />
        </div>
        {fx && kind.supplyDate && fx.get(form).currency !== BASE_CURRENCY ? (
          <div className="space-y-1.5 md:col-span-6">
            <Label htmlFor={`${id}-supply`}>{kind.supplyDate.label}</Label>
            <Input
              id={`${id}-supply`}
              type="date"
              value={kind.supplyDate.get(form)}
              aria-describedby={`${id}-supply-hint`}
              onChange={(e) => {
                const supply = kind.supplyDate;
                if (supply) edit((f) => supply.set(f, e.target.value));
              }}
            />
            <p id={`${id}-supply-hint`} className="text-xs text-muted-foreground">
              {kind.supplyDate.hint}
            </p>
          </div>
        ) : null}
        {fx ? (
          <CurrencyFields
            id={id}
            fields={fx.get(form)}
            date={rateDateOf(form)}
            figure={fx.figure}
            lockedNote={fx.locked ? fx.locked(form) : null}
            sources={
              fx.sources
                ? {
                    onProvider: (provider) => edit((f) => fx.set(f, withRateProvider(fx.get(f), provider))),
                    onReference: (text) => edit((f) => fx.set(f, withRateReference(fx.get(f), text))),
                  }
                : undefined
            }
            onCurrency={(code) => edit((f) => fx.set(f, withCurrency(fx.get(f), code, true)))}
            onRate={(text) => edit((f) => fx.set(f, withRateTyped(fx.get(f), text)))}
          />
        ) : null}
        {[...(partyChoice ? [partyChoice] : []), ...(extraChoices ?? [])].map((choice, index, all) => {
          // Alone, a choice takes the row at half width; beside another, each takes half the row.
          const beside = all.length > 1;
          const choiceId = (n: number) => (n === 0 ? `${id}-choice` : `${id}-choice-${n}`);
          return (
            <div key={choice.label} className={beside ? 'space-y-1.5 md:col-span-6' : 'space-y-1.5 md:col-span-12'}>
              <Label htmlFor={choiceId(index)}>{choice.label}</Label>
              <Select
                value={choice.get(form) || NO_CHOICE}
                onValueChange={(v) => edit((f) => choice.set(f, v === NO_CHOICE ? '' : v))}
              >
                <SelectTrigger id={choiceId(index)} className={beside ? 'w-full' : 'w-full md:w-1/2'}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CHOICE}>{choice.noneLabel}</SelectItem>
                  {choice.options(form).map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* One container that is always there, so a reader announces a note when it appears. */}
              <div role="status" className="space-y-1">
                {choice.notes(form).map((note) => (
                  <p key={note} className="text-xs text-amber-600">
                    {note}
                  </p>
                ))}
              </div>
            </div>
          );
        })}
        {kind.extras?.map((extra, index) => (
          <div key={extra.label} className={extra.inputMode === 'numeric' ? 'space-y-1.5 md:col-span-4' : 'space-y-1.5 md:col-span-8'}>
            <Label htmlFor={`${id}-extra-${index}`}>{extra.label}</Label>
            <Input
              id={`${id}-extra-${index}`}
              value={extra.get(form)}
              inputMode={extra.inputMode}
              maxLength={extra.inputMode === 'numeric' ? 3 : 500}
              placeholder={extra.placeholder}
              autoComplete="off"
              aria-describedby={extra.hint ? `${id}-extra-${index}-hint` : undefined}
              onChange={(e) => edit((f) => extra.set(f, e.target.value))}
            />
            {extra.hint ? (
              <p id={`${id}-extra-${index}-hint`} className="text-xs text-muted-foreground">
                {extra.hint}
              </p>
            ) : null}
          </div>
        ))}

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
            pricePlaceholder={kind.pricePlaceholder}
            discount={kind.discount}
            currency={fx ? fx.get(form).currency : undefined}
            onChange={(lines) => edit((f) => ({ ...f, lines }))}
          />
          {fx ? (
            <p className="text-right text-xs text-muted-foreground" aria-live="polite">
              {ringgitTotalNote(fx.get(form), form.lines)}
            </p>
          ) : null}
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
          <Button type="submit" size="sm" variant={draftOnly ? 'default' : 'outline'} disabled={save.pending}>
            {save.pending && !posting ? 'Saving…' : 'Save draft'}
          </Button>
          {draftOnly ? null : (
            <Button type="button" size="sm" disabled={save.pending} onClick={() => send(true)}>
              {save.pending && posting ? words.posting : words.post}
            </Button>
          )}
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
