import { describe, expect, it } from 'vitest';
import type { CreditNoteRow, CreditNoteStatus } from '@/lib/finance/credit-notes';
import { creditNoteActions, creditNoteName } from '@/lib/finance/sales-followon-views';

const note = (status: CreditNoteStatus, n: Partial<CreditNoteRow> = {}): CreditNoteRow => ({
  id: `note-${status}`,
  credit_note_no: status === 'draft' ? null : 'CN-0003',
  invoice_id: 'invoice-1',
  invoice_no: 'INV-0007',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  credit_date: '2026-10-06',
  reason: 'returns',
  amount: 30,
  refunded: 0,
  status,
  notes: null,
  ...n,
});

describe('creditNoteActions', () => {
  it('lets a draft be edited, issued or deleted, and never voided or refunded', () => {
    expect(creditNoteActions(note('draft'), false)).toEqual(['edit', 'issue', 'delete']);
    // Whatever the flag says: a draft has credited nothing, so there is nothing to refund against it.
    expect(creditNoteActions(note('draft'), true)).toEqual(['edit', 'issue', 'delete']);
  });
  it('lets an issued credit note be voided, and refunded while something of it can be', () => {
    expect(creditNoteActions(note('issued'), true)).toEqual(['refund', 'void']);
    expect(creditNoteActions(note('issued'), false)).toEqual(['void']);
  });
  it('offers nothing on a void credit note', () => {
    expect(creditNoteActions(note('void'), false)).toEqual([]);
    expect(creditNoteActions(note('void'), true)).toEqual([]);
  });
  it('never offers what the database refuses for the status: no editing, issuing or deleting once issued', () => {
    for (const status of ['issued', 'void'] as const) {
      const offered = creditNoteActions(note(status), true);
      expect(offered, status).not.toContain('edit');
      expect(offered, status).not.toContain('issue');
      expect(offered, status).not.toContain('delete');
    }
  });
  it('offers Void on an issued credit note that has been refunded: the refusal says what to do first', () => {
    expect(creditNoteActions(note('issued', { refunded: 30 }), false)).toEqual(['void']);
  });
});

describe('creditNoteName', () => {
  it('names a credit note by its number and customer, and a draft as the draft', () => {
    expect(creditNoteName(note('issued'))).toBe('CN-0003 to Aisyah Trading');
    expect(creditNoteName(note('draft'))).toBe('the draft credit note to Aisyah Trading');
  });
});
