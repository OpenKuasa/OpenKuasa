import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BNM_CURRENCIES,
  DOCUMENT_CURRENCIES,
  PER_100_CURRENCIES,
  currencyLabel,
  currencyOptions,
  isDocumentCurrency,
  minorUnits,
  quoteUnit,
} from '@/lib/finance/currencies';
import { money, rm } from '@/lib/finance/format';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const MIGRATION = read('supabase/migrations/20261119160000_bendahara_quotation_currency.sql');
const LATEST = JSON.parse(read('tests/fixtures/bnm/latest-1700-2026-10-15.json')) as {
  data: { currency_code: string; unit: number }[];
};

describe('the currency list', () => {
  it('is the same list as the domain public.finance_currency in the migration', () => {
    const domain = /create domain public\.finance_currency as text\s+constraint finance_currency_check check \(value in \(([^)]*)\)\)/.exec(MIGRATION);
    expect(domain).not.toBeNull();
    const codes = [...domain![1].matchAll(/'([A-Z]{3})'/g)].map((m) => m[1]);
    expect(codes).toEqual([...DOCUMENT_CURRENCIES]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('has ringgit and every currency Bank Negara publishes but SDR, and no three-decimal currency', () => {
    expect(isDocumentCurrency('MYR')).toBe(true);
    const published = LATEST.data.map((d) => d.currency_code).filter((c) => c !== 'SDR').sort();
    expect([...BNM_CURRENCIES]).toEqual(published);
    for (const code of published) expect(isDocumentCurrency(code), code).toBe(true);
    for (const code of ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND', 'SDR', 'XDR', 'XAU', 'usd', 'US', '']) {
      expect(isDocumentCurrency(code), code).toBe(false);
    }
  });

  it('quotes per 100 exactly the currencies BNM gives per 100', () => {
    const per100 = LATEST.data.filter((d) => d.unit === 100).map((d) => d.currency_code).sort();
    expect([...PER_100_CURRENCIES]).toEqual(per100);
    expect(quoteUnit('JPY')).toBe(100);
    expect(quoteUnit('USD')).toBe(1);
    expect(quoteUnit('ZAR')).toBe(1);
  });

  it('knows which have no minor unit', () => {
    expect(minorUnits('JPY')).toBe(0);
    expect(minorUnits('KRW')).toBe(0);
    expect(minorUnits('VND')).toBe(0);
    // ISO 4217 gives IDR two decimals, though nobody uses them.
    expect(minorUnits('IDR')).toBe(2);
    expect(minorUnits('USD')).toBe(2);
    expect(minorUnits('KWD')).toBeNull();
  });

  it('lists ringgit first, then what BNM publishes, then the rest, each once', () => {
    const options = currencyOptions();
    expect(options[0]).toBe('MYR');
    expect(options.slice(1, 1 + BNM_CURRENCIES.length)).toEqual([...BNM_CURRENCIES]);
    expect(new Set(options).size).toBe(DOCUMENT_CURRENCIES.length);
    expect(options).toHaveLength(DOCUMENT_CURRENCIES.length);
  });
});

describe('money', () => {
  it('writes ringgit exactly as rm does, so no ringgit figure changes', () => {
    for (const n of [0, 1240, 1240.5, 0.005, 1_000_000.123]) expect(money(n)).toBe(rm(n));
    expect(money(1240, 'MYR')).toBe('RM 1,240.00');
    expect(currencyLabel('MYR')).toBe('RM');
  });

  it('writes another currency with its code and its own decimals', () => {
    expect(money(1000, 'USD')).toBe('USD 1,000.00');
    expect(money(150000, 'JPY')).toBe('JPY 150,000');
    expect(currencyLabel('USD')).toBe('USD');
  });
});
