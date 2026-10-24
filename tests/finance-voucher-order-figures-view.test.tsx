import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoucherOrderFigures } from '@/components/finance/voucher-order-figures';
import type { VoucherFigures } from '@/lib/finance/voucher-order-figures';

/**
 * The figures beside the approve question (#242), as the approver reads them: one block per order with what was
 * ordered, received, billed and paid, this payment on its own line, then each bill with its share of the payment
 * and the supplier's own invoice number and date. Rendered to a string and read as markup, like the other cards.
 */

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const figures: VoucherFigures = {
  orders: [
    {
      orderId: 'po-1',
      poNo: 'PO-0001',
      currency: 'MYR',
      ordered: 325,
      received: 225,
      billed: 325,
      paid: 100,
      thisPayment: 275,
      setOff: 50,
      href: '/finance/purchase-orders?po=po-1',
      bills: [
        {
          id: 'b1',
          billNo: 'BILL-0001',
          supplierRef: 'INV-778',
          billDate: '2026-10-02',
          thisPayment: 275,
          currency: 'MYR',
        },
      ],
    },
  ],
  withoutOrder: [
    { id: 'b2', billNo: 'BILL-0002', supplierRef: null, billDate: '2026-10-03', thisPayment: 50, currency: 'MYR' },
  ],
};

describe('the figures beside the approve question', () => {
  it('shows the order once, with this payment on its own line and the contra line so the figures add up', () => {
    const t = text(renderToStaticMarkup(<VoucherOrderFigures figures={figures} />));
    expect(t).toContain('PO-0001');
    expect(t).toContain('Ordered RM 325.00');
    expect(t).toContain('Received RM 225.00');
    expect(t).toContain('Billed so far RM 325.00');
    expect(t).toContain('Paid so far RM 100.00');
    expect(t).toContain('This payment RM 275.00');
    expect(t).toContain('Set off by contra RM 50.00');
  });

  it("names each bill under the order with the supplier's own invoice number, its date and its share", () => {
    const t = text(renderToStaticMarkup(<VoucherOrderFigures figures={figures} />));
    expect(t).toContain('BILL-0001, INV-778, 02 Oct 2026');
    expect(t).toContain('BILL-0002, 03 Oct 2026');
    expect(t).toContain('No purchase order');
  });

  it('links the order to the screen that opens it', () => {
    const html = renderToStaticMarkup(<VoucherOrderFigures figures={figures} />);
    expect(html).toContain('href="/finance/purchase-orders?po=po-1"');
  });

  it('leaves the contra line out when no bill was settled by contra', () => {
    const plain: VoucherFigures = { orders: [{ ...figures.orders[0], setOff: 0 }], withoutOrder: [] };
    const t = text(renderToStaticMarkup(<VoucherOrderFigures figures={plain} />));
    expect(t).not.toContain('Set off by contra');
    expect(t).not.toContain('No purchase order');
  });
});
