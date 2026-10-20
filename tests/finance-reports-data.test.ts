import { describe, expect, it } from 'vitest';
import { listOpenBills, listOpenInvoices, OPEN_PAGE_SIZE, readFxBooks } from '@/lib/finance/reports-data';
import { fakeFinance } from './setup/fake-finance';

const invoice = (n: number) => ({ customer_id: `c${n}`, customer_name: `Customer ${n}`, due_date: '2026-10-01', balance: '12.50', display_status: 'sent' });
const bill = (n: number) => ({ supplier_id: `s${n}`, supplier_name: `Supplier ${n}`, due_date: '2026-10-01', balance: '40.00', display_status: 'pending' });

describe('listOpenInvoices', () => {
  it('reads only the five columns, of this workspace’s open posted invoices, from the totals view', async () => {
    const { ctx, calls } = fakeFinance({ data: [invoice(1)], error: null });
    expect(await listOpenInvoices(ctx)).toEqual([
      { customer_id: 'c1', customer_name: 'Customer 1', due_date: '2026-10-01', balance: 12.5, display_status: 'sent' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_invoice_totals',
      op: 'select',
      // In ringgit (stage 3a): the view's balance_myr, read under the name balance.
      columns: 'customer_id,customer_name,due_date,balance:balance_myr,display_status',
      filters: { org_id: ctx.orgId, 'balance_myr neq': 0, 'display_status in': ['sent', 'overdue', 'paid'] },
      range: [0, OPEN_PAGE_SIZE - 1],
    });
    expect(calls[0].order).toEqual(['due_date asc', 'id asc']);
  });
  it('reads on past a full page', async () => {
    const full = Array.from({ length: OPEN_PAGE_SIZE }, (_, n) => invoice(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [invoice(-1)], error: null }));
    expect(await listOpenInvoices(ctx)).toHaveLength(OPEN_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([
      [0, OPEN_PAGE_SIZE - 1],
      [OPEN_PAGE_SIZE, 2 * OPEN_PAGE_SIZE - 1],
    ]);
  });
  it('is empty for no rows, and throws a read error', async () => {
    expect(await listOpenInvoices(fakeFinance({ data: null, error: null }).ctx)).toEqual([]);
    await expect(listOpenInvoices(fakeFinance({ data: null, error: { code: 'XX000' } }).ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('listOpenBills', () => {
  it('reads only the five columns, of this workspace’s pending and overdue bills with a balance above zero', async () => {
    const { ctx, calls } = fakeFinance({ data: [bill(1)], error: null });
    expect(await listOpenBills(ctx)).toEqual([
      { supplier_id: 's1', supplier_name: 'Supplier 1', due_date: '2026-10-01', balance: 40, display_status: 'pending' },
    ]);
    expect(calls[0]).toMatchObject({
      name: 'supplier_bill_totals',
      op: 'select',
      // In ringgit (stage 4a): the view's balance_myr, read under the name balance; the filter stays on balance.
      columns: 'supplier_id,supplier_name,due_date,balance:balance_myr,display_status',
      filters: { org_id: ctx.orgId, 'balance gt': 0, 'display_status in': ['pending', 'overdue'] },
      range: [0, OPEN_PAGE_SIZE - 1],
    });
    expect(calls[0].order).toEqual(['due_date asc', 'id asc']);
  });
  it('reads on past a full page', async () => {
    const full = Array.from({ length: OPEN_PAGE_SIZE }, (_, n) => bill(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [], error: null }));
    expect(await listOpenBills(ctx)).toHaveLength(OPEN_PAGE_SIZE);
    expect(calls.map((c) => c.range)).toEqual([
      [0, OPEN_PAGE_SIZE - 1],
      [OPEN_PAGE_SIZE, 2 * OPEN_PAGE_SIZE - 1],
    ]);
  });
  it('throws a read error', async () => {
    await expect(listOpenBills(fakeFinance({ data: null, error: { code: 'XX000' } }).ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('readFxBooks', () => {
  const answers: Record<string, unknown[]> = {
    finance_invoices: [{ invoice_date: '2026-10-05' }],
    supplier_bills: [{ bill_date: '2026-10-12' }],
    finance_accounts: [{ opening_date: '2026-09-01' }],
    finance_transactions: [{ txn_date: '2026-10-15' }],
    finance_fx_revaluations: [{ period_end: '2026-10-31' }, { period_end: '2026-10-31' }, { period_end: '2026-09-30' }],
  };
  it('reads the first date of each kind of foreign item, one row each, and the month ends of the posted runs', async () => {
    const { ctx, calls } = fakeFinance((call) => ({ data: answers[call.name] ?? [], error: null }));
    expect(await readFxBooks(ctx)).toEqual({ firstForeignDate: '2026-09-01', revaluedMonthEnds: ['2026-10-31', '2026-09-30'] });
    expect(calls.map((c) => [c.name, c.columns, c.filters, c.order, c.limit])).toEqual([
      ['finance_invoices', 'invoice_date', { org_id: 'org-1', 'currency neq': 'MYR', 'status in': ['posted', 'void'] }, ['invoice_date asc'], 1],
      ['supplier_bills', 'bill_date', { org_id: 'org-1', 'currency neq': 'MYR', 'status in': ['posted', 'void'] }, ['bill_date asc'], 1],
      ['finance_accounts', 'opening_date', { org_id: 'org-1', 'currency neq': 'MYR', 'opening_balance neq': 0 }, ['opening_date asc'], 1],
      ['finance_transactions', 'txn_date', { org_id: 'org-1', 'currency neq': 'MYR', 'status in': ['posted', 'void'] }, ['txn_date asc'], 1],
      ['finance_fx_revaluations', 'period_end', { org_id: 'org-1' }, ['period_end desc'], undefined],
    ]);
  });
  it('has no first date for a ringgit-only workspace, and throws a read error', async () => {
    expect(await readFxBooks(fakeFinance({ data: [], error: null }).ctx)).toEqual({ firstForeignDate: null, revaluedMonthEnds: [] });
    await expect(readFxBooks(fakeFinance({ data: null, error: { code: 'XX000' } }).ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});
