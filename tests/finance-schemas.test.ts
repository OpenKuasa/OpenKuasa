import { describe, expect, it } from 'vitest';
import { billIdInput, saveBillInput } from '@/lib/finance/bills';
import { cashReceiptIdInput, saveCashReceiptInput } from '@/lib/finance/cash-receipts';
import { createContactInput, updateContactInput } from '@/lib/finance/contacts';
import { creditNoteIdInput, saveCreditNoteInput } from '@/lib/finance/credit-notes';
import { invoiceIdInput, saveInvoiceInput, setEInvoiceInput } from '@/lib/finance/invoices';
import { markPaymentPaidInput, paymentIdInput, recordPaymentInInput, recordPaymentOutInput } from '@/lib/finance/money';
import { createProductInput, updateProductInput } from '@/lib/finance/products';
import { quotationIdInput, saveQuotationInput } from '@/lib/finance/quotations';
import { recordRefundInput } from '@/lib/finance/refunds';

const ID = '11111111-1111-4111-8111-111111111111';

/**
 * A server action parses its input and hands the result to a write function
 * that parses again. That is only safe while parsing a schema's own output
 * changes nothing; a transform that is not idempotent would be applied twice.
 */
const cases: [string, { parse: (v: unknown) => unknown }, unknown][] = [
  ['createContactInput', createContactInput, { name: ' Aisyah ', is_customer: true, is_supplier: false, email: '', phone: ' 012 ', tin: '' }],
  ['updateContactInput', updateContactInput, { id: ID, name: ' Aisyah ', email: '' }],
  ['createProductInput', createProductInput, { name: ' Ink ', type: 'product', price: 14.506, cost: 0.03754, sku: ' ', uom: '' }],
  ['updateProductInput', updateProductInput, { id: ID, price: 14.506, cost: 2.34567, category: '' }],
  ['saveBillInput', saveBillInput, {
    supplier_id: ID, bill_date: '2026-10-01', due_date: '2026-10-31', supplier_ref: ' ', notes: '',
    lines: [{ description: ' Gloves ', quantity: 1.23456, unit_price: 0.123456, uom: '', product_id: '' }],
  }],
  ['recordPaymentOutInput', recordPaymentOutInput, {
    account_id: ID, txn_date: '2026-10-05', method: 'fpx', reference: ' ',
    allocations: [{ bill_id: ID, amount: 32.506 }],
  }],
  ['saveBillInput (smallest quantity)', saveBillInput, {
    supplier_id: ID, bill_date: '2026-10-01', due_date: '2026-10-31', supplier_ref: ' ', notes: '',
    lines: [{ description: ' Gloves ', quantity: 0.0005, unit_price: 0.123456, uom: '', product_id: '' }],
  }],
  ['recordPaymentOutInput (smallest amount)', recordPaymentOutInput, {
    account_id: ID, txn_date: '2026-10-05', method: 'fpx', reference: ' ',
    allocations: [{ bill_id: ID, amount: 0.005 }],
  }],
  ['markPaymentPaidInput', markPaymentPaidInput, { id: ID, paid_on: '2026-10-09' }],
  ['billIdInput', billIdInput, { id: ID }],
  ['paymentIdInput', paymentIdInput, { id: ID }],
  ['saveBillInput (a draft being changed, with a product)', saveBillInput, {
    id: ID, supplier_id: ID, bill_date: '2026-10-01', due_date: '2026-10-01', supplier_ref: ' INV 88 ', notes: ' urgent ',
    lines: [{ product_id: ID, description: 'Ink', quantity: 2, uom: ' box ', unit_price: 14.5, sst_rate: 6 }],
  }],
  ['recordPaymentOutInput (scheduled, two bills)', recordPaymentOutInput, {
    account_id: ID, txn_date: '2026-10-20', method: 'cheque', reference: ' CHQ 001 ', notes: '', scheduled: true,
    allocations: [{ bill_id: ID, amount: 10.005 }, { bill_id: '22222222-2222-4222-8222-222222222222', amount: 5 }],
  }],
  ['saveBillInput (an SST rate with three decimals)', saveBillInput, {
    supplier_id: ID, bill_date: '2026-10-01', due_date: '2026-10-31',
    lines: [{ description: 'Gloves', quantity: 1, unit_price: 10, sst_rate: 1.005 }, { description: 'Ink', quantity: 1, unit_price: 10, sst_rate: 0.145 }],
  }],
  ['saveInvoiceInput', saveInvoiceInput, {
    customer_id: ID, invoice_date: '2026-10-01', due_date: '2026-10-31', notes: '',
    lines: [{ description: ' Design work ', quantity: 1.23456, unit_price: 0.123456, uom: '', product_id: '' }],
  }],
  ['saveInvoiceInput (smallest quantity, an SST rate with three decimals)', saveInvoiceInput, {
    customer_id: ID, invoice_date: '2026-10-01', due_date: '2026-10-31',
    lines: [{ description: 'Design work', quantity: 0.0005, unit_price: 10, sst_rate: 1.005 }, { description: 'Hosting', quantity: 1, unit_price: 10, sst_rate: 0.145 }],
  }],
  ['saveInvoiceInput (a draft being changed, with a product)', saveInvoiceInput, {
    id: ID, customer_id: ID, invoice_date: '2026-10-01', due_date: '2026-10-01', notes: ' Net 30 ',
    lines: [{ product_id: ID, description: 'Ink', quantity: 2, uom: ' box ', pack_size: ' box of 4 ', unit_price: 14.5, sst_rate: 6 }],
  }],
  ['invoiceIdInput', invoiceIdInput, { id: ID }],
  ['recordPaymentInInput', recordPaymentInInput, {
    account_id: ID, txn_date: '2026-10-05', method: 'fpx', reference: ' ',
    allocations: [{ invoice_id: ID, amount: 32.506 }],
  }],
  ['recordPaymentInInput (smallest amount)', recordPaymentInInput, {
    account_id: ID, txn_date: '2026-10-05', method: 'fpx',
    allocations: [{ invoice_id: ID, amount: 0.005 }],
  }],
  ['recordPaymentInInput (two invoices, a reference and a note)', recordPaymentInInput, {
    account_id: ID, txn_date: '2026-10-20', method: 'cheque', reference: ' CHQ 001 ', notes: ' banked ',
    allocations: [{ invoice_id: ID, amount: 10.005 }, { invoice_id: '22222222-2222-4222-8222-222222222222', amount: 5 }],
  }],
  ['setEInvoiceInput', setEInvoiceInput, { id: ID, einvoice_status: 'validated', einvoice_uuid: ' F9D425P6DS7D8IU ' }],
  ['setEInvoiceInput (no status, an empty UUID box)', setEInvoiceInput, { id: ID, einvoice_status: 'none', einvoice_uuid: '  ' }],
  ['setEInvoiceInput (a status and no UUID yet)', setEInvoiceInput, { id: ID, einvoice_status: 'pending' }],
  ['saveQuotationInput', saveQuotationInput, {
    customer_id: ID, quote_date: '2026-10-01', valid_until: '2026-10-31', notes: '',
    lines: [{ description: ' Design work ', quantity: 1.23456, unit_price: 0.123456, uom: '', product_id: '' }],
  }],
  ['saveQuotationInput (a draft being changed, valid for the day, an SST rate with three decimals)', saveQuotationInput, {
    id: ID, customer_id: ID, quote_date: '2026-10-01', valid_until: '2026-10-01', notes: ' Valid 30 days ',
    lines: [{ product_id: ID, description: 'Ink', quantity: 0.0005, uom: ' box ', unit_price: 14.5, sst_rate: 1.005 }],
  }],
  ['quotationIdInput', quotationIdInput, { id: ID }],
  ['saveCreditNoteInput', saveCreditNoteInput, { invoice_id: ID, credit_date: '2026-10-06', reason: 'returns', amount: 240.005, notes: ' ' }],
  ['saveCreditNoteInput (a draft being changed, the smallest amount)', saveCreditNoteInput, {
    id: ID, invoice_id: ID, credit_date: '2026-10-06', reason: 'other', amount: 0.005, notes: ' Two returned ',
  }],
  ['creditNoteIdInput', creditNoteIdInput, { id: ID }],
  ['recordRefundInput (against an invoice)', recordRefundInput, {
    invoice_id: ID, account_id: ID, txn_date: '2026-10-06', method: 'fpx', reason: 'damaged_goods', amount: 240.005, reference: ' ',
  }],
  ['recordRefundInput (pending, against a credit note, the invoice box left empty)', recordRefundInput, {
    invoice_id: '', credit_note_id: ID, account_id: ID, txn_date: '2026-10-06', method: 'cheque', reason: 'other', amount: 0.005,
    reference: ' CHQ 001 ', notes: ' Collected in person ', scheduled: true,
  }],
  ['saveCashReceiptInput (income, a typed payer)', saveCashReceiptInput, {
    kind: 'income', account_id: ID, txn_date: '2026-10-06', method: 'cash', category_id: ID, amount: 32.506,
    party_name: ' Walk-in ', contact_id: '', reference: ' ',
  }],
  ['saveCashReceiptInput (income, a draft being changed, a contact, the smallest amount)', saveCashReceiptInput, {
    kind: 'income', id: ID, account_id: ID, txn_date: '2026-10-06', method: 'cheque', category_id: ID, amount: 0.005,
    contact_id: ID, party_name: ' ', reference: ' CHQ 001 ', notes: ' Deposit ',
  }],
  ['saveCashReceiptInput (two invoices)', saveCashReceiptInput, {
    kind: 'invoice', account_id: ID, txn_date: '2026-10-20', method: 'fpx', notes: ' banked ',
    allocations: [{ invoice_id: ID, amount: 10.005 }, { invoice_id: '22222222-2222-4222-8222-222222222222', amount: 5 }],
  }],
  ['cashReceiptIdInput', cashReceiptIdInput, { id: ID }],
];

describe('finance schemas parse their own output unchanged', () => {
  for (const [name, schema, input] of cases) {
    it(name, () => {
      const once = schema.parse(input);
      expect(schema.parse(once)).toEqual(once);
    });
  }
});

describe('a bill line’s SST rate', () => {
  const bill = (sst_rate: number) => ({
    supplier_id: ID, bill_date: '2026-10-01', due_date: '2026-10-31',
    lines: [{ description: 'Gloves', quantity: 1, unit_price: 10, sst_rate }],
  });
  const rate = (input: unknown) => saveBillInput.parse(input).lines[0].sst_rate;

  it('is rounded to two decimals as the database stores it, half away from zero', () => {
    // 1.005 * 100 is 100.49999999999999 in floating point; the column numeric(5,2) stores 1.01.
    const once = saveBillInput.parse(bill(1.005));
    expect(once.lines[0].sst_rate).toBe(1.01);
    expect(rate(once)).toBe(1.01);
    expect(rate(bill(0.145))).toBe(0.15);
    expect(rate(bill(8.004))).toBe(8);
    expect(rate(bill(6))).toBe(6);
  });
  it('is checked against 0 to 100 after rounding', () => {
    expect(rate(bill(100.004))).toBe(100);
    expect(saveBillInput.safeParse(bill(100.005)).error?.issues[0]?.message).toBe('Enter an SST rate between 0 and 100.');
    expect(saveBillInput.safeParse(bill(-0.01)).error?.issues[0]?.message).toBe('Enter an SST rate between 0 and 100.');
    expect(saveBillInput.safeParse(bill(Number.NaN)).error?.issues[0]?.message).toBe('Enter an SST rate between 0 and 100.');
  });
  it('is 0 when the line has none', () => {
    expect(rate({ ...bill(0), lines: [{ description: 'Gloves', quantity: 1, unit_price: 10 }] })).toBe(0);
  });
});
