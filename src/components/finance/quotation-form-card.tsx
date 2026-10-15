'use client';

import { DocumentFormCard } from '@/components/finance/document-form-card';
import type { FinanceContact } from '@/lib/finance/contacts';
import { withCurrentParty } from '@/lib/finance/document-form';
import type { FxDefault } from '@/lib/finance/fx-rates';
import type { FinanceProduct } from '@/lib/finance/products';
import { QUOTATION_FORM_KIND, newQuotationForm, quotationFormFromDetail } from '@/lib/finance/quotation-form';
import type { QuotationDetail, SaveAndSendQuotationResult } from '@/lib/finance/quotations';
import type { FinResult } from '@/lib/finance/result';

export type QuotationFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Saves the draft, then marks it as sent. The shared card calls its second button's action `saveAndPost`. */
  saveAndPost: (input: unknown) => Promise<SaveAndSendQuotationResult>;
  /** Bank Negara's rate for a currency and a date, read with the person's session. */
  fxRate: (input: unknown) => Promise<FinResult<FxDefault | null>>;
};

/**
 * A new quotation, or a draft being changed (`editing`). The card itself is
 * the one bills and invoices use; the rules are in
 * src/lib/finance/quotation-form.ts.
 */
export function QuotationFormCard({
  editing,
  customers,
  products,
  today,
  actions,
  onClose,
}: {
  /** The draft being changed, with its lines; absent for a new quotation. */
  editing?: QuotationDetail;
  /** Active customers, by name. */
  customers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  /** The default quotation date, YYYY-MM-DD. */
  today: string;
  actions: QuotationFormActions;
  onClose: () => void;
}) {
  return (
    <DocumentFormCard
      kind={QUOTATION_FORM_KIND}
      initial={() => (editing ? quotationFormFromDetail(editing) : newQuotationForm(today, 'new-0'))}
      // A customer archived since the draft was saved is still this quotation's customer.
      parties={withCurrentParty(customers, editing && { id: editing.customer_id, name: editing.customer_name })}
      products={products}
      actions={actions}
      onClose={onClose}
    />
  );
}
