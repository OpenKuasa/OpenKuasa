'use client';

import { DocumentFormCard } from '@/components/finance/document-form-card';
import type { FinanceContact } from '@/lib/finance/contacts';
import { withCurrentParty } from '@/lib/finance/document-form';
import type { FxDefault } from '@/lib/finance/fx-rates';
import type { FinanceProduct } from '@/lib/finance/products';
import { PURCHASE_ORDER_FORM_KIND, newPurchaseOrderForm, purchaseOrderFormFromDetail } from '@/lib/finance/purchase-order-form';
import type { PurchaseOrderDetail, SaveAndSubmitPurchaseOrderResult } from '@/lib/finance/purchase-orders';
import type { FinResult } from '@/lib/finance/result';

export type PurchaseOrderFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Saves the draft, then submits it for approval. The shared card calls its second button's action `saveAndPost`. */
  saveAndPost: (input: unknown) => Promise<SaveAndSubmitPurchaseOrderResult>;
  /** Bank Negara's rate for a currency and a date, read with the person's session; absent, none is offered. */
  fxRate?: (input: unknown) => Promise<FinResult<FxDefault | null>>;
};

/**
 * A new purchase order, or a draft being changed (`editing`). The card itself is
 * the one bills, invoices, quotations and RFQs use; the rules are in
 * src/lib/finance/purchase-order-form.ts.
 */
export function PurchaseOrderFormCard({
  editing,
  suppliers,
  products,
  today,
  actions,
  onClose,
}: {
  /** The draft being changed, with its lines; absent for a new order. */
  editing?: PurchaseOrderDetail;
  /** Active suppliers, by name. */
  suppliers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  /** The default order date, YYYY-MM-DD. */
  today: string;
  actions: PurchaseOrderFormActions;
  onClose: () => void;
}) {
  return (
    <DocumentFormCard
      kind={PURCHASE_ORDER_FORM_KIND}
      initial={() => (editing ? purchaseOrderFormFromDetail(editing) : newPurchaseOrderForm(today, 'new-0'))}
      // A supplier archived since the draft was saved is still this order's supplier.
      parties={withCurrentParty(suppliers, editing && { id: editing.supplier_id, name: editing.supplier_name })}
      products={products}
      actions={actions}
      onClose={onClose}
    />
  );
}
