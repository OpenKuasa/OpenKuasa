import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_LABELS,
  PROVIDER_NEEDS_REFERENCE,
  RATE_PROVIDERS,
  REFERENCE_LABELS,
  SST_RATE_RULE,
  fxSstRate,
  rateDateFor,
} from '@/lib/finance/sst-rate';

const MIGRATION = readFileSync(join(process.cwd(), 'supabase/migrations/20261120100000_bendahara_invoice_currency.sql'), 'utf8');

describe('the one SST rate rule', () => {
  it('is Bank Negara Malaysia’s 17:00 selling rate for the date of supply, as its SQL twin says', () => {
    expect(SST_RATE_RULE).toEqual({ source: 'bnm', session: '1700', figure: 'selling', date: 'supply' });
    // private.finance_sst_fx_rate: the same source, session and figure, per one unit, newest on or before the date.
    expect(MIGRATION).toContain("where r.source = 'bnm' and r.session = '1700' and r.currency = target_currency");
    expect(MIGRATION).toContain('select round(r.selling_rate / r.unit, 10), r.rate_date');
    expect(MIGRATION).toContain('and r.rate_date <= supply_date and r.selling_rate is not null');
  });

  it('takes the date of supply, or the invoice date when there is none', () => {
    expect(rateDateFor('2026-10-18', '2026-10-14')).toBe('2026-10-14');
    expect(rateDateFor('2026-10-18', null)).toBe('2026-10-18');
    expect(rateDateFor('2026-10-18', undefined)).toBe('2026-10-18');
    expect(rateDateFor('2026-10-18', '  ')).toBe('2026-10-18');
  });
});

describe('where a typed rate comes from', () => {
  it('lists exactly the sources the table accepts (Public Ruling 3/2026 para 3.3, and 3.5)', () => {
    const check = /fx_rate_provider in\s*\(([^)]*)\)/.exec(MIGRATION)?.[1] ?? '';
    const inSql = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(inSql).toEqual([...RATE_PROVIDERS]);
  });

  it('asks a name or reference of exactly the three the table asks it of', () => {
    const check = /fx_rate_provider not in \(([^)]*)\)/.exec(MIGRATION)?.[1] ?? '';
    const inSql = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect([...PROVIDER_NEEDS_REFERENCE].sort()).toEqual(inSql);
    expect(Object.keys(REFERENCE_LABELS).sort()).toEqual(inSql);
  });

  it('names every source in words', () => {
    for (const provider of RATE_PROVIDERS) expect(PROVIDER_LABELS[provider]).toMatch(/\w/);
  });
});

describe('reading the rule’s rate', () => {
  const client = (data: unknown, error: unknown = null) => {
    const calls: { fn: string; args: unknown }[] = [];
    return { calls, client: { rpc: async (fn: string, args: unknown) => (calls.push({ fn, args }), { data, error }) } as never };
  };

  it('asks the database function and keeps the rate as its exact text', async () => {
    const { client: c, calls } = client([{ rate: '0.0258200000', rate_date: '2026-10-16', unit: 100, selling_rate: '2.582000' }]);
    expect(await fxSstRate(c, 'JPY', '2026-10-18')).toEqual({
      rate: 0.02582,
      rate_text: '0.0258200000',
      rate_date: '2026-10-16',
      unit: 100,
      published_rate: 2.582,
      figure: 'selling',
    });
    expect(calls).toEqual([{ fn: 'finance_fx_rate_for_invoice', args: { target_currency: 'JPY', on_date: '2026-10-18' } }]);
  });

  it('answers null when Bank Negara has none, and throws a read error', async () => {
    expect(await fxSstRate(client([]).client, 'THB', '2026-10-18')).toBeNull();
    await expect(fxSstRate(client(null, { code: 'XX000' }).client, 'USD', '2026-10-18')).rejects.toMatchObject({ code: 'XX000' });
  });
});
