import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FinanceContact } from '@/lib/finance/contacts';
import { RfqCompareCard } from '@/components/finance/rfq-compare-card';
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
  quoted_at: null,
  purchase_order_id: null,
  purchase_order_no: null,
  source_rfq_id: null,
  ...over,
});

const done = <T,>(data: T) => vi.fn(async () => ({ ok: true as const, data }));
const actions: RfqActions = {
  save: done({ id: 'x' }),
  saveAndPost: done({ id: 'x', rfq_no: 'RFQ-0001' }),
  send: done({ id: 'x', rfq_no: 'RFQ-0001' }),
  quote: done({ id: 'x' }),
  close: done({ id: 'x' }),
  convert: done({ id: 'x' }),
  remove: done({ id: 'x' }),
  get: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
  getSent: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
  getForCopy: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
  getComparison: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
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
    expect(items(html)).toEqual(['Edit', 'Mark as sent', 'Copy to another supplier', 'Delete']);
    expect(text(html)).toContain('Draft');
  });

  it('offers a sent RFQ Record prices and Close', () => {
    expect(items(render([row({ status: 'sent' })]))).toEqual(['Record prices', 'Copy to another supplier', 'Close RFQ']);
  });

  it('offers a quoted RFQ with no order Make purchase order and Close, and one with an order only Close', () => {
    expect(items(render([row({ status: 'quoted', total: 100, quoted_at: '2026-10-02T09:00:00Z' })]))).toEqual(['Make purchase order', 'Copy to another supplier', 'Close RFQ']);
    const ordered = render([row({ status: 'quoted', quoted_at: '2026-10-02T09:00:00Z', purchase_order_id: 'po-1', purchase_order_no: 'PO-0007' })]);
    expect(items(ordered)).not.toContain('Make purchase order');
    expect(items(ordered)).toEqual(['Copy to another supplier', 'Close RFQ']);
  });

  it('offers an overdue RFQ the same menu as a sent one, Copy to another supplier included', () => {
    expect(items(render([row({ status: 'sent', reply_by: '2026-10-01' })]))).toEqual([
      'Record prices',
      'Copy to another supplier',
      'Close RFQ',
    ]);
  });

  it('shows only open RFQs until a status is chosen, and a closed one can only be copied', () => {
    const html = render([row({ status: 'closed', rfq_no: 'RFQ-0009' })]);
    expect(html).not.toContain('Actions for');
    expect(text(html)).not.toContain('RFQ-0009');
    // The status filter's "Closed" brings the row back; what its menu would offer is a copy.
    expect(rfqActions(row({ status: 'closed' }))).toEqual(['copy']);
  });

  it('shows a dash for the total until the supplier answers, and the order number when there is one', () => {
    // Prices the buyer typed before sending are not a quote.
    const typed = text(render([row({ status: 'sent', total: 120 })]));
    expect(typed).toContain('—');
    expect(typed).not.toContain('120.00');
    const priced = text(render([row({ status: 'quoted', total: 1234.5, quoted_at: '2026-10-02T09:00:00Z', purchase_order_no: 'PO-0007' })]));
    expect(priced).toContain('1,234.50');
    expect(priced).toContain('PO-0007');
  });

  it('offers Compare quotes on an RFQ that went out with a copy to another supplier, and not on a draft copy', () => {
    const first = row({ id: 'first', status: 'quoted', quoted_at: '2026-10-02T09:00:00Z' });
    const copy = row({ id: 'copy', rfq_no: 'RFQ-0002', status: 'sent', source_rfq_id: 'first' });
    const draft = row({ id: 'draft', rfq_no: null, status: 'draft', source_rfq_id: 'first' });
    expect(items(render([first, copy]))).toEqual([
      'Make purchase order', 'Compare quotes', 'Copy to another supplier', 'Close RFQ',
      'Record prices', 'Compare quotes', 'Copy to another supplier', 'Close RFQ',
    ]);
    // A draft copy has asked nobody yet: the first RFQ alone has nothing to be compared with.
    expect(items(render([first, draft]))).not.toContain('Compare quotes');
  });

  it('gives a reader no New button and no menu', () => {
    const html = render([row({ status: 'draft', rfq_no: null })], false);
    expect(text(html)).not.toContain('New RFQ');
    expect(html).not.toContain('Actions for');
    expect(items(html)).toEqual([]);
    expect(html).not.toContain('Copy to another supplier');
    expect(text(html)).toContain('Export');
  });
});

describe('the RFQ form', () => {
  const detail: RfqDetail = {
    ...row({ status: 'draft', rfq_no: null, supplier_id: 'sup-gone', supplier_name: 'Archived Traders' }),
    subtotal: 0,
    sst_total: 0,
    notes: null,
    quoted_at: null,
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

  it('says the supplier fills in the price', () => {
    const html = renderToStaticMarkup(
      <RfqFormCard suppliers={[{ id: 'sup-1', name: 'Kopi Hulu Supplies' } as FinanceContact]} products={[]} today={TODAY} actions={actions} onClose={() => {}} />,
    );
    expect(html).toContain('placeholder="Supplier price"');
    expect(html).not.toContain('placeholder="0.00"');
  });
});

describe('a copied RFQ form', () => {
  const source: RfqDetail = {
    ...row({ status: 'quoted', supplier_id: 'sup-1', supplier_name: 'Kopi Hulu Supplies', total: 106 }),
    subtotal: 100,
    sst_total: 6,
    notes: 'Deliver before noon',
    quoted_at: '2026-10-02T09:00:00Z',
    lines: [
      { id: 'l1', product_id: null, description: 'Arabica beans', quantity: 20, uom: 'kg', pack_size: null, unit_price: 5, sst_rate: 6 },
    ],
  };
  const html = renderToStaticMarkup(
    <RfqFormCard
      copyOf={source}
      suppliers={[{ id: 'sup-1', name: 'Kopi Hulu Supplies' } as FinanceContact, { id: 'sup-2', name: 'Biji Segar' } as FinanceContact]}
      products={[]}
      today={TODAY}
      actions={actions}
      onClose={() => {}}
    />,
  );

  it('is the ordinary New RFQ form, with no supplier chosen', () => {
    expect(text(html)).toContain('New RFQ');
    expect(text(html)).not.toContain('Edit RFQ');
    expect(html).toContain('data-chosen=""');
    expect(html).not.toContain('data-chosen="sup-1"');
  });
  it('holds the lines and the notes, dated today, with the price boxes empty', () => {
    expect(html).toContain('value="Arabica beans"');
    expect(html).toContain('value="Deliver before noon"');
    expect(html).toContain(`value="${TODAY}"`);
    expect(html).not.toContain('value="5"');
    expect(html).not.toContain('value="2026-10-20"');
  });
});

describe('the prices card', () => {
  const sent: RfqDetail = {
    ...row({ supplier_ref: 'Q-77' }),
    subtotal: 0,
    sst_total: 0,
    notes: null,
    quoted_at: null,
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

describe('Compare quotes', () => {
  const rfq = (id: string, supplier_name: string, over: Partial<RfqDetail>): RfqDetail => ({
    ...row({ id, rfq_no: `RFQ-${id}`, supplier_name, status: 'quoted' }),
    subtotal: 0,
    sst_total: 0,
    notes: null,
    quoted_at: '2026-10-02T09:00:00Z',
    lines: [],
    ...over,
  });
  const line = { product_id: null, uom: 'kg', pack_size: null, sst_rate: 0 };
  const group = [
    rfq('1', 'Kopi Hulu Supplies', {
      total: 100,
      lines: [
        { ...line, id: 'a1', description: 'Arabica beans', quantity: 20, unit_price: 5 },
        { ...line, id: 'a2', description: 'Robusta beans', quantity: 10, unit_price: 3 },
      ],
    }),
    rfq('2', 'Biji Segar', {
      status: 'sent',
      quoted_at: null,
      lines: [
        { ...line, id: 'b1', description: 'Arabica beans', quantity: 20, unit_price: null },
        { ...line, id: 'b2', description: 'Robusta beans', quantity: 10, unit_price: null },
      ],
    }),
    rfq('3', 'Ladang Timur', {
      total: 100,
      purchase_order_id: 'po-1',
      purchase_order_no: 'PO-0004',
      lines: [{ ...line, id: 'c1', description: 'Arabica beans', quantity: 20, unit_price: 5 }],
    }),
  ];
  const html = renderToStaticMarkup(
    <RfqCompareCard rfqs={group} convert={actions.convert} onConverted={() => {}} onClose={() => {}} />,
  );

  it('shows a column for each supplier and a row for each item', () => {
    expect(text(html)).toContain('Kopi Hulu Supplies RFQ-1 · Quoted');
    expect(text(html)).toContain('Biji Segar RFQ-2 · Sent');
    expect(text(html)).toContain('Arabica beans');
    expect(text(html)).toContain('Robusta beans');
  });
  it('marks the lowest price in words, every supplier tied at it, and says where a supplier gave no price', () => {
    expect(text(html).match(/Lowest RM 5\.00/g)).toHaveLength(2);
    expect(text(html)).toContain('Not quoted');
  });
  it('offers Make purchase order only on a quoted RFQ that has no order, and names the order that stands', () => {
    expect(text(html).match(/Make purchase order/g)).toHaveLength(1);
    expect(text(html)).toContain('Order PO-0004');
  });
  // The class list of the element that directly holds `inner`, and every header cell of the table with its scope.
  const classesOf = (markup: string, inner: string) =>
    markup.match(new RegExp(`<(?:th|span)[^>]*class="([^"]*)"[^>]*>${inner}<`))?.[1].split(' ') ?? [];
  const headers = (markup: string, scope: string) =>
    [...markup.matchAll(/<th ([^>]*)>([\s\S]*?)<\/th>/g)].filter(([, attrs]) => attrs.includes(`scope="${scope}"`)).map(([, , inner]) => text(inner));

  it('is a named table whose columns and rows each have a header', () => {
    expect(html).toMatch(/<table [^>]*aria-label="Quotes compared"/);
    expect(headers(html, 'col')).toEqual(['Item', 'Kopi Hulu Supplies RFQ-1 · Quoted', 'Biji Segar RFQ-2 · Sent', 'Ladang Timur RFQ-3 · Quoted']);
    expect(headers(html, 'row')).toEqual(['Arabica beans kg', 'Robusta beans kg', 'Total', 'Purchase order']);
    // No header cell is left without a scope.
    expect(html.match(/<th /g)).toHaveLength(8);
  });
  it('lets an item description and a supplier name wrap, an unbroken description too', () => {
    const item = html.match(/<th [^>]*class="([^"]*)"[^>]*><span class="font-medium">Arabica beans</)?.[1].split(' ') ?? [];
    // `break-words` does not lower a table cell's least width, so an unbroken word would widen the column instead.
    expect(item).toEqual(expect.arrayContaining(['whitespace-normal', '[overflow-wrap:anywhere]']));
    expect(item).not.toContain('whitespace-nowrap');
    const supplier = classesOf(html, 'Kopi Hulu Supplies');
    expect(supplier).toContain('whitespace-normal');
    expect(supplier).not.toContain('whitespace-nowrap');
  });
  it('shows no total for an RFQ whose answer has not been recorded, whatever prices were typed on it', () => {
    const paper = { ...line, quantity: 10 };
    const unanswered = renderToStaticMarkup(
      <RfqCompareCard
        rfqs={[
          rfq('1', 'Kopi Hulu Supplies', { total: 120, lines: [{ ...paper, id: 'a1', description: 'A4 paper', unit_price: 12 }] }),
          // The buyer typed 7.77 before sending: the view totals it, but the supplier has not answered.
          rfq('2', 'Biji Segar', {
            status: 'sent',
            quoted_at: null,
            total: 77.7,
            lines: [{ ...paper, id: 'b1', description: 'A4 paper', unit_price: 7.77 }],
          }),
        ]}
        onConverted={() => {}}
        onClose={() => {}}
      />,
    );
    expect(text(unanswered)).toContain('Total RM 120.00 Not quoted');
    expect(text(unanswered)).not.toContain('77.70');
    expect(text(unanswered)).not.toContain('7.77');
  });
  it('shows a supplier’s own description under its price when it differs from the row’s', () => {
    const paper = { ...line, product_id: 'p1', quantity: 10 };
    const substituted = renderToStaticMarkup(
      <RfqCompareCard
        rfqs={[
          rfq('1', 'Kopi Hulu Supplies', { lines: [{ ...paper, id: 'a1', description: 'A4 paper 80gsm', unit_price: 12 }] }),
          rfq('2', 'Biji Segar', { lines: [{ ...paper, id: 'b1', description: 'A4 paper 70gsm (substitute)', unit_price: 9 }] }),
        ]}
        onConverted={() => {}}
        onClose={() => {}}
      />,
    );
    expect(text(substituted).match(/A4 paper 80gsm/g)).toHaveLength(1);
    expect(text(substituted)).toContain('Lowest RM 9.00 Qty 10 · No SST · RM 90.00 A4 paper 70gsm (substitute)');
    expect(classesOf(substituted, 'A4 paper 70gsm \\(substitute\\)')).toEqual(expect.arrayContaining(['whitespace-normal', 'break-words']));
  });
});
