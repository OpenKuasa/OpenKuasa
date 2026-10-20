import { describe, expect, it } from 'vitest';
import { listBankAccounts, listBankTransactions } from '@/lib/finance/banking';
import { PAYMENT_PAGE_SIZE } from '@/lib/finance/money';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

// The fixture gives numeric columns as strings, as PostgREST can; the data layer must turn them into numbers either way.
const accountRow = {
  id: 'a1', name: 'Main Bank', kind: 'bank', bank_name: 'Maybank', opening_balance: '1000.00',
  opening_date: '2026-01-01', active: true, balance: '72400.00', to_be_paid: '960.00', last_import_at: '2026-10-09T02:00:00Z',
  unmatched_lines: 2,
  // Stage 5a: the currency, the rate as exact text, and the ringgit figures.
  currency: 'MYR', opening_rate_text: '1.0000000000', opening_rate_source: null, opening_rate_date: null,
  opening_balance_myr: '1000.00', balance_myr: '72400.00',
};
const transactionRow = {
  transaction_id: 't1', account_id: 'a1', account_name: 'Main Bank', account_kind: 'bank', direction: 'out',
  txn_date: '2026-10-07', amount: '2000.00', status: 'posted', number: 'TR-0004', method: 'bank_transfer', reference: null,
  notes: 'Monthly sweep', party_name: null, kind: 'transfer', category_name: null, documents: null, transfer_id: 'x1',
  other_account_name: 'Savings', reconciled: true, created_at: '2026-10-07T03:00:00Z',
  currency: 'MYR', fx_rate_text: '1.0000000000', fx_rate_source: null, amount_myr: '2000.00', other_currency: 'MYR',
  other_amount: '2000.00',
};
/** The selector's own names for the two columns read as text (`alias:column::text`). */
const selected = (columns: string) => columns.split(',').map((c) => c.split(':')[0]).sort();

describe('listBankAccounts', () => {
  it('reads the balances view for the workspace, bank accounts first, with every amount as a number', async () => {
    const { ctx, calls } = fakeFinance({ data: [accountRow], error: null });
    expect(await listBankAccounts(ctx)).toEqual([
      { ...accountRow, opening_balance: 1000, balance: 72400, to_be_paid: 960, opening_balance_myr: 1000, balance_myr: 72400 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'table', name: 'finance_account_balances', op: 'select', filters: { org_id: 'org-1' }, order: ['kind asc', 'name asc'],
    });
    // The selector asks for exactly the columns of this test's fixture row (not checked against the migration).
    expect(selected(calls[0].columns!)).toEqual(Object.keys(accountRow).sort());
    // The rate is read as text, never a float.
    expect(calls[0].columns).toContain('opening_rate_text:opening_rate::text');
    // The view has no account number: nobody signed in may read that column, and asking for it refuses the whole read.
    expect(calls[0].columns).not.toContain('account_no');
  });
  it('answers with no rows when the view has none, and throws when it cannot be read', async () => {
    expect(await listBankAccounts(fakeFinance({ data: null, error: null }).ctx)).toEqual([]);
    await expect(listBankAccounts(fakeFinance({ data: null, error: { code: '42501' } }).ctx)).rejects.toEqual({ code: '42501' });
  });
});

describe('listBankTransactions', () => {
  it('reads the bank transactions view for the workspace, newest first, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [transactionRow], error: null });
    expect(await listBankTransactions(ctx)).toEqual([{ ...transactionRow, amount: 2000, amount_myr: 2000, other_amount: 2000 }]);
    expect(calls[0]).toMatchObject({
      kind: 'table', name: 'finance_bank_transactions', op: 'select', filters: { org_id: 'org-1' },
      order: ['txn_date desc', 'transaction_id asc'], range: [0, PAYMENT_PAGE_SIZE - 1],
    });
    expect(selected(calls[0].columns!)).toEqual(Object.keys(transactionRow).sort());
    expect(calls[0].columns).toContain('fx_rate_text:fx_rate::text');
  });
  it('reads on until a page comes back short', async () => {
    const full = Array.from({ length: PAYMENT_PAGE_SIZE }, (_, i) => ({ ...transactionRow, transaction_id: `t${i}` }));
    const pages = (call: FinanceCall) => ({ data: call.range![0] === 0 ? full : [{ ...transactionRow, transaction_id: 'last' }], error: null });
    const { ctx, calls } = fakeFinance(pages);
    expect(await listBankTransactions(ctx)).toHaveLength(PAYMENT_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([[0, PAYMENT_PAGE_SIZE - 1], [PAYMENT_PAGE_SIZE, 2 * PAYMENT_PAGE_SIZE - 1]]);
  });
  it('drops a movement that arrives on two pages, as one recorded between two requests can', async () => {
    const full = Array.from({ length: PAYMENT_PAGE_SIZE }, (_, i) => ({ ...transactionRow, transaction_id: `t${i}` }));
    const second = [{ ...transactionRow, transaction_id: `t${PAYMENT_PAGE_SIZE - 1}` }, { ...transactionRow, transaction_id: 'new' }];
    const { ctx } = fakeFinance((call) => ({ data: call.range![0] === 0 ? full : second, error: null }));
    const rows = await listBankTransactions(ctx);
    expect(rows).toHaveLength(PAYMENT_PAGE_SIZE + 1);
    expect(new Set(rows.map((r) => r.transaction_id)).size).toBe(rows.length);
  });
  it('throws when the view cannot be read', async () => {
    await expect(listBankTransactions(fakeFinance({ data: null, error: { code: 'XX000' } }).ctx)).rejects.toEqual({ code: 'XX000' });
  });
});
