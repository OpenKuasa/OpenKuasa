/**
 * What the Invoices and Payments In screens show, worked out from the rows
 * the data layer reads. Pure, with no server imports, so the client views and
 * the tests both use it. `today` is always a YYYY-MM-DD date.
 */
import type { Slice } from '@/components/charts';
import { toCsv } from './csv';
import { money, rmShort } from './format';
import { type EInvoiceStatus, type InvoiceDisplayStatus, type InvoiceListRow, invoiceRinggit } from './invoices';
import { PROVIDER_LABELS } from './sst-rate';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentInRow, type PaymentMethod, paymentInRinggit } from './money';
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

/**
 * What a customer still owes on an invoice: its balance once it has gone out,
 * nothing (null) on a draft or a void one. Below zero, the customer is in
 * credit: they have paid, or been credited, more than the invoice came to.
 * In the invoice's own currency; `invoiceRinggit` gives it in ringgit.
 */
export function owed(invoice: InvoiceListRow): number | null {
  return isIssued(invoice) ? invoice.balance : null;
}

/** How much the customer is in credit on an invoice: 0 unless its balance is below zero. In its own currency. */
export function inCredit(invoice: InvoiceListRow): number {
  const balance = owed(invoice);
  return balance !== null && balance < 0 ? round2(-balance) : 0;
}

/**
 * The same in ringgit, for every figure that adds credits up: what the invoice still carries in ringgit for the
 * credit (its balance_myr below zero), which for a ringgit invoice is `inCredit`. Stage 3c: a credit note can put
 * a customer in credit on an invoice in another currency.
 */
export function inCreditRinggit(invoice: InvoiceListRow): number {
  if (inCredit(invoice) === 0) return 0;
  const balance = invoiceRinggit(invoice).balance;
  return balance < 0 ? round2(-balance) : 0;
}

/**
 * The Balance cell of an invoice row, in the invoice's currency. A draft or a
 * void invoice owes nothing and shows a dash. A customer in credit is never
 * shown as a negative amount: the cell says how much they are in credit.
 */
export function balanceText(invoice: InvoiceListRow): string {
  const balance = owed(invoice);
  if (balance === null) return '—';
  return balance < 0 ? `${money(-balance, invoice.currency)} in credit` : money(balance, invoice.currency);
}

/** True once any invoice is in another currency: only then do the list and the export show currencies. */
export function invoicesHaveForeign(rows: InvoiceListRow[]): boolean {
  return rows.some((i) => i.currency !== 'MYR');
}

/** What a total or a balance adds to a ringgit figure: its ringgit, which for a ringgit invoice is itself. */
const ringgitTotal = (i: InvoiceListRow) => invoiceRinggit(i).total;
const ringgitBalance = (i: InvoiceListRow) => invoiceRinggit(i).balance;

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
      invoiced: thousands(sum(invoicedInMonth, ringgitTotal)),
      // In ringgit: a payment of an invoice in another currency counts the ringgit it brought.
      received: thousands(sum(receivedInMonth, paymentInRinggit)),
    };
  });

  const statusCount = (status: InvoiceDisplayStatus) => invoices.filter((i) => i.display_status === status).length;

  return {
    stats: [
      // Relies on the database: an invoice that reads Sent or Overdue always has a balance above zero (one in credit reads Paid).
      // In ringgit: an invoice in another currency counts its ringgit balance.
      { label: 'Total receivable', value: rmShort(sum(open, ringgitBalance)), delta: count(open.length, 'open invoice'), deltaTone: 'flat' },
      { label: 'Due this week', value: rmShort(sum(dueThisWeek, ringgitBalance)), delta: count(dueThisWeek.length, 'invoice'), deltaTone: 'flat' },
      { label: 'Overdue', value: rmShort(sum(overdue, ringgitBalance)), delta: count(overdue.length, 'invoice'), deltaTone: overdue.length ? 'down' : 'flat' },
      { label: 'Received (MTD)', value: rmShort(sum(receivedMtd, paymentInRinggit)), delta: count(paymentCount(receivedMtd), 'payment'), deltaTone: 'flat' },
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

/**
 * The customer the filter is on. A refresh can remove the chosen customer
 * (their last invoice was deleted): the answer is then `all`, and the view
 * stores that, so the old choice does not come back by itself when that
 * customer has an invoice again.
 */
export function customerChoice(chosen: string, customers: { id: string }[]): string {
  return chosen === 'all' || customers.some((c) => c.id === chosen) ? chosen : 'all';
}

export type InvoiceAction = 'edit' | 'post' | 'delete' | 'pay' | 'credit' | 'refund' | 'einvoice' | 'void';

/**
 * What a posted invoice can still take. Each is worked out by the rule of the
 * form it opens, from rows this file does not see: payments not yet posted,
 * credit notes, and refunds that are pending.
 */
export type InvoiceCan = {
  /** A payment in: `receivableInvoices` offers the invoice. */
  pay: boolean;
  /** A credit note: `creditableInvoices` offers the invoice. */
  credit: boolean;
  /** A refund: `refundTargets` offers the invoice. */
  refund: boolean;
};

/**
 * What one invoice can still take, by what the three forms offer.
 * `refundable` is null when the credit notes or the refunds could not be
 * read: nothing can then say what a refund may be for, so none is offered.
 * Empty lists would not do instead: with no pending refund known, every
 * customer in credit would be offered a refund the form cannot check. A
 * payment in and a credit note depend on neither read: both are decided from
 * the invoice rows, which were read, and are still offered.
 */
export function invoiceCan(
  invoice: InvoiceListRow,
  offers: {
    /** `receivableInvoices`. */
    receivable: { id: string }[];
    /** `creditableInvoices`. */
    creditable: { id: string }[];
    /** `refundTargets`: invoices and credit notes. Null when they could not be worked out. */
    refundable: { kind: 'invoice' | 'credit_note'; id: string }[] | null;
  },
): InvoiceCan {
  const { receivable, creditable, refundable } = offers;
  return {
    pay: receivable.some((r) => r.id === invoice.id),
    credit: creditable.some((c) => c.id === invoice.id),
    refund: refundable !== null && refundable.some((t) => t.kind === 'invoice' && t.id === invoice.id),
  };
}

/**
 * What an invoice's row menu offers, in order: only what the database allows
 * for its status. A draft is edited, posted or deleted, never voided. A
 * posted invoice ("Sent", "Overdue", "Paid") has its e-Invois details set and
 * can be voided; it takes a payment while `can.pay` and it is not paid, a
 * credit note while `can.credit`, paid or not, and a refund while
 * `can.refund` and its customer is in credit, which only a paid invoice is.
 * Voiding one that has payments, credit notes or refunds is offered and
 * refused with the reason, as on a paid bill. A void invoice offers nothing.
 */
export function invoiceActions(invoice: InvoiceListRow, can: InvoiceCan): InvoiceAction[] {
  if (invoice.display_status === 'draft') return ['edit', 'post', 'delete'];
  if (invoice.display_status === 'void') return [];
  const offered: InvoiceAction[] = [];
  if (can.pay && invoice.display_status !== 'paid') offered.push('pay');
  if (can.credit) offered.push('credit');
  if (can.refund && inCredit(invoice) > 0) offered.push('refund');
  return [...offered, 'einvoice', 'void'];
}

/**
 * The invoices table as a CSV file. Amounts are numbers, so a spreadsheet can
 * add them up: Total − Paid − Credited + Refunded − Set off is the Balance,
 * which is below zero for a customer in credit. Set off (what contra entries
 * set off) is the last column, so the columns before it keep their places. A
 * ringgit-only workspace's export is what it was; once any invoice is in
 * another currency, every row also says its currency (the amounts before are
 * in it), its rate (ringgit per one unit), its ringgit total and balance, and
 * where a rate typed by hand came from.
 */
export function invoicesCsv(invoices: InvoiceListRow[]): string {
  const base = ['No.', 'Date', 'Customer', 'Due', 'Total', 'Paid', 'Credited', 'Refunded', 'Balance', 'Status', 'e-Invois', 'Set off'];
  const row = (i: InvoiceListRow) => [
    i.invoice_no,
    i.invoice_date,
    i.customer_name,
    i.due_date,
    i.total,
    i.paid,
    i.credited,
    i.refunded,
    owed(i),
    INVOICE_STATUS_LABELS[i.display_status],
    EINVOICE_STATUS_LABELS[i.einvoice_status],
    i.set_off ?? 0,
  ];
  if (!invoicesHaveForeign(invoices)) return toCsv(base, invoices.map(row));
  return toCsv(
    [...base, 'Currency', 'Rate (RM per unit)', 'Total (RM)', 'Balance (RM)', 'Rate source'],
    invoices.map((i) => [
      ...row(i),
      i.currency,
      // The exact text, so a spreadsheet gets every digit the invoice was posted at.
      i.fx_rate_text ?? i.fx_rate,
      i.total_myr,
      owed(i) === null ? null : i.balance_myr,
      rateSourceWords(i),
    ]),
  );
}

/**
 * Where an invoice's rate came from, in words: "Bank Negara Malaysia 5 pm selling, 15 October 2026" is not
 * built here (the date is the e-Invoice card's), only the source: BNM's rule, or the source of a typed rate
 * with its name or reference. Empty for ringgit and while there is no rate.
 */
export function rateSourceWords(i: Pick<InvoiceListRow, 'currency' | 'fx_rate_source' | 'fx_rate_provider' | 'fx_rate_reference'>): string {
  if (i.currency === 'MYR' || i.fx_rate_source === null) return '';
  if (i.fx_rate_source === 'bnm') return 'Bank Negara Malaysia, 5 pm selling';
  const provider = i.fx_rate_provider ? PROVIDER_LABELS[i.fx_rate_provider] : 'Typed by hand';
  return i.fx_rate_reference ? `${provider}: ${i.fx_rate_reference}` : provider;
}

/* ---- Payments In --------------------------------------------------- */

export function paymentsInView(rows: PaymentInRow[], today: string): PaymentsInViewData {
  const posted = received(rows);
  const mtd = posted.filter((p) => monthOf(p.txn_date) === monthOf(today));
  // In ringgit throughout: a payment of an invoice in another currency counts the ringgit it brought.
  const mtdTotal = sum(mtd, paymentInRinggit);
  const mtdCount = paymentCount(mtd);
  const electronicMtd = sum(mtd.filter((p) => ELECTRONIC.has(p.method)), paymentInRinggit);

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = posted.filter((p) => monthOf(p.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return { label, received: thousands(sum(inMonth, paymentInRinggit)) };
  });

  const methods: Slice[] = PAYMENT_METHODS.map((method) => ({
    key: method,
    label: PAYMENT_METHOD_LABELS[method],
    value: sum(mtd.filter((p) => p.method === method), paymentInRinggit),
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

/** What a payment-in row's menu offers: a received payment can be voided, and that is all. There is no edit and no delete. */
export function paymentInActions(row: PaymentInRow): 'void'[] {
  return row.status === 'posted' ? ['void'] : [];
}

/** The other invoices the same payment pays, by number. A payment split across invoices shows one row per invoice. */
export function siblingInvoices(rows: PaymentInRow[], row: PaymentInRow): string[] {
  return rows
    .filter((other) => other.transaction_id === row.transaction_id && other.allocation_id !== row.allocation_id)
    .map((other) => other.invoice_no ?? 'a draft invoice')
    .sort();
}

/** "This payment also covers INV-0007 and INV-0008." for a split payment; empty for a payment against one invoice. */
export function alsoCoversInvoices(rows: PaymentInRow[], row: PaymentInRow): string {
  return alsoCoversSentence(siblingInvoices(rows, row));
}

/**
 * The payments table as a CSV file: one line per invoice a payment pays. Amounts are numbers. Once a payment
 * of an invoice in another currency exists, four columns follow: the currency `Amount` is in, the ringgit
 * received for the line, what the invoice carried, and the realised difference.
 */
export function paymentsInCsv(rows: PaymentInRow[]): string {
  const base = ['Date', 'No.', 'Customer', 'Invoice', 'Account', 'Method', 'Amount', 'Status'];
  const row = (p: PaymentInRow) => [
    p.txn_date,
    p.number,
    p.customer_name,
    p.invoice_no,
    p.account_name,
    PAYMENT_METHOD_LABELS[p.method],
    p.amount,
    PAYMENT_IN_STATUS_LABELS[p.status],
  ];
  if (!rows.some((p) => (p.currency ?? 'MYR') !== 'MYR')) return toCsv(base, rows.map(row));
  return toCsv(
    [...base, 'Currency', 'Amount (RM)', 'Carried (RM)', 'Realised (RM)'],
    rows.map((p) => [
      ...row(p),
      p.currency ?? 'MYR',
      (p.currency ?? 'MYR') === 'MYR' ? (p.amount_myr ?? p.amount) : (p.amount_myr ?? null),
      (p.currency ?? 'MYR') === 'MYR' ? (p.carried_myr ?? p.amount) : (p.carried_myr ?? null),
      (p.currency ?? 'MYR') === 'MYR' ? (p.realised_myr ?? 0) : (p.realised_myr ?? null),
    ]),
  );
}
