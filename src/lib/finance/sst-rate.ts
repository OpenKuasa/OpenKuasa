/**
 * THE rule for the rate a foreign amount on a sales document is put into ringgit at. Its SQL twin is
 * private.finance_sst_fx_rate (supabase/migrations/20261120100000_bendahara_invoice_currency.sql); change both
 * together. Service Tax Regulations 2018 reg 10(1)(h), Sales Tax Regulations 2018 reg 7(i), Customs Public
 * Ruling 3/2026 para 3.1-3.4: the selling rate prevailing in Malaysia at the time of supply, from one source
 * used consistently.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FxDefault } from './fx-rates';

export const SST_RATE_RULE = {
  source: 'bnm',
  session: '1700',
  figure: 'selling',
  /** The newest rate on or before this date. */
  date: 'supply',
} as const;

/** The date the rate is taken for: the date of supply, or the invoice date when none is given. */
export function rateDateFor(invoiceDate: string, supplyDate: string | null | undefined): string {
  return supplyDate && supplyDate.trim() !== '' ? supplyDate : invoiceDate;
}

/** Where a rate typed by hand came from (PR 3/2026 para 3.3, and 3.5 for anything else). */
export const RATE_PROVIDERS = [
  'bnm', 'malaysian_bank', 'bloomberg', 'reuters', 'oanda', 'foreign_central_bank', 'customs_approved',
] as const;
export type RateProvider = (typeof RATE_PROVIDERS)[number];
export const PROVIDER_NEEDS_REFERENCE: ReadonlySet<RateProvider> = new Set(['malaysian_bank', 'foreign_central_bank', 'customs_approved']);
export const PROVIDER_LABELS: Record<RateProvider, string> = {
  bnm: 'Bank Negara Malaysia (another rate or time)',
  malaysian_bank: 'A bank in Malaysia',
  bloomberg: 'Bloomberg',
  reuters: 'Reuters',
  oanda: 'Oanda',
  foreign_central_bank: 'A foreign central bank',
  customs_approved: 'Another source approved by Customs',
};
export const REFERENCE_LABELS: Partial<Record<RateProvider, string>> = {
  malaysian_bank: "The bank's name",
  foreign_central_bank: "The central bank's name",
  customs_approved: "Customs' approval reference",
};
/** The reference column holds at most this many characters (the table's check). */
export const RATE_REFERENCE_MAX = 100;

export function isRateProvider(value: unknown): value is RateProvider {
  return typeof value === 'string' && (RATE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The rule's rate for an invoice in `currency` supplied on `date`, read with the person's own session: BNM's
 * 17:00 selling rate per one unit, the newest on or before the date. The rate travels as exact text; `rate`
 * beside it is for display only. null when BNM has none.
 */
export async function fxSstRate(client: SupabaseClient, currency: string, date: string): Promise<FxDefault | null> {
  const { data, error } = await client.rpc('finance_fx_rate_for_invoice', { target_currency: currency, on_date: date });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || row.rate === null || row.rate === undefined) return null;
  const text = String(row.rate);
  return {
    rate: Number(text),
    rate_text: text,
    rate_date: row.rate_date as string,
    unit: Number(row.unit),
    published_rate: Number(row.selling_rate),
    figure: 'selling',
  };
}
