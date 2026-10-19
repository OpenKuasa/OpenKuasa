'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BASE_CURRENCY, currencyOptions } from '@/lib/finance/currencies';
import { type CurrencyFields as Fields, type RateFigure, rateLabel, rateNotes, sourceError } from '@/lib/finance/document-currency';
import {
  PROVIDER_LABELS,
  PROVIDER_NEEDS_REFERENCE,
  RATE_PROVIDERS,
  RATE_REFERENCE_MAX,
  REFERENCE_LABELS,
  type RateProvider,
  isRateProvider,
} from '@/lib/finance/sst-rate';

const OPTIONS = currencyOptions();
/** Radix Select has no empty value, so "not chosen" is a word. */
const NO_PROVIDER = 'none';

/**
 * A document's currency, and for any currency but ringgit its exchange rate
 * with what the form knows about it. Drawn by the shared document form for a
 * kind that has `currency`. The rules are in src/lib/finance/document-currency.ts.
 * With `sources` (invoices), a rate typed by hand also says where it came
 * from, and for a bank, a central bank or a Customs approval, its name.
 */
export function CurrencyFields({
  id,
  fields,
  date,
  figure = 'middle',
  lockedNote = null,
  sources,
  onCurrency,
  onRate,
}: {
  id: string;
  fields: Fields;
  /** The date the rate is for, as typed. */
  date: string;
  /** Which of Bank Negara's rates the kind is offered. */
  figure?: RateFigure;
  /** Why the currency cannot be changed (a bill with a purchase order); null when it can. */
  lockedNote?: string | null;
  /** Present for a kind whose typed rate names its source. */
  sources?: { onProvider: (provider: RateProvider | null) => void; onReference: (text: string) => void };
  onCurrency: (code: string) => void;
  onRate: (text: string) => void;
}) {
  const foreign = fields.currency !== BASE_CURRENCY;
  const notes = rateNotes(fields, date, figure);
  const typed = foreign && fields.rateSource === 'manual' && fields.rate.trim() !== '';
  const needsReference = fields.provider !== null && PROVIDER_NEEDS_REFERENCE.has(fields.provider);
  const missingSource = sources && typed ? sourceError(fields) : null;
  return (
    <>
      <div className="space-y-1.5 md:col-span-3">
        <Label htmlFor={`${id}-currency`}>Currency</Label>
        <Select value={fields.currency} onValueChange={onCurrency} disabled={lockedNote !== null}>
          <SelectTrigger
            id={`${id}-currency`}
            className="w-full min-w-28"
            aria-describedby={lockedNote !== null ? `${id}-currency-locked` : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPTIONS.map((code) => (
              <SelectItem key={code} value={code}>
                {code === BASE_CURRENCY ? 'MYR (ringgit)' : code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {lockedNote !== null ? (
          <p id={`${id}-currency-locked`} className="text-xs text-muted-foreground">
            {lockedNote}
          </p>
        ) : null}
      </div>
      {foreign ? (
        <div className="space-y-1.5 md:col-span-9">
          <Label htmlFor={`${id}-rate`}>{rateLabel(fields.currency)}</Label>
          <Input
            id={`${id}-rate`}
            className="md:w-48"
            value={fields.rate}
            inputMode="decimal"
            autoComplete="off"
            maxLength={20}
            aria-describedby={`${id}-rate-notes`}
            onChange={(e) => onRate(e.target.value)}
          />
          {/* One container that is always there, so a reader announces a note when it appears. */}
          <div id={`${id}-rate-notes`} role="status" className="space-y-1">
            {notes.map((note) => (
              <p key={note} className="text-xs text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {sources && typed ? (
        <>
          <div className="space-y-1.5 md:col-span-6">
            <Label htmlFor={`${id}-rate-source`}>Where this rate comes from</Label>
            <Select
              value={fields.provider ?? NO_PROVIDER}
              onValueChange={(v) => sources.onProvider(isRateProvider(v) ? v : null)}
            >
              <SelectTrigger id={`${id}-rate-source`} className="w-full" aria-describedby={`${id}-rate-source-note`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROVIDER}>Choose a source</SelectItem>
                {RATE_PROVIDERS.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {PROVIDER_LABELS[provider]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {needsReference && fields.provider ? (
            <div className="space-y-1.5 md:col-span-6">
              <Label htmlFor={`${id}-rate-reference`}>{REFERENCE_LABELS[fields.provider]}</Label>
              <Input
                id={`${id}-rate-reference`}
                value={fields.reference}
                maxLength={RATE_REFERENCE_MAX}
                autoComplete="off"
                aria-describedby={`${id}-rate-source-note`}
                onChange={(e) => sources.onReference(e.target.value)}
              />
            </div>
          ) : null}
          <div id={`${id}-rate-source-note`} role="status" className="md:col-span-12">
            {missingSource ? <p className="text-xs text-amber-600">{missingSource}</p> : null}
          </div>
        </>
      ) : null}
    </>
  );
}
