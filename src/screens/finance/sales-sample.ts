/**
 * Sample sales data (Rimba Ventures Sdn Bhd), shown on Invoices, Payments In,
 * Quotations, Credit Notes and Refunds when there is no database. Raw rows in
 * the shape the data layer reads, so every screen runs them through the same
 * builders as live data and their figures agree with each other: a credit
 * note here is taken off its invoice here, and a refund here is added back.
 */
import type { CreditNoteReason, CreditNoteRow, CreditNoteStatus } from '@/lib/finance/credit-notes';
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow, PaymentMethod } from '@/lib/finance/money';
import type { QuotationDisplayStatus, QuotationListRow } from '@/lib/finance/quotations';
import type { RefundReason, RefundRow } from '@/lib/finance/refunds';

/** The sample is a fixed month, so its figures do not drain away as the calendar moves on. */
export const SAMPLE_TODAY = '2026-10-10';

const numbered = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;

/** `credited` is what the sample's issued credit notes on the invoice come to; `refunded` its refunds that were paid out. */
const invoice = (
  n: number,
  invoice_date: string,
  customer_name: string,
  due_date: string,
  total: number,
  display_status: InvoiceDisplayStatus,
  einvoice_status: EInvoiceStatus,
  paid: number = display_status === 'paid' ? total : 0,
  credited: number = 0,
  refunded: number = 0,
): InvoiceListRow => ({
  id: `sample-invoice-${n}`,
  invoice_no: display_status === 'draft' ? null : numbered('INV', n),
  customer_id: customer_name,
  customer_name,
  invoice_date,
  due_date,
  total,
  paid,
  credited,
  refunded,
  balance: total - paid - credited + refunded,
  display_status,
  einvoice_status,
  einvoice_uuid: null,
});

/** Earlier months, so the trend has a shape: [month, invoiced and since paid in full]. */
const SAMPLE_HISTORY: [string, number][] = [
  ['2026-03', 34000],
  ['2026-04', 38000],
  ['2026-05', 36000],
  ['2026-06', 43000],
  ['2026-07', 46000],
  ['2026-08', 41200],
];

export const SAMPLE_INVOICES: InvoiceListRow[] = [
  invoice(1043, '2026-10-08', 'Seri Mutiara Enterprise', '2026-11-07', 2750, 'draft', 'none'),
  // Credited RM 240 and refunded in full.
  invoice(1042, '2026-10-07', 'Aisyah Trading', '2026-11-06', 1240, 'paid', 'validated', 1240, 240, 240),
  invoice(1041, '2026-10-05', 'Zaki Enterprise', '2026-11-04', 3500, 'sent', 'pending', 1000),
  invoice(1040, '2026-10-01', 'Nurul Boutique', '2026-10-08', 8900, 'overdue', 'validated'),
  invoice(1039, '2026-09-28', 'Lim Hardware Sdn Bhd', '2026-10-28', 2100, 'paid', 'validated', 2100, 450, 450),
  // Credited RM 600 and not refunded: the customer is in credit.
  invoice(1038, '2026-09-25', 'Siti Decor', '2026-10-25', 4200, 'paid', 'validated', 4200, 600),
  // Not paid yet: the credit note of RM 520 lowers what is owed.
  invoice(1037, '2026-09-20', 'Nusantara Logistics', '2026-10-15', 6400, 'sent', 'pending', 0, 520),
  invoice(1036, '2026-09-14', 'Langkawi Fresh', '2026-10-14', 5600, 'paid', 'validated', 5600, 180, 180),
  invoice(1035, '2026-09-10', 'Lim Hardware Sdn Bhd', '2026-09-24', 3180, 'overdue', 'validated'),
  // In credit while their refunds are pending.
  invoice(1033, '2026-09-05', 'Nurul Boutique', '2026-10-05', 850, 'paid', 'validated', 850, 680),
  invoice(1032, '2026-09-03', 'Seri Mutiara Enterprise', '2026-10-03', 3180, 'paid', 'validated', 3180, 900, 900),
  invoice(1030, '2026-08-30', 'Nusantara Logistics', '2026-09-29', 6800, 'paid', 'validated', 6800, 320),
  // Newest first, as the real list is: the history is stored oldest first.
  ...SAMPLE_HISTORY.map(([month, total], i) =>
    invoice(1006 - i, `${month}-12`, 'Aisyah Trading', `${month}-26`, total, 'paid', 'validated'),
  ).reverse(),
];

const invoiceNumbered = (n: number): InvoiceListRow => {
  const found = SAMPLE_INVOICES.find((i) => i.id === `sample-invoice-${n}`);
  if (!found) throw new Error(`no sample invoice ${n}`);
  return found;
};

const receipt = (n: number, txn_date: string, invoiceNo: number, method: PaymentMethod, amount?: number): PaymentInRow => {
  const paid = invoiceNumbered(invoiceNo);
  return {
    allocation_id: `sample-receipt-${n}`,
    transaction_id: `sample-receipt-${n}`,
    number: numbered('RC', n),
    txn_date,
    method,
    amount: amount ?? paid.total,
    transaction_amount: amount ?? paid.total,
    status: 'posted',
    reference: null,
    account_id: method === 'cash' ? 'cash' : 'bank',
    account_name: method === 'cash' ? 'Cash in hand' : 'Main Bank',
    invoice_id: paid.id,
    invoice_no: paid.invoice_no,
    customer_name: paid.customer_name,
  };
};

export const SAMPLE_PAYMENTS_IN: PaymentInRow[] = [
  receipt(108, '2026-10-08', 1042, 'fpx'),
  receipt(107, '2026-10-08', 1041, 'fpx', 1000),
  receipt(106, '2026-10-07', 1036, 'fpx'),
  receipt(105, '2026-10-05', 1039, 'bank_transfer'),
  receipt(104, '2026-10-04', 1038, 'card'),
  receipt(103, '2026-10-03', 1032, 'duitnow'),
  receipt(102, '2026-10-02', 1033, 'cash'),
  receipt(101, '2026-09-30', 1030, 'bank_transfer'),
  // Newest first, as the real list is: the history is stored oldest first.
  ...SAMPLE_HISTORY.map(([month], i) => receipt(96 - i, `${month}-24`, 1006 - i, 'bank_transfer')).reverse(),
];

/* ---- quotations ------------------------------------------------------ */

const quotation = (
  n: number,
  quote_date: string,
  customer_name: string,
  valid_until: string,
  total: number,
  display_status: QuotationDisplayStatus,
  accepted_on: string | null = null,
): QuotationListRow => ({
  id: `sample-quotation-${n}`,
  quotation_no: display_status === 'draft' ? null : numbered('QT', n),
  customer_id: customer_name,
  customer_name,
  quote_date,
  valid_until,
  total,
  display_status,
  accepted_on,
  invoice_id: null,
  invoice_no: null,
});

/** Newest first, as the real list is. */
export const SAMPLE_QUOTATIONS: QuotationListRow[] = [
  quotation(228, '2026-10-09', 'Nurul Boutique', '2026-11-08', 2400, 'draft'),
  quotation(227, '2026-10-08', 'Seri Mutiara Enterprise', '2026-11-07', 6200, 'sent'),
  quotation(226, '2026-10-07', 'Langkawi Fresh', '2026-11-06', 4800, 'sent'),
  quotation(225, '2026-10-06', 'Aisyah Trading', '2026-11-05', 12000, 'accepted', '2026-10-08'),
  quotation(224, '2026-10-04', 'Zaki Enterprise', '2026-11-03', 9500, 'sent'),
  quotation(223, '2026-09-29', 'Lim Hardware Sdn Bhd', '2026-10-29', 7500, 'accepted', '2026-10-02'),
  quotation(220, '2026-09-20', 'Aisyah Trading', '2026-10-20', 8400, 'accepted', '2026-09-25'),
  quotation(219, '2026-09-16', 'Langkawi Fresh', '2026-10-16', 3600, 'declined'),
  quotation(222, '2026-09-12', 'Siti Decor', '2026-09-27', 3200, 'expired'),
  quotation(221, '2026-09-02', 'Nusantara Logistics', '2026-09-17', 5800, 'expired'),
  // Earlier months, so the trend has a shape.
  quotation(212, '2026-08-12', 'Aisyah Trading', '2026-09-11', 18000, 'accepted', '2026-08-20'),
  quotation(208, '2026-07-12', 'Zaki Enterprise', '2026-08-11', 9000, 'declined'),
  quotation(205, '2026-06-12', 'Siti Decor', '2026-07-12', 14000, 'accepted', '2026-06-21'),
  quotation(203, '2026-05-12', 'Lim Hardware Sdn Bhd', '2026-06-11', 11000, 'accepted', '2026-05-20'),
  quotation(201, '2026-04-12', 'Nusantara Logistics', '2026-05-12', 7500, 'expired'),
];

/* ---- credit notes ---------------------------------------------------- */

/** `refunded` is what was paid out against the note itself; a refund put against the invoice is not counted on the note. */
const creditNote = (
  n: number,
  credit_date: string,
  invoiceNo: number,
  reason: CreditNoteReason,
  amount: number,
  status: CreditNoteStatus,
  refunded: number = 0,
): CreditNoteRow => {
  const against = invoiceNumbered(invoiceNo);
  return {
    id: `sample-credit-note-${n}`,
    credit_note_no: status === 'draft' ? null : numbered('CN', n),
    invoice_id: against.id,
    invoice_no: against.invoice_no,
    customer_id: against.customer_id,
    customer_name: against.customer_name,
    credit_date,
    reason,
    amount,
    refunded,
    status,
    notes: null,
  };
};

/** Newest first, as the real list is. */
export const SAMPLE_CREDIT_NOTES: CreditNoteRow[] = [
  creditNote(38, '2026-10-09', 1041, 'pricing_adjustment', 300, 'draft'),
  creditNote(34, '2026-10-09', 1042, 'returns', 240, 'issued', 240),
  creditNote(37, '2026-10-08', 1037, 'goodwill', 520, 'issued'),
  creditNote(35, '2026-10-08', 1036, 'returns', 180, 'issued', 180),
  creditNote(36, '2026-10-07', 1032, 'returns', 900, 'issued', 900),
  creditNote(31, '2026-10-07', 1033, 'returns', 680, 'issued'),
  // Refunded against its invoice, INV-1039, not against the note.
  creditNote(33, '2026-10-06', 1039, 'overbilling', 450, 'issued'),
  creditNote(32, '2026-10-06', 1038, 'pricing_adjustment', 600, 'issued'),
  creditNote(30, '2026-10-04', 1030, 'overbilling', 320, 'issued'),
];

/* ---- refunds --------------------------------------------------------- */

/** `voucher` is null for a refund that is still pending. `noteNo` is null for a refund put against the invoice itself. */
const refund = (
  n: number,
  voucher: number | null,
  txn_date: string,
  invoiceNo: number,
  noteNo: number | null,
  method: PaymentMethod,
  reason: RefundReason,
  amount: number,
): RefundRow => {
  const against = invoiceNumbered(invoiceNo);
  return {
    allocation_id: `sample-refund-${n}`,
    transaction_id: `sample-refund-${n}`,
    number: voucher === null ? null : numbered('PV', voucher),
    txn_date,
    method,
    amount,
    transaction_amount: amount,
    status: voucher === null ? 'scheduled' : 'posted',
    reference: null,
    reason,
    notes: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    invoice_id: against.id,
    invoice_no: against.invoice_no,
    credit_note_id: noteNo === null ? null : `sample-credit-note-${noteNo}`,
    credit_note_no: noteNo === null ? null : numbered('CN', noteNo),
    customer_id: against.customer_id,
    customer_name: against.customer_name,
  };
};

/** Newest first, as the real list is. */
export const SAMPLE_REFUNDS: RefundRow[] = [
  refund(6, null, '2026-10-10', 1033, 31, 'duitnow', 'wrong_item', 680),
  refund(5, 4, '2026-10-10', 1042, 34, 'fpx', 'damaged_goods', 240),
  refund(4, null, '2026-10-09', 1030, 30, 'bank_transfer', 'overpayment', 320),
  refund(3, 3, '2026-10-09', 1036, 35, 'fpx', 'damaged_goods', 180),
  refund(2, 2, '2026-10-08', 1032, 36, 'bank_transfer', 'order_cancelled', 900),
  refund(1, 1, '2026-10-07', 1039, null, 'bank_transfer', 'overpayment', 450),
];
