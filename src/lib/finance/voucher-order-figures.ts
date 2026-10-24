/**
 * The figures an approver is shown beside a supplier payment, worked out from
 * the reads the vouchers screen already makes: the purchase orders behind the
 * voucher's bills, with what was ordered, received, billed so far and paid so
 * far, this payment on its own line, and how much of it goes to each bill with
 * the supplier's own invoice number and date. Pure.
 *
 * Written for issue #242. Two rules it keeps, as the maintainers asked:
 *
 * - "Paid so far" is posted money out only, read off each bill in the bill's
 *   own currency exactly as `supplier_bill_totals` reads it, never the ringgit
 *   that left the bank. A bill settled by a contra entry moved no money, so it
 *   is not in `paid`; it is shown on its own "Set off by contra" line instead,
 *   so the figures still add up for the approver. Contra entries are in
 *   ringgit, so that line is.
 * - Delivery order numbers are left out entirely: deliveries are not stored as
 *   records yet, only a running total per line (#190).
 */
import type { PaymentOutRow } from './money';
import type { OrderBilling } from './purchase-views';

/** What the figures read off a bill's row; `BillListRow` satisfies it. */
export type FiguresBill = {
  id: string;
  bill_no: string | null;
  /** The supplier's own invoice number, as typed on the bill. */
  supplier_ref?: string | null;
  bill_date: string;
  /** 'void' for a bill that was voided; every bill but those counts. */
  display_status?: string;
  currency: string;
  /** Posted money out, in the bill's currency. */
  paid: number;
  /** Settled by posted contra entries, in ringgit; 0 when none. */
  set_off?: number;
  purchase_order_id: string | null;
};

/** What the figures read off a payment's row; one row per bill the payment pays. */
export type FiguresPayment = Pick<PaymentOutRow, 'transaction_id' | 'bill_id' | 'status' | 'amount'> &
  Partial<Pick<PaymentOutRow, 'bill_no' | 'currency'>>;

/** One bill behind the payment, with how much of it goes to that bill. */
export type VoucherFigureBill = {
  id: string;
  /** Our number for the bill; null while it is a draft. */
  billNo: string | null;
  /** The supplier's own invoice number; null when it was not typed. */
  supplierRef: string | null;
  billDate: string;
  /** The part of this payment that goes to the bill, in the bill's currency. */
  thisPayment: number;
  currency: string;
};

/** One purchase order behind the payment, with its figures and the bills under it. */
export type VoucherFigureOrder = {
  orderId: string;
  /** The order's number; null while it has never been submitted. */
  poNo: string | null;
  /** The currency the order's own figures are in, which is its bills' currency (FIN49). */
  currency: string;
  ordered: number;
  received: number;
  /** Every bill raised against the order that was not voided, drafts included. */
  billed: number;
  /** Posted money out against those bills, in the order's currency. */
  paid: number;
  /** This payment to the order's bills, summed, in the order's currency. */
  thisPayment: number;
  /** Settled by posted contra entries, in ringgit; 0 when none, and the line is then not drawn. */
  setOff: number;
  /** Where the order's own screen opens that order, for the line-by-line detail. */
  href: string;
  bills: VoucherFigureBill[];
};

export type VoucherFigures = {
  orders: VoucherFigureOrder[];
  /** Bills with no purchase order behind them, each saying so rather than being left out. */
  withoutOrder: VoucherFigureBill[];
};

/** Whether there is anything to draw: false for a voucher for an expense category. */
export function voucherFiguresShown(figures: VoucherFigures): boolean {
  return figures.orders.length > 0 || figures.withoutOrder.length > 0;
}

/** Where the purchase orders screen opens one order's dialog: the screen reads `?po=`. */
export function orderScreenHref(orderId: string): string {
  return `/finance/purchase-orders?po=${encodeURIComponent(orderId)}`;
}

/** A sum of money as the database stores it, to the sen, so no float dust is shown. */
function sen(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/**
 * For the voucher `transactionId` (a payment waiting for approval), the orders
 * behind its bills and their figures; nothing when it pays no bill. `payments`
 * is every Payments Out row, `bills` every bill, `orders` the purchase orders
 * that may be shown (approved and closed ones; a cancelled order says nothing).
 */
export function voucherOrderFigures(
  transactionId: string,
  payments: FiguresPayment[],
  bills: FiguresBill[],
  orders: OrderBilling[],
): VoucherFigures {
  const allocations = payments.filter(
    (p) => p.transaction_id === transactionId && p.status !== 'void' && p.status !== 'rejected',
  );
  const empty: VoucherFigures = { orders: [], withoutOrder: [] };
  if (allocations.length === 0) return empty;

  const billById = new Map(bills.map((b) => [b.id, b]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const byOrder = new Map<string, VoucherFigureBill[]>();
  const withoutOrder: VoucherFigureBill[] = [];

  for (const allocation of allocations) {
    const bill = billById.get(allocation.bill_id);
    const line: VoucherFigureBill = {
      id: allocation.bill_id,
      billNo: bill?.bill_no ?? allocation.bill_no ?? null,
      supplierRef: bill?.supplier_ref ?? null,
      billDate: bill?.bill_date ?? '',
      thisPayment: sen(allocation.amount),
      currency: bill?.currency ?? allocation.currency ?? 'MYR',
    };
    const orderId = bill?.purchase_order_id ?? null;
    if (orderId === null || !orderById.has(orderId)) {
      withoutOrder.push(line);
      continue;
    }
    byOrder.set(orderId, [...(byOrder.get(orderId) ?? []), line]);
  }

  const blocks: VoucherFigureOrder[] = [];
  for (const [orderId, lines] of byOrder) {
    const order = orderById.get(orderId);
    if (!order) continue;
    // The order's own bills, not only the ones this payment touches: paid so far is the whole order's.
    const orderBills = bills.filter((b) => b.purchase_order_id === orderId && b.display_status !== 'void');
    blocks.push({
      orderId,
      poNo: order.po_no,
      currency: order.currency,
      ordered: sen(order.total),
      received: sen(order.received_total),
      billed: sen(order.billed_total),
      paid: sen(orderBills.reduce((sum, b) => sum + b.paid, 0)),
      thisPayment: sen(lines.reduce((sum, line) => sum + line.thisPayment, 0)),
      setOff: sen(orderBills.reduce((sum, b) => sum + (b.set_off ?? 0), 0)),
      href: orderScreenHref(orderId),
      bills: lines,
    });
  }

  return { orders: blocks, withoutOrder };
}

/**
 * The same, for every voucher that is waiting for approval: the answer the
 * screen keeps by voucher id. A voucher with nothing to say is not in it.
 */
export function voucherFiguresByVoucher(
  payments: FiguresPayment[],
  bills: FiguresBill[],
  orders: OrderBilling[],
): Record<string, VoucherFigures> {
  const waiting = new Set(
    payments.filter((p) => p.status === 'pending_approval').map((p) => p.transaction_id),
  );
  const figures: Record<string, VoucherFigures> = {};
  for (const transactionId of waiting) {
    const found = voucherOrderFigures(transactionId, payments, bills, orders);
    if (voucherFiguresShown(found)) figures[transactionId] = found;
  }
  return figures;
}
