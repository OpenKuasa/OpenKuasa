import type { RfqListRow, RfqStatus } from '@/lib/finance/rfqs';

const rfq = (
  n: number,
  supplier_name: string,
  rfq_date: string,
  reply_by: string | null,
  status: RfqStatus,
  line_count: number,
  total: number,
): RfqListRow => ({
  id: `sample-rfq-${n}`,
  rfq_no: status === 'draft' ? null : `RFQ-${String(n).padStart(4, '0')}`,
  supplier_id: supplier_name,
  supplier_name,
  rfq_date,
  reply_by,
  supplier_ref: status === 'quoted' ? `QUO/${n}` : null,
  status,
  line_count,
  total,
  fully_priced: status === 'quoted',
  purchase_order_id: null,
  purchase_order_no: null,
});

/** Newest first, as the real list is: one RFQ for each status a person can see on a first visit. */
export const SAMPLE_RFQS: RfqListRow[] = [
  rfq(14, 'Kopi Hulu Supplies', '2026-10-09', '2026-10-16', 'draft', 3, 0),
  rfq(13, 'Seri Packaging Sdn Bhd', '2026-10-05', '2026-10-12', 'sent', 2, 0),
  rfq(12, 'Bunga Raya Stationery', '2026-09-28', '2026-10-05', 'quoted', 4, 1860),
];
