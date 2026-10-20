'use client';

import { AllocationFormCard, type RecordPayment } from '@/components/finance/allocation-form-card';
import type { FxRateLookup } from '@/components/finance/movement-rate-fields';
import type { FinanceAccount } from '@/lib/finance/money';
import { PAYMENT_OUT_KIND, type PayableBill } from '@/lib/finance/payment-form';
import { type OrderBilling, orderNotesForBills } from '@/lib/finance/purchase-views';

export type { RecordPayment } from '@/components/finance/allocation-form-card';

/**
 * Records a payment to one supplier, split across their open bills, paid now
 * or scheduled. Used on Payments Out, and on Supplier Bills from a bill's Pay
 * choice (`preselect`). The card itself is the one payments in use; the rules
 * are in src/lib/finance/payment-form.ts.
 */
export function PaymentFormCard({
  payable,
  accounts,
  today,
  preselect,
  orders = [],
  record,
  fxRate,
  onClose,
}: {
  /** Every bill that can still take a payment, from `payableBills`. */
  payable: PayableBill[];
  accounts: FinanceAccount[];
  /** The default payment date, YYYY-MM-DD. */
  today: string;
  /** Opened from a bill row: that supplier chosen and that bill ticked. */
  preselect?: { supplierId: string; billId: string };
  /** The purchase orders the bills may be raised against, to advise on the bills ticked. */
  orders?: OrderBilling[];
  record: RecordPayment;
  /** Bank Negara's selling rate, for a payment from an account in another currency (stage 5b). */
  fxRate?: FxRateLookup;
  onClose: () => void;
}) {
  return (
    <AllocationFormCard
      kind={PAYMENT_OUT_KIND}
      documents={payable}
      accounts={accounts}
      today={today}
      preselect={preselect ? { partyId: preselect.supplierId, documentId: preselect.billId } : undefined}
      notes={(form) =>
        orderNotesForBills(
          payable.filter((b) => b.id in form.amounts),
          orders,
        )
      }
      record={record}
      fxRate={fxRate}
      onClose={onClose}
    />
  );
}
