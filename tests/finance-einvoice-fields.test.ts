import { describe, expect, it } from 'vitest';
import { calculationRateText, einvoiceCurrencyFields, einvoiceCurrencyLines } from '@/lib/finance/einvoice-fields';

describe('the e-Invoice currency fields', () => {
  it('carries a foreign invoice’s code, its one rate trimmed as trim_scale trims it, and its tax in ringgit', () => {
    expect(einvoiceCurrencyFields({ currency: 'USD', fx_rate_text: '4.0830000000', sst_myr: 336, sst: 80 })).toEqual({
      documentCurrencyCode: 'USD',
      calculationRate: '4.083',
      taxTotalMyr: 336,
    });
    expect(einvoiceCurrencyFields({ currency: 'JPY', fx_rate_text: '0.0258200000', sst_myr: 12.91, sst: 500 }).calculationRate).toBe('0.02582');
  });

  it('leaves the rate out for ringgit and takes its own SST', () => {
    expect(einvoiceCurrencyFields({ currency: 'MYR', fx_rate_text: '1.0000000000', sst_myr: 6, sst: 6 })).toEqual({
      documentCurrencyCode: 'MYR',
      calculationRate: null,
      taxTotalMyr: 6,
    });
  });

  it('trims only after the point', () => {
    expect(calculationRateText('100.0000000000')).toBe('100');
    expect(calculationRateText('4.2000000000')).toBe('4.2');
    expect(calculationRateText('12')).toBe('12');
    expect(calculationRateText('1234.1234567891')).toHaveLength(15);
  });
});

describe('what the e-Invois card shows', () => {
  const usd = {
    currency: 'USD',
    fx_rate_text: '4.0830000000',
    fx_rate_source: 'bnm' as const,
    fx_rate_date: '2026-10-15',
    fx_rate_provider: null,
    fx_rate_reference: null,
    sst_myr: 336,
  };

  it('names the rate, where it came from and the SST in ringgit', () => {
    expect(einvoiceCurrencyLines(usd)).toEqual([
      'Currency USD',
      'Exchange rate 4.083 (RM per USD), Bank Negara Malaysia 5 pm selling, 15 Oct 2026',
      'SST in ringgit RM 336.00',
    ]);
    expect(
      einvoiceCurrencyLines({ ...usd, fx_rate_text: '4.2000000000', fx_rate_source: 'manual', fx_rate_date: null, fx_rate_provider: 'reuters' })[1],
    ).toBe('Exchange rate 4.2 (RM per USD), typed by hand, Reuters');
    expect(
      einvoiceCurrencyLines({
        ...usd,
        fx_rate_source: 'manual',
        fx_rate_date: null,
        fx_rate_provider: 'malaysian_bank',
        fx_rate_reference: 'Maybank',
      })[1],
    ).toBe('Exchange rate 4.083 (RM per USD), typed by hand, A bank in Malaysia, Maybank');
  });

  it('shows nothing for ringgit, and no rate line while a draft has none', () => {
    expect(einvoiceCurrencyLines({ ...usd, currency: 'MYR' })).toEqual([]);
    expect(einvoiceCurrencyLines({ ...usd, fx_rate_text: null, fx_rate_source: null, fx_rate_date: null, sst_myr: null })).toEqual([
      'Currency USD',
    ]);
  });
});
