import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContactInput, updateContactInput } from '@/lib/finance/contacts';
import { emptyLine } from '@/lib/finance/document-form';
import { newQuotationForm, quotationFormError, quotationPayload, withQuotationCustomer } from '@/lib/finance/quotation-form';
import { type QuotationListRow, convertQuotation, saveQuotation, saveQuotationInput, sendQuotation } from '@/lib/finance/quotations';
import { quotationActions, quotationsCsv, quotationsHaveForeign, quotationsView } from '@/lib/finance/sales-followon-views';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const line = { description: 'Design work', quantity: 10, unit_price: 12.5 };
const valid = { customer_id: CUSTOMER, quote_date: '2026-10-01', valid_until: '2026-10-31', lines: [line] };
const first = (value: unknown) => saveQuotationInput.safeParse(value).error?.issues[0]?.message;

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

describe('saveQuotationInput, with a currency', () => {
  it('takes no currency at all, as the finance assistant sends it: nothing is defaulted, so a draft keeps its own', () => {
    const parsed = saveQuotationInput.parse(valid);
    expect(parsed).not.toHaveProperty('currency');
    expect(parsed).not.toHaveProperty('fx_rate');
  });

  it('takes a currency from the list, a rate above 0 or none, and where the rate came from', () => {
    expect(first({ ...valid, currency: 'USD', fx_rate: 4.0815, fx_rate_source: 'bnm', fx_rate_date: '2026-10-15' })).toBeUndefined();
    expect(first({ ...valid, currency: 'USD', fx_rate: null, fx_rate_source: null, fx_rate_date: null })).toBeUndefined();
    expect(first({ ...valid, currency: 'KWD' })).toBe('Choose a currency.');
    expect(first({ ...valid, currency: 'usd' })).toBe('Choose a currency.');
    // The form sends the rate as exact text.
    expect(first({ ...valid, currency: 'USD', fx_rate: '4.0123456789' })).toBeUndefined();
    for (const bad of ['0', '0.0', 'abc', '1e3', '-1', '4.', '12345678901']) {
      expect(first({ ...valid, currency: 'USD', fx_rate: bad }), bad).toBe('Enter the exchange rate as a number above 0, such as 4.0815.');
    }
    expect(first({ ...valid, currency: 'USD', fx_rate: 0 })).toBe('Enter the exchange rate as a number above 0, such as 4.0815.');
    expect(first({ ...valid, currency: 'USD', fx_rate: Number.NaN })).toBe('Enter the exchange rate as a number above 0, such as 4.0815.');
    expect(first({ ...valid, currency: 'USD', fx_rate: 4, fx_rate_source: 'guess' })).toBe('Enter the exchange rate as a number above 0, such as 4.0815.');
  });

  it('refuses cents in a currency that has none', () => {
    expect(first({ ...valid, currency: 'JPY', lines: [{ ...line, unit_price: 1500 }] })).toBeUndefined();
    expect(first({ ...valid, currency: 'JPY' })).toBe('JPY has no cents: enter whole amounts.');
  });
});

describe('the database’s answers', () => {
  it('turns FIN38, FIN39 and FIN40 into sentences', async () => {
    const answer = async (code: string) => {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      return [await saveQuotation(ctx, valid), await sendQuotation(ctx, { id: ID }), await convertQuotation(ctx, { id: ID, invoice_date: '2026-10-12' })];
    };
    for (const result of await answer('FIN38')) {
      expect(result).toEqual({ ok: false, error: 'Enter the exchange rate before marking it as sent.' });
    }
    for (const result of await answer('FIN39')) {
      expect(result).toEqual({
        ok: false,
        error: "That rate is not the one Bank Negara Malaysia published for that day. Type it in again and save; it is kept as typed by hand.",
      });
    }
    for (const result of await answer('FIN40')) {
      expect(result).toEqual({
        ok: false,
        error: 'This quotation is not in ringgit, and invoices in other currencies are not available yet. Make the invoice in ringgit on Invoices instead.',
      });
    }
  });
});

describe('the form', () => {
  it('takes the customer’s default currency on a new quotation, and sends it', () => {
    const form = withQuotationCustomer(newQuotationForm('2026-10-15', 'k1'), { id: CUSTOMER, default_currency: 'SGD' });
    expect(form.fx.currency).toBe('SGD');
    expect(quotationPayload(form)).toMatchObject({ currency: 'SGD', fx_rate: null, fx_rate_source: null, fx_rate_date: null });
  });

  it('may be saved with no rate, and not marked as sent without one', () => {
    const form = {
      ...withQuotationCustomer(newQuotationForm('2026-10-15', 'k1'), { id: CUSTOMER, default_currency: 'SGD' }),
      lines: [{ ...emptyLine('k1'), description: 'Design work', quantity: '1', unit_price: '100' }],
    };
    expect(quotationFormError(form)).toBeNull();
    expect(quotationFormError(form, true)).toBe('Enter the exchange rate before marking it as sent.');
  });
});

const row = (q: Partial<QuotationListRow>): QuotationListRow => ({
  id: 'q',
  quotation_no: 'QT-0001',
  customer_id: 'c',
  customer_name: 'Acme Pte Ltd',
  quote_date: '2026-10-01',
  valid_until: '2026-10-31',
  total: 1000,
  display_status: 'sent',
  accepted_on: null,
  invoice_id: null,
  invoice_no: null,
  currency: 'MYR',
  fx_rate: 1,
  fx_rate_source: null,
  fx_rate_date: null,
  total_myr: 1000,
  ...q,
});

describe('the list', () => {
  it('adds quotations up in ringgit: a USD one at its rate, a draft with no rate as nothing', () => {
    const rows = [
      row({ id: 'a', total: 1000, total_myr: 1000 }),
      row({ id: 'b', total: 1000, currency: 'USD', fx_rate: 4.0815, fx_rate_source: 'bnm', fx_rate_date: '2026-09-30', total_myr: 4081.5 }),
      row({ id: 'c', display_status: 'draft', quotation_no: null, total: 500, currency: 'USD', fx_rate: null, total_myr: null }),
    ];
    const view = quotationsView(rows, '2026-10-15');
    expect(view.stats.find((s) => s.label === 'Open quotes')?.value).toBe('RM 5,082');
    expect(view.stats.find((s) => s.label === 'Pipeline value')?.value).toBe('RM 5,082');
  });

  it('does not offer "Make invoice" for an accepted quotation in another currency', () => {
    expect(quotationActions(row({ display_status: 'accepted' }))).toEqual(['convert', 'decline']);
    expect(quotationActions(row({ display_status: 'accepted', currency: 'USD', fx_rate: 4.08, fx_rate_source: 'manual' }))).toEqual(['decline']);
  });

  it('exports as before for a ringgit-only workspace, and with currency columns once one is foreign', () => {
    const ringgit = [row({})];
    expect(quotationsHaveForeign(ringgit)).toBe(false);
    expect(quotationsCsv(ringgit).replace(/^\uFEFF/, '').split(/\r?\n/)[0]).toBe('No.,Date,Customer,Total,Valid until,Status,Invoice');
    const mixed = [...ringgit, row({ id: 'b', currency: 'USD', fx_rate: 4.1, fx_rate_source: 'manual', total_myr: 4100 })];
    const csv = quotationsCsv(mixed).replace(/^\uFEFF/, '').split(/\r?\n/);
    expect(csv[0]).toBe('No.,Date,Customer,Total,Valid until,Status,Invoice,Currency,Rate (RM per unit),Total (RM),Rate typed by hand');
    expect(csv[2]).toContain(',USD,4.1,4100,yes');
  });
});

describe('a contact’s default currency', () => {
  it('is none unless chosen, and is left alone by an update that does not name it', () => {
    expect(createContactInput.parse({ name: 'Acme', is_customer: true, is_supplier: false }).default_currency).toBeNull();
    expect(createContactInput.parse({ name: 'Acme', is_customer: true, is_supplier: false, default_currency: 'SGD' }).default_currency).toBe('SGD');
    expect(updateContactInput.parse({ id: ID, name: 'Acme' })).not.toHaveProperty('default_currency');
    expect(updateContactInput.parse({ id: ID, default_currency: null }).default_currency).toBeNull();
    expect(createContactInput.safeParse({ name: 'Acme', is_customer: true, is_supplier: false, default_currency: 'KWD' }).error?.issues[0]?.message).toBe(
      'Choose a currency from the list, or none.',
    );
  });
});
