import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type FxLatestRate, fxRatesCardView, longDate, rateWords } from '@/lib/finance/fx-rates';

const rate = (currency: string, rate_date: string, unit = 1, middle_rate = 4.0815): FxLatestRate => ({
  currency,
  rate_date,
  unit,
  middle_rate,
  rate: middle_rate / unit,
});

describe('fxRatesCardView', () => {
  it('says there are no rates yet, and when they come', () => {
    expect(fxRatesCardView([], '2026-10-15')).toEqual({
      rows: [],
      subtitle: 'Bank Negara Malaysia, 5 pm middle rate',
      note: 'No rates yet. They are fetched from Bank Negara Malaysia every working day after 5:30 pm.',
    });
  });

  it('puts the most used first, names the unit BNM quotes per, and dates only a rate older than the rest', () => {
    const view = fxRatesCardView(
      [rate('AED', '2026-10-15', 100, 111.1202), rate('JPY', '2026-10-15', 100, 2.5857), rate('USD', '2026-10-15'), rate('EGP', '2026-10-14', 1, 0.0846)],
      '2026-10-15',
    );
    expect(view.subtitle).toBe('Bank Negara Malaysia, 5 pm middle rate, 15 October 2026');
    expect(view.note).toBeNull();
    expect(view.rows).toEqual([
      { currency: 'USD', words: 'RM 4.0815 per USD', date: '' },
      { currency: 'JPY', words: 'RM 2.5857 per 100 JPY', date: '' },
      { currency: 'AED', words: 'RM 111.1202 per 100 AED', date: '' },
      { currency: 'EGP', words: 'RM 0.0846 per EGP', date: '14 October 2026' },
    ]);
  });

  it('says so when the newest rate is more than seven days old', () => {
    expect(fxRatesCardView([rate('USD', '2026-10-02')], '2026-10-09').note).toBeNull();
    expect(fxRatesCardView([rate('USD', '2026-10-02')], '2026-10-10').note).toBe(
      'These rates have not been updated since 2 October 2026.',
    );
  });
});

describe('words', () => {
  it('reads a date in full and a rate to four decimals or more', () => {
    expect(longDate('2026-10-02')).toBe('2 October 2026');
    expect(rateWords({ currency: 'VND', unit: 100, middle_rate: 0.0158 })).toBe('RM 0.0158 per 100 VND');
  });
});

describe('the migration', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261119150000_bendahara_fx_rates.sql'), 'utf8');

  it('gives service_role select and insert on the rates, and no update, delete or truncate', () => {
    expect(sql).toContain('grant select, insert on public.finance_fx_rates to service_role;');
    expect(sql).toContain('grant select, insert, update on public.finance_fx_fetch_state to service_role;');
    expect(sql).toMatch(/revoke all on public\.finance_fx_rates from anon, authenticated, service_role;/);
    expect(sql).not.toMatch(/grant [^;]*(update|delete|truncate)[^;]* on public\.finance_fx_rates/);
  });

  it('lets a signed-in person read the rates and nothing else', () => {
    expect(sql).toContain('grant select on public.finance_fx_rates to authenticated;');
    expect(sql).not.toMatch(/grant [^;]* on public\.finance_fx_fetch_state to [^;]*authenticated/);
    expect(sql).not.toMatch(/to anon\b/);
  });
});
