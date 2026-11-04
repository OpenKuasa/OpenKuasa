import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { createContact } from '@/lib/finance/contacts';
import { PURCHASE_ORDER_MESSAGES, getPurchaseOrder, savePurchaseOrder, submitPurchaseOrder } from '@/lib/finance/purchase-orders';
import { cellNeedsReason, compareQuotes, quotesInSeveralCurrencies } from '@/lib/finance/rfq-compare';
import { RFQ_MESSAGES, awardRfqLines, convertRfq, getRfq, getRfqGroup, quoteRfq, saveRfq, sendRfq } from '@/lib/finance/rfqs';

// Splitting an RFQ comparison between suppliers (20261202090000_bendahara_rfq_split.sql) against the hosted
// database, through the app's own data layer with a real client. Every refusal and every role is proved by
// supabase/tests/bendahara_rfq_split_check.sql; this file adds what only the API shows (named arguments, the
// uuid[] answer, the screen's sentence for a refusal, the reason read back through the view) and holds the
// database's comparison to the screen's: for every line of a few quotes, the database asks for a reason exactly
// when the screen says it needs one (cellNeedsReason in src/lib/finance/rfq-compare.ts): another supplier's
// comparable price is lower, or it cannot be compared and another supplier quoted the row.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Ctx = { client: SupabaseClient; orgId: string };
type Supplier = { id: string };

async function workspace(orgName: string): Promise<Ctx & { suppliers: Supplier[] }> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const ctx = { client: c, orgId: orgId as string };
  const suppliers: Supplier[] = [];
  for (const name of ['Seri Packaging', 'Maju Supplies', 'Teguh Trading', 'Overseas Ltd']) {
    const made = await createContact(ctx, { name: `${name} of ${orgName}`, is_customer: false, is_supplier: true });
    if (!made.ok) throw new Error(made.error);
    suppliers.push({ id: made.data.id });
  }
  return { ...ctx, suppliers };
}

const today = new Date().toISOString().slice(0, 10);

type Line = { description: string; quantity: number; uom?: string; sst_rate?: number; price: number };

/** A sent, quoted RFQ; `source` makes it a copy of the first, so the RFQs compare. */
async function quoted(ctx: Ctx, supplier: Supplier, lines: Line[], extra: { source?: string; currency?: string; rate?: string | null } = {}) {
  const saved = await saveRfq(ctx, {
    supplier_id: supplier.id,
    rfq_date: today,
    source_rfq_id: extra.source,
    ...(extra.currency ? { currency: extra.currency, fx_rate: extra.rate ?? null, fx_rate_source: extra.rate ? ('manual' as const) : null } : {}),
    lines: lines.map(({ description, quantity, uom, sst_rate }) => ({ description, quantity, uom: uom ?? null, sst_rate: sst_rate ?? 0 })),
  });
  if (!saved.ok) throw new Error(saved.error);
  const id = saved.data.id;
  const sent = await sendRfq(ctx, { id });
  if (!sent.ok) throw new Error(sent.error);
  const rfq = await getRfq(ctx, id);
  const answered = await quoteRfq(ctx, { id, prices: rfq!.lines.map((l, i) => ({ line_id: l.id, unit_price: lines[i].price })) });
  if (!answered.ok) throw new Error(answered.error);
  return { id, lines: rfq!.lines.map((l) => l.id) };
}

const award = (ctx: Ctx, awards: object[]) => ctx.client.rpc('finance_award_rfq_lines', { target_org: ctx.orgId, awards });

/** Cancels every draft order, so the next call starts with every RFQ free. */
async function clear(ctx: Ctx) {
  const { error } = await ctx.client.from('finance_purchase_orders').update({ status: 'cancelled' }).eq('org_id', ctx.orgId).eq('status', 'draft');
  expect(error, error?.message).toBeNull();
}

async function orderedLines(ctx: Ctx, orderId: string) {
  const { data, error } = await ctx.client
    .from('finance_purchase_order_lines')
    .select('position, description, quantity, unit_price')
    .eq('purchase_order_id', orderId)
    .order('position');
  expect(error, error?.message).toBeNull();
  return (data ?? []).map((l) => `${l.position}:${l.description}:${Number(l.quantity)}:${Number(l.unit_price)}`);
}

testWithSupabase('a split makes one draft order per supplier with only the chosen lines, and a refused one makes none', async () => {
  const o = await workspace('Split A Sdn Bhd');
  const [s1, s2, s3] = o.suppliers;
  const r1 = await quoted(o, s1, [
    { description: 'Bolts', quantity: 10, uom: 'pcs', price: 3 },
    { description: 'Press', quantity: 1, price: 700 },
    { description: 'Valve', quantity: 2, price: 50 },
  ]);
  const r2 = await quoted(o, s2, [
    { description: 'Bolts', quantity: 10, uom: 'pcs', price: 3 },
    { description: 'Press', quantity: 1, price: 760 },
    { description: 'Valve', quantity: 2, price: 60 },
  ], { source: r1.id });
  const r3 = await quoted(o, s3, [{ description: 'Extra', quantity: 1, price: 9 }], { source: r1.id });

  const made = await award(o, [
    { rfq_id: r1.id, line_ids: [r1.lines[1], r1.lines[2]] },
    { rfq_id: r2.id, line_ids: [r2.lines[0]] },
    { rfq_id: r3.id, line_ids: [r3.lines[0]] },
  ]);
  expect(made.error, made.error?.message).toBeNull();
  const ids = made.data as string[];
  expect(ids).toHaveLength(3);
  expect(await orderedLines(o, ids[0])).toEqual(['2:Press:1:700', '3:Valve:2:50']);
  expect(await orderedLines(o, ids[1])).toEqual(['1:Bolts:10:3']);
  expect(await orderedLines(o, ids[2])).toEqual(['1:Extra:1:9']);
  const { data: orders } = await o.client.from('finance_purchase_orders').select('id, rfq_id, status, award_reason').in('id', ids);
  expect(orders!.map((p) => [p.rfq_id, p.status, p.award_reason]).sort()).toEqual(
    [[r1.id, 'draft', null], [r2.id, 'draft', null], [r3.id, 'draft', null]].sort(),
  );
  await clear(o);

  // All or none: the first award is fine, the second takes Press at 760 against 700 with no reason.
  const refused = await award(o, [
    { rfq_id: r1.id, line_ids: [r1.lines[2]] },
    { rfq_id: r2.id, line_ids: [r2.lines[1]] },
  ]);
  expect(refused.error?.code).toBe('FIN75');
  const { count } = await o.client.from('finance_purchase_orders').select('id', { count: 'exact', head: true }).eq('org_id', o.orgId).neq('status', 'cancelled');
  expect(count).toBe(0);
  // With the reason it goes through, and the view carries it.
  const reasoned = await award(o, [{ rfq_id: r2.id, line_ids: [r2.lines[1]], reason: ' Delivers next day ' }]);
  expect(reasoned.error, reasoned.error?.message).toBeNull();
  const { data: read } = await o.client.from('finance_purchase_order_totals').select('award_reason').eq('id', (reasoned.data as string[])[0]).single();
  expect(read!.award_reason).toBe('Delivers next day');
  await clear(o);

  expect((await award(o, [])).error?.code).toBe('FIN76');
  expect((await award(o, [{ rfq_id: r1.id, line_ids: [r2.lines[0]] }])).error?.code).toBe('FIN76');
  expect((await award(o, [{ rfq_id: r1.id, line_ids: [r1.lines[0]] }, { rfq_id: r2.id, line_ids: [r2.lines[0]] }])).error?.code).toBe('FIN76');
});

testWithSupabase('Make purchase order asks for a reason when another supplier quoted the same rows for less, and keeps it', async () => {
  const o = await workspace('Split B Sdn Bhd');
  const [s1, s2] = o.suppliers;
  const rows: Line[] = [
    { description: 'Bolts', quantity: 10, uom: 'pcs', price: 3 },
    { description: 'Valve', quantity: 2, price: 50 },
  ];
  const low = await quoted(o, s1, rows);
  const high = await quoted(o, s2, rows.map((l) => ({ ...l, price: l.price + 1 })), { source: low.id });

  // The call with no reason is the old one: the database refuses it, and the app says what to do.
  const refused = await convertRfq(o, { id: high.id });
  expect(refused).toEqual({ ok: false, error: RFQ_MESSAGES.needsReason });
  const blank = await convertRfq(o, { id: high.id, reason: '   ' });
  expect(blank).toEqual({ ok: false, error: RFQ_MESSAGES.needsReason });
  const { count } = await o.client.from('finance_purchase_orders').select('id', { count: 'exact', head: true }).eq('org_id', o.orgId);
  expect(count).toBe(0);

  const made = await convertRfq(o, { id: high.id, reason: 'Delivers next day' });
  expect(made.ok).toBe(true);
  const poId = made.ok ? made.data.purchase_order_id : '';
  const { data: read } = await o.client.from('finance_purchase_order_totals').select('award_reason').eq('id', poId).single();
  expect(read!.award_reason).toBe('Delivers next day');

  // While it is a draft the reason may be changed, not emptied; after it is submitted it is locked.
  const changed = await o.client.from('finance_purchase_orders').update({ award_reason: 'Brand asked for' }).eq('id', poId).select('id');
  expect(changed.error, changed.error?.message).toBeNull();
  const emptied = await o.client.from('finance_purchase_orders').update({ award_reason: null }).eq('id', poId).select('id');
  expect(emptied.error?.code).toBe('FIN75');
  const submitted = await submitPurchaseOrder(o, { id: poId });
  expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
  const late = await o.client.from('finance_purchase_orders').update({ award_reason: 'Changed my mind' }).eq('id', poId).select('id');
  expect(late.error?.code).toBe('FIN01');

  // The lowest needs none, called with the old two arguments.
  const cheap = await o.client.rpc('finance_convert_rfq', { target_org: o.orgId, target_rfq: low.id });
  expect(cheap.error, cheap.error?.message).toBeNull();
});

testWithSupabase('the database asks for a reason exactly where the screen says one is needed', async () => {
  const o = await workspace('Split C Sdn Bhd');
  const [s1, s2, s3, s4] = o.suppliers;

  // Group M, all ringgit: a tie (the second wording differs by spaces and capitals), two lines for one item, a row only
  // one supplier quoted.
  const m1 = await quoted(o, s1, [
    { description: 'Bolts', quantity: 10, uom: 'pcs', price: 3 },
    { description: 'Gasket', quantity: 1, price: 5 },
    { description: 'Gasket', quantity: 2, price: 4 },
  ]);
  const m2 = await quoted(o, s2, [
    { description: '  BOLTS ', quantity: 10, uom: 'PCS ', price: 3 },
    { description: 'gasket', quantity: 1, price: 6 },
    { description: 'GASKET', quantity: 2, price: 3 },
  ], { source: m1.id });
  const m3 = await quoted(o, s3, [
    { description: 'Bolts', quantity: 10, uom: 'pcs', price: 3.5 },
    { description: 'Widget', quantity: 1, price: 7 },
  ], { source: m1.id });

  // Group X, ringgit and dollars: one dollar quote with a rate, one without.
  const x1 = await quoted(o, s1, [
    { description: 'Pump', quantity: 1, price: 100 },
    { description: 'Fan', quantity: 5, price: 3 },
  ]);
  const x2 = await quoted(o, s2, [
    { description: 'Pump', quantity: 1, price: 30 },
    { description: 'Fan', quantity: 5, price: 0.8 },
  ], { source: x1.id, currency: 'USD', rate: '4.0000' });
  const x3 = await quoted(o, s4, [
    { description: 'Pump', quantity: 1, price: 10 },
    { description: 'Fan', quantity: 5, price: 1 },
  ], { source: x1.id, currency: 'USD', rate: null });

  const seen = { asked: 0, free: 0 };
  const outcomes: Record<string, boolean> = {};
  for (const first of [m1.id, x1.id]) {
    const group = await getRfqGroup(o, first);
    const rows = compareQuotes(group);
    const mixed = quotesInSeveralCurrencies(group);
    for (const [i, rfq] of group.entries()) {
      for (const [index, line] of rfq.lines.entries()) {
        const found = rows
          .map((row) => ({ row, cell: row.cells[i] }))
          .find((c) => c.cell && c.cell.unit_price === line.unit_price && c.cell.quantity === line.quantity && c.cell.sst_rate === line.sst_rate);
        expect(found, `${rfq.rfq_no} line ${index + 1}`).toBeDefined();
        // The screen's own answer (what Make N purchase orders says under a box), held to the database's below.
        const expected = cellNeedsReason(found!.row, i, mixed) !== null;

        const made = await award(o, [{ rfq_id: rfq.id, line_ids: [line.id] }]);
        if (expected) {
          expect(made.error?.code, `${rfq.rfq_no} ${line.description} x${line.quantity}`).toBe('FIN75');
          seen.asked += 1;
        } else {
          expect(made.error, `${rfq.rfq_no} ${line.description} x${line.quantity}: ${made.error?.message}`).toBeNull();
          seen.free += 1;
          await clear(o);
        }
        outcomes[`${rfq.id}:${index}`] = expected;
      }
    }
  }
  // The fixtures reach both answers, so the loop above is not agreeing about nothing.
  expect(seen.asked).toBeGreaterThanOrEqual(6);
  expect(seen.free).toBeGreaterThanOrEqual(6);
  // And a few answers that are the point: a tie needs none, a lower price elsewhere does, a lone quote needs none.
  expect(outcomes[`${m1.id}:0`]).toBe(false);
  expect(outcomes[`${m2.id}:0`]).toBe(false);
  expect(outcomes[`${m3.id}:0`]).toBe(true);
  expect(outcomes[`${m1.id}:2`]).toBe(true);
  expect(outcomes[`${m2.id}:2`]).toBe(false);
  expect(outcomes[`${m3.id}:1`]).toBe(false);
  expect(outcomes[`${x1.id}:0`]).toBe(false);
  expect(outcomes[`${x2.id}:0`]).toBe(true);
  expect(outcomes[`${x3.id}:0`]).toBe(true);
});

testWithSupabase('the app’s split makes the orders, and the reason on a draft is edited, not emptied, and locked once submitted', async () => {
  const o = await workspace('Split D Sdn Bhd');
  const [s1, s2] = o.suppliers;
  const rows: Line[] = [
    { description: 'Bolts', quantity: 10, uom: 'pcs', price: 3 },
    { description: 'Valve', quantity: 2, price: 50 },
  ];
  const low = await quoted(o, s1, rows);
  const high = await quoted(o, s2, rows.map((l) => ({ ...l, price: l.price + 1 })), { source: low.id });

  // The sentences the screen shows for a refusal.
  expect(await awardRfqLines(o, { awards: [{ rfq_id: high.id, line_ids: [high.lines[0]] }] })).toEqual({ ok: false, error: RFQ_MESSAGES.needsReason });
  expect(await awardRfqLines(o, { awards: [{ rfq_id: low.id, line_ids: [high.lines[0]] }] })).toEqual({ ok: false, error: RFQ_MESSAGES.badAward });

  const made = await awardRfqLines(o, {
    awards: [
      { rfq_id: low.id, line_ids: [low.lines[0]] },
      { rfq_id: high.id, line_ids: [high.lines[1]], reason: ' Delivers next day ' },
    ],
  });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  const ids = made.ok ? made.data.purchase_order_ids : [];
  expect(ids).toHaveLength(2);
  expect(await awardRfqLines(o, { awards: [{ rfq_id: high.id, line_ids: [high.lines[0]], reason: 'again' }] })).toEqual({ ok: false, error: RFQ_MESSAGES.hasOrder });

  // The reason is read with the order, and the draft's form saves it back.
  const order = await getPurchaseOrder(o, ids[1]);
  expect(order).toMatchObject({ rfq_id: high.id, award_reason: 'Delivers next day' });
  expect((await getPurchaseOrder(o, ids[0]))?.award_reason).toBeNull();
  const save = (reason: string | null | undefined) =>
    savePurchaseOrder(o, {
      id: ids[1],
      supplier_id: order!.supplier_id,
      po_date: order!.po_date,
      lines: order!.lines.map((l) => ({ description: l.description, quantity: l.quantity, uom: l.uom, pack_size: l.pack_size, unit_price: l.unit_price, sst_rate: l.sst_rate })),
      award_reason: reason,
    });
  expect(await save('Brand asked for')).toEqual({ ok: true, data: { id: ids[1] } });
  expect((await getPurchaseOrder(o, ids[1]))?.award_reason).toBe('Brand asked for');
  expect(await save(undefined)).toEqual({ ok: true, data: { id: ids[1] } });
  expect((await getPurchaseOrder(o, ids[1]))?.award_reason).toBe('Brand asked for');
  expect(await save('')).toEqual({ ok: false, error: PURCHASE_ORDER_MESSAGES.reasonKept });
  expect((await getPurchaseOrder(o, ids[1]))?.award_reason).toBe('Brand asked for');

  const submitted = await submitPurchaseOrder(o, { id: ids[1] });
  expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
  expect(await save('Changed my mind')).toEqual({ ok: false, error: PURCHASE_ORDER_MESSAGES.locked });
});
