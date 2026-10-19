/**
 * The currency keys a document that posts takes on its way to the database (an invoice from stage 3a, a supplier
 * bill from stage 4a), and the two rules asked of them together: whole amounts in a currency with no minor unit,
 * and a rate typed by hand that names where it came from. Each key is optional with no default: a caller that
 * sends no currency (the finance assistant, which writes ringgit, and the code deployed before the stage) leaves
 * a draft's currency and rate as they are, and a new document in ringgit. The database stores rate 1 for ringgit
 * whatever is sent. Each document words its own sentences.
 */
import { z } from 'zod';
import { BASE_CURRENCY, isDocumentCurrency } from './currencies';
import { wholeUnitsError } from './document-currency';
import { isoDate } from './document-lines';
import { EINVOICE_RATE_MAX, calculationRateText } from './einvoice-fields';
import { PROVIDER_NEEDS_REFERENCE, RATE_PROVIDERS, RATE_REFERENCE_MAX } from './sst-rate';

export type CurrencyInputMessages = {
  currency: string;
  rate: string;
  rateTooLong: string;
  rateSource: string;
  referenceTooLong: string;
};

/** The six keys, worded with `M`. */
export function currencyInputKeys(M: CurrencyInputMessages) {
  return {
    currency: z.string({ error: M.currency }).refine(isDocumentCurrency, M.currency).optional(),
    /** Ringgit per one unit; null on a draft in another currency whose rate is not known yet. */
    // A number (a direct caller) or exact decimal text (the form: no digit lost to a float).
    fx_rate: z
      .union([
        z
          .number({ error: M.rate })
          .positive(M.rate)
          .max(1_000_000_000, M.rate)
          .refine((n) => calculationRateText(String(n)).length <= EINVOICE_RATE_MAX, M.rateTooLong),
        z
          .string({ error: M.rate })
          .regex(/^\d{1,10}(\.\d{1,10})?$/, M.rate)
          .refine((t) => Number(t) > 0 && Number(t) <= 1_000_000_000, M.rate)
          .refine((t) => calculationRateText(t).length <= EINVOICE_RATE_MAX, M.rateTooLong),
      ], { error: M.rate })
      .nullable()
      .optional(),
    fx_rate_source: z.enum(['bnm', 'manual'], { error: M.rate }).nullable().optional(),
    fx_rate_date: isoDate.nullable().optional(),
    /** Where a rate typed by hand came from (Customs Public Ruling 3/2026 para 3.3). */
    fx_rate_provider: z.enum(RATE_PROVIDERS, { error: M.rateSource }).nullable().optional(),
    /** The bank's or central bank's name, or Customs' approval reference; trimmed, empty is none. */
    fx_rate_reference: z
      .string({ error: M.rateSource })
      .trim()
      .max(RATE_REFERENCE_MAX, M.referenceTooLong)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
  };
}

/** The keys a ringgit-only caller's schema leaves out (with `.omit`). */
export const CURRENCY_INPUT_KEYS = {
  currency: true,
  fx_rate: true,
  fx_rate_source: true,
  fx_rate_date: true,
  fx_rate_provider: true,
  fx_rate_reference: true,
} as const;

type Checked = {
  currency?: string;
  fx_rate?: number | string | null;
  fx_rate_source?: 'bnm' | 'manual' | null;
  fx_rate_provider?: (typeof RATE_PROVIDERS)[number] | null;
  fx_rate_reference?: string | null;
  lines: { unit_price: number; discount_amount?: number | null }[];
};

/** The two rules, as a superRefine: whole units on the lines, and a typed rate's source. */
export function currencyInputIssues(M: Pick<CurrencyInputMessages, 'rateSource'>) {
  return (v: Checked, ctx: z.RefinementCtx) => {
    // With no currency sent the draft keeps its own; the save checks that case against the stored one.
    const problem = wholeUnitsError(v.currency ?? BASE_CURRENCY, v.lines);
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['lines'] });
    // A rate typed by hand names its source, and a bank, a central bank or a Customs approval its name.
    const manual = v.currency !== undefined && v.currency !== BASE_CURRENCY && v.fx_rate != null && v.fx_rate_source !== 'bnm';
    if (manual && (!v.fx_rate_provider || (PROVIDER_NEEDS_REFERENCE.has(v.fx_rate_provider) && !v.fx_rate_reference))) {
      ctx.addIssue({ code: 'custom', message: M.rateSource, path: ['fx_rate_provider'] });
    }
  };
}
