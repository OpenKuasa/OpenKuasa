import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PURCHASE_ORDER_MESSAGES,
  PURCHASE_ORDER_PAGE_SIZE,
  billFromPurchaseOrder,
  billFromPurchaseOrderInput,
  cancelPurchaseOrder,
  closePurchaseOrder,
  decidePurchaseOrder,
  decidePurchaseOrderInput,
  deletePurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  purchaseOrderIdInput,
  receivePurchaseOrder,
  receivePurchaseOrderInput,
  savePurchaseOrder,
  savePurchaseOrderInput,
  submitPurchaseOrder,
  withdrawPurchaseOrder,
} from '@/lib/finance/purchase-orders';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const LINE = '66666666-6666-4666-8666-666666666666';
const BILL = '77777777-7777-4777-8777-777777777777';

const line = { description: 'Printer paper', quantity: 10, unit_price: 12.5 };
const valid = { supplier_id: SUPPLIER, po_date: '2026-10-01', expected_date: '2026-10-31', lines: [line] };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => savePurchaseOrderInput.safeParse(value).error?.issues[0]?.message;

describe('savePurchaseOrderInput', () => {
  it('asks for a supplier', () => {
    expect(first({ ...valid, supplier_id: '' })).toBe('Choose a supplier.');
    expect(first({ ...valid, supplier_id: undefined })).toBe('Choose a supplier.');
  });
  it('asks for real dates, with the expected delivery not before the order date', () => {
    expect(first({ ...valid, po_date: '01/10/2026' })).toBe('Enter a valid date.');
    expect(first({ ...valid, expected_date: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, expected_date: '2026-09-30' })).toBe('The expected delivery date cannot be before the order date.');
    expect(first({ ...valid, expected_date: '2026-10-01' })).toBeUndefined();
  });
  it('lets the expected delivery date be empty, and stores an empty box as null', () => {
    for (const expected_date of ['', null, undefined]) {
      expect(savePurchaseOrderInput.parse({ ...valid, expected_date }).expected_date).toBeNull();
    }
  });
  it('takes payment terms of 0 to 365 whole days, or none', () => {
    expect(savePurchaseOrderInput.parse({ ...valid, payment_terms_days: 0 }).payment_terms_days).toBe(0);
    expect(savePurchaseOrderInput.parse({ ...valid, payment_terms_days: 365 }).payment_terms_days).toBe(365);
    expect(savePurchaseOrderInput.parse({ ...valid, payment_terms_days: null }).payment_terms_days).toBeNull();
    expect(savePurchaseOrderInput.parse(valid).payment_terms_days).toBeNull();
    for (const payment_terms_days of [-1, 366, 1.5, Number.NaN, '30']) {
      expect(first({ ...valid, payment_terms_days }), String(payment_terms_days)).toBe(PURCHASE_ORDER_MESSAGES.terms);
    }
    expect(PURCHASE_ORDER_MESSAGES.terms).toBe('Enter payment terms from 0 to 365 days, or leave them empty.');
  });
  it('takes a delivery address of 500 characters or fewer, and stores an empty one as null', () => {
    expect(savePurchaseOrderInput.parse({ ...valid, delivery_address: '  Lot 3, Shah Alam ' }).delivery_address).toBe('Lot 3, Shah Alam');
    for (const delivery_address of ['', '   ', null, undefined]) {
      expect(savePurchaseOrderInput.parse({ ...valid, delivery_address }).delivery_address).toBeNull();
    }
    expect(first({ ...valid, delivery_address: 'a'.repeat(501) })).toBe('Keep the delivery address to 500 characters or fewer.');
    expect(first({ ...valid, delivery_address: 'a'.repeat(500) })).toBeUndefined();
  });
  it('needs a price on every line: unlike an RFQ, an order is for an agreed price', () => {
    expect(first({ ...valid, lines: [{ description: 'Paper', quantity: 1 }] })).toBe('Enter a unit price of 0 or more.');
    expect(first({ ...valid, lines: [{ ...line, unit_price: null }] })).toBe('Enter a unit price of 0 or more.');
    expect(first({ ...valid, lines: [{ ...line, unit_price: -1 }] })).toBe('Enter a unit price of 0 or more.');
    expect(savePurchaseOrderInput.parse({ ...valid, lines: [{ ...line, unit_price: 0 }] }).lines[0].unit_price).toBe(0);
    expect(savePurchaseOrderInput.parse({ ...valid, lines: [{ ...line, unit_price: 1.23456 }] }).lines[0].unit_price).toBe(1.2346);
  });
  it('asks for at least one line, and not more than 100, with the sentences a bill line uses', () => {
    expect(first({ ...valid, lines: [] })).toBe('Add at least one line.');
    expect(first({ ...valid, lines: Array.from({ length: 101 }, () => line) })).toBe('A purchase order can have at most 100 lines.');
    expect(first({ ...valid, lines: [{ ...line, description: '  ' }] })).toBe('Describe each line.');
    expect(first({ ...valid, lines: [{ ...line, quantity: 0.0004 }] })).toBe('Enter a quantity above 0.');
    expect(first({ ...valid, lines: [{ ...line, sst_rate: 100.005 }] })).toBe('Enter an SST rate between 0 and 100.');
  });
  it('has no place for a number, a status or a received quantity: the database gives those', () => {
    const parsed = savePurchaseOrderInput.parse({
      ...valid, notes: '  ', po_no: 'PO-9999', status: 'approved', rfq_id: ID, lines: [{ ...line, received_quantity: 5 }],
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'delivery_address', 'expected_date', 'lines', 'notes', 'payment_terms_days', 'po_date', 'supplier_id',
    ]);
    expect(parsed.lines[0]).not.toHaveProperty('received_quantity');
    expect(parsed.notes).toBeNull();
  });
});

describe('the other inputs', () => {
  it('purchaseOrderIdInput wants an id', () => {
    expect(purchaseOrderIdInput.safeParse({ id: ID }).success).toBe(true);
    expect(purchaseOrderIdInput.safeParse({ id: 'nope' }).error?.issues[0]?.message).toBe('That purchase order no longer exists.');
  });
  it('a rejection needs a reason, an approval does not', () => {
    const said = (value: unknown) => decidePurchaseOrderInput.safeParse(value).error?.issues[0]?.message;
    expect(said({ id: ID, approve: false })).toBe('Say why the order is rejected.');
    expect(said({ id: ID, approve: false, reason: '   ' })).toBe('Say why the order is rejected.');
    expect(said({ id: ID, approve: false, reason: null })).toBe('Say why the order is rejected.');
    expect(decidePurchaseOrderInput.parse({ id: ID, approve: false, reason: ' Too dear ' }).reason).toBe('Too dear');
    expect(said({ id: ID, approve: true })).toBeUndefined();
    expect(decidePurchaseOrderInput.parse({ id: ID, approve: true }).reason).toBeNull();
    expect(said({ id: 'nope', approve: true })).toBe('That purchase order no longer exists.');
    expect(said({ id: ID, approve: 'yes' })).toBeDefined();
  });
  it('receipts need a line and a quantity of 0 or more, to 3 places', () => {
    const said = (value: unknown) => receivePurchaseOrderInput.safeParse(value).error?.issues[0]?.message;
    const receipts = [{ line_id: LINE, received_quantity: 4 }];
    expect(said({ id: ID, receipts })).toBeUndefined();
    expect(receivePurchaseOrderInput.parse({ id: ID, receipts: [{ line_id: LINE, received_quantity: 0 }] }).receipts[0].received_quantity).toBe(0);
    expect(receivePurchaseOrderInput.parse({ id: ID, receipts: [{ line_id: LINE, received_quantity: 1.23456 }] }).receipts[0].received_quantity).toBe(1.235);
    expect(said({ id: ID, receipts: [] })).toBe('Enter how much has arrived for each line, 0 or more.');
    expect(said({ id: ID, receipts: [{ line_id: LINE, received_quantity: -1 }] })).toBe('Enter how much has arrived for each line, 0 or more.');
    expect(said({ id: ID, receipts: [{ line_id: LINE, received_quantity: Number.NaN }] })).toBe('Enter how much has arrived for each line, 0 or more.');
    expect(said({ id: ID, receipts: [{ line_id: 'nope', received_quantity: 1 }] })).toBe('That purchase order no longer exists.');
  });
  it('a bill needs an order and a real bill date', () => {
    expect(billFromPurchaseOrderInput.safeParse({ id: ID, bill_date: '2026-10-12' }).success).toBe(true);
    expect(billFromPurchaseOrderInput.safeParse({ id: ID, bill_date: '12/10/2026' }).error?.issues[0]?.message).toBe('Enter a valid date.');
    expect(billFromPurchaseOrderInput.safeParse({ id: 'nope', bill_date: '2026-10-12' }).error?.issues[0]?.message).toBe(
      'That purchase order no longer exists.',
    );
  });
});

describe('purchase order reads', () => {
  const row = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `po-${n}`, po_no: `PO-${n}`, supplier_id: 's1', supplier_name: 'Syarikat Kertas', rfq_id: null, rfq_no: null,
    po_date: '2026-10-01', expected_date: '2026-10-20', status: 'approved', created_by: 'u1', submitted_by: 'u1',
    rejection_reason: null, payment_terms_days: 30, delivery_address: null,
    total: '132.50', delivery: 'partial', received_total: '50.00', billed_total: '40.00', over_billed: false, billed_over_received: false,
    ...extra,
  });
  const read = (n: number, extra: Record<string, unknown> = {}) => ({
    ...row(n), total: 132.5, received_total: 50, billed_total: 40, ...extra,
  });

  it('lists from the totals view, in the caller’s workspace, newest first, with the figures as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1)], error: null });
    expect(await listPurchaseOrders(ctx)).toEqual([read(1)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_purchase_order_totals',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['po_date desc', 'id asc'],
      range: [0, PURCHASE_ORDER_PAGE_SIZE - 1],
    });
    for (const column of ['po_no', 'rfq_no', 'created_by', 'submitted_by', 'payment_terms_days', 'delivery_address', 'received_total', 'billed_over_received']) {
      expect(calls[0].columns, column).toContain(column);
    }
  });
  it('keeps missing terms missing and turns terms into a number', async () => {
    const { ctx } = fakeFinance({ data: [row(1, { payment_terms_days: null }), row(2, { payment_terms_days: '14' })], error: null });
    expect((await listPurchaseOrders(ctx)).map((r) => r.payment_terms_days)).toEqual([null, 14]);
  });
  it('reads on past a full page, so a long book is never cut short', async () => {
    const full = Array.from({ length: PURCHASE_ORDER_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listPurchaseOrders(ctx)).toHaveLength(PURCHASE_ORDER_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([
      [0, PURCHASE_ORDER_PAGE_SIZE - 1],
      [PURCHASE_ORDER_PAGE_SIZE, 2 * PURCHASE_ORDER_PAGE_SIZE - 1],
    ]);
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listPurchaseOrders(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
  it('reads one order with its lines in the order entered, including what has arrived', async () => {
    const lines = [
      { id: 'l1', product_id: null, description: 'Printer paper', quantity: '10.000', uom: null, pack_size: null, unit_price: '12.5000', sst_rate: '6.00', amount: '125.00', sst_amount: '7.50', received_quantity: '4.000' },
      { id: 'l2', product_id: null, description: 'Toner', quantity: '1.000', uom: 'pc', pack_size: null, unit_price: '80.0000', sst_rate: '0.00', amount: '80.00', sst_amount: '0.00', received_quantity: '0.000' },
    ];
    const { ctx, calls } = fakeFinance((call) =>
      call.name === 'finance_purchase_order_totals'
        ? { data: { ...row(1), subtotal: '205.00', sst_total: '7.50', notes: 'Urgent' }, error: null }
        : { data: lines, error: null },
    );
    expect(await getPurchaseOrder(ctx, ID)).toEqual({
      ...read(1), subtotal: 205, sst_total: 7.5, notes: 'Urgent',
      lines: [
        { ...lines[0], quantity: 10, unit_price: 12.5, sst_rate: 6, amount: 125, sst_amount: 7.5, received_quantity: 4 },
        { ...lines[1], quantity: 1, unit_price: 80, sst_rate: 0, amount: 80, sst_amount: 0, received_quantity: 0 },
      ],
    });
    expect(calls[0].filters).toEqual({ org_id: 'org-1', id: ID });
    expect(calls[1]).toMatchObject({
      name: 'finance_purchase_order_lines',
      filters: { org_id: 'org-1', purchase_order_id: ID },
      order: ['position asc', 'id asc'],
    });
    expect(calls[1].columns).toContain('received_quantity');
  });
  it('answers null for an order that is not there, and for an id that is not an id, without asking the database', async () => {
    const missing = fakeFinance({ data: null, error: null });
    expect(await getPurchaseOrder(missing.ctx, ID)).toBeNull();
    const bad = fakeFinance({ data: null, error: null });
    expect(await getPurchaseOrder(bad.ctx, 'nope')).toBeNull();
    expect(bad.calls).toEqual([]);
  });
});

describe('purchase order writes', () => {
  it('saves through the database function, in the caller’s workspace, with the terms and address', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    expect(
      await savePurchaseOrder(ctx, { ...valid, id: ID, payment_terms_days: 14, delivery_address: 'Lot 3' }),
    ).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_purchase_order' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      purchase_order: {
        id: ID, supplier_id: SUPPLIER, po_date: '2026-10-01', expected_date: '2026-10-31',
        payment_terms_days: 14, delivery_address: 'Lot 3', notes: null,
      },
      lines: [{ product_id: null, description: 'Printer paper', quantity: 10, uom: null, pack_size: null, unit_price: 12.5, sst_rate: 0 }],
    });
  });
  it('submits and returns the number', async () => {
    const { ctx, calls } = fakeFinance({ data: 'PO-0007', error: null });
    expect(await submitPurchaseOrder(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, po_no: 'PO-0007' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_submit_purchase_order' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_po: ID });
  });
  it('approves, and rejects with the reason; the functions answer nothing, so success is no error', async () => {
    const { ctx, calls } = fakeFinance({ data: null, error: null });
    expect(await decidePurchaseOrder(ctx, { id: ID, approve: true })).toEqual({ ok: true, data: { id: ID } });
    expect(await decidePurchaseOrder(ctx, { id: ID, approve: false, reason: 'Too dear' })).toEqual({ ok: true, data: { id: ID } });
    expect(calls.map((c) => [c.name, c.args])).toEqual([
      ['finance_decide_purchase_order', { target_org: 'org-1', target_po: ID, approve: true, reason: null }],
      ['finance_decide_purchase_order', { target_org: 'org-1', target_po: ID, approve: false, reason: 'Too dear' }],
    ]);
  });
  it('withdraws, closes and cancels; each answers nothing, so success is no error', async () => {
    const { ctx, calls } = fakeFinance({ data: null, error: null });
    expect(await withdrawPurchaseOrder(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(await closePurchaseOrder(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(await cancelPurchaseOrder(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls.map((c) => [c.name, c.args])).toEqual([
      ['finance_withdraw_purchase_order', { target_org: 'org-1', target_po: ID }],
      ['finance_close_purchase_order', { target_org: 'org-1', target_po: ID }],
      ['finance_cancel_purchase_order', { target_org: 'org-1', target_po: ID }],
    ]);
  });
  it('records receipts as the totals so far', async () => {
    const { ctx, calls } = fakeFinance({ data: null, error: null });
    const receipts = [{ line_id: LINE, received_quantity: 4 }];
    expect(await receivePurchaseOrder(ctx, { id: ID, receipts })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_receive_purchase_order' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_po: ID, receipts });
  });
  it('deletes a draft, scoped to the workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await deletePurchaseOrder(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ name: 'finance_purchase_orders', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('says the order is gone when a delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    expect(await deletePurchaseOrder(ctx, { id: ID })).toEqual({ ok: false, error: 'That purchase order no longer exists.' });
  });
  it('turns each database refusal into a sentence, whichever function met it', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'That cannot be done to this purchase order as it now stands. It may have been submitted, approved, closed or cancelled since this page was loaded.'],
      ['FIN10', 'A purchase order needs at least one line with an amount.'],
      ['FIN11', 'That purchase order no longer exists.'],
      ['FIN14', 'Only an owner or admin can do that to a purchase order.'],
      ['FIN18', 'You raised or submitted this purchase order, so someone else has to approve it.'],
      ['FIN20', 'This purchase order has bills against it. Void those bills, or delete them if they are drafts, first.'],
      ['FIN21', 'A bill can only be raised against an approved purchase order.'],
      ['23505', 'That purchase order number is already used.'],
      ['23503', 'The supplier or a product on this purchase order no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    const receipts = [{ line_id: LINE, received_quantity: 1 }];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await savePurchaseOrder(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await submitPurchaseOrder(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await withdrawPurchaseOrder(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await closePurchaseOrder(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await cancelPurchaseOrder(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deletePurchaseOrder(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      // These two meet FIN10 for a reason of their own: nothing recorded, or a rejection with no reason.
      if (code !== 'FIN10') {
        expect(await decidePurchaseOrder(ctx, { id: ID, approve: true }), code).toEqual({ ok: false, error: message });
        expect(await receivePurchaseOrder(ctx, { id: ID, receipts }), code).toEqual({ ok: false, error: message });
      }
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('words FIN10 for a decision or a delivery by what was missing', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN10' } });
    expect(await decidePurchaseOrder(ctx, { id: ID, approve: true })).toEqual({ ok: false, error: 'Say why the order is rejected.' });
    expect(await receivePurchaseOrder(ctx, { id: ID, receipts: [{ line_id: LINE, received_quantity: 1 }] })).toEqual({
      ok: false, error: 'Enter how much has arrived for each line, 0 or more.',
    });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await savePurchaseOrder(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(await closePurchaseOrder(ctx, { id: ID })).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});

describe('billFromPurchaseOrder', () => {
  const header = {
    id: ID, po_no: 'PO-0007', supplier_id: SUPPLIER, supplier_name: 'Syarikat Kertas', rfq_id: null, rfq_no: null,
    po_date: '2026-10-01', expected_date: null, status: 'approved', created_by: 'u1', submitted_by: 'u1',
    rejection_reason: null, payment_terms_days: 30, delivery_address: null,
    total: '132.50', delivery: 'pending', received_total: '0', billed_total: '0', over_billed: false, billed_over_received: false,
    subtotal: '125.00', sst_total: '7.50', notes: 'Urgent',
  };
  const poLines = [
    { id: 'l1', product_id: null, description: 'Printer paper', quantity: '10.000', uom: 'ream', pack_size: 'box of 5', unit_price: '12.5000', sst_rate: '6.00', amount: '125.00', sst_amount: '7.50', received_quantity: '4.000' },
  ];
  const answering = (
    head: Record<string, unknown> | null,
    rpc: { data: unknown; error: unknown } = { data: BILL, error: null },
    supplier: { data: unknown; error: unknown } = { data: { payment_terms_days: 14 }, error: null },
  ) =>
    fakeFinance((call) => {
      if (call.name === 'finance_purchase_order_totals') return { data: head, error: null };
      if (call.name === 'finance_purchase_order_lines') return { data: poLines, error: null };
      if (call.name === 'finance_contacts') return supplier;
      return rpc;
    });

  it('saves a draft bill for the order’s supplier with its lines, the order’s id, and the due date from the order’s terms', async () => {
    const { ctx, calls } = answering(header);
    expect(await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-12' })).toEqual({ ok: true, data: { id: ID, bill_id: BILL } });
    const save = calls.find((c) => c.name === 'finance_save_bill');
    expect(save?.args).toEqual({
      target_org: 'org-1',
      bill: {
        supplier_id: SUPPLIER, supplier_ref: null, bill_date: '2026-10-12', due_date: '2026-11-11', notes: null, purchase_order_id: ID,
      },
      lines: [{ product_id: null, description: 'Printer paper', quantity: 10, uom: 'ream', pack_size: 'box of 5', unit_price: 12.5, sst_rate: 6 }],
    });
    // The bill is a draft: nothing is posted.
    expect(calls.map((c) => c.name)).not.toContain('finance_post_bill');
  });
  const dueDate = (calls: { name: string; args?: Record<string, unknown> }[]) =>
    (calls.find((c) => c.name === 'finance_save_bill')?.args as { bill: { due_date: string } }).bill.due_date;
  it('uses the order’s own terms and does not look the supplier up', async () => {
    const { ctx, calls } = answering(header);
    await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-12' });
    expect(dueDate(calls)).toBe('2026-11-11');
    expect(calls.map((c) => c.name)).not.toContain('finance_contacts');
  });
  it('uses the supplier’s terms when the order has none', async () => {
    const { ctx, calls } = answering({ ...header, payment_terms_days: null });
    await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-12' });
    expect(dueDate(calls)).toBe('2026-10-26');
    expect(calls.find((c) => c.name === 'finance_contacts')?.filters).toEqual({ org_id: 'org-1', id: SUPPLIER });
  });
  it('is due on the bill date when neither the order nor the supplier has terms to read', async () => {
    for (const supplier of [{ data: null, error: null }, { data: null, error: { code: 'x' } }]) {
      const { ctx, calls } = answering({ ...header, payment_terms_days: null }, undefined, supplier);
      await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-12' });
      expect(dueDate(calls)).toBe('2026-10-12');
    }
  });
  it('does not ask for a bill against an order that is not approved', async () => {
    for (const status of ['draft', 'pending_approval', 'closed', 'cancelled']) {
      const { ctx, calls } = answering({ ...header, status });
      expect(await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-12' }), status).toEqual({
        ok: false, error: 'A bill can only be raised against an approved purchase order.',
      });
      expect(calls.map((c) => c.name), status).not.toContain('finance_save_bill');
    }
  });
  it('says the order is gone when it is not in this workspace', async () => {
    const { ctx, calls } = answering(null);
    expect(await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-12' })).toEqual({
      ok: false, error: 'That purchase order no longer exists.',
    });
    expect(calls.map((c) => c.name)).not.toContain('finance_save_bill');
  });
  it('puts the bill refusals in the order’s words: FIN21 means the order stopped being approved', async () => {
    const { ctx } = answering(header, { data: null, error: { code: 'FIN21' } });
    expect(await billFromPurchaseOrder(ctx, { id: ID, bill_date: '2026-10-12' })).toEqual({
      ok: false, error: 'A bill can only be raised against an approved purchase order.',
    });
    const tooBig = answering(header, { data: null, error: { code: '22003' } });
    expect(await billFromPurchaseOrder(tooBig.ctx, { id: ID, bill_date: '2026-10-12' })).toEqual({ ok: false, error: 'That amount is too large.' });
  });
});
