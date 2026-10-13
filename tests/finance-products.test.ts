import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinanceWriteContext } from '@/lib/finance/result';
import {
  type FinanceProduct,
  createProduct,
  createProductInput,
  deleteProduct,
  productsView,
  updateProduct,
  updateProductInput,
} from '@/lib/finance/products';

const ID = '22222222-2222-4222-8222-222222222222';

type Call = { table: string; op: string; values?: Record<string, unknown>; filters: Record<string, unknown> };

function fakeClient(answer: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: '', filters: {} };
      calls.push(call);
      const builder = {
        insert(values: Record<string, unknown>) { call.op = 'insert'; call.values = values; return builder; },
        update(values: Record<string, unknown>) { call.op = 'update'; call.values = values; return builder; },
        delete() { call.op = 'delete'; return builder; },
        eq(column: string, value: unknown) { call.filters[column] = value; return builder; },
        select() { return builder; },
        single: async () => answer,
        maybeSingle: async () => answer,
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, calls };
}

const product: FinanceProduct = {
  id: ID, sku: 'PRD-010', name: 'Printer Ink', type: 'product', category: 'Office supplies',
  uom: 'cartridge', price: 85, cost: 52, sst_rate: 6, active: true,
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, value: unknown) =>
  schema.safeParse(value).error?.issues[0]?.message;

describe('product schemas', () => {
  const valid = { name: 'Printer Ink', type: 'product', price: 85 };

  it('asks for a name', () => {
    expect(first(createProductInput, { ...valid, name: '' })).toBe('Enter the item’s name.');
  });
  it('refuses a negative price or cost', () => {
    expect(first(createProductInput, { ...valid, price: -1 })).toBe('Enter a price of 0 or more.');
    expect(first(createProductInput, { ...valid, cost: -0.5 })).toBe('Enter a cost of 0 or more.');
  });
  it('keeps the SST rate between 0 and 100', () => {
    expect(first(createProductInput, { ...valid, sst_rate: 101 })).toBe('Enter an SST rate between 0 and 100.');
    // The column is numeric(5,2): 1.005 is stored as 1.01, so that is what the write carries.
    const rounded = createProductInput.parse({ ...valid, sst_rate: 1.005 });
    expect(rounded.sst_rate).toBe(1.01);
    expect(createProductInput.parse(rounded).sst_rate).toBe(1.01);
    expect(updateProductInput.parse({ id: ID, sst_rate: 0.145 }).sst_rate).toBe(0.15);
    expect(first(createProductInput, { ...valid, sst_rate: 100.005 })).toBe('Enter an SST rate between 0 and 100.');
  });
  it('fills the defaults and turns an empty SKU into null', () => {
    expect(createProductInput.parse({ ...valid, sku: '  ' })).toMatchObject({
      sku: null, category: null, uom: 'unit', cost: 0, sst_rate: 0, type: 'product',
    });
  });
  it('rounds a price to two decimals', () => {
    expect(createProductInput.parse({ ...valid, price: 14.506 }).price).toBe(14.51);
  });
  it('keeps four decimals on a cost, as the column does', () => {
    expect(createProductInput.parse({ ...valid, cost: 0.0375 }).cost).toBe(0.0375);
    expect(createProductInput.parse({ ...valid, cost: 0.03754 }).cost).toBe(0.0375);
    expect(updateProductInput.parse({ id: ID, cost: 2.3456 }).cost).toBe(2.3456);
  });
  it('refuses a cost too large for the column', () => {
    expect(first(createProductInput, { ...valid, cost: 10_000_000_000 })).toBe('Enter a cost of 0 or more.');
  });
});

describe('product writes', () => {
  it('creates in the caller’s workspace', async () => {
    const { ctx, calls } = fakeClient({ data: product, error: null });
    expect(await createProduct(ctx, { name: 'Printer Ink', type: 'product', price: 85 })).toEqual({ ok: true, data: product });
    expect(calls[0]).toMatchObject({ table: 'finance_products', op: 'insert' });
    expect(calls[0].values).toMatchObject({ org_id: 'org-1', name: 'Printer Ink' });
  });
  it('explains an SKU that is already used', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: '23505' } });
    expect(await createProduct(ctx, { name: 'Ink', type: 'product', price: 1, sku: 'PRD-010' })).toEqual({
      ok: false, error: 'Another product already uses that SKU.',
    });
    expect(await updateProduct(ctx, { id: ID, sku: 'PRD-010' })).toEqual({
      ok: false, error: 'Another product already uses that SKU.',
    });
  });
  it('explains a delete refused because documents use the item', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: '23503' } });
    expect(await deleteProduct(ctx, { id: ID })).toEqual({
      ok: false, error: 'This item is used on bills or other documents. Archive it instead.',
    });
  });
  it('says the item is gone when no row comes back', async () => {
    const { ctx } = fakeClient({ data: null, error: null });
    expect(await updateProduct(ctx, { id: ID, name: 'New' })).toEqual({ ok: false, error: 'That item no longer exists.' });
    expect(await deleteProduct(ctx, { id: ID })).toEqual({ ok: false, error: 'That item no longer exists.' });
  });
});

describe('productsView', () => {
  const service: FinanceProduct = { ...product, id: 's1', sku: null, name: 'Consultation', type: 'service', category: 'Professional', price: 250, sst_rate: 6 };
  const untaxed: FinanceProduct = { ...product, id: 'p2', sku: null, name: 'Receipt Roll', category: null, price: 6, sst_rate: 0 };
  const archived: FinanceProduct = { ...product, id: 'p3', name: 'Old Item', price: 1000, active: false };

  it('counts and averages active items only', () => {
    const view = productsView([product, service, untaxed, archived]);
    expect(view.stats).toEqual({ items: 3, services: 1, taxable: 2, averagePrice: 113.67 });
  });
  it('counts active items per category, largest first, with a name for none', () => {
    const view = productsView([product, service, untaxed, { ...product, id: 'p4', name: 'Paper' }]);
    expect(view.byCategory).toEqual([
      { label: 'Office supplies', items: 2 },
      { label: 'Professional', items: 1 },
      { label: 'Uncategorised', items: 1 },
    ]);
  });
  it('handles no items', () => {
    expect(productsView([]).stats).toEqual({ items: 0, services: 0, taxable: 0, averagePrice: 0 });
  });
});
