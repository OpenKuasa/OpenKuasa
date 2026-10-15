import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUOTATION_PAGE_SIZE,
  acceptQuotation,
  convertQuotation,
  convertQuotationInput,
  declineQuotation,
  deleteQuotation,
  getQuotation,
  listQuotations,
  saveQuotation,
  saveQuotationInput,
  sendQuotation,
} from '@/lib/finance/quotations';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const INVOICE = '55555555-5555-4555-8555-555555555555';
/** What "Make invoice" sends: the quotation, and the date on the person's own calendar. */
const CONVERT = { id: ID, invoice_date: '2026-10-12' };

const line = { description: 'Design work', quantity: 10, unit_price: 12.5 };
const valid = { customer_id: CUSTOMER, quote_date: '2026-10-01', valid_until: '2026-10-31', lines: [line] };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveQuotationInput.safeParse(value).error?.issues[0]?.message;

describe('saveQuotationInput', () => {
  it('asks for a customer', () => {
    expect(first({ ...valid, customer_id: '' })).toBe('Choose a customer.');
    expect(first({ ...valid, customer_id: undefined })).toBe('Choose a customer.');
  });
  it('asks for real dates, with the valid-until date not before the quotation date', () => {
    expect(first({ ...valid, quote_date: '01/10/2026' })).toBe('Enter a valid date.');
    expect(first({ ...valid, valid_until: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, valid_until: '2026-09-30' })).toBe('The valid-until date cannot be before the quotation date.');
    expect(first({ ...valid, valid_until: '2026-10-01' })).toBeUndefined();
  });
  it('asks for at least one line, and not more than 100, with the sentences an invoice line uses', () => {
    expect(first({ ...valid, lines: [] })).toBe('Add at least one line.');
    expect(first({ ...valid, lines: Array.from({ length: 101 }, () => line) })).toBe('A quotation can have at most 100 lines.');
    expect(first({ ...valid, lines: [{ ...line, description: '  ' }] })).toBe('Describe each line.');
    expect(first({ ...valid, lines: [{ ...line, quantity: 0.0004 }] })).toBe('Enter a quantity above 0.');
    expect(first({ ...valid, lines: [{ ...line, sst_rate: 100.005 }] })).toBe('Enter an SST rate between 0 and 100.');
  });
  it('has no place for a number, a status or the date it was accepted: the database gives those', () => {
    const parsed = saveQuotationInput.parse({ ...valid, notes: '  ', quotation_no: 'QT-9999', status: 'accepted', accepted_at: '2026-10-02' });
    expect(Object.keys(parsed).sort()).toEqual(['customer_id', 'lines', 'notes', 'quote_date', 'valid_until']);
    expect(parsed.notes).toBeNull();
  });
});

describe('quotation reads', () => {
  const row = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `qt-${n}`, quotation_no: `QT-${n}`, customer_id: 'c1', customer_name: 'Aisyah Trading',
    quote_date: '2026-10-01', valid_until: '2026-10-31', total: '132.50', display_status: 'sent',
    accepted_at: null, invoice_id: null, invoice_no: null, ...extra,
  });
  /** The row as the data layer hands it on: `accepted_at` becomes the date `accepted_on`. */
  const read = (n: number, extra: Record<string, unknown> = {}) => {
    const rest: Record<string, unknown> = { ...row(n) };
    delete rest.accepted_at;
    return { ...rest, total: 132.5, accepted_on: null, ...extra };
  };

  it('lists from the totals view, in the caller’s workspace, newest first, with the total as a number', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1)], error: null });
    expect(await listQuotations(ctx)).toEqual([read(1)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_quotation_totals',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['quote_date desc', 'id asc'],
      range: [0, QUOTATION_PAGE_SIZE - 1],
    });
  });
  it('gives the day a quotation was accepted as a UTC date, and the invoice made from it', async () => {
    const accepted = row(2, { display_status: 'accepted', accepted_at: '2026-10-08T23:30:00+00:00', invoice_id: INVOICE, invoice_no: null });
    const { ctx } = fakeFinance({ data: [accepted], error: null });
    expect(await listQuotations(ctx)).toEqual([
      read(2, { display_status: 'accepted', accepted_on: '2026-10-08', invoice_id: INVOICE, invoice_no: null }),
    ]);
  });
  it('reads on past a full page, so a long book is never cut short', async () => {
    const full = Array.from({ length: QUOTATION_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listQuotations(ctx)).toHaveLength(QUOTATION_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([[0, QUOTATION_PAGE_SIZE - 1], [QUOTATION_PAGE_SIZE, 2 * QUOTATION_PAGE_SIZE - 1]]);
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listQuotations(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
  it('reads one quotation with its lines in the order they were entered', async () => {
    const lines = [
      { id: 'l1', product_id: null, description: 'Design work', quantity: '10.000', uom: null, pack_size: null, unit_price: '12.5000', sst_rate: '6.00', amount: '125.00', sst_amount: '7.50' },
    ];
    const { ctx, calls } = fakeFinance((call) =>
      call.name === 'finance_quotation_totals'
        ? { data: { ...row(1), subtotal: '125.00', sst: '7.50', notes: 'Valid for 30 days' }, error: null }
        : { data: lines, error: null },
    );
    const quotation = await getQuotation(ctx, ID);
    expect(quotation).toEqual({
      ...read(1), subtotal: 125, sst: 7.5, notes: 'Valid for 30 days',
      lines: [{ ...lines[0], quantity: 10, unit_price: 12.5, sst_rate: 6, amount: 125, sst_amount: 7.5 }],
    });
    expect(calls[0].filters).toEqual({ org_id: 'org-1', id: ID });
    expect(calls[1]).toMatchObject({ name: 'finance_quotation_lines', filters: { org_id: 'org-1', quotation_id: ID }, order: ['position asc', 'id asc'] });
  });
  it('answers null for a quotation that is not there, and for an id that is not an id, without asking the database', async () => {
    const missing = fakeFinance({ data: null, error: null });
    expect(await getQuotation(missing.ctx, ID)).toBeNull();
    const bad = fakeFinance({ data: null, error: null });
    expect(await getQuotation(bad.ctx, 'nope')).toBeNull();
    expect(bad.calls).toEqual([]);
  });
});

describe('quotation writes', () => {
  it('saves through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    expect(await saveQuotation(ctx, { ...valid, id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_quotation' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      quotation: { id: ID, customer_id: CUSTOMER, quote_date: '2026-10-01', valid_until: '2026-10-31', notes: null },
      lines: [{ product_id: null, description: 'Design work', quantity: 10, uom: null, pack_size: null, unit_price: 12.5, sst_rate: 0, discount_pct: null, discount_amount: null }],
    });
  });
  it('sends and returns the number', async () => {
    const { ctx, calls } = fakeFinance({ data: 'QT-0007', error: null });
    expect(await sendQuotation(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, quotation_no: 'QT-0007' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_send_quotation' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_quotation: ID });
  });
  it('records a yes with the moment it was given, and a no with none', async () => {
    const yes = fakeFinance({ data: { id: ID }, error: null });
    expect(await acceptQuotation(yes.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(yes.calls[0]).toMatchObject({ name: 'finance_quotations', op: 'update', filters: { id: ID, org_id: 'org-1' } });
    expect(Object.keys(yes.calls[0].values!).sort()).toEqual(['accepted_at', 'status', 'updated_at']);
    expect(yes.calls[0].values).toMatchObject({ status: 'accepted' });
    expect(yes.calls[0].values!.accepted_at).toBe(yes.calls[0].values!.updated_at);
    expect(String(yes.calls[0].values!.accepted_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const no = fakeFinance({ data: { id: ID }, error: null });
    expect(await declineQuotation(no.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(no.calls[0].values).toMatchObject({ status: 'declined', accepted_at: null });
  });
  it('deletes a draft, scoped to the workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await deleteQuotation(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ name: 'finance_quotations', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('converts through the database function, handing it the person’s date, and answers with the new invoice', async () => {
    const { ctx, calls } = fakeFinance({ data: INVOICE, error: null });
    expect(await convertQuotation(ctx, CONVERT)).toEqual({ ok: true, data: { id: ID, invoice_id: INVOICE } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_convert_quotation' });
    // The date is the person's, not the database's: before 08:00 in Malaysia the database is still on the day before.
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_quotation: ID, invoice_date: '2026-10-12' });
  });
  it('asks a conversion for a quotation and a real date', () => {
    const said = (value: unknown) => convertQuotationInput.safeParse(value).error?.issues[0]?.message;
    expect(said(CONVERT)).toBeUndefined();
    expect(said({ id: 'nope', invoice_date: '2026-10-12' })).toBe('That quotation no longer exists.');
    // Both wrong: the quotation is named first.
    expect(said({ id: 'nope' })).toBe('That quotation no longer exists.');
    for (const invoice_date of [undefined, null, '', '12/10/2026', '2026-02-30', '2026-10-12T08:00:00+08:00', 20261012]) {
      expect(said({ id: ID, invoice_date }), String(invoice_date)).toBe('Enter a valid date.');
    }
    // Nothing else is taken from the input.
    expect(convertQuotationInput.parse({ ...CONVERT, due_date: '2026-10-13', target_org: 'someone-else' })).toEqual(CONVERT);
  });
  it('words FIN01 so that it reads sensibly from every button that can meet it, and claims nothing false (FIN01)', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN01' } });
    const sentence =
      'That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.';
    // Through the app it is met only when the quotation changed in another tab: Save, Mark as sent or Delete
    // on a draft that has been sent meanwhile; Mark accepted on one already accepted; Mark declined on one
    // already declined. Only a direct call can answer a draft, and the sentence is not false of that either.
    for (const result of [
      await saveQuotation(ctx, { ...valid, id: ID }),
      await sendQuotation(ctx, { id: ID }),
      await acceptQuotation(ctx, { id: ID }),
      await declineQuotation(ctx, { id: ID }),
      await deleteQuotation(ctx, { id: ID }),
    ]) {
      expect(result).toEqual({ ok: false, error: sentence });
    }
    // It does not say what happened, only what may have: a draft answered by a direct call was never sent.
    expect(sentence).not.toContain('already been sent or answered');
    expect(sentence).not.toContain('has been sent');
    // It does not tell a person looking at an accepted quotation to send a draft.
    expect(sentence).not.toContain('Send a draft');
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.'],
      ['FIN04', 'Only an accepted quotation can be made into an invoice.'],
      ['FIN10', 'A quotation needs at least one line with an amount.'],
      ['FIN11', 'That quotation no longer exists.'],
      ['FIN13', 'This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first.'],
      ['23505', 'That quotation number is already used.'],
      ['23503', 'The customer or a product on this quotation no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await saveQuotation(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await sendQuotation(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await acceptQuotation(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await declineQuotation(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deleteQuotation(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      if (code !== '23505') expect(await convertQuotation(ctx, CONVERT), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('words two conversions at the same moment as the quotation having an invoice, not as a number being used', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: '23505' } });
    expect(await convertQuotation(ctx, CONVERT)).toEqual({
      ok: false,
      error: 'This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first.',
    });
  });
  it('says the quotation is gone when an answer or a delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    for (const write of [acceptQuotation, declineQuotation, deleteQuotation]) {
      expect(await write(ctx, { id: ID })).toEqual({ ok: false, error: 'That quotation no longer exists.' });
    }
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await saveQuotation(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});
