import { describe, expect, it } from 'vitest';
import { RECENT_LISTED, TOP_CUSTOMERS_LISTED, buildBillings } from '@/lib/crm/billings';
import type { InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow } from '@/lib/finance/money';
import { ringgitRow } from './helpers/invoice-rows';

/** 10 Oct 2026, mid-morning in Kuala Lumpur. */
const NOW = new Date('2026-10-10T02:00:00.000Z');

let seq = 0;
function invoice(
  status: InvoiceDisplayStatus,
  total: number,
  paid: number,
  over: Partial<InvoiceListRow> = {},
): InvoiceListRow {
  seq += 1;
  return ringgitRow({
    id: `inv-${String(seq).padStart(3, '0')}`,
    invoice_no: status === 'draft' ? null : `INV-${seq}`,
    customer_id: 'c1',
    customer_name: 'Aisyah Trading',
    invoice_date: '2026-10-05',
    due_date: '2026-11-04',
    total,
    paid,
    credited: 0,
    refunded: 0,
    balance: total - paid,
    display_status: status,
    einvoice_status: 'none',
    einvoice_uuid: null,
    ...over,
  });
}

describe('Kasturi’s Billings figures', () => {
  it('count only posted invoices as billed: drafts and void ones are left out', () => {
    const model = buildBillings(
      [
        invoice('sent', 1000, 0),
        invoice('paid', 500.1, 500.1),
        invoice('overdue', 250.2, 50, { invoice_date: '2026-09-01', due_date: '2026-09-15' }),
        invoice('draft', 9000, 0),
        invoice('void', 7000, 0),
      ],
      NOW,
    );
    expect(model.monthTitle).toBe('October 2026');
    expect(model.stats).toEqual({
      billedThisMonth: 1500.1,
      billedThisMonthCount: 2,
      outstanding: 1200.2,
      outstandingCount: 2,
      overdue: 200.2,
      overdueCount: 1,
      received: 550.1,
      // 550.10 of 1,750.30.
      collectionRate: 31,
    });
    expect(model.total).toBe(5);
    expect(model.byStatus).toEqual([
      { status: 'draft', count: 1 },
      { status: 'sent', count: 1 },
      { status: 'overdue', count: 1 },
      { status: 'paid', count: 1 },
      { status: 'void', count: 1 },
    ]);
  });

  it('take this month from the date in Malaysia, not UTC', () => {
    // 17:00 UTC on 30 Sep is 1:00 am on 1 Oct in Kuala Lumpur.
    const model = buildBillings(
      [invoice('sent', 100, 0, { invoice_date: '2026-10-01' }), invoice('sent', 40, 0, { invoice_date: '2026-09-30' })],
      new Date('2026-09-30T17:00:00.000Z'),
    );
    expect(model.monthTitle).toBe('October 2026');
    expect(model.stats.billedThisMonth).toBe(100);
  });

  it('show six months of billing, oldest first, ending with this month', () => {
    const model = buildBillings(
      [
        invoice('paid', 300, 300, { invoice_date: '2026-05-20' }),
        invoice('sent', 200, 0, { invoice_date: '2026-08-02' }),
        invoice('sent', 50, 0, { invoice_date: '2026-08-30' }),
        invoice('sent', 75, 0, { invoice_date: '2026-04-30' }),
      ],
      NOW,
    );
    expect(model.trend).toEqual([
      { month: '2026-05', label: 'May', billed: 300 },
      { month: '2026-06', label: 'Jun', billed: 0 },
      { month: '2026-07', label: 'Jul', billed: 0 },
      { month: '2026-08', label: 'Aug', billed: 250 },
      { month: '2026-09', label: 'Sep', billed: 0 },
      { month: '2026-10', label: 'Oct', billed: 0 },
    ]);
  });

  it('a customer in credit owes nothing, rather than reducing what others owe', () => {
    const model = buildBillings(
      [invoice('sent', 400, 0), invoice('paid', 100, 150, { balance: -50, customer_id: 'c2', customer_name: 'Zaki' })],
      NOW,
    );
    expect(model.stats.outstanding).toBe(400);
    expect(model.stats.collectionRate).toBe(30);
  });

  it('rank customers by what they were billed, with what each still owes', () => {
    const rows = [
      invoice('sent', 100, 0, { customer_id: 'c2', customer_name: 'Zaki Enterprise' }),
      invoice('paid', 900, 900),
      invoice('overdue', 300, 100),
      invoice('draft', 5000, 0, { customer_id: 'c3', customer_name: 'Draft Only' }),
      ...Array.from({ length: TOP_CUSTOMERS_LISTED }, (_, i) =>
        invoice('paid', 10 + i, 10 + i, { customer_id: `x${i}`, customer_name: `Small ${i}` }),
      ),
    ];
    const { topCustomers } = buildBillings(rows, NOW);
    expect(topCustomers).toHaveLength(TOP_CUSTOMERS_LISTED);
    expect(topCustomers.slice(0, 2)).toEqual([
      { id: 'c1', name: 'Aisyah Trading', billed: 1200, outstanding: 200 },
      { id: 'c2', name: 'Zaki Enterprise', billed: 100, outstanding: 100 },
    ]);
    expect(topCustomers.map((customer) => customer.name)).not.toContain('Draft Only');
  });

  it('list the newest invoices first, drafts included', () => {
    const rows = Array.from({ length: RECENT_LISTED + 2 }, (_, i) =>
      invoice(i === 0 ? 'draft' : 'sent', 10, 0, { invoice_date: `2026-10-${String(i + 1).padStart(2, '0')}` }),
    );
    const { recent } = buildBillings(rows, NOW);
    expect(recent).toHaveLength(RECENT_LISTED);
    expect(recent[0].invoice_date).toBe('2026-10-10');
    expect(recent.at(-1)?.invoice_date).toBe('2026-10-03');
  });

  it('an empty workspace has zeros and no collection rate', () => {
    const model = buildBillings([], NOW);
    expect(model.stats.collectionRate).toBeNull();
    expect(model.stats.outstanding).toBe(0);
    expect(model.topCustomers).toEqual([]);
    expect(model.recent).toEqual([]);
    expect(model.trend).toHaveLength(6);
  });
});

/** A posted payment in against an invoice; the ringgit that arrived is `amount_myr`. */
function payment(invoiceId: string, amount: number, over: Partial<PaymentInRow> = {}): PaymentInRow {
  seq += 1;
  return {
    allocation_id: `al-${seq}`,
    transaction_id: `tx-${seq}`,
    number: `PV-${seq}`,
    txn_date: '2026-10-06',
    method: 'bank_transfer',
    amount,
    transaction_amount: amount,
    status: 'posted',
    reference: null,
    account_id: 'acc1',
    account_name: 'Maybank',
    invoice_id: invoiceId,
    invoice_no: null,
    customer_name: 'Aisyah Trading',
    ...over,
  };
}

describe('Kasturi’s Billings received figure (what arrived, as Bendahara shows it)', () => {
  // Worked example: worth RM 1,680 at its rate; the customer pays and RM 1,658 arrives (carried 1,680, loss 22).
  const usd = () =>
    invoice('paid', 400, 400, {
      currency: 'USD',
      fx_rate: 4.2,
      fx_rate_text: '4.2000000000',
      total_myr: 1680,
      balance_myr: 0,
      balance: 0,
      paid_myr: 1680,
    });
  const arrived = { currency: 'USD', amount_myr: 1658, carried_myr: 1680, realised_myr: -22 };

  it('counts the ringgit that arrived for a foreign invoice, and still owes nothing', () => {
    const row = usd();
    const model = buildBillings([row], NOW, new Map(), [payment(row.id, 400, arrived)]);
    expect(model.stats.received).toBe(1658);
    expect(model.stats.outstanding).toBe(0);
    expect(model.stats.billedThisMonth).toBe(1680);
    expect(model.topCustomers[0]).toMatchObject({ billed: 1680, outstanding: 0 });
  });

  it('leaves out a voided payment', () => {
    const row = usd();
    const model = buildBillings([row], NOW, new Map(), [payment(row.id, 400, { ...arrived, status: 'void' })]);
    expect(model.stats.received).toBe(0);
  });

  it('is unchanged for a ringgit invoice: the amount paid', () => {
    const row = invoice('sent', 500, 200);
    const model = buildBillings([row], NOW, new Map(), [
      payment(row.id, 200, { amount_myr: 200, carried_myr: 200, realised_myr: 0 }),
    ]);
    expect(model.stats.received).toBe(200);
    expect(model.stats.outstanding).toBe(300);
    expect(model.stats.collectionRate).toBe(40);
  });

  it('counts only payments of issued invoices', () => {
    const draft = invoice('draft', 500, 0);
    const model = buildBillings([draft], NOW, new Map(), [payment(draft.id, 50)]);
    expect(model.stats.received).toBe(0);
  });
});
