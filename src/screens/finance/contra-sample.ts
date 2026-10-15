import type { ContraLine, ContraRow } from '@/lib/finance/contras';

/**
 * The contra entries of an invented workspace (Rimba Ventures Sdn Bhd), shown by Contra Entries when no database
 * is connected. Each invoice side and each bill side adds up to its entry's amount, as posting asks.
 */

const line = (id: string, kind: ContraLine['kind'], no: string, amount: number): ContraLine => ({
  id: `sample-contra-line-${id}`,
  kind,
  document_id: `sample-${kind}-${no}`,
  document_no: no,
  amount,
});

export const SAMPLE_CONTRAS: ContraRow[] = [
  {
    id: 'sample-contra-6',
    contra_no: null,
    contra_date: '2026-10-08',
    contact_id: 'sample-contact-tan',
    contact_name: 'Tan & Sons Trading',
    amount: 2750,
    reference: null,
    notes: 'Waiting for their confirmation',
    status: 'draft',
    posted_at: null,
    voided_at: null,
    invoices: [line('6a', 'invoice', 'INV-0031', 2750)],
    bills: [line('6b', 'bill', 'BILL-0019', 2750)],
  },
  {
    id: 'sample-contra-5',
    contra_no: 'CT-0005',
    contra_date: '2026-10-06',
    contact_id: 'sample-contact-lim',
    contact_name: 'Lim Hardware',
    amount: 1800,
    reference: 'Letter LH/10/26',
    notes: null,
    status: 'posted',
    posted_at: '2026-10-06T03:00:00Z',
    voided_at: null,
    invoices: [line('5a', 'invoice', 'INV-0027', 1200), line('5b', 'invoice', 'INV-0029', 600)],
    bills: [line('5c', 'bill', 'BILL-0017', 1800)],
  },
  {
    id: 'sample-contra-4',
    contra_no: 'CT-0004',
    contra_date: '2026-09-28',
    contact_id: 'sample-contact-maju',
    contact_name: 'Syarikat Maju Jaya',
    amount: 3200,
    reference: 'Email of 27 Sep',
    notes: null,
    status: 'posted',
    posted_at: '2026-09-28T03:00:00Z',
    voided_at: null,
    invoices: [line('4a', 'invoice', 'INV-0022', 3200)],
    bills: [line('4b', 'bill', 'BILL-0012', 1700), line('4c', 'bill', 'BILL-0014', 1500)],
  },
  {
    id: 'sample-contra-3',
    contra_no: 'CT-0003',
    contra_date: '2026-09-15',
    contact_id: 'sample-contact-hasan',
    contact_name: 'Kedai Runcit Hasan',
    amount: 960,
    reference: null,
    notes: 'Entered against the wrong bill',
    status: 'void',
    posted_at: '2026-09-15T03:00:00Z',
    voided_at: '2026-09-16T03:00:00Z',
    invoices: [line('3a', 'invoice', 'INV-0018', 960)],
    bills: [line('3b', 'bill', 'BILL-0009', 960)],
  },
];
