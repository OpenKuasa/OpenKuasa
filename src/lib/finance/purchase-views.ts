/**
 * What the Supplier Bills, Payments Out, RFQs and Purchase Orders screens show, worked out from the
 * rows the data layer reads. Pure, with no server imports, so the client views
 * and the tests both use it. `today` is always a YYYY-MM-DD date.
 */
import type { Slice } from '@/components/charts';
import type { BillDisplayStatus, BillListRow } from './bills';
import { toCsv } from './csv';
import { rm, rmShort } from './format';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod, type PaymentOutRow } from './money';
import type { PurchaseOrderDelivery, PurchaseOrderListRow, PurchaseOrderStatus } from './purchase-orders';
import type { RfqDisplayStatus, RfqListRow } from './rfqs';
import {
  ELECTRONIC,
  METHOD_COLORS,
  type Stat,
  addDays,
  alsoCoversSentence,
  count,
  lastMonths,
  monthOf,
  paymentCount,
  round2,
  sum,
  thousands,
} from './view-helpers';

// Defined in view-helpers.ts, which the sales screens share; exported from here for this module's existing importers.
export { LATEST_ROWS, type Stat, displayDate, todayUtc } from './view-helpers';

export type BillsViewData = {
  stats: Stat[];
  /** Open balance per supplier, the five largest. */
  bySupplier: { label: string; value: number }[];
  /** How many bills are in each status. Void bills are left out. */
  byStatus: Slice[];
};

export type PaymentsViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands. */
  trend: { label: string; electronic: number; cash: number }[];
  /** Whether anything was paid in those eight months, however little: a small payment rounds to 0 in `trend`. */
  hasTrend: boolean;
  /** Paid this month per method, in RM. */
  byMethod: Slice[];
  paidMtd: string;
};

export const BILL_STATUS_LABELS: Record<BillDisplayStatus, string> = {
  draft: 'Draft',
  pending: 'Pending',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentOutRow['status'], string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  scheduled: 'To be paid',
  posted: 'Paid',
  rejected: 'Rejected',
  void: 'Void',
};

/* ---- Supplier Bills ----------------------------------------------- */

export function billsView(bills: BillListRow[], paid: PaymentOutRow[], today: string): BillsViewData {
  const open = bills.filter((b) => b.display_status === 'pending' || b.display_status === 'overdue');
  const overdue = open.filter((b) => b.display_status === 'overdue');
  const weekEnd = addDays(today, 7);
  const dueThisWeek = open.filter((b) => b.display_status === 'pending' && b.due_date <= weekEnd);
  // Only money that has actually left counts: not scheduled, not voided.
  const paidMtd = paid.filter((p) => p.status === 'posted' && p.txn_date.slice(0, 7) === today.slice(0, 7));

  const owed = new Map<string, { label: string; value: number }>();
  for (const b of open) {
    const entry = owed.get(b.supplier_id) ?? { label: b.supplier_name, value: 0 };
    entry.value += b.balance;
    owed.set(b.supplier_id, entry);
  }
  const bySupplier = [...owed.values()]
    .map((entry) => ({ label: entry.label, value: round2(entry.value) }))
    .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label))
    .slice(0, 5);

  const statusCount = (status: BillDisplayStatus) => bills.filter((b) => b.display_status === status).length;

  return {
    stats: [
      { label: 'Total payable', value: rmShort(sum(open, (b) => b.balance)), delta: count(open.length, 'open bill'), deltaTone: 'flat' },
      { label: 'Due this week', value: rmShort(sum(dueThisWeek, (b) => b.balance)), delta: count(dueThisWeek.length, 'bill'), deltaTone: 'flat' },
      { label: 'Overdue', value: rmShort(sum(overdue, (b) => b.balance)), delta: count(overdue.length, 'bill'), deltaTone: overdue.length ? 'down' : 'flat' },
      { label: 'Paid (MTD)', value: rmShort(sum(paidMtd, (p) => p.amount)), delta: count(paymentCount(paidMtd), 'payment'), deltaTone: 'flat' },
    ],
    bySupplier,
    byStatus: [
      { key: 'pending', label: 'Pending', value: statusCount('pending'), color: 'var(--chart-1)' },
      { key: 'paid', label: 'Paid', value: statusCount('paid'), color: 'var(--chart-2)' },
      { key: 'overdue', label: 'Overdue', value: statusCount('overdue'), color: 'var(--chart-4)' },
      { key: 'draft', label: 'Draft', value: statusCount('draft'), color: 'var(--chart-3)' },
    ],
  };
}

/** `open` is every bill that is not void: what the table shows until a status is chosen. */
export type BillFilter = 'open' | BillDisplayStatus;

/** Bills matching the status filter whose number or supplier contains the search text. */
export function filterBills(bills: BillListRow[], query: string, filter: BillFilter): BillListRow[] {
  const q = query.trim().toLowerCase();
  return bills.filter(
    (b) =>
      (filter === 'open' ? b.display_status !== 'void' : b.display_status === filter) &&
      `${b.bill_no ?? ''} ${b.supplier_name}`.toLowerCase().includes(q),
  );
}

/** The bills table as a CSV file. Amounts are numbers, so a spreadsheet can add them up. */
export function billsCsv(bills: BillListRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Supplier', 'Due', 'Total', 'Balance', 'Status', 'Purchase order', 'Category'],
    bills.map((b) => [
      b.bill_no,
      b.bill_date,
      b.supplier_name,
      b.due_date,
      b.total,
      b.balance,
      BILL_STATUS_LABELS[b.display_status],
      b.purchase_order_no,
      b.category_name,
    ]),
  );
}

/* ---- Payments Out ------------------------------------------------- */

export function paymentsView(rows: PaymentOutRow[], today: string): PaymentsViewData {
  const month = today.slice(0, 7);
  const paid = rows.filter((p) => p.status === 'posted');
  const paidMtd = paid.filter((p) => p.txn_date.slice(0, 7) === month);
  const paidMtdTotal = sum(paidMtd, (p) => p.amount);
  const electronicMtd = sum(paidMtd.filter((p) => ELECTRONIC.has(p.method)), (p) => p.amount);
  const scheduled = rows.filter((p) => p.status === 'scheduled');

  // Last 8 months, oldest first, in RM thousands.
  const paidK = (list: PaymentOutRow[]) => thousands(sum(list, (p) => p.amount));
  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = paid.filter((p) => monthOf(p.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return {
      label,
      electronic: paidK(inMonth.filter((p) => ELECTRONIC.has(p.method))),
      cash: paidK(inMonth.filter((p) => !ELECTRONIC.has(p.method))),
    };
  });

  const methods: Slice[] = PAYMENT_METHODS.map((method) => ({
    key: method,
    label: PAYMENT_METHOD_LABELS[method],
    value: sum(paidMtd.filter((p) => p.method === method), (p) => p.amount),
    color: METHOD_COLORS[method],
  }));
  const used = methods.filter((slice) => slice.value > 0);

  return {
    stats: [
      { label: 'Paid (MTD)', value: rmShort(paidMtdTotal), delta: 'this month', deltaTone: 'flat' },
      { label: 'Payments', value: String(paymentCount(paidMtd)), delta: 'this month', deltaTone: 'flat' },
      {
        label: 'Via bank / FPX',
        value: paidMtdTotal ? `${Math.round((electronicMtd / paidMtdTotal) * 100)}%` : '—',
        delta: 'of paid MTD',
        deltaTone: 'flat',
      },
      { label: 'To be paid', value: rmShort(sum(scheduled, (p) => p.amount)), delta: count(paymentCount(scheduled), 'payment'), deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    // Seven empty slices would be noise; with nothing paid, all seven stay so the legend still shows.
    byMethod: used.length ? used : methods,
    paidMtd: rmShort(paidMtdTotal),
  };
}

/** `current` is paid and scheduled together: what the table shows until a status is chosen. */
export type PaymentStatusFilter = 'current' | 'all' | 'posted' | 'scheduled' | 'void';
export type PaymentMethodFilter = 'all' | PaymentMethod;

/** Rows matching both filters whose supplier, bill number, voucher number or reference contains the search text. */
export function filterPayments(
  rows: PaymentOutRow[],
  query: string,
  status: PaymentStatusFilter,
  method: PaymentMethodFilter,
): PaymentOutRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((p) => {
    const statusOk =
      status === 'all' || (status === 'current' ? p.status === 'posted' || p.status === 'scheduled' : p.status === status);
    return (
      statusOk &&
      (method === 'all' || p.method === method) &&
      `${p.supplier_name} ${p.bill_no ?? ''} ${p.number ?? ''} ${p.reference ?? ''}`.toLowerCase().includes(q)
    );
  });
}

/**
 * The other bills the same payment pays. A payment split across bills shows
 * one row per bill, and voiding, deleting or marking paid from any of them
 * acts on the whole payment, so the question names the others.
 */
export function siblingBills(rows: PaymentOutRow[], row: PaymentOutRow): string[] {
  return rows
    .filter((other) => other.transaction_id === row.transaction_id && other.allocation_id !== row.allocation_id)
    .map((other) => other.bill_no ?? 'a draft bill')
    .sort();
}

/** "This payment also covers BILL-0007 and BILL-0008." for a split payment; empty for a payment against one bill. */
export function alsoCovers(rows: PaymentOutRow[], row: PaymentOutRow): string {
  return alsoCoversSentence(siblingBills(rows, row));
}

/** What a payment's bills are checked against: the billing figures and flags of a purchase order. */
export type OrderBilling = Pick<
  PurchaseOrderListRow,
  'id' | 'po_no' | 'total' | 'billed_total' | 'received_total' | 'over_billed' | 'billed_over_received'
>;

/**
 * One sentence for each purchase order, among the ones these bills are raised against, that is billed for more
 * than its total or for more than has been received, in the order the bills come. When several of the bills belong to
 * the same order the first is named and the rest counted. Advice only: it blocks nothing. An order that is not
 * in `orders` (cancelled ones may not be passed) says nothing.
 */
export function orderNotesForBills(
  bills: { bill_no: string | null; purchase_order_id: string | null }[],
  orders: OrderBilling[],
): string[] {
  const byOrder = new Map<string, string[]>();
  for (const bill of bills) {
    if (bill.purchase_order_id === null) continue;
    byOrder.set(bill.purchase_order_id, [...(byOrder.get(bill.purchase_order_id) ?? []), bill.bill_no ?? 'A draft bill']);
  }
  const notes: string[] = [];
  for (const [orderId, names] of byOrder) {
    const order = orders.find((o) => o.id === orderId);
    if (!order || !(order.over_billed || order.billed_over_received)) continue;
    const [first, ...others] = names;
    const subject = others.length === 0 ? `${first} is` : `${first} and ${others.length} more are`;
    const po = order.po_no ?? 'its purchase order';
    notes.push(
      order.over_billed
        ? `${subject} against ${po}, whose bills come to ${rm(order.billed_total)}, over its total of ${rm(order.total)}.`
        : `${subject} against ${po}, which is billed ${rm(order.billed_total)} with ${rm(order.received_total)} received so far.`,
    );
  }
  return notes;
}

/** Payments that have not been paid yet: the ones a purchase-order warning is still useful on. */
const NOT_YET_PAID: ReadonlySet<PaymentOutRow['status']> = new Set(['scheduled', 'pending_approval']);

/**
 * The rows (by allocation id) of payments still to be paid whose own bill is raised against a flagged purchase
 * order. A payment over several bills is several rows; only the row of the bill that is flagged is marked.
 */
export function paymentRowsAgainstFlaggedOrders(
  rows: PaymentOutRow[],
  bills: { id: string; purchase_order_id: string | null }[],
  orders: OrderBilling[],
): Set<string> {
  const flagged = new Set(orders.filter((o) => o.over_billed || o.billed_over_received).map((o) => o.id));
  const flaggedBills = new Set(bills.filter((b) => b.purchase_order_id !== null && flagged.has(b.purchase_order_id)).map((b) => b.id));
  return new Set(rows.filter((r) => NOT_YET_PAID.has(r.status) && flaggedBills.has(r.bill_id)).map((r) => r.allocation_id));
}

/** The payments table as a CSV file. Amounts are numbers, so a spreadsheet can add them up. */
export function paymentsCsv(rows: PaymentOutRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Supplier', 'Bill', 'Account', 'Method', 'Amount', 'Status'],
    rows.map((p) => [
      p.txn_date,
      p.number,
      p.supplier_name,
      p.bill_no,
      p.account_name,
      PAYMENT_METHOD_LABELS[p.method],
      p.amount,
      PAYMENT_STATUS_LABELS[p.status],
    ]),
  );
}

/* ---- RFQs ----------------------------------------------------------- */

export const RFQ_STATUS_LABELS: Record<RfqDisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  quoted: 'Quoted',
  closed: 'Closed',
  overdue: 'Reply overdue',
};

/** A sent RFQ whose reply-by date has passed reads "overdue"; one with no reply-by date never does. */
export function rfqDisplayStatus(row: RfqListRow, today: string): RfqDisplayStatus {
  return row.status === 'sent' && row.reply_by !== null && row.reply_by < today ? 'overdue' : row.status;
}

/** `open` is every RFQ that is not closed: what the table shows until a status is chosen. */
export type RfqFilter = 'open' | 'all' | RfqDisplayStatus;

/** RFQs matching the status filter whose number, supplier or supplier's reference contains the search text. */
export function filterRfqs(rows: RfqListRow[], query: string, filter: RfqFilter, today: string): RfqListRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    const status = rfqDisplayStatus(row, today);
    return (
      (filter === 'all' || (filter === 'open' ? status !== 'closed' : status === filter)) &&
      `${row.rfq_no ?? ''} ${row.supplier_name} ${row.supplier_ref ?? ''}`.toLowerCase().includes(q)
    );
  });
}

export type RfqAction = 'edit' | 'send' | 'delete' | 'recordPrices' | 'convert' | 'compare' | 'copy' | 'close';

/**
 * What an RFQ's row menu offers, in order: only what the database allows for
 * its status. A draft is edited, marked as sent or deleted. Once sent it is
 * locked, and only the supplier's answer is recorded (an overdue RFQ too:
 * a late reply is still a reply), or the RFQ is closed. A quoted RFQ becomes a
 * purchase order, unless one stands already, or is closed. Any RFQ, in any
 * status, can be copied to another supplier: that opens a new RFQ and changes
 * nothing here, so it comes before what ends or removes the RFQ. An RFQ that
 * has gone out with copies to other suppliers (`comparable`, see
 * comparableRfqIds) can have its quotes compared, which changes nothing either.
 */
export function rfqActions(row: RfqListRow, comparable = false): RfqAction[] {
  const compare: RfqAction[] = comparable ? ['compare'] : [];
  switch (row.status) {
    case 'draft':
      return ['edit', 'send', 'copy', 'delete'];
    case 'sent':
      return ['recordPrices', ...compare, 'copy', 'close'];
    case 'quoted':
      return row.purchase_order_id === null ? ['convert', ...compare, 'copy', 'close'] : [...compare, 'copy', 'close'];
    default:
      return [...compare, 'copy'];
  }
}

/** How a question or a menu names one RFQ: its number, or "this draft RFQ". */
export function rfqName(row: RfqListRow): string {
  return row.rfq_no ?? 'this draft RFQ';
}

export type RfqsViewData = {
  /** How many RFQs are in each status; an overdue one counts as overdue, not as sent. */
  counts: Record<RfqDisplayStatus, number>;
  /** Sent and not yet answered, overdue ones included. */
  awaitingReply: number;
  overdue: number;
};

export function rfqsView(rows: RfqListRow[], today: string): RfqsViewData {
  const counts: Record<RfqDisplayStatus, number> = { draft: 0, sent: 0, quoted: 0, closed: 0, overdue: 0 };
  for (const row of rows) counts[rfqDisplayStatus(row, today)] += 1;
  return { counts, awaitingReply: counts.sent + counts.overdue, overdue: counts.overdue };
}

/** The RFQs table as a CSV file. The total is a number, and empty until the supplier's answer is recorded. */
export function rfqsCsv(rows: RfqListRow[], today: string): string {
  return toCsv(
    ['No.', 'Date', 'Supplier', 'Reply by', 'Supplier ref', 'Lines', 'Total', 'Status', 'Purchase order'],
    rows.map((r) => [
      r.rfq_no,
      r.rfq_date,
      r.supplier_name,
      r.reply_by,
      r.supplier_ref,
      r.line_count,
      // Empty until the supplier's answer is recorded, like the dash on the screen: prices the buyer typed are not a quote.
      r.quoted_at ? r.total : null,
      RFQ_STATUS_LABELS[rfqDisplayStatus(r, today)],
      r.purchase_order_no,
    ]),
  );
}

/* ---- Purchase Orders ------------------------------------------------ */

export const PO_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  approved: 'Approved',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export const PO_DELIVERY_LABELS: Record<PurchaseOrderDelivery, string> = {
  pending: 'Not delivered',
  partial: 'Partly delivered',
  delivered: 'Delivered',
};

/** `open` is every order still going on (a draft, awaiting approval, or approved): what the table shows until a status is chosen. */
export type PurchaseOrderFilter = 'open' | 'all' | PurchaseOrderStatus;

const OPEN_ORDER: ReadonlySet<PurchaseOrderStatus> = new Set(['draft', 'pending_approval', 'approved']);

/** Orders matching the status filter whose number, supplier or RFQ number contains the search text. */
export function filterPurchaseOrders(rows: PurchaseOrderListRow[], query: string, filter: PurchaseOrderFilter): PurchaseOrderListRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filter === 'all' || (filter === 'open' ? OPEN_ORDER.has(row.status) : row.status === filter)) &&
      `${row.po_no ?? ''} ${row.supplier_name} ${row.rfq_no ?? ''}`.toLowerCase().includes(q),
  );
}

export type PurchaseOrderAction =
  | 'edit'
  | 'submit'
  | 'delete'
  | 'approve'
  | 'reject'
  | 'withdraw'
  | 'receive'
  | 'createBill'
  | 'close'
  | 'cancel';

/**
 * What an order's row menu offers the viewer, in order: only what the database allows for its status and for
 * them. The database asks again and its answer counts; this keeps the menu from offering what it would refuse.
 * `raiser` created the order; `mine` also covers whoever submitted it, and neither may approve it unless they
 * own the workspace. A draft that was never numbered is deleted; a numbered one (rejected or withdrawn) is
 * cancelled, since its number was given out. Closing and cancelling an approved order are an owner's or admin's.
 */
export function purchaseOrderActions(
  row: PurchaseOrderListRow,
  viewer: { userId: string; canSignOff: boolean; isOwner: boolean },
): PurchaseOrderAction[] {
  const raiser = row.created_by !== null && row.created_by === viewer.userId;
  const mine = raiser || (row.submitted_by !== null && row.submitted_by === viewer.userId);
  const mayCancel = raiser || viewer.canSignOff;
  switch (row.status) {
    case 'draft':
      if (row.po_no === null) return ['edit', 'submit', 'delete'];
      return mayCancel ? ['edit', 'submit', 'cancel'] : ['edit', 'submit'];
    case 'pending_approval': {
      const actions: PurchaseOrderAction[] = [];
      if (viewer.canSignOff) {
        if (!mine || viewer.isOwner) actions.push('approve');
        actions.push('reject');
      }
      if (mayCancel) actions.push('withdraw', 'cancel');
      return actions;
    }
    case 'approved':
      return viewer.canSignOff ? ['receive', 'createBill', 'close', 'cancel'] : ['receive', 'createBill'];
    default:
      return [];
  }
}

/** How a question or a menu names one order: its number, or "this draft purchase order". */
export function purchaseOrderName(row: PurchaseOrderListRow): string {
  return row.po_no ?? 'this draft purchase order';
}

export type PurchaseOrdersViewData = {
  awaitingApproval: number;
  /** Approved and not yet closed or cancelled. */
  approvedOpen: number;
  /** Billed for more than the order is worth, whatever its status. */
  overBilled: number;
};

export function purchaseOrdersView(rows: PurchaseOrderListRow[]): PurchaseOrdersViewData {
  return {
    awaitingApproval: rows.filter((r) => r.status === 'pending_approval').length,
    approvedOpen: rows.filter((r) => r.status === 'approved').length,
    overBilled: rows.filter((r) => r.over_billed).length,
  };
}

/**
 * The purchase orders table as a CSV file. Amounts are numbers. The delivery column is empty for an order
 * that was never approved: "Not delivered" would read as a late delivery.
 */
export function purchaseOrdersCsv(rows: PurchaseOrderListRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Supplier', 'RFQ', 'Expected delivery', 'Total', 'Received', 'Billed', 'Delivery', 'Status'],
    rows.map((r) => [
      r.po_no,
      r.po_date,
      r.supplier_name,
      r.rfq_no,
      r.expected_date,
      r.total,
      r.received_total,
      r.billed_total,
      r.status === 'approved' || r.status === 'closed' ? PO_DELIVERY_LABELS[r.delivery] : null,
      PO_STATUS_LABELS[r.status],
    ]),
  );
}
