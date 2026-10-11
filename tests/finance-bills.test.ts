import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinanceWriteContext } from '@/lib/finance/result';
import { deleteBill, postBill, saveBill, saveBillInput, voidBill } from '@/lib/finance/bills';

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
