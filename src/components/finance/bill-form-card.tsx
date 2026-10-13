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
  withCategory,
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
  initial,
  draftOnly,
  suppliers,
  products,
  orders,
  categories,
  defaultCategoryId,
  rows,
  today,
  actions,
  onClose,
}: {
  /** The draft being changed, with its lines; absent for a new bill. */
  editing?: BillDetail;
  /** What a new bill's form starts with, in place of an empty one: a receipt's details. Ignored when `editing`. */
  initial?: BillForm;
  /** True when the form may only save a draft: it has no button that posts. A bill made from a receipt. */
  draftOnly?: boolean;
  /** Active suppliers, by name. */
  suppliers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  /**
   * Purchase orders to choose from: the approved ones, and any the drafts are linked to. Absent, the form has
   * no picker (and leaves a draft's link alone only if the caller sends no `purchase_order_id`).
   */
  orders?: BillOrderOption[];
  /**
   * The active expense categories to choose from. Absent, the form has no category picker. A draft whose
   * category has since been archived still shows it.
   */
  categories?: { id: string; name: string }[];
  /** The category a new bill starts in: the one behind the workspace's purchases account. */
  defaultCategoryId?: string;
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
  const categoryChoice: PartyChoice<BillForm> | undefined = categories && {
    label: 'Category',
    noneLabel: 'Default category',
    options: (form) => {
      // A draft's own category stays on offer even once archived, so saving does not move it.
      const current = form.category_id;
      const known = current === '' || categories.some((c) => c.id === current);
      const own = known ? [] : [{ id: current, name: editing?.category_id === current ? (editing.category_name ?? 'Archived category') : 'Archived category' }];
      return [...categories, ...own].map((c) => ({ id: c.id, label: c.name }));
    },
    get: (form) => form.category_id,
    set: (form, id) => withCategory(form, id, defaultCategoryId),
    notes: () => [],
  };
  return (
    <DocumentFormCard
      kind={BILL_FORM_KIND}
      initial={() => (editing ? billFormFromDetail(editing) : (initial ?? newBillForm(today, 'new-0', defaultCategoryId ?? '')))}
      // A supplier archived since the draft was saved is still this bill's supplier.
      parties={withCurrentParty(suppliers, editing && { id: editing.supplier_id, name: editing.supplier_name })}
      products={products}
      partyChoice={partyChoice}
      extraChoices={categoryChoice ? [categoryChoice] : undefined}
      draftOnly={draftOnly}
      actions={actions}
      onClose={onClose}
    />
  );
}
