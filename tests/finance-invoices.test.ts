import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INVOICE_PAGE_SIZE,
  deleteInvoice,
  getInvoice,
  listInvoices,
  postInvoice,
  saveInvoice,
  saveInvoiceInput,
  voidInvoice,
} from '@/lib/finance/invoices';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';

const line = { description: 'Design work', quantity: 10, unit_price: 12.5 };
const valid = { customer_id: CUSTOMER, invoice_date: '2026-10-01', due_date: '2026-10-31', lines: [line] };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveInvoiceInput.safeParse(value).error?.issues[0]?.message;

describe('saveInvoiceInput', () => {
  it('asks for a customer', () => {
    expect(first({ ...valid, customer_id: '' })).toBe('Choose a customer.');
    expect(first({ ...valid, customer_id: undefined })).toBe('Choose a customer.');
  });
  it('asks for real dates, with the due date not before the invoice date', () => {
    expect(first({ ...valid, invoice_date: '01/10/2026' })).toBe('Enter a valid date.');
    expect(first({ ...valid, invoice_date: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, due_date: '2026-09-30' })).toBe('The due date cannot be before the invoice date.');
    expect(first({ ...valid, due_date: '2026-10-01' })).toBeUndefined();
  });
  it('asks for at least one line, and not more than 100', () => {
    expect(first({ ...valid, lines: [] })).toBe('Add at least one line.');
    expect(first({ ...valid, lines: Array.from({ length: 101 }, () => line) })).toBe('An invoice can have at most 100 lines.');
  });
  it('checks each line with the sentences a bill line uses', () => {
    expect(first({ ...valid, lines: [{ ...line, description: '  ' }] })).toBe('Describe each line.');
    expect(first({ ...valid, lines: [{ ...line, quantity: 0 }] })).toBe('Enter a quantity above 0.');
    expect(first({ ...valid, lines: [{ ...line, quantity: 0.0004 }] })).toBe('Enter a quantity above 0.');
    expect(first({ ...valid, lines: [{ ...line, unit_price: -1 }] })).toBe('Enter a unit price of 0 or more.');
    expect(first({ ...valid, lines: [{ ...line, sst_rate: 100.005 }] })).toBe('Enter an SST rate between 0 and 100.');
    expect(first({ ...valid, lines: [{ ...line, product_id: 'ink' }] })).toBe('Choose a product from the list, or leave it empty.');
  });
  it('rounds first, then checks: quantities to 3 decimals, prices to 4, the SST rate to 2; empties become null', () => {
    const parsed = saveInvoiceInput.parse({
      ...valid,
      notes: '  ',
      lines: [{ description: ' Design work ', quantity: 1.23456, unit_price: 0.123456, sst_rate: 1.005, uom: '', product_id: '' }],
    });
    expect(parsed.notes).toBeNull();
    expect(parsed.lines[0]).toEqual({
      product_id: null, description: 'Design work', quantity: 1.235, uom: null, pack_size: null, unit_price: 0.1235, sst_rate: 1.01, discount_pct: null, discount_amount: null,
    });
    expect(saveInvoiceInput.parse({ ...valid, lines: [{ ...line, quantity: 0.0005 }] }).lines[0].quantity).toBe(0.001);
  });
  it('has no place for an invoice number, a status or an e-Invois status: the database gives those', () => {
    const parsed = saveInvoiceInput.parse({ ...valid, invoice_no: 'INV-9999', status: 'posted', einvoice_status: 'validated' });
    expect(Object.keys(parsed).sort()).toEqual(['customer_id', 'due_date', 'invoice_date', 'lines', 'notes']);
  });
});

describe('invoice reads', () => {
  const row = (n: number) => ({
    id: `inv-${n}`, invoice_no: `INV-${n}`, customer_id: 'c1', customer_name: 'Aisyah Trading',
    invoice_date: '2026-10-01', due_date: '2026-10-31', total: '132.50', paid: '100.00', credited: '20.00', refunded: '0.00',
    balance: '12.50', display_status: 'sent', einvoice_status: 'none', einvoice_uuid: null,
  });

  it('lists from the totals view, in the caller’s workspace, newest first, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1)], error: null });
    expect(await listInvoices(ctx)).toEqual([{ ...row(1), total: 132.5, paid: 100, credited: 20, refunded: 0, balance: 12.5 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_invoice_totals',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['invoice_date desc', 'id asc'],
      range: [0, INVOICE_PAGE_SIZE - 1],
    });
    expect(calls[0].columns).toContain('einvoice_status');
    expect(calls[0].columns).toContain('einvoice_uuid');
    expect(calls[0].columns).toContain('credited');
    expect(calls[0].columns).toContain('refunded');
  });
  it('reads a customer in credit as a balance below zero', async () => {
    const inCredit = { ...row(2), paid: '132.50', credited: '30.00', refunded: '10.00', balance: '-20.00', display_status: 'paid' };
    const { ctx } = fakeFinance({ data: [inCredit], error: null });
    expect(await listInvoices(ctx)).toMatchObject([{ paid: 132.5, credited: 30, refunded: 10, balance: -20, display_status: 'paid' }]);
  });
  it('reads on past a full page, so a long book is never cut short', async () => {
    const full = Array.from({ length: INVOICE_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listInvoices(ctx)).toHaveLength(INVOICE_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([[0, INVOICE_PAGE_SIZE - 1], [INVOICE_PAGE_SIZE, 2 * INVOICE_PAGE_SIZE - 1]]);
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listInvoices(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
  it('reads one invoice with its lines in the order they were entered', async () => {
    const lines = [
      { id: 'l1', product_id: null, description: 'Design work', quantity: '10.000', uom: null, pack_size: null, unit_price: '12.5000', sst_rate: '6.00', amount: '125.00', sst_amount: '7.50' },
    ];
    const { ctx, calls } = fakeFinance((call) =>
      call.name === 'finance_invoice_totals'
        ? { data: { ...row(1), subtotal: '125.00', sst: '7.50', notes: null, einvoice_uuid: null }, error: null }
        : { data: lines, error: null },
    );
    const invoice = await getInvoice(ctx, ID);
    expect(invoice).toMatchObject({ id: 'inv-1', total: 132.5, subtotal: 125, sst: 7.5, notes: null, einvoice_uuid: null });
    expect(invoice?.lines).toEqual([{ ...lines[0], quantity: 10, unit_price: 12.5, sst_rate: 6, amount: 125, sst_amount: 7.5 }]);
    expect(calls[0].filters).toEqual({ org_id: 'org-1', id: ID });
    expect(calls[1]).toMatchObject({ name: 'finance_invoice_lines', filters: { org_id: 'org-1', invoice_id: ID }, order: ['position asc', 'id asc'] });
  });
  it('answers null for an invoice that is not there, and for an id that is not an id, without asking the database', async () => {
    const missing = fakeFinance({ data: null, error: null });
    expect(await getInvoice(missing.ctx, ID)).toBeNull();
    const bad = fakeFinance({ data: null, error: null });
    expect(await getInvoice(bad.ctx, 'nope')).toBeNull();
    expect(bad.calls).toEqual([]);
  });
});

describe('invoice writes', () => {
  it('saves through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    expect(await saveInvoice(ctx, { ...valid, id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_invoice' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      invoice: { id: ID, customer_id: CUSTOMER, invoice_date: '2026-10-01', due_date: '2026-10-31', notes: null },
      lines: [{ product_id: null, description: 'Design work', quantity: 10, uom: null, pack_size: null, unit_price: 12.5, sst_rate: 0, discount_pct: null, discount_amount: null }],
    });
  });
  it('posts and returns the number', async () => {
    const { ctx, calls } = fakeFinance({ data: 'INV-0007', error: null });
    expect(await postInvoice(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, invoice_no: 'INV-0007' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_post_invoice' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_invoice: ID });
  });
  it('voids by setting the status and deletes a draft, both scoped to the workspace', async () => {
    const voided = fakeFinance({ data: { id: ID }, error: null });
    expect(await voidInvoice(voided.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(voided.calls[0]).toMatchObject({ name: 'finance_invoices', op: 'update', filters: { id: ID, org_id: 'org-1' } });
    expect(voided.calls[0].values).toMatchObject({ status: 'void' });
    expect(Object.keys(voided.calls[0].values!).sort()).toEqual(['status', 'updated_at']);

    const removed = fakeFinance({ data: { id: ID }, error: null });
    expect(await deleteInvoice(removed.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(removed.calls[0]).toMatchObject({ name: 'finance_invoices', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'This invoice has been posted or voided, so that can no longer be done.'],
      ['FIN02', 'This invoice has payments or refunds. Void the payments on Payments In, and void or delete the refunds on Refunds, before voiding it.'],
      ['FIN12', 'This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it.'],
      ['FIN10', 'An invoice needs at least one line with an amount.'],
      ['FIN11', 'That invoice no longer exists.'],
      ['FIN14', 'Only an owner or admin can post, pay or void. Ask one of them to do this.'],
      ['23505', 'That invoice number is already used.'],
      ['23503', 'The customer or a product on this invoice no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await saveInvoice(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await postInvoice(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await voidInvoice(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deleteInvoice(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says the invoice is gone when void or delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    expect(await voidInvoice(ctx, { id: ID })).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(await deleteInvoice(ctx, { id: ID })).toEqual({ ok: false, error: 'That invoice no longer exists.' });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await saveInvoice(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});
