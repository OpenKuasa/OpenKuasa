import { describe, expect, it } from 'vitest';
import { saveRfqInput } from '@/lib/finance/rfqs';
import { savePurchaseOrderInput, billFromPurchaseOrderInput } from '@/lib/finance/purchase-orders';
import { saveJournalInput, reverseJournalInput } from '@/lib/finance/ledger';

// A valid v4 UUID (what a read tool hands the model).
const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Regression for the prod smoke finding (#225 follow-up): the Bendahara AI tools reuse these capability input
 * schemas, so an LLM drafting a finance document must be able to omit the fields it has no value for. An RFQ is a
 * *request* for prices, so its lines carry no price; and none of these documents needs the operator to type a date
 * when "today" is right. Before this fix those fields were required, so every AI draft failed validation and the
 * specialist reported "I could not draft the RFQ".
 */
describe('finance write schemas accept an LLM draft (no price on an RFQ line; dates default to today)', () => {
  it('saveRfq: a line with no unit_price, and no rfq_date', () => {
    const r = saveRfqInput.parse({ supplier_id: ID, lines: [{ description: '15mm copper pipe', quantity: 10 }] });
    expect(r.rfq_date).toMatch(DATE);
    expect(r.lines[0].unit_price).toBeNull();
  });

  it('savePurchaseOrder: no po_date (lines still carry their agreed price)', () => {
    const r = savePurchaseOrderInput.parse({ supplier_id: ID, lines: [{ description: '15mm copper pipe', quantity: 10, unit_price: 5 }] });
    expect(r.po_date).toMatch(DATE);
  });

  it('billFromPurchaseOrder: no bill_date', () => {
    expect(billFromPurchaseOrderInput.parse({ id: ID }).bill_date).toMatch(DATE);
  });

  it('reverseJournal: no reversal_date', () => {
    expect(reverseJournalInput.parse({ id: ID }).reversal_date).toMatch(DATE);
  });

  it('saveJournal: omitting journal_date is not a validation error', () => {
    const r = saveJournalInput.safeParse({ description: 'Accrue rent', lines: [] });
    // lines may fail (min 1), but journal_date must NOT be the reason — it now defaults.
    const dateIssue = r.success ? undefined : r.error.issues.find((i) => i.path[0] === 'journal_date');
    expect(dateIssue).toBeUndefined();
  });
});
