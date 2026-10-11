import { describe, expect, it } from 'vitest';
import {
  type CreditNoteForm,
  creditNoteFormError,
  creditNoteFormFromRow,
  creditNotePayload,
  creditNoteSaved,
  creditNoteSavedNote,
  creditNoteSavedNotIssued,
  creditableInvoices,
  creditableLabel,
  newCreditNoteForm,
} from '@/lib/finance/credit-note-form';
import { type CreditNoteRow, saveCreditNoteInput } from '@/lib/finance/credit-notes';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { WRITE_FAILED } from '@/lib/finance/result';

const SENT = '11111111-1111-4111-8111-111111111111';
const PAID = '22222222-2222-4222-8222-222222222222';
const DRAFT_NOTE = '33333333-3333-4333-8333-333333333333';

const invoice = (i: Partial<InvoiceListRow> = {}): InvoiceListRow => ({
  id: SENT,
  invoice_no: 'INV-0007',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 0,
  credited: 0,
  refunded: 0,
  balance: 100,
  display_status: 'sent',
  einvoice_status: 'none',
  einvoice_uuid: null,
  ...i,
});

const form = (f: Partial<CreditNoteForm> = {}): CreditNoteForm => ({
  invoiceId: SENT,
  date: '2026-10-06',
  reason: 'returns',
  amount: '30',
  notes: '',
  ...f,
});

describe('creditableInvoices', () => {
  it('offers posted invoices only: sent, overdue or paid, never a draft or a void one', () => {
    const offered = creditableInvoices([
      invoice({ id: 'a', invoice_no: 'INV-0001', display_status: 'sent' }),
      invoice({ id: 'b', invoice_no: 'INV-0002', display_status: 'overdue' }),
      invoice({ id: 'c', invoice_no: 'INV-0003', display_status: 'paid', paid: 100, balance: 0 }),
      invoice({ id: 'd', invoice_no: null, display_status: 'draft' }),
      invoice({ id: 'e', invoice_no: 'INV-0005', display_status: 'void' }),
    ]);
    expect(offered.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
  it('offers the total less what is already credited, whatever has been paid', () => {
    // What was paid does not limit a credit note: crediting a paid invoice is what leaves the customer in credit.
    const [paid] = creditableInvoices([invoice({ id: PAID, display_status: 'paid', paid: 100, balance: 0 })]);
    expect(paid).toMatchObject({ total: 100, credited: 0, creditable: 100 });
    const [part] = creditableInvoices([invoice({ credited: 30.1, balance: 69.9 })]);
    expect(part.creditable).toBe(69.9);
    // To the sen: 0.3 − 0.1 is not 0.19999999999999998.
    expect(creditableInvoices([invoice({ total: 0.3, credited: 0.1, balance: 0.2 })])[0].creditable).toBe(0.2);
  });
  it('leaves out an invoice credited for its whole total, unless the form is on it', () => {
    const full = invoice({ id: PAID, credited: 100, balance: 0, display_status: 'paid' });
    expect(creditableInvoices([full])).toEqual([]);
    expect(creditableInvoices([full], PAID)).toMatchObject([{ id: PAID, creditable: 0 }]);
    // An invoice that was voided is not kept: a credit note cannot go against it at all.
    expect(creditableInvoices([invoice({ id: PAID, display_status: 'void' })], PAID)).toEqual([]);
    // More credited than billed can only come from a direct write; it is never offered as a negative amount.
    expect(creditableInvoices([invoice({ id: PAID, credited: 120 })], PAID)[0].creditable).toBe(0);
  });
  it('lists them by customer, then by number', () => {
    const offered = creditableInvoices([
      invoice({ id: 'z2', invoice_no: 'INV-0009', customer_name: 'Zaki Enterprise' }),
      invoice({ id: 'a2', invoice_no: 'INV-0008', customer_name: 'Aisyah Trading' }),
      invoice({ id: 'a1', invoice_no: 'INV-0002', customer_name: 'Aisyah Trading' }),
    ]);
    expect(offered.map((i) => i.id)).toEqual(['a1', 'a2', 'z2']);
  });
  it('orders numbers as numbers once they pass four digits: INV-9999 before INV-10000', () => {
    const offered = creditableInvoices([
      invoice({ id: 'late', invoice_no: 'INV-10000' }),
      invoice({ id: 'early', invoice_no: 'INV-9999' }),
      invoice({ id: 'first', invoice_no: 'INV-0002' }),
    ]);
    expect(offered.map((i) => i.invoice_no)).toEqual(['INV-0002', 'INV-9999', 'INV-10000']);
  });
  it('names an invoice in the picker with what it has left', () => {
    expect(creditableLabel(creditableInvoices([invoice({ total: 1240, credited: 240 })])[0])).toBe(
      'INV-0007 · Aisyah Trading · RM 1,000.00 left to credit',
    );
  });
});

describe('a new credit note form', () => {
  const offered = creditableInvoices([invoice()]);

  it('is dated today with nothing chosen and nothing typed', () => {
    expect(newCreditNoteForm(offered, '2026-10-09')).toEqual({ invoiceId: '', date: '2026-10-09', reason: '', amount: '', notes: '' });
  });
  it('opens on the invoice whose row it was started from, when that invoice can take a credit note', () => {
    expect(newCreditNoteForm(offered, '2026-10-09', SENT).invoiceId).toBe(SENT);
    expect(newCreditNoteForm(offered, '2026-10-09', PAID).invoiceId).toBe('');
    // The amount is the person's to type: a credit note is seldom for everything that is left.
    expect(newCreditNoteForm(offered, '2026-10-09', SENT).amount).toBe('');
  });
});

describe('a draft being changed', () => {
  const note: CreditNoteRow = {
    id: DRAFT_NOTE,
    credit_note_no: null,
    invoice_id: SENT,
    invoice_no: 'INV-0007',
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    credit_date: '2026-10-02',
    reason: 'pricing_adjustment',
    amount: 30.5,
    refunded: 0,
    status: 'draft',
    notes: null,
  };

  it('opens with what was saved, the amount as an amount box shows it', () => {
    expect(creditNoteFormFromRow(note)).toEqual({
      id: DRAFT_NOTE,
      invoiceId: SENT,
      date: '2026-10-02',
      reason: 'pricing_adjustment',
      amount: '30.50',
      notes: '',
    });
    expect(creditNoteFormFromRow({ ...note, notes: 'Two returned' }).notes).toBe('Two returned');
  });
  it('is sent with its id, so the draft is changed and no second one is made', () => {
    expect(creditNotePayload(creditNoteFormFromRow(note))).toEqual({
      id: DRAFT_NOTE,
      invoice_id: SENT,
      credit_date: '2026-10-02',
      reason: 'pricing_adjustment',
      amount: 30.5,
      notes: '',
    });
  });
});

describe('creditNotePayload', () => {
  it('sends the amount as a number, and no id for a new credit note', () => {
    expect(creditNotePayload(form({ amount: ' 30.50 ', notes: 'Two returned' }))).toEqual({
      invoice_id: SENT,
      credit_date: '2026-10-06',
      reason: 'returns',
      amount: 30.5,
      notes: 'Two returned',
    });
  });
  it('is what the write’s own schema accepts', () => {
    expect(saveCreditNoteInput.safeParse(creditNotePayload(form())).success).toBe(true);
  });
});

describe('creditNoteFormError', () => {
  const offered = creditableInvoices([invoice({ credited: 20, balance: 80 })], SENT);

  it('lets a form through that can be saved', () => {
    expect(creditNoteFormError(form(), offered)).toBeNull();
    // All that is left, to the sen.
    expect(creditNoteFormError(form({ amount: '80' }), offered)).toBeNull();
    expect(creditNoteFormError(form({ amount: '80.00' }), offered)).toBeNull();
  });
  it('asks for an invoice, a real date and a reason, in the schema’s own sentences', () => {
    expect(creditNoteFormError(form({ invoiceId: '' }), offered)).toBe('Choose the invoice this credit note is against.');
    expect(creditNoteFormError(form({ date: '2026-02-30' }), offered)).toBe('Enter a valid date.');
    expect(creditNoteFormError(form({ date: '' }), offered)).toBe('Enter a valid date.');
    expect(creditNoteFormError(form({ reason: '' }), offered)).toBe('Choose a reason.');
    expect(creditNoteFormError(form({ notes: 'x'.repeat(201) }), offered)).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('refuses an empty amount, nothing, and a figure typed with a comma', () => {
    for (const amount of ['', ' ', '0', '0.004', '-5', '1,200.50', 'abc']) {
      expect(creditNoteFormError(form({ amount }), offered), amount).toBe('Enter an amount above 0.');
    }
  });
  it('refuses a sen more than the invoice has left to credit, before the database is asked', () => {
    expect(creditNoteFormError(form({ amount: '80.01' }), offered)).toBe('That is more than this invoice has left to credit.');
    // Rounded to the sen first, as the schema rounds: 80.004 is 80.00.
    expect(creditNoteFormError(form({ amount: '80.004' }), offered)).toBeNull();
    expect(creditNoteFormError(form({ amount: '80.005' }), offered)).toBe('That is more than this invoice has left to credit.');
  });
  it('says so when the invoice was credited in full, or voided, while the form was open', () => {
    const full = creditableInvoices([invoice({ credited: 100, balance: 0, display_status: 'paid' })], SENT);
    expect(creditNoteFormError(form({ amount: '0.01' }), full)).toBe('That is more than this invoice has left to credit.');
    const voided = creditableInvoices([invoice({ display_status: 'void' })], SENT);
    expect(creditNoteFormError(form(), voided)).toBe('A credit note can only go against a posted invoice.');
  });
});

describe('the note that a credit note was saved', () => {
  // Aisyah's invoice, and one of another customer.
  const offered = creditableInvoices([
    invoice(),
    invoice({ id: PAID, invoice_no: 'INV-0009', customer_id: 'bakar', customer_name: 'Bakar Enterprise', display_status: 'paid', paid: 100, balance: 0 }),
  ]);

  it('names the invoice the form saved against when the person picked another than the row the card was opened from', () => {
    // Opened from INV-0007's row on Invoices, then "Against invoice" changed to another customer's invoice.
    const opened = newCreditNoteForm(offered, '2026-10-06', SENT);
    expect(opened.invoiceId).toBe(SENT);
    const changed: CreditNoteForm = { ...opened, invoiceId: PAID, reason: 'returns', amount: '25' };
    expect(creditNoteFormError(changed, offered)).toBeNull();

    const saved = creditNoteSaved(changed, offered, false);
    expect(saved).toEqual({ invoice_no: 'INV-0009', customer_name: 'Bakar Enterprise', amount: 25, issued: false });
    // What the note says is what was sent.
    expect(creditNotePayload(changed)).toMatchObject({ invoice_id: PAID, amount: 25 });
    const said = creditNoteSavedNote(saved!);
    expect(said).toEqual({
      title: 'Credit note saved',
      subtitle: 'INV-0009 to Bakar Enterprise',
      lead: 'A draft credit note of RM 25.00 was saved against INV-0009. It is issued, changed or deleted on',
    });
    expect(`${said.subtitle} ${said.lead}`).not.toMatch(/INV-0007|Aisyah/);
  });
  it('says so when the credit note was issued as well', () => {
    expect(creditNoteSavedNote(creditNoteSaved(form(), offered, true)!)).toEqual({
      title: 'Credit note issued',
      subtitle: 'INV-0007 to Aisyah Trading',
      // INV-0007 is still owed, so this credit note cannot be refunded: the note does not say it can.
      lead: 'A credit note of RM 30.00 was issued against INV-0007. It can be voided, or refunded while the customer is in credit, on',
    });
  });
  it('states the amount as it was stored, rounded to the sen as the schema rounds it', () => {
    // 1.005 is stored as RM 1.00 and 1.255 as RM 1.25: the note says the same, not a sen more.
    const saved = creditNoteSaved(form({ amount: '1.005' }), offered, false)!;
    expect(saved.amount).toBe(1);
    expect(saved.amount).toBe(saveCreditNoteInput.parse(creditNotePayload(form({ amount: '1.005' }))).amount);
    expect(creditNoteSavedNote(saved).lead).toBe('A draft credit note of RM 1.00 was saved against INV-0007. It is issued, changed or deleted on');
    expect(creditNoteSaved(form({ amount: '1.255' }), offered, true)!.amount).toBe(1.25);
  });
  it('has nothing to say of a form whose invoice is not offered, or with no amount', () => {
    expect(creditNoteSaved(form({ invoiceId: DRAFT_NOTE }), offered, false)).toBeNull();
    expect(creditNoteSaved(form({ amount: '' }), offered, false)).toBeNull();
  });
});

describe('creditNoteSavedNotIssued', () => {
  it('says the draft was kept, and why it was not issued', () => {
    expect(creditNoteSavedNotIssued('That is more than this invoice has left to credit.')).toBe(
      'The credit note was saved as a draft, but it was not issued. That is more than this invoice has left to credit.',
    );
  });
  it('does not repeat the general failure sentence', () => {
    expect(creditNoteSavedNotIssued(WRITE_FAILED)).toBe('The credit note was saved as a draft, but issuing it failed. Please try again.');
  });
});
