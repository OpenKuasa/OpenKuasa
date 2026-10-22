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

/** Rimba Ventures Sdn Bhd, newest first. Times are UTC; the screen shows them in Malaysia time. */
export const SAMPLE_AUDIT_ENTRIES: AuditEntry[] = [
  entry(1, '2026-10-23T06:20:00Z', 'Saudara', 'posted', 'Posted invoice', 'finance_invoice', 'INV-1042', { party: 'Aisyah Trading', amount: 1240, currency: 'MYR' }),
  entry(2, '2026-10-23T03:05:00Z', 'Aisyah', 'posted', 'Posted expense', 'finance_expense', 'EXP-320', { party: 'TNB', amount: 200, currency: 'MYR' }),
  entry(3, '2026-10-22T08:40:00Z', 'Faiz', 'draft_deleted', 'Deleted draft quotation', 'finance_quotation', 'QT-214', { party: 'Lim Hardware' }),
  entry(4, '2026-10-22T02:12:00Z', 'Saudara', 'posted', 'Posted supplier bill', 'finance_supplier_bill', 'BILL-088', { party: 'Lim Hardware', amount: 2300, currency: 'MYR' }),
  entry(5, '2026-10-21T09:30:00Z', 'Aisyah', 'voided', 'Voided invoice', 'finance_invoice', 'INV-1038', { party: 'Nusantara Logistics', amount: 860, currency: 'MYR' }),
  entry(6, '2026-10-20T01:48:00Z', 'Faiz', 'posted', 'Posted payment', 'finance_payment', 'PAY-2210', { party: 'Aisyah Trading', amount: 500, currency: 'USD', amount_myr: 2350 }),
  entry(7, '2026-10-15T07:22:00Z', 'Saudara', 'posted', 'Posted journal', 'finance_journal', 'JV-031', { amount: 75, currency: 'MYR' }),
  entry(8, '2026-10-08T05:07:00Z', 'Aisyah', 'draft_deleted', 'Deleted draft expense', 'finance_expense', 'EXP-317', { amount: 95, currency: 'MYR' }),
  entry(9, '2026-10-03T01:15:00Z', 'Saudara', 'posted', 'Posted invoice', 'finance_invoice', 'INV-1041', { party: 'Rimba Foods', amount: 3180, currency: 'MYR' }),
  entry(10, '2026-10-02T08:02:00Z', 'Nurul', 'voided', 'Voided supplier bill', 'finance_supplier_bill', 'BILL-086', { party: 'Nusantara Logistics', amount: 410, currency: 'MYR' }),
];
