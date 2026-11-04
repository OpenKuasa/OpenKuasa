import { describe, expect, it } from 'vitest';
import {
  cellNeedsReason,
  comparableRfqIds,
  compareQuotes,
  orderableRfq,
  rfqCopyCount,
  rfqDeleteWarning,
  rfqGroupId,
  splitPlan,
  splitAwards,
  splitReasonHint,
  startingChoice,
  toggleChoice,
} from '@/lib/finance/rfq-compare';
import type { RfqDetail, RfqLine, RfqListRow } from '@/lib/finance/rfqs';
import type { SplitOrder } from '@/lib/finance/rfq-compare';

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

describe('line ids', () => {
  it('are threaded to each cell, so a choice is an RFQ and one of its lines', () => {
    const a = rfq('a', [line('Paper', 12), line('Toner', 80)]);
    const b = rfq('b', [line('Toner', 70)]);
    const [paper, toner] = compareQuotes([a, b]);
    expect(paper.cells.map((c) => c?.line_id ?? null)).toEqual([a.lines[0].id, null]);
    expect(toner.cells.map((c) => c?.line_id)).toEqual([a.lines[1].id, b.lines[0].id]);
  });
});

describe('where choosing starts', () => {
  const start = (rfqs: RfqDetail[]) => {
    const rows = compareQuotes(rfqs);
    return rows.map((r) => rfqs.findIndex((x) => x.id === startingChoice(rows, rfqs)[r.key]));
  };

  it('is the one supplier marked lowest on a row', () => {
    expect(start([rfq('a', [line('Paper', 12), line('Toner', 70)]), rfq('b', [line('Paper', 11), line('Toner', 80)])])).toEqual([1, 0]);
  });
  it('is nobody on a tie, as every tied cell is marked', () => {
    expect(start([rfq('a', [line('Paper', 12)]), rfq('b', [line('Paper', 12)]), rfq('c', [line('Paper', 13)])])).toEqual([-1]);
  });
  it('is nobody when the lowest supplier already has an order', () => {
    expect(start([rfq('a', [line('Paper', 12)]), rfq('b', [line('Paper', 11)], { purchase_order_id: 'po-1' })])).toEqual([-1]);
  });
  it('is the only supplier who quoted a row, when that RFQ can be ordered', () => {
    expect(start([rfq('a', [line('Paper', 12), line('Toner', 80)]), rfq('b', [line('Paper', 11)])])).toEqual([1, 0]);
  });
  it('is nobody on a row nobody quoted, or where two quoted but only one could be compared', () => {
    expect(start([rfq('a', [line('Paper', 12)]), rfq('b', [line('Stapler', null)], { status: 'sent', quoted_at: null })])).toEqual([0, -1]);
    const usd = { currency: 'USD', fx_rate: null, fx_rate_text: null };
    expect(start([rfq('a', [line('Paper', 12)]), rfq('b', [line('Paper', 3)], usd)])).toEqual([-1]);
  });
});

describe('choosing a line', () => {
  it('moves a row to the supplier chosen last, and clears it when chosen again', () => {
    const one = toggleChoice({ r1: 'a' }, 'r1', 'b');
    expect(one).toEqual({ r1: 'b' });
    expect(toggleChoice(one, 'r1', 'b')).toEqual({});
    expect(toggleChoice({ r1: 'a' }, 'r2', 'a')).toEqual({ r1: 'a', r2: 'a' });
  });
});

describe('what a reason is needed for', () => {
  const usd = (over: Partial<RfqDetail> = {}) => ({ currency: 'USD', fx_rate: 4, fx_rate_text: '4.0000000000', ...over });
  const needs = (rfqs: RfqDetail[]) => {
    const [row] = compareQuotes(rfqs);
    const mixed = new Set(rfqs.map((r) => r.currency)).size > 1;
    return rfqs.map((_, i) => cellNeedsReason(row, i, mixed));
  };

  it('is a strictly lower price from another supplier, SST included', () => {
    expect(needs([rfq('a', [line('Paper', 12)]), rfq('b', [line('Paper', 11)]), rfq('c', [line('Paper', 13)])])).toEqual(['lower', null, 'lower']);
    expect(needs([rfq('a', [line('Paper', 10, { sst_rate: 10 })]), rfq('b', [line('Paper', 10.5)])])).toEqual(['lower', null]);
  });
  it('is nothing on a tie, or a row only one supplier quoted', () => {
    expect(needs([rfq('a', [line('Paper', 12)]), rfq('b', [line('Paper', 12)])])).toEqual([null, null]);
    expect(needs([rfq('a', [line('Paper', 12)]), rfq('b', [line('Stapler', 1)])])).toEqual([null, null]);
  });
  it('is nothing for a supplier that did not answer, or whose price is the buyer’s own', () => {
    expect(needs([rfq('a', [line('Paper', 12)]), rfq('b', [line('Paper', 5)], { status: 'sent', quoted_at: null })])).toEqual([null, null]);
  });
  it('is no exchange rate to compare by, in quotes of several currencies, when another supplier quoted the row', () => {
    const noRate = usd({ fx_rate: null, fx_rate_text: null });
    expect(needs([rfq('a', [line('Paper', 12)]), rfq('b', [line('Paper', 1)], noRate)])).toEqual([null, 'no_rate']);
    // With nobody to compare it with it needs none; a foreign quote with a rate is compared like any other.
    expect(needs([rfq('a', [line('Stapler', 12)]), rfq('b', [line('Paper', 1)], noRate)])).toEqual([null, null]);
    expect(needs([rfq('a', [line('Paper', 12)]), rfq('b', [line('Paper', 2)], usd())])).toEqual(['lower', null]);
  });
});

describe('splitPlan', () => {
  const choice = (rfqs: RfqDetail[], picks: Record<string, string>) => {
    const rows = compareQuotes(rfqs);
    return splitPlan(rfqs, rows, Object.fromEntries(rows.flatMap((r) => (picks[r.description] ? [[r.key, picks[r.description]]] : []))));
  };

  it('adds up the lines chosen in the one currency, one order per supplier, and counts what is left out', () => {
    const rfqs = [
      rfq('a', [line('Paper', 12, { quantity: 10 }), line('Toner', 80, { quantity: 1 }), line('Pens', 2, { quantity: 5 })]),
      rfq('b', [line('Paper', 11, { quantity: 10 }), line('Toner', 80, { quantity: 1 })]),
      rfq('c', [line('Stapler', null)], { status: 'sent', quoted_at: null }),
    ];
    const plan = choice(rfqs, { Paper: 'b', Pens: 'a' });
    expect(plan.mixed).toBe(false);
    expect(plan.currency).toBe('MYR');
    expect(plan.orders.map((o) => [o.rfq.id, o.lines.length, o.quoted, o.sen])).toEqual([['a', 1, 3, 1000], ['b', 1, 2, 11000]]);
    expect(plan.totalSen).toBe(12000);
    expect(Object.values(plan.rowSen)).toEqual([11000, 1000]);
    // Toner was quoted twice and not chosen; Stapler was quoted by nobody; Paper at b is the lowest, Pens has no rival.
    expect([plan.notChosen, plan.noQuote, plan.unrated]).toEqual([1, 1, 0]);
    expect(plan.orders.map((o) => [o.lower, o.noRate])).toEqual([[[], []], [[], []]]);
  });
  it('lists the items that need a reason, by order', () => {
    const rfqs = [rfq('a', [line('Paper', 12), line('Toner', 80)]), rfq('b', [line('Paper', 11), line('Toner', 90)])];
    const plan = choice(rfqs, { Paper: 'a', Toner: 'a' });
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].lower).toEqual(['Paper']);
  });
  it('ignores a choice for an RFQ that can no longer be ordered, or whose line is gone', () => {
    const rfqs = [rfq('a', [line('Paper', 12)]), rfq('b', [line('Paper', 11)], { purchase_order_id: 'po-1' })];
    const plan = choice(rfqs, { Paper: 'b' });
    expect(plan.orders).toEqual([]);
    expect(plan.notChosen).toBe(1);
    expect(splitPlan(rfqs, compareQuotes(rfqs), { nope: 'a' }).orders).toEqual([]);
  });
  it('puts quotes of several currencies into ringgit at each RFQ’s rate, leaves out a line with no rate, and says how many', () => {
    const rfqs = [
      rfq('a', [line('Pump', 100, { quantity: 1 }), line('Fan', 3, { quantity: 5 })]),
      rfq('b', [line('Pump', 20, { quantity: 1 }), line('Fan', 0.8, { quantity: 5 })], { currency: 'USD', fx_rate: 4, fx_rate_text: '4.0000000000' }),
      rfq('c', [line('Pump', 10, { quantity: 1 }), line('Fan', 1, { quantity: 5 })], { currency: 'USD', fx_rate: null, fx_rate_text: null }),
    ];
    const plan = choice(rfqs, { Pump: 'b', Fan: 'c' });
    expect(plan.mixed).toBe(true);
    expect(plan.currency).toBe('MYR');
    // Pump at b: USD 20.00 x 4 = RM 80.00. Fan at c is USD 5.00, which cannot be put into ringgit.
    expect(Object.entries(plan.rowSen).map(([, sen]) => sen)).toEqual([8000, null]);
    expect(plan.totalSen).toBe(8000);
    expect(plan.unrated).toBe(1);
    // Each order is in its own currency.
    expect(plan.orders.map((o) => [o.rfq.id, o.sen, o.lower, o.noRate])).toEqual([['b', 2000, [], []], ['c', 500, [], ['Fan']]]);
  });
  it('rounds each line’s ringgit to the sen', () => {
    const rfqs = [
      rfq('a', [line('Pump', 1)]),
      rfq('b', [line('Pump', 3.3, { quantity: 1 })], { currency: 'USD', fx_rate: 4.1234, fx_rate_text: '4.1234000000' }),
    ];
    // USD 3.30 x 4.1234 = RM 13.607 -> 13.61.
    expect(choice(rfqs, { Pump: 'b' }).totalSen).toBe(1361);
  });
});

describe('what a split sends and says', () => {
  it('starts nothing chosen once any RFQ of the request has an order', () => {
    const ordered: RfqDetail = { ...rfq('a', [line('Paper', 1)]), purchase_order_id: 'po-1' };
    const open = rfq('b', [line('Paper', 2)]);
    expect(startingChoice(compareQuotes([open, ordered]), [open, ordered])).toEqual({});
  });
  it('sends each order with its lines and the reason typed for it', () => {
    const rfq = { id: 'r1' } as RfqDetail;
    const lines = [{ cell: { line_id: 'l1' } }, { cell: { line_id: 'l2' } }] as SplitOrder['lines'];
    expect(splitAwards({ orders: [{ rfq, lines } as SplitOrder] }, { r1: 'Faster' })).toEqual([{ rfq_id: 'r1', line_ids: ['l1', 'l2'], reason: 'Faster' }]);
  });
  it('names the items that need a reason, and is null when none do', () => {
    expect(splitReasonHint({ lower: [], noRate: [] })).toBeNull();
    expect(splitReasonHint({ lower: ['Paper'], noRate: [] })).toBe('Needs a reason: Paper has a lower quote.');
    expect(splitReasonHint({ lower: ['Paper', 'Toner'], noRate: ['Saw'] })).toBe(
      'Needs a reason: Paper, Toner have a lower quote. Saw has no exchange rate to compare.',
    );
  });
});
