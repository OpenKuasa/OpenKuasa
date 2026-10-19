import { describe, expect, it } from 'vitest';
import { purchaseOrderPrint, type PrintablePurchaseOrder } from '@/lib/finance/purchase-order-print';
import type { Letterhead } from '@/lib/people/letterhead-data';

const RAISER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

const order = (o: Partial<PrintablePurchaseOrder> = {}): PrintablePurchaseOrder => ({
  id: '33333333-3333-4333-8333-333333333333',
  po_no: 'PO-0001',
  supplier_id: '44444444-4444-4444-8444-444444444444',
  supplier_name: 'Kopi Hulu Supplies Sdn Bhd',
  rfq_id: null,
  rfq_no: null,
  po_date: '2026-10-14',
  expected_date: null,
  status: 'approved',
  created_by: RAISER,
  submitted_by: RAISER,
  rejection_reason: null,
  payment_terms_days: null,
  delivery_address: null,
  total: 1723.7,
  delivery: 'pending',
  received_total: 0,
  billed_total: 0,
  over_billed: false,
  billed_over_received: false,
  currency: 'MYR',
  fx_rate: 1,
  fx_rate_text: '1.0000000000',
  fx_rate_source: null,
  fx_rate_date: null,
  total_myr: 1723.7,
  subtotal: 1697.5,
  sst_total: 26.2,
  notes: null,
  lines: [],
  // 3:42 pm and 4:10 pm in Kuala Lumpur (UTC+8).
  submitted_at: '2026-10-14T07:42:00Z',
  approved_by: APPROVER,
  approved_at: '2026-10-14T08:10:00Z',
  supplier: { name: 'Kopi Hulu Supplies Sdn Bhd', ssm_no: '201901000123', phone: '03-1234 5678', email: 'sales@kopihulu.my' },
  people: {
    [RAISER]: { full_name: 'Aisyah Rahman', email: 'aisyah@rimba.my', job_title: 'Purchasing Executive', role: 'member' },
    [APPROVER]: { full_name: 'Hafiz Wasabie', email: 'hafiz@rimba.my', job_title: null, role: 'owner' },
  },
  ...o,
});

const head: Letterhead = {
  name: 'Rimba Ventures Sdn Bhd',
  registration_no: '202301012345',
  address: '12 Jalan Kopi',
  city: 'Kuala Lumpur',
  state: 'W.P. Kuala Lumpur',
  postcode: '50450',
  logo_path: null,
  isDemo: false,
};

describe('a printed purchase order', () => {
  it('is headed with its number and date, and addressed to the supplier with their SSM no., phone and email', () => {
    const p = purchaseOrderPrint(order(), head);
    expect(p.po_no).toBe('PO-0001');
    expect(p.date).toBe('14 Oct 2026');
    expect(p.to).toEqual(['Kopi Hulu Supplies Sdn Bhd', 'SSM 201901000123', '03-1234 5678 · sales@kopihulu.my']);
  });

  it('leaves out the SSM no., phone or email the supplier does not have', () => {
    const p = purchaseOrderPrint(order({ supplier: { name: 'Kedai Ah Seng', ssm_no: null, phone: ' ', email: 'ahseng@mail.my' } }), head);
    expect(p.to).toEqual(['Kedai Ah Seng', 'ahseng@mail.my']);
  });

  it("delivers to the order's own address, else to the workspace's, else says nothing", () => {
    expect(purchaseOrderPrint(order({ delivery_address: 'Lot 5, Gudang Shah Alam' }), head).deliver_to).toBe('Lot 5, Gudang Shah Alam');
    expect(purchaseOrderPrint(order(), head).deliver_to).toBe('12 Jalan Kopi, 50450 Kuala Lumpur, W.P. Kuala Lumpur');
    const noAddress = { ...head, address: null, city: null, state: null, postcode: null };
    expect(purchaseOrderPrint(order(), noAddress).deliver_to).toBeNull();
    expect(purchaseOrderPrint(order(), null).deliver_to).toBeNull();
  });

  it('gives the expected delivery date, the payment terms and our RFQ, each only when there is one', () => {
    const full = order({ expected_date: '2026-10-21', payment_terms_days: 30, rfq_id: '55555555-5555-4555-8555-555555555555', rfq_no: 'RFQ-0003' });
    expect(purchaseOrderPrint(full, head).details).toEqual([
      { label: 'Expected delivery', value: '21 Oct 2026' },
      { label: 'Payment terms', value: '30 days' },
      { label: 'Our RFQ', value: 'RFQ-0003' },
    ]);
    expect(purchaseOrderPrint(order(), head).details).toEqual([]);
  });

  it('calls terms of 0 days cash on delivery', () => {
    expect(purchaseOrderPrint(order({ payment_terms_days: 0 }), head).details).toEqual([{ label: 'Payment terms', value: 'Cash on delivery' }]);
  });

  it('numbers the lines, with the unit and pack size, a unit price to 4 decimals and the SST rate, then the totals', () => {
    const lines: PrintablePurchaseOrder['lines'] = [
      { id: 'a1', product_id: null, description: 'Arabica beans', quantity: 20, uom: 'kg', pack_size: null, unit_price: 68.5, sst_rate: 0, amount: 1370, sst_amount: 0, received_quantity: 0 },
      { id: 'a2', product_id: null, description: 'Paper cups', quantity: 1000, uom: 'pcs', pack_size: '50 per sleeve', unit_price: 0.3275, sst_rate: 8, amount: 327.5, sst_amount: 26.2, received_quantity: 0 },
    ];
    const p = purchaseOrderPrint(order({ lines }), head);
    expect(p.lines).toEqual([
      { no: 1, description: 'Arabica beans', quantity: '20', unit: 'kg', unit_price: 'RM 68.50', sst: '—', amount: 'RM 1,370.00' },
      { no: 2, description: 'Paper cups', quantity: '1,000', unit: 'pcs (50 per sleeve)', unit_price: 'RM 0.3275', sst: '8%', amount: 'RM 327.50' },
    ]);
    expect(p.totals).toEqual([
      { label: 'Subtotal', value: 'RM 1,697.50' },
      { label: 'SST', value: 'RM 26.20' },
      { label: 'Total', value: 'RM 1,723.70' },
    ]);
  });

  it('carries the notes, if any, and asks the supplier to quote the PO number on their delivery order and invoice', () => {
    const p = purchaseOrderPrint(order({ notes: 'Deliver before noon.' }), head);
    expect(p.notes).toBe('Deliver before noon.');
    expect(p.quote_line).toBe('Please quote PO-0001 on your delivery order and invoice.');
    expect(purchaseOrderPrint(order({ notes: '  ' }), head).notes).toBeNull();
  });
});

describe('the signature blocks', () => {
  it('name who submitted the order and who approved it, with their job title or role, and when, in Malaysian time', () => {
    expect(purchaseOrderPrint(order(), head).signatures).toEqual([
      { label: 'Prepared by', name: 'Aisyah Rahman', designation: 'Purchasing Executive', date: '14 Oct 2026, 3:42 pm' },
      { label: 'Approved by', name: 'Hafiz Wasabie', designation: 'Owner', date: '14 Oct 2026, 4:10 pm' },
    ]);
  });

  it('give the Malaysian date when it is already the next day there, and say noon and midnight as 12', () => {
    const late = purchaseOrderPrint(order({ submitted_at: '2026-10-14T16:00:00Z', approved_at: '2026-10-14T17:05:00Z' }), head);
    expect(late.signatures.map((s) => s.date)).toEqual(['15 Oct 2026, 12:00 am', '15 Oct 2026, 1:05 am']);
    const noon = purchaseOrderPrint(order({ approved_at: '2026-10-14T04:00:00Z' }), head);
    expect(noon.signatures[1].date).toBe('14 Oct 2026, 12:00 pm');
  });

  it("fall back to the email's name when there is no full name, and to whoever raised the order when nobody submitted it", () => {
    const people = {
      [RAISER]: { full_name: ' ', email: 'aisyah@rimba.my', job_title: null, role: 'admin' as const },
      [APPROVER]: { full_name: 'Hafiz Wasabie', email: 'hafiz@rimba.my', job_title: 'Director', role: 'owner' as const },
    };
    const p = purchaseOrderPrint(order({ people, submitted_by: null, submitted_at: null }), head);
    expect(p.signatures).toEqual([
      { label: 'Prepared by', name: 'aisyah', designation: 'Admin', date: '' },
      { label: 'Approved by', name: 'Hafiz Wasabie', designation: 'Director', date: '14 Oct 2026, 4:10 pm' },
    ]);
  });

  it('leave the name and designation blank for someone who has left this workspace, even if their profile can still be read', () => {
    const people = {
      [RAISER]: { full_name: 'Aisyah Rahman', email: 'aisyah@rimba.my', job_title: 'Purchasing Executive', role: null },
      [APPROVER]: { full_name: 'Hafiz Wasabie', email: 'hafiz@rimba.my', job_title: null, role: 'owner' as const },
    };
    const p = purchaseOrderPrint(order({ people }), head);
    expect(p.signatures[0]).toEqual({ label: 'Prepared by', name: '', designation: '', date: '14 Oct 2026, 3:42 pm' });
    expect(p.signatures[1].name).toBe('Hafiz Wasabie');
  });

  it('leave the name and designation blank for someone who can no longer be read, and keep the date', () => {
    const p = purchaseOrderPrint(order({ people: {} }), head);
    expect(p.signatures).toEqual([
      { label: 'Prepared by', name: '', designation: '', date: '14 Oct 2026, 3:42 pm' },
      { label: 'Approved by', name: '', designation: '', date: '14 Oct 2026, 4:10 pm' },
    ]);
  });
});
