/**
 * What the Supplier Bills and Payments Out screens show, worked out from the
 * rows the data layer reads. Pure, with no server imports, so the client views
 * and the tests both use it. `today` is always a YYYY-MM-DD date.
 */
import type { Slice } from '@/components/charts';
import type { BillDisplayStatus, BillListRow } from './bills';
import { toCsv } from './csv';
import { rmShort } from './format';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod, type PaymentOutRow } from './money';
import {
  ELECTRONIC,
  METHOD_COLORS,
  type Stat,
  addDays,
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
  scheduled: 'Scheduled',
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
    ['No.', 'Date', 'Supplier', 'Due', 'Total', 'Balance', 'Status'],
    bills.map((b) => [b.bill_no, b.bill_date, b.supplier_name, b.due_date, b.total, b.balance, BILL_STATUS_LABELS[b.display_status]]),
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
      { label: 'Scheduled', value: rmShort(sum(scheduled, (p) => p.amount)), delta: count(paymentCount(scheduled), 'payment'), deltaTone: 'flat' },
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
  const others = siblingBills(rows, row);
  if (others.length === 0) return '';
  const list = others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}`;
  return `This payment also covers ${list}.`;
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
