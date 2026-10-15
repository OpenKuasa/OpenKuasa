import { describe, expect, it } from 'vitest';
import {
  CONTRA_FORM_MESSAGES,
  amountFromSides,
  chooseContraContact,
  contraFormError,
  contraFormFromRow,
  contraFormSides,
  contraHiddenNote,
  contraOwedLine,
  contraParties,
  contraPostQuestion,
  contraSidesLine,
  contraStats,
  contraVoidQuestion,
  contrasCsv,
  droppedLinesNote,
  filterContras,
  newContraForm,
  submitContra,
  toggleContraDocument,
  typedContraAmount,
} from '@/lib/finance/contra-form';
import { CONTRA_MESSAGES, type ContraContact, type ContraRow, saveContraInput } from '@/lib/finance/contras';
import type { PayableBill } from '@/lib/finance/payment-form';
import type { ReceivableInvoice } from '@/lib/finance/receipt-form';

const LIM = '11111111-1111-4111-8111-111111111111';
const TAN = '22222222-2222-4222-8222-222222222222';
const ONLY_CUSTOMER = '33333333-3333-4333-8333-333333333333';
const INV_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const INV_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const BILL_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CONTRA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const contact = (id: string, name: string, extra: Partial<ContraContact> = {}): ContraContact => ({
  id, name, is_customer: true, is_supplier: true, active: true, ...extra,
});
const invoice = (id: string, customer: string, no: string, balance: number, held = 0): ReceivableInvoice => ({
  id, invoice_no: no, customer_id: customer, customer_name: '', due_date: '2026-10-31', overdue: false, balance, held, payable: balance - held,
});
const bill = (id: string, supplier: string, no: string, balance: number, scheduled = 0): PayableBill => ({
  id, bill_no: no, supplier_id: supplier, supplier_name: '', purchase_order_id: null, due_date: '2026-10-20', overdue: true, balance, scheduled, payable: balance - scheduled,
});

const contacts = [contact(TAN, 'Tan & Sons'), contact(LIM, 'Lim Hardware'), contact(ONLY_CUSTOMER, 'Aisyah', { is_supplier: false })];
const invoices = [invoice(INV_1, LIM, 'INV-0001', 132.5), invoice(INV_2, LIM, 'INV-0002', 50, 20), invoice('x', ONLY_CUSTOMER, 'INV-0009', 10)];
const bills = [bill(BILL_1, LIM, 'BILL-0001', 100, 30)];
const parties = contraParties(contacts, invoices, bills);

const row = (extra: Partial<ContraRow> = {}): ContraRow => ({
  id: CONTRA,
  contra_no: null,
  contra_date: '2026-10-10',
  contact_id: LIM,
  contact_name: 'Lim Hardware',
  amount: 70,
  reference: 'Agreed by phone',
  notes: null,
  status: 'draft',
  posted_at: null,
  voided_at: null,
  invoices: [{ id: 'l1', kind: 'invoice', document_id: INV_1, document_no: 'INV-0001', amount: 70 }],
  bills: [{ id: 'l2', kind: 'bill', document_id: BILL_1, document_no: 'BILL-0001', amount: 70 }],
  ...extra,
});

describe('who and what a contra entry can set off', () => {
  it('offers only active contacts who are both a customer and a supplier with an invoice and a bill to set off', () => {
    expect(parties.map((p) => p.name)).toEqual(['Lim Hardware']);
    expect(contraParties([...contacts, contact('z', 'Gone Sdn Bhd', { active: false })], invoices, bills).map((p) => p.id)).toEqual([LIM]);
  });

  it('offers each document for what it owes less what payments not yet posted hold of it', () => {
    const [lim] = parties;
    expect(lim.invoices.map((d) => [d.number, d.payable])).toEqual([['INV-0001', 132.5], ['INV-0002', 30]]);
    expect(lim.bills.map((d) => [d.number, d.held, d.payable])).toEqual([['BILL-0001', 30, 70]]);
    expect(contraOwedLine(lim.invoices[0])).toBe('RM 132.50 owed · due 31 Oct 2026');
    expect(contraOwedLine(lim.bills[0])).toBe('RM 70.00 can be set off (RM 100.00 owed, RM 30.00 in payments not yet posted) · due 20 Oct 2026, overdue');
  });

  it('keeps the contact of a draft being edited even when it has nothing left to set off', () => {
    expect(contraParties(contacts, [], [], [TAN]).map((p) => p.id)).toEqual([TAN]);
    expect(contraParties(contacts, [], []).map((p) => p.id)).toEqual([]);
  });
});

describe('the contra form', () => {
  it('starts dated today, with the only contact chosen', () => {
    expect(newContraForm('2026-10-16', parties)).toEqual({
      contactId: LIM, date: '2026-10-16', amount: '', reference: '', notes: '', invoices: {}, bills: {},
    });
    expect(newContraForm('2026-10-16', []).contactId).toBe('');
  });

  it('ticks a document for what its side still lacks of the amount, or all it can take', () => {
    const [lim] = parties;
    let form = { ...newContraForm('2026-10-16', parties), amount: '150' };
    form = toggleContraDocument(form, 'invoices', lim.invoices[0], true);
    expect(form.invoices).toEqual({ [INV_1]: '132.50' });
    form = toggleContraDocument(form, 'invoices', lim.invoices[1], true);
    expect(form.invoices[INV_2]).toBe('17.50');
    form = toggleContraDocument(form, 'bills', lim.bills[0], true);
    expect(form.bills).toEqual({ [BILL_1]: '70.00' });
    expect(toggleContraDocument(form, 'invoices', lim.invoices[0], false).invoices).toEqual({ [INV_2]: '17.50' });
  });

  it('starts the documents again when another contact is chosen', () => {
    const form = { ...newContraForm('2026-10-16', parties), invoices: { [INV_1]: '1' } };
    expect(chooseContraContact(form, TAN)).toMatchObject({ contactId: TAN, invoices: {}, bills: {} });
    expect(chooseContraContact(form, LIM)).toBe(form);
  });

  it('shows each side against the amount, in sen', () => {
    const form = { ...newContraForm('2026-10-16', parties), amount: '0.3', invoices: { [INV_1]: '0.1', [INV_2]: '0.2' }, bills: { [BILL_1]: '0.3' } };
    expect(contraFormSides(form)).toMatchObject({ invoiceSide: 0.3, billSide: 0.3, ready: true });
    expect(contraSidesLine({ ...form, bills: { [BILL_1]: '0.25' } })).toBe('Invoices RM 0.30 of RM 0.30 · Bills RM 0.25 of RM 0.30');
    expect(amountFromSides({ ...form, amount: '', invoices: { [INV_1]: '80' }, bills: { [BILL_1]: '70' } }).amount).toBe('70.00');
  });

  it('lets a draft be saved unfinished, and asks for balanced sides only to post', () => {
    const form = { ...newContraForm('2026-10-16', parties), amount: '70', invoices: { [INV_1]: '70' } };
    expect(contraFormError(form, parties, false)).toBeNull();
    expect(contraFormError(form, parties, true)).toBe(CONTRA_MESSAGES.unbalanced);
    expect(contraFormError({ ...form, bills: { [BILL_1]: '70' } }, parties, true)).toBeNull();
  });

  it('refuses, in order, a missing contact, a bad date, an amount not above zero and a line over what it can take', () => {
    const form = { ...newContraForm('2026-10-16', parties), amount: '70' };
    expect(contraFormError({ ...form, contactId: '' }, parties, false)).toBe(CONTRA_MESSAGES.contact);
    expect(contraFormError({ ...form, date: '2026-02-30' }, parties, false)).toBe(CONTRA_MESSAGES.date);
    expect(contraFormError({ ...form, amount: '0' }, parties, false)).toBe(CONTRA_MESSAGES.amount);
    expect(contraFormError({ ...form, amount: '1,200' }, parties, false)).toBe(CONTRA_MESSAGES.amount);
    expect(contraFormError(typedContraAmount(form, 'bills', BILL_1, '70.01'), parties, false)).toBe(CONTRA_FORM_MESSAGES.tooMuch);
    expect(contraFormError(typedContraAmount(form, 'invoices', INV_1, '0'), parties, false)).toBe(CONTRA_MESSAGES.amount);
    expect(contraFormError({ ...form, reference: 'x'.repeat(101) }, parties, false)).toBe(CONTRA_MESSAGES.reference);
  });

  it('sends what saveContraInput takes', () => {
    const form = { ...newContraForm('2026-10-16', parties), id: CONTRA, amount: '70', reference: ' Agreed ', invoices: { [INV_1]: '70' }, bills: { [BILL_1]: '70.00' } };
    const out = submitContra(form, parties, true);
    expect(out).toEqual({
      payload: {
        id: CONTRA, contact_id: LIM, contra_date: '2026-10-16', amount: 70, reference: ' Agreed ', notes: '',
        invoices: [{ invoice_id: INV_1, amount: 70 }], bills: [{ bill_id: BILL_1, amount: 70 }],
      },
    });
    expect(saveContraInput.safeParse((out as { payload: unknown }).payload).success).toBe(true);
    expect(submitContra({ ...form, amount: '' }, parties, false)).toEqual({ error: CONTRA_MESSAGES.amount });
  });

  it('opens a draft as it was saved, leaving out a line that can no longer be set off and saying so', () => {
    const { form, dropped } = contraFormFromRow(
      row({ invoices: [...row().invoices, { id: 'l3', kind: 'invoice', document_id: 'paid-off', document_no: 'INV-0005', amount: 5 }] }),
      parties,
    );
    expect(form).toEqual({
      id: CONTRA, contactId: LIM, date: '2026-10-10', amount: '70.00', reference: 'Agreed by phone', notes: '',
      invoices: { [INV_1]: '70.00' }, bills: { [BILL_1]: '70.00' },
    });
    expect(dropped).toEqual(['INV-0005']);
    expect(droppedLinesNote(dropped)).toBe(
      'INV-0005 can no longer be set off (paid, voided, or held by a payment since this draft was saved), so it was taken off the form. Save to keep the draft without it.',
    );
    expect(droppedLinesNote([])).toBeNull();
  });
});

describe('the contra list', () => {
  const rows = [
    row({ id: 'd', contra_no: null }),
    row({ id: 'p', contra_no: 'CT-0002', status: 'posted', contact_name: 'Tan & Sons', amount: 100.1 }),
    row({ id: 'p2', contra_no: 'CT-0001', status: 'posted', contra_date: '2026-09-30', amount: 5 }),
    row({ id: 'v', contra_no: 'CT-0003', status: 'void', reference: null }),
  ];

  it('filters by status and searches number, contact, reference and documents', () => {
    expect(filterContras(rows, '', 'posted').map((r) => r.id)).toEqual(['p', 'p2']);
    expect(filterContras(rows, 'tan', 'all').map((r) => r.id)).toEqual(['p']);
    expect(filterContras(rows, 'ct-0003', 'all').map((r) => r.id)).toEqual(['v']);
    expect(filterContras(rows, 'bill-0001', 'draft').map((r) => r.id)).toEqual(['d']);
    expect(filterContras(rows, 'phone', 'void')).toEqual([]);
  });

  it('counts this month’s posted ones, what they set off, and the drafts', () => {
    expect(contraStats(rows, '2026-10-16')).toEqual({ postedThisMonth: 1, setOffThisMonth: 100.1, drafts: 1 });
  });

  it('exports the table, with a formula-looking name made harmless', () => {
    expect(contrasCsv([row({ contra_no: 'CT-0001', status: 'posted', contact_name: '=cmd' })])).toBe(
      '﻿Date,No.,Contact,Invoices,Bills,Amount,Reference,Notes,Status\r\n' +
        "2026-10-10,CT-0001,'=cmd,INV-0001,BILL-0001,70,Agreed by phone,,Posted\r\n",
    );
  });

  it('asks before posting and voiding, saying what moves', () => {
    expect(contraPostQuestion(row())).toBe(
      'Post the draft for Lim Hardware? Together INV-0001 will owe RM 70.00 less, and so will BILL-0001; the books record the set-off. It gets its number and cannot be edited afterwards: a posted contra entry is undone by voiding it.',
    );
    expect(contraVoidQuestion(row({ contra_no: 'CT-0003', status: 'posted', amount: 100 }))).toBe(
      'Void CT-0003? Its invoices and bills owe again the RM 100.00 it set off on each side, and the books reverse it. This cannot be undone.',
    );
  });

  it('says where a row just written went when the list does not show it', () => {
    const written = { id: 'x', status: 'posted' as const, contact: 'Lim Hardware', amount: 70 };
    expect(contraHiddenNote(written, 'draft', false)).toBe(
      'The contra entry of RM 70.00 for Lim Hardware was posted. Choose Posted or All in the status filter to see it.',
    );
    expect(contraHiddenNote(written, 'posted', false)).toBe('The contra entry of RM 70.00 for Lim Hardware was posted. Clear the search to see it.');
    expect(contraHiddenNote(written, 'draft', true)).toBeNull();
  });
});
