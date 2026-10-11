/**
 * What the Quotations, Credit Notes and Refunds screens show, worked out from
 * the rows the data layer reads. Pure, with no server imports, so the client
 * views and the tests both use it. `today` is always a YYYY-MM-DD date.
 */
import type { Slice } from '@/components/charts';
import { CREDIT_NOTE_REASONS, CREDIT_NOTE_REASON_LABELS, type CreditNoteReason, type CreditNoteRow, type CreditNoteStatus } from './credit-notes';
import { toCsv } from './csv';
import { rmShort } from './format';
import type { InvoiceListRow } from './invoices';
import { PAYMENT_METHOD_LABELS } from './money';
import type { QuotationDisplayStatus, QuotationListRow } from './quotations';
import { REFUND_REASONS, REFUND_REASON_LABELS, type RefundReason, type RefundRow } from './refunds';
import { inCredit } from './sales-views';
import { type Stat, count, lastMonths, monthOf, paymentCount, sum, thousands } from './view-helpers';

/** The customers the rows name, by name, for a customer filter. Two customers with one name stay two choices. */
export function customersOf(rows: { customer_id: string; customer_name: string }[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const row of rows) byId.set(row.customer_id, row.customer_name);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

/** The calendar year a date falls in. */
const yearOf = (iso: string) => iso.slice(0, 4);

/** One slice per reason that has an amount; with nothing at all, every reason stays so the legend still shows. */
function reasonSlices<R extends string>(
  reasons: readonly R[],
  labels: Record<R, string>,
  colors: Record<R, string>,
  amountOf: (reason: R) => number,
): Slice[] {
  const all = reasons.map((reason) => ({ key: reason, label: labels[reason], value: amountOf(reason), color: colors[reason] }));
  const used = all.filter((slice) => slice.value > 0);
  return used.length ? used : all;
}

/* ---- Quotations ---------------------------------------------------- */

export type QuotationsViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: what was quoted (and sent) and what was accepted. */
  trend: { label: string; quoted: number; accepted: number }[];
  /** Whether anything was quoted or accepted in those eight months, however little: a small amount rounds to 0 in `trend`. */
  hasTrend: boolean;
  /** This calendar quarter's quotations by how far they got: created, sent, accepted. */
  funnel: Slice[];
  /** How many quotations are dated this quarter. */
  funnelCount: number;
};

export const QUOTATION_STATUS_LABELS: Record<QuotationDisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
};

/** 2026-10-09 → 2026-Q4 */
function quarterOf(iso: string): string {
  return `${yearOf(iso)}-Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;
}

/** Sent at some point: everything but a draft. */
const wasSent = (q: QuotationListRow) => q.display_status !== 'draft';

export function quotationsView(rows: QuotationListRow[], today: string): QuotationsViewData {
  const open = rows.filter((q) => q.display_status === 'sent');
  const drafts = rows.filter((q) => q.display_status === 'draft');
  const accepted = rows.filter((q) => q.display_status === 'accepted');
  const acceptedMtd = accepted.filter((q) => q.accepted_on !== null && monthOf(q.accepted_on) === monthOf(today));
  // An answer, or the time for one ran out. Open quotations and drafts are still undecided.
  const decided = rows.filter((q) => ['accepted', 'declined', 'expired'].includes(q.display_status));
  const pipeline = [...drafts, ...open];

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const quotedInMonth = rows.filter((q) => wasSent(q) && monthOf(q.quote_date) === key);
    const acceptedInMonth = accepted.filter((q) => q.accepted_on !== null && monthOf(q.accepted_on) === key);
    if (quotedInMonth.length > 0 || acceptedInMonth.length > 0) hasTrend = true;
    return {
      label,
      quoted: thousands(sum(quotedInMonth, (q) => q.total)),
      accepted: thousands(sum(acceptedInMonth, (q) => q.total)),
    };
  });

  const thisQuarter = rows.filter((q) => quarterOf(q.quote_date) === quarterOf(today));

  return {
    stats: [
      { label: 'Open quotes', value: rmShort(sum(open, (q) => q.total)), delta: count(open.length, 'open quote'), deltaTone: 'flat' },
      { label: 'Accepted (MTD)', value: rmShort(sum(acceptedMtd, (q) => q.total)), delta: count(acceptedMtd.length, 'quotation'), deltaTone: 'flat' },
      {
        label: 'Conversion',
        value: decided.length ? `${Math.round((accepted.length / decided.length) * 100)}%` : '—',
        delta: `${accepted.length} of ${decided.length} decided`,
        deltaTone: 'flat',
      },
      { label: 'Pipeline value', value: rmShort(sum(pipeline, (q) => q.total)), delta: `${count(pipeline.length, 'quotation')}, drafts included`, deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    // No "Viewed" step: nothing tracks a customer opening a quotation.
    funnel: [
      { key: 'created', label: 'Created', value: thisQuarter.length, color: 'var(--chart-5)' },
      { key: 'sent', label: 'Sent', value: thisQuarter.filter(wasSent).length, color: 'var(--chart-1)' },
      { key: 'accepted', label: 'Accepted', value: thisQuarter.filter((q) => q.display_status === 'accepted').length, color: 'var(--chart-2)' },
    ],
    funnelCount: thisQuarter.length,
  };
}

export type QuotationFilter = 'all' | QuotationDisplayStatus;

/**
 * Quotations matching the status and customer filters whose number, customer
 * or invoice number contains the search text. The invoice is the one made
 * from the quotation; while that is a draft it has no number to match.
 */
export function filterQuotations(
  rows: QuotationListRow[],
  query: string,
  filter: QuotationFilter,
  customerId: string = 'all',
): QuotationListRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filter === 'all' || row.display_status === filter) &&
      (customerId === 'all' || row.customer_id === customerId) &&
      `${row.quotation_no ?? ''} ${row.customer_name} ${row.invoice_no ?? ''}`.toLowerCase().includes(q),
  );
}

/** The invoice made from a quotation: its number, "Draft invoice" while it has none, or nothing (null). */
export function quotationInvoice(row: QuotationListRow): string | null {
  if (row.invoice_id === null) return null;
  return row.invoice_no ?? 'Draft invoice';
}

export type QuotationAction = 'edit' | 'send' | 'delete' | 'accept' | 'decline' | 'convert';

/**
 * What a quotation's row menu offers, in order: only what the database allows
 * for its status. A draft is edited, marked as sent or deleted. Once sent it
 * is locked, and only the customer's answer is recorded: accepted or
 * declined, on an expired quotation too, since accepting late is the seller's
 * call. An accepted quotation is made into an invoice, or its answer is
 * corrected; a declined one can be corrected to accepted. Once an invoice
 * stands for the quotation the answer is frozen and it cannot be converted
 * again, so nothing is offered.
 */
export function quotationActions(row: QuotationListRow): QuotationAction[] {
  if (row.display_status === 'draft') return ['edit', 'send', 'delete'];
  if (row.invoice_id !== null) return [];
  switch (row.display_status) {
    case 'sent':
    case 'expired':
      return ['accept', 'decline'];
    case 'accepted':
      return ['convert', 'decline'];
    case 'declined':
      return ['accept'];
    default:
      return [];
  }
}

/** How a question or a menu names one quotation: its number, or "the draft quotation", and its customer. */
export function quotationName(row: QuotationListRow): string {
  return `${row.quotation_no ?? 'the draft quotation'} to ${row.customer_name}`;
}

/** The quotations table as a CSV file, its columns in the table's order. The total is a number, so a spreadsheet can add it up. */
export function quotationsCsv(rows: QuotationListRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Customer', 'Total', 'Valid until', 'Status', 'Invoice'],
    rows.map((q) => [
      q.quotation_no,
      q.quote_date,
      q.customer_name,
      q.total,
      q.valid_until,
      QUOTATION_STATUS_LABELS[q.display_status],
      quotationInvoice(q),
    ]),
  );
}

/* ---- Credit Notes -------------------------------------------------- */

export type CreditNotesViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: issued credit notes by their date. */
  trend: { label: string; credited: number }[];
  /** Whether anything was credited in those eight months, however little. */
  hasTrend: boolean;
  /** Issued credit notes dated this calendar year, in RM, per reason. */
  byReason: Slice[];
  /** Whether any credit note was issued this year. */
  hasReasons: boolean;
  creditedYtd: string;
};

export const CREDIT_NOTE_STATUS_LABELS: Record<CreditNoteStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  void: 'Void',
};

const CREDIT_REASON_COLORS: Record<CreditNoteReason, string> = {
  returns: 'var(--chart-1)',
  pricing_adjustment: 'var(--chart-4)',
  overbilling: 'var(--chart-3)',
  goodwill: 'var(--chart-5)',
  other: 'var(--chart-2)',
};

export function creditNotesView(rows: CreditNoteRow[], today: string): CreditNotesViewData {
  // Only an issued credit note has credited anything: not a draft, not a void one.
  const issued = rows.filter((n) => n.status === 'issued');
  const drafts = rows.filter((n) => n.status === 'draft');
  const mtd = issued.filter((n) => monthOf(n.credit_date) === monthOf(today));
  const ytd = issued.filter((n) => yearOf(n.credit_date) === yearOf(today));

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = issued.filter((n) => monthOf(n.credit_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return { label, credited: thousands(sum(inMonth, (n) => n.amount)) };
  });

  return {
    stats: [
      { label: 'Credited (MTD)', value: rmShort(sum(mtd, (n) => n.amount)), delta: count(mtd.length, 'credit note'), deltaTone: 'flat' },
      { label: 'Issued', value: String(issued.length), delta: 'in all', deltaTone: 'flat' },
      { label: 'Drafts', value: String(drafts.length), delta: 'not yet issued', deltaTone: 'flat' },
      { label: 'Invoices affected', value: String(new Set(issued.map((n) => n.invoice_id)).size), delta: 'with an issued credit note', deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    byReason: reasonSlices(CREDIT_NOTE_REASONS, CREDIT_NOTE_REASON_LABELS, CREDIT_REASON_COLORS, (reason) =>
      sum(ytd.filter((n) => n.reason === reason), (n) => n.amount),
    ),
    hasReasons: ytd.length > 0,
    creditedYtd: rmShort(sum(ytd, (n) => n.amount)),
  };
}

/** `open` is every credit note that is not void: what the table shows until a status is chosen. */
export type CreditNoteFilter = 'open' | CreditNoteStatus;

/** Credit notes matching the status filter whose number, customer or invoice number contains the search text. */
export function filterCreditNotes(rows: CreditNoteRow[], query: string, filter: CreditNoteFilter): CreditNoteRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (n) =>
      (filter === 'open' ? n.status !== 'void' : n.status === filter) &&
      `${n.credit_note_no ?? ''} ${n.customer_name} ${n.invoice_no ?? ''}`.toLowerCase().includes(q),
  );
}

/** What has been refunded against an issued credit note; nothing to show (null) for a draft or a void one. */
export function refundedOnNote(note: CreditNoteRow): number | null {
  return note.status === 'issued' ? note.refunded : null;
}

/** The credit notes table as a CSV file. Amounts are numbers. */
export function creditNotesCsv(rows: CreditNoteRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Customer', 'Invoice', 'Reason', 'Amount', 'Refunded', 'Status'],
    rows.map((n) => [
      n.credit_note_no,
      n.credit_date,
      n.customer_name,
      n.invoice_no,
      CREDIT_NOTE_REASON_LABELS[n.reason],
      n.amount,
      refundedOnNote(n),
      CREDIT_NOTE_STATUS_LABELS[n.status],
    ]),
  );
}

/* ---- Refunds ------------------------------------------------------- */

export type RefundsViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: refunds that were paid out, by their date. */
  trend: { label: string; refunded: number }[];
  /** Whether anything was refunded in those eight months, however little. */
  hasTrend: boolean;
  /** Refunds paid out this calendar year, in RM, per reason. */
  byReason: Slice[];
  /** Whether any refund was paid out this year. */
  hasReasons: boolean;
  refundedYtd: string;
};

/**
 * A refund is a payment out: scheduled reads "Pending" here and posted reads
 * "Refunded". One still being written (`draft`) is counted as pending by the
 * filter and the Pending card, so it reads "Pending" too.
 */
export const REFUND_STATUS_LABELS: Record<RefundRow['status'], string> = {
  draft: 'Pending',
  pending_approval: 'Pending approval',
  scheduled: 'Pending',
  posted: 'Refunded',
  rejected: 'Rejected',
  void: 'Void',
};

const REFUND_REASON_COLORS: Record<RefundReason, string> = {
  order_cancelled: 'var(--chart-1)',
  damaged_goods: 'var(--chart-4)',
  wrong_item: 'var(--chart-3)',
  overpayment: 'var(--chart-5)',
  other: 'var(--chart-2)',
};

/** Recorded but not yet money out: it holds the customer's credit. */
export function isPendingRefund(row: RefundRow): boolean {
  return row.status === 'scheduled' || row.status === 'draft' || row.status === 'pending_approval';
}

/**
 * `invoices` is every invoice of the workspace: the "In credit" card adds up
 * what customers are in credit across them, pending refunds included, since a
 * pending refund has not left the bank yet.
 */
export function refundsView(rows: RefundRow[], invoices: InvoiceListRow[], today: string): RefundsViewData {
  // Only money that has actually gone out counts as refunded: not pending, not voided.
  const paid = rows.filter((r) => r.status === 'posted');
  const pending = rows.filter(isPendingRefund);
  const mtd = paid.filter((r) => monthOf(r.txn_date) === monthOf(today));
  const ytd = paid.filter((r) => yearOf(r.txn_date) === yearOf(today));
  const credits = invoices.map(inCredit).filter((amount) => amount > 0);

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = paid.filter((r) => monthOf(r.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return { label, refunded: thousands(sum(inMonth, (r) => r.amount)) };
  });

  return {
    stats: [
      { label: 'Refunded (MTD)', value: rmShort(sum(mtd, (r) => r.amount)), delta: count(paymentCount(mtd), 'refund'), deltaTone: 'flat' },
      {
        label: 'Pending',
        value: rmShort(sum(pending, (r) => r.amount)),
        delta: count(paymentCount(pending), 'refund'),
        deltaTone: pending.length ? 'down' : 'flat',
      },
      { label: 'In credit', value: rmShort(sum(credits, (amount) => amount)), delta: count(credits.length, 'invoice'), deltaTone: 'flat' },
      { label: 'Invoices refunded', value: String(new Set(paid.map((r) => r.invoice_id)).size), delta: 'in all', deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    byReason: reasonSlices(REFUND_REASONS, REFUND_REASON_LABELS, REFUND_REASON_COLORS, (reason) =>
      sum(ytd.filter((r) => r.reason === reason), (r) => r.amount),
    ),
    hasReasons: ytd.length > 0,
    refundedYtd: rmShort(sum(ytd, (r) => r.amount)),
  };
}

/** `open` is every refund that is not void: what the table shows until a status is chosen. */
export type RefundFilter = 'open' | 'pending' | 'posted' | 'void';

/** Refunds matching the status filter whose customer, invoice, credit note, voucher number or reference contains the search text. */
export function filterRefunds(rows: RefundRow[], query: string, filter: RefundFilter): RefundRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (filter === 'open' ? r.status !== 'void' : filter === 'pending' ? isPendingRefund(r) : r.status === filter) &&
      `${r.customer_name} ${r.invoice_no ?? ''} ${r.credit_note_no ?? ''} ${r.number ?? ''} ${r.reference ?? ''}`
        .toLowerCase()
        .includes(q),
  );
}

/** The refunds table as a CSV file. Amounts are numbers. */
export function refundsCsv(rows: RefundRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Customer', 'Invoice', 'Credit note', 'Reason', 'Account', 'Method', 'Amount', 'Status'],
    rows.map((r) => [
      r.txn_date,
      r.number,
      r.customer_name,
      r.invoice_no,
      r.credit_note_no,
      REFUND_REASON_LABELS[r.reason],
      r.account_name,
      PAYMENT_METHOD_LABELS[r.method],
      r.amount,
      REFUND_STATUS_LABELS[r.status],
    ]),
  );
}
