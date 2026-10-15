/**
 * The currencies a document may be in: ISO 4217's active codes with no or
 * two minor units. Three-decimal currencies (BHD, IQD, JOD, KWD, LYD, OMR,
 * TND) are refused: every money column keeps two decimals, and none is on
 * Bank Negara Malaysia's list. Fund, metal and test codes (X…) are left out,
 * but for the three CFA/CFP francs and the East Caribbean dollar and guilder.
 * The database holds the same list in the domain public.finance_currency;
 * tests/finance-currencies.test.ts reads the migration and holds them equal.
 * Pure.
 */

/** No minor unit: amounts are whole numbers. */
export const ZERO_DECIMAL_CURRENCIES = [
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
] as const;

/** Two minor units, as ringgit. */
export const TWO_DECIMAL_CURRENCIES = [
  'AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BMD', 'BND', 'BOB',
  'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CNY', 'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DKK',
  'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GTQ', 'GYD', 'HKD',
  'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IRR', 'JMD', 'KES', 'KGS', 'KHR', 'KPW', 'KYD', 'KZT', 'LAK', 'LBP',
  'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR',
  'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'QAR', 'RON', 'RSD',
  'RUB', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'USD', 'UYU', 'UZS', 'VES', 'WST', 'XCD', 'XCG',
  'YER', 'ZAR', 'ZMW', 'ZWG',
] as const;

/** Every code a document may carry, A to Z. */
export const DOCUMENT_CURRENCIES: readonly string[] = [...ZERO_DECIMAL_CURRENCIES, ...TWO_DECIMAL_CURRENCIES].sort();

const ZERO = new Set<string>(ZERO_DECIMAL_CURRENCIES);
const ALL = new Set<string>(DOCUMENT_CURRENCIES);

export const BASE_CURRENCY = 'MYR';

export function isDocumentCurrency(code: string): boolean {
  return ALL.has(code);
}

/** 0 or 2; null for a code no document may carry. */
export function minorUnits(code: string): 0 | 2 | null {
  if (!ALL.has(code)) return null;
  return ZERO.has(code) ? 0 : 2;
}

/**
 * The currencies Bank Negara Malaysia publishes a 1700 middle rate for (SDR
 * aside, which no document is in), as listed on 2026-10-15. Others have no
 * default rate: the person types one.
 */
export const BNM_CURRENCIES = [
  'AED', 'AUD', 'BND', 'CAD', 'CHF', 'CNY', 'EGP', 'EUR', 'GBP', 'HKD', 'IDR', 'INR', 'JPY', 'KHR', 'KRW', 'MMK',
  'NPR', 'NZD', 'PHP', 'PKR', 'SAR', 'SGD', 'THB', 'TWD', 'USD', 'VND',
] as const;

/** The ones BNM quotes per 100 units; the rate box asks for ringgit per 100 of them too. */
export const PER_100_CURRENCIES = ['AED', 'HKD', 'IDR', 'INR', 'JPY', 'KHR', 'KRW', 'MMK', 'NPR', 'PHP', 'PKR', 'SAR', 'THB', 'TWD', 'VND'] as const;
const PER_100 = new Set<string>(PER_100_CURRENCIES);

/** How many units of a currency the rate box (and BNM) quotes ringgit for: 1 or 100. */
export function quoteUnit(code: string): 1 | 100 {
  return PER_100.has(code) ? 100 : 1;
}

/** What the picker lists: ringgit first, then the currencies BNM publishes, then every other, each group A to Z. */
export function currencyOptions(): string[] {
  const bnm = new Set<string>(BNM_CURRENCIES);
  return [
    BASE_CURRENCY,
    ...BNM_CURRENCIES,
    ...DOCUMENT_CURRENCIES.filter((code) => code !== BASE_CURRENCY && !bnm.has(code)),
  ];
}

/** The label of an amount's currency: "RM" for ringgit, as every screen already writes it; the code for any other. */
export function currencyLabel(code: string): string {
  return code === BASE_CURRENCY ? 'RM' : code;
}
