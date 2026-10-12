import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaymentVouchersView, type VouchersWriter } from '@/components/finance/payment-vouchers-view';
import { SAMPLE_PAYMENT_VOUCHERS } from '@/screens/finance/cash-book-sample';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';

/**
 * The Payment Vouchers screen as the server sends it: rendered to a string and read as markup (no DOM here). A
 * person who is given no `writer` (a viewer, the demo workspace, the sample) must see nothing that changes data.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const never = async () => ({ ok: false as const, error: 'no' });
const writer = (canDecide: boolean): VouchersWriter => ({
  actions: { record: never, approve: never, reject: never, remove: never },
  canDecide,
  accounts: [],
  contacts: [],
  categories: [],
  orderNotes: {},
});

const render = (w?: VouchersWriter) =>
  renderToStaticMarkup(<PaymentVouchersView rows={SAMPLE_PAYMENT_VOUCHERS} today={SAMPLE_TODAY} followClock={false} writer={w} />);

/** How many row menus the markup holds. */
const menus = (html: string) => html.split('aria-haspopup').length - 1;

describe('the Payment Vouchers screen', () => {
  it('has no New voucher button, no Actions column and no row menu without a writer', () => {
    const html = render();
    expect(html).toContain('Payment Vouchers');
    expect(html).not.toContain('New voucher');
    expect(html).not.toContain('Actions');
    expect(html).not.toContain('aria-haspopup');
  });
  it('has them for a writer (so the test above would notice them)', () => {
    const html = render(writer(true));
    expect(html).toContain('New voucher');
    expect(html).toContain('Actions');
    expect(menus(html)).toBeGreaterThan(0);
  });
  it('gives a member a menu on the same rows as an owner: what differs is inside it', () => {
    // Every waiting row of the sample is of a kind that belongs here, so it has Delete for both.
    expect(menus(render(writer(false)))).toBe(menus(render(writer(true))));
  });
  it('still links a supplier payment and a refund to their own screens', () => {
    const html = render(writer(true));
    expect(html).toContain('href="/finance/payments-out"');
    expect(html).toContain('To be paid');
  });
});
