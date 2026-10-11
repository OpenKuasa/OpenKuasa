/**
 * Sample invoices and payments in (Rimba Ventures Sdn Bhd), shown on Invoices
 * and Payments In when there is no database. Raw rows in the shape the data
 * layer reads, so both screens run them through the same builders as live
 * data and their figures agree with each other.
 */
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow, PaymentMethod } from '@/lib/finance/money';

/** The sample is a fixed month, so its figures do not drain away as the calendar moves on. */
export const SAMPLE_TODAY = '2026-10-10';

const invoice = (
  n: number,
  invoice_date: string,
  customer_name: string,
  due_date: string,
  total: number,
  display_status: InvoiceDisplayStatus,
  einvoice_status: EInvoiceStatus,
  paid: number = display_status === 'paid' ? total : 0,
): InvoiceListRow => ({
  id: `sample-invoice-${n}`,
  invoice_no: display_status === 'draft' ? null : `INV-${String(n).padStart(4, '0')}`,
  customer_id: customer_name,
  customer_name,
  invoice_date,
  due_date,
  total,
  paid,
  balance: total - paid,
  display_status,
  einvoice_status,
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
  invoice(1042, '2026-10-07', 'Aisyah Trading', '2026-11-06', 1240, 'paid', 'validated'),
  invoice(1041, '2026-10-05', 'Zaki Enterprise', '2026-11-04', 3500, 'sent', 'pending', 1000),
  invoice(1040, '2026-10-01', 'Nurul Boutique', '2026-10-08', 8900, 'overdue', 'validated'),
  invoice(1039, '2026-09-28', 'Lim Hardware Sdn Bhd', '2026-10-28', 2100, 'paid', 'validated'),
  invoice(1038, '2026-09-25', 'Siti Decor', '2026-10-25', 4200, 'paid', 'validated'),
  invoice(1037, '2026-09-20', 'Nusantara Logistics', '2026-10-15', 6400, 'sent', 'pending'),
  invoice(1036, '2026-09-14', 'Langkawi Fresh', '2026-10-14', 5600, 'paid', 'validated'),
  invoice(1035, '2026-09-10', 'Lim Hardware Sdn Bhd', '2026-09-24', 3180, 'overdue', 'validated'),
  invoice(1033, '2026-09-05', 'Nurul Boutique', '2026-10-05', 850, 'paid', 'validated'),
  invoice(1032, '2026-09-03', 'Seri Mutiara Enterprise', '2026-10-03', 3180, 'paid', 'validated'),
  invoice(1030, '2026-08-30', 'Nusantara Logistics', '2026-09-29', 6800, 'paid', 'validated'),
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
    number: `RC-${String(n).padStart(4, '0')}`,
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
