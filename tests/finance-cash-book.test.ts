import { describe, expect, it } from 'vitest';
import { listCashReceipts, listPaymentVouchers } from '@/lib/finance/cash-book';
import { EXPENSE_PAGE_SIZE, listExpenses } from '@/lib/finance/expenses';
import { PAYMENT_PAGE_SIZE } from '@/lib/finance/money';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

// PostgREST answers a numeric column as a string when it is large, and as a number otherwise.
const receiptRow = {
  transaction_id: 't1', number: 'RC-0001', txn_date: '2026-10-05', method: 'cash', amount: '80.00', status: 'posted',
  reference: null, notes: null, account_id: 'a1', account_name: 'Cash in hand', account_kind: 'cash', contact_id: null,
  party_name: 'Walk-in', kind: 'income', category_id: 'c1', category_name: 'Sales', documents: null,
};
const voucherRow = {
  transaction_id: 't2', number: null, txn_date: '2026-10-06', method: 'fpx', amount: '300.00', status: 'pending_approval',
  reference: 'ACC 1', notes: null, account_id: 'a2', account_name: 'Main Bank', account_kind: 'bank', contact_id: null,
  party_name: 'Water board', kind: 'other', category_id: 'c2', category_name: 'Utilities', documents: null, approved_at: null,
};
const expenseRow = {
  id: 'e1', expense_date: '2026-10-04', category_id: 'c3', category_name: 'Rent', vendor_id: null, vendor_name: 'Landlord',
  amount: '4500.00', sst_amount: '0.00', notes: null, status: 'approved', display_status: 'paid', paid: '4500.00', held: '0.00',
  method: 'bank_transfer', paid_on: '2026-10-04', updated_at: '2026-10-04T09:00:00.123456+00:00',
};

describe('listCashReceipts', () => {
  it('reads the receipts view for the workspace, newest first, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [receiptRow], error: null });
    expect(await listCashReceipts(ctx)).toEqual([{ ...receiptRow, amount: 80 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'table', name: 'finance_cash_receipts', op: 'select', filters: { org_id: 'org-1' },
      order: ['txn_date desc', 'transaction_id asc'], range: [0, PAYMENT_PAGE_SIZE - 1],
    });
    // Every column the row type has, and nothing the view does not have.
    expect(calls[0].columns!.split(',').sort()).toEqual(Object.keys(receiptRow).sort());
  });
  it('reads on until a page comes back short', async () => {
    const full = Array.from({ length: PAYMENT_PAGE_SIZE }, (_, i) => ({ ...receiptRow, transaction_id: `t${i}` }));
    const pages = (call: FinanceCall) => ({ data: call.range![0] === 0 ? full : [receiptRow], error: null });
    const { ctx, calls } = fakeFinance(pages);
    expect(await listCashReceipts(ctx)).toHaveLength(PAYMENT_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([[0, PAYMENT_PAGE_SIZE - 1], [PAYMENT_PAGE_SIZE, 2 * PAYMENT_PAGE_SIZE - 1]]);
  });
  it('answers with no rows when the view has none, and throws when it cannot be read', async () => {
    expect(await listCashReceipts(fakeFinance({ data: null, error: null }).ctx)).toEqual([]);
    await expect(listCashReceipts(fakeFinance({ data: null, error: { code: '42501' } }).ctx)).rejects.toEqual({ code: '42501' });
  });
});

describe('listPaymentVouchers', () => {
  it('reads the vouchers view, with when it was approved', async () => {
    const { ctx, calls } = fakeFinance({ data: [voucherRow], error: null });
    expect(await listPaymentVouchers(ctx)).toEqual([{ ...voucherRow, amount: 300 }]);
    expect(calls[0]).toMatchObject({
      name: 'finance_payment_vouchers', filters: { org_id: 'org-1' }, order: ['txn_date desc', 'transaction_id asc'],
    });
    expect(calls[0].columns!.split(',').sort()).toEqual(Object.keys(voucherRow).sort());
  });
  it('throws when the view cannot be read', async () => {
    await expect(listPaymentVouchers(fakeFinance({ data: null, error: { code: 'XX000' } }).ctx)).rejects.toEqual({ code: 'XX000' });
  });
});

describe('listExpenses', () => {
  it('reads the expense totals for the workspace, newest first, with every amount as a number', async () => {
    const { ctx, calls } = fakeFinance({ data: [expenseRow], error: null });
    expect(await listExpenses(ctx)).toEqual([{ ...expenseRow, amount: 4500, sst_amount: 0, paid: 4500, held: 0 }]);
    expect(calls[0]).toMatchObject({
      kind: 'table', name: 'finance_expense_totals', op: 'select', filters: { org_id: 'org-1' },
      order: ['expense_date desc', 'id asc'], range: [0, EXPENSE_PAGE_SIZE - 1],
    });
    expect(calls[0].columns!.split(',').sort()).toEqual(Object.keys(expenseRow).sort());
  });
  it('reads on until a page comes back short, and throws when it cannot be read', async () => {
    const full = Array.from({ length: EXPENSE_PAGE_SIZE }, (_, i) => ({ ...expenseRow, id: `e${i}` }));
    const pages = (call: FinanceCall) => ({ data: call.range![0] === 0 ? full : [], error: null });
    const paged = fakeFinance(pages);
    expect(await listExpenses(paged.ctx)).toHaveLength(EXPENSE_PAGE_SIZE);
    expect(paged.calls).toHaveLength(2);
    await expect(listExpenses(fakeFinance({ data: null, error: { code: '42501' } }).ctx)).rejects.toEqual({ code: '42501' });
  });
});
