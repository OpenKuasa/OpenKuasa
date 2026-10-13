import { describe, expect, it } from 'vitest';
import { documentFormWords, emptyLine } from '@/lib/finance/document-form';
import type { FinanceProduct } from '@/lib/finance/products';
import {
  RFQ_FORM_KIND,
  type RfqForm,
  newRfqForm,
  priceDrafts,
  quoteFormError,
  quotePayload,
  rfqFormAfterRefusal,
  rfqFormCopiedFrom,
  rfqFormError,
  rfqFormFromDetail,
  rfqPayload,
  rfqSavedNotSent,
  withRfqProduct,
} from '@/lib/finance/rfq-form';
import { RFQ_MESSAGES, type RfqDetail, quoteRfqInput, saveRfqInput } from '@/lib/finance/rfqs';
import { WRITE_FAILED } from '@/lib/finance/result';

const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const RFQ = '33333333-3333-4333-8333-333333333333';
const LINE_1 = '66666666-6666-4666-8666-666666666661';
const LINE_2 = '66666666-6666-4666-8666-666666666662';
const today = '2026-10-11';

const paper: FinanceProduct = {
  id: PRODUCT, sku: 'PPR', name: 'Printer paper', type: 'product', category: null, uom: 'ream', price: 24.9, cost: 12.5, sst_rate: 6, active: true,
};

/** A form a person has filled in: a supplier and one line of 10, no price yet. */
const filled = (form: Partial<RfqForm> = {}): RfqForm => ({
  ...RFQ_FORM_KIND.withParty(newRfqForm(today, 'k1'), { id: SUPPLIER, payment_terms_days: 30 }),
  lines: [{ ...emptyLine('k1'), description: 'Printer paper', quantity: '10' }],
  ...form,
});

describe('a new RFQ form', () => {
  it('is dated today, with no reply-by date, no supplier and one empty line', () => {
    expect(newRfqForm(today, 'k1')).toEqual({
      supplier_id: '', rfq_date: today, reply_by: '', notes: '', lines: [emptyLine('k1')],
    });
  });
  it('does not move the reply-by date when the RFQ date changes', () => {
    const form = RFQ_FORM_KIND.secondDate.set(newRfqForm(today, 'k1'), '2026-10-20');
    expect(RFQ_FORM_KIND.withDate(form, '2026-10-15', 30)).toMatchObject({ rfq_date: '2026-10-15', reply_by: '2026-10-20' });
  });
});

describe('a saved draft, as the form shows it', () => {
  it('shows a missing price as an empty box and a price of 0 as 0', () => {
    const detail: RfqDetail = {
      id: RFQ, rfq_no: null, supplier_id: SUPPLIER, supplier_name: 'Syarikat Kertas', rfq_date: '2026-10-01', reply_by: null,
      supplier_ref: null, status: 'draft', line_count: 2, total: 0, purchase_order_id: null, purchase_order_no: null, source_rfq_id: null,
      subtotal: 0, sst_total: 0, notes: null, quoted_at: null,
      lines: [
        { id: LINE_1, product_id: PRODUCT, description: 'Printer paper', quantity: 5, uom: 'ream', pack_size: 'box of 5', unit_price: null, sst_rate: 6 },
        { id: LINE_2, product_id: null, description: 'Sample', quantity: 1, uom: null, pack_size: null, unit_price: 0, sst_rate: 0 },
      ],
    };
    expect(rfqFormFromDetail(detail)).toEqual({
      id: RFQ, supplier_id: SUPPLIER, rfq_date: '2026-10-01', reply_by: '', notes: '',
      lines: [
        { key: LINE_1, product_id: PRODUCT, description: 'Printer paper', quantity: '5', uom: 'ream', pack_size: 'box of 5', unit_price: '', sst_rate: '6' },
        { key: LINE_2, product_id: '', description: 'Sample', quantity: '1', uom: '', pack_size: '', unit_price: '0', sst_rate: '0' },
      ],
    });
  });
});

describe('a copy of an RFQ, for another supplier', () => {
  const priced: RfqDetail = {
    id: RFQ, rfq_no: 'RFQ-0004', supplier_id: SUPPLIER, supplier_name: 'Syarikat Kertas', rfq_date: '2026-09-01', reply_by: '2026-09-15',
    supplier_ref: 'Q-77', status: 'quoted', line_count: 2, total: 130, purchase_order_id: 'po-1', purchase_order_no: 'PO-0003', source_rfq_id: null,
    subtotal: 125, sst_total: 5, notes: 'Deliver to the back door', quoted_at: '2026-10-02T09:00:00Z',
    lines: [
      { id: LINE_1, product_id: PRODUCT, description: 'Printer paper', quantity: 5, uom: 'ream', pack_size: 'box of 5', unit_price: 24.9, sst_rate: 6 },
      { id: LINE_2, product_id: null, description: 'Sample', quantity: 1, uom: null, pack_size: null, unit_price: 0, sst_rate: 0 },
    ],
  };

  it('is a new RFQ: no id, no supplier, dated today, with no reply-by date', () => {
    const form = rfqFormCopiedFrom(priced, today);
    expect(form).not.toHaveProperty('id');
    expect(form).toMatchObject({ supplier_id: '', rfq_date: today, reply_by: '' });
  });
  it('keeps the notes and every line, and empties every price box, a price of 0 included', () => {
    const form = rfqFormCopiedFrom(priced, today);
    expect(form.notes).toBe('Deliver to the back door');
    expect(form.lines.map((line) => ({ ...line, key: undefined }))).toEqual([
      { key: undefined, product_id: PRODUCT, description: 'Printer paper', quantity: '5', uom: 'ream', pack_size: 'box of 5', unit_price: '', sst_rate: '6' },
      { key: undefined, product_id: '', description: 'Sample', quantity: '1', uom: '', pack_size: '', unit_price: '', sst_rate: '0' },
    ]);
  });
  it('gives the lines new keys, none of them the source line ids, and no two the same', () => {
    const keys = rfqFormCopiedFrom(priced, today).lines.map((line) => line.key);
    expect(new Set(keys).size).toBe(2);
    expect(keys).not.toContain(LINE_1);
    expect(keys).not.toContain(LINE_2);
  });
  it('is not ready to save until a supplier is chosen, then saves as a new draft', () => {
    const form = rfqFormCopiedFrom(priced, today);
    expect(rfqFormError(form)).toBe('Choose a supplier.');
    const chosen = RFQ_FORM_KIND.withParty(form, { id: SUPPLIER, payment_terms_days: 30 });
    expect(rfqFormError(chosen)).toBeNull();
    expect(rfqPayload(chosen)).not.toHaveProperty('id');
  });
  it('remembers the RFQ it was copied from, and sends it with the new draft', () => {
    const chosen = RFQ_FORM_KIND.withParty(rfqFormCopiedFrom(priced, today), { id: SUPPLIER, payment_terms_days: 30 });
    expect(rfqPayload(chosen)).toMatchObject({ source_rfq_id: priced.id });
    expect(saveRfqInput.parse(rfqPayload(chosen)).source_rfq_id).toBe(priced.id);
    expect(rfqPayload(filled())).not.toHaveProperty('source_rfq_id');
  });
  it('leaves the RFQ it was copied from unchanged', () => {
    const before = JSON.stringify(priced);
    rfqFormCopiedFrom(priced, today);
    expect(JSON.stringify(priced)).toBe(before);
  });
  it('lets go of the RFQ it was copied from once that RFQ is gone, so saving again is not refused the same way', () => {
    const chosen = RFQ_FORM_KIND.withParty(rfqFormCopiedFrom(priced, today), { id: SUPPLIER, payment_terms_days: 30 });
    const after = rfqFormAfterRefusal(chosen, RFQ_MESSAGES.copiedFromGone);
    expect(after).not.toHaveProperty('source_rfq_id');
    expect(rfqPayload(after)).not.toHaveProperty('source_rfq_id');
    // Everything the person typed is still there, and it is still a new RFQ.
    expect(after).toEqual({ ...chosen, source_rfq_id: undefined });
    expect(rfqFormError(after)).toBeNull();
    expect(rfqPayload(after)).not.toHaveProperty('id');
    expect(chosen.source_rfq_id).toBe(priced.id);
  });
  it('keeps the RFQ it was copied from through any other refusal', () => {
    const chosen = RFQ_FORM_KIND.withParty(rfqFormCopiedFrom(priced, today), { id: SUPPLIER, payment_terms_days: 30 });
    for (const error of [RFQ_MESSAGES.gone, RFQ_MESSAGES.missing, RFQ_MESSAGES.locked, WRITE_FAILED, '']) {
      expect(rfqFormAfterRefusal(chosen, error), error).toBe(chosen);
    }
  });
});

describe('what the RFQ form sends', () => {
  it('sends an empty price box as null, and a typed 0 as 0', () => {
    const sent = rfqPayload(
      filled({ lines: [
        { ...emptyLine('k1'), description: 'A', quantity: '2', unit_price: '' },
        { ...emptyLine('k2'), description: 'B', quantity: '2', unit_price: '0' },
        { ...emptyLine('k3'), description: 'C', quantity: '2', unit_price: '3.5' },
      ] }),
    ) as { lines: { unit_price: number | null }[] };
    expect(sent.lines.map((l) => l.unit_price)).toEqual([null, 0, 3.5]);
  });
  it('is what saveRfqInput takes, with the id only when a draft is being changed', () => {
    expect(rfqPayload(filled({ notes: ' Urgent ' }))).toEqual({
      supplier_id: SUPPLIER, rfq_date: today, reply_by: '', notes: ' Urgent ',
      lines: [{ product_id: '', description: 'Printer paper', uom: '', pack_size: '', quantity: 10, unit_price: null, sst_rate: 0 }],
    });
    expect(rfqPayload(filled())).not.toHaveProperty('id');
    expect(rfqPayload(filled({ id: 'abc' }))).toMatchObject({ id: 'abc' });
    expect(saveRfqInput.safeParse(rfqPayload(filled())).success).toBe(true);
    expect(JSON.stringify(rfqPayload(filled()))).not.toContain('"key"');
  });
  it('sends a price that is not a number as NaN, which is refused', () => {
    const form = filled({ lines: [{ ...emptyLine('k1'), description: 'A', quantity: '1', unit_price: '1,200' }] });
    expect(rfqFormError(form)).toBe('Enter a unit price of 0 or more.');
  });
});

describe('what is wrong with an RFQ form', () => {
  it('passes a form with no prices, so an RFQ can be sent without any', () => {
    expect(rfqFormError(filled())).toBeNull();
  });
  it('says so in the schema’s own sentences, the first thing first', () => {
    expect(rfqFormError(filled({ supplier_id: '' }))).toBe('Choose a supplier.');
    expect(rfqFormError(filled({ rfq_date: '' }))).toBe('Enter a valid date.');
    expect(rfqFormError(filled({ reply_by: '2026-10-10' }))).toBe('The reply-by date cannot be before the RFQ date.');
    expect(rfqFormError(filled({ reply_by: today }))).toBeNull();
    expect(rfqFormError(filled({ lines: [] }))).toBe('Add at least one line.');
    expect(rfqFormError(filled({ lines: [{ ...emptyLine('k1'), quantity: '1' }] }))).toBe('Describe each line.');
    expect(rfqFormError(filled({ lines: [{ ...filled().lines[0], quantity: '0' }] }))).toBe('Enter a quantity above 0.');
  });
});

describe('choosing a product', () => {
  it('fills the name, unit and SST, and leaves the price box empty: the supplier says what it costs', () => {
    const line = withRfqProduct({ ...emptyLine('k1'), unit_price: '9' }, paper);
    expect(line).toMatchObject({ product_id: PRODUCT, description: 'Printer paper', uom: 'ream', sst_rate: '6', quantity: '1', unit_price: '' });
  });
  it('clears only the link for "no product"', () => {
    expect(withRfqProduct({ ...emptyLine('k1'), product_id: PRODUCT, description: 'Printer paper' }, null)).toMatchObject({
      product_id: '', description: 'Printer paper',
    });
  });
});

describe('saved, but not marked as sent', () => {
  it('says the draft is safe and passes on the database’s sentence', () => {
    expect(rfqSavedNotSent('An RFQ needs at least one line.')).toBe(
      'The RFQ was saved as a draft, but it was not marked as sent. An RFQ needs at least one line.',
    );
    expect(rfqSavedNotSent(WRITE_FAILED)).toBe('The RFQ was saved as a draft, but marking it as sent failed. Please try again.');
  });
});

describe('the RFQ form, as the shared card draws it', () => {
  it('says RFQ and supplier, with an optional reply-by date', () => {
    expect([RFQ_FORM_KIND.noun, RFQ_FORM_KIND.party, RFQ_FORM_KIND.dateLabel]).toEqual(['RFQ', 'supplier', 'RFQ date']);
    expect(RFQ_FORM_KIND.secondDate.label).toBe('Reply by (optional)');
    expect(RFQ_FORM_KIND.secondDate.optional).toBe(true);
    expect(RFQ_FORM_KIND.partyId(filled())).toBe(SUPPLIER);
    expect(RFQ_FORM_KIND.date(filled())).toBe(today);
    expect(RFQ_FORM_KIND.secondDate.get(filled())).toBe('');
    expect(RFQ_FORM_KIND.reference).toBeUndefined();
  });
  it('is the RFQ form’s own rules, not a second set', () => {
    expect(RFQ_FORM_KIND.withProduct).toBe(withRfqProduct);
    expect(RFQ_FORM_KIND.error).toBe(rfqFormError);
    expect(RFQ_FORM_KIND.payload).toBe(rfqPayload);
    expect(RFQ_FORM_KIND.savedNotPosted).toBe(rfqSavedNotSent);
    expect(RFQ_FORM_KIND.afterRefusal).toBe(rfqFormAfterRefusal);
  });
  it('is marked as sent, never posted, in every word the card shows', () => {
    const words = documentFormWords(RFQ_FORM_KIND);
    expect(words.post).toBe('Save and mark as sent');
    expect(Object.values(words).join(' ').toLowerCase()).not.toContain('post');
  });
});

describe('recording the supplier’s prices', () => {
  const detail = {
    id: RFQ,
    lines: [
      { id: LINE_1, product_id: null, description: 'Printer paper', quantity: 5, uom: 'ream', pack_size: null, unit_price: null, sst_rate: 6 },
      { id: LINE_2, product_id: null, description: 'Toner', quantity: 1, uom: null, pack_size: null, unit_price: 80, sst_rate: 0 },
    ],
  } as RfqDetail;

  it('starts from the lines, with the price box empty where there is no price', () => {
    expect(priceDrafts(detail)).toEqual([
      { line_id: LINE_1, description: 'Printer paper', quantity: 5, uom: 'ream', unit_price: '', sst_rate: '6' },
      { line_id: LINE_2, description: 'Toner', quantity: 1, uom: null, unit_price: '80', sst_rate: '0' },
    ]);
  });
  it('sends numbers, and what quoteRfqInput takes', () => {
    const drafts = priceDrafts(detail).map((d) => ({ ...d, unit_price: d.unit_price || '4.5' }));
    const sent = quotePayload(RFQ, ' Q-1 ', drafts);
    expect(sent).toEqual({
      id: RFQ, supplier_ref: ' Q-1 ',
      prices: [{ line_id: LINE_1, unit_price: 4.5, sst_rate: 6 }, { line_id: LINE_2, unit_price: 80, sst_rate: 0 }],
    });
    expect(quoteRfqInput.safeParse(sent).success).toBe(true);
  });
  it('refuses one empty price, however many are filled', () => {
    expect(quoteFormError(priceDrafts(detail))).toBe('Enter a price for every line before marking the RFQ as quoted.');
    expect(quoteFormError(priceDrafts(detail).map((d) => ({ ...d, unit_price: '  ' })))).toBe(
      'Enter a price for every line before marking the RFQ as quoted.',
    );
  });
  it('accepts a price of 0, and refuses a bad price or rate with the line sentences', () => {
    const drafts = priceDrafts(detail).map((d) => ({ ...d, unit_price: '0' }));
    expect(quoteFormError(drafts)).toBeNull();
    expect(quoteFormError([{ ...drafts[0], unit_price: '1,200' }])).toBe('Enter a unit price of 0 or more.');
    expect(quoteFormError([{ ...drafts[0], unit_price: '-1' }])).toBe('Enter a unit price of 0 or more.');
    expect(quoteFormError([{ ...drafts[0], sst_rate: '101' }])).toBe('Enter an SST rate between 0 and 100.');
  });
  it('refuses no lines at all', () => {
    expect(quoteFormError([])).toBe('Enter a price for every line before marking the RFQ as quoted.');
  });
});
