'use client';

import { AllocationFormCard, type RecordPayment } from '@/components/finance/allocation-form-card';
import type { FxRateLookup } from '@/components/finance/movement-rate-fields';
import type { FinanceAccount } from '@/lib/finance/money';
import { PAYMENT_IN_KIND, type ReceivableInvoice, currencyListNotes } from '@/lib/finance/receipt-form';

/**
 * Records a payment received from one customer, split across their open
 * invoices. It is posted at once: there is no scheduling. Used on Payments
 * In, and on Invoices from an invoice's Record payment choice (`preselect`).
 * The card itself is the one payments out use; the rules are in
 * src/lib/finance/receipt-form.ts.
 */
export function ReceiptFormCard({
  receivable,
  accounts,
  today,
  preselect,
  record,
  fxRate,
  onClose,
}: {
  /** Every invoice that can still take a payment, from `receivableInvoices`. */
  receivable: ReceivableInvoice[];
  accounts: FinanceAccount[];
  /** The default payment date, YYYY-MM-DD. */
  today: string;
  /** Opened from an invoice row: that customer chosen and that invoice ticked. */
  preselect?: { customerId: string; invoiceId: string };
  record: RecordPayment;
  /** Bank Negara's selling rate, for a payment into an account in another currency (stage 5b). */
  fxRate?: FxRateLookup;
  onClose: () => void;
}) {
  return (
    <AllocationFormCard
      kind={PAYMENT_IN_KIND}
      documents={receivable}
      accounts={accounts}
      today={today}
      preselect={preselect ? { partyId: preselect.customerId, documentId: preselect.invoiceId } : undefined}
      notes={(form) => currencyListNotes(form, receivable)}
      record={record}
      fxRate={fxRate}
      onClose={onClose}
    />
  );
}
