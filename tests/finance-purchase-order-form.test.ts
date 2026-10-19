import { describe, expect, it } from 'vitest';
import { documentFormWords, emptyLine } from '@/lib/finance/document-form';
import type { FinanceProduct } from '@/lib/finance/products';
import {
  PURCHASE_ORDER_FORM_KIND,
  type PurchaseOrderForm,
  newPurchaseOrderForm,
  purchaseOrderFormError,
  purchaseOrderFormFromDetail,
  purchaseOrderPayload,
  purchaseOrderSavedNotSubmitted,
  receiptDrafts,
  receivePayload,
  submitReceipts,
  withOrderProduct,
  withOrderSupplier,
} from '@/lib/finance/purchase-order-form';
import { type PurchaseOrderDetail, receivePurchaseOrderInput, savePurchaseOrderInput } from '@/lib/finance/purchase-orders';
import { WRITE_FAILED } from '@/lib/finance/result';
import { ringgitFields } from '@/lib/finance/document-currency';

const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const PO = '33333333-3333-4333-8333-333333333333';
const LINE_1 = '66666666-6666-4666-8666-666666666661';
const LINE_2 = '66666666-6666-4666-8666-666666666662';
const today = '2026-10-12';

const paper: FinanceProduct = {
  id: PRODUCT, sku: 'PPR', name: 'Printer paper', type: 'product', category: null, uom: 'ream', price: 24.9, cost: 12.5, sst_rate: 6, active: true,
};

/** A form a person has filled in: a supplier on 30 days and one line of 10 at 12.5. */
const filled = (form: Partial<PurchaseOrderForm> = {}): PurchaseOrderForm => ({
  ...withOrderSupplier(newPurchaseOrderForm(today, 'k1'), { id: SUPPLIER, payment_terms_days: 30 }),
  lines: [{ ...emptyLine('k1'), description: 'Printer paper', quantity: '10', unit_price: '12.5' }],
  ...form,
});

describe('a new purchase order form', () => {
  it('is dated today, with no expected date, no terms, no address, no supplier and one empty line', () => {
    expect(newPurchaseOrderForm(today, 'k1')).toEqual({
      supplier_id: '', po_date: today, expected_date: '', payment_terms_days: '', termsEdited: false,
      delivery_address: '', notes: '', lines: [emptyLine('k1')], fx: ringgitFields(),
    });
  });
});

describe('choosing a supplier', () => {
  it('fills the payment terms from the supplier’s', () => {
    expect(filled()).toMatchObject({ supplier_id: SUPPLIER, payment_terms_days: '30', termsEdited: false });
    expect(withOrderSupplier(filled(), { id: 'other', payment_terms_days: 7 })).toMatchObject({ supplier_id: 'other', payment_terms_days: '7' });
  });
  it('keeps terms the person typed, even if they emptied the box', () => {
    const typed = PURCHASE_ORDER_FORM_KIND.extras![0].set(filled(), '0');
    expect(typed).toMatchObject({ payment_terms_days: '0', termsEdited: true });
    expect(withOrderSupplier(typed, { id: 'other', payment_terms_days: 7 })).toMatchObject({ supplier_id: 'other', payment_terms_days: '0' });
    const emptied = PURCHASE_ORDER_FORM_KIND.extras![0].set(filled(), '');
    expect(withOrderSupplier(emptied, { id: 'other', payment_terms_days: 7 }).payment_terms_days).toBe('');
  });
});

describe('a saved draft, as the form shows it', () => {
  const detail = {
    id: PO, po_no: null, supplier_id: SUPPLIER, supplier_name: 'Syarikat Kertas', rfq_id: null, rfq_no: null,
    po_date: '2026-10-01', expected_date: null, status: 'draft', created_by: 'u1', submitted_by: null, rejection_reason: null,
    payment_terms_days: null, delivery_address: 'Lot 3, Shah Alam', total: 0, delivery: 'pending', received_total: 0,
    billed_total: 0, over_billed: false, billed_over_received: false, subtotal: 0, sst_total: 0, notes: null,
    currency: 'MYR', fx_rate: 1, fx_rate_text: '1.0000000000', fx_rate_source: null, fx_rate_date: null, total_myr: 0,
    lines: [
      { id: LINE_1, product_id: PRODUCT, description: 'Printer paper', quantity: 5, uom: 'ream', pack_size: 'box of 5', unit_price: 12.5, sst_rate: 6, amount: 62.5, sst_amount: 3.75, received_quantity: 0 },
    ],
  } as PurchaseOrderDetail;
  it('shows the saved terms as they are, as set by hand, and an empty box for none', () => {
    expect(purchaseOrderFormFromDetail(detail)).toEqual({
      id: PO, supplier_id: SUPPLIER, po_date: '2026-10-01', expected_date: '', payment_terms_days: '', termsEdited: true,
      delivery_address: 'Lot 3, Shah Alam', notes: '',
      lines: [{ key: LINE_1, product_id: PRODUCT, description: 'Printer paper', quantity: '5', uom: 'ream', pack_size: 'box of 5', unit_price: '12.5', sst_rate: '6', discount_pct: '', discount_amount: '' }],
      fx: ringgitFields(),
    });
    expect(purchaseOrderFormFromDetail({ ...detail, payment_terms_days: 0, expected_date: '2026-10-20' })).toMatchObject({
      payment_terms_days: '0', expected_date: '2026-10-20',
    });
  });
});

describe('what the purchase order form sends', () => {
  it('is what savePurchaseOrderInput takes, with the id only when a draft is being changed', () => {
    expect(purchaseOrderPayload(filled({ notes: ' Urgent ', delivery_address: ' Lot 3 ' }))).toEqual({
      supplier_id: SUPPLIER, po_date: today, expected_date: '', payment_terms_days: 30, delivery_address: ' Lot 3 ', notes: ' Urgent ',
      lines: [{ product_id: '', description: 'Printer paper', uom: '', pack_size: '', quantity: 10, unit_price: 12.5, sst_rate: 0 }],
      // A ringgit order sends its code alone, as a quotation does; the database stores rate 1.
      currency: 'MYR', fx_rate: null, fx_rate_source: null, fx_rate_date: null,
    });
    expect(purchaseOrderPayload(filled())).not.toHaveProperty('id');
    expect(purchaseOrderPayload(filled({ id: 'abc' }))).toMatchObject({ id: 'abc' });
    expect(savePurchaseOrderInput.safeParse(purchaseOrderPayload(filled())).success).toBe(true);
    expect(JSON.stringify(purchaseOrderPayload(filled()))).not.toContain('termsEdited');
    expect(JSON.stringify(purchaseOrderPayload(filled()))).not.toContain('"key"');
  });
  it('sends empty terms as null, and terms that are not a whole number as something the schema refuses', () => {
    expect(purchaseOrderPayload(filled({ payment_terms_days: '  ' }))).toMatchObject({ payment_terms_days: null });
    expect(purchaseOrderPayload(filled({ payment_terms_days: '0' }))).toMatchObject({ payment_terms_days: 0 });
    expect(purchaseOrderFormError(filled({ payment_terms_days: '30 days' }))).toBe('Enter payment terms from 0 to 365 days, or leave them empty.');
    expect(purchaseOrderFormError(filled({ payment_terms_days: '1.5' }))).toBe('Enter payment terms from 0 to 365 days, or leave them empty.');
    expect(purchaseOrderFormError(filled({ payment_terms_days: '366' }))).toBe('Enter payment terms from 0 to 365 days, or leave them empty.');
  });
});

describe('what is wrong with a purchase order form', () => {
  it('passes a complete form', () => {
    expect(purchaseOrderFormError(filled())).toBeNull();
    expect(purchaseOrderFormError(filled(), true)).toBeNull();
  });
  it('says so in the schema’s own sentences, the first thing first', () => {
    expect(purchaseOrderFormError(filled({ supplier_id: '' }))).toBe('Choose a supplier.');
    expect(purchaseOrderFormError(filled({ po_date: '' }))).toBe('Enter a valid date.');
    expect(purchaseOrderFormError(filled({ expected_date: '2026-10-11' }))).toBe('The expected delivery date cannot be before the order date.');
    expect(purchaseOrderFormError(filled({ expected_date: today }))).toBeNull();
    expect(purchaseOrderFormError(filled({ delivery_address: 'a'.repeat(501) }))).toBe('Keep the delivery address to 500 characters or fewer.');
    expect(purchaseOrderFormError(filled({ lines: [] }))).toBe('Add at least one line.');
    expect(purchaseOrderFormError(filled({ lines: [{ ...emptyLine('k1'), description: 'A', quantity: '1' }] }))).toBe('Enter a unit price of 0 or more.');
    expect(purchaseOrderFormError(filled({ lines: [{ ...emptyLine('k1'), description: 'A', quantity: '1', unit_price: '1,200' }] }))).toBe(
      'Enter a unit price of 0 or more.',
    );
  });
  it('lets a draft total nothing, but not an order being submitted', () => {
    const free = filled({ lines: [{ ...emptyLine('k1'), description: 'Sample', quantity: '1', unit_price: '0' }] });
    expect(purchaseOrderFormError(free)).toBeNull();
    expect(purchaseOrderFormError(free, true)).toBe('A purchase order needs at least one line with an amount.');
  });
});

describe('choosing a product', () => {
  it('fills the name, unit, cost and SST: what the workspace pays for it', () => {
    expect(withOrderProduct({ ...emptyLine('k1'), unit_price: '99' }, paper)).toMatchObject({
      product_id: PRODUCT, description: 'Printer paper', uom: 'ream', unit_price: '12.5', sst_rate: '6', quantity: '1',
    });
  });
  it('clears only the link for "no product"', () => {
    expect(withOrderProduct({ ...emptyLine('k1'), product_id: PRODUCT, description: 'Printer paper', unit_price: '12.5' }, null)).toMatchObject({
      product_id: '', description: 'Printer paper', unit_price: '12.5',
    });
  });
});

describe('saved, but not submitted', () => {
  it('says the draft is safe and passes on the database’s sentence', () => {
    expect(purchaseOrderSavedNotSubmitted('A purchase order needs at least one line with an amount.')).toBe(
      'The purchase order was saved as a draft, but it was not submitted for approval. A purchase order needs at least one line with an amount.',
    );
    expect(purchaseOrderSavedNotSubmitted(WRITE_FAILED)).toBe(
      'The purchase order was saved as a draft, but submitting it failed. Please try again.',
    );
  });
});

describe('the purchase order form, as the shared card draws it', () => {
  it('says purchase order and supplier, with an optional expected delivery date', () => {
    expect([PURCHASE_ORDER_FORM_KIND.noun, PURCHASE_ORDER_FORM_KIND.party, PURCHASE_ORDER_FORM_KIND.dateLabel]).toEqual([
      'purchase order', 'supplier', 'Order date',
    ]);
    expect(PURCHASE_ORDER_FORM_KIND.secondDate.label).toBe('Expected delivery (optional)');
    expect(PURCHASE_ORDER_FORM_KIND.secondDate.optional).toBe(true);
    expect(PURCHASE_ORDER_FORM_KIND.partyId(filled())).toBe(SUPPLIER);
    expect(PURCHASE_ORDER_FORM_KIND.date(filled())).toBe(today);
    expect(PURCHASE_ORDER_FORM_KIND.secondDate.get(filled())).toBe('');
    expect(PURCHASE_ORDER_FORM_KIND.reference).toBeUndefined();
  });
  it('does not move the expected date when the order date changes', () => {
    const form = PURCHASE_ORDER_FORM_KIND.secondDate.set(newPurchaseOrderForm(today, 'k1'), '2026-10-20');
    expect(PURCHASE_ORDER_FORM_KIND.withDate(form, '2026-10-15', 30)).toMatchObject({ po_date: '2026-10-15', expected_date: '2026-10-20' });
  });
  it('draws payment terms and delivery address after the dates', () => {
    const extras = PURCHASE_ORDER_FORM_KIND.extras!;
    expect(extras.map((e) => e.label)).toEqual(['Payment terms (days)', 'Delivery address (optional)']);
    expect(extras[0].inputMode).toBe('numeric');
    expect(extras[0].get(filled())).toBe('30');
    expect(extras[1].get(filled({ delivery_address: 'Lot 3' }))).toBe('Lot 3');
    expect(extras[1].set(filled(), 'Lot 9')).toMatchObject({ delivery_address: 'Lot 9' });
  });
  it('is the form’s own rules, not a second set', () => {
    expect(PURCHASE_ORDER_FORM_KIND.withProduct).toBe(withOrderProduct);
    expect(PURCHASE_ORDER_FORM_KIND.withParty).toBe(withOrderSupplier);
    expect(PURCHASE_ORDER_FORM_KIND.error).toBe(purchaseOrderFormError);
    expect(PURCHASE_ORDER_FORM_KIND.payload).toBe(purchaseOrderPayload);
    expect(PURCHASE_ORDER_FORM_KIND.savedNotPosted).toBe(purchaseOrderSavedNotSubmitted);
  });
  it('is submitted for approval, never posted, in every word the card shows', () => {
    const words = documentFormWords(PURCHASE_ORDER_FORM_KIND);
    expect(words.post).toBe('Save and submit for approval');
    expect(Object.values(words).join(' ').toLowerCase()).not.toContain('post');
  });
});

describe('recording what has arrived', () => {
  const detail = {
    id: PO,
    lines: [
      { id: LINE_1, product_id: null, description: 'Printer paper', quantity: 10, uom: 'ream', pack_size: null, unit_price: 12.5, sst_rate: 6, amount: 125, sst_amount: 7.5, received_quantity: 4 },
      { id: LINE_2, product_id: null, description: 'Toner', quantity: 1, uom: null, pack_size: null, unit_price: 80, sst_rate: 0, amount: 80, sst_amount: 0, received_quantity: 0 },
    ],
  } as PurchaseOrderDetail;

  it('starts from the lines, with what has arrived so far in each box', () => {
    expect(receiptDrafts(detail)).toEqual([
      { line_id: LINE_1, description: 'Printer paper', uom: 'ream', ordered: 10, received: '4' },
      { line_id: LINE_2, description: 'Toner', uom: null, ordered: 1, received: '0' },
    ]);
  });
  it('sends numbers, and what receivePurchaseOrderInput takes', () => {
    const drafts = receiptDrafts(detail).map((d) => ({ ...d, received: d.received === '0' ? '1' : '10' }));
    const sent = receivePayload(PO, drafts);
    expect(sent).toEqual({
      id: PO, receipts: [{ line_id: LINE_1, received_quantity: 10 }, { line_id: LINE_2, received_quantity: 1 }],
    });
    expect(receivePurchaseOrderInput.safeParse(sent).success).toBe(true);
  });
  it('decides once: the sentence to show with nothing to send, or the payload', () => {
    const drafts = receiptDrafts(detail);
    expect(submitReceipts(PO, drafts)).toEqual({ payload: receivePayload(PO, drafts) });
    expect(submitReceipts(PO, [{ ...drafts[0], received: '' }, drafts[1]])).toEqual({
      error: 'Enter how much has been received for each line, 0 or more.',
    });
    expect(submitReceipts(PO, [{ ...drafts[0], received: '1,000' }])).toEqual({ error: 'Enter how much has been received for each line, 0 or more.' });
    expect(submitReceipts(PO, [{ ...drafts[0], received: '-1' }])).toEqual({ error: 'Enter how much has been received for each line, 0 or more.' });
    expect(submitReceipts(PO, [])).toEqual({ error: 'Enter how much has been received for each line, 0 or more.' });
  });
  it('accepts 0 and more than was ordered: suppliers over-deliver', () => {
    const drafts = receiptDrafts(detail);
    expect('payload' in submitReceipts(PO, drafts.map((d) => ({ ...d, received: '0' })))).toBe(true);
    expect('payload' in submitReceipts(PO, drafts.map((d) => ({ ...d, received: '25.5' })))).toBe(true);
  });
});
