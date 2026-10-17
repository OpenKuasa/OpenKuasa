import { describe, expect, it } from 'vitest';
import type { InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow } from '@/lib/finance/money';
import { alsoCovers } from '@/lib/finance/purchase-views';
import {
  alsoCoversInvoices,
  customerChoice,
  invoiceActions,
  invoiceCan,
  invoiceCustomers,
  paymentInActions,
  siblingInvoices,
} from '@/lib/finance/sales-views';
import { alsoCoversSentence } from '@/lib/finance/view-helpers';
import { ringgitRow } from './helpers/invoice-rows';

const invoice = (display_status: InvoiceDisplayStatus, i: Partial<InvoiceListRow> = {}): InvoiceListRow => ringgitRow({
  id: `invoice-${display_status}`,
  invoice_no: display_status === 'draft' ? null : 'INV-0001',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 0,
  credited: 0,
  refunded: 0,
  balance: 100,
  display_status,
  einvoice_status: 'none',
  einvoice_uuid: null,
  ...i,
});

const row = (allocation: string, p: Partial<PaymentInRow> = {}): PaymentInRow => ({
  allocation_id: allocation,
  transaction_id: 'txn-1',
  number: 'RC-0001',
  txn_date: '2026-10-05',
  method: 'fpx',
  amount: 100,
  transaction_amount: 300,
  status: 'posted',
  reference: null,
  account_id: 'bank',
  account_name: 'Main Bank',
  invoice_id: `invoice-${allocation}`,
  invoice_no: 'INV-0007',
  customer_name: 'Aisyah Trading',
  ...p,
});

/** What the forms' own rules say an invoice can still take; the menu rule is given it. */
const NOTHING = { pay: false, credit: false, refund: false };
const EVERYTHING = { pay: true, credit: true, refund: true };

describe('invoiceActions, for a customer in credit', () => {
  // RM 100 invoiced and paid, then RM 30 credited: the customer is RM 30 in credit.
  const inCredit = invoice('paid', { paid: 100, credited: 30, balance: -30 });

  it('offers a refund, and no payment, on a paid invoice whose balance is below zero', () => {
    expect(invoiceActions(inCredit, EVERYTHING)).toEqual(['credit', 'refund', 'einvoice', 'void']);
    expect(invoiceActions(inCredit, { pay: true, credit: false, refund: true })).toEqual(['refund', 'einvoice', 'void']);
  });
  it('offers no refund once refunds that are pending hold all of the credit', () => {
    expect(invoiceActions(inCredit, { pay: false, credit: true, refund: false })).toEqual(['credit', 'einvoice', 'void']);
    expect(invoiceActions(inCredit, NOTHING)).toEqual(['einvoice', 'void']);
  });
  it('never offers a refund while the customer owes money or is exactly settled, whatever the flag says', () => {
    expect(invoiceActions(invoice('sent'), EVERYTHING)).not.toContain('refund');
    expect(invoiceActions(invoice('overdue', { credited: 30, balance: 70 }), EVERYTHING)).not.toContain('refund');
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), EVERYTHING)).not.toContain('refund');
  });
});

describe('invoiceCan: what the forms offer an invoice', () => {
  // RM 100 invoiced and paid, then RM 30 credited: the customer is RM 30 in credit.
  const inCredit = invoice('paid', { paid: 100, credited: 30, balance: -30 });
  const owing = invoice('sent');
  const receivable = [{ id: owing.id }];
  const creditable = [{ id: owing.id }, { id: inCredit.id }];
  const refundable = [
    { kind: 'invoice' as const, id: inCredit.id },
    { kind: 'credit_note' as const, id: 'note-1' },
  ];

  it('offers each of the three exactly when its form offers the invoice', () => {
    expect(invoiceCan(owing, { receivable, creditable, refundable })).toEqual({ pay: true, credit: true, refund: false });
    expect(invoiceCan(inCredit, { receivable, creditable, refundable })).toEqual({ pay: false, credit: true, refund: true });
    // A credit note that can be refunded is not its invoice: an id is matched by kind.
    expect(invoiceCan(invoice('paid', { id: 'note-1' }), { receivable, creditable, refundable })).toEqual({
      pay: false,
      credit: false,
      refund: false,
    });
  });
  it('offers no refund when the credit notes or the refunds could not be read, and still a credit note', () => {
    // A credit note is decided from the invoice rows, which were read; only the refund needs the two lists.
    const unread = { receivable, creditable, refundable: null };
    expect(invoiceCan(owing, unread)).toEqual({ pay: true, credit: true, refund: false });
    expect(invoiceCan(inCredit, unread)).toEqual({ pay: false, credit: true, refund: false });
    // The rest of each row's menu is as it was.
    expect(invoiceActions(owing, invoiceCan(owing, unread))).toEqual(['pay', 'credit', 'einvoice', 'void']);
    expect(invoiceActions(inCredit, invoiceCan(inCredit, unread))).toEqual(['credit', 'einvoice', 'void']);
  });
});

describe('invoiceActions', () => {
  it('lets a draft be edited, posted or deleted, and never voided, paid, credited or refunded', () => {
    expect(invoiceActions(invoice('draft'), NOTHING)).toEqual(['edit', 'post', 'delete']);
    expect(invoiceActions(invoice('draft'), EVERYTHING)).toEqual(['edit', 'post', 'delete']);
  });
  it('lets a posted invoice take a payment and a credit note while it can, have its e-Invois set, and be voided', () => {
    expect(invoiceActions(invoice('sent'), EVERYTHING)).toEqual(['pay', 'credit', 'einvoice', 'void']);
    expect(invoiceActions(invoice('overdue'), EVERYTHING)).toEqual(['pay', 'credit', 'einvoice', 'void']);
    expect(invoiceActions(invoice('sent'), { pay: true, credit: false, refund: false })).toEqual(['pay', 'einvoice', 'void']);
    // Nothing left that a new payment or a new credit note could take.
    expect(invoiceActions(invoice('sent'), NOTHING)).toEqual(['einvoice', 'void']);
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), NOTHING)).toEqual(['einvoice', 'void']);
  });
  it('offers a credit note on a paid invoice: what was paid does not limit one', () => {
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), EVERYTHING)).toEqual(['credit', 'einvoice', 'void']);
  });
  it('never offers a payment on a paid invoice, whatever the flag says', () => {
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), EVERYTHING)).not.toContain('pay');
    expect(invoiceActions(invoice('sent'), EVERYTHING)).toContain('pay');
  });
  it('offers nothing on a void invoice', () => {
    expect(invoiceActions(invoice('void'), NOTHING)).toEqual([]);
    expect(invoiceActions(invoice('void'), EVERYTHING)).toEqual([]);
  });
  it('never offers what the database refuses for the status: no editing or deleting once posted, no voiding a draft', () => {
    for (const status of ['sent', 'overdue', 'paid', 'void'] as const) {
      const offered = invoiceActions(invoice(status), EVERYTHING);
      expect(offered, status).not.toContain('edit');
      expect(offered, status).not.toContain('post');
      expect(offered, status).not.toContain('delete');
    }
    expect(invoiceActions(invoice('draft'), EVERYTHING)).not.toContain('void');
    expect(invoiceActions(invoice('draft'), EVERYTHING)).not.toContain('einvoice');
  });
});

describe('customerChoice', () => {
  const customers = invoiceCustomers([invoice('sent'), invoice('sent', { customer_id: 'zaki', customer_name: 'Zaki Enterprise' })]);

  it('keeps a customer who still has an invoice, and "all"', () => {
    expect(customerChoice('zaki', customers)).toBe('zaki');
    expect(customerChoice('all', customers)).toBe('all');
    expect(customerChoice('all', [])).toBe('all');
  });
  it('goes back to everyone when the chosen customer’s last invoice is gone', () => {
    expect(customerChoice('nurul', customers)).toBe('all');
    expect(customerChoice('zaki', [])).toBe('all');
  });
});

describe('paymentInActions', () => {
  it('lets a received payment be voided, and offers nothing else on any row', () => {
    expect(paymentInActions(row('a'))).toEqual(['void']);
    for (const status of ['void', 'draft', 'pending_approval', 'scheduled', 'rejected'] as const) {
      expect(paymentInActions(row('a', { status })), status).toEqual([]);
    }
  });
});

describe('a payment split across invoices', () => {
  const rows = [
    row('a', { invoice_no: 'INV-0007' }),
    row('b', { invoice_no: 'INV-0009' }),
    row('c', { invoice_no: 'INV-0008' }),
    row('d', { transaction_id: 'txn-2', invoice_no: 'INV-0001' }),
  ];

  it('names the other invoices, whichever row the menu was opened from', () => {
    expect(siblingInvoices(rows, rows[0])).toEqual(['INV-0008', 'INV-0009']);
    expect(siblingInvoices(rows, rows[1])).toEqual(['INV-0007', 'INV-0008']);
    expect(alsoCoversInvoices(rows, rows[1])).toBe('This payment also covers INV-0007 and INV-0008.');
    expect(alsoCoversInvoices(rows.slice(0, 2), rows[0])).toBe('This payment also covers INV-0009.');
  });
  it('says nothing for a payment against one invoice', () => {
    expect(siblingInvoices(rows, rows[3])).toEqual([]);
    expect(alsoCoversInvoices(rows, rows[3])).toBe('');
  });
  it('is the sentence a payment out uses', () => {
    expect(alsoCoversSentence([])).toBe('');
    expect(alsoCoversSentence(['A'])).toBe('This payment also covers A.');
    expect(alsoCoversSentence(['A', 'B', 'C'])).toBe('This payment also covers A, B and C.');
    expect(alsoCovers([], { transaction_id: 't', allocation_id: 'x' } as never)).toBe('');
  });
});
