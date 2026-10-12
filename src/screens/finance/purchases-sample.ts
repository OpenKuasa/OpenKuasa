import type { PurchaseOrderListRow, PurchaseOrderStatus } from '@/lib/finance/purchase-orders';
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

const order = (
  n: number,
  supplier_name: string,
  status: PurchaseOrderStatus,
  over: Partial<PurchaseOrderListRow>,
): PurchaseOrderListRow => ({
  id: `sample-po-${n}`,
  po_no: status === 'draft' ? null : `PO-${String(n).padStart(4, '0')}`,
  supplier_id: supplier_name,
  supplier_name,
  rfq_id: null,
  rfq_no: null,
  po_date: '2026-10-08',
  expected_date: null,
  status,
  created_by: 'sample-user',
  submitted_by: status === 'draft' ? null : 'sample-user',
  rejection_reason: null,
  payment_terms_days: 30,
  delivery_address: null,
  total: 0,
  delivery: 'pending',
  received_total: 0,
  billed_total: 0,
  over_billed: false,
  billed_over_received: false,
  ...over,
});

/**
 * Newest first, as the real list is: a draft, one awaiting approval, and one
 * approved and partly delivered, with a bill over what has arrived.
 */
export const SAMPLE_PURCHASE_ORDERS: PurchaseOrderListRow[] = [
  order(9, 'Kopi Hulu Supplies', 'draft', { po_date: '2026-10-10', expected_date: '2026-10-24', total: 2480 }),
  order(8, 'Seri Packaging Sdn Bhd', 'pending_approval', { po_date: '2026-10-07', expected_date: '2026-10-21', total: 3180 }),
  order(7, 'Bunga Raya Stationery', 'approved', {
    po_date: '2026-10-02',
    expected_date: '2026-10-16',
    rfq_id: 'sample-rfq-12',
    rfq_no: 'RFQ-0012',
    total: 1860,
    delivery: 'partial',
    received_total: 930,
    billed_total: 1400,
    billed_over_received: true,
  }),
];
