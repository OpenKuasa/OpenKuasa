import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RfqCompareCard } from '@/components/finance/rfq-compare-card';
import { compareQuotes, startingChoice } from '@/lib/finance/rfq-compare';
import type { RfqDetail } from '@/lib/finance/rfqs';

/**
 * Compare quotes with Split between suppliers on, rendered to a string. There is no DOM here, so nothing can be
 * pressed: the card's own state (its first six `useState`s, in this order) is seeded instead, to read what split mode
 * and its question draw. What a press changes is in rfq-compare.ts (toggleChoice, startingChoice, splitPlan), tested in
 * tests/finance-rfq-compare.test.ts.
 */
const seed = vi.hoisted(() => ({ values: [] as unknown[], calls: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: ((initial: unknown) => {
      const at = seed.calls++;
      return at < 6 && seed.values[at] !== undefined ? [seed.values[at], () => {}] : actual.useState(initial);
    }) as typeof actual.useState,
  };
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

let n = 0;
const rfq = (id: string, supplier_name: string, prices: [string, number | null, number?][], over: Partial<RfqDetail> = {}): RfqDetail => ({
  id,
  rfq_no: `RFQ-${id}`,
  supplier_id: `sup-${id}`,
  supplier_name,
  rfq_date: '2026-10-01',
  reply_by: null,
  supplier_ref: null,
  status: 'quoted',
  line_count: prices.length,
  total: 0,
  quoted_at: '2026-10-02T09:00:00Z',
  purchase_order_id: null,
  purchase_order_no: null,
  source_rfq_id: null,
  currency: 'MYR',
  fx_rate: 1,
  fx_rate_text: '1.0000000000',
  fx_rate_source: null,
  fx_rate_date: null,
  total_myr: 0,
  subtotal: 0,
  sst_total: 0,
  notes: null,
  lines: prices.map(([description, unit_price, quantity]) => ({
    id: `l${(n += 1)}`,
    product_id: null,
    description,
    quantity: quantity ?? 10,
    uom: null,
    pack_size: null,
    unit_price,
    sst_rate: 0,
  })),
  ...over,
});

const award = vi.fn(async () => ({ ok: true as const, data: null }));
const render = (rfqs: RfqDetail[], state: { chosen?: Record<string, string>; asking?: boolean; reasons?: Record<string, string> } = {}) => {
  seed.calls = 0;
  seed.values = [undefined, undefined, true, state.chosen ?? {}, state.asking ?? false, state.reasons ?? {}];
  return renderToStaticMarkup(<RfqCompareCard rfqs={rfqs} award={award} onConverted={() => {}} onAwarded={() => {}} onClose={() => {}} />);
};
const start = (rfqs: RfqDetail[]) => startingChoice(compareQuotes(rfqs), rfqs);

beforeEach(() => {
  seed.calls = 0;
  seed.values = [];
});

describe('Split between suppliers, switched on', () => {
  const group = () => [
    rfq('a', 'Kopi Hulu', [['Paper', 12], ['Toner', 80], ['Pens', 2, 5]]),
    rfq('b', 'Biji Segar', [['Paper', 11], ['Toner', 80]]),
    rfq('c', 'Ladang Timur', [['Stapler', null]], { status: 'sent', quoted_at: null }),
  ];

  it('gives each quoted cell of an orderable column a Choose button that names the item and supplier, and none to the rest', () => {
    const rfqs = group();
    const html = render(rfqs, { chosen: start(rfqs) });
    expect(html.match(/aria-label="Choose [^"]+"/g)).toEqual([
      'aria-label="Choose Paper from Kopi Hulu"',
      'aria-label="Choose Paper from Biji Segar"',
      'aria-label="Choose Toner from Kopi Hulu"',
      'aria-label="Choose Toner from Biji Segar"',
      'aria-label="Choose Pens from Kopi Hulu"',
    ]);
    // Paper is lowest at Biji Segar and Pens is quoted only by Kopi Hulu; Toner is a tie, so it starts on nobody.
    expect(html.match(/aria-pressed="true"[^>]*aria-label="Choose ([^"]+)"/g)?.map((m) => m.match(/Choose ([^"]+)/)![1])).toEqual([
      'Paper from Biji Segar',
      'Pens from Kopi Hulu',
    ]);
    expect(html.match(/aria-pressed="false"[^>]*aria-label="Choose ([^"]+)"/g)).toHaveLength(3);
  });
  it('shows no button on a column that has an order already', () => {
    const rfqs = group();
    rfqs[1] = { ...rfqs[1], purchase_order_id: 'po-1', purchase_order_no: 'PO-0001' };
    const html = render(rfqs, { chosen: start(rfqs) });
    expect(html).not.toContain('from Biji Segar"');
    expect(html).toContain('aria-label="Choose Paper from Kopi Hulu"');
  });
  it('adds a Split column, a split total beside the totals and a Chosen row under Total', () => {
    const rfqs = group();
    const html = render(rfqs, { chosen: start(rfqs) });
    const t = text(html);
    // Paper at Biji Segar: 10 x 11 = 110.00; Pens at Kopi Hulu: 5 x 2 = 10.00.
    expect(t).toContain('Split Chosen');
    expect(t).toMatch(/Pens RM 2\.00 .* RM 10\.00 Chosen Not quoted Not quoted RM 10\.00/);
    expect(t).toContain('Not quoted RM 120.00 1 line not chosen Chosen 1 line, RM 10.00 1 line, RM 110.00 —');
  });
  it('makes the question ask for one box a supplier, and says what was left out', () => {
    const rfqs = group();
    const chosen = { ...start(rfqs) };
    const html = render(rfqs, { chosen, asking: true });
    const t = text(html);
    expect(t).toContain('Make these 2 draft purchase orders?');
    expect(t).toContain('Kopi Hulu · RFQ-a · 1 line · RM 10.00');
    expect(t).toContain('Biji Segar · RFQ-b · 1 line · RM 110.00');
    // Kopi Hulu quoted three lines and gets one; Biji Segar quoted two and gets one.
    expect(t).toContain('Gets 1 of the 3 lines it quoted. Check any minimum order or delivery charge.');
    expect(t).toContain('Gets 1 of the 2 lines it quoted. Check any minimum order or delivery charge.');
    expect(t).toContain('1 line was left out.');
    expect(t).toContain('1 line had no quotes and is not ordered.');
    expect(html).toContain('aria-label="Why Kopi Hulu was chosen"');
    expect(html).toContain('aria-label="Why Biji Segar was chosen"');
    expect(t).not.toContain('Needs a reason');
    expect(t).toContain('Make 2 purchase orders');
  });
  it('says under the box which items need a reason, and keeps what was typed', () => {
    const rfqs = group();
    const toner = compareQuotes(rfqs).find((r) => r.description === 'Paper')!;
    // Paper goes to Kopi Hulu (12) while Biji Segar quoted 11.
    const html = render(rfqs, { chosen: { [toner.key]: 'a' }, asking: true, reasons: { a: 'Delivers next day' } });
    expect(text(html)).toContain('Needs a reason: Paper has a lower quote.');
    expect(html).toContain('value="Delivers next day"');
    expect(text(html)).toContain('Make purchase order');
  });
  it('makes the Make button unavailable, with a short reason, when nothing is chosen', () => {
    const html = render(group(), { chosen: {} });
    expect(text(html)).toContain('Choose a quote on at least one line to make an order.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Review purchase orders/);
    expect(text(html)).not.toContain('Make these');
  });
  it('turns the figures into approximate ringgit for quotes in several currencies, and says what has no rate', () => {
    const rfqs = [
      rfq('a', 'Kopi Hulu', [['Pump', 100, 1], ['Fan', 3, 5]]),
      rfq('b', 'Pacific Tools', [['Pump', 20, 1], ['Fan', 0.8, 5]], { currency: 'USD', fx_rate: 4, fx_rate_text: '4.0000000000' }),
      rfq('c', 'Overseas Ltd', [['Pump', 10, 1], ['Fan', 1, 5]], { currency: 'USD', fx_rate: null, fx_rate_text: null }),
    ];
    const rows = compareQuotes(rfqs);
    const key = (d: string) => rows.find((r) => r.description === d)!.key;
    const html = render(rfqs, { chosen: { [key('Pump')]: 'b', [key('Fan')]: 'c' }, asking: true });
    const t = text(html);
    expect(t).toContain('≈ RM 80.00');
    expect(t).toContain('No exchange rate');
    expect(t).toContain('plus 1 line with no exchange rate');
    expect(t).toContain('USD 20.00');
    // Fan at Overseas Ltd cannot be compared and the others quoted it.
    expect(t).toContain('Needs a reason: Fan has no exchange rate to compare.');
    expect(t).toContain('in ringgit at each RFQ’s own exchange rate');
  });
  it('is not drawn when the split is off', () => {
    seed.calls = 0;
    seed.values = [undefined, undefined, false];
    const html = renderToStaticMarkup(<RfqCompareCard rfqs={group()} award={award} onConverted={() => {}} onAwarded={() => {}} onClose={() => {}} />);
    expect(text(html)).not.toContain('Choose');
    expect(text(html)).not.toContain('Split Chosen');
    expect(text(html)).toContain('Split between suppliers');
  });
});
