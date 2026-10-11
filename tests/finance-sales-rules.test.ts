import { describe, expect, it } from 'vitest';
import type { InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow } from '@/lib/finance/money';
import { alsoCovers } from '@/lib/finance/purchase-views';
import {
  alsoCoversInvoices,
  customerChoice,
  invoiceActions,
  invoiceCustomers,
  paymentInActions,
  siblingInvoices,
} from '@/lib/finance/sales-views';
import { alsoCoversSentence } from '@/lib/finance/view-helpers';

const invoice = (display_status: InvoiceDisplayStatus, i: Partial<InvoiceListRow> = {}): InvoiceListRow => ({
  id: `invoice-${display_status}`,
  invoice_no: display_status === 'draft' ? null : 'INV-0001',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 0,
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

describe('invoiceActions', () => {
  it('lets a draft be edited, posted or deleted, and never voided or paid', () => {
    expect(invoiceActions(invoice('draft'), false)).toEqual(['edit', 'post', 'delete']);
    expect(invoiceActions(invoice('draft'), true)).toEqual(['edit', 'post', 'delete']);
  });
  it('lets a posted invoice take a payment while it can, have its e-Invois set, and be voided', () => {
    expect(invoiceActions(invoice('sent'), true)).toEqual(['pay', 'einvoice', 'void']);
    expect(invoiceActions(invoice('overdue'), true)).toEqual(['pay', 'einvoice', 'void']);
    // Nothing left that a new payment could take.
    expect(invoiceActions(invoice('sent'), false)).toEqual(['einvoice', 'void']);
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), false)).toEqual(['einvoice', 'void']);
  });
  it('never offers a payment on a paid invoice, whatever the flag says', () => {
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), true)).toEqual(['einvoice', 'void']);
    expect(invoiceActions(invoice('sent'), true)).toContain('pay');
  });
  it('offers nothing on a void invoice', () => {
    expect(invoiceActions(invoice('void'), false)).toEqual([]);
    expect(invoiceActions(invoice('void'), true)).toEqual([]);
  });
  it('never offers what the database refuses for the status: no editing or deleting once posted, no voiding a draft', () => {
    for (const status of ['sent', 'overdue', 'paid', 'void'] as const) {
      const offered = invoiceActions(invoice(status), true);
      expect(offered, status).not.toContain('edit');
      expect(offered, status).not.toContain('post');
      expect(offered, status).not.toContain('delete');
    }
    expect(invoiceActions(invoice('draft'), true)).not.toContain('void');
    expect(invoiceActions(invoice('draft'), true)).not.toContain('einvoice');
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
