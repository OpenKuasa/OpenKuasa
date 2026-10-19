import { describe, expect, it } from 'vitest';
import { comparableRfqIds, compareQuotes, orderableRfq, rfqCopyCount, rfqDeleteWarning, rfqGroupId } from '@/lib/finance/rfq-compare';
import type { RfqDetail, RfqLine, RfqListRow } from '@/lib/finance/rfqs';

const row = (id: string, over: Partial<RfqListRow> = {}): RfqListRow => ({
  id,
  rfq_no: `RFQ-${id}`,
  supplier_id: `sup-${id}`,
  supplier_name: `Supplier ${id}`,
  rfq_date: '2026-10-01',
  reply_by: null,
  supplier_ref: null,
  status: 'sent',
  line_count: 1,
  total: 0,
  quoted_at: null,
  purchase_order_id: null,
  purchase_order_no: null,
  source_rfq_id: null,
  currency: 'MYR',
  fx_rate: 1,
  fx_rate_text: '1.0000000000',
  fx_rate_source: null,
  fx_rate_date: null,
  total_myr: 0,
  ...over,
});

let lineSeq = 0;
const line = (description: string, unit_price: number | null, over: Partial<RfqLine> = {}): RfqLine => ({
  id: `l${(lineSeq += 1)}`,
  product_id: null,
  description,
  quantity: 10,
  uom: 'ream',
  pack_size: null,
  unit_price,
  sst_rate: 0,
  ...over,
});

/** A quoted RFQ: its answer has been recorded. */
const rfq = (id: string, lines: RfqLine[], over: Partial<RfqDetail> = {}): RfqDetail => ({
  ...row(id, { status: 'quoted' }),
  subtotal: 0,
  sst_total: 0,
  notes: null,
  quoted_at: '2026-10-02T09:00:00Z',
  lines,
  ...over,
});

/** Each row as `description: cell, cell, …`, a cell being its price (`*` when marked lowest), `-` unpriced, `x` not asked. */
const grid = (rfqs: RfqDetail[]) =>
  compareQuotes(rfqs).map(
    (r) =>
      `${r.description}: ${r.cells
        .map((c) => (c === null ? 'x' : c.unit_price === null ? '-' : `${c.unit_price}${c.lowest ? '*' : ''}`))
        .join(', ')}`,
  );

describe('RFQ groups', () => {
  it('go by the first RFQ, which its copies name', () => {
    expect(rfqGroupId(row('a'))).toBe('a');
    expect(rfqGroupId(row('b', { source_rfq_id: 'a' }))).toBe('a');
  });
  it('can be compared once two of their RFQs have gone to a supplier, whatever has happened to them since', () => {
    const rows = [
      row('a', { status: 'quoted' }),
      row('b', { source_rfq_id: 'a', status: 'closed' }),
      row('c', { source_rfq_id: 'a', status: 'draft' }),
      row('d'),
      row('e', { source_rfq_id: 'd', status: 'draft' }),
    ];
    expect([...comparableRfqIds(rows)].sort()).toEqual(['a', 'b']);
  });
});

describe('deleting a draft that RFQs were copied from', () => {
  const draft = row('a', { status: 'draft', rfq_no: null });
  const copy = (id: string, status: RfqListRow['status'] = 'sent') => row(id, { source_rfq_id: 'a', status });
  const unrelated = [row('x'), row('y', { source_rfq_id: 'x' })];

  it('says nothing when nothing was copied from it', () => {
    expect(rfqCopyCount([draft, ...unrelated], draft)).toBe(0);
    expect(rfqDeleteWarning([draft, ...unrelated], draft)).toBeNull();
  });
  it('says the one copy will be on its own', () => {
    const rows = [draft, copy('b'), ...unrelated];
    expect(rfqCopyCount(rows, draft)).toBe(1);
    expect(rfqDeleteWarning(rows, draft)).toBe(
      '1 RFQ was copied from this one. Deleting it leaves that RFQ on its own: its quote can then be compared only with RFQs copied from it afterwards.',
    );
  });
  it('says several copies cannot be compared with each other, counting them in any status', () => {
    const rows = [draft, copy('b'), copy('c', 'draft'), copy('d', 'closed'), ...unrelated];
    expect(rfqCopyCount(rows, draft)).toBe(3);
    expect(rfqDeleteWarning(rows, draft)).toBe(
      '3 RFQs were copied from this one. Deleting it means their quotes cannot be compared with each other.',
    );
  });
  it('says nothing when a copy is deleted: the rest of its group still name the first RFQ', () => {
    const b = copy('b', 'draft');
    const rows = [draft, b, copy('c'), copy('d')];
    expect(rfqCopyCount(rows, b)).toBe(0);
    expect(rfqDeleteWarning(rows, b)).toBeNull();
  });
});

describe('the Make purchase order question in the comparison', () => {
  const group = [
    rfq('a', []),
    rfq('b', [], { purchase_order_id: 'po-1', purchase_order_no: 'PO-0004' }),
    rfq('c', [], { status: 'sent', quoted_at: null }),
    rfq('d', [], { status: 'closed' }),
  ];
  it('is about the RFQ as the group now reads', () => {
    expect(orderableRfq(group, 'a')).toBe(group[0]);
  });
  it('goes when its RFQ has an order, is not quoted, has left the group, or nothing is asked', () => {
    for (const id of ['b', 'c', 'd', 'gone', null]) expect(orderableRfq(group, id), String(id)).toBeNull();
  });
  it('goes after a refusal once the group, read again, shows the order someone else made', () => {
    expect(orderableRfq([rfq('a', []), rfq('e', [])], 'a')?.id).toBe('a');
    expect(orderableRfq([rfq('a', [], { purchase_order_id: 'po-9' }), rfq('e', [])], 'a')).toBeNull();
  });
});

describe('compareQuotes', () => {
  it('marks the lowest price on each line, and every supplier tied at it', () => {
    expect(
      grid([
        rfq('a', [line('Paper', 12.5), line('Toner', 80)]),
        rfq('b', [line('Paper', 12.4), line('Toner', 80)]),
        rfq('c', [line('Paper', 13), line('Toner', 95)]),
      ]),
    ).toEqual(['Paper: 12.5, 12.4*, 13', 'Toner: 80*, 80*, 95']);
  });
  it('compares prices with SST added, as SST on a purchase is a cost', () => {
    // 10.00 + 10% = 11.00 against 10.50 + 0%: the second is lower.
    expect(grid([rfq('a', [line('Paper', 10, { sst_rate: 10 })]), rfq('b', [line('Paper', 10.5)])])).toEqual(['Paper: 10, 10.5*']);
  });
  it('tells prices apart in the fourth decimal', () => {
    expect(grid([rfq('a', [line('Screw', 0.045)]), rfq('b', [line('Screw', 0.0449)])])).toEqual(['Screw: 0.045, 0.0449*']);
    // The same to the sen (12.34), so only the third and fourth decimals tell them apart.
    expect(grid([rfq('a', [line('Bolt', 12.3412)]), rfq('b', [line('Bolt', 12.3449)])])).toEqual(['Bolt: 12.3412*, 12.3449']);
  });
  it('counts no price on an RFQ whose answer has not been recorded: one typed before sending is not a quote', () => {
    expect(
      grid([
        rfq('a', [line('Paper', 12)]),
        rfq('b', [line('Paper', 9)], { status: 'sent', quoted_at: null }),
        rfq('c', [line('Paper', 11)], { status: 'closed', quoted_at: null }),
        rfq('d', [line('Paper', 10)], { status: 'closed' }),
      ]),
    ).toEqual(['Paper: 12, -, -, 10*']);
    const [paper] = compareQuotes([rfq('b', [line('Paper', 9)], { status: 'sent', quoted_at: null })]);
    expect(paper.cells[0]?.total).toBeNull();
  });
  it('marks nothing on a line only one supplier has priced, and keeps an unpriced line apart from one not asked for', () => {
    expect(
      grid([
        rfq('a', [line('Paper', 12), line('Toner', 80)]),
        rfq('b', [line('Paper', null)]),
      ]),
    ).toEqual(['Paper: 12, -', 'Toner: 80, x']);
  });
  it('matches a line by its product, or else by its description, in the same unit and pack size', () => {
    expect(
      grid([
        rfq('a', [
          line('A4 paper 80gsm', 12, { product_id: 'p1' }),
          line('Staples', 3),
          line('Envelopes', 5, { pack_size: 'box of 100' }),
        ]),
        rfq('b', [
          line('A4 paper, 80 gsm', 11, { product_id: 'p1' }),
          line('  STAPLES ', 4),
          line('Envelopes', 2, { pack_size: 'box of 50' }),
        ]),
      ]),
    ).toEqual(['A4 paper 80gsm: 12, 11*', 'Staples: 3*, 4', 'Envelopes: 5, x', 'Envelopes: x, 2']);
  });
  it('keeps a cell’s own description when lines matched by product are worded differently, so a substitute shows', () => {
    const [paper, ...rest] = compareQuotes([
      rfq('a', [line('A4 paper 80gsm', 12, { product_id: 'p1' })]),
      rfq('b', [line('A4 paper 70gsm (substitute)', 9, { product_id: 'p1' })]),
      rfq('c', [line('  a4 PAPER  80gsm ', 10, { product_id: 'p1' })]),
      rfq('d', [line('A4 paper 75gsm', 11, { product_id: 'p1' })], { status: 'sent', quoted_at: null }),
    ]);
    expect(rest).toEqual([]);
    // The row goes by the first description; the price comparison is unchanged.
    expect(paper.description).toBe('A4 paper 80gsm');
    expect(paper.cells.map((c) => c?.lowest)).toEqual([false, true, false, false]);
    // A space or a capital is not a different description; an RFQ with no recorded answer still says what it asks for.
    expect(paper.cells.map((c) => c?.description)).toEqual([null, 'A4 paper 70gsm (substitute)', null, 'A4 paper 75gsm']);
  });
  it('keeps lines apart that differ only in their unit, whether matched by product or by description', () => {
    expect(
      grid([
        rfq('a', [line('Paper', 12, { uom: 'ream' }), line('Toner', 80, { product_id: 'p2', uom: 'pc' })]),
        rfq('b', [line('Paper', 9, { uom: 'box' }), line('Toner', 70, { product_id: 'p2', uom: 'carton' })]),
      ]),
    ).toEqual(['Paper: 12, x', 'Toner: 80, x', 'Paper: x, 9', 'Toner: x, 70']);
    // A capital or a stray space in the unit is still the same unit.
    expect(grid([rfq('a', [line('Paper', 12, { uom: 'Ream ' })]), rfq('b', [line('Paper', 9, { uom: 'ream' })])])).toEqual([
      'Paper: 12, 9*',
    ]);
  });
  it('keeps two lines for the same item on one RFQ as two rows, matched in the order entered', () => {
    expect(
      grid([rfq('a', [line('Paper', 12), line('Paper', 10)]), rfq('b', [line('Paper', 11), line('Paper', 9)])]),
    ).toEqual(['Paper: 12, 11*', 'Paper: 10, 9*']);
  });
  it('totals each priced line as the RFQ does: the amount and its SST, each rounded to the sen', () => {
    const [paper] = compareQuotes([rfq('a', [line('Paper', 12.345, { quantity: 3, sst_rate: 6 })])]);
    // 3 x 12.345 = 37.035 -> 37.04; SST 2.2221 -> 2.22.
    expect(paper.cells[0]?.total).toBe(39.26);
  });
});
