'use client';

import { DocumentFormCard } from '@/components/finance/document-form-card';
import { BILL_FORM_KIND, billFormFromDetail, newBillForm } from '@/lib/finance/bill-form';
import type { BillDetail, SaveAndPostResult } from '@/lib/finance/bills';
import type { FinanceContact } from '@/lib/finance/contacts';
import type { FinanceProduct } from '@/lib/finance/products';
import type { FinResult } from '@/lib/finance/result';

export type BillFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  saveAndPost: (input: unknown) => Promise<SaveAndPostResult>;
};

/**
 * A new bill, or a draft being changed (`editing`). The card itself is the
 * one invoices use; the rules are in src/lib/finance/bill-form.ts.
 */
export function BillFormCard({
  editing,
  suppliers,
  products,
  today,
  actions,
  onClose,
}: {
  /** The draft being changed, with its lines; absent for a new bill. */
  editing?: BillDetail;
  /** Active suppliers, by name. */
  suppliers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  /** The default bill date, YYYY-MM-DD. */
  today: string;
  actions: BillFormActions;
  onClose: () => void;
}) {
  return (
    <DocumentFormCard
      kind={BILL_FORM_KIND}
      initial={() => (editing ? billFormFromDetail(editing) : newBillForm(today, 'new-0'))}
      // A supplier archived since the draft was saved is still this bill's supplier.
      parties={
        editing && !suppliers.some((s) => s.id === editing.supplier_id)
          ? [{ id: editing.supplier_id, name: editing.supplier_name, payment_terms_days: 0 }, ...suppliers]
          : suppliers
      }
      products={products}
      actions={actions}
      onClose={onClose}
    />
  );
}
