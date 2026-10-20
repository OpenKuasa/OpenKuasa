import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrderNotes } from '@/components/finance/order-notes';
import { PaymentFormCard } from '@/components/finance/payment-form-card';
import { type PaymentActions, PaymentsView } from '@/components/finance/payments-view';
import type { BillListRow } from '@/lib/finance/bills';
import type { FinanceAccount, PaymentOutRow } from '@/lib/finance/money';
import { type OrderBilling, paymentsView } from '@/lib/finance/purchase-views';
import { payableBills } from '@/lib/finance/payment-form';
import { ringgitBill } from './helpers/bill-rows';

/**
 * The Payments Out screen as the server sends it: rendered to a string and read as markup (no DOM here, so
 * nothing can be pressed). What a press decides is in tests/finance-payment-form.test.ts and
 * tests/finance-purchase-views.test.ts; the Mark as paid question and a bill being ticked need a browser.
 */

// A closed select draws no options. Here its options are drawn in place, and the chosen one is marked.
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Select: ({ value, children }: { value?: string; children?: ReactNode }) => <div data-chosen={value}>{children}</div>,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => <div data-option={value}>{children}</div>,
  };
});

const TODAY = '2026-10-10';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const MARK = "This bill’s purchase order is billed over its total or for more than has been received";
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const bill = (id: string, extra: Partial<BillListRow> = {}): BillListRow => ringgitBill({
  id,
  bill_no: `BILL-${id}`,
  supplier_id: SUPPLIER,
  supplier_name: 'Lim Hardware',
  bill_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 0,
  balance: 100,
  display_status: 'pending',
  purchase_order_id: null,
  purchase_order_no: null,
  category_id: null,
  category_name: null,
  ...extra,
});

const payment = (n: number, bill_id: string, status: PaymentOutRow['status'] = 'scheduled'): PaymentOutRow => ({
  allocation_id: `alloc-${n}`,
  transaction_id: `txn-${n}`,
  number: status === 'posted' ? `PV-000${n}` : null,
  txn_date: '2026-10-12',
  method: 'bank_transfer',
  amount: 100,
  transaction_amount: 100,
  status,
  reference: null,
  account_id: 'bank',
  account_name: 'Main Bank',
  bill_id,
  bill_no: `BILL-${bill_id}`,
  supplier_name: 'Lim Hardware',
});

const order = (extra: Partial<OrderBilling> = {}): OrderBilling => ({
  id: 'po-1',
  po_no: 'PO-0003',
  total: 1000,
  billed_total: 1250,
  received_total: 1000,
  over_billed: true,
  billed_over_received: false,
  currency: 'MYR',
  ...extra,
});

const accounts: FinanceAccount[] = [{ id: 'bank', name: 'Main Bank', kind: 'bank', bank_name: 'Maybank', currency: 'MYR' }];
const actions: PaymentActions = {
  record: vi.fn(),
  markPaid: vi.fn(),
  voidPayment: vi.fn(),
  remove: vi.fn(),
};

const render = (rows: PaymentOutRow[], bills: BillListRow[], orders: OrderBilling[], withWriter = true) =>
  renderToStaticMarkup(
    <PaymentsView
      rows={rows}
      view={paymentsView(rows, TODAY)}
      writer={withWriter ? { actions, bills, accounts, orders } : undefined}
    />,
  );

describe('the payments list', () => {
  const bills = [bill('a', { purchase_order_id: 'po-1', purchase_order_no: 'PO-0003' }), bill('b')];

  it('marks a payment still to be paid whose bill is over its purchase order, in words a screen reader gets', () => {
    const html = render([payment(1, 'a'), payment(2, 'b')], bills, [order()]);
    expect(html.split(`title="${MARK}"`)).toHaveLength(2);
    expect(html.split(`<span class="sr-only">${MARK}</span>`)).toHaveLength(2);
    // It sits in the flagged payment's row, beside its amount.
    const flaggedRow = html.split('<tr').find((r) => r.includes('BILL-a')) ?? '';
    expect(flaggedRow).toContain(MARK);
    const otherRow = html.split('<tr').find((r) => r.includes('BILL-b')) ?? '';
    expect(otherRow).not.toContain(MARK);
  });

  it('marks only the row of the bill that is over its order, in a payment over two bills', () => {
    const rows = [payment(1, 'b'), { ...payment(1, 'a'), allocation_id: 'alloc-1b' }];
    const html = render(rows, bills, [order()]);
    expect(html.split(`title="${MARK}"`)).toHaveLength(2);
    expect(html.split('<tr').find((r) => r.includes('BILL-a'))).toContain(MARK);
    expect(html.split('<tr').find((r) => r.includes('BILL-b'))).not.toContain(MARK);
  });

  it('marks a billed-over-received order too', () => {
    const html = render([payment(1, 'a')], bills, [order({ over_billed: false, billed_over_received: true })]);
    expect(html).toContain(MARK);
  });

  it('marks nothing on a payment that is paid or void', () => {
    const rows = [payment(1, 'a', 'posted'), payment(2, 'a', 'void')];
    // Void rows are hidden by the default filter; the paid one is shown, unmarked.
    expect(render(rows, bills, [order()])).not.toContain(MARK);
  });

  it('marks nothing when the order is fine, or the bill has none', () => {
    const rows = [payment(1, 'a'), payment(2, 'b')];
    expect(render(rows, bills, [order({ over_billed: false })])).not.toContain(MARK);
    expect(render(rows, bills, [])).not.toContain(MARK);
  });

  it('marks nothing for a reader, who is given no orders and cannot pay', () => {
    expect(render([payment(1, 'a')], [], [], false)).not.toContain(MARK);
  });
});

describe('the order notes', () => {
  it('draws each note in one status container', () => {
    const html = renderToStaticMarkup(<OrderNotes notes={['BILL-1 is against PO-3, over.', 'BILL-2 is against PO-4, over.']} />);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(text(html)).toBe('BILL-1 is against PO-3, over. BILL-2 is against PO-4, over.');
  });
  it('draws an empty status container for no notes, so a reader hears one appear', () => {
    const html = renderToStaticMarkup(<OrderNotes notes={[]} />);
    expect(html).toContain('role="status"');
    expect(text(html)).toBe('');
  });
});

describe('the Record Payment form', () => {
  const bills = [
    bill('a', { purchase_order_id: 'po-1', purchase_order_no: 'PO-0003' }),
    bill('b', { supplier_id: 'other', supplier_name: 'Maju', purchase_order_id: 'po-2', purchase_order_no: 'PO-0004' }),
  ];
  const card = (preselect: { supplierId: string; billId: string } | undefined, orders: OrderBilling[]) =>
    renderToStaticMarkup(
      <PaymentFormCard
        payable={payableBills(bills, [])}
        accounts={accounts}
        today={TODAY}
        preselect={preselect}
        orders={orders}
        record={vi.fn()}
        onClose={() => {}}
      />,
    );

  it('says so, in the status container, when a ticked bill is over its purchase order', () => {
    const html = card({ supplierId: SUPPLIER, billId: 'a' }, [order()]);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(text(html)).toContain('BILL-a is against PO-0003, whose bills come to RM 1,250.00, over its total of RM 1,000.00.');
  });

  it('keeps the status container, empty, when nothing is ticked or the ticked bill is fine', () => {
    for (const html of [card(undefined, [order()]), card({ supplierId: SUPPLIER, billId: 'a' }, [order({ over_billed: false })])]) {
      expect(html.match(/role="status"/g)).toHaveLength(1);
      expect(text(html)).not.toContain('is against');
    }
  });

  it('says nothing about a bill that is not ticked', () => {
    const html = card({ supplierId: 'other', billId: 'b' }, [order()]);
    expect(text(html)).not.toContain('is against PO-0003');
  });
});

describe('a bill in another currency on Payments Out (stage 4b)', () => {
  // Worked example B4: USD 1,080.00 at 4.2 (RM 4,536.00), USD 400.00 paid with RM 1,700.00.
  const usd = bill('u', {
    currency: 'USD', fx_rate: 4.2, fx_rate_text: '4.2000000000', fx_rate_source: 'manual', fx_rate_provider: 'reuters',
    total: 1080, balance: 680, paid: 400, total_myr: 4536, balance_myr: 2856,
  });
  const usdPaid: PaymentOutRow = {
    ...payment(1, 'u', 'posted'), amount: 400, transaction_amount: 1700, currency: 'USD', amount_myr: 1700, carried_myr: 1680, realised_myr: -20,
  };
  const myrPaid: PaymentOutRow = { ...payment(2, 'a', 'posted'), amount: 50, transaction_amount: 50 };

  it('shows the part in its currency, the ringgit paid out for it, and the realised difference', () => {
    const html = render([usdPaid, myrPaid], [usd, bill('a')], []);
    const row = text(html.split('<tr').find((r) => r.includes('BILL-u')) ?? '');
    expect(row).toContain('USD 400.00 · RM 1,700.00 Realised loss RM 20.00');
    expect(text(html.split('<tr').find((r) => r.includes('BILL-a')) ?? '')).toContain('RM 50.00');
    // Paid this month in ringgit: RM 50.00 + RM 1,700.00.
    expect(text(html)).toContain('RM 1,750');
  });

  it('asks for the ringgit paid out, and offers no "Schedule for later", once a USD bill is ticked', () => {
    const html = renderToStaticMarkup(
      <PaymentFormCard
        payable={payableBills([usd], [])}
        accounts={accounts}
        today={TODAY}
        preselect={{ supplierId: SUPPLIER, billId: 'u' }}
        orders={[]}
        record={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(text(html)).toContain('Ringgit paid out');
    expect(text(html)).toContain('USD 680.00 to pay (≈ RM 2,856.00 still carried)');
    expect(text(html)).not.toContain('Schedule for later');
    const ringgit = renderToStaticMarkup(
      <PaymentFormCard
        payable={payableBills([bill('a')], [])}
        accounts={accounts}
        today={TODAY}
        preselect={{ supplierId: SUPPLIER, billId: 'a' }}
        orders={[]}
        record={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(text(ringgit)).toContain('Schedule for later');
    expect(text(ringgit)).not.toContain('Ringgit paid out');
  });
});
