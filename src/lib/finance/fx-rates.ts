/**
 * Exchange rates as the screens read them: Bank Negara Malaysia's middle rate
 * of the 1700 session, ringgit per unit, stored by the fetch route in
 * finance_fx_rates. Every signed-in person may read them; nobody signed in
 * writes them. The functions that take a client read with the person's own
 * session; the rest are pure.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isDocumentCurrency } from './currencies';
import { isIsoDate } from './document-lines';
import { daysBetween } from './fx-dates';

/** A rate older than this, against the date it is wanted for, is offered with a warning. */
export const FX_STALE_AFTER_DAYS = 7;

/** One currency's newest rate (finance_fx_latest_rates). */
export type FxLatestRate = {
  currency: string;
  rate_date: string;
  /** 1 or 100: what BNM quotes the rate per. */
  unit: number;
  /** Ringgit per `unit`, as published. */
  middle_rate: number;
  /** Ringgit per one unit. */
  rate: number;
};

/** Every currency's newest rate, by code. */
export async function listLatestFxRates(client: SupabaseClient): Promise<FxLatestRate[]> {
  const { data, error } = await client
    .from('finance_fx_latest_rates')
    .select('currency, rate_date, unit, middle_rate, rate')
    .order('currency', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    currency: r.currency as string,
    rate_date: r.rate_date as string,
    // Display only: a stage that multiplies money by a rate must keep the exact numeric string, not these numbers.
    unit: Number(r.unit),
    middle_rate: Number(r.middle_rate),
    rate: Number(r.rate),
  }));
}

/** 2026-10-02 → 2 October 2026 */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** How a rate reads: "RM 4.0815 per USD", "RM 2.5857 per 100 JPY". Four decimals, as BNM publishes. */
export function rateWords(r: { currency: string; unit: number; middle_rate: number }): string {
  const per = r.unit === 1 ? r.currency : `${r.unit} ${r.currency}`;
  return `RM ${r.middle_rate.toLocaleString('en-MY', { minimumFractionDigits: 4, maximumFractionDigits: 6 })} per ${per}`;
}

/** Most-used first on the card; every other currency follows by code. */
export const FX_CARD_FIRST = ['USD', 'SGD', 'EUR', 'GBP', 'CNY', 'JPY', 'AUD', 'THB', 'IDR', 'HKD'];

export type FxRatesCardView = {
  rows: { currency: string; words: string; date: string }[];
  /** Under the title: where the rates are from and what day they are for. */
  subtitle: string;
  /** A sentence shown above the table, or null. */
  note: string | null;
};

/**
 * The read-only "Exchange rates" card on Banking. `today` is the person's
 * date. The newest date of all is the card's date; a currency whose rate is
 * older shows its own date.
 */
export function fxRatesCardView(rates: FxLatestRate[], today: string): FxRatesCardView {
  const order = (code: string) => {
    const i = FX_CARD_FIRST.indexOf(code);
    return i === -1 ? FX_CARD_FIRST.length : i;
  };
  const sorted = [...rates].sort((a, b) => order(a.currency) - order(b.currency) || a.currency.localeCompare(b.currency));
  const newest = rates.map((r) => r.rate_date).sort().at(-1) ?? null;
  if (newest === null) {
    return {
      rows: [],
      subtitle: 'Bank Negara Malaysia, 5 pm middle rate',
      note: 'No rates yet. They are fetched from Bank Negara Malaysia every working day after 5:30 pm.',
    };
  }
  return {
    rows: sorted.map((r) => ({ currency: r.currency, words: rateWords(r), date: r.rate_date === newest ? '' : longDate(r.rate_date) })),
    subtitle: `Bank Negara Malaysia, 5 pm middle rate, ${longDate(newest)}`,
    note:
      daysBetween(newest, today) > FX_STALE_AFTER_DAYS
        ? `These rates have not been updated since ${longDate(newest)}.`
        : null,
  };
}

/* ---- stage 2: the rate a document is offered ------------------------------ */

/**
 * BNM's rate a document dated D is offered: the latest 1700 rate on or before D. Quotations and invoices are
 * both offered the SST rule's selling rate (src/lib/finance/sst-rate.ts); the middle rate was a quotation's
 * until PR 3q, and is what a test can still build here.
 */
export type FxDefault = {
  /** Ringgit per one unit. For display; when `rate_text` is there, money is worked from it. */
  rate: number;
  /** Ringgit per one unit as the database's exact decimal text (the selling rate, from stage 3). */
  rate_text?: string;
  /** The date BNM gave it for; before D on a weekend, a holiday, or when BNM has nothing newer. */
  rate_date: string;
  unit: number;
  /** Ringgit per `unit`, as published: the middle rate (absent when `figure` is selling). */
  middle_rate?: number;
  /** Ringgit per `unit` as BNM printed the figure the rate is (the selling rate for an invoice). */
  published_rate?: number;
  /** Which BNM figure this is; absent means the middle rate (stage 2). */
  figure?: 'middle' | 'selling';
};

export const FX_RATE_MESSAGES = {
  currency: 'Choose a currency.',
  date: 'Enter a valid date (YYYY-MM-DD).',
} as const;

/** What a form sends to ask for BNM's rate. */
export const fxRateForInput = z.object({
  currency: z.string({ error: FX_RATE_MESSAGES.currency }).refine(isDocumentCurrency, FX_RATE_MESSAGES.currency),
  date: z.string({ error: FX_RATE_MESSAGES.date }).refine(isIsoDate, FX_RATE_MESSAGES.date),
});

/** "The latest rate is from 2 October 2026." when the rate offered is more than seven days before the document's date. */
export function staleRateNote(rateDate: string, documentDate: string): string | null {
  return daysBetween(rateDate, documentDate) > FX_STALE_AFTER_DAYS ? `The latest rate is from ${longDate(rateDate)}.` : null;
}
