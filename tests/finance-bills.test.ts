import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinanceWriteContext } from '@/lib/finance/result';
import { BILL_MESSAGES, BILL_PAGE_SIZE, deleteBill, getBill, listBills, postBill, saveBill, saveBillInput, voidBill } from '@/lib/finance/bills';

const ID = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';

type Call = { kind: 'rpc' | 'table'; name: string; op?: string; args?: Record<string, unknown>; values?: Record<string, unknown>; filters: Record<string, unknown> };

/** Records rpc and table requests and answers each with the same canned result. */
function fakeClient(answer: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ kind: 'rpc', name, args, filters: {} });
      return answer;
    },
    from(name: string) {
      const call: Call = { kind: 'table', name, filters: {} };
      calls.push(call);
      const builder = {
        update(values: Record<string, unknown>) { call.op = 'update'; call.values = values; return builder; },
        delete() { call.op = 'delete'; return builder; },
        eq(column: string, value: unknown) { call.filters[column] = value; return builder; },
        select() { return builder; },
        maybeSingle: async () => answer,
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, calls };
}

const line = { description: 'Gloves', quantity: 10, unit_price: 12.5 };
const valid = { supplier_id: SUPPLIER, bill_date: '2026-10-01', due_date: '2026-10-31', lines: [line] };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveBillInput.safeParse(value).error?.issues[0]?.message;

describe('saveBillInput', () => {
  it('asks for a supplier', () => {
    expect(first({ ...valid, supplier_id: '' })).toBe('Choose a supplier.');
  });
  it('asks for real dates, with the due date not before the bill date', () => {
    expect(first({ ...valid, bill_date: '01/10/2026' })).toBe('Enter a valid date.');
    expect(first({ ...valid, bill_date: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, due_date: '2026-09-30' })).toBe('The due date cannot be before the bill date.');
  });
  it('asks for at least one line, and not more than 100', () => {
    expect(first({ ...valid, lines: [] })).toBe('Add at least one line.');
    expect(first({ ...valid, lines: Array.from({ length: 101 }, () => line) })).toBe('A bill can have at most 100 lines.');
  });
  it('checks each line', () => {
    expect(first({ ...valid, lines: [{ ...line, description: '  ' }] })).toBe('Describe each line.');
    expect(first({ ...valid, lines: [{ ...line, quantity: 0 }] })).toBe('Enter a quantity above 0.');
    expect(first({ ...valid, lines: [{ ...line, unit_price: -1 }] })).toBe('Enter a unit price of 0 or more.');
    expect(first({ ...valid, lines: [{ ...line, sst_rate: 101 }] })).toBe('Enter an SST rate between 0 and 100.');
  });
  it('fills the defaults, rounds quantities to 3 and prices to 4 decimals, and empties become null', () => {
    const parsed = saveBillInput.parse({
      ...valid,
      supplier_ref: '  ',
      notes: '',
      lines: [{ description: ' Gloves ', quantity: 1.23456, unit_price: 0.123456, uom: '', product_id: '' }],
    });
    expect(parsed).toMatchObject({ supplier_ref: null, notes: null });
    expect(parsed.lines[0]).toEqual({
      product_id: null, description: 'Gloves', quantity: 1.235, uom: null, pack_size: null, unit_price: 0.1235, sst_rate: 0,
    });
  });
});

describe('saveBillInput purchase_order_id', () => {
  const PO = '88888888-8888-4888-8888-888888888888';
  it('leaves the key out when the input has none, so a draft keeps the order it has', () => {
    expect(saveBillInput.parse(valid)).not.toHaveProperty('purchase_order_id');
  });
  it('takes an order id, and an empty box or null as null (no order)', () => {
    expect(saveBillInput.parse({ ...valid, purchase_order_id: PO }).purchase_order_id).toBe(PO);
    expect(saveBillInput.parse({ ...valid, purchase_order_id: '' }).purchase_order_id).toBeNull();
    expect(saveBillInput.parse({ ...valid, purchase_order_id: null }).purchase_order_id).toBeNull();
  });
  it('refuses something that is not an id, in the order’s words', () => {
    expect(first({ ...valid, purchase_order_id: 'nope' })).toBe('Choose an approved purchase order from this supplier, or none.');
  });
  it('sends it to the database function only when the input has it', async () => {
    const withOrder = fakeClient({ data: ID, error: null });
    await saveBill(withOrder.ctx, { ...valid, purchase_order_id: PO });
    expect(withOrder.calls[0].args!.bill).toMatchObject({ purchase_order_id: PO });
    const without = fakeClient({ data: ID, error: null });
    await saveBill(without.ctx, valid);
    expect(without.calls[0].args!.bill).not.toHaveProperty('purchase_order_id');
  });
  it('turns FIN21 into the order sentence', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: 'FIN21' } });
    expect(await saveBill(ctx, { ...valid, purchase_order_id: PO })).toEqual({
      ok: false, error: 'Choose an approved purchase order from this supplier, or none.',
    });
  });
});

describe('saveBillInput category_id', () => {
  const CATEGORY = '99999999-9999-4999-8999-999999999999';
  it('leaves the key out when the input has none, so a draft keeps its category and a new bill gets the default', () => {
    expect(saveBillInput.parse(valid)).not.toHaveProperty('category_id');
  });
  it('takes a category id, and an empty box or null as null (the database then gives the default)', () => {
    expect(saveBillInput.parse({ ...valid, category_id: CATEGORY }).category_id).toBe(CATEGORY);
    expect(saveBillInput.parse({ ...valid, category_id: '' }).category_id).toBeNull();
    expect(saveBillInput.parse({ ...valid, category_id: null }).category_id).toBeNull();
  });
  it('refuses something that is not an id, in the category’s words', () => {
    expect(first({ ...valid, category_id: 'nope' })).toBe('Choose an expense category for the bill.');
    expect(BILL_MESSAGES.category).toBe('Choose an expense category for the bill.');
  });
  it('sends it to the database function only when the input has it', async () => {
    const withCategory = fakeClient({ data: ID, error: null });
    await saveBill(withCategory.ctx, { ...valid, category_id: CATEGORY });
    expect(withCategory.calls[0].args!.bill).toMatchObject({ category_id: CATEGORY });
    const without = fakeClient({ data: ID, error: null });
    await saveBill(without.ctx, valid);
    expect(without.calls[0].args!.bill).not.toHaveProperty('category_id');
  });
  it('turns FIN26 into the category sentence', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: 'FIN26' } });
    expect(await saveBill(ctx, { ...valid, category_id: CATEGORY })).toEqual({
      ok: false, error: 'Choose an expense category for the bill.',
    });
  });
});

describe('saveBillInput quantity rounding', () => {
  it('refuses a quantity that rounds to 0 and rounds a half step up', () => {
    expect(first({ ...valid, lines: [{ ...line, quantity: 0.0004 }] })).toBe('Enter a quantity above 0.');
    expect(saveBillInput.parse({ ...valid, lines: [{ ...line, quantity: 0.0005 }] }).lines[0].quantity).toBe(0.001);
  });
});

describe('bill writes', () => {
  it('saves through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeClient({ data: ID, error: null });
    expect(await saveBill(ctx, { ...valid, id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_bill' });
    expect(calls[0].args).toMatchObject({
      target_org: 'org-1',
      bill: { id: ID, supplier_id: SUPPLIER, bill_date: '2026-10-01', due_date: '2026-10-31' },
    });
    expect((calls[0].args!.lines as unknown[]).length).toBe(1);
  });
  it('posts and returns the number', async () => {
    const { ctx, calls } = fakeClient({ data: 'BILL-0007', error: null });
    expect(await postBill(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, bill_no: 'BILL-0007' } });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_bill: ID });
  });
  it('voids by setting the status, scoped to the workspace', async () => {
    const { ctx, calls } = fakeClient({ data: { id: ID }, error: null });
    expect(await voidBill(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'table', name: 'supplier_bills', op: 'update' });
    expect(calls[0].values).toMatchObject({ status: 'void' });
    expect(calls[0].filters).toEqual({ id: ID, org_id: 'org-1' });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'This bill is posted and can no longer be changed. Void it instead.'],
      ['FIN02', 'This bill has payments. Void or delete them before voiding it.'],
      ['FIN10', 'A bill needs at least one line with an amount.'],
      ['FIN11', 'That bill no longer exists.'],
      ['FIN14', 'Only an owner or admin can post, pay or void. Ask one of them to do this.'],
      ['23505', 'That bill number is already used.'],
      ['23503', 'The supplier or a product on this bill no longer exists.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeClient({ data: null, error: { code } });
      expect(await saveBill(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await postBill(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await voidBill(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deleteBill(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says the bill is gone when void or delete touches no row', async () => {
    const { ctx } = fakeClient({ data: null, error: null });
    expect(await voidBill(ctx, { id: ID })).toEqual({ ok: false, error: 'That bill no longer exists.' });
    expect(await deleteBill(ctx, { id: ID })).toEqual({ ok: false, error: 'That bill no longer exists.' });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: 'XX000' } });
    expect(await saveBill(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});

/** Answers each table with its own rows; a paged read gets the slice asked for. */
function tableClient(tables: Record<string, { rows?: Record<string, unknown>[]; error?: unknown }>) {
  const reads: { table: string; eq: Record<string, unknown>; range?: [number, number] }[] = [];
  const client = {
    from(name: string) {
      const read = { table: name, eq: {} as Record<string, unknown>, range: undefined as [number, number] | undefined };
      reads.push(read);
      const t = tables[name] ?? { rows: [] };
      const rows = t.rows ?? [];
      const builder = {
        select() { return builder; },
        order() { return builder; },
        eq(column: string, value: unknown) { read.eq[column] = value; return builder; },
        range: async (from: number, to: number) => {
          read.range = [from, to];
          return { data: t.error ? null : rows.slice(from, to + 1), error: t.error ?? null };
        },
        maybeSingle: async () => {
          const match = rows.find((r) => Object.entries(read.eq).every(([k, v]) => k === 'org_id' || r[k] === v));
          return { data: t.error ? null : (match ?? null), error: t.error ?? null };
        },
        // An unpaged read (a bill's lines) is awaited as it stands.
        then(resolve: (v: unknown) => void) { resolve({ data: t.error ? null : rows, error: t.error ?? null }); },
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, reads };
}

const billRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, bill_no: null, supplier_id: SUPPLIER, supplier_name: 'Lim', bill_date: '2026-10-01', due_date: '2026-10-31',
  total: '100', paid: '0', balance: '100', display_status: 'draft', ...extra,
});
const link = (bill_id: string, no: string) => ({ org_id: 'org-1', bill_id, purchase_order_id: `po-${no}`, po_no: no, purchase_order_status: 'approved' });

describe('listBills with purchase orders', () => {
  it('gives each bill the order it is linked to, and null where it has none', async () => {
    const { ctx, reads } = tableClient({
      supplier_bill_totals: { rows: [billRow('b1'), billRow('b2')] },
      finance_bill_purchase_orders: { rows: [link('b2', 'PO-0003')] },
    });
    const rows = await listBills(ctx);
    expect(rows.map((r) => [r.id, r.purchase_order_id, r.purchase_order_no])).toEqual([
      ['b1', null, null],
      ['b2', 'po-PO-0003', 'PO-0003'],
    ]);
    expect(rows[0].total).toBe(100);
    expect(reads.find((r) => r.table === 'finance_bill_purchase_orders')!.eq).toEqual({ org_id: 'org-1' });
  });
  it('reads the links a page at a time as well', async () => {
    const many = Array.from({ length: BILL_PAGE_SIZE + 1 }, (_, i) => link(`b${i}`, `PO-${i}`));
    const { ctx, reads } = tableClient({ supplier_bill_totals: { rows: [billRow('b0')] }, finance_bill_purchase_orders: { rows: many } });
    await listBills(ctx);
    expect(reads.filter((r) => r.table === 'finance_bill_purchase_orders').map((r) => r.range)).toEqual([
      [0, BILL_PAGE_SIZE - 1],
      [BILL_PAGE_SIZE, 2 * BILL_PAGE_SIZE - 1],
    ]);
  });
  it('fails like the other reads when the links cannot be read, rather than showing bills with the order missing', async () => {
    const { ctx } = tableClient({ supplier_bill_totals: { rows: [billRow('b1')] }, finance_bill_purchase_orders: { error: { code: 'x' } } });
    await expect(listBills(ctx)).rejects.toEqual({ code: 'x' });
  });
  it('reads what posted contra entries set off, apart from what was paid', async () => {
    const { ctx } = tableClient({
      supplier_bill_totals: { rows: [billRow('b1', { set_off: '40.00', balance: '60.00', display_status: 'pending' })] },
      finance_bill_purchase_orders: { rows: [] },
    });
    expect(await listBills(ctx)).toMatchObject([{ paid: 0, set_off: 40, balance: 60 }]);
  });
});

describe('getBill with purchase orders', () => {
  it('carries the order of a linked bill', async () => {
    const { ctx } = tableClient({
      supplier_bill_totals: { rows: [billRow(ID, { supplier_ref: null, notes: null })] },
      supplier_bill_lines: { rows: [] },
      finance_bill_purchase_orders: { rows: [link(ID, 'PO-0003')] },
    });
    const bill = await getBill(ctx, ID);
    expect(bill).toMatchObject({ id: ID, purchase_order_id: 'po-PO-0003', purchase_order_no: 'PO-0003' });
  });
  it('has none for an unlinked bill', async () => {
    const { ctx } = tableClient({
      supplier_bill_totals: { rows: [billRow(ID, { supplier_ref: null, notes: null })] },
      supplier_bill_lines: { rows: [] },
      finance_bill_purchase_orders: { rows: [] },
    });
    expect(await getBill(ctx, ID)).toMatchObject({ purchase_order_id: null, purchase_order_no: null });
  });
});

describe('bills with categories', () => {
  const CAT = 'cat-1';
  const cats = { finance_categories: { rows: [{ id: CAT, name: 'Purchases' }, { id: 'cat-2', name: 'Utilities' }] } };

  it('gives each bill its category and the category’s name, read from the bills themselves', async () => {
    const { ctx, reads } = tableClient({
      supplier_bill_totals: { rows: [billRow('b1'), billRow('b2')] },
      supplier_bills: { rows: [{ id: 'b1', category_id: CAT }, { id: 'b2', category_id: 'cat-2' }] },
      ...cats,
    });
    const rows = await listBills(ctx);
    expect(rows.map((r) => [r.id, r.category_id, r.category_name])).toEqual([
      ['b1', CAT, 'Purchases'],
      ['b2', 'cat-2', 'Utilities'],
    ]);
    expect(reads.find((r) => r.table === 'supplier_bills')!.eq).toEqual({ org_id: 'org-1' });
    expect(reads.find((r) => r.table === 'finance_categories')!.eq).toEqual({ org_id: 'org-1' });
  });
  it('reads the categories of bills a page at a time as well', async () => {
    const many = Array.from({ length: BILL_PAGE_SIZE + 1 }, (_, i) => ({ id: `b${i}`, category_id: CAT }));
    const { ctx, reads } = tableClient({ supplier_bill_totals: { rows: [billRow('b0')] }, supplier_bills: { rows: many }, ...cats });
    await listBills(ctx);
    expect(reads.filter((r) => r.table === 'supplier_bills').map((r) => r.range)).toEqual([
      [0, BILL_PAGE_SIZE - 1],
      [BILL_PAGE_SIZE, 2 * BILL_PAGE_SIZE - 1],
    ]);
  });
  it('has none for a bill whose category cannot be found', async () => {
    const { ctx } = tableClient({ supplier_bill_totals: { rows: [billRow('b1')] }, supplier_bills: { rows: [] }, ...cats });
    expect((await listBills(ctx))[0]).toMatchObject({ category_id: null, category_name: null });
  });
  it('fails like the other reads when the categories cannot be read', async () => {
    const { ctx } = tableClient({ supplier_bill_totals: { rows: [billRow('b1')] }, supplier_bills: { error: { code: 'x' } }, ...cats });
    await expect(listBills(ctx)).rejects.toEqual({ code: 'x' });
    const second = tableClient({
      supplier_bill_totals: { rows: [billRow('b1')] }, supplier_bills: { rows: [{ id: 'b1', category_id: CAT }] }, finance_categories: { error: { code: 'y' } },
    });
    await expect(listBills(second.ctx)).rejects.toEqual({ code: 'y' });
  });
  it('carries the category of one bill', async () => {
    const { ctx, reads } = tableClient({
      supplier_bill_totals: { rows: [billRow(ID, { supplier_ref: null, notes: null })] },
      supplier_bill_lines: { rows: [] },
      supplier_bills: { rows: [{ id: ID, category_id: 'cat-2' }, { id: 'other', category_id: CAT }] },
      ...cats,
    });
    expect(await getBill(ctx, ID)).toMatchObject({ id: ID, category_id: 'cat-2', category_name: 'Utilities' });
    expect(reads.find((r) => r.table === 'supplier_bills')!.eq).toEqual({ org_id: 'org-1', id: ID });
  });
});
