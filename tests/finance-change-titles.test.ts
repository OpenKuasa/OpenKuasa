import { describe, expect, it } from 'vitest';
import { approvalTitle, approvalDetail, collectNames, nameIn } from '@/lib/chat/change-titles';

describe('finance approve-card titles', () => {
  it('names the invoice lifecycle specifically, not generically', () => {
    const named = () => 'INV-001';
    expect(approvalTitle('postInvoice', { id: 'i1' }, named)).toBe('Post invoice “INV-001”?');
    expect(approvalTitle('voidInvoice', { id: 'i1' }, named)).toBe('Void invoice “INV-001”?');
    expect(approvalTitle('setEInvoice', { id: 'i1' }, named).toLowerCase()).toContain('e-invois');
    // No name known → a specific fallback, never the generic "Approve this change?".
    expect(approvalTitle('postInvoice', { id: 'i1' })).toBe('Post this invoice?');
    expect(approvalTitle('postInvoice', { id: 'i1' })).not.toBe('Approve this change?');
  });

  it('distinguishes creating a draft from editing one', () => {
    expect(approvalTitle('saveInvoice', {})).toBe('Create a draft invoice?');
    expect(approvalTitle('saveInvoice', { id: 'i1' }, () => 'INV-002')).toBe('Save changes to invoice “INV-002”?');
    expect(approvalTitle('saveBill', {})).toBe('Create a draft supplier bill?');
  });

  it('names finance contacts and items', () => {
    expect(approvalTitle('createFinanceContact', { name: 'Kedai Runcit Sdn Bhd' })).toBe('Add finance contact “Kedai Runcit Sdn Bhd”?');
    expect(approvalTitle('setFinanceContactActive', { id: 'c1', active: false }, () => 'Kedai Runcit')).toBe('Deactivate finance contact “Kedai Runcit”?');
    expect(approvalTitle('createFinanceItem', { name: 'Kopi O' })).toBe('Add item “Kopi O”?');
  });

  it('warns that a finance delete cannot be undone', () => {
    expect(approvalDetail('deleteBill', { id: 'b1' })).toBe('This cannot be undone.');
    expect(approvalDetail('deleteFinanceItem', { id: 'p1' })).toBe('This cannot be undone.');
  });
});

describe('finance name resolution', () => {
  it('finds an invoice by id from a listInvoices result (keyed on id, named by invoice_no)', () => {
    const results = [
      { tool: 'listInvoices', output: [{ id: 'i1', invoice_no: 'INV-001', customer_name: 'Ali' }] },
    ];
    const names = collectNames(results);
    expect(names['invoice:i1']).toBe('INV-001');
    expect(nameIn(results)('i1', 'invoice')).toBe('INV-001');
  });
});
