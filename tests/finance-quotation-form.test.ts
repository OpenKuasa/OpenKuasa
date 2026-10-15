import { describe, expect, it } from 'vitest';
import { ringgitFields } from '@/lib/finance/document-currency';
import { documentFormWords, emptyLine } from '@/lib/finance/document-form';
import type { FinanceProduct } from '@/lib/finance/products';
import {
  QUOTATION_FORM_KIND,
  QUOTATION_FORM_WORDS,
  QUOTATION_VALID_DAYS,
  type QuotationForm,
  defaultValidUntil,
  newQuotationForm,
  quotationFormError,
  quotationFormFromDetail,
  quotationPayload,
  quotationSavedNotSent,
  withQuotationCustomer,
  withQuoteDate,
  withQuotedProduct,
  withValidUntil,
} from '@/lib/finance/quotation-form';
import { type QuotationDetail, saveQuotationInput } from '@/lib/finance/quotations';
import { WRITE_FAILED } from '@/lib/finance/result';

const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const today = '2026-10-11';

const gloves: FinanceProduct = {
  id: PRODUCT, sku: 'GLV', name: 'Gloves', type: 'product', category: null, uom: 'box', price: 24.9, cost: 12.5, sst_rate: 6, active: true,
};

/** A form a person has filled in: a customer and one line of 10 × 12.50. */
const filled = (form: Partial<QuotationForm> = {}): QuotationForm => ({
  ...withQuotationCustomer(newQuotationForm(today, 'k1'), { id: CUSTOMER }),
  lines: [{ ...emptyLine('k1'), description: 'Design work', quantity: '10', unit_price: '12.5' }],
  ...form,
});

describe('a new quotation form', () => {
  it('is dated today, valid for thirty days, with one empty line and no customer', () => {
    expect(QUOTATION_VALID_DAYS).toBe(30);
    expect(newQuotationForm(today, 'k1')).toEqual({
      customer_id: '',
      quote_date: '2026-10-11',
      valid_until: '2026-11-10',
      validEdited: false,
      notes: '',
      lines: [emptyLine('k1')],
      fx: ringgitFields(),
    });
    expect(defaultValidUntil('2026-01-31')).toBe('2026-03-02');
  });
  it('rolls over a year end and counts a leap February', () => {
    expect(defaultValidUntil('2026-12-15')).toBe('2027-01-14');
    expect(defaultValidUntil('2028-02-01')).toBe('2028-03-02');
  });
  it('does not move the valid-until date when a customer is chosen, whatever their payment terms', () => {
    const form = newQuotationForm(today, 'k1');
    const chosen = QUOTATION_FORM_KIND.withParty(form, { id: CUSTOMER, payment_terms_days: 90 });
    expect(chosen).toEqual({ ...form, customer_id: CUSTOMER });
  });
});

describe('the valid-until date', () => {
  it('follows the quotation date until it is set by hand', () => {
    const moved = withQuoteDate(newQuotationForm(today, 'k1'), '2026-12-01');
    expect([moved.quote_date, moved.valid_until]).toEqual(['2026-12-01', '2026-12-31']);
    const byHand = withValidUntil(moved, '2026-12-15');
    expect(byHand).toMatchObject({ valid_until: '2026-12-15', validEdited: true });
    expect(withQuoteDate(byHand, '2027-01-05')).toMatchObject({ quote_date: '2027-01-05', valid_until: '2026-12-15' });
  });
  it('stays where it was while the quotation date is half typed or emptied', () => {
    const form = newQuotationForm(today, 'k1');
    expect(withQuoteDate(form, '').valid_until).toBe('2026-11-10');
    expect(withQuoteDate(form, '2026-1').valid_until).toBe('2026-11-10');
    expect(withQuoteDate(form, '2026-02-30').valid_until).toBe('2026-11-10');
  });
  it('is kept as it was saved when a draft is opened, and no longer follows the date', () => {
    const detail: QuotationDetail = {
      id: '33333333-3333-4333-8333-333333333333', quotation_no: null, customer_id: CUSTOMER, customer_name: 'Aisyah Trading',
      quote_date: '2026-10-01', valid_until: '2026-10-08', total: 132.5, display_status: 'draft', accepted_on: null,
      invoice_id: null, invoice_no: null, subtotal: 125, sst: 7.5, notes: null,
      currency: 'MYR', fx_rate: 1, fx_rate_source: null, fx_rate_date: null, total_myr: 132.5,
      lines: [
        { id: 'line-1', product_id: PRODUCT, description: 'Gloves', quantity: 5, uom: 'box', pack_size: 'box of 4', unit_price: 24.9, sst_rate: 6, amount: 124.5, sst_amount: 7.47 },
        { id: 'line-2', product_id: null, description: 'Design work', quantity: 10, uom: null, pack_size: null, unit_price: 12.5, sst_rate: 0, amount: 125, sst_amount: 0 },
      ],
    };
    const form = quotationFormFromDetail(detail);
    expect(form).toEqual({
      id: detail.id, customer_id: CUSTOMER, quote_date: '2026-10-01', valid_until: '2026-10-08', validEdited: true, notes: '',
      lines: [
        { key: 'line-1', product_id: PRODUCT, description: 'Gloves', quantity: '5', uom: 'box', pack_size: 'box of 4', unit_price: '24.9', sst_rate: '6', discount_pct: '', discount_amount: '' },
        { key: 'line-2', product_id: '', description: 'Design work', quantity: '10', uom: '', pack_size: '', unit_price: '12.5', sst_rate: '0', discount_pct: '', discount_amount: '' },
      ],
      fx: ringgitFields(),
    });
    expect(withQuoteDate(form, '2026-10-05').valid_until).toBe('2026-10-08');
  });
});

describe('what the quotation form sends', () => {
  it('is what saveQuotationInput takes, with figures as numbers and the id only when a draft is being changed', () => {
    expect(quotationPayload(filled({ notes: ' Valid 30 days ' }))).toEqual({
      customer_id: CUSTOMER,
      quote_date: '2026-10-11',
      valid_until: '2026-11-10',
      notes: ' Valid 30 days ',
      lines: [{ product_id: '', description: 'Design work', uom: '', pack_size: '', quantity: 10, unit_price: 12.5, sst_rate: 0 }],
      // A ringgit quotation sends its code; the database stores rate 1 for it.
      currency: 'MYR',
      fx_rate: null,
      fx_rate_source: null,
      fx_rate_date: null,
    });
    expect(quotationPayload(filled())).not.toHaveProperty('id');
    expect(quotationPayload(filled({ id: 'abc' }))).toMatchObject({ id: 'abc' });
    expect(saveQuotationInput.safeParse(quotationPayload(filled())).success).toBe(true);
  });
  it('never sends what only the form knows: whether the date was set by hand, and each line’s key', () => {
    const sent = JSON.stringify(quotationPayload(filled()));
    expect(sent).not.toContain('validEdited');
    expect(sent).not.toContain('"key"');
  });
  it('fills a line from a product at its price, not its cost', () => {
    expect(withQuotedProduct(emptyLine('k1'), gloves)).toMatchObject({
      product_id: PRODUCT, description: 'Gloves', uom: 'box', unit_price: '24.9', sst_rate: '6', quantity: '1',
    });
    expect(withQuotedProduct({ ...emptyLine('k1'), product_id: PRODUCT, description: 'Gloves' }, null)).toMatchObject({
      product_id: '', description: 'Gloves',
    });
  });
});

describe('what is wrong with a quotation form', () => {
  it('says so in the schema’s own sentences, the first thing first', () => {
    expect(quotationFormError(filled())).toBeNull();
    expect(quotationFormError(filled({ customer_id: '' }))).toBe('Choose a customer.');
    expect(quotationFormError(filled({ quote_date: '' }))).toBe('Enter a valid date.');
    expect(quotationFormError(filled({ valid_until: '2026-10-10' }))).toBe('The valid-until date cannot be before the quotation date.');
    expect(quotationFormError(filled({ lines: [] }))).toBe('Add at least one line.');
    expect(quotationFormError(filled({ lines: [{ ...emptyLine('k1'), quantity: '1', unit_price: '5' }] }))).toBe('Describe each line.');
    expect(quotationFormError(filled({ notes: 'x'.repeat(201) }))).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('refuses a figure typed with a comma, an empty price and a quantity of nothing', () => {
    const line = (l: Partial<ReturnType<typeof emptyLine>>) => filled({ lines: [{ ...emptyLine('k1'), description: 'Design work', ...l }] });
    expect(quotationFormError(line({ quantity: '1', unit_price: '1,200.50' }))).toBe('Enter a unit price of 0 or more.');
    expect(quotationFormError(line({ quantity: '1', unit_price: '' }))).toBe('Enter a unit price of 0 or more.');
    expect(quotationFormError(line({ quantity: '0', unit_price: '5' }))).toBe('Enter a quantity above 0.');
    expect(quotationFormError(line({ quantity: '1', unit_price: '5', sst_rate: '101' }))).toBe('Enter an SST rate between 0 and 100.');
  });
  it('lets a draft total nothing, but not a quotation that is being marked as sent', () => {
    const free = filled({ lines: [{ ...emptyLine('k1'), description: 'Sample pack', quantity: '1', unit_price: '0' }] });
    expect(quotationFormError(free)).toBeNull();
    expect(quotationFormError(free, true)).toBe('A quotation needs at least one line with an amount.');
    expect(quotationFormError(filled(), true)).toBeNull();
  });
  it('accepts a quotation valid only on its own date', () => {
    expect(quotationFormError(filled({ valid_until: today }))).toBeNull();
  });
});

describe('saved, but not marked as sent', () => {
  it('says the draft is safe and passes on the database’s sentence', () => {
    expect(quotationSavedNotSent('A quotation needs at least one line with an amount.')).toBe(
      'The quotation was saved as a draft, but it was not marked as sent. A quotation needs at least one line with an amount.',
    );
  });
  it('does not say "could not be saved" about a quotation that was saved', () => {
    expect(quotationSavedNotSent(WRITE_FAILED)).toBe('The quotation was saved as a draft, but marking it as sent failed. Please try again.');
  });
});

describe('the quotation form, as the shared card draws it', () => {
  it('is the quotation form’s own rules, not a second set', () => {
    expect(QUOTATION_FORM_KIND.withParty).toBe(withQuotationCustomer);
    expect(QUOTATION_FORM_KIND.withDate).toBe(withQuoteDate);
    expect(QUOTATION_FORM_KIND.withProduct).toBe(withQuotedProduct);
    expect(QUOTATION_FORM_KIND.error).toBe(quotationFormError);
    expect(QUOTATION_FORM_KIND.payload).toBe(quotationPayload);
    expect(QUOTATION_FORM_KIND.savedNotPosted).toBe(quotationSavedNotSent);
    expect(QUOTATION_FORM_KIND.secondDate.set).toBe(withValidUntil);
    expect(QUOTATION_FORM_KIND.reference).toBeUndefined();
  });
  it('says customer and quotation, and calls its second date Valid until', () => {
    expect([QUOTATION_FORM_KIND.noun, QUOTATION_FORM_KIND.party, QUOTATION_FORM_KIND.dateLabel]).toEqual([
      'quotation', 'customer', 'Quotation date',
    ]);
    expect(QUOTATION_FORM_KIND.secondDate.label).toBe('Valid until');
    expect(QUOTATION_FORM_KIND.partyId(filled())).toBe(CUSTOMER);
    expect(QUOTATION_FORM_KIND.date(filled())).toBe(today);
    expect(QUOTATION_FORM_KIND.secondDate.get(filled())).toBe('2026-11-10');
  });
  it('is marked as sent, never posted, in every word the card shows', () => {
    const words = documentFormWords(QUOTATION_FORM_KIND);
    expect(words).toBe(QUOTATION_FORM_WORDS);
    expect(words).toEqual({
      newSubtitle: 'Saved as a draft until it is marked as sent',
      draftSubtitle: 'A draft: it gets its number when it is marked as sent',
      post: 'Save and mark as sent',
      posting: 'Marking as sent…',
    });
    expect(Object.values(words).join(' ').toLowerCase()).not.toContain('post');
  });
  it('ignores the customer’s payment terms when the date changes', () => {
    expect(QUOTATION_FORM_KIND.withDate(newQuotationForm(today, 'k1'), '2026-12-01', 90).valid_until).toBe('2026-12-31');
  });
});
