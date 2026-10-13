/**
 * Finance products and services: what goes on an invoice or bill line. One Zod
 * schema and one function per write; org_id comes from the context.
 */
import { z } from 'zod';
import { roundRate } from './bills';
import {
  type FinResult,
  type FinanceWriteContext,
  PG_FOREIGN_KEY,
  PG_UNIQUE,
  pgCode,
  writeFailed,
} from './result';

export type ProductType = 'product' | 'service';

export type FinanceProduct = {
  id: string;
  sku: string | null;
  name: string;
  type: ProductType;
  category: string | null;
  uom: string;
  price: number;
  cost: number;
  sst_rate: number;
  active: boolean;
};

export const PRODUCT_COLUMNS = 'id,sku,name,type,category,uom,price,cost,sst_rate,active';
export const PRODUCT_NAME_MAX = 160;
export const PRODUCT_LIMIT = 1000;

export const PRODUCT_MESSAGES = {
  name: 'Enter the item’s name.',
  nameTooLong: `Keep the name to ${PRODUCT_NAME_MAX} characters or fewer.`,
  type: 'Choose Product or Service.',
  tooLong: 'That is too long. Keep it to 60 characters or fewer.',
  price: 'Enter a price of 0 or more.',
  cost: 'Enter a cost of 0 or more.',
  sst: 'Enter an SST rate between 0 and 100.',
  skuTaken: 'Another product already uses that SKU.',
  gone: 'That item no longer exists.',
  inUse: 'This item is used on bills or other documents. Archive it instead.',
} as const;

const M = PRODUCT_MESSAGES;
/** price is numeric(14,2); cost is numeric(14,4), which holds sub-sen unit costs. */
const MAX_PRICE = 999_999_999_999.99;
const MAX_COST = 9_999_999_999.9999;

const name = z.string({ error: M.name }).trim().min(1, M.name).max(PRODUCT_NAME_MAX, M.nameTooLong);
const text = z
  .string({ error: M.tooLong })
  .trim()
  .max(60, M.tooLong)
  .transform((v) => (v === '' ? null : v))
  .nullable();
const type = z.enum(['product', 'service'], { error: M.type });
const price = z
  .number({ error: M.price })
  .min(0, M.price)
  .max(MAX_PRICE, M.price)
  .transform((v) => Math.round(v * 100) / 100);
const cost = z
  .number({ error: M.cost })
  .min(0, M.cost)
  .max(MAX_COST, M.cost)
  .transform((v) => Math.round(v * 10000) / 10000);
// Rounded as the column numeric(5,2) stores it, then checked, as on a bill line.
const sst = z.number({ error: M.sst }).transform(roundRate).pipe(z.number().min(0, M.sst).max(100, M.sst));
const uom = z
  .string({ error: M.tooLong })
  .trim()
  .max(60, M.tooLong)
  .transform((v) => (v === '' ? 'unit' : v));
const id = z.string({ error: M.gone }).uuid(M.gone);

export const createProductInput = z.object({
  name,
  type,
  sku: text.default(null),
  category: text.default(null),
  uom: uom.default('unit'),
  price,
  cost: cost.default(0),
  sst_rate: sst.default(0),
});

export const updateProductInput = z.object({
  id,
  name: name.optional(),
  type: type.optional(),
  sku: text.optional(),
  category: text.optional(),
  uom: uom.optional(),
  price: price.optional(),
  cost: cost.optional(),
  sst_rate: sst.optional(),
});

export const setProductActiveInput = z.object({ id, active: z.boolean() });
export const deleteProductInput = z.object({ id });

function productWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const code = pgCode(error);
  if (code === PG_UNIQUE) return { ok: false, error: M.skuTaken };
  if (code === PG_FOREIGN_KEY) return { ok: false, error: M.inUse };
  return writeFailed(fnName, error);
}

/** numeric columns arrive as strings from PostgREST. */
function toProduct(row: Record<string, unknown>): FinanceProduct {
  return {
    ...(row as unknown as FinanceProduct),
    price: Number(row.price),
    cost: Number(row.cost),
    sst_rate: Number(row.sst_rate),
  };
}

export async function listProducts(ctx: FinanceWriteContext): Promise<FinanceProduct[]> {
  const { data, error } = await ctx.client
    .from('finance_products')
    .select(PRODUCT_COLUMNS)
    .eq('org_id', ctx.orgId)
    .order('name', { ascending: true })
    .range(0, PRODUCT_LIMIT - 1);
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toProduct);
}

export async function createProduct(
  ctx: FinanceWriteContext,
  input: z.input<typeof createProductInput>,
): Promise<FinResult<FinanceProduct>> {
  const values = createProductInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_products')
    .insert({ ...values, org_id: ctx.orgId })
    .select(PRODUCT_COLUMNS)
    .single();
  if (error || !data) return productWriteFailed('createProduct', error);
  return { ok: true, data: toProduct(data as unknown as Record<string, unknown>) };
}

export async function updateProduct(
  ctx: FinanceWriteContext,
  input: z.input<typeof updateProductInput>,
): Promise<FinResult<FinanceProduct>> {
  const { id: productId, ...fields } = updateProductInput.parse(input);
  if (Object.values(fields).every((v) => v === undefined)) {
    return { ok: false, error: 'Nothing to update.' };
  }
  const { data, error } = await ctx.client
    .from('finance_products')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', productId)
    .eq('org_id', ctx.orgId)
    .select(PRODUCT_COLUMNS)
    .maybeSingle();
  if (error) return productWriteFailed('updateProduct', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: toProduct(data as unknown as Record<string, unknown>) };
}

export async function setProductActive(
  ctx: FinanceWriteContext,
  input: z.input<typeof setProductActiveInput>,
): Promise<FinResult<FinanceProduct>> {
  const { id: productId, active } = setProductActiveInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_products')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', productId)
    .eq('org_id', ctx.orgId)
    .select(PRODUCT_COLUMNS)
    .maybeSingle();
  if (error) return productWriteFailed('setProductActive', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: toProduct(data as unknown as Record<string, unknown>) };
}

export async function deleteProduct(
  ctx: FinanceWriteContext,
  input: z.input<typeof deleteProductInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: productId } = deleteProductInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_products')
    .delete()
    .eq('id', productId)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return productWriteFailed('deleteProduct', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/* ---- what the screen shows ------------------------------------------- */

export type ProductsViewData = {
  stats: { items: number; services: number; taxable: number; averagePrice: number };
  byCategory: { label: string; items: number }[];
  rows: FinanceProduct[];
};

/** Stock and revenue are not tracked yet, so the mock-up's stock and revenue figures are not shown. */
export function productsView(products: FinanceProduct[]): ProductsViewData {
  const rows = [...products].sort((x, y) => x.name.localeCompare(y.name));
  const active = rows.filter((p) => p.active);
  const counts = new Map<string, number>();
  for (const p of active) {
    const label = p.category ?? 'Uncategorised';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const total = active.reduce((sum, p) => sum + p.price, 0);
  return {
    stats: {
      items: active.length,
      services: active.filter((p) => p.type === 'service').length,
      taxable: active.filter((p) => p.sst_rate > 0).length,
      averagePrice: active.length ? Math.round((total / active.length) * 100) / 100 : 0,
    },
    byCategory: [...counts.entries()]
      .map(([label, items]) => ({ label, items }))
      .sort((x, y) => y.items - x.items || x.label.localeCompare(y.label)),
    rows,
  };
}
