import { describe, expect, it } from 'vitest';
import { listOpenBills, listOpenInvoices, OPEN_PAGE_SIZE } from '@/lib/finance/reports-data';
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
