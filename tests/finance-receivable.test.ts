import { describe, expect, it } from 'vitest';
import { type FinanceContact, contactsView, listBillBalances, listInvoiceBalances } from '@/lib/finance/contacts';
import type { FinanceWriteContext } from '@/lib/finance/result';

type Page = { data: unknown[] | null; error: unknown };
type Request = { view: string; columns: string; filters: Record<string, unknown>; within: Record<string, unknown[]>; range: [number, number] };

/** A stand-in list query: from → select → eq → in → order → range, answering one canned page per range call. */
function fakeListClient(pages: Page[]) {
  const requests: Request[] = [];
  const client = {
    from(view: string) {
      const request: Request = { view, columns: '', filters: {}, within: {}, range: [0, 0] };
      const builder = {
        select(columns: string) { request.columns = columns; return builder; },
        eq(column: string, value: unknown) { request.filters[column] = value; return builder; },
        in(column: string, values: unknown[]) { request.within[column] = values; return builder; },
        order() { return builder; },
        range(from: number, to: number) {
          request.range = [from, to];
          requests.push(request);
          return Promise.resolve(pages[requests.length - 1] ?? { data: [], error: null });
        },
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, requests };
}

const contact = (c: Partial<FinanceContact>): FinanceContact => ({
  id: 'c1',
  name: 'Aisyah Trading',
  is_customer: true,
  is_supplier: false,
  email: null,
  phone: null,
  ssm_no: null,
  tin: null,
  payment_terms_days: 30,
  active: true,
  ...c,
});

describe('Receivable and a customer in credit', () => {
  it('does not take a customer’s credit on one invoice off what they owe on another', () => {
    const view = contactsView(
      [contact({ id: 'c1' })],
      [],
      [
        { customer_id: 'c1', balance: 500, display_status: 'sent' },
        // Only open invoices are read; if a paid one in credit arrived anyway it would not be counted.
        { customer_id: 'c1', balance: -200, display_status: 'paid' },
      ],
    );
    expect(view.stats.receivable).toBe(500);
    expect(view.rows[0].receivable).toBe(500);
  });
});

describe('listInvoiceBalances', () => {
  const invoice = (n: number) => ({ customer_id: 'c1', balance: String(n), display_status: 'sent' });

  it('reads the open invoices of the caller’s workspace from the totals view, with balances as numbers', async () => {
    const { ctx, requests } = fakeListClient([{ data: [invoice(12.5), { ...invoice(7), display_status: 'overdue' }], error: null }]);
    expect(await listInvoiceBalances(ctx)).toEqual([
      { customer_id: 'c1', balance: 12.5, display_status: 'sent' },
      { customer_id: 'c1', balance: 7, display_status: 'overdue' },
    ]);
    expect(requests).toEqual([
      {
        view: 'finance_invoice_totals',
        columns: 'customer_id, balance, display_status',
        filters: { org_id: 'org-1' },
        within: { display_status: ['sent', 'overdue'] },
        range: [0, 999],
      },
    ]);
  });
  it('keeps reading until a short page, so no invoice is left out', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => invoice(i + 1));
    const { ctx, requests } = fakeListClient([{ data: full, error: null }, { data: [invoice(5)], error: null }]);
    const rows = await listInvoiceBalances(ctx);
    expect(requests.map((r) => r.range)).toEqual([[0, 999], [1000, 1999]]);
    expect(rows).toHaveLength(1001);
    expect(rows.every((r) => typeof r.balance === 'number')).toBe(true);
  });
  it('throws a database error instead of swallowing it', async () => {
    const failure = { code: 'XX000', message: 'boom' };
    const { ctx } = fakeListClient([{ data: null, error: failure }]);
    await expect(listInvoiceBalances(ctx)).rejects.toBe(failure);
  });
  it('leaves the bills read as it was: its own view, its own column, its own statuses', async () => {
    const { ctx, requests } = fakeListClient([{ data: [], error: null }]);
    expect(await listBillBalances(ctx)).toEqual([]);
    expect(requests[0]).toMatchObject({
      view: 'supplier_bill_totals',
      columns: 'supplier_id, balance, display_status',
      within: { display_status: ['pending', 'overdue'] },
    });
  });
});

describe('contactsView with invoices', () => {
  const aisyah = contact({});
  const both = contact({ id: 'b1', name: 'Lim Hardware Sdn Bhd', is_supplier: true });
  const archived = contact({ id: 'c2', name: 'Old Customer', active: false });
  const bills = [{ supplier_id: 'b1', balance: 300, display_status: 'pending' }];
  const invoices = [
    { customer_id: 'c1', balance: 2499.9, display_status: 'sent' },
    { customer_id: 'c1', balance: 0.1, display_status: 'overdue' },
    { customer_id: 'c1', balance: 780.4, display_status: 'draft' },
    { customer_id: 'c1', balance: 0, display_status: 'paid' },
    { customer_id: 'c1', balance: 999, display_status: 'void' },
    { customer_id: 'b1', balance: 120, display_status: 'sent' },
    { customer_id: 'c2', balance: 50, display_status: 'overdue' },
  ];

  it('sums what customers owe on sent and overdue invoices only, to the sen', () => {
    const view = contactsView([aisyah, both, archived], bills, invoices);
    expect(view.stats).toEqual({ customers: 2, suppliers: 1, receivable: 2670, payable: 300 });
  });
  it('gives each contact its receivable beside its payable, including an archived one and one that is both', () => {
    const view = contactsView([aisyah, both, archived], bills, invoices);
    expect(Object.fromEntries(view.rows.map((r) => [r.id, [r.receivable, r.payable]]))).toEqual({
      c1: [2500, 0],
      b1: [120, 300],
      c2: [50, 0],
    });
  });
  it('counts a receivable from a customer that is not among the loaded contacts', () => {
    const view = contactsView([aisyah], [], [...invoices, { customer_id: 'not-loaded', balance: 10, display_status: 'sent' }]);
    expect(view.stats.receivable).toBe(2680);
  });
  it('is 0 with no invoices, and when none are given', () => {
    expect(contactsView([aisyah], bills, []).stats.receivable).toBe(0);
    const view = contactsView([aisyah], bills);
    expect(view.stats.receivable).toBe(0);
    expect(view.rows[0].receivable).toBe(0);
  });
  it('leaves the largest-balances chart to what is owed to suppliers', () => {
    expect(contactsView([aisyah, both], bills, invoices).topBalances).toEqual([{ label: 'Lim Hardware Sdn Bhd', balance: 300 }]);
  });
});
