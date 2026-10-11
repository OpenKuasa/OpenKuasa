'use client';

import { DocumentFormCard } from '@/components/finance/document-form-card';
import type { FinanceContact } from '@/lib/finance/contacts';
import { INVOICE_FORM_KIND, invoiceFormFromDetail, newInvoiceForm } from '@/lib/finance/invoice-form';
import type { InvoiceDetail, SaveAndPostInvoiceResult } from '@/lib/finance/invoices';
import type { FinanceProduct } from '@/lib/finance/products';
import type { FinResult } from '@/lib/finance/result';

export type InvoiceFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  saveAndPost: (input: unknown) => Promise<SaveAndPostInvoiceResult>;
};

/**
 * A new invoice, or a draft being changed (`editing`). The card itself is the
 * one bills use; the rules are in src/lib/finance/invoice-form.ts.
 */
export function InvoiceFormCard({
  editing,
  customers,
  products,
  today,
  actions,
  onClose,
}: {
  /** The draft being changed, with its lines; absent for a new invoice. */
  editing?: InvoiceDetail;
  /** Active customers, by name. */
  customers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  /** The default invoice date, YYYY-MM-DD. */
  today: string;
  actions: InvoiceFormActions;
  onClose: () => void;
}) {
  return (
    <DocumentFormCard
      kind={INVOICE_FORM_KIND}
      initial={() => (editing ? invoiceFormFromDetail(editing) : newInvoiceForm(today, 'new-0'))}
      // A customer archived since the draft was saved is still this invoice's customer.
      parties={
        editing && !customers.some((c) => c.id === editing.customer_id)
          ? [{ id: editing.customer_id, name: editing.customer_name, payment_terms_days: 0 }, ...customers]
          : customers
      }
      products={products}
      actions={actions}
      onClose={onClose}
    />
  );
}
