'use client';

import { useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type CurrencyFields, rateKey, rateLabel, rateNotes } from '@/lib/finance/document-currency';
import type { FxDefault } from '@/lib/finance/fx-rates';
import type { FinResult } from '@/lib/finance/result';

/** Bank Negara's 5 pm selling rate for `{ currency, date }` (the one rule); null when it has none. */
export type FxRateLookup = (input: unknown) => Promise<FinResult<FxDefault | null>>;
export type RateAnswer = { ok: true; rate: FxDefault | null } | { ok: false };

/**
 * The rate of a movement on an account in another currency (stage 5b): the box, in ringgit per the unit BNM quotes,
 * filled with BNM's selling rate for the movement's date and kept as typed once the person types another, and what
 * the form says under it. BNM is asked once per currency and date; `onAnswer` applies the answer to the form as it
 * then stands (`withRateAnswer` drops one for a date that is no longer the form's).
 */
export function MovementRateFields({
  id,
  fx,
  date,
  fxRate,
  onAnswer,
  onTyped,
  notes,
  className,
}: {
  id: string;
  fx: CurrencyFields;
  /** The movement's date, YYYY-MM-DD: what BNM's rate is asked for. */
  date: string;
  /** Absent: nothing is looked up, and the rate is typed. */
  fxRate?: FxRateLookup;
  onAnswer: (key: string, answer: RateAnswer) => void;
  onTyped: (text: string) => void;
  /** More sentences under the box: what the movement comes to in ringgit, as "about". */
  notes: string[];
  className?: string;
}) {
  const key = rateKey(fx, date);
  useEffect(() => {
    if (key === null || !fxRate || fx.answered === key) return;
    let live = true;
    const [currency, on] = key.split('|');
    fxRate({ currency, date: on }).then(
      (result) => {
        if (live) onAnswer(key, result.ok ? { ok: true, rate: result.data } : { ok: false });
      },
      () => {
        if (live) onAnswer(key, { ok: false });
      },
    );
    return () => {
      live = false;
    };
    // Asked once for each currency and date; the answer is applied to the form as it then stands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const lines = [...rateNotes(fx, date, 'selling'), ...notes];
  return (
    <div className={className ?? 'space-y-1.5'}>
      <Label htmlFor={`${id}-rate`}>{rateLabel(fx.currency)}</Label>
      <Input
        id={`${id}-rate`}
        inputMode="decimal"
        autoComplete="off"
        className="w-40 text-right tabular-nums"
        aria-describedby={`${id}-rate-notes`}
        // Enter in the box does not record the payment half typed.
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
        value={fx.rate}
        onChange={(e) => onTyped(e.target.value)}
      />
      <div id={`${id}-rate-notes`} role="status" className="space-y-1">
        {lines.map((line) => (
          <p key={line} className="text-xs text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

/** How an account picker names an account: its name, its bank, and its currency when it is not ringgit. */
export function accountLabel(account: { name: string; bank_name: string | null; currency: string }): string {
  return `${account.name}${account.bank_name ? ` · ${account.bank_name}` : ''}${account.currency === 'MYR' ? '' : ` · ${account.currency}`}`;
}
