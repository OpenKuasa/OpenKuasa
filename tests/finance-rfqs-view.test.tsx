import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FinanceContact } from '@/lib/finance/contacts';
import { RfqFormCard } from '@/components/finance/rfq-form-card';
import { RfqPricesCard } from '@/components/finance/rfq-prices-card';
import { type RfqActions, RfqsView } from '@/components/finance/rfqs-view';
import { rfqActions } from '@/lib/finance/purchase-views';
import { priceDrafts, quoteFormError, quotePayload, submitPrices } from '@/lib/finance/rfq-form';
import { RFQ_MESSAGES, type RfqDetail, type RfqListRow } from '@/lib/finance/rfqs';

/**
 * The RFQs screen, as the server sends it: rendered to a string and read as
 * markup. There is no DOM here (node, no jsdom), so nothing can be pressed or
 * typed: what a press decides is in plain functions (tests/finance-rfq-form.test.ts,
 * tests/finance-purchase-views.test.ts). What still needs a browser is
 * checked by hand.
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

const TODAY = '2026-10-10';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = (html: string) =>
  [...html.matchAll(/<div role="menuitem">([\s\S]*?)<\/div>/g)].map(([, inner]) => text(inner));

const row = (over: Partial<RfqListRow> = {}): RfqListRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  rfq_no: 'RFQ-0001',
  supplier_id: 'sup-1',
  supplier_name: 'Kopi Hulu Supplies',
  rfq_date: '2026-10-01',
  reply_by: '2026-10-20',
  supplier_ref: null,
  status: 'sent',
  line_count: 2,
  total: 0,
  fully_priced: false,
  purchase_order_id: null,
  purchase_order_no: null,
  ...over,
});

const done = <T,>(data: T) => vi.fn(async () => ({ ok: true as const, data }));
const actions: RfqActions = {
  save: done({ id: 'x' }),
  saveAndPost: done({ id: 'x', rfq_no: 'RFQ-0001' }),
  send: done({ id: 'x', rfq_no: 'RFQ-0001' }),
  quote: done({ id: 'x' }),
  close: done({ id: 'x' }),
  remove: done({ id: 'x' }),
  get: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
  getSent: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
};
const writer = { actions, suppliers: [], products: [] };

const render = (rows: RfqListRow[], withWriter = true) =>
  renderToStaticMarkup(<RfqsView rows={rows} today={TODAY} followClock={false} writer={withWriter ? writer : undefined} />);

describe('the RFQs list', () => {
  it('gives a writer New RFQ, and the counts in the header', () => {
    const html = render([row({ status: 'sent' }), row({ id: 'b', rfq_no: 'RFQ-0002', reply_by: '2026-10-05' })]);
    expect(text(html)).toContain('New RFQ');
    expect(text(html)).toContain('Awaiting reply 2');
    expect(text(html)).toContain('Reply overdue 1');
    expect(text(html)).toContain('Quoted 0');
  });

  it('offers a draft Edit, Mark as sent and Delete', () => {
    const html = render([row({ status: 'draft', rfq_no: null })]);
    expect(items(html)).toEqual(['Edit', 'Mark as sent', 'Delete']);
    expect(text(html)).toContain('Draft');
  });

  it('offers a sent RFQ Record prices and Close', () => {
    expect(items(render([row({ status: 'sent' })]))).toEqual(['Record prices', 'Close RFQ']);
  });

  it('offers a closed RFQ no menu, and shows only open ones until a status is chosen', () => {
    const html = render([row({ status: 'closed', rfq_no: 'RFQ-0009' })]);
    expect(html).not.toContain('Actions for');
    expect(text(html)).not.toContain('RFQ-0009');
    // The status filter's "Closed" brings the row back; what its menu would offer is nothing.
    expect(rfqActions(row({ status: 'closed' }))).toEqual([]);
  });

  it('shows a dash for the total until every line is priced, and the order number when there is one', () => {
    expect(text(render([row({ status: 'quoted', total: 120, fully_priced: false })]))).toContain('—');
    const priced = text(render([row({ status: 'quoted', total: 1234.5, fully_priced: true, purchase_order_no: 'PO-0007' })]));
    expect(priced).toContain('1,234.50');
    expect(priced).toContain('PO-0007');
  });

  it('gives a reader no New button and no menu', () => {
    const html = render([row({ status: 'draft', rfq_no: null })], false);
    expect(text(html)).not.toContain('New RFQ');
    expect(html).not.toContain('Actions for');
    expect(items(html)).toEqual([]);
    expect(text(html)).toContain('Export');
  });
});

describe('the RFQ form', () => {
  const detail: RfqDetail = {
    ...row({ status: 'draft', rfq_no: null, supplier_id: 'sup-gone', supplier_name: 'Archived Traders' }),
    subtotal: 0,
    sst_total: 0,
    notes: null,
    lines: [],
  };

  it('still shows the supplier of a draft whose supplier was archived since', () => {
    const html = renderToStaticMarkup(
      <RfqFormCard
        editing={detail}
        suppliers={[{ id: 'sup-1', name: 'Kopi Hulu Supplies' } as FinanceContact]}
        products={[]}
        today={TODAY}
        actions={actions}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('data-chosen="sup-gone"');
    expect(html).toMatch(/<span data-option="sup-gone">Archived Traders/);
    expect(html).toMatch(/<span data-option="sup-1">Kopi Hulu Supplies/);
  });
});

describe('the prices card', () => {
  const sent: RfqDetail = {
    ...row({ supplier_ref: 'Q-77' }),
    subtotal: 0,
    sst_total: 0,
    notes: null,
    lines: [
      { id: '11111111-1111-4111-8111-1111111111a1', product_id: null, description: 'Arabica beans', quantity: 5, uom: 'kg', pack_size: null, unit_price: null, sst_rate: 0 },
      { id: '11111111-1111-4111-8111-1111111111a2', product_id: null, description: 'Paper cups', quantity: 200, uom: 'pcs', pack_size: null, unit_price: null, sst_rate: 6 },
    ],
  };

  it('shows the supplier reference box and one row per line with its quantity and unit', () => {
    const html = renderToStaticMarkup(<RfqPricesCard rfq={sent} quote={actions.quote} onClose={() => {}} />);
    const t = text(html);
    expect(t).toContain('Supplier reference');
    expect(t).toContain('Arabica beans');
    expect(t).toContain('Paper cups');
    expect(t).toContain('5 kg');
    expect(t).toContain('200 pcs');
    expect(html).toContain('Unit price for line 1, Arabica beans');
    expect(html).toContain('SST rate for line 2, Paper cups');
  });

  it('refuses to save while one price is empty, in the unpriced sentence, with nothing to send', () => {
    const drafts = priceDrafts(sent).map((d, i) => (i === 0 ? { ...d, unit_price: '12.50' } : d));
    expect(quoteFormError(drafts)).toBe(RFQ_MESSAGES.unpriced);
    expect(submitPrices(sent.id, 'Q-77', drafts)).toEqual({ error: RFQ_MESSAGES.unpriced });
  });

  it('gives the payload, and no error, once every price is filled', () => {
    const drafts = priceDrafts(sent).map((d) => ({ ...d, unit_price: '12.50' }));
    const result = submitPrices(sent.id, 'Q-77', drafts);
    expect(result).not.toHaveProperty('error');
    expect(result).toEqual({ payload: quotePayload(sent.id, 'Q-77', drafts) });
  });
});
