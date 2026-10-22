import type { AuditEntityType, AuditEntry } from '@/lib/finance/audit';

/** The day the sample books are read as of; the log starts on 23 Oct 2026. */
export const SAMPLE_TODAY = '2026-10-23';

function entry(
  n: number,
  createdAt: string,
  actorName: string,
  event: string,
  action: string,
  entityType: AuditEntityType,
  target: string | null,
  extra: Partial<AuditEntry['details']> = {},
): AuditEntry {
  return {
    id: `sample-${n}`,
    createdAt,
    actorName,
    action,
    target,
    entityType,
    entityId: null,
    details: { event, ...extra },
  };
}

/**
 * Rimba Ventures Sdn Bhd, newest first. Times are UTC; the screen shows them in Malaysia time. Each row is what the
 * database writes for that event (20261125120000): the same sentence, event, target and detail keys.
 */
export const SAMPLE_AUDIT_ENTRIES: AuditEntry[] = [
  entry(1, '2026-10-23T06:20:00Z', 'Saudara', 'posted', 'Posted an invoice', 'finance_invoice', 'INV-1042', { number: 'INV-1042', party: 'Aisyah Trading', amount: 1240, currency: 'MYR', amount_myr: 1240 }),
  entry(2, '2026-10-23T03:05:00Z', 'Aisyah', 'approved', 'Approved an expense', 'finance_expense', 'TNB', { party: 'TNB', amount: 200 }),
  // A draft has no number: its target is the customer.
  entry(3, '2026-10-22T08:40:00Z', 'Faiz', 'deleted', 'Deleted a draft quotation', 'finance_quotation', 'Lim Hardware', { party: 'Lim Hardware' }),
  entry(4, '2026-10-22T02:12:00Z', 'Saudara', 'posted', 'Posted a supplier bill', 'finance_supplier_bill', 'BILL-088', { number: 'BILL-088', party: 'Lim Hardware', amount: 2300, currency: 'MYR', amount_myr: 2300 }),
  entry(5, '2026-10-21T09:30:00Z', 'Aisyah', 'voided', 'Voided an invoice', 'finance_invoice', 'INV-1038', { number: 'INV-1038', party: 'Nusantara Logistics', amount: 860, currency: 'MYR', amount_myr: 860 }),
  entry(6, '2026-10-20T01:48:00Z', 'Faiz', 'recorded', 'Recorded money in', 'finance_payment', 'OR-2210', { number: 'OR-2210', party: 'Aisyah Trading', direction: 'in', amount: 500, currency: 'USD', amount_myr: 2350 }),
  entry(7, '2026-10-15T07:22:00Z', 'Saudara', 'posted', 'Posted a journal', 'finance_journal', 'JV-031', { number: 'JV-031' }),
  entry(8, '2026-10-08T05:07:00Z', 'Aisyah', 'deleted', 'Deleted a draft invoice', 'finance_invoice', 'Rimba Foods', { party: 'Rimba Foods' }),
  entry(9, '2026-10-03T01:15:00Z', 'Saudara', 'posted', 'Posted an invoice', 'finance_invoice', 'INV-1041', { number: 'INV-1041', party: 'Rimba Foods', amount: 3180, currency: 'MYR', amount_myr: 3180 }),
  entry(10, '2026-10-02T08:02:00Z', 'Nurul', 'voided', 'Voided a supplier bill', 'finance_supplier_bill', 'BILL-086', { number: 'BILL-086', party: 'Nusantara Logistics', amount: 410, currency: 'MYR', amount_myr: 410 }),
];
