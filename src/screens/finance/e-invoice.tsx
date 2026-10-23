import { BadgeCheck } from 'lucide-react';
import { PlaceholderPage } from '@/components/app/placeholder-page';

/**
 * Sending invoices to LHDN MyInvois is not built yet. Until it is, a posted
 * invoice's e-Invois card records the status and UUID from the MyInvois portal.
 */
export default function EInvoiceScreen() {
  return (
    <PlaceholderPage
      title="e-Invoice LHDN"
      subtitle="Sending invoices to LHDN MyInvois from here is on the way. For now, submit them on the MyInvois portal and record each one's status and UUID on the invoice, under e-Invois."
      icon={BadgeCheck}
    />
  );
}
