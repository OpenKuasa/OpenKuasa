/**
 * What a later MyInvois submission takes from a posted invoice (LHDN SDK Invoice v1.1): its currency, the one
 * exchange rate it was posted at, and its tax in ringgit. Nothing is submitted by this app yet. Pure.
 */
import { BASE_CURRENCY } from './currencies';
import { rm } from './format';
import type { InvoiceListRow } from './invoices';
import { PROVIDER_LABELS } from './sst-rate';
import { displayDate } from './view-helpers';

/** CalculationRate is at most this many characters (LHDN SDK Invoice v1.1; the invoices table checks it too). */
export const EINVOICE_RATE_MAX = 15;

export type EInvoiceCurrencyFields = {
  /** cbc:DocumentCurrencyCode */
  documentCurrencyCode: string;
  /** cac:TaxExchangeRate/cbc:CalculationRate, at most 15 characters; null for ringgit (left out). */
  calculationRate: string | null;
  /** cac:TaxTotal/cbc:TaxAmount @currencyID MYR */
  taxTotalMyr: number;
};

/**
 * The database's rate text with its trailing zeros (and a bare point) dropped, as trim_scale gives it, so the
 * table's 15-character check is the same length test: "4.0830000000" → "4.083".
 */
export function calculationRateText(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

export function einvoiceCurrencyFields(row: {
  currency: string;
  fx_rate_text: string | null;
  sst_myr: number | null;
  sst: number;
}): EInvoiceCurrencyFields {
  const ringgit = row.currency === BASE_CURRENCY;
  return {
    documentCurrencyCode: row.currency,
    calculationRate: ringgit || row.fx_rate_text === null ? null : calculationRateText(row.fx_rate_text),
    taxTotalMyr: ringgit ? row.sst : (row.sst_myr ?? 0),
  };
}

/**
 * The read-only lines the e-Invois card shows for an invoice in another currency: what a submission would carry.
 * Nothing for ringgit. "Exchange rate 4.083 (RM per USD), Bank Negara Malaysia 5 pm selling, 15 Oct 2026", or
 * "…, typed by hand, Reuters"; "SST in ringgit RM 336.00".
 */
export function einvoiceCurrencyLines(
  row: Pick<
    InvoiceListRow,
    'currency' | 'fx_rate_text' | 'fx_rate_source' | 'fx_rate_date' | 'fx_rate_provider' | 'fx_rate_reference' | 'sst_myr'
  >,
): string[] {
  if (row.currency === BASE_CURRENCY) return [];
  const lines = [`Currency ${row.currency}`];
  if (row.fx_rate_text !== null) {
    const source =
      row.fx_rate_source === 'bnm' && row.fx_rate_date
        ? `Bank Negara Malaysia 5 pm selling, ${displayDate(row.fx_rate_date)}`
        : ['typed by hand', row.fx_rate_provider ? PROVIDER_LABELS[row.fx_rate_provider] : null, row.fx_rate_reference]
            .filter(Boolean)
            .join(', ');
    lines.push(`Exchange rate ${calculationRateText(row.fx_rate_text)} (RM per ${row.currency}), ${source}`);
  }
  if (row.sst_myr !== null) lines.push(`SST in ringgit ${rm(row.sst_myr)}`);
  return lines;
}
