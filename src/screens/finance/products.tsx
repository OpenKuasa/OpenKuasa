import {
  createProductAction,
  deleteProductAction,
  setProductActiveAction,
  updateProductAction,
} from '@/app/(app)/finance/actions';
import { type ProductActions, ProductsView } from '@/components/finance/products-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { type FinanceProduct, listProducts, productsView } from '@/lib/finance/products';
import { createClient } from '@/lib/supabase/server';

/* ---- sample data (Rimba Ventures Sdn Bhd), shown when there is no database ---- */

const sample = (
  id: string,
  name: string,
  sku: string,
  type: 'product' | 'service',
  category: string,
  price: number,
  sst_rate: number,
  active = true,
): FinanceProduct => ({ id, name, sku, type, category, uom: type === 'service' ? 'job' : 'unit', price, cost: 0, sst_rate, active, tax_type: sst_rate > 0 ? 'service' : 'none', sst_code: null });

const SAMPLE_PRODUCTS: FinanceProduct[] = [
  sample('1', 'Consultation — 1hr', 'SRV-001', 'service', 'Professional', 250, 6),
  sample('2', 'Website Package', 'SRV-002', 'service', 'Professional', 3500, 6),
  sample('3', 'Monthly Bookkeeping', 'SRV-003', 'service', 'Professional', 600, 6),
  sample('4', 'Printer Ink', 'PRD-010', 'product', 'Office supplies', 85, 6),
  sample('5', 'A4 Paper (Ream)', 'PRD-011', 'product', 'Office supplies', 14.5, 6),
  sample('6', 'Thermal Receipt Roll', 'PRD-012', 'product', 'Consumables', 6, 0),
  sample('7', 'Logo Design', 'SRV-004', 'service', 'Professional', 450, 6, false),
];

const ACTIONS: ProductActions = {
  create: createProductAction,
  update: updateProductAction,
  setActive: setProductActiveAction,
  remove: deleteProductAction,
};

export default async function ProductsScreen() {
  if (!hasSupabaseEnv()) {
    return <ProductsView view={productsView(SAMPLE_PRODUCTS)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const products = await listProducts(ctx);
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  return <ProductsView view={productsView(products)} actions={canEdit ? ACTIONS : undefined} />;
}
