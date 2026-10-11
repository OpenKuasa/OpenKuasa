import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BILL_FORM_KIND, newBillForm, withSupplier } from '@/lib/finance/bill-form';
import { POSTING_WORDS, documentFormWords, withDueDate } from '@/lib/finance/document-form';
import { INVOICE_FORM_KIND, newInvoiceForm, withCustomer } from '@/lib/finance/invoice-form';

const today = '2026-10-11';

describe('the second date of a document form', () => {
  it('is the due date on a bill: read from the form, and set by hand through withDueDate', () => {
    const bill = withSupplier(newBillForm(today, 'k1'), { id: 'lim', payment_terms_days: 30 });
    expect(BILL_FORM_KIND.secondDate.label).toBe('Due date');
    expect(BILL_FORM_KIND.secondDate.get(bill)).toBe('2026-11-10');
    expect(BILL_FORM_KIND.secondDate.set).toBe(withDueDate);
    expect(BILL_FORM_KIND.secondDate.set(bill, '2026-12-01')).toEqual({ ...bill, due_date: '2026-12-01', dueEdited: true });
  });
  it('is the due date on an invoice, the same way', () => {
    const invoice = withCustomer(newInvoiceForm(today, 'k1'), { id: 'aisyah', payment_terms_days: 14 });
    expect(INVOICE_FORM_KIND.secondDate.label).toBe('Due date');
    expect(INVOICE_FORM_KIND.secondDate.get(invoice)).toBe('2026-10-25');
    expect(INVOICE_FORM_KIND.secondDate.set).toBe(withDueDate);
    expect(INVOICE_FORM_KIND.secondDate.set(invoice, '2026-12-01')).toEqual({ ...invoice, due_date: '2026-12-01', dueEdited: true });
  });
  it('stops following the date once it is set through the card, as it always did', () => {
    const invoice = INVOICE_FORM_KIND.secondDate.set(newInvoiceForm(today, 'k1'), '2026-12-01');
    expect(INVOICE_FORM_KIND.withDate(invoice, '2026-10-20', 14).due_date).toBe('2026-12-01');
    const bill = BILL_FORM_KIND.secondDate.set(newBillForm(today, 'k1'), '2026-12-01');
    expect(BILL_FORM_KIND.withDate(bill, '2026-10-20', 30).due_date).toBe('2026-12-01');
  });
});

describe('the words of a document form', () => {
  it('are the posting words on a bill and an invoice, exactly as the card has always said them', () => {
    expect(BILL_FORM_KIND.words).toBeUndefined();
    expect(INVOICE_FORM_KIND.words).toBeUndefined();
    expect(documentFormWords(BILL_FORM_KIND)).toBe(POSTING_WORDS);
    expect(documentFormWords(INVOICE_FORM_KIND)).toEqual({
      newSubtitle: 'Saved as a draft until it is posted',
      draftSubtitle: 'A draft: it gets its number when it is posted',
      post: 'Save and post',
      posting: 'Posting…',
    });
  });
  it('are a kind’s own words when it has them', () => {
    const words = { newSubtitle: 'a', draftSubtitle: 'b', post: 'c', posting: 'd' };
    expect(documentFormWords({ words })).toBe(words);
    expect(documentFormWords({})).toBe(POSTING_WORDS);
  });
});

describe('the shared form card', () => {
  it('has none of the words that belong to a kind, so they can only come from the kind', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/finance/document-form-card.tsx'), 'utf8');
    for (const word of ['Due date', 'Save and post', 'Posting…', 'it is posted']) expect(source, word).not.toContain(word);
  });
});
