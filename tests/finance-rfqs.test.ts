import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RFQ_MESSAGES,
  RFQ_PAGE_SIZE,
  closeRfq,
  convertRfq,
  deleteRfq,
  getRfq,
  getRfqGroup,
  listRfqs,
  quoteRfq,
  quoteRfqInput,
  saveRfq,
  saveRfqInput,
  sendRfq,
} from '@/lib/finance/rfqs';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const LINE = '66666666-6666-4666-8666-666666666666';

const line = { description: 'Printer paper', quantity: 10, unit_price: null };
const valid = { supplier_id: SUPPLIER, rfq_date: '2026-10-01', reply_by: '2026-10-31', lines: [line] };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveRfqInput.safeParse(value).error?.issues[0]?.message;

describe('saveRfqInput', () => {
  it('asks for a supplier', () => {
    expect(first({ ...valid, supplier_id: '' })).toBe('Choose a supplier.');
    expect(first({ ...valid, supplier_id: undefined })).toBe('Choose a supplier.');
  });
  it('asks for real dates, with the reply-by date not before the RFQ date', () => {
    expect(first({ ...valid, rfq_date: '01/10/2026' })).toBe('Enter a valid date.');
    expect(first({ ...valid, reply_by: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, reply_by: '2026-09-30' })).toBe('The reply-by date cannot be before the RFQ date.');
    expect(first({ ...valid, reply_by: '2026-10-01' })).toBeUndefined();
  });
  it('lets the reply-by date be empty, and stores an empty box as null', () => {
    for (const reply_by of ['', null, undefined]) {
      const parsed = saveRfqInput.parse({ ...valid, reply_by });
      expect(parsed.reply_by).toBeNull();
    }
  });
  it('lets a line have no price, or a price of 0, and rounds a typed price to 4 places', () => {
    expect(saveRfqInput.parse(valid).lines[0].unit_price).toBeNull();
    expect(saveRfqInput.parse({ ...valid, lines: [{ ...line, unit_price: 0 }] }).lines[0].unit_price).toBe(0);
    expect(saveRfqInput.parse({ ...valid, lines: [{ ...line, unit_price: 1.23456 }] }).lines[0].unit_price).toBe(1.2346);
    expect(first({ ...valid, lines: [{ ...line, unit_price: -1 }] })).toBe('Enter a unit price of 0 or more.');
    expect(first({ ...valid, lines: [{ ...line, unit_price: 1_000_000_000 }] })).toBe('Enter a unit price of 0 or more.');
    expect(first({ ...valid, lines: [{ ...line, unit_price: 'abc' }] })).toBe('Enter a unit price of 0 or more.');
  });
  it('asks for at least one line, and not more than 100, with the sentences a quotation line uses', () => {
    expect(first({ ...valid, lines: [] })).toBe('Add at least one line.');
    expect(first({ ...valid, lines: Array.from({ length: 101 }, () => line) })).toBe('An RFQ can have at most 100 lines.');
    expect(first({ ...valid, lines: [{ ...line, description: '  ' }] })).toBe('Describe each line.');
    expect(first({ ...valid, lines: [{ ...line, quantity: 0.0004 }] })).toBe('Enter a quantity above 0.');
    expect(first({ ...valid, lines: [{ ...line, sst_rate: 100.005 }] })).toBe('Enter an SST rate between 0 and 100.');
  });
  it('takes the RFQ a new draft was copied from only as an id, with or without the draft’s own', () => {
    for (const source_rfq_id of ['nope', '', null, 7]) {
      expect(first({ ...valid, source_rfq_id }), String(source_rfq_id)).toBe('That RFQ no longer exists.');
    }
    expect(saveRfqInput.parse({ ...valid, source_rfq_id: ID }).source_rfq_id).toBe(ID);
    expect(saveRfqInput.parse({ ...valid, id: ID, source_rfq_id: ID }).source_rfq_id).toBe(ID);
    expect(saveRfqInput.parse(valid)).not.toHaveProperty('source_rfq_id');
  });
  it('has no place for a number, a status or a supplier reference: the database gives those', () => {
    const parsed = saveRfqInput.parse({ ...valid, notes: '  ', rfq_no: 'RFQ-9999', status: 'quoted', supplier_ref: 'X' });
    expect(Object.keys(parsed).sort()).toEqual(['lines', 'notes', 'reply_by', 'rfq_date', 'supplier_id']);
    expect(parsed.notes).toBeNull();
  });
});

describe('quoteRfqInput', () => {
  const said = (value: unknown) => quoteRfqInput.safeParse(value).error?.issues[0]?.message;
  const prices = [{ line_id: LINE, unit_price: 4.5 }];
  it('takes a price for each line, with an optional rate and reference', () => {
    expect(said({ id: ID, prices })).toBeUndefined();
    expect(quoteRfqInput.parse({ id: ID, supplier_ref: '  Q-1 ', prices: [{ ...prices[0], sst_rate: 6 }] })).toEqual({
      id: ID, supplier_ref: 'Q-1', prices: [{ line_id: LINE, unit_price: 4.5, sst_rate: 6 }],
    });
    expect(quoteRfqInput.parse({ id: ID, supplier_ref: ' ', prices }).supplier_ref).toBeNull();
  });
  it('refuses no prices, a bad price, a bad rate or a bad id', () => {
    expect(said({ id: ID, prices: [] })).toBe('Enter a price for every line before marking the RFQ as quoted.');
    expect(said({ id: ID, prices: [{ line_id: LINE, unit_price: -1 }] })).toBe('Enter a unit price of 0 or more.');
    expect(said({ id: ID, prices: [{ line_id: LINE, unit_price: 1, sst_rate: 101 }] })).toBe('Enter an SST rate between 0 and 100.');
    expect(said({ id: 'nope', prices })).toBe('That RFQ no longer exists.');
  });
});

describe('RFQ reads', () => {
  const row = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `rfq-${n}`, rfq_no: `RFQ-${n}`, supplier_id: 's1', supplier_name: 'Syarikat Kertas',
    rfq_date: '2026-10-01', reply_by: '2026-10-31', supplier_ref: null, status: 'quoted',
    line_count: 2, total: '132.50', quoted_at: '2026-10-02T09:00:00+00:00', purchase_order_id: null, purchase_order_no: null, source_rfq_id: null,
    currency: 'MYR', fx_rate: '1.0000000000', fx_rate_text: '1.0000000000', fx_rate_source: null, fx_rate_date: null, total_myr: '132.50',
    ...extra,
  });
  const read = (n: number, extra: Record<string, unknown> = {}) => ({ ...row(n), line_count: 2, total: 132.5, fx_rate: 1, total_myr: 132.5, ...extra });

  it('lists from the totals view, in the caller’s workspace, newest first, with the figures as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1)], error: null });
    expect(await listRfqs(ctx)).toEqual([read(1)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_rfq_totals',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['rfq_date desc', 'id asc'],
      range: [0, RFQ_PAGE_SIZE - 1],
    });
  });
  it('reads on past a full page, so a long book is never cut short', async () => {
    const full = Array.from({ length: RFQ_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listRfqs(ctx)).toHaveLength(RFQ_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([[0, RFQ_PAGE_SIZE - 1], [RFQ_PAGE_SIZE, 2 * RFQ_PAGE_SIZE - 1]]);
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listRfqs(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
  it('reads one RFQ with its lines in the order entered, keeping a missing price missing', async () => {
    const lines = [
      { id: 'l1', product_id: null, description: 'Printer paper', quantity: '10.000', uom: null, pack_size: null, unit_price: '12.5000', sst_rate: '6.00' },
      { id: 'l2', product_id: null, description: 'Toner', quantity: '1.000', uom: null, pack_size: null, unit_price: null, sst_rate: '0.00' },
    ];
    const { ctx, calls } = fakeFinance((call) =>
      call.name === 'finance_rfq_totals'
        ? { data: { ...row(1), subtotal: '125.00', sst_total: '7.50', notes: 'Urgent', quoted_at: '2026-10-02T09:00:00+00:00' }, error: null }
        : { data: lines, error: null },
    );
    expect(await getRfq(ctx, ID)).toEqual({
      ...read(1), subtotal: 125, sst_total: 7.5, notes: 'Urgent', quoted_at: '2026-10-02T09:00:00+00:00',
      lines: [
        { ...lines[0], quantity: 10, unit_price: 12.5, sst_rate: 6 },
        { ...lines[1], quantity: 1, unit_price: null, sst_rate: 0 },
      ],
    });
    expect(calls[0].filters).toEqual({ org_id: 'org-1', id: ID });
    expect(calls[1]).toMatchObject({ name: 'finance_rfq_lines', filters: { org_id: 'org-1', rfq_id: ID }, order: ['position asc', 'id asc'] });
  });
  it('answers null for an RFQ that is not there, and for an id that is not an id, without asking the database', async () => {
    const missing = fakeFinance({ data: null, error: null });
    expect(await getRfq(missing.ctx, ID)).toBeNull();
    const bad = fakeFinance({ data: null, error: null });
    expect(await getRfq(bad.ctx, 'nope')).toBeNull();
    expect(bad.calls).toEqual([]);
  });
  it('reads a group from its first RFQ: that RFQ and every copy that names it, drafts left out, in the order made', async () => {
    const FIRST = '55555555-5555-4555-8555-555555555555';
    const { ctx, calls } = fakeFinance((call) => {
      if (call.name === 'finance_rfq_lines') return { data: [], error: null };
      // The group's ids; then each RFQ by its own id, the clicked copy first.
      if (call.columns === 'id') return { data: [{ id: FIRST }, { id: ID }], error: null };
      return { data: row(1, { id: call.filters.id, source_rfq_id: call.filters.id === ID ? FIRST : null }), error: null };
    });
    const group = await getRfqGroup(ctx, ID);
    expect(group.map((r) => r.id)).toEqual([FIRST, ID]);
    expect(calls[2]).toMatchObject({
      name: 'finance_rfq_totals',
      filters: { org_id: 'org-1', or: `id.eq.${FIRST},source_rfq_id.eq.${FIRST}`, 'status neq': 'draft' },
      order: ['created_at asc', 'id asc'],
    });
  });
  it('reads no group for an RFQ that is not there', async () => {
    const { ctx, calls } = fakeFinance({ data: null, error: null });
    expect(await getRfqGroup(ctx, ID)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('RFQ writes', () => {
  it('saves through the database function, in the caller’s workspace, sending a missing price as null', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    expect(await saveRfq(ctx, { ...valid, id: ID })).toEqual({ ok: true, data: { id: ID } });
    // A draft saved with no currency keeps its own, so its stored currency is read first (the whole-units rule).
    expect(calls[0]).toMatchObject({ kind: 'table', name: 'finance_rfqs', filters: { org_id: 'org-1', id: ID } });
    expect(calls[1]).toMatchObject({ kind: 'rpc', name: 'finance_save_rfq' });
    expect(calls[1].args).toEqual({
      target_org: 'org-1',
      rfq: { id: ID, supplier_id: SUPPLIER, rfq_date: '2026-10-01', reply_by: '2026-10-31', notes: null },
      lines: [{ product_id: null, description: 'Printer paper', quantity: 10, uom: null, pack_size: null, unit_price: null, sst_rate: 0 }],
    });
  });
  it('sends and returns the number', async () => {
    const { ctx, calls } = fakeFinance({ data: 'RFQ-0007', error: null });
    expect(await sendRfq(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, rfq_no: 'RFQ-0007' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_send_rfq' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_rfq: ID });
  });
  it('records the prices; the function answers nothing, so success is no error', async () => {
    const { ctx, calls } = fakeFinance({ data: null, error: null });
    const prices = [{ line_id: LINE, unit_price: 4.5 }];
    expect(await quoteRfq(ctx, { id: ID, supplier_ref: 'Q-1', prices })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_quote_rfq' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_rfq: ID, prices, supplier_reference: 'Q-1' });
  });
  it('closes; the function answers nothing, so success is no error', async () => {
    const { ctx, calls } = fakeFinance({ data: null, error: null });
    expect(await closeRfq(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_close_rfq' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_rfq: ID });
  });
  it('deletes a draft, scoped to the workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await deleteRfq(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ name: 'finance_rfqs', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'That cannot be done to this RFQ as it now stands. It may have been sent, priced or closed since this page was loaded.'],
      ['FIN10', 'An RFQ needs at least one line.'],
      ['FIN11', 'That RFQ no longer exists.'],
      ['FIN19', 'Enter a price for every line before marking the RFQ as quoted.'],
      ['23505', 'That RFQ number is already used.'],
      ['23503', 'The supplier or a product on this RFQ no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    const prices = [{ line_id: LINE, unit_price: 4.5 }];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await saveRfq(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await sendRfq(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await quoteRfq(ctx, { id: ID, prices }), code).toEqual({ ok: false, error: message });
      expect(await closeRfq(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deleteRfq(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says the RFQ it was copied from is gone when a new copy is refused with FIN11, and nothing else', async () => {
    const sentence = 'The RFQ this was copied from can no longer be found. Save again to keep this one on its own.';
    const copy = { ...valid, source_rfq_id: ID };
    const refused = () => fakeFinance({ data: null, error: { code: 'FIN11' } }).ctx;
    expect(await saveRfq(refused(), copy)).toEqual({ ok: false, error: sentence });
    expect(RFQ_MESSAGES.copiedFromGone).toBe(sentence);
    // A draft being changed that is gone is that RFQ, whatever link is sent with it; so is a new RFQ with no link.
    const OTHER = '55555555-5555-4555-8555-555555555555';
    expect(await saveRfq(refused(), { ...copy, id: OTHER })).toEqual({ ok: false, error: 'That RFQ no longer exists.' });
    expect(await saveRfq(refused(), { ...valid, id: OTHER })).toEqual({ ok: false, error: 'That RFQ no longer exists.' });
    expect(await saveRfq(refused(), valid)).toEqual({ ok: false, error: 'That RFQ no longer exists.' });
    // Any other refusal of a new copy keeps its own sentence.
    for (const [code, message] of [['23503', RFQ_MESSAGES.missing], ['42501', 'You do not have permission to make changes here.']]) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await saveRfq(ctx, copy), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('saves a copy again without its link once the form has let go of it', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    expect(await saveRfq(ctx, valid)).toEqual({ ok: true, data: { id: ID } });
    expect((calls[0].args as { rfq: object }).rfq).not.toHaveProperty('source_rfq_id');
  });
  it('says the RFQ is gone when a delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    expect(await deleteRfq(ctx, { id: ID })).toEqual({ ok: false, error: 'That RFQ no longer exists.' });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await saveRfq(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(await closeRfq(ctx, { id: ID })).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});

describe('convertRfq', () => {
  const PO = '88888888-8888-4888-8888-888888888888';
  it('makes a purchase order through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: PO, error: null });
    expect(await convertRfq(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, purchase_order_id: PO } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_convert_rfq' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_rfq: ID });
  });
  it('says the RFQ already has an order for FIN22 and for a unique-key clash', async () => {
    const sentence = 'This RFQ already has a purchase order. Cancel that order first to make another.';
    for (const code of ['FIN22', '23505']) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await convertRfq(ctx, { id: ID }), code).toEqual({ ok: false, error: sentence });
    }
    expect(RFQ_MESSAGES.hasOrder).toBe(sentence);
  });
  it('uses the RFQ sentences for the other refusals, and the general one with a log for the rest', async () => {
    const cases: [string, string][] = [
      ['FIN01', RFQ_MESSAGES.locked],
      ['FIN11', 'That RFQ no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await convertRfq(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
    }
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await convertRfq(ctx, { id: ID })).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
