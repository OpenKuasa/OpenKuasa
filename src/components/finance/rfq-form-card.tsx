'use client';

import { DocumentFormCard } from '@/components/finance/document-form-card';
import type { FinanceContact } from '@/lib/finance/contacts';
import { withCurrentParty } from '@/lib/finance/document-form';
import type { FinanceProduct } from '@/lib/finance/products';
import { RFQ_FORM_KIND, newRfqForm, rfqFormFromDetail } from '@/lib/finance/rfq-form';
import type { RfqDetail, SaveAndSendRfqResult } from '@/lib/finance/rfqs';
import type { FinResult } from '@/lib/finance/result';

export type RfqFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Saves the draft, then marks it as sent. The shared card calls its second button's action `saveAndPost`. */
  saveAndPost: (input: unknown) => Promise<SaveAndSendRfqResult>;
};

/**
 * A new RFQ, or a draft being changed (`editing`). The card itself is the one
 * bills, invoices and quotations use; the rules are in
 * src/lib/finance/rfq-form.ts.
 */
export function RfqFormCard({
  editing,
  suppliers,
  products,
  today,
  actions,
  onClose,
}: {
  /** The draft being changed, with its lines; absent for a new RFQ. */
  editing?: RfqDetail;
  /** Active suppliers, by name. */
  suppliers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  /** The default RFQ date, YYYY-MM-DD. */
  today: string;
  actions: RfqFormActions;
  onClose: () => void;
}) {
  return (
    <DocumentFormCard
      kind={RFQ_FORM_KIND}
      initial={() => (editing ? rfqFormFromDetail(editing) : newRfqForm(today, 'new-0'))}
      // A supplier archived since the draft was saved is still this RFQ's supplier.
      parties={withCurrentParty(suppliers, editing && { id: editing.supplier_id, name: editing.supplier_name })}
      products={products}
      actions={actions}
      onClose={onClose}
    />
  );
}
