import { describe, expect, it } from 'vitest';
import type { BillListRow } from '@/lib/finance/bills';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { buildFinanceOverview } from '@/lib/finance/overview';

const TODAY = '2026-10-12';

function invoice(over: Partial<InvoiceListRow>): InvoiceListRow {
  return {
    id: 'i',
    invoice_no: 'INV-1',
    customer_id: 'c1',
    customer_name: 'Siti Decor',
    invoice_date: '2026-09-01',
    due_date: '2026-10-30',
    total: 1000,
    paid: 0,
    credited: 0,
    refunded: 0,
    balance: 1000,
    display_status: 'sent',
    einvoice_status: 'none',
    einvoice_uuid: null,
    ...over,
  };
}

function bill(over: Partial<BillListRow>): BillListRow {
  return {
    id: 'b',
    bill_no: 'BILL-1',
    supplier_id: 's1',
    supplier_name: 'Lim Hardware',
    bill_date: '2026-09-20',
    due_date: '2026-10-20',
    total: 500,
    paid: 0,
    balance: 500,
    display_status: 'pending',
    purchase_order_id: null,
    purchase_order_no: null,
    category_id: null,
    category_name: null,
    ...over,
  };
}

describe('buildFinanceOverview', () => {
  it('is empty with no documents', () => {
    const m = buildFinanceOverview([], [], TODAY);
    expect(m.isEmpty).toBe(true);
    expect(m.receivable).toEqual({ total: 0, overdue: 0, openCount: 0, overdueCount: 0 });
    expect(m.payable).toEqual({ total: 0, overdue: 0, openCount: 0, overdueCount: 0 });
    expect(m.overdueInvoices).toEqual([]);
  });

  it('totals only open (sent/overdue) invoices with money owed, to the sen', () => {
    const m = buildFinanceOverview(
      [
        invoice({ id: 'a', balance: 0.1 }),
        invoice({ id: 'b', balance: 0.2, display_status: 'overdue', due_date: '2026-10-02' }),
        invoice({ id: 'c', balance: 900, display_status: 'draft' }),
        invoice({ id: 'd', balance: 900, display_status: 'void' }),
        invoice({ id: 'e', balance: 0, display_status: 'paid' }),
        invoice({ id: 'f', balance: -50, display_status: 'sent' }),
      ],
      [],
      TODAY,
    );
    expect(m.receivable).toEqual({ total: 0.3, overdue: 0.2, openCount: 2, overdueCount: 1 });
    expect(m.isEmpty).toBe(false);
  });

  it('lists overdue invoices oldest first with days overdue, capped', () => {
    const rows = [
      invoice({ id: 'a', invoice_no: 'INV-1', customer_name: 'A', balance: 100, display_status: 'overdue', due_date: '2026-10-10' }),
      invoice({ id: 'b', invoice_no: 'INV-2', customer_name: 'B', balance: 200, display_status: 'overdue', due_date: '2026-08-01' }),
      invoice({ id: 'c', invoice_no: null, customer_name: 'C', balance: 300, display_status: 'overdue', due_date: '2026-09-01' }),
    ];
    const m = buildFinanceOverview(rows, [], TODAY, { limit: 2 });
    expect(m.overdueInvoices.map((r) => [r.customer, r.daysOverdue])).toEqual([
      ['B', 72],
      ['C', 41],
    ]);
    expect(m.overdueInvoices[1].number).toBe('Draft');
    expect(m.receivable.overdueCount).toBe(3);
  });

  it('groups outstanding by customer, largest first', () => {
    const m = buildFinanceOverview(
      [
        invoice({ id: 'a', customer_id: 'c1', customer_name: 'Siti Decor', balance: 600.5 }),
        invoice({ id: 'b', customer_id: 'c1', customer_name: 'Siti Decor', balance: 100.25, display_status: 'overdue', due_date: '2026-10-01' }),
        invoice({ id: 'c', customer_id: 'c2', customer_name: 'Zaki', balance: 900 }),
      ],
      [],
      TODAY,
    );
    expect(m.outstandingByCustomer).toEqual([
      { label: 'Zaki', amount: 900 },
      { label: 'Siti Decor', amount: 700.75 },
    ]);
  });

  it('totals open bills and lists them by due date, soonest first', () => {
    const m = buildFinanceOverview(
      [],
      [
        bill({ id: 'a', bill_no: 'BILL-3', balance: 300, due_date: '2026-10-25' }),
        bill({ id: 'b', bill_no: 'BILL-2', balance: 200, due_date: '2026-10-01', display_status: 'overdue' }),
        bill({ id: 'c', balance: 999, display_status: 'draft' }),
        bill({ id: 'd', balance: 0, display_status: 'paid' }),
      ],
      TODAY,
    );
    expect(m.payable).toEqual({ total: 500, overdue: 200, openCount: 2, overdueCount: 1 });
    expect(m.unpaidBills.map((b) => [b.number, b.overdue])).toEqual([
      ['BILL-2', true],
      ['BILL-3', false],
    ]);
  });

  it('lists recorded e-Invois status for issued invoices, newest first', () => {
    const m = buildFinanceOverview(
      [
        invoice({ id: 'a', invoice_no: 'INV-1', invoice_date: '2026-09-01', einvoice_status: 'validated' }),
        invoice({ id: 'b', invoice_no: 'INV-2', invoice_date: '2026-10-01', einvoice_status: 'pending' }),
        invoice({ id: 'c', invoice_no: 'INV-3', einvoice_status: 'none' }),
        invoice({ id: 'd', invoice_no: 'INV-4', einvoice_status: 'rejected', display_status: 'void' }),
      ],
      [],
      TODAY,
    );
    expect(m.eInvoices.map((e) => [e.number, e.status])).toEqual([
      ['INV-2', 'pending'],
      ['INV-1', 'validated'],
    ]);
  });
});
