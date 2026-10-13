/**
 * Sample receipts (Rimba Ventures Sdn Bhd), shown on the Receipts Inbox when
 * there is no database. Raw rows in the shape the data layer reads, so the
 * screen runs them through the same builders as live data. None has a file.
 */
import type { InboxReceiptRow, InboxReceiptStatus, InboxReceiptType } from '@/lib/finance/receipts';

const TYPES: Record<string, InboxReceiptType> = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

const receipt = (
  n: number,
  uploaded: string,
  extension: 'jpg' | 'png' | 'pdf',
  vendor: string | null,
  amount: number | null,
  status: InboxReceiptStatus,
  document: { kind: 'expense' | 'bill'; label: string } | null,
  extraction_failed = false,
  readByModel = false,
): InboxReceiptRow => ({
  id: `sample-receipt-${n}`,
  file_name: `receipt-${String(n).padStart(4, '0')}.${extension}`,
  mime_type: TYPES[extension],
  size_bytes: 150_000 + n * 1_000,
  has_file: false,
  vendor,
  receipt_date: amount === null ? null : uploaded,
  amount,
  sst_amount: amount === null ? null : 0,
  status,
  document_kind: document?.kind ?? null,
  document_label: document?.label ?? null,
  extraction_failed,
  extracted_at: readByModel ? `${uploaded}T09:00:05+00:00` : null,
  created_at: `${uploaded}T09:00:00+00:00`,
});

/** Newest first: five matched, two to review (one a model read, one it could not) and one unmatched. */
export const SAMPLE_INBOX_RECEIPTS: InboxReceiptRow[] = [
  receipt(42, '2026-10-03', 'jpg', 'Shell', 142.5, 'matched', { kind: 'expense', label: 'Travel' }),
  receipt(41, '2026-10-02', 'jpg', 'TNB', 318.2, 'matched', { kind: 'expense', label: 'Utilities' }),
  receipt(40, '2026-10-02', 'png', 'Grab', 36, 'matched', { kind: 'expense', label: 'Travel' }),
  receipt(39, '2026-10-01', 'jpg', 'Lazada', 249.9, 'review', null, false, true),
  receipt(38, '2026-09-30', 'pdf', 'Printhub', 310, 'matched', { kind: 'bill', label: 'BILL-0006' }),
  receipt(37, '2026-09-29', 'jpg', null, null, 'review', null, true),
  receipt(36, '2026-09-28', 'pdf', 'Nusantara Logistics', 540, 'unmatched', null),
  receipt(35, '2026-09-27', 'jpg', 'Lim Hardware', 88.6, 'matched', { kind: 'expense', label: 'Supplies' }),
];
