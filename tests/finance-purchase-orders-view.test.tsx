import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentFormCard } from '@/components/finance/document-form-card';
import { PurchaseOrderFormCard } from '@/components/finance/purchase-order-form-card';
import { PurchaseOrderReceiveCard } from '@/components/finance/purchase-order-receive-card';
import { PurchaseOrderRejectCard } from '@/components/finance/purchase-order-reject-card';
import { type PurchaseOrderActions, PurchaseOrdersView, createBillQuestion } from '@/components/finance/purchase-orders-view';
import { PURCHASE_ORDER_FORM_KIND, newPurchaseOrderForm, receiptDrafts, submitReceipts } from '@/lib/finance/purchase-order-form';
import { PURCHASE_ORDER_MESSAGES, type PurchaseOrderDetail, type PurchaseOrderListRow } from '@/lib/finance/purchase-orders';

/**
 * The Purchase Orders screen, as the server sends it: rendered to a string and
 * read as markup. There is no DOM here (node, no jsdom), so nothing can be
 * pressed or typed: what a press decides is in plain functions
 * (tests/finance-purchase-order-form.test.ts, tests/finance-purchase-views.test.ts).
 * What still needs a browser is checked by hand.
 */

// A closed menu draws nothing but its button. Here its items are drawn in place, so what the menu offers can be read.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Item = ({ children }: { children?: ReactNode }) => <div role="menuitem">{children}</div>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: Item,
  };
});

// A closed select draws no options. Here its options are drawn in place, and the chosen one is marked.
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Select: ({ value, children }: { value?: string; children?: ReactNode }) => <div data-chosen={value}>{children}</div>,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => <span data-option={value}>{children}</span>,
  };
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = (html: string) =>
  [...html.matchAll(/<div role="menuitem">([\s\S]*?)<\/div>/g)].map(([, inner]) => text(inner));

const ME = 'user-me';
const OTHER = 'user-other';
const member = { userId: ME, canSignOff: false, isOwner: false };
const admin = { userId: ME, canSignOff: true, isOwner: false };

const row = (over: Partial<PurchaseOrderListRow> = {}): PurchaseOrderListRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  po_no: 'PO-0001',
  supplier_id: 'sup-1',
  supplier_name: 'Kopi Hulu Supplies',
  rfq_id: null,
  rfq_no: null,
  po_date: '2026-10-01',
  expected_date: '2026-10-15',
  status: 'approved',
  created_by: OTHER,
  submitted_by: OTHER,
  rejection_reason: null,
  payment_terms_days: 30,
  delivery_address: null,
  total: 1000,
  delivery: 'pending',
  received_total: 0,
  billed_total: 0,
  over_billed: false,
  billed_over_received: false,
  ...over,
});

const done = <T,>(data: T) => vi.fn(async () => ({ ok: true as const, data }));
const actions: PurchaseOrderActions = {
  save: done({ id: 'x' }),
  saveAndPost: done({ id: 'x', po_no: 'PO-0001' }),
  submit: done({ id: 'x', po_no: 'PO-0001' }),
  decide: done({ id: 'x' }),
  withdraw: done({ id: 'x' }),
  receive: done({ id: 'x' }),
  close: done({ id: 'x' }),
  cancel: done({ id: 'x' }),
  remove: done({ id: 'x' }),
  billFrom: done({ id: 'x', bill_id: 'y' }),
  get: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
  getApproved: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
};
const writerFor = (viewer = member) => ({ viewer, actions, suppliers: [], products: [] });

const render = (rows: PurchaseOrderListRow[], viewer: typeof member | null = member) =>
  renderToStaticMarkup(<PurchaseOrdersView rows={rows} writer={viewer ? writerFor(viewer) : undefined} />);

describe('the purchase orders list', () => {
  it('gives a writer New purchase order, and the three counts', () => {
    const html = render([
      row({ status: 'pending_approval' }),
      row({ id: 'b', po_no: 'PO-0002', status: 'approved' }),
      row({ id: 'c', po_no: 'PO-0003', status: 'approved', over_billed: true }),
    ]);
    expect(text(html)).toContain('New purchase order');
    expect(text(html)).toContain('Awaiting approval 1');
    expect(text(html)).toContain('Approved and open 2');
    expect(text(html)).toContain('Billed over the order 1');
  });

  it('offers a member the menu for each status, as purchaseOrderActions decides', () => {
    expect(items(render([row({ status: 'draft', po_no: null, created_by: ME })]))).toEqual(['Edit', 'Submit for approval', 'Delete']);
    expect(items(render([row({ status: 'draft', po_no: 'PO-0004', created_by: OTHER })]))).toEqual(['Edit', 'Submit for approval']);
    expect(items(render([row({ status: 'pending_approval', created_by: ME })]))).toEqual(['Withdraw', 'Cancel order']);
    expect(items(render([row({ status: 'approved' })]))).toEqual(['Record delivery', 'Create bill']);
    expect(items(render([row({ status: 'closed' })], member))).toEqual([]);
  });

  it('offers a sign-off viewer approve, reject, close and cancel', () => {
    expect(items(render([row({ status: 'pending_approval' })], admin))).toEqual(['Approve', 'Reject', 'Withdraw', 'Cancel order']);
    expect(items(render([row({ status: 'approved' })], admin))).toEqual(['Record delivery', 'Create bill', 'Close order', 'Cancel order']);
  });

  it('does not offer a sign-off viewer to approve an order they raised, unless they own the workspace', () => {
    const mine = row({ status: 'pending_approval', created_by: ME });
    expect(items(render([mine], admin))).toEqual(['Reject', 'Withdraw', 'Cancel order']);
    expect(items(render([mine], { ...admin, isOwner: true }))).toEqual(['Approve', 'Reject', 'Withdraw', 'Cancel order']);
  });

  it('gives a reader no New button and no menu, only the list and Export', () => {
    const html = render([row({ status: 'draft', po_no: null })], null);
    expect(text(html)).not.toContain('New purchase order');
    expect(html).not.toContain('Actions for');
    expect(items(html)).toEqual([]);
    expect(text(html)).toContain('Export');
  });

  it('shows Draft for an order with no number, and the RFQ number when it came from one', () => {
    const t = text(render([row({ status: 'draft', po_no: null, rfq_no: 'RFQ-0012' })]));
    expect(t).toContain('Draft');
    expect(t).toContain('RFQ-0012');
  });

  it('shows a rejected draft its reason under the status', () => {
    const t = text(render([row({ status: 'draft', po_no: 'PO-0005', rejection_reason: 'Price too high' })]));
    expect(t).toContain('Rejected: Price too high');
  });

  it('warns when billed over the order, and when billed over what has arrived', () => {
    const over = render([row({ billed_total: 1200, over_billed: true })]);
    expect(over).toContain('Billed more than the order');
    expect(over).not.toContain('Billed more than has arrived');
    const early = render([row({ delivery: 'partial', received_total: 400, billed_total: 600, billed_over_received: true })]);
    expect(early).toContain('Billed more than has arrived');
    expect(early).not.toContain('Billed more than the order');
    const fine = render([row({ billed_total: 500 })]);
    expect(fine).not.toContain('Billed more than');
  });

  it('draws the two billed warnings with different icons', () => {
    const over = render([row({ billed_total: 1200, over_billed: true })]);
    const early = render([row({ delivery: 'partial', received_total: 400, billed_total: 600, billed_over_received: true })]);
    expect(over).toContain('lucide-triangle-alert');
    expect(over).not.toContain('lucide-package-x');
    expect(early).toContain('lucide-package-x');
    expect(early).not.toContain('lucide-triangle-alert');
  });

  it('asks before another bill is made from an order that already has bills, and not otherwise', () => {
    expect(createBillQuestion(row({ billed_total: 300 }))).toBe('PO-0001 already has RM 300.00 billed. Make another draft bill for the full order?');
    expect(createBillQuestion(row({ billed_total: 0 }))).toBeNull();
  });

  it('shows the delivery of an approved order, and shows only open orders until a status is chosen', () => {
    const t = text(render([row({ delivery: 'partial' }), row({ id: 'z', po_no: 'PO-0099', status: 'cancelled' })]));
    expect(t).toContain('Partly delivered');
    expect(t).not.toContain('PO-0099');
  });
});

describe('the purchase order form', () => {
  const html = () =>
    renderToStaticMarkup(
      <PurchaseOrderFormCard
        suppliers={[{ id: 'sup-1', name: 'Kopi Hulu Supplies', payment_terms_days: 30 } as never]}
        products={[]}
        today="2026-10-10"
        actions={actions}
        onClose={() => {}}
      />,
    );

  it('draws the payment terms and delivery address after the dates, with the helper line', () => {
    const t = text(html()).replace(/&#x27;/g, "'");
    expect(t).toContain('Payment terms (days)');
    expect(t).toContain('Delivery address (optional)');
    expect(t).toContain("Leave empty to use the supplier's terms.");
    expect(t.indexOf('Expected delivery')).toBeLessThan(t.indexOf('Payment terms (days)'));
    expect(t.indexOf('Delivery address')).toBeLessThan(t.indexOf('Lines'));
    expect(html()).toContain('inputMode="numeric"');
  });

  it('draws nothing extra for a kind without extras', () => {
    const kind = { ...PURCHASE_ORDER_FORM_KIND, extras: undefined };
    const plain = renderToStaticMarkup(
      <DocumentFormCard
        kind={kind}
        initial={() => newPurchaseOrderForm('2026-10-10', 'k')}
        parties={[{ id: 'sup-1', name: 'A', payment_terms_days: 0 }]}
        products={[]}
        actions={actions}
        onClose={() => {}}
      />,
    );
    expect(text(plain)).not.toContain('Payment terms');
    expect(text(plain)).not.toContain('Delivery address');
  });
});

describe('the reject card', () => {
  it('asks for a reason of up to 200 characters, with Reject and Cancel', () => {
    const html = renderToStaticMarkup(<PurchaseOrderRejectCard order={row({ status: 'pending_approval' })} decide={actions.decide} onClose={() => {}} />);
    expect(text(html)).toContain('Reason');
    expect(html).toContain('maxLength="200"');
    expect(text(html)).toContain('Reject');
    expect(text(html)).toContain('Cancel');
  });

  it('says the order goes to the supplier', () => {
    const html = renderToStaticMarkup(<PurchaseOrderRejectCard order={row({ status: 'pending_approval' })} decide={actions.decide} onClose={() => {}} />);
    expect(text(html)).toContain('PO-0001 to Kopi Hulu Supplies');
    expect(text(html)).not.toContain('from Kopi Hulu Supplies');
  });
});

describe('the receive card', () => {
  const order: PurchaseOrderDetail = {
    ...row({ status: 'approved' }),
    subtotal: 1000,
    sst_total: 0,
    notes: null,
    lines: [
      { id: '11111111-1111-4111-8111-1111111111a1', product_id: null, description: 'Arabica beans', quantity: 5, uom: 'kg', pack_size: null, unit_price: 100, sst_rate: 0, amount: 500, sst_amount: 0, received_quantity: 2 },
      { id: '11111111-1111-4111-8111-1111111111a2', product_id: null, description: 'Paper cups', quantity: 200, uom: 'pcs', pack_size: null, unit_price: 2, sst_rate: 6, amount: 400, sst_amount: 24, received_quantity: 0 },
    ],
  };

  it('says to enter the total so far, and shows each line with what was ordered', () => {
    const html = renderToStaticMarkup(<PurchaseOrderReceiveCard order={order} receive={actions.receive} onClose={() => {}} />);
    const t = text(html);
    expect(t).toContain('Enter the total that has arrived so far, not just this delivery.');
    expect(t).toContain('Arabica beans');
    expect(t).toContain('Paper cups');
    expect(t).toContain('5 kg');
    expect(html).toContain('Total received for line 1, Arabica beans');
    // Nothing over the ordered quantity yet.
    expect(t).not.toContain('More than ordered');
  });

  it('ties the More than ordered note to its box', () => {
    const over = { ...order, lines: [{ ...order.lines[0], received_quantity: 9 }, order.lines[1]] };
    const html = renderToStaticMarkup(<PurchaseOrderReceiveCard order={over} receive={actions.receive} onClose={() => {}} />);
    const note = html.match(/<span id="([^"]+)"[^>]*>More than ordered<\/span>/);
    expect(note).not.toBeNull();
    const box = html.match(/<input[^>]*Total received for line 1[^>]*>/)?.[0] ?? '';
    expect(box).toContain(note![1]);
  });

  it('refuses an empty box before any call, and lets an over-delivery through', () => {
    const drafts = receiptDrafts(order);
    expect(submitReceipts(order.id, drafts.map((d, i) => (i === 0 ? { ...d, received: '' } : d)))).toEqual({
      error: PURCHASE_ORDER_MESSAGES.received,
    });
    expect(submitReceipts(order.id, drafts.map((d, i) => (i === 0 ? { ...d, received: '9' } : d)))).not.toHaveProperty('error');
  });
});
