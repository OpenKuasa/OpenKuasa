import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SST_TAX_TYPES,
  getSstSettings,
  saveSstSettings,
  sstPeriodFor,
  sstPeriodLabel,
  sstSettingsInput,
  taxTypeForRate,
} from '@/lib/finance/sst';
import type { FinanceWriteContext } from '@/lib/finance/result';

afterEach(() => vi.restoreAllMocks());

describe('taxTypeForRate', () => {
  it('follows private.finance_sst_tax_type_for_rate', () => {
    expect(taxTypeForRate(0)).toBe('none');
    expect(taxTypeForRate(5)).toBe('sales');
    expect(taxTypeForRate(10)).toBe('sales');
    expect(taxTypeForRate(6)).toBe('service');
    expect(taxTypeForRate(8)).toBe('service');
    expect(taxTypeForRate(7)).toBeNull();
    expect(SST_TAX_TYPES).toEqual(['sales', 'service', 'none']);
  });
});

describe('sstPeriodFor', () => {
  it('finds the two-month period and its due date', () => {
    expect(sstPeriodFor('2026-10-21', 9)).toEqual({ start: '2026-09-01', end: '2026-10-31', due: '2026-11-30' });
    expect(sstPeriodFor('2026-10-21', 1)).toEqual({ start: '2026-09-01', end: '2026-10-31', due: '2026-11-30' });
    expect(sstPeriodFor('2024-02-10', 1).due).toBe('2024-03-31');
  });
  it('crosses a year end', () => {
    expect(sstPeriodFor('2027-01-15', 12)).toEqual({ start: '2026-12-01', end: '2027-01-31', due: '2027-02-28' });
    expect(sstPeriodFor('2027-12-05', 12).due).toBe('2028-02-29');
  });
  it('labels both shapes', () => {
    expect(sstPeriodLabel(sstPeriodFor('2026-10-21', 9))).toBe('1 Sep – 31 Oct 2026');
    expect(sstPeriodLabel(sstPeriodFor('2027-01-15', 12))).toBe('1 Dec 2026 – 31 Jan 2027');
  });
});

describe('sstSettingsInput', () => {
  const base = { period_start_month: 1 };
  it('trims numbers and turns empty into null', () => {
    expect(sstSettingsInput.parse({ ...base, service_tax_no: '  W10-1 ' }).service_tax_no).toBe('W10-1');
    expect(sstSettingsInput.parse({ ...base, sales_tax_no: '' }).sales_tax_no).toBeNull();
    expect(sstSettingsInput.parse(base).service_tax_no).toBeNull();
  });
  it('refuses a number over 35 characters and a bad month', () => {
    expect(sstSettingsInput.safeParse({ ...base, service_tax_no: 'x'.repeat(36) }).success).toBe(false);
    expect(sstSettingsInput.safeParse({ period_start_month: 0 }).success).toBe(false);
    expect(sstSettingsInput.safeParse({ period_start_month: 13 }).success).toBe(false);
  });
  it('defaults the basis to payment', () => {
    expect(sstSettingsInput.parse(base).service_tax_basis).toBe('payment');
  });
});

function fakeClient(result: { data: unknown; error: unknown }) {
  const seen: { table?: string; filters: Record<string, unknown>; upsert?: unknown; options?: unknown } = { filters: {} };
  const builder = {
    select: () => builder,
    eq: (c: string, v: unknown) => {
      seen.filters[c] = v;
      return builder;
    },
    maybeSingle: async () => result,
    upsert: async (values: unknown, options: unknown) => {
      seen.upsert = values;
      seen.options = options;
      return { error: result.error };
    },
  };
  const client = {
    from: (t: string) => {
      seen.table = t;
      return builder;
    },
  };
  return { ctx: { client, orgId: 'org-1' } as unknown as FinanceWriteContext, seen };
}

describe('settings I/O', () => {
  it('reads the workspace row', async () => {
    const row = { period_start_month: 3, service_tax_no: null, sales_tax_no: 'S1', service_tax_basis: 'invoice' };
    const { ctx, seen } = fakeClient({ data: row, error: null });
    expect(await getSstSettings(ctx)).toEqual(row);
    expect(seen.table).toBe('finance_sst_settings');
    expect(seen.filters).toEqual({ org_id: 'org-1' });
  });
  it('returns null when nothing is saved', async () => {
    const { ctx } = fakeClient({ data: null, error: null });
    expect(await getSstSettings(ctx)).toBeNull();
  });
  it('upserts on org_id', async () => {
    const { ctx, seen } = fakeClient({ data: null, error: null });
    expect(await saveSstSettings(ctx, { period_start_month: 2, service_tax_no: ' A ' })).toEqual({ ok: true });
    expect(seen.upsert).toEqual({
      org_id: 'org-1', period_start_month: 2, service_tax_no: 'A', sales_tax_no: null, service_tax_basis: 'payment',
    });
    expect(seen.options).toEqual({ onConflict: 'org_id' });
  });
  it('maps 42501 to the owner/admin message', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: '42501' } });
    expect(await saveSstSettings(ctx, { period_start_month: 2 })).toEqual({
      ok: false, error: 'Only an owner or admin can change SST settings.',
    });
  });
  it('refuses invalid input without writing', async () => {
    const { ctx, seen } = fakeClient({ data: null, error: null });
    const r = await saveSstSettings(ctx, { period_start_month: 13 });
    expect(r.ok).toBe(false);
    expect(seen.upsert).toBeUndefined();
  });
});
