import { describe, expect, it } from 'vitest';
import { billTotals } from '@/lib/finance/bill-math';
import { emptyLine, lineNumbers } from '@/lib/finance/document-form';
import {
  INVOICE_FORM_KIND,
  type InvoiceForm,
  eInvoiceForm,
  eInvoiceFormError,
  eInvoicePayload,
  invoiceFormError,
  invoiceFormFromDetail,
  invoicePayload,
  invoiceSavedNotPosted,
  newInvoiceForm,
  withCustomer,
  withEInvoiceStatus,
  withInvoiceDate,
  withSoldProduct,
} from '@/lib/finance/invoice-form';
import { INVOICE_MESSAGES, type InvoiceDetail, saveInvoiceInput, setEInvoiceInput } from '@/lib/finance/invoices';
import type { FinanceProduct } from '@/lib/finance/products';
import { WRITE_FAILED } from '@/lib/finance/result';

const INVOICE = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const today = '2026-10-11';

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

/** A form that can be saved: a customer and one line of 10 at RM 24.90. */
const filled = (f: Partial<InvoiceForm> = {}): InvoiceForm => ({
  ...newInvoiceForm(today, 'k1'),
  customer_id: CUSTOMER,
  due_date: '2026-11-10',
  lines: [{ ...emptyLine('k1'), description: 'Gloves', quantity: '10', unit_price: '24.90' }],
  ...f,
});

describe('newInvoiceForm', () => {
  it('is dated today with one empty line of quantity 1 and no SST, and has no supplier reference', () => {
    expect(newInvoiceForm(today, 'k1')).toEqual({
      customer_id: '',
      invoice_date: today,
      due_date: today,
      dueEdited: false,
      notes: '',
      lines: [{ key: 'k1', product_id: '', description: '', quantity: '1', uom: '', pack_size: '', unit_price: '', sst_rate: '0' }],
    });
  });
});

describe('the due date', () => {
  const customer = { id: CUSTOMER, payment_terms_days: 30 };

  it('follows the customer’s payment terms and the invoice date', () => {
    const chosen = withCustomer(newInvoiceForm(today, 'k1'), customer);
    expect(chosen).toMatchObject({ customer_id: CUSTOMER, due_date: '2026-11-10', dueEdited: false });
    expect(withInvoiceDate(chosen, '2026-12-15', 30)).toMatchObject({ invoice_date: '2026-12-15', due_date: '2027-01-14' });
    expect(withCustomer(chosen, { id: 'other', payment_terms_days: 7 }).due_date).toBe('2026-10-18');
    expect(withCustomer(chosen, { id: 'cash', payment_terms_days: 0 }).due_date).toBe(today);
  });
  it('stops following once the person sets it by hand', () => {
    const edited = { ...withCustomer(newInvoiceForm(today, 'k1'), customer), due_date: '2026-10-25', dueEdited: true };
    expect(withInvoiceDate(edited, '2026-10-12', 30).due_date).toBe('2026-10-25');
    expect(withCustomer(edited, { id: 'other', payment_terms_days: 7 })).toMatchObject({ customer_id: 'other', due_date: '2026-10-25' });
  });
  it('stays where it was while the invoice date is half typed or cleared', () => {
    const chosen = withCustomer(newInvoiceForm(today, 'k1'), customer);
    expect(withInvoiceDate(chosen, '', 30)).toMatchObject({ invoice_date: '', due_date: '2026-11-10' });
    expect(withInvoiceDate(chosen, '0002-10-11', 30).due_date).toBe('2026-11-10');
    // A customer chosen while the date box is empty does not blank the due date either.
    expect(withCustomer({ ...chosen, invoice_date: '' }, { id: 'other', payment_terms_days: 7 }).due_date).toBe('2026-11-10');
  });
});

describe('withSoldProduct', () => {
  const line = { ...emptyLine('k1'), description: 'typed by hand', quantity: '4', unit_price: '9', pack_size: '100 pcs' };

  it('fills the unit price from the product’s price, not its cost', () => {
    expect(withSoldProduct(line, gloves)).toEqual({
      key: 'k1',
      product_id: PRODUCT,
      description: 'Nitrile Gloves (Box)',
      quantity: '4',
      uom: 'box',
      pack_size: '100 pcs',
      unit_price: '24.9',
      sst_rate: '6',
    });
  });
  it('only clears the link when "no product" is chosen', () => {
    const linked = withSoldProduct(line, gloves);
    expect(withSoldProduct(linked, null)).toEqual({ ...linked, product_id: '' });
  });
});

describe('invoiceFormError', () => {
  it('passes a form that can be saved', () => {
    expect(invoiceFormError(filled())).toBeNull();
  });
  it('asks for a customer first', () => {
    expect(invoiceFormError(filled({ customer_id: '' }))).toBe('Choose a customer.');
  });
  it('asks for real dates, the due date not before the invoice date', () => {
    expect(invoiceFormError(filled({ invoice_date: '' }))).toBe('Enter a valid date.');
    expect(invoiceFormError(filled({ due_date: '20261-11-10' }))).toBe('Enter a valid date.');
    expect(invoiceFormError(filled({ due_date: '2026-10-10' }))).toBe('The due date cannot be before the invoice date.');
  });
  it('checks each line in the schema’s words, and refuses a figure typed with a comma', () => {
    const line = filled().lines[0];
    const withLine = (l: Partial<typeof line>) => filled({ lines: [{ ...line, ...l }] });
    expect(invoiceFormError(withLine({ description: '  ' }))).toBe('Describe each line.');
    expect(invoiceFormError(withLine({ quantity: '0' }))).toBe('Enter a quantity above 0.');
    expect(invoiceFormError(withLine({ quantity: '1,000' }))).toBe('Enter a quantity above 0.');
    expect(invoiceFormError(withLine({ unit_price: '' }))).toBe('Enter a unit price of 0 or more.');
    expect(invoiceFormError(withLine({ unit_price: '1,250.00' }))).toBe('Enter a unit price of 0 or more.');
    expect(invoiceFormError(withLine({ sst_rate: '101' }))).toBe('Enter an SST rate between 0 and 100.');
    expect(invoiceFormError(withLine({ sst_rate: '' }))).toBeNull();
  });
  it('asks for at least one line, and at most 100', () => {
    const line = filled().lines[0];
    expect(invoiceFormError(filled({ lines: [] }))).toBe('Add at least one line.');
    expect(invoiceFormError(filled({ lines: Array.from({ length: 101 }, (_, i) => ({ ...line, key: `k${i}` })) }))).toBe(
      'An invoice can have at most 100 lines.',
    );
  });
  it('lets a draft total nothing, but not an invoice that is being posted', () => {
    const free = filled({ lines: [{ ...filled().lines[0], unit_price: '0' }] });
    expect(invoiceFormError(free)).toBeNull();
    expect(invoiceFormError(free, true)).toBe('An invoice needs at least one line with an amount.');
    expect(invoiceFormError(filled(), true)).toBeNull();
  });
});

describe('invoicePayload', () => {
  it('sends numbers, never the text that was typed, with the lines in the order they are on the form', () => {
    const payload = invoicePayload(
      filled({
        notes: ' Net 30 ',
        lines: [
          { key: 'k1', product_id: PRODUCT, description: ' Gloves ', quantity: '10', uom: 'box', pack_size: '', unit_price: '24.90', sst_rate: '6' },
          { ...emptyLine('k2'), description: 'Delivery', unit_price: '20' },
        ],
      }),
    );
    expect(payload).toEqual({
      customer_id: CUSTOMER,
      invoice_date: today,
      due_date: '2026-11-10',
      notes: ' Net 30 ',
      lines: [
        { product_id: PRODUCT, description: ' Gloves ', uom: 'box', pack_size: '', quantity: 10, unit_price: 24.9, sst_rate: 6 },
        { product_id: '', description: 'Delivery', uom: '', pack_size: '', quantity: 1, unit_price: 20, sst_rate: 0 },
      ],
    });
    expect('id' in payload).toBe(false);
    expect(saveInvoiceInput.parse(payload)).toMatchObject({ notes: 'Net 30', lines: [{ description: 'Gloves' }, { description: 'Delivery', product_id: null }] });
  });
  it('sends the id when a draft is being changed, and never the line keys, the dueEdited flag or a workspace', () => {
    const payload = invoicePayload(filled({ id: INVOICE }));
    expect(payload.id).toBe(INVOICE);
    expect(Object.keys(payload).sort()).toEqual(['customer_id', 'due_date', 'id', 'invoice_date', 'lines', 'notes']);
    expect(Object.keys(payload.lines[0]).sort()).toEqual(['description', 'pack_size', 'product_id', 'quantity', 'sst_rate', 'unit_price', 'uom']);
  });
});

describe('invoiceFormFromDetail', () => {
  const detail: InvoiceDetail = {
    id: INVOICE,
    invoice_no: null,
    customer_id: CUSTOMER,
    customer_name: 'Aisyah Trading',
    invoice_date: '2026-10-01',
    due_date: '2026-10-15',
    total: 263.94,
    paid: 0,
    balance: 263.94,
    display_status: 'draft',
    einvoice_status: 'none',
    einvoice_uuid: null,
    subtotal: 249,
    sst: 14.94,
    notes: 'Net 14',
    lines: [
      { id: 'line-1', product_id: PRODUCT, description: 'Nitrile Gloves (Box)', quantity: 10, uom: 'box', pack_size: '100 pcs', unit_price: 24.9, sst_rate: 6, amount: 249, sst_amount: 14.94 },
      { id: 'line-2', product_id: null, description: 'Delivery', quantity: 1, uom: null, pack_size: null, unit_price: 0, sst_rate: 0, amount: 0, sst_amount: 0 },
    ],
  };

  it('shows a saved draft as it was saved, in the order of its lines, and keeps its due date', () => {
    const form = invoiceFormFromDetail(detail);
    expect(form).toMatchObject({ id: INVOICE, customer_id: CUSTOMER, invoice_date: '2026-10-01', due_date: '2026-10-15', dueEdited: true, notes: 'Net 14' });
    expect(form.lines.map((l) => [l.key, l.description, l.unit_price])).toEqual([
      ['line-1', 'Nitrile Gloves (Box)', '24.9'],
      ['line-2', 'Delivery', '0'],
    ]);
  });
  it('saves back what it loaded: nothing is lost by opening and saving a draft', () => {
    const form = invoiceFormFromDetail(detail);
    expect(invoiceFormError(form)).toBeNull();
    const parsed = saveInvoiceInput.parse(invoicePayload(form));
    expect(parsed.id).toBe(INVOICE);
    expect(parsed.lines).toEqual([
      { product_id: PRODUCT, description: 'Nitrile Gloves (Box)', quantity: 10, uom: 'box', pack_size: '100 pcs', unit_price: 24.9, sst_rate: 6 },
      { product_id: null, description: 'Delivery', quantity: 1, uom: null, pack_size: null, unit_price: 0, sst_rate: 0 },
    ]);
    expect(billTotals(form.lines.map(lineNumbers))).toEqual({ subtotal: 249, sst: 14.94, total: 263.94 });
  });
});

describe('invoiceSavedNotPosted', () => {
  it('says the draft was saved, then why it was not posted', () => {
    expect(invoiceSavedNotPosted(WRITE_FAILED)).toBe('The invoice was saved as a draft, but posting it failed. Please try again.');
    expect(invoiceSavedNotPosted(INVOICE_MESSAGES.empty)).toBe(
      `The invoice was saved as a draft, but it was not posted. ${INVOICE_MESSAGES.empty}`,
    );
  });
});

describe('the invoice form, as the shared card draws it', () => {
  it('is the invoice form’s own rules, with no second reference box', () => {
    expect(INVOICE_FORM_KIND.withParty).toBe(withCustomer);
    expect(INVOICE_FORM_KIND.withDate).toBe(withInvoiceDate);
    expect(INVOICE_FORM_KIND.withProduct).toBe(withSoldProduct);
    expect(INVOICE_FORM_KIND.error).toBe(invoiceFormError);
    expect(INVOICE_FORM_KIND.payload).toBe(invoicePayload);
    expect(INVOICE_FORM_KIND.savedNotPosted).toBe(invoiceSavedNotPosted);
    expect(INVOICE_FORM_KIND.reference).toBeUndefined();
  });
  it('reads the customer and the invoice date, and says customer and invoice', () => {
    expect(INVOICE_FORM_KIND.partyId(filled())).toBe(CUSTOMER);
    expect(INVOICE_FORM_KIND.date(filled())).toBe(today);
    expect([INVOICE_FORM_KIND.noun, INVOICE_FORM_KIND.party, INVOICE_FORM_KIND.dateLabel]).toEqual(['invoice', 'customer', 'Invoice date']);
  });
});

describe('the e-Invois form', () => {
  it('opens on what the invoice has now', () => {
    expect(eInvoiceForm({ einvoice_status: 'none', einvoice_uuid: null })).toEqual({ status: 'none', uuid: '' });
    expect(eInvoiceForm({ einvoice_status: 'validated', einvoice_uuid: 'F9D425P6DS7D8IU' })).toEqual({ status: 'validated', uuid: 'F9D425P6DS7D8IU' });
  });
  it('keeps the UUID while the status moves between pending, validated and rejected, and empties it for None', () => {
    const form = { status: 'pending' as const, uuid: 'F9D425P6DS7D8IU' };
    expect(withEInvoiceStatus(form, 'validated')).toEqual({ status: 'validated', uuid: 'F9D425P6DS7D8IU' });
    expect(withEInvoiceStatus(form, 'rejected')).toEqual({ status: 'rejected', uuid: 'F9D425P6DS7D8IU' });
    expect(withEInvoiceStatus(form, 'none')).toEqual({ status: 'none', uuid: '' });
  });
  it('sends the invoice, the status and the UUID as typed; the schema trims it', () => {
    const payload = eInvoicePayload(INVOICE, { status: 'validated', uuid: ' F9D425P6DS7D8IU ' });
    expect(payload).toEqual({ id: INVOICE, einvoice_status: 'validated', einvoice_uuid: ' F9D425P6DS7D8IU ' });
    expect(setEInvoiceInput.parse(payload).einvoice_uuid).toBe('F9D425P6DS7D8IU');
  });
  it('says what is wrong in the schema’s words', () => {
    expect(eInvoiceFormError(INVOICE, { status: 'pending', uuid: '' })).toBeNull();
    expect(eInvoiceFormError(INVOICE, { status: 'validated', uuid: 'x'.repeat(101) })).toBe('Keep the UUID to 100 characters or fewer.');
    expect(eInvoiceFormError(INVOICE, { status: 'none', uuid: 'F9D425P6DS7D8IU' })).toBe(
      'An invoice with no e-Invois status has no UUID. Clear the UUID, or choose a status.',
    );
    expect(eInvoiceFormError('nope', { status: 'pending', uuid: '' })).toBe('That invoice no longer exists.');
  });
});
