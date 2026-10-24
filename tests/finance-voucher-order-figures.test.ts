import { describe, expect, it } from 'vitest';
import type { BillListRow } from '@/lib/finance/bills';
import type { OrderBilling } from '@/lib/finance/purchase-views';
import {
  type FiguresPayment,
  orderScreenHref,
  voucherFiguresByVoucher,
  voucherFiguresShown,
  voucherOrderFigures,
} from '@/lib/finance/voucher-order-figures';
import { ringgitBill } from './helpers/bill-rows';

/**
 * The figures beside the approve step (#242): one block per purchase order with ordered, received, billed so far,
 * paid so far and this payment, the bills under it with their share of the payment and the supplier's invoice
 * number, and a line for a bill with no order. The money is read, never converted: an order and its bills are in
 * one currency (FIN49).
 */

const PO = 'po000001-1111-4111-8111-111111111111';
const PO_MARKET = 'po000002-2222-4222-8222-222222222222';
const BILL_A = 'b1111111-1111-4111-8111-111111111111';
const BILL_B = 'b2222222-2222-4222-8222-222222222222';
const BILL_C = 'b3333333-3333-4333-8333-333333333333';
const BILL_VOID = 'b4444444-4444-4444-8444-444444444444';
const SUPPLIER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VOUCHER = '55555555-5555-4555-8555-555555555555';
const OTHER_VOUCHER = '56666666-5555-4555-8555-555555555555';

const order = (over: Partial<OrderBilling> = {}): OrderBilling => ({
  id: PO,
  po_no: 'PO-0001',
  total: 325,
  received_total: 225,
  billed_total: 325,
  over_billed: false,
  billed_over_received: false,
  currency: 'MYR',
  ...over,
});

const bill = (over: Partial<BillListRow> = {}): BillListRow =>
  ringgitBill({
    id: BILL_A,
    bill_no: 'BILL-0001',
    supplier_ref: 'INV-8841',
    supplier_id: SUPPLIER,
    supplier_name: 'Syarikat Maju',
    bill_date: '2026-10-05',
    due_date: '2026-11-04',
    total: 325,
    paid: 0,
    set_off: 0,
    credited: 0,
    balance: 325,
    display_status: 'pending',
    purchase_order_id: PO,
    purchase_order_no: 'PO-0001',
    category_id: null,
    category_name: null,
    ...over,
  });

const payment = (over: Partial<FiguresPayment> = {}): FiguresPayment => ({
  transaction_id: VOUCHER,
  bill_id: BILL_A,
  status: 'pending_approval',
  amount: 325,
  bill_no: 'BILL-0001',
  currency: 'MYR',
  ...over,
});

describe('the figures beside the approve step', () => {
  it('shows one block per order, the bills under it and a line for a bill with no order', () => {
    const bills = [
      bill(),
      bill({
        id: BILL_C,
        bill_no: null,
        supplier_ref: null,
        total: 50,
        balance: 50,
        display_status: 'draft',
        purchase_order_id: null,
        purchase_order_no: null,
      }),
    ];
    const payments = [payment(), payment({ bill_id: BILL_C, amount: 50, bill_no: null })];
    const figures = voucherOrderFigures(VOUCHER, payments, bills, [order()]);

    expect(figures.orders).toHaveLength(1);
    expect(figures.orders[0]).toMatchObject({
      orderId: PO,
      poNo: 'PO-0001',
      currency: 'MYR',
      ordered: 325,
      received: 225,
      billed: 325,
      paid: 0,
      thisPayment: 325,
      setOff: 0,
      href: `/finance/purchase-orders?po=${PO}`,
    });
    // The bill's own number, the supplier's invoice number and its date, with what this payment puts on it.
    expect(figures.orders[0].bills).toEqual([
      { id: BILL_A, billNo: 'BILL-0001', supplierRef: 'INV-8841', billDate: '2026-10-05', thisPayment: 325, currency: 'MYR' },
    ]);
    // A bill with no purchase order is named on its own line rather than left out.
    expect(figures.withoutOrder).toEqual([
      { id: BILL_C, billNo: null, supplierRef: null, billDate: '2026-10-05', thisPayment: 50, currency: 'MYR' },
    ]);
  });

  it('sums this payment for the order and keeps each bill under it', () => {
    const bills = [bill(), bill({ id: BILL_B, bill_no: 'BILL-0002', supplier_ref: 'INV-8842', total: 100, balance: 100 })];
    const payments = [payment({ amount: 200 }), payment({ bill_id: BILL_B, amount: 100, bill_no: 'BILL-0002' })];
    const figures = voucherOrderFigures(VOUCHER, payments, bills, [order()]);

    expect(figures.orders[0].thisPayment).toBe(300);
    expect(figures.orders[0].bills.map((b) => b.thisPayment)).toEqual([200, 100]);
    expect(figures.withoutOrder).toEqual([]);
  });

  it("reads paid so far off the order's own bills, posted money out only, in the bill's currency", () => {
    const bills = [
      bill({ paid: 120.5 }),
      bill({ id: BILL_B, bill_no: 'BILL-0002', paid: 4.5, total: 100, balance: 95.5 }),
      // A voided bill counts nothing, even if money once moved on it.
      bill({ id: BILL_VOID, bill_no: 'BILL-0009', paid: 900, display_status: 'void' }),
    ];
    const figures = voucherOrderFigures(VOUCHER, [payment()], bills, [order({ billed_total: 425 })]);

    expect(figures.orders[0].paid).toBe(125);
    // The waiting voucher's own row is not posted money out: it is this payment instead.
    expect(figures.orders[0].thisPayment).toBe(325);
  });

  it('shows contra set-off on its own line, in ringgit, so the figures add up', () => {
    const bills = [bill({ paid: 100, set_off: 40 })];
    const figures = voucherOrderFigures(VOUCHER, [payment()], bills, [order()]);

    expect(figures.orders[0]).toMatchObject({ paid: 100, setOff: 40 });
  });

  it("keeps a foreign order's figures in its own currency, never the ringgit that left the bank", () => {
    const bills = [bill({ currency: 'USD', total: 200, paid: 50, balance: 150 })];
    const figures = voucherOrderFigures(
      VOUCHER,
      [payment({ amount: 150, currency: 'USD' })],
      bills,
      [order({ currency: 'USD', total: 200, received_total: 200, billed_total: 200 })],
    );

    expect(figures.orders[0]).toMatchObject({
      currency: 'USD',
      ordered: 200,
      received: 200,
      billed: 200,
      paid: 50,
      thisPayment: 150,
    });
    expect(figures.orders[0].bills[0].currency).toBe('USD');
  });

  it('says nothing for a voucher that pays no bill, or whose bill is not among the ones read', () => {
    expect(voucherFiguresShown(voucherOrderFigures(VOUCHER, [], [], []))).toBe(false);
    // Payments Out names the bill, but the bill is not in the read: nothing is guessed about its order.
    const figures = voucherOrderFigures(VOUCHER, [payment()], [], [order()]);
    expect(figures.orders).toEqual([]);
    expect(figures.withoutOrder.map((b) => b.thisPayment)).toEqual([325]);
  });

  it('keeps the figures of each waiting voucher, and only those with something to say', () => {
    const payments = [
      payment(),
      payment({ transaction_id: OTHER_VOUCHER, status: 'scheduled' }),
      payment({ transaction_id: OTHER_VOUCHER, status: 'posted' }),
    ];
    const figures = voucherFiguresByVoucher(payments, [bill()], [order()]);

    expect(Object.keys(figures)).toEqual([VOUCHER]);
    expect(figures[VOUCHER].orders[0].poNo).toBe('PO-0001');
  });

  it('orders the blocks as the bills come, and links each to its own screen', () => {
    const bills = [
      bill(),
      bill({ id: BILL_B, bill_no: 'BILL-0002', total: 80, balance: 80, purchase_order_id: PO_MARKET, purchase_order_no: 'PO-0002' }),
    ];
    const payments = [payment(), payment({ bill_id: BILL_B, amount: 80, bill_no: 'BILL-0002' })];
    const figures = voucherOrderFigures(VOUCHER, payments, bills, [
      order(),
      order({ id: PO_MARKET, po_no: 'PO-0002', total: 80, received_total: 80, billed_total: 80 }),
    ]);

    expect(figures.orders.map((o) => o.poNo)).toEqual(['PO-0001', 'PO-0002']);
    expect(figures.orders[1].href).toBe(orderScreenHref(PO_MARKET));
    expect(figures.orders[1].href).toBe(`/finance/purchase-orders?po=${PO_MARKET}`);
  });
});
