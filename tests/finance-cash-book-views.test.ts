import { describe, expect, it } from 'vitest';
import type { CashReceiptRow, PaymentVoucherRow } from '@/lib/finance/cash-book';
import type { CashBookPeriod } from '@/lib/finance/cash-book-views';
import {
  CASH_BOOK_PERIODS,
  cashBookCountLine,
  emptyPeriodText,
  nothingInPeriod,
  CASH_BOOK_PERIOD_LABELS,
  CASH_RECEIPT_STATUS_LABELS,
  DONUT_SLICES,
  EXPENSE_STATUS_LABELS,
  PAYMENT_VOUCHER_KIND_LABELS,
  PAYMENT_VOUCHER_STATUS_LABELS,
  cashReceiptsCsv,
  cashReceiptsInPeriod,
  cashReceiptsView,
  expenseCategories,
  expenseMethod,
  expensesCsv,
  expensesView,
  filterCashReceipts,
  filterExpenses,
  filterPaymentVouchers,
  inPeriod,
  isApprovedExpense,
  isWaitingVoucher,
  paymentVouchersCsv,
  paymentVouchersInPeriod,
  paymentVouchersView,
  receiptFor,
  receiptHiddenNote,
  voucherCategory,
  voucherHome,
} from '@/lib/finance/cash-book-views';
import { CSV_BOM } from '@/lib/finance/csv';
import type { ExpenseRow } from '@/lib/finance/expenses';
import { rmShort } from '@/lib/finance/format';
import { paymentCount, sum } from '@/lib/finance/view-helpers';
import { SAMPLE_CASH_RECEIPTS, SAMPLE_EXPENSES, SAMPLE_PAYMENT_VOUCHERS } from '@/screens/finance/cash-book-sample';
import { SAMPLE_PAYMENTS_IN, SAMPLE_REFUNDS, SAMPLE_TODAY } from '@/screens/finance/sales-sample';

const today = '2026-10-09';

let seq = 0;
const receipt = (r: Partial<CashReceiptRow> = {}): CashReceiptRow => {
  seq += 1;
  return {
    transaction_id: `receipt-${seq}`,
    number: `RC-${String(seq).padStart(4, '0')}`,
    txn_date: '2026-10-05',
    method: 'fpx',
    amount: 100,
    status: 'posted',
    reference: null,
    notes: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    account_kind: 'bank',
    contact_id: null,
    party_name: 'Aisyah Trading',
    kind: 'invoice',
    category_id: null,
    category_name: null,
    documents: 'INV-0001',
    ...r,
  };
};
const cash = (r: Partial<CashReceiptRow> = {}) =>
  receipt({ account_id: 'cash', account_name: 'Cash in hand', account_kind: 'cash', method: 'cash', kind: 'income', documents: null, category_name: 'Sales', ...r });

/** A voucher as the view gives it: one that pays expenses has no category of its own, only the name its expenses share. */
const voucher = (v: Partial<PaymentVoucherRow> = {}): PaymentVoucherRow => {
  seq += 1;
  const kind = v.kind ?? 'other';
  return {
    transaction_id: `voucher-${seq}`,
    number: `PV-${String(seq).padStart(4, '0')}`,
    txn_date: '2026-10-05',
    method: 'fpx',
    amount: 100,
    status: 'posted',
    reference: null,
    notes: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    account_kind: 'bank',
    contact_id: null,
    party_name: 'Syabas',
    kind,
    category_id: kind === 'other' ? 'utilities' : null,
    category_name: 'Utilities',
    documents: null,
    approved_at: null,
    ...v,
  };
};

const expense = (e: Partial<ExpenseRow> = {}): ExpenseRow => {
  seq += 1;
  return {
    id: `expense-${seq}`,
    expense_date: '2026-10-05',
    category_id: 'rent',
    category_name: 'Rent',
    vendor_id: null,
    vendor_name: 'Menara Axis',
    amount: 100,
    sst_amount: 0,
    notes: null,
    status: 'approved',
    display_status: 'approved',
    paid: 0,
    held: 0,
    method: null,
    paid_on: null,
    updated_at: '2026-10-05T09:00:00.000000+00:00',
    ...e,
  };
};

const stat = (stats: { label: string; value: string; delta?: string }[], label: string) => stats.find((s) => s.label === label)!;

describe('the period selector', () => {
  it('offers this month, this quarter, this year and all time, last, and says so in a person’s words', () => {
    expect(CASH_BOOK_PERIODS).toEqual(['month', 'quarter', 'year', 'all']);
    expect(CASH_BOOK_PERIOD_LABELS).toEqual({ month: 'This month', quarter: 'This quarter', year: 'This year', all: 'All time' });
  });
  it('puts every date in All time, however far from today', () => {
    expect(inPeriod('1999-01-01', today, 'all')).toBe(true);
    expect(inPeriod('2031-12-31', today, 'all')).toBe(true);
  });
  it('words an empty chart without saying "all time" as if it were a month', () => {
    expect(nothingInPeriod('received', 'month')).toBe('Nothing received this month.');
    expect(nothingInPeriod('paid out', 'year')).toBe('Nothing paid out this year.');
    expect(nothingInPeriod('received', 'all')).toBe('Nothing received yet.');
  });
  it('only tells a person to choose a longer period when there is one', () => {
    expect(emptyPeriodText('receipts', 'month')).toBe('Nothing in this period. Choose a longer one to see earlier receipts.');
    expect(emptyPeriodText('vouchers', 'year')).toBe('Nothing in this period. Choose a longer one to see earlier vouchers.');
    expect(emptyPeriodText('vouchers', 'all')).toBe('Nothing here.');
  });
  it('words the cards for All time as "all time"', () => {
    const view = cashReceiptsView([cash({ amount: 250, txn_date: '2020-01-01' })], today, 'all');
    expect(stat(view.stats, 'Received')).toMatchObject({ value: 'RM 250', delta: 'all time' });
  });
  it('places a date by the calendar: month, quarter and year of today', () => {
    expect(inPeriod('2026-10-01', today, 'month')).toBe(true);
    expect(inPeriod('2026-09-30', today, 'month')).toBe(false);
    expect(inPeriod('2026-11-30', today, 'quarter')).toBe(true);
    expect(inPeriod('2026-09-30', today, 'quarter')).toBe(false);
    expect(inPeriod('2026-01-01', today, 'year')).toBe(true);
    expect(inPeriod('2025-12-31', today, 'year')).toBe(false);
    // Another year's October is not this month.
    expect(inPeriod('2025-10-09', today, 'month')).toBe(false);
    expect(inPeriod('2025-11-09', today, 'quarter')).toBe(false);
  });
});

describe('the edges of a period', () => {
  const received = (date: string, today: string, period: 'month' | 'quarter' | 'year') =>
    stat(cashReceiptsView([cash({ amount: 250, txn_date: date })], today, period).stats, 'Received').value;

  it('puts the last day of a month in that month and the first of the next out of it', () => {
    expect(received('2026-09-30', '2026-09-30', 'month')).toBe('RM 250');
    expect(received('2026-10-01', '2026-09-30', 'month')).toBe('RM 0');
    expect(received('2026-09-30', '2026-10-01', 'month')).toBe('RM 0');
    expect(received('2026-10-01', '2026-10-01', 'month')).toBe('RM 250');
  });
  it('puts 30 September in the third quarter and 1 October in the fourth', () => {
    expect(received('2026-09-30', '2026-09-30', 'quarter')).toBe('RM 250');
    expect(received('2026-10-01', '2026-09-30', 'quarter')).toBe('RM 0');
    expect(received('2026-09-30', '2026-10-01', 'quarter')).toBe('RM 0');
    expect(received('2026-10-01', '2026-10-01', 'quarter')).toBe('RM 250');
  });
  it('keeps the previous quarter, dated in the previous year, out of January’s quarter', () => {
    expect(received('2025-12-31', '2026-01-15', 'quarter')).toBe('RM 0');
    expect(received('2025-10-01', '2026-01-15', 'quarter')).toBe('RM 0');
    expect(received('2026-03-31', '2026-01-15', 'quarter')).toBe('RM 250');
    expect(received('2026-04-01', '2026-01-15', 'quarter')).toBe('RM 0');
    expect(received('2025-12-31', '2026-01-15', 'year')).toBe('RM 0');
    expect(received('2026-01-01', '2026-01-15', 'year')).toBe('RM 250');
  });
  it('counts a leap day in February and in the first quarter of that year', () => {
    expect(received('2028-02-29', '2028-02-15', 'month')).toBe('RM 250');
    expect(received('2028-02-29', '2028-03-01', 'month')).toBe('RM 0');
    expect(received('2028-02-29', '2028-01-10', 'quarter')).toBe('RM 250');
    expect(received('2028-02-29', '2028-04-01', 'quarter')).toBe('RM 0');
  });
});

describe('donut slices are told apart by what they are, not by their name', () => {
  it('keeps two categories of one name as two slices on Payment Vouchers', () => {
    const rows = [
      voucher({ amount: 300, category_id: 'rent-a', category_name: 'Rent' }),
      voucher({ amount: 200, category_id: 'rent-b', category_name: 'Rent' }),
      voucher({ amount: 100, category_id: 'rent-a', category_name: 'Rent' }),
    ];
    const view = paymentVouchersView(rows, today, 'month');
    expect(view.byCategory.map((s) => [s.label, s.value])).toEqual([['Rent', 400], ['Rent', 200]]);
    expect(new Set(view.byCategory.map((s) => s.key)).size).toBe(2);
  });
  it('gives vouchers that pay expenses a slice per category of those expenses', () => {
    // As the view gives them: a voucher for expenses has no category of its own, only the name its expenses share.
    const rows = [
      voucher({ amount: 4500, kind: 'expense', category_id: null, category_name: 'Rent' }),
      voucher({ amount: 8900, kind: 'expense', category_id: null, category_name: 'Salaries' }),
      voucher({ amount: 1280, kind: 'expense', category_id: null, category_name: 'Utilities' }),
      voucher({ amount: 94, kind: 'expense', category_id: null, category_name: 'Utilities' }),
      voucher({ amount: 420, kind: 'other', category_id: 'utilities', category_name: 'Utilities' }),
    ];
    const view = paymentVouchersView(rows, today, 'month');
    // The two Utilities slices stay apart: one is the expenses' category, known here by name only, and the other the
    // voucher's own, known by its id. Making them one needs the view to give the id of the expenses' category.
    expect(view.byCategory.map((s) => [s.label, s.value])).toEqual([
      ['Salaries', 8900], ['Rent', 4500], ['Utilities', 1374], ['Utilities', 420],
    ]);
    expect(sum(view.byCategory, (s) => s.value)).toBe(15194);
  });
  it('keeps two categories of one name as two slices on Expenses', () => {
    const rows = [
      expense({ category_id: 'travel-a', category_name: 'Travel', amount: 500 }),
      expense({ category_id: 'travel-b', category_name: 'Travel', amount: 300 }),
    ];
    const view = expensesView(rows, today);
    expect(view.byCategory.map((s) => [s.label, s.value])).toEqual([['Travel', 500], ['Travel', 300]]);
    expect(stat(view.stats, 'Top category')).toMatchObject({ value: 'Travel', delta: '63% of spend this year' });
  });
  it('keeps two accounts of one name as two slices on Cash Receipts', () => {
    const rows = [receipt({ account_id: 'a1', account_name: 'Bank', amount: 700 }), receipt({ account_id: 'a2', account_name: 'Bank', amount: 100 })];
    expect(cashReceiptsView(rows, today, 'month').byAccount.map((s) => [s.label, s.value])).toEqual([['Bank', 700], ['Bank', 100]]);
  });
});

describe('cashReceiptsView', () => {
  it('counts only posted receipts dated in the period: not a draft, not a void one', () => {
    const rows = [
      receipt({ amount: 300 }),
      cash({ amount: 100 }),
      receipt({ amount: 9999, status: 'draft', number: null }),
      receipt({ amount: 9999, status: 'void' }),
      receipt({ amount: 50, txn_date: '2026-08-15' }),
    ];
    const month = cashReceiptsView(rows, today, 'month');
    expect(stat(month.stats, 'Received')).toMatchObject({ value: 'RM 400', delta: 'this month' });
    expect(stat(month.stats, 'Receipts')).toMatchObject({ value: '2', delta: '1 draft not yet posted' });
    expect(stat(month.stats, 'Average receipt').value).toBe('RM 200');
    expect(stat(month.stats, 'Into the bank').value).toBe('75%');
    expect(month.received).toBe('RM 400');
    expect(month.hasReceived).toBe(true);
    const year = cashReceiptsView(rows, today, 'year');
    expect(stat(year.stats, 'Received')).toMatchObject({ value: 'RM 450', delta: 'this year' });
    expect(stat(year.stats, 'Receipts').value).toBe('3');
    // August is in the third quarter.
    expect(stat(cashReceiptsView(rows, today, 'quarter').stats, 'Received').value).toBe('RM 400');
  });
  it('splits each account its own slice, largest first, and the trend into bank and cash', () => {
    const rows = [receipt({ amount: 1000 }), cash({ amount: 3000 }), cash({ amount: 500, txn_date: '2026-09-02' })];
    const view = cashReceiptsView(rows, today, 'month');
    expect(view.byAccount.map((s) => [s.label, s.value])).toEqual([['Cash in hand', 3000], ['Main Bank', 1000]]);
    expect(new Set(view.byAccount.map((s) => s.key)).size).toBe(2);
    expect(view.trend).toHaveLength(8);
    expect(view.trend[7]).toEqual({ label: 'Oct', bank: 1, cash: 3 });
    expect(view.trend[6]).toEqual({ label: 'Sep', bank: 0, cash: 0.5 });
    expect(view.hasTrend).toBe(true);
  });
  it('says there is a trend for a receipt too small to show in thousands, and none when nothing was posted', () => {
    expect(cashReceiptsView([cash({ amount: 4 })], today, 'month').hasTrend).toBe(true);
    expect(cashReceiptsView([cash({ amount: 4 })], today, 'month').trend[7]).toEqual({ label: 'Oct', bank: 0, cash: 0 });
    const empty = cashReceiptsView([receipt({ status: 'draft' })], today, 'month');
    expect(empty.hasTrend).toBe(false);
    expect(empty.hasReceived).toBe(false);
    expect(empty.byAccount).toEqual([]);
    expect(stat(empty.stats, 'Average receipt').value).toBe('—');
    expect(stat(empty.stats, 'Into the bank').value).toBe('—');
    expect(stat(empty.stats, 'Receipts')).toMatchObject({ value: '0', delta: '1 draft not yet posted' });
  });
  it('adds amounts in sen, so thirty receipts of ten sen are three ringgit', () => {
    const rows = Array.from({ length: 30 }, () => cash({ amount: 0.1 }));
    expect(cashReceiptsView(rows, today, 'month').byAccount[0].value).toBe(3);
  });
});

describe('a receipt in the table', () => {
  it('says what it is for: its invoices, or its category', () => {
    expect(receiptFor(receipt({ documents: 'INV-0001, INV-0002' }))).toBe('INV-0001, INV-0002');
    expect(receiptFor(receipt({ documents: null }))).toBe('Invoices');
    expect(receiptFor(cash())).toBe('Sales');
    expect(receiptFor(cash({ category_name: null }))).toBe('—');
  });
  it('has a word for every status', () => {
    expect(CASH_RECEIPT_STATUS_LABELS).toMatchObject({ draft: 'Draft', posted: 'Posted', void: 'Void' });
    expect(Object.values(CASH_RECEIPT_STATUS_LABELS).every((label) => label.length > 0)).toBe(true);
  });
  it('is found by its number, payer, invoice, category or reference, within the status chosen', () => {
    const rows = [
      receipt({ number: 'RC-0101', party_name: 'Aisyah Trading', documents: 'INV-1042' }),
      cash({ number: 'RC-0102', party_name: 'Walk-in', reference: 'TILL 7' }),
      receipt({ number: null, status: 'draft', party_name: 'Langkawi Fresh' }),
      receipt({ number: 'RC-0099', status: 'void', party_name: 'Zaki Enterprise' }),
    ];
    expect(filterCashReceipts(rows, '', 'open')).toHaveLength(3);
    expect(filterCashReceipts(rows, '', 'void').map((r) => r.party_name)).toEqual(['Zaki Enterprise']);
    expect(filterCashReceipts(rows, '', 'draft').map((r) => r.party_name)).toEqual(['Langkawi Fresh']);
    expect(filterCashReceipts(rows, '', 'posted')).toHaveLength(2);
    expect(filterCashReceipts(rows, ' inv-1042 ', 'open').map((r) => r.number)).toEqual(['RC-0101']);
    expect(filterCashReceipts(rows, 'sales', 'open').map((r) => r.number)).toEqual(['RC-0102']);
    expect(filterCashReceipts(rows, 'till', 'open').map((r) => r.number)).toEqual(['RC-0102']);
    expect(filterCashReceipts(rows, 'zaki', 'open')).toEqual([]);
  });
  it('exports with the table’s columns and amounts as numbers', () => {
    const csv = cashReceiptsCsv([cash({ number: 'RC-0102', party_name: 'Walk-in', amount: 80.5, reference: '=SUM(A1)' }), receipt({ number: null, status: 'draft', party_name: null })]);
    const lines = csv.slice(CSV_BOM.length).split('\r\n');
    expect(lines[0]).toBe('Date,No.,Received from,For,Account,Method,Reference,Amount,Status');
    expect(lines[1]).toBe("2026-10-05,RC-0102,Walk-in,Sales,Cash in hand,Cash,'=SUM(A1),80.5,Posted");
    expect(lines[2]).toBe('2026-10-05,,,INV-0001,Main Bank,FPX,,100,Draft');
  });
});

describe('paymentVouchersView', () => {
  it('counts only vouchers that were paid in the period, and what is waiting whatever its date', () => {
    const rows = [
      voucher({ amount: 300 }),
      voucher({ amount: 100, kind: 'bill', category_name: null, documents: 'BILL-0001' }),
      voucher({ amount: 2200, status: 'pending_approval', number: null, txn_date: '2026-07-01' }),
      voucher({ amount: 960, status: 'scheduled', number: null }),
      voucher({ amount: 9999, status: 'rejected', number: null }),
      voucher({ amount: 9999, status: 'void' }),
      voucher({ amount: 50, txn_date: '2026-08-15' }),
    ];
    const month = paymentVouchersView(rows, today, 'month');
    expect(stat(month.stats, 'Paid')).toMatchObject({ value: 'RM 400', delta: 'this month' });
    expect(stat(month.stats, 'Vouchers')).toMatchObject({ value: '2', delta: '1 more to be paid' });
    expect(stat(month.stats, 'Pending approval')).toMatchObject({ value: 'RM 2,200', delta: '1 voucher', deltaTone: 'down' });
    expect(stat(month.stats, 'Average voucher').value).toBe('RM 200');
    expect(stat(paymentVouchersView(rows, today, 'year').stats, 'Paid').value).toBe('RM 450');
    expect(month.paid).toBe('RM 400');
  });
  it('puts supplier payments and refunds in a category each, and the rest under their own', () => {
    const rows = [
      voucher({ amount: 500, kind: 'bill', category_name: null }),
      voucher({ amount: 200, kind: 'refund', category_name: null }),
      voucher({ amount: 300, kind: 'expense', category_name: 'Rent' }),
      voucher({ amount: 100, kind: 'other', category_name: 'Rent' }),
      voucher({ amount: 50, kind: 'expense', category_name: null }),
      voucher({ amount: 25, kind: 'other', category_name: null }),
    ];
    expect(rows.map(voucherCategory)).toEqual(['Supplier bills', 'Refunds', 'Rent', 'Rent', 'Several categories', 'No category']);
    const view = paymentVouchersView(rows, today, 'month');
    // Rent is two slices: the expenses' category, which the view names without an id, and the other voucher's own.
    expect(view.byCategory.map((s) => [s.label, s.value])).toEqual([
      ['Supplier bills', 500], ['Rent', 300], ['Refunds', 200], ['Rent', 100], ['Other categories', 75],
    ]);
    // The slices add up to what was paid: nothing is counted twice and nothing dropped.
    expect(sum(view.byCategory, (s) => s.value)).toBe(1175);
    expect(view.byCategory).toHaveLength(DONUT_SLICES + 1);
  });
  it('has nothing to chart when nothing was paid, and no alarm when nothing is waiting', () => {
    const view = paymentVouchersView([voucher({ status: 'scheduled', number: null })], today, 'month');
    expect(view.hasPaid).toBe(false);
    expect(view.hasTrend).toBe(false);
    expect(view.byCategory).toEqual([]);
    expect(stat(view.stats, 'Pending approval')).toMatchObject({ value: 'RM 0', delta: '0 vouchers', deltaTone: 'flat' });
    expect(stat(view.stats, 'Average voucher').value).toBe('—');
    expect(paymentVouchersView([voucher({ amount: 3 })], today, 'month').hasTrend).toBe(true);
  });
});

describe('a voucher in the table', () => {
  it('names the screen it is changed on when that is not this one', () => {
    expect(voucherHome('bill')).toEqual({ label: 'Payments Out', href: '/finance/payments-out' });
    expect(voucherHome('refund')).toEqual({ label: 'Refunds', href: '/finance/refunds' });
    expect(voucherHome('expense')).toBeNull();
    expect(voucherHome('other')).toBeNull();
  });
  it('has a word for every status and every kind', () => {
    expect(PAYMENT_VOUCHER_STATUS_LABELS).toMatchObject({
      pending_approval: 'Pending approval', scheduled: 'To be paid', posted: 'Paid', rejected: 'Rejected', void: 'Void',
    });
    expect(PAYMENT_VOUCHER_KIND_LABELS).toEqual({ bill: 'Supplier payment', refund: 'Refund', expense: 'Expense', other: 'Other payment' });
  });
  it('is waiting only while it is pending approval', () => {
    expect(isWaitingVoucher(voucher({ status: 'pending_approval' }))).toBe(true);
    for (const status of ['draft', 'scheduled', 'posted', 'rejected', 'void'] as const) {
      expect(isWaitingVoucher(voucher({ status })), status).toBe(false);
    }
  });
  it('is found by status, by kind and by what it says', () => {
    const rows = [
      voucher({ number: 'PV-0001', party_name: 'Syabas', kind: 'other', category_name: 'Utilities' }),
      voucher({ number: 'PV-0002', party_name: 'Lim Hardware', kind: 'bill', category_name: null, documents: 'BILL-0221' }),
      voucher({ number: null, party_name: 'Ramli', status: 'pending_approval', reference: 'OCT RENT' }),
      voucher({ number: null, party_name: 'TNB', status: 'scheduled' }),
      voucher({ number: null, party_name: 'Maju', status: 'rejected' }),
      voucher({ number: 'PV-0003', party_name: 'Gone', status: 'void' }),
      voucher({ number: null, party_name: 'Half written', status: 'draft' }),
    ];
    expect(filterPaymentVouchers(rows, '', 'open').map((v) => v.party_name)).toEqual(['Syabas', 'Lim Hardware', 'Ramli', 'TNB', 'Half written']);
    expect(filterPaymentVouchers(rows, '', 'waiting').map((v) => v.party_name)).toEqual(['Ramli']);
    expect(filterPaymentVouchers(rows, '', 'scheduled').map((v) => v.party_name)).toEqual(['TNB']);
    expect(filterPaymentVouchers(rows, '', 'posted')).toHaveLength(2);
    expect(filterPaymentVouchers(rows, '', 'rejected').map((v) => v.party_name)).toEqual(['Maju']);
    expect(filterPaymentVouchers(rows, '', 'void').map((v) => v.party_name)).toEqual(['Gone']);
    expect(filterPaymentVouchers(rows, '', 'open', 'bill').map((v) => v.number)).toEqual(['PV-0002']);
    expect(filterPaymentVouchers(rows, 'bill-0221', 'open').map((v) => v.number)).toEqual(['PV-0002']);
    expect(filterPaymentVouchers(rows, 'supplier bills', 'open').map((v) => v.number)).toEqual(['PV-0002']);
    expect(filterPaymentVouchers(rows, 'oct rent', 'open').map((v) => v.party_name)).toEqual(['Ramli']);
  });
  it('is found by the words in its Kind column', () => {
    const rows = [
      voucher({ number: 'PV-0001', kind: 'other', category_name: 'Utilities' }),
      voucher({ number: 'PV-0002', kind: 'bill', category_id: null, category_name: null, documents: 'BILL-0221' }),
      voucher({ number: 'PV-0003', kind: 'refund', category_id: null, category_name: null, documents: 'CN-0004' }),
      voucher({ number: 'PV-0004', kind: 'expense', category_id: null, category_name: 'Rent' }),
    ];
    expect(filterPaymentVouchers(rows, 'supplier payment', 'open').map((v) => v.number)).toEqual(['PV-0002']);
    expect(filterPaymentVouchers(rows, ' Other Payment ', 'open').map((v) => v.number)).toEqual(['PV-0001']);
    expect(filterPaymentVouchers(rows, 'expense', 'open').map((v) => v.number)).toEqual(['PV-0004']);
    expect(filterPaymentVouchers(rows, 'refund', 'open').map((v) => v.number)).toEqual(['PV-0003']);
    // The words of one kind do not find another.
    expect(filterPaymentVouchers(rows, 'supplier payment', 'open', 'other')).toEqual([]);
  });
  it('exports with its kind, category and documents, and amounts as numbers', () => {
    const csv = paymentVouchersCsv([
      voucher({ number: 'PV-0002', party_name: 'Lim Hardware', kind: 'bill', category_name: null, documents: 'BILL-0221, BILL-0222', amount: 1200.5 }),
      voucher({ number: null, party_name: 'Ramli', status: 'pending_approval', category_name: 'Rent' }),
    ]);
    const lines = csv.slice(CSV_BOM.length).split('\r\n');
    expect(lines[0]).toBe('Date,No.,Paid to,Kind,Category,For,Account,Method,Reference,Amount,Status');
    expect(lines[1]).toBe('2026-10-05,PV-0002,Lim Hardware,Supplier payment,Supplier bills,"BILL-0221, BILL-0222",Main Bank,FPX,,1200.5,Paid');
    expect(lines[2]).toBe('2026-10-05,,Ramli,Other payment,Rent,,Main Bank,FPX,,100,Pending approval');
  });
});

describe('expensesView', () => {
  it('counts approved and paid expenses as spend, and pending ones apart; a rejected one nowhere', () => {
    const rows = [
      expense({ amount: 4500, category_name: 'Rent', display_status: 'paid', paid: 4500, method: 'bank_transfer' }),
      expense({ amount: 1500, category_id: 'services', category_name: 'Services' }),
      expense({ amount: 2200, category_id: 'marketing', category_name: 'Marketing', status: 'pending', display_status: 'pending' }),
      expense({ amount: 9999, status: 'rejected', display_status: 'rejected' }),
      expense({ amount: 4500, expense_date: '2026-08-03', display_status: 'paid', paid: 4500 }),
      expense({ amount: 7777, expense_date: '2025-12-31' }),
    ];
    const view = expensesView(rows, today);
    expect(stat(view.stats, 'Total expenses (YTD)')).toMatchObject({ value: 'RM 10.5k', delta: '3 approved expenses' });
    expect(stat(view.stats, 'This month')).toMatchObject({ value: 'RM 6,000', delta: '2 approved expenses' });
    expect(stat(view.stats, 'Top category')).toMatchObject({ value: 'Rent', delta: '86% of spend this year' });
    expect(stat(view.stats, 'Pending approval')).toMatchObject({ value: 'RM 2,200', delta: '1 expense', deltaTone: 'down' });
    expect(view.byCategory.map((s) => [s.label, s.value])).toEqual([['Rent', 9000], ['Services', 1500]]);
    expect(view.spendYtd).toBe('RM 10.5k');
    expect(view.hasSpend).toBe(true);
    // October: entered is everything not rejected, approved leaves the pending one out.
    expect(view.trend[7]).toEqual({ label: 'Oct', entered: 8.2, approved: 6 });
    expect(view.trend[5]).toEqual({ label: 'Aug', entered: 4.5, approved: 4.5 });
    expect(view.hasTrend).toBe(true);
  });
  it('has empty states: no spend, no top category, nothing pending', () => {
    const view = expensesView([expense({ status: 'rejected', display_status: 'rejected' })], today);
    expect(view.hasSpend).toBe(false);
    expect(view.hasTrend).toBe(false);
    expect(view.byCategory).toEqual([]);
    expect(stat(view.stats, 'Top category')).toMatchObject({ value: '—', delta: 'this year' });
    expect(stat(view.stats, 'Pending approval')).toMatchObject({ value: 'RM 0', delta: '0 expenses', deltaTone: 'flat' });
    // A pending expense alone is a trend, and still no spend.
    const pending = expensesView([expense({ status: 'pending', display_status: 'pending' })], today);
    expect(pending.hasTrend).toBe(true);
    expect(pending.hasSpend).toBe(false);
  });
  it('folds categories past the fourth into one slice', () => {
    const names = ['Rent', 'Salaries', 'Marketing', 'Utilities', 'Travel', 'Supplies'];
    const rows = names.map((name, i) => expense({ category_id: name, category_name: name, amount: 600 - i * 100 }));
    const view = expensesView(rows, today);
    expect(view.byCategory.map((s) => [s.label, s.value])).toEqual([
      ['Rent', 600], ['Salaries', 500], ['Marketing', 400], ['Utilities', 300], ['Other categories', 300],
    ]);
  });
});

describe('an expense in the table', () => {
  it('is approved spend once approved, paid or not', () => {
    expect(isApprovedExpense(expense({ display_status: 'approved' }))).toBe(true);
    expect(isApprovedExpense(expense({ display_status: 'paid' }))).toBe(true);
    expect(isApprovedExpense(expense({ display_status: 'pending' }))).toBe(false);
    expect(isApprovedExpense(expense({ display_status: 'rejected' }))).toBe(false);
  });
  it('has a word for every status, and a dash for how it was paid until it is', () => {
    expect(EXPENSE_STATUS_LABELS).toEqual({ pending: 'Pending approval', approved: 'Approved', rejected: 'Rejected', paid: 'Paid' });
    expect(expenseMethod(expense())).toBe('—');
    expect(expenseMethod(expense({ method: 'ewallet' }))).toBe('E-Wallet');
  });
  it('lists the categories the rows name, once each, by name', () => {
    const rows = [
      expense({ category_id: 'u', category_name: 'Utilities' }),
      expense({ category_id: 'r', category_name: 'Rent' }),
      expense({ category_id: 'u', category_name: 'Utilities' }),
      expense({ category_id: 'r2', category_name: 'Rent' }),
    ];
    expect(expenseCategories(rows)).toEqual([{ id: 'r', name: 'Rent' }, { id: 'r2', name: 'Rent' }, { id: 'u', name: 'Utilities' }]);
  });
  it('is found by status, by category and by vendor, category or notes', () => {
    const rows = [
      expense({ vendor_name: 'Menara Axis', category_id: 'rent', category_name: 'Rent', display_status: 'paid' }),
      expense({ vendor_name: 'Meta Ads', category_id: 'marketing', category_name: 'Marketing', status: 'pending', display_status: 'pending', notes: 'Raya campaign' }),
      expense({ vendor_name: 'AirAsia', category_id: 'travel', category_name: 'Travel', status: 'rejected', display_status: 'rejected' }),
      expense({ vendor_name: 'Guaman Lee', category_id: 'services', category_name: 'Services' }),
    ];
    expect(filterExpenses(rows, '', 'open').map((e) => e.vendor_name)).toEqual(['Menara Axis', 'Meta Ads', 'Guaman Lee']);
    expect(filterExpenses(rows, '', 'rejected').map((e) => e.vendor_name)).toEqual(['AirAsia']);
    expect(filterExpenses(rows, '', 'paid').map((e) => e.vendor_name)).toEqual(['Menara Axis']);
    expect(filterExpenses(rows, '', 'approved').map((e) => e.vendor_name)).toEqual(['Guaman Lee']);
    expect(filterExpenses(rows, '', 'open', 'marketing').map((e) => e.vendor_name)).toEqual(['Meta Ads']);
    expect(filterExpenses(rows, ' RAYA ', 'open').map((e) => e.vendor_name)).toEqual(['Meta Ads']);
    expect(filterExpenses(rows, 'services', 'open').map((e) => e.vendor_name)).toEqual(['Guaman Lee']);
  });
  it('exports amounts as numbers, with what was paid and how', () => {
    const csv = expensesCsv([
      expense({ vendor_name: 'Unifi Business', category_name: 'Utilities', amount: 94, sst_amount: 5.32, display_status: 'paid', paid: 94, method: 'card' }),
      expense({ vendor_name: 'Meta Ads', category_name: 'Marketing', status: 'pending', display_status: 'pending', notes: 'Raya, week 1' }),
    ]);
    const lines = csv.slice(CSV_BOM.length).split('\r\n');
    expect(lines[0]).toBe('Date,Category,Vendor,Amount,SST,Paid,Method,Status,Notes');
    expect(lines[1]).toBe('2026-10-05,Utilities,Unifi Business,94,5.32,94,Card,Paid,');
    expect(lines[2]).toBe('2026-10-05,Marketing,Meta Ads,100,0,0,,Pending approval,"Raya, week 1"');
  });
});

describe('the sample shown when there is no database', () => {
  it('lists each sample payment in once on Cash Receipts, for what the payment came to', () => {
    const invoiceReceipts = SAMPLE_CASH_RECEIPTS.filter((r) => r.kind === 'invoice');
    expect(invoiceReceipts).toHaveLength(paymentCount(SAMPLE_PAYMENTS_IN));
    for (const r of invoiceReceipts) {
      const parts = SAMPLE_PAYMENTS_IN.filter((p) => p.transaction_id === r.transaction_id);
      expect(parts.length, r.transaction_id).toBeGreaterThan(0);
      expect(r.amount, r.transaction_id).toBe(sum(parts, (p) => p.amount));
      expect(r.number, r.transaction_id).toBe(parts[0].number);
    }
    expect(new Set(SAMPLE_CASH_RECEIPTS.map((r) => r.transaction_id)).size).toBe(SAMPLE_CASH_RECEIPTS.length);
  });
  it('lists each sample refund once on Payment Vouchers, with its amount and status', () => {
    const refundVouchers = SAMPLE_PAYMENT_VOUCHERS.filter((v) => v.kind === 'refund');
    expect(refundVouchers).toHaveLength(SAMPLE_REFUNDS.length);
    for (const v of refundVouchers) {
      const refund = SAMPLE_REFUNDS.find((r) => r.transaction_id === v.transaction_id)!;
      expect([v.amount, v.status, v.number], v.transaction_id).toEqual([refund.amount, refund.status, refund.number]);
    }
    expect(new Set(SAMPLE_PAYMENT_VOUCHERS.map((v) => v.transaction_id)).size).toBe(SAMPLE_PAYMENT_VOUCHERS.length);
  });
  it('has one paid voucher for each paid sample expense, for its amount, and no number used twice', () => {
    const expenseVouchers = SAMPLE_PAYMENT_VOUCHERS.filter((v) => v.kind === 'expense');
    const paid = SAMPLE_EXPENSES.filter((e) => e.display_status === 'paid');
    expect(expenseVouchers).toHaveLength(paid.length);
    expect(sum(expenseVouchers, (v) => v.amount)).toBe(sum(paid, (e) => e.paid));
    expect(expenseVouchers.every((v) => v.status === 'posted' && v.category_name !== null)).toBe(true);
    // The view's shape: the expenses' category by name, and no category of the voucher's own.
    expect(expenseVouchers.every((v) => v.category_id === null)).toBe(true);
    const paidThisMonth = paymentVouchersView(expenseVouchers, SAMPLE_TODAY, 'month').byCategory;
    expect(paidThisMonth.map((s) => [s.label, s.value])).toEqual([
      ['Rent', 4500], ['Utilities', 1374], ['Supplies', 640], ['Travel', 186],
    ]);
    const numbers = SAMPLE_PAYMENT_VOUCHERS.map((v) => v.number).filter((n) => n !== null);
    expect(new Set(numbers).size).toBe(numbers.length);
    const receiptNumbers = SAMPLE_CASH_RECEIPTS.map((r) => r.number).filter((n) => n !== null);
    expect(new Set(receiptNumbers).size).toBe(receiptNumbers.length);
  });
  it('gives every card, chart and filter something to show', () => {
    const receipts = cashReceiptsView(SAMPLE_CASH_RECEIPTS, SAMPLE_TODAY, 'month');
    expect(receipts.hasTrend && receipts.hasReceived).toBe(true);
    expect(receipts.byAccount.map((s) => s.label).sort()).toEqual(['Cash in hand', 'Main Bank']);
    expect(SAMPLE_CASH_RECEIPTS.some((r) => r.status === 'draft' && r.number === null)).toBe(true);
    const vouchers = paymentVouchersView(SAMPLE_PAYMENT_VOUCHERS, SAMPLE_TODAY, 'month');
    expect(vouchers.hasTrend && vouchers.hasPaid).toBe(true);
    expect(stat(vouchers.stats, 'Pending approval')).toMatchObject({ value: 'RM 4,340', delta: '2 vouchers' });
    expect(new Set(SAMPLE_PAYMENT_VOUCHERS.map((v) => v.kind))).toEqual(new Set(['bill', 'refund', 'expense', 'other']));
    expect(SAMPLE_PAYMENT_VOUCHERS.every((v) => (v.status === 'posted') === (v.number !== null))).toBe(true);
    const expenses = expensesView(SAMPLE_EXPENSES, SAMPLE_TODAY);
    expect(expenses.hasTrend && expenses.hasSpend).toBe(true);
    expect(stat(expenses.stats, 'Pending approval')).toMatchObject({ value: 'RM 5,800', delta: '2 expenses' });
    expect(new Set(SAMPLE_EXPENSES.map((e) => e.display_status))).toEqual(new Set(['pending', 'approved', 'rejected', 'paid']));
    expect(SAMPLE_EXPENSES.every((e) => e.sst_amount <= e.amount && (e.display_status === 'paid') === (e.method !== null))).toBe(true);
  });
  it('keeps each list newest first, as the database gives it', () => {
    const sorted = (dates: string[]) => dates.every((d, i) => i === 0 || dates[i - 1] >= d);
    expect(sorted(SAMPLE_CASH_RECEIPTS.map((r) => r.txn_date))).toBe(true);
    expect(sorted(SAMPLE_PAYMENT_VOUCHERS.map((v) => v.txn_date))).toBe(true);
    expect(sorted(SAMPLE_EXPENSES.map((e) => e.expense_date))).toBe(true);
  });
});

describe('the table follows the period, as the cards do', () => {
  const receipts = [
    receipt({ number: 'RC-A', txn_date: '2026-10-03', amount: 120 }),
    receipt({ number: 'RC-B', txn_date: '2026-11-15', amount: 230.5 }),
    receipt({ number: 'RC-C', txn_date: '2025-12-31', amount: 75.25 }),
    receipt({ number: 'RC-D', txn_date: '2026-10-01', status: 'void', amount: 40 }),
    receipt({ number: null, party_name: 'Old draft', txn_date: '2026-02-01', status: 'draft', amount: 10 }),
    receipt({ number: 'RC-E', txn_date: '2026-02-01', status: 'void', amount: 60 }),
  ];
  const parties = (rows: CashReceiptRow[]) => rows.map((r) => r.number ?? r.party_name);

  it('keeps the receipts dated in the period, and every draft the Receipts card counts as not yet posted', () => {
    expect(parties(cashReceiptsInPeriod(receipts, today, 'month'))).toEqual(['RC-A', 'RC-D', 'Old draft']);
    expect(parties(cashReceiptsInPeriod(receipts, today, 'quarter'))).toEqual(['RC-A', 'RC-B', 'RC-D', 'Old draft']);
    expect(parties(cashReceiptsInPeriod(receipts, today, 'year'))).toEqual(['RC-A', 'RC-B', 'RC-D', 'Old draft', 'RC-E']);
  });
  it('lists exactly the posted receipts a card counts, with the same period selected', () => {
    for (const period of CASH_BOOK_PERIODS) {
      const view = cashReceiptsView(receipts, today, period);
      const posted = filterCashReceipts(cashReceiptsInPeriod(receipts, today, period), '', 'posted');
      expect(String(posted.length), period).toBe(view.stats.find((s) => s.label === 'Receipts')?.value);
      expect(rmShort(sum(posted, (r) => r.amount)), period).toBe(view.received);
      expect(rmShort(sum(posted, (r) => r.amount)), period).toBe(view.stats.find((s) => s.label === 'Received')?.value);
    }
    // The sums really differ between periods, so the comparison above can fail.
    expect(cashReceiptsView(receipts, today, 'month').received).toBe('RM 120');
    expect(cashReceiptsView(receipts, today, 'quarter').received).toBe('RM 351');
    expect(cashReceiptsView(receipts, today, 'all').received).toBe('RM 426');
  });
  it('puts the first and last day of a month and of a quarter in the right periods, and the table agrees with the cards', () => {
    const edges = [
      receipt({ number: 'Sep-30', txn_date: '2026-09-30', amount: 11 }),
      receipt({ number: 'Oct-01', txn_date: '2026-10-01', amount: 22 }),
      receipt({ number: 'Oct-31', txn_date: '2026-10-31', amount: 33 }),
      receipt({ number: 'Nov-01', txn_date: '2026-11-01', amount: 44 }),
      receipt({ number: 'Dec-31', txn_date: '2026-12-31', amount: 55 }),
      receipt({ number: 'Jan-01', txn_date: '2027-01-01', amount: 66 }),
    ];
    const posted = (period: CashBookPeriod) => filterCashReceipts(cashReceiptsInPeriod(edges, today, period), '', 'posted');
    expect(parties(posted('month'))).toEqual(['Oct-01', 'Oct-31']);
    expect(parties(posted('quarter'))).toEqual(['Oct-01', 'Oct-31', 'Nov-01', 'Dec-31']);
    expect(parties(posted('year'))).toEqual(['Sep-30', 'Oct-01', 'Oct-31', 'Nov-01', 'Dec-31']);
    expect(posted('all')).toHaveLength(6);
    for (const period of CASH_BOOK_PERIODS) {
      expect(rmShort(sum(posted(period), (r) => r.amount)), period).toBe(cashReceiptsView(edges, today, period).received);
    }
    // The first of the next quarter belongs to that quarter, not to the one ending the day before.
    expect(parties(filterCashReceipts(cashReceiptsInPeriod(edges, '2026-12-31', 'quarter'), '', 'posted'))).toEqual(['Oct-01', 'Oct-31', 'Nov-01', 'Dec-31']);
    expect(parties(filterCashReceipts(cashReceiptsInPeriod(edges, '2027-01-01', 'quarter'), '', 'posted'))).toEqual(['Jan-01']);
  });
  it('leaves search and the status filter to work on top of the period', () => {
    const inMonth = cashReceiptsInPeriod(receipts, today, 'month');
    expect(parties(filterCashReceipts(inMonth, '', 'posted'))).toEqual(['RC-A']);
    expect(parties(filterCashReceipts(inMonth, 'rc-b', 'open'))).toEqual([]);
    expect(cashReceiptsCsv(inMonth).split('\r\n').filter(Boolean)).toHaveLength(1 + 3);
  });

  const vouchers = [
    voucher({ number: 'PV-A', txn_date: '2026-10-03' }),
    voucher({ number: 'PV-B', txn_date: '2026-11-15' }),
    voucher({ number: null, party_name: 'Old waiting', txn_date: '2026-01-01', status: 'pending_approval' }),
    voucher({ number: null, party_name: 'Old to pay', txn_date: '2025-06-01', status: 'scheduled' }),
    voucher({ number: null, party_name: 'Old draft', txn_date: '2026-01-01', status: 'draft' }),
    voucher({ number: 'PV-C', txn_date: '2026-01-01', status: 'void' }),
    voucher({ number: null, party_name: 'Old rejected', txn_date: '2026-01-01', status: 'rejected' }),
  ];
  const names = (rows: PaymentVoucherRow[]) => rows.map((v) => v.number ?? v.party_name);

  it('keeps the vouchers dated in the period, and all that wait for approval, are still to be paid, or are drafts', () => {
    // 'Old draft' is dated in January: it stays in the month and the quarter, as a draft receipt does.
    expect(names(paymentVouchersInPeriod(vouchers, today, 'month'))).toEqual(['PV-A', 'Old waiting', 'Old to pay', 'Old draft']);
    expect(names(paymentVouchersInPeriod(vouchers, today, 'quarter'))).toEqual(['PV-A', 'PV-B', 'Old waiting', 'Old to pay', 'Old draft']);
    expect(names(paymentVouchersInPeriod(vouchers, today, 'year'))).toEqual([
      'PV-A', 'PV-B', 'Old waiting', 'Old to pay', 'Old draft', 'PV-C', 'Old rejected',
    ]);
  });
  it('lists a draft dated last year in this month, and no figure counts it', () => {
    const lastYear = [voucher({ number: null, party_name: 'Last year draft', txn_date: '2025-03-01', status: 'draft', amount: 999 })];
    for (const period of CASH_BOOK_PERIODS) {
      expect(names(paymentVouchersInPeriod(lastYear, today, period)), period).toEqual(['Last year draft']);
      const view = paymentVouchersView(lastYear, today, period);
      expect(view.stats.find((s) => s.label === 'Paid')?.value, period).not.toContain('999');
      expect(view.stats.find((s) => s.label === 'Vouchers')?.value, period).toBe('0');
      expect(view.stats.find((s) => s.label === 'Pending approval')?.delta, period).toBe('0 vouchers');
    }
  });
  it('lists every voucher a card counts, with the same period selected', () => {
    for (const period of CASH_BOOK_PERIODS) {
      const view = paymentVouchersView(vouchers, today, period);
      const inTable = paymentVouchersInPeriod(vouchers, today, period);
      expect(String(filterPaymentVouchers(inTable, '', 'posted').length), period).toBe(view.stats.find((s) => s.label === 'Vouchers')?.value);
      const waiting = filterPaymentVouchers(inTable, '', 'waiting');
      expect(view.stats.find((s) => s.label === 'Pending approval')?.delta, period).toBe(`${waiting.length} voucher`);
      expect(view.stats.find((s) => s.label === 'Vouchers')?.delta, period).toBe('1 more to be paid');
      expect(filterPaymentVouchers(inTable, '', 'scheduled')).toHaveLength(1);
    }
  });
});

describe('the line under the table', () => {
  const line = (over: Partial<Parameters<typeof cashBookCountLine>[0]> = {}) =>
    cashBookCountLine({
      noun: 'vouchers',
      period: 'month',
      workspaceRows: 5,
      shown: 3,
      matching: 3,
      total: 3,
      keptEarlier: 0,
      keptLater: 0,
      ...over,
    });

  it('says the period when every row is dated in it', () => {
    expect(line()).toBe('Showing 3 of 3 vouchers this month');
    expect(line({ noun: 'receipts', period: 'quarter' })).toBe('Showing 3 of 3 receipts this quarter');
  });
  it('says so in plain words when rows from outside the period are kept', () => {
    expect(line({ keptEarlier: 2 })).toBe('Showing 3 of 3 vouchers: this month, and 2 earlier ones still waiting or in draft');
    expect(line({ keptEarlier: 1 })).toBe('Showing 3 of 3 vouchers: this month, and 1 earlier one still waiting or in draft');
    expect(line({ noun: 'receipts', keptEarlier: 1 })).toBe('Showing 3 of 3 receipts: this month, and 1 earlier draft');
    expect(line({ noun: 'receipts', keptEarlier: 2 })).toBe('Showing 3 of 3 receipts: this month, and 2 earlier drafts');
    expect(line({ keptLater: 1 })).toBe('Showing 3 of 3 vouchers: this month, and 1 later one still waiting or in draft');
    expect(line({ keptEarlier: 1, keptLater: 1 })).toBe('Showing 3 of 3 vouchers: this month, and 2 more dated outside it, still waiting or in draft');
    expect(line({ noun: 'receipts', keptEarlier: 1, keptLater: 1 })).toBe('Showing 3 of 3 receipts: this month, and 2 more drafts dated outside it');
  });
  it('keeps the whole table in view when a search or filter narrows it', () => {
    expect(line({ shown: 1, matching: 1, total: 3 })).toBe('Showing 1 of 1 vouchers (3 this month)');
    expect(line({ shown: 1, matching: 1, total: 3, keptEarlier: 2 })).toBe(
      'Showing 1 of 1 vouchers (3 in the table: this month, and 2 earlier ones still waiting or in draft)',
    );
  });
  it('reads sensibly for All time', () => {
    expect(line({ period: 'all' })).toBe('Showing 3 of 3 vouchers, all time');
    expect(line({ period: 'all', shown: 1, matching: 1, total: 3 })).toBe('Showing 1 of 1 vouchers (3 in all)');
  });
  it('reads sensibly when the period holds nothing', () => {
    expect(line({ shown: 0, matching: 0, total: 0 })).toBe('Showing 0 of 0 vouchers this month');
  });
  it('shows no line when the workspace has no rows at all', () => {
    expect(line({ workspaceRows: 0, shown: 0, matching: 0, total: 0 })).toBeNull();
  });
});

describe('what the screen says when a receipt just written is not in the list', () => {
  const today = '2026-11-03';
  const posted = (date: string) => ({ id: 'a', kind: 'posted' as const, number: 'RC-0012', date });
  const voided = { id: 'a', kind: 'voided' as const, number: 'RC-0012', date: '2026-11-01' };
  const sentence = (kind: 'posted' | 'voided') =>
    `Receipt RC-0012 was ${kind}. Clear the search or choose View all to see it.`;

  it('says nothing when the receipt is on screen, whatever the period and filter', () => {
    expect(receiptHiddenNote(posted('2026-11-01'), today, 'month', 'open', true, true)).toBeNull();
    expect(receiptHiddenNote(posted('2026-10-01'), today, 'month', 'void', true, true)).toBeNull();
    expect(receiptHiddenNote(voided, today, 'month', 'open', true, true)).toBeNull();
  });
  it('says a posted receipt is outside the period, for each period', () => {
    expect(receiptHiddenNote(posted('2026-10-30'), today, 'month', 'open', false, false)).toBe(
      'Receipt RC-0012 dated 30 Oct 2026 was posted. It is outside this month: choose a longer period to see it.',
    );
    expect(receiptHiddenNote(posted('2026-06-30'), today, 'quarter', 'open', false, false)).toBe(
      'Receipt RC-0012 dated 30 Jun 2026 was posted. It is outside this quarter: choose a longer period to see it.',
    );
    expect(receiptHiddenNote(posted('2025-12-31'), today, 'year', 'open', false, false)).toBe(
      'Receipt RC-0012 dated 31 Dec 2025 was posted. It is outside this year: choose a longer period to see it.',
    );
  });
  it('never blames All time, which holds every date', () => {
    expect(receiptHiddenNote(posted('2019-01-01'), today, 'all', 'open', false, false)).toBe(sentence('posted'));
  });
  it('says a posted receipt is hidden by a status filter that cannot show it', () => {
    for (const filter of ['draft', 'void'] as const) {
      expect(receiptHiddenNote(posted('2026-11-01'), today, 'month', filter, false, false)).toBe(
        'Receipt RC-0012 was posted. Choose Posted in the status filter to see it.',
      );
    }
  });
  it('puts the period first when both the period and the filter hide a posted receipt', () => {
    expect(receiptHiddenNote(posted('2026-10-30'), today, 'month', 'void', false, false)).toMatch(/outside this month/);
  });
  it('says a voided receipt left the list unless the Void filter is on', () => {
    const left = 'Receipt RC-0012 was voided. Choose Void in the status filter to see it.';
    expect(receiptHiddenNote(voided, today, 'month', 'open', false, false)).toBe(left);
    expect(receiptHiddenNote(voided, today, 'all', 'posted', false, false)).toBe(left);
  });
  it('says search text or the ten-row limit hides a posted receipt that the period and filter allow', () => {
    // Not among the matching rows, and nothing else explains it: the search.
    expect(receiptHiddenNote(posted('2026-11-01'), today, 'month', 'open', false, false)).toBe(sentence('posted'));
    // Among the matching rows but past the tenth: the limit.
    expect(receiptHiddenNote(posted('2026-11-01'), today, 'month', 'open', true, false)).toBe(sentence('posted'));
  });
  it('says search text or the ten-row limit hides a voided receipt while the Void filter is chosen', () => {
    expect(receiptHiddenNote(voided, today, 'month', 'void', false, false)).toBe(sentence('voided'));
    expect(receiptHiddenNote(voided, today, 'month', 'void', true, false)).toBe(sentence('voided'));
  });
  it('does not blame the period or filter for a receipt that matches them', () => {
    expect(receiptHiddenNote(posted('2026-10-30'), today, 'month', 'open', true, false)).toBe(sentence('posted'));
  });
});
