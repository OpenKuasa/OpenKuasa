/**
 * What the Invoices and Payments In screens show, worked out from the rows
 * the data layer reads. Pure, with no server imports, so the client views and
 * the tests both use it. `today` is always a YYYY-MM-DD date.
 */
import type { Slice } from '@/components/charts';
import { toCsv } from './csv';
import { rmShort } from './format';
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from './invoices';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentInRow, type PaymentMethod } from './money';
import {
  ELECTRONIC,
  METHOD_COLORS,
  type Stat,
  addDays,
  count,
  lastMonths,
  monthOf,
  paymentCount,
  sum,
  thousands,
} from './view-helpers';

export type InvoicesViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: what was invoiced and what was received. */
  trend: { label: string; invoiced: number; received: number }[];
  /** Whether anything was invoiced or received in those eight months, however little: a small amount rounds to 0 in `trend`. */
  hasTrend: boolean;
  /** How many invoices are in each status. Void invoices are left out. */
  byStatus: Slice[];
  /** How many invoices `byStatus` counts. */
  invoiceCount: number;
};

export type PaymentsInViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands. */
  trend: { label: string; received: number }[];
  /** Whether anything was received in those eight months, however little: a small payment rounds to 0 in `trend`. */
  hasTrend: boolean;
  /** Received this month per method, in RM. */
  byMethod: Slice[];
  /** Whether anything was received this month. */
  hasReceived: boolean;
  receivedMtd: string;
};

/** A posted invoice is "Sent": no email goes out, the word says it is out of the workspace's hands. */
export const INVOICE_STATUS_LABELS: Record<InvoiceDisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

/** `none` has no label: the table shows a dash. */
export const EINVOICE_STATUS_LABELS: Record<EInvoiceStatus, string> = {
  none: '',
  pending: 'Pending',
  validated: 'Validated',
  rejected: 'Rejected',
};

/** Money in is posted the moment it is recorded, and the screen words that "Received". */
export const PAYMENT_IN_STATUS_LABELS: Record<PaymentInRow['status'], string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  scheduled: 'Scheduled',
  posted: 'Received',
  rejected: 'Rejected',
  void: 'Void',
};

/** Posted and not void: an invoice that has gone out, paid or not. */
function isIssued(invoice: InvoiceListRow): boolean {
  return invoice.display_status === 'sent' || invoice.display_status === 'overdue' || invoice.display_status === 'paid';
}

/** What a customer still owes on an invoice: its balance once it has gone out, nothing (null) on a draft or a void one. */
export function owed(invoice: InvoiceListRow): number | null {
  return isIssued(invoice) ? invoice.balance : null;
}

/** Only money that has actually arrived counts: not voided, not half-written. */
function received(rows: PaymentInRow[]): PaymentInRow[] {
  return rows.filter((p) => p.status === 'posted');
}

/* ---- Invoices ------------------------------------------------------ */

export function invoicesView(invoices: InvoiceListRow[], payments: PaymentInRow[], today: string): InvoicesViewData {
  const open = invoices.filter((i) => i.display_status === 'sent' || i.display_status === 'overdue');
  const overdue = open.filter((i) => i.display_status === 'overdue');
  const weekEnd = addDays(today, 7);
  const dueThisWeek = open.filter((i) => i.display_status === 'sent' && i.due_date <= weekEnd);
  const posted = received(payments);
  const receivedMtd = posted.filter((p) => monthOf(p.txn_date) === monthOf(today));
  const issued = invoices.filter(isIssued);

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const invoicedInMonth = issued.filter((i) => monthOf(i.invoice_date) === key);
    const receivedInMonth = posted.filter((p) => monthOf(p.txn_date) === key);
    if (invoicedInMonth.length > 0 || receivedInMonth.length > 0) hasTrend = true;
    return {
      label,
      invoiced: thousands(sum(invoicedInMonth, (i) => i.total)),
      received: thousands(sum(receivedInMonth, (p) => p.amount)),
    };
  });

  const statusCount = (status: InvoiceDisplayStatus) => invoices.filter((i) => i.display_status === status).length;

  return {
    stats: [
      { label: 'Total receivable', value: rmShort(sum(open, (i) => i.balance)), delta: count(open.length, 'open invoice'), deltaTone: 'flat' },
      { label: 'Due this week', value: rmShort(sum(dueThisWeek, (i) => i.balance)), delta: count(dueThisWeek.length, 'invoice'), deltaTone: 'flat' },
      { label: 'Overdue', value: rmShort(sum(overdue, (i) => i.balance)), delta: count(overdue.length, 'invoice'), deltaTone: overdue.length ? 'down' : 'flat' },
      { label: 'Received (MTD)', value: rmShort(sum(receivedMtd, (p) => p.amount)), delta: count(paymentCount(receivedMtd), 'payment'), deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    byStatus: [
      { key: 'sent', label: 'Sent', value: statusCount('sent'), color: 'var(--chart-1)' },
      { key: 'paid', label: 'Paid', value: statusCount('paid'), color: 'var(--chart-2)' },
      { key: 'overdue', label: 'Overdue', value: statusCount('overdue'), color: 'var(--chart-4)' },
      { key: 'draft', label: 'Draft', value: statusCount('draft'), color: 'var(--chart-3)' },
    ],
    invoiceCount: invoices.filter((i) => i.display_status !== 'void').length,
  };
}

/** `open` is every invoice that is not void: what the table shows until a status is chosen. */
export type InvoiceFilter = 'open' | InvoiceDisplayStatus;

/** Invoices matching the status and customer filters whose number or customer contains the search text. */
export function filterInvoices(
  invoices: InvoiceListRow[],
  query: string,
  filter: InvoiceFilter,
  customerId: string = 'all',
): InvoiceListRow[] {
  const q = query.trim().toLowerCase();
  return invoices.filter(
    (i) =>
      (filter === 'open' ? i.display_status !== 'void' : i.display_status === filter) &&
      (customerId === 'all' || i.customer_id === customerId) &&
      `${i.invoice_no ?? ''} ${i.customer_name}`.toLowerCase().includes(q),
  );
}

/** The customers that have an invoice, by name, for the customer filter. Two customers with one name stay two choices. */
export function invoiceCustomers(invoices: InvoiceListRow[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const i of invoices) byId.set(i.customer_id, i.customer_name);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

/** The invoices table as a CSV file. Amounts are numbers, so a spreadsheet can add them up. */
export function invoicesCsv(invoices: InvoiceListRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Customer', 'Due', 'Total', 'Paid', 'Balance', 'Status', 'e-Invois'],
    invoices.map((i) => [
      i.invoice_no,
      i.invoice_date,
      i.customer_name,
      i.due_date,
      i.total,
      i.paid,
      owed(i),
      INVOICE_STATUS_LABELS[i.display_status],
      EINVOICE_STATUS_LABELS[i.einvoice_status],
    ]),
  );
}

/* ---- Payments In --------------------------------------------------- */

export function paymentsInView(rows: PaymentInRow[], today: string): PaymentsInViewData {
  const posted = received(rows);
  const mtd = posted.filter((p) => monthOf(p.txn_date) === monthOf(today));
  const mtdTotal = sum(mtd, (p) => p.amount);
  const mtdCount = paymentCount(mtd);
  const electronicMtd = sum(mtd.filter((p) => ELECTRONIC.has(p.method)), (p) => p.amount);

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = posted.filter((p) => monthOf(p.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return { label, received: thousands(sum(inMonth, (p) => p.amount)) };
  });

  const methods: Slice[] = PAYMENT_METHODS.map((method) => ({
    key: method,
    label: PAYMENT_METHOD_LABELS[method],
    value: sum(mtd.filter((p) => p.method === method), (p) => p.amount),
    color: METHOD_COLORS[method],
  }));
  const used = methods.filter((slice) => slice.value > 0);

  return {
    stats: [
      { label: 'Received (MTD)', value: rmShort(mtdTotal), delta: 'this month', deltaTone: 'flat' },
      // A payment split across invoices is several rows and one payment.
      { label: 'Payments', value: String(mtdCount), delta: 'this month', deltaTone: 'flat' },
      { label: 'Average payment', value: mtdCount ? rmShort(mtdTotal / mtdCount) : '—', delta: 'this month', deltaTone: 'flat' },
      {
        label: 'Via bank / FPX',
        value: mtdTotal ? `${Math.round((electronicMtd / mtdTotal) * 100)}%` : '—',
        delta: 'of received MTD',
        deltaTone: 'flat',
      },
    ],
    trend,
    hasTrend,
    // Seven empty slices would be noise; with nothing received, all seven stay so the legend still shows.
    byMethod: used.length ? used : methods,
    hasReceived: mtd.length > 0,
    receivedMtd: rmShort(mtdTotal),
  };
}

/** `posted` is what the table shows until a status is chosen: money that was received and still stands. */
export type PaymentInStatusFilter = 'posted' | 'void' | 'all';
export type PaymentInMethodFilter = 'all' | PaymentMethod;

/** Rows matching both filters whose customer, invoice number, receipt number or reference contains the search text. */
export function filterPaymentsIn(
  rows: PaymentInRow[],
  query: string,
  status: PaymentInStatusFilter,
  method: PaymentInMethodFilter,
): PaymentInRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (p) =>
      (status === 'all' || p.status === status) &&
      (method === 'all' || p.method === method) &&
      `${p.customer_name} ${p.invoice_no ?? ''} ${p.number ?? ''} ${p.reference ?? ''}`.toLowerCase().includes(q),
  );
}

/** The payments table as a CSV file: one line per invoice a payment pays. Amounts are numbers. */
export function paymentsInCsv(rows: PaymentInRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Customer', 'Invoice', 'Account', 'Method', 'Amount', 'Status'],
    rows.map((p) => [
      p.txn_date,
      p.number,
      p.customer_name,
      p.invoice_no,
      p.account_name,
      PAYMENT_METHOD_LABELS[p.method],
      p.amount,
      PAYMENT_IN_STATUS_LABELS[p.status],
    ]),
  );
}
