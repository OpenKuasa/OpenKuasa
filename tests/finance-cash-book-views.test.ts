import { describe, expect, it } from 'vitest';
import type { CashReceiptRow, PaymentVoucherRow } from '@/lib/finance/cash-book';
import {
  CASH_BOOK_PERIODS,
  CASH_BOOK_PERIOD_LABELS,
  CASH_RECEIPT_STATUS_LABELS,
  DONUT_SLICES,
  EXPENSE_STATUS_LABELS,
  PAYMENT_VOUCHER_KIND_LABELS,
  PAYMENT_VOUCHER_STATUS_LABELS,
  cashReceiptsCsv,
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
  paymentVouchersView,
  receiptFor,
  voucherCategory,
  voucherHome,
} from '@/lib/finance/cash-book-views';
import { CSV_BOM } from '@/lib/finance/csv';
import type { ExpenseRow } from '@/lib/finance/expenses';
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

const voucher = (v: Partial<PaymentVoucherRow> = {}): PaymentVoucherRow => {
  seq += 1;
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
    kind: 'other',
    category_id: 'utilities',
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
    ...e,
  };
};

const stat = (stats: { label: string; value: string; delta?: string }[], label: string) => stats.find((s) => s.label === label)!;

describe('the period selector', () => {
  it('offers this month, this quarter and this year, and says so in a person’s words', () => {
    expect(CASH_BOOK_PERIODS).toEqual(['month', 'quarter', 'year']);
    expect(CASH_BOOK_PERIOD_LABELS).toEqual({ month: 'This month', quarter: 'This quarter', year: 'This year' });
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
    expect(view.byCategory.map((s) => [s.label, s.value])).toEqual([
      ['Supplier bills', 500], ['Rent', 400], ['Refunds', 200], ['Several categories', 50], ['Other categories', 25],
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
