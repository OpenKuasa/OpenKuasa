/**
 * Sample invoices and payments in (Rimba Ventures Sdn Bhd), shown on Invoices
 * and Payments In when there is no database. Raw rows in the shape the data
 * layer reads, so both screens run them through the same builders as live
 * data and their figures agree with each other. What is credited and refunded
 * on an invoice here is what the sample credit notes and refunds come to;
 * those rows join this file with the screens that show them.
 */
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow, PaymentMethod } from '@/lib/finance/money';

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
