/**
 * Sample cash book data (Rimba Ventures Sdn Bhd), shown on Cash Receipts,
 * Payment Vouchers and Expenses when there is no database. Raw rows in the
 * shape the data layer reads, so the screens run them through the same
 * builders as live data. The cash book lists every movement of money, so the
 * sample's payments in are its receipts and the sample's refunds are among
 * its vouchers: the same money on Payments In and on Cash Receipts, once
 * each. Each paid sample expense has the voucher that paid it.
 */
import type { CashReceiptRow, PaymentVoucherKind, PaymentVoucherRow } from '@/lib/finance/cash-book';
import type { ExpenseRow, ExpenseStatus } from '@/lib/finance/expenses';
import type { PaymentMethod } from '@/lib/finance/money';
import { SAMPLE_PAYMENTS_IN, SAMPLE_REFUNDS } from './sales-sample';

const numbered = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;
const account = (method: PaymentMethod) =>
  method === 'cash'
    ? ({ account_id: 'cash', account_name: 'Cash in hand', account_kind: 'cash' } as const)
    : ({ account_id: 'bank', account_name: 'Main Bank', account_kind: 'bank' } as const);
const newestFirst = <T>(rows: T[], date: (row: T) => string) => [...rows].sort((x, y) => date(y).localeCompare(date(x)));

/* ---- expenses -------------------------------------------------------- */

/** `paidWith` is null for an expense that has not been paid; a paid one was paid on its own date. */
const expense = (
  n: number,
  expense_date: string,
  category_name: string,
  vendor_name: string,
  amount: number,
  status: ExpenseStatus,
  paidWith: PaymentMethod | null = null,
  sst_amount: number = 0,
): ExpenseRow => ({
  id: `sample-expense-${n}`,
  expense_date,
  category_id: category_name,
  category_name,
  vendor_id: null,
  vendor_name,
  amount,
  sst_amount,
  notes: null,
  status,
  display_status: paidWith ? 'paid' : status,
  paid: paidWith ? amount : 0,
  held: 0,
  method: paidWith,
  paid_on: paidWith ? expense_date : null,
  updated_at: `${expense_date}T09:00:00.000000+00:00`,
});

/** Earlier months, so the trend has a shape: [month, rent, salaries]. All approved and paid. */
const EXPENSE_HISTORY: [string, number, number][] = [
  ['2026-03', 4500, 8300],
  ['2026-04', 4500, 8300],
  ['2026-05', 4500, 8500],
  ['2026-06', 4500, 8500],
  ['2026-07', 4500, 8700],
  ['2026-08', 4500, 8700],
  ['2026-09', 4500, 8900],
];

/** Newest first, as the real list is. */
export const SAMPLE_EXPENSES: ExpenseRow[] = newestFirst(
  [
    expense(12, '2026-10-09', 'Marketing', 'Billboard Kuala Lumpur', 3600, 'pending'),
    expense(11, '2026-10-08', 'Rent', 'Menara Axis Management', 4500, 'approved', 'bank_transfer'),
    expense(10, '2026-10-07', 'Utilities', 'Suria Utilities Sdn Bhd', 1280, 'approved', 'fpx'),
    expense(9, '2026-10-06', 'Marketing', 'Meta Ads Malaysia', 2200, 'pending'),
    expense(8, '2026-10-05', 'Travel', 'Grab Malaysia', 186, 'approved', 'ewallet'),
    expense(7, '2026-10-04', 'Supplies', 'Printhub Solutions', 640, 'approved', 'cash'),
    expense(6, '2026-10-02', 'Utilities', 'Unifi Business', 94, 'approved', 'card', 5.32),
    expense(5, '2026-10-01', 'Travel', 'AirAsia', 420, 'rejected'),
    expense(4, '2026-09-30', 'Services', 'Syarikat Guaman Lee', 1500, 'approved'),
    ...EXPENSE_HISTORY.flatMap(([month, rent, salaries], i) => [
      expense(100 + i * 2, `${month}-03`, 'Rent', 'Menara Axis Management', rent, 'approved', 'bank_transfer'),
      expense(101 + i * 2, `${month}-28`, 'Salaries', `Payroll, ${month}`, salaries, 'approved', 'bank_transfer'),
    ]),
  ],
  (row) => row.expense_date,
);

/* ---- payment vouchers ------------------------------------------------ */

const voucher = (
  id: string,
  number: string | null,
  txn_date: string,
  party_name: string,
  kind: PaymentVoucherKind,
  category_name: string | null,
  documents: string | null,
  method: PaymentMethod,
  amount: number,
  status: PaymentVoucherRow['status'] = 'posted',
): PaymentVoucherRow => ({
  transaction_id: id,
  number,
  txn_date,
  method,
  amount,
  status,
  reference: null,
  notes: null,
  ...account(method),
  contact_id: null,
  party_name,
  kind,
  // As the view gives it: a voucher that pays expenses has no category of its own, only the name its expenses share.
  category_id: kind === 'expense' ? null : category_name,
  category_name,
  documents,
  approved_at: kind === 'other' && status !== 'pending_approval' ? `${txn_date}T02:00:00Z` : null,
});

/** One voucher per paid sample expense, numbered from PV-0200 in date order. */
const EXPENSE_VOUCHERS: PaymentVoucherRow[] = [...SAMPLE_EXPENSES]
  .filter((e) => e.method !== null)
  .sort((x, y) => x.expense_date.localeCompare(y.expense_date) || x.id.localeCompare(y.id))
  .map((e, i) =>
    voucher(`sample-voucher-${e.id}`, numbered('PV', 200 + i), e.expense_date, e.vendor_name, 'expense', e.category_name, null, e.method!, e.amount),
  );

/** The sample's refunds, as the vouchers they are. */
const REFUND_VOUCHERS: PaymentVoucherRow[] = SAMPLE_REFUNDS.map((r) =>
  voucher(r.transaction_id, r.number, r.txn_date, r.customer_name, 'refund', null, r.credit_note_no ?? r.invoice_no, r.method, r.amount, r.status),
);

/** Newest first, as the real list is. */
export const SAMPLE_PAYMENT_VOUCHERS: PaymentVoucherRow[] = newestFirst(
  [
    voucher('sample-voucher-1', null, '2026-10-10', 'Tenaga Nasional Berhad', 'other', 'Utilities', null, 'bank_transfer', 960, 'scheduled'),
    voucher('sample-voucher-2', null, '2026-10-09', 'Syarikat Ramli & Anak', 'other', 'Rent', null, 'bank_transfer', 2200, 'pending_approval'),
    voucher('sample-voucher-3', null, '2026-10-06', 'Kurier Pantas Sdn Bhd', 'other', 'Services', null, 'bank_transfer', 2140, 'pending_approval'),
    voucher('sample-voucher-4', numbered('PV', 120), '2026-10-04', 'Syabas Air Selangor', 'other', 'Utilities', null, 'fpx', 420),
    voucher('sample-voucher-5', numbered('PV', 119), '2026-10-01', 'Majlis Bandaraya Shah Alam', 'other', 'Services', null, 'cash', 380),
    voucher('sample-voucher-6', null, '2026-09-28', 'Kedai Alat Tulis Maju', 'other', 'Supplies', null, 'cash', 75, 'rejected'),
    voucher('sample-voucher-7', numbered('PV', 118), '2026-10-07', 'Nusantara Logistics', 'bill', null, 'BILL-0225', 'fpx', 1180),
    voucher('sample-voucher-8', numbered('PV', 117), '2026-10-06', 'Printhub Enterprise', 'bill', null, 'BILL-0230', 'bank_transfer', 1450),
    voucher('sample-voucher-9', numbered('PV', 116), '2026-10-02', 'Kedai Kertas Ah Seng', 'bill', null, 'BILL-0224', 'cash', 1650),
    voucher('sample-voucher-10', null, '2026-10-12', 'Syarikat Maju Jaya', 'bill', null, 'BILL-0228', 'bank_transfer', 4300, 'scheduled'),
    ...REFUND_VOUCHERS,
    ...EXPENSE_VOUCHERS,
  ],
  (row) => row.txn_date,
);

/* ---- cash receipts --------------------------------------------------- */

const income = (
  n: number,
  number: string | null,
  txn_date: string,
  party_name: string,
  category_name: string,
  method: PaymentMethod,
  amount: number,
): CashReceiptRow => ({
  transaction_id: `sample-income-${n}`,
  number,
  txn_date,
  method,
  amount,
  status: number === null ? 'draft' : 'posted',
  reference: null,
  notes: null,
  ...account(method),
  contact_id: null,
  party_name,
  kind: 'income',
  category_id: category_name,
  category_name,
  documents: null,
});

/** The sample's payments in, as the receipts they are: one row per payment, with the invoices it pays. */
const INVOICE_RECEIPTS: CashReceiptRow[] = [...new Set(SAMPLE_PAYMENTS_IN.map((p) => p.transaction_id))].map((id) => {
  const parts = SAMPLE_PAYMENTS_IN.filter((p) => p.transaction_id === id);
  const first = parts[0];
  return {
    transaction_id: id,
    number: first.number,
    txn_date: first.txn_date,
    method: first.method,
    amount: first.transaction_amount,
    status: first.status,
    reference: first.reference,
    notes: null,
    ...account(first.method),
    contact_id: null,
    party_name: first.customer_name,
    kind: 'invoice',
    category_id: null,
    category_name: null,
    documents: parts
      .map((p) => p.invoice_no ?? '')
      .sort()
      .join(', '),
  };
});

/** Newest first, as the real list is. */
export const SAMPLE_CASH_RECEIPTS: CashReceiptRow[] = newestFirst(
  [
    income(7, null, '2026-10-10', 'Langkawi Fresh', 'Sales', 'cheque', 2180),
    income(6, numbered('RC', 114), '2026-10-09', 'Kedai Runcit Pak Din', 'Sales', 'cash', 850),
    income(5, numbered('RC', 113), '2026-10-06', 'Mei Ling Bakery', 'Sales', 'cash', 900),
    income(4, numbered('RC', 112), '2026-10-04', 'Tan & Sons Enterprise', 'Sales', 'duitnow', 1200),
    income(3, numbered('RC', 111), '2026-09-29', 'Bank Islam, profit paid', 'Other income', 'bank_transfer', 64.2),
    income(2, numbered('RC', 110), '2026-08-31', 'Kedai Runcit Pak Din', 'Sales', 'cash', 780),
    income(1, numbered('RC', 109), '2026-07-30', 'Mei Ling Bakery', 'Sales', 'cash', 650),
    ...INVOICE_RECEIPTS,
  ],
  (row) => row.txn_date,
);
