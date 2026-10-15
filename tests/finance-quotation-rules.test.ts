import { describe, expect, it } from 'vitest';
import type { QuotationDisplayStatus, QuotationListRow } from '@/lib/finance/quotations';
import { type QuotationAction, quotationActions, quotationName } from '@/lib/finance/sales-followon-views';

const quotation = (display_status: QuotationDisplayStatus, q: Partial<QuotationListRow> = {}): QuotationListRow => ({
  id: `quotation-${display_status}`,
  quotation_no: display_status === 'draft' ? null : 'QT-0007',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  quote_date: '2026-10-01',
  valid_until: '2026-10-31',
  total: 132.5,
  display_status,
  accepted_on: display_status === 'accepted' ? '2026-10-08' : null,
  invoice_id: null,
  invoice_no: null,
  currency: 'MYR',
  fx_rate: 1,
  fx_rate_source: null,
  fx_rate_date: null,
  total_myr: 132.5,
  ...q,
});

describe('quotationActions', () => {
  it('gives a status it does not know no actions', () => {
    expect(quotationActions(quotation('bogus' as QuotationDisplayStatus))).toEqual([]);
  });
  it('lets a draft be edited, marked as sent or deleted, and never answered or made into an invoice', () => {
    expect(quotationActions(quotation('draft'))).toEqual(['edit', 'send', 'delete']);
  });
  it('lets a sent quotation be answered either way, and nothing else: it is locked', () => {
    expect(quotationActions(quotation('sent'))).toEqual(['accept', 'decline']);
  });
  it('still lets an expired quotation be answered: accepting it late is the seller’s call', () => {
    expect(quotationActions(quotation('expired'))).toEqual(['accept', 'decline']);
  });
  it('lets an accepted quotation be made into an invoice, or the answer be corrected', () => {
    expect(quotationActions(quotation('accepted'))).toEqual(['convert', 'decline']);
  });
  it('lets a declined quotation be corrected to accepted, and not made into an invoice', () => {
    expect(quotationActions(quotation('declined'))).toEqual(['accept']);
  });
  it('offers nothing once an invoice stands for the quotation, a draft invoice included', () => {
    expect(quotationActions(quotation('accepted', { invoice_id: 'i1', invoice_no: 'INV-0044' }))).toEqual([]);
    expect(quotationActions(quotation('accepted', { invoice_id: 'i1', invoice_no: null }))).toEqual([]);
    // The database never leaves these standing; if one is met, nothing is offered that it would refuse.
    expect(quotationActions(quotation('declined', { invoice_id: 'i1' }))).toEqual([]);
    expect(quotationActions(quotation('sent', { invoice_id: 'i1' }))).toEqual([]);
  });
  it('never offers editing or deleting once a quotation has its number', () => {
    for (const status of ['sent', 'expired', 'accepted', 'declined'] as const) {
      const offered: QuotationAction[] = quotationActions(quotation(status));
      expect(offered, status).not.toContain('edit');
      expect(offered, status).not.toContain('delete');
      expect(offered, status).not.toContain('send');
    }
  });
  it('offers the same thing whatever the total: a draft of nothing is refused with a sentence when it is sent', () => {
    expect(quotationActions(quotation('draft', { total: 0 }))).toEqual(['edit', 'send', 'delete']);
  });
});

describe('quotationName', () => {
  it('names a quotation by its number and customer, and a draft as the draft', () => {
    expect(quotationName(quotation('sent'))).toBe('QT-0007 to Aisyah Trading');
    expect(quotationName(quotation('draft'))).toBe('the draft quotation to Aisyah Trading');
  });
});
