'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BASE_CURRENCY, currencyOptions } from '@/lib/finance/currencies';
import { type CurrencyFields as Fields, rateLabel, rateNotes } from '@/lib/finance/document-currency';

const OPTIONS = currencyOptions();

/**
 * A document's currency, and for any currency but ringgit its exchange rate
 * with what the form knows about it. Drawn by the shared document form for a
 * kind that has `currency`. The rules are in src/lib/finance/document-currency.ts.
 */
export function CurrencyFields({
  id,
  fields,
  date,
  onCurrency,
  onRate,
}: {
  id: string;
  fields: Fields;
  /** The document's date as typed, which the rate is for. */
  date: string;
  onCurrency: (code: string) => void;
  onRate: (text: string) => void;
}) {
  const foreign = fields.currency !== BASE_CURRENCY;
  const notes = rateNotes(fields, date);
  return (
    <>
      <div className="space-y-1.5 md:col-span-3">
        <Label htmlFor={`${id}-currency`}>Currency</Label>
        <Select value={fields.currency} onValueChange={onCurrency}>
          <SelectTrigger id={`${id}-currency`} className="w-full min-w-28">
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
    </>
  );
}
