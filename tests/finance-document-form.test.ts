import { describe, expect, it } from 'vitest';
import {
  BILL_FORM_KIND,
  billFormError,
  billPayload,
  emptyLine as billEmptyLine,
  lineNumbers as billLineNumbers,
  newBillForm,
  savedNotPosted,
  withBillDate,
  withDueDate as billWithDueDate,
  withProduct,
  withSupplier,
} from '@/lib/finance/bill-form';
import {
  defaultDueDate,
  emptyLine,
  filledFromProduct,
  followedDueDate,
  lineDraft,
  lineNumbers,
  linePayload,
  savedAsDraft,
  withDueDate,
} from '@/lib/finance/document-form';
import type { FinanceProduct } from '@/lib/finance/products';
import { WRITE_FAILED } from '@/lib/finance/result';

const PRODUCT = '99999999-9999-4999-8999-999999999999';

const gloves: FinanceProduct = {
  id: PRODUCT,
  sku: 'PRD-010',
  name: 'Nitrile Gloves (Box)',
  type: 'product',
  category: 'Consumables',
  uom: 'box',
  price: 24.9,
  cost: 12.5,
  sst_rate: 6,
  active: true,
};

describe('what the bill form and the invoice form share', () => {
  it('is one definition: bill-form.ts hands on the same functions', () => {
    expect(billEmptyLine).toBe(emptyLine);
    expect(billLineNumbers).toBe(lineNumbers);
    expect(billWithDueDate).toBe(withDueDate);
  });

  it('fills a line from a product at the price it is given, keeping the quantity and the pack size', () => {
    const line = { ...emptyLine('k1'), description: 'typed by hand', quantity: '4', unit_price: '9', pack_size: '100 pcs' };
    expect(filledFromProduct(line, gloves, gloves.price)).toEqual({
      key: 'k1',
      product_id: PRODUCT,
      description: 'Nitrile Gloves (Box)',
      quantity: '4',
      uom: 'box',
      pack_size: '100 pcs',
      unit_price: '24.9',
      sst_rate: '6',
      discount_pct: '',
      discount_amount: '',
    });
    expect(filledFromProduct(line, null, 0)).toEqual({ ...line, product_id: '' });
  });

  it('shows a saved line as text, with nothing for what was left empty', () => {
    expect(
      lineDraft({ id: 'line-2', product_id: null, description: 'Delivery', quantity: 1.5, uom: null, pack_size: null, unit_price: 0, sst_rate: 8, amount: 0, sst_amount: 0 }),
    ).toEqual({ key: 'line-2', product_id: '', description: 'Delivery', quantity: '1.5', uom: '', pack_size: '', unit_price: '0', sst_rate: '8', discount_pct: '', discount_amount: '' });
  });

  it('sends a line as numbers, without its key', () => {
    const line = { ...emptyLine('k1'), product_id: PRODUCT, description: ' Gloves ', quantity: '10', uom: 'box', unit_price: '12.50', sst_rate: '6' };
    expect(linePayload(line)).toEqual({
      product_id: PRODUCT,
      description: ' Gloves ',
      uom: 'box',
      pack_size: '',
      quantity: 10,
      unit_price: 12.5,
      sst_rate: 6,
    });
    expect(Number.isNaN(linePayload({ ...line, quantity: '1,000' }).quantity)).toBe(true);
  });

  it('sends a percentage discount, a fixed one, and never shadows a real amount with a 0', () => {
    const line = { ...emptyLine('k1'), description: 'Widget', quantity: '2', unit_price: '50', sst_rate: '6' };
    expect(linePayload({ ...line, discount_pct: '5' })).toMatchObject({ discount_pct: 5 });
    expect(linePayload({ ...line, discount_amount: '10' })).toMatchObject({ discount_amount: 10 });
    // A line with no discount carries neither key.
    const plain = linePayload(line) as Record<string, unknown>;
    expect('discount_pct' in plain).toBe(false);
    expect('discount_amount' in plain).toBe(false);
    // A leftover 0 in the percentage box must not drop a real ringgit discount.
    const mixed = linePayload({ ...line, discount_pct: '0', discount_amount: '20' }) as Record<string, unknown>;
    expect(mixed.discount_amount).toBe(20);
    expect('discount_pct' in mixed).toBe(false);
  });

  it('moves the due date with the date and the terms until it is set by hand', () => {
    const following = { due_date: '2026-10-11', dueEdited: false };
    expect(defaultDueDate('2026-10-11', 30)).toBe('2026-11-10');
    expect(followedDueDate(following, '2026-12-15', 30)).toBe('2027-01-14');
    expect(followedDueDate(following, '2026-12-15', undefined)).toBe('2026-12-15');
    // Half typed, or cleared: it stays where it was.
    expect(followedDueDate(following, '', 30)).toBe('2026-10-11');
    expect(followedDueDate(following, '0002-10-11', 30)).toBe('2026-10-11');
    const byHand = withDueDate(following, '2026-10-25');
    expect(byHand).toEqual({ due_date: '2026-10-25', dueEdited: true });
    expect(followedDueDate(byHand, '2026-12-15', 30)).toBe('2026-10-25');
  });

  it('words "saved but not posted" for either document', () => {
    expect(savedAsDraft('invoice', WRITE_FAILED)).toBe('The invoice was saved as a draft, but posting it failed. Please try again.');
    expect(savedAsDraft('invoice', 'Add at least one line.')).toBe('The invoice was saved as a draft, but it was not posted. Add at least one line.');
    expect(savedAsDraft('bill', WRITE_FAILED)).toBe(savedNotPosted(WRITE_FAILED));
  });
});

describe('the bill form, as the shared card draws it', () => {
  const form = withSupplier(newBillForm('2026-10-11', 'k1'), { id: 'lim', payment_terms_days: 30 });

  it('is the bill form’s own rules, not a second set', () => {
    expect(BILL_FORM_KIND.withParty).toBe(withSupplier);
    expect(BILL_FORM_KIND.withDate).toBe(withBillDate);
    expect(BILL_FORM_KIND.withProduct).toBe(withProduct);
    expect(BILL_FORM_KIND.error).toBe(billFormError);
    expect(BILL_FORM_KIND.payload).toBe(billPayload);
    expect(BILL_FORM_KIND.savedNotPosted).toBe(savedNotPosted);
  });

  it('reads the supplier and the bill date, and keeps the supplier’s reference', () => {
    expect(BILL_FORM_KIND.partyId(form)).toBe('lim');
    expect(BILL_FORM_KIND.date(form)).toBe('2026-10-11');
    expect(BILL_FORM_KIND.reference?.set(form, 'INV 88')).toEqual({ ...form, supplier_ref: 'INV 88' });
    expect(BILL_FORM_KIND.reference?.get({ ...form, supplier_ref: 'INV 88' })).toBe('INV 88');
  });

  it('fills a bill line from the product’s cost', () => {
    expect(BILL_FORM_KIND.withProduct(emptyLine('k1'), gloves).unit_price).toBe('12.5');
  });

  it('says supplier and bill', () => {
    expect([BILL_FORM_KIND.noun, BILL_FORM_KIND.party, BILL_FORM_KIND.dateLabel]).toEqual(['bill', 'supplier', 'Bill date']);
  });
});
