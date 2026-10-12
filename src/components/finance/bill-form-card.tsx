'use client';

import { DocumentFormCard, type PartyChoice } from '@/components/finance/document-form-card';
import {
  BILL_FORM_KIND,
  type BillForm,
  type BillOrderOption,
  billFormFromDetail,
  billOrderWarnings,
  newBillForm,
  ordersForSupplier,
  ownCountedTotal,
} from '@/lib/finance/bill-form';
import { withCurrentParty } from '@/lib/finance/document-form';
import type { BillDetail, BillListRow, SaveAndPostResult } from '@/lib/finance/bills';
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
  orders,
  rows,
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
  /**
   * Purchase orders to choose from: the approved ones, and any the drafts are linked to. Absent, the form has
   * no picker (and leaves a draft's link alone only if the caller sends no `purchase_order_id`).
   */
  orders?: BillOrderOption[];
  /** The bills as listed, for what this bill already counts toward its order. */
  rows?: BillListRow[];
  /** The default bill date, YYYY-MM-DD. */
  today: string;
  actions: BillFormActions;
  onClose: () => void;
}) {
  const partyChoice: PartyChoice<BillForm> | undefined = orders && {
    label: 'Purchase order',
    noneLabel: 'No purchase order',
    options: (form) => ordersForSupplier(orders, form.supplier_id, form.purchase_order_id),
    get: (form) => form.purchase_order_id,
    set: (form, id) => ({ ...form, purchase_order_id: id }),
    notes: (form) => {
      const chosen = orders.find((o) => o.id === form.purchase_order_id && o.supplier_id === form.supplier_id) ?? null;
      // The bill's own saved total is already in the order's billed figure; the saved row for the form's current id says how much.
      const own = ownCountedTotal(rows ?? (editing ? [editing] : []), form.id, chosen?.id ?? '');
      return billOrderWarnings(form.lines, chosen, own);
    },
  };
  return (
    <DocumentFormCard
      kind={BILL_FORM_KIND}
      initial={() => (editing ? billFormFromDetail(editing) : newBillForm(today, 'new-0'))}
      // A supplier archived since the draft was saved is still this bill's supplier.
      parties={withCurrentParty(suppliers, editing && { id: editing.supplier_id, name: editing.supplier_name })}
      products={products}
      partyChoice={partyChoice}
      actions={actions}
      onClose={onClose}
    />
  );
}
