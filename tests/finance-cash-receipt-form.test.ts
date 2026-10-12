import { describe, expect, it } from 'vitest';
import type { CashReceiptRow } from '@/lib/finance/cash-book';
import {
  cashReceiptActions,
  receiptDeleteEffect,
  receiptName,
  receiptVoidEffect,
} from '@/lib/finance/cash-book-views';
import {
  type CashReceiptForm,
  TYPED_PAYER,
  afterRefusedReceiptSave,
  cashReceiptFormError,
  cashReceiptPayload,
  cashReceiptTotal,
  chooseReceiptCustomer,
  editCashReceiptForm,
  keepReceiptInvoices,
  leftOutInvoicesNote,
  newCashReceiptForm,
  receiptInvoicesForForm,
  receiptPaymentsForForm,
  receiptSavedNotPosted,
  receivableFor,
  toggleAllReceiptInvoices,
  toggleReceiptInvoice,
  withCurrent,
} from '@/lib/finance/cash-receipt-form';
import { saveCashReceiptInput } from '@/lib/finance/cash-receipts';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { FinanceAccount, PaymentInRow } from '@/lib/finance/money';

const AISYAH = '11111111-1111-4111-8111-111111111111';
const ZAKI = '22222222-2222-4222-8222-222222222222';
const BANK = '66666666-6666-4666-8666-666666666666';
const TILL = '77777777-7777-4777-8777-777777777777';
const SALES = '99999999-9999-4999-8999-999999999999';
const OTHER = '99999999-9999-4999-8999-000000000002';
const DRAFT = '55555555-5555-4555-8555-555555555555';
const today = '2026-10-12';

/** 1 → a valid uuid ending in 000000000001. */
const invoiceId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

const invoice = (n: number, i: Partial<InvoiceListRow> = {}): InvoiceListRow => ({
  id: invoiceId(n),
  invoice_no: `INV-${String(n).padStart(4, '0')}`,
  customer_id: AISYAH,
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

/** One row of Payments In: what one payment puts against one invoice. */
const paid = (n: number, p: Partial<PaymentInRow> = {}): PaymentInRow => ({
  allocation_id: `alloc-${n}-${p.transaction_id ?? 'txn'}`,
  transaction_id: 'txn',
  number: null,
  txn_date: '2026-10-05',
  method: 'fpx',
  amount: 100,
  transaction_amount: 100,
  status: 'draft',
  reference: null,
  account_id: BANK,
  account_name: 'Main Bank',
  invoice_id: invoiceId(n),
  invoice_no: `INV-${String(n).padStart(4, '0')}`,
  customer_name: 'Aisyah Trading',
  ...p,
});

const receipt = (r: Partial<CashReceiptRow> = {}): CashReceiptRow => ({
  transaction_id: DRAFT,
  number: null,
  txn_date: '2026-10-05',
  method: 'cash',
  amount: 50,
  status: 'draft',
  reference: null,
  notes: null,
  account_id: TILL,
  account_name: 'Cash in Hand',
  account_kind: 'cash',
  contact_id: null,
  party_name: 'Walk-in',
  kind: 'income',
  category_id: SALES,
  category_name: 'Sales',
  documents: null,
  ...r,
});

const accounts: FinanceAccount[] = [
  { id: TILL, name: 'Cash in Hand', kind: 'cash', bank_name: null },
  { id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank' },
];
const categories = [{ id: OTHER, name: 'Other income' }, { id: SALES, name: 'Sales' }];

const incomeForm = (f: Partial<CashReceiptForm> = {}): CashReceiptForm => ({
  ...newCashReceiptForm(accounts, categories, today),
  categoryId: SALES,
  amount: '50',
  ...f,
});
const invoiceForm = (f: Partial<CashReceiptForm> = {}): CashReceiptForm => ({
  ...newCashReceiptForm(accounts, categories, today),
  kind: 'invoice',
  customerId: AISYAH,
  amounts: { [invoiceId(1)]: '100.00' },
  ...f,
});

describe('a new form', () => {
  it('is for other income, into the first bank account, by bank transfer, dated with the date it is given', () => {
    expect(newCashReceiptForm(accounts, categories, today)).toEqual({
      kind: 'income', customerId: '', amounts: {}, payer: TYPED_PAYER, payerName: '', categoryId: '', amount: '',
      accountId: BANK, date: today, method: 'bank_transfer', reference: '', notes: '',
    });
  });
  it('chooses the category when there is only one, and no account when there is none', () => {
    expect(newCashReceiptForm([], [categories[1]], today)).toMatchObject({ categoryId: SALES, accountId: '' });
  });
});

describe('the form for a draft being changed', () => {
  it('holds a receipt for income as it was saved: a typed payer', () => {
    expect(editCashReceiptForm(receipt({ reference: 'R-1', notes: 'counter' }), [])).toEqual({
      id: DRAFT, kind: 'income', customerId: '', amounts: {}, payer: TYPED_PAYER, payerName: 'Walk-in',
      categoryId: SALES, amount: '50.00', accountId: TILL, date: '2026-10-05', method: 'cash', reference: 'R-1', notes: 'counter',
    });
  });
  it('holds a contact as the payer by its id, never by the name the view shows for it', () => {
    const form = editCashReceiptForm(receipt({ contact_id: ZAKI, party_name: 'Zaki Enterprise' }), []);
    expect(form).toMatchObject({ payer: ZAKI, payerName: '' });
    expect(cashReceiptPayload(form)).toMatchObject({ contact_id: ZAKI, party_name: null });
  });
  it('holds nobody as an empty typed name', () => {
    expect(editCashReceiptForm(receipt({ party_name: null }), [])).toMatchObject({ payer: TYPED_PAYER, payerName: '' });
  });
  it('holds a receipt for invoices as its customer and its split, read from its Payments In rows', () => {
    const row = receipt({ kind: 'invoice', contact_id: AISYAH, party_name: 'Aisyah Trading', category_id: null, category_name: null, amount: 130, documents: 'INV-0001, INV-0002' });
    const payments = [
      paid(1, { transaction_id: DRAFT, amount: 100 }),
      paid(2, { transaction_id: DRAFT, amount: 30 }),
      paid(3, { transaction_id: 'another', amount: 5 }),
    ];
    expect(editCashReceiptForm(row, payments)).toMatchObject({
      id: DRAFT, kind: 'invoice', customerId: AISYAH,
      amounts: { [invoiceId(1)]: '100.00', [invoiceId(2)]: '30.00' },
      payer: TYPED_PAYER, payerName: '', categoryId: '', amount: '',
    });
  });
});

describe('which invoices a receipt can go against', () => {
  const invoices = [invoice(1), invoice(2, { balance: 40 }), invoice(3, { display_status: 'draft' }), invoice(4, { display_status: 'paid', balance: 0 })];
  it('offers posted invoices that still owe, less what receipts not yet posted hold', () => {
    const receivable = receivableFor(invoices, [paid(1, { transaction_id: 'other-draft', amount: 60 })]);
    expect(receivable.map((i) => [i.invoice_no, i.payable, i.held])).toEqual([['INV-0001', 40, 60], ['INV-0002', 40, 0]]);
  });
  it('does not count the draft being changed against its own invoices', () => {
    const payments = [paid(1, { transaction_id: DRAFT, amount: 100 }), paid(2, { transaction_id: 'other-draft', amount: 10 })];
    // To anyone else, INV-0001 is fully held and is not offered at all.
    expect(receivableFor(invoices, payments).map((i) => [i.invoice_no, i.payable])).toEqual([['INV-0002', 30]]);
    expect(receivableFor(invoices, payments, DRAFT).map((i) => [i.invoice_no, i.payable])).toEqual([['INV-0001', 100], ['INV-0002', 30]]);
  });
});

describe('ticking invoices', () => {
  const receivable = receivableFor([invoice(1), invoice(2, { balance: 40 }), invoice(5, { customer_id: ZAKI, customer_name: 'Zaki Enterprise' })], []);
  it('ticks an invoice for all it can take, unticks it, ticks all and clears all, keeping every other field', () => {
    const start = invoiceForm({ amounts: {}, notes: 'kept' });
    const one = toggleReceiptInvoice(start, receivable[1], true);
    expect(one).toMatchObject({ amounts: { [invoiceId(2)]: '40.00' }, notes: 'kept', kind: 'invoice' });
    expect(toggleReceiptInvoice(one, receivable[1], false).amounts).toEqual({});
    const all = toggleAllReceiptInvoices(start, receivable.slice(0, 2), true);
    expect(all.amounts).toEqual({ [invoiceId(1)]: '100.00', [invoiceId(2)]: '40.00' });
    expect(cashReceiptTotal(all)).toBe(140);
    expect(toggleAllReceiptInvoices(all, receivable.slice(0, 2), false).amounts).toEqual({});
  });
  it('starts the ticks again when another customer is chosen, and changes nothing when the same one is', () => {
    const form = invoiceForm();
    expect(chooseReceiptCustomer(form, AISYAH)).toBe(form);
    expect(chooseReceiptCustomer(form, ZAKI)).toMatchObject({ customerId: ZAKI, amounts: {} });
  });
  it('drops a ticked invoice that is no longer offered, and is the same form when nothing goes', () => {
    const form = invoiceForm({ amounts: { [invoiceId(1)]: '100.00', [invoiceId(9)]: '5.00' } });
    expect(keepReceiptInvoices(form, receivable).amounts).toEqual({ [invoiceId(1)]: '100.00' });
    const kept = invoiceForm();
    expect(keepReceiptInvoices(kept, receivable)).toBe(kept);
  });
});

describe('the total', () => {
  it('is the amount box for income, and nothing while that is not a number above 0', () => {
    expect(cashReceiptTotal(incomeForm({ amount: '50.5' }))).toBe(50.5);
    expect(cashReceiptTotal(incomeForm({ amount: '' }))).toBe(0);
    expect(cashReceiptTotal(incomeForm({ amount: '1,200.50' }))).toBe(0);
    expect(cashReceiptTotal(incomeForm({ amount: '-3' }))).toBe(0);
  });
  it('is the ticked amounts for invoices, whatever the amount box of the other side holds', () => {
    expect(cashReceiptTotal(invoiceForm({ amount: '999', amounts: { [invoiceId(1)]: '60.10', [invoiceId(2)]: '0.20' } }))).toBe(60.3);
  });
});

describe('what is sent', () => {
  it('sends a receipt for income its category, amount and typed payer, and nothing of the other side', () => {
    const payload = cashReceiptPayload(incomeForm({ payerName: ' Walk-in ', customerId: AISYAH, amounts: { [invoiceId(1)]: '5' } }));
    expect(payload).toEqual({
      kind: 'income', account_id: BANK, txn_date: today, method: 'bank_transfer', reference: '', notes: '',
      category_id: SALES, amount: 50, contact_id: null, party_name: ' Walk-in ',
    });
    expect(saveCashReceiptInput.parse(payload)).toMatchObject({ party_name: 'Walk-in', contact_id: null });
  });
  it('sends a contact as the payer and drops a name typed before the contact was chosen', () => {
    const payload = cashReceiptPayload(incomeForm({ payer: ZAKI, payerName: 'left over' }));
    expect(payload).toMatchObject({ contact_id: ZAKI, party_name: null });
    expect(saveCashReceiptInput.safeParse(payload).success).toBe(true);
  });
  it('sends a receipt for invoices its split, and no amount, payer or category', () => {
    const payload = cashReceiptPayload(invoiceForm({ amount: '999', categoryId: SALES, payer: ZAKI, amounts: { [invoiceId(1)]: '60.10', [invoiceId(2)]: '0.2' } }));
    expect(payload).toEqual({
      kind: 'invoice', account_id: BANK, txn_date: today, method: 'bank_transfer', reference: '', notes: '',
      allocations: [{ invoice_id: invoiceId(1), amount: 60.1 }, { invoice_id: invoiceId(2), amount: 0.2 }],
    });
  });
  it('sends the id of a draft being changed, and none for a new receipt', () => {
    expect(cashReceiptPayload(incomeForm({ id: DRAFT }))).toMatchObject({ id: DRAFT });
    expect('id' in cashReceiptPayload(incomeForm())).toBe(false);
  });
  it('sends an amount that is not a number as NaN, which the schema refuses', () => {
    const payload = cashReceiptPayload(incomeForm({ amount: '1,200.50' }));
    expect(Number.isNaN((payload as { amount: number }).amount)).toBe(true);
    expect(saveCashReceiptInput.safeParse(payload).success).toBe(false);
  });
});

describe('what is wrong with the form', () => {
  const receivable = receivableFor([invoice(1), invoice(2, { balance: 40 })], []);
  it('passes a complete receipt of either kind', () => {
    expect(cashReceiptFormError(incomeForm(), receivable)).toBeNull();
    expect(cashReceiptFormError(incomeForm({ payerName: '' }), receivable)).toBeNull();
    expect(cashReceiptFormError(invoiceForm(), receivable)).toBeNull();
  });
  it('asks a receipt for income for a category first, then an amount, then the rest', () => {
    expect(cashReceiptFormError(incomeForm({ categoryId: '', amount: '' }), receivable)).toBe('Choose an income category.');
    expect(cashReceiptFormError(incomeForm({ amount: '' }), receivable)).toBe('Enter an amount above 0.');
    expect(cashReceiptFormError(incomeForm({ amount: '1,200.50' }), receivable)).toBe('Enter an amount above 0.');
    expect(cashReceiptFormError(incomeForm({ amount: '0.004' }), receivable)).toBe('Enter an amount above 0.');
    expect(cashReceiptFormError(incomeForm({ accountId: '' }), receivable)).toBe('Choose the account the money went into.');
    expect(cashReceiptFormError(incomeForm({ date: '' }), receivable)).toBe('Enter a valid date.');
    expect(cashReceiptFormError(incomeForm({ payerName: 'x'.repeat(201) }), receivable)).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('is not held up by what the other side holds', () => {
    expect(cashReceiptFormError(incomeForm({ customerId: '', amounts: { [invoiceId(9)]: 'abc' } }), receivable)).toBeNull();
    expect(cashReceiptFormError(invoiceForm({ categoryId: '', amount: 'abc', payerName: 'x'.repeat(300) }), receivable)).toBeNull();
  });
  it('asks a receipt for invoices for a customer, then an invoice, then amounts each can take', () => {
    expect(cashReceiptFormError(invoiceForm({ customerId: '' }), receivable)).toBe('Choose a customer.');
    expect(cashReceiptFormError(invoiceForm({ amounts: {} }), receivable)).toBe('Choose at least one invoice this receipt is for.');
    expect(cashReceiptFormError(invoiceForm({ amounts: { [invoiceId(1)]: '' } }), receivable)).toBe('Enter an amount above 0.');
    expect(cashReceiptFormError(invoiceForm({ amounts: { [invoiceId(2)]: '40.01' } }), receivable)).toBe(
      'That is more than is still owed on an invoice, counting what other receipts not yet posted already hold.',
    );
    // Ticked, then paid off in another tab: no longer among the customer's invoices.
    expect(cashReceiptFormError(invoiceForm({ amounts: { [invoiceId(9)]: '1' } }), receivable)).toBe(
      'That is more than is still owed on an invoice, counting what other receipts not yet posted already hold.',
    );
    expect(cashReceiptFormError(invoiceForm({ accountId: '' }), receivable)).toBe('Choose the account the money went into.');
  });
});

describe('a picker’s list with the draft’s own choice', () => {
  const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  it('is the same list when there is no draft, or its choice is already offered', () => {
    expect(withCurrent(list)).toBe(list);
    expect(withCurrent(list, null)).toBe(list);
    expect(withCurrent(list, { id: 'b', name: 'B as it was' })).toBe(list);
  });
  it('puts a choice that is no longer offered first', () => {
    expect(withCurrent(list, { id: 'z', name: 'Archived' })).toEqual([{ id: 'z', name: 'Archived' }, ...list]);
  });
});

describe('saved but not posted', () => {
  it('says the draft was kept and why it was not posted', () => {
    expect(receiptSavedNotPosted('That is more than is still owed on an invoice.')).toBe(
      'The receipt was saved as a draft, but it was not posted. That is more than is still owed on an invoice.',
    );
    expect(receiptSavedNotPosted('That change could not be saved. Please try again.')).toBe(
      'The receipt was saved as a draft, but posting it failed. Please try again.',
    );
    expect(receiptSavedNotPosted('Saved as a draft. Only an owner or admin can post or issue it.')).toBe(
      'The receipt was saved as a draft. Only an owner or admin can post it.',
    );
  });
});

describe('what a row’s menu offers', () => {
  const statuses = ['draft', 'pending_approval', 'scheduled', 'posted', 'rejected', 'void'] as const;
  it('offers an owner or admin Edit, Post and Delete on a draft and Void on a posted receipt, of either kind', () => {
    for (const kind of ['income', 'invoice'] as const) {
      expect(statuses.map((status) => cashReceiptActions(receipt({ status, kind }), true))).toEqual([
        ['edit', 'post', 'delete'], [], [], ['void'], [], [],
      ]);
    }
  });
  it('offers anyone else who may write Edit and Delete on a draft, and nothing that the database keeps to an owner or admin', () => {
    for (const kind of ['income', 'invoice'] as const) {
      expect(statuses.map((status) => cashReceiptActions(receipt({ status, kind }), false))).toEqual([
        ['edit', 'delete'], [], [], [], [], [],
      ]);
    }
  });
  it('names a receipt by its number and payer, and a draft as a draft', () => {
    expect(receiptName(receipt({ status: 'posted', number: 'RC-0007', party_name: 'Aiman' }))).toBe('RC-0007 from Aiman');
    expect(receiptName(receipt())).toBe('the draft receipt from Walk-in');
    expect(receiptName(receipt({ party_name: null }))).toBe('the draft receipt');
    expect(receiptName(receipt({ status: 'posted', party_name: null }))).toBe('the receipt');
  });
  it('says what voiding and deleting do, by what the receipt is for', () => {
    expect(receiptVoidEffect(receipt({ kind: 'invoice' }))).toBe('The invoices it paid will owe that amount again.');
    expect(receiptVoidEffect(receipt())).toBe('It will no longer count as money received.');
    expect(receiptDeleteEffect(receipt({ kind: 'invoice' }))).toBe('What it holds of its invoices is freed. ');
    expect(receiptDeleteEffect(receipt())).toBe('');
  });
});

describe('what the browser is sent for the form', () => {
  const invoices = [
    invoice(1),
    invoice(2, { display_status: 'overdue' }),
    invoice(3, { display_status: 'draft' }),
    invoice(4, { display_status: 'paid', balance: 0 }),
    invoice(5, { display_status: 'void' }),
    invoice(6, { display_status: 'sent', balance: 0 }),
  ];
  it('keeps the invoices that can still take money: posted, with a balance', () => {
    expect(receiptInvoicesForForm(invoices).map((i) => i.invoice_no)).toEqual(['INV-0001', 'INV-0002']);
  });
  it('keeps the payment rows that hold part of an invoice without being posted', () => {
    const rows = ['draft', 'pending_approval', 'scheduled', 'posted', 'void', 'rejected'].map((status, n) =>
      paid(n + 1, { status: status as PaymentInRow['status'] }),
    );
    expect(receiptPaymentsForForm(rows).map((p) => p.status)).toEqual(['draft', 'pending_approval', 'scheduled']);
  });
  it('changes nothing the form offers or holds, including for a draft being changed', () => {
    const everything = [invoice(1), invoice(2, { balance: 40 }), invoice(3, { display_status: 'draft' }), invoice(4, { display_status: 'paid', balance: 0 })];
    const payments = [
      paid(1, { transaction_id: DRAFT, amount: 100 }),
      paid(2, { transaction_id: 'other-draft', amount: 10 }),
      paid(4, { transaction_id: 'posted-one', status: 'posted', amount: 100 }),
    ];
    const sentInvoices = receiptInvoicesForForm(everything);
    const sentPayments = receiptPaymentsForForm(payments);
    for (const editingId of [undefined, DRAFT]) {
      expect(receivableFor(sentInvoices, sentPayments, editingId)).toEqual(receivableFor(everything, payments, editingId));
    }
    // The draft's own invoice is offered while it is being changed, though no one else can take it.
    expect(receivableFor(sentInvoices, sentPayments, DRAFT).map((i) => i.invoice_no)).toContain('INV-0001');
    const row = receipt({ kind: 'invoice', contact_id: AISYAH, party_name: 'Aisyah Trading', category_id: null, category_name: null, amount: 100 });
    expect(editCashReceiptForm(row, sentPayments)).toEqual(editCashReceiptForm(row, payments));
  });
});

describe('a new form for invoices', () => {
  it('chooses the customer when exactly one has open invoices', () => {
    const one = receivableFor([invoice(1), invoice(2)], []);
    expect(newCashReceiptForm(accounts, categories, today, one).customerId).toBe(AISYAH);
  });
  it('leaves the customer to the person when several have, or none has', () => {
    const several = receivableFor([invoice(1), invoice(5, { customer_id: ZAKI, customer_name: 'Zaki Enterprise' })], []);
    expect(newCashReceiptForm(accounts, categories, today, several).customerId).toBe('');
    expect(newCashReceiptForm(accounts, categories, today, []).customerId).toBe('');
    expect(newCashReceiptForm(accounts, categories, today).customerId).toBe('');
  });
});

describe('a draft whose ticked invoice can no longer take money', () => {
  const receivable = receivableFor([invoice(1)], []);
  it('says so in one sentence for one invoice, and for several, on a saved draft', () => {
    expect(leftOutInvoicesNote(invoiceForm({ id: DRAFT, amounts: { [invoiceId(1)]: '10', [invoiceId(9)]: '5' } }), receivable)).toBe(
      'An invoice ticked on this draft can no longer take money, so it has been left out.',
    );
    expect(leftOutInvoicesNote(invoiceForm({ id: DRAFT, amounts: { [invoiceId(8)]: '10', [invoiceId(9)]: '5' } }), receivable)).toBe(
      '2 invoices ticked on this draft can no longer take money, so they have been left out.',
    );
  });
  it('does not say "this draft" on a new receipt that was never saved', () => {
    expect(leftOutInvoicesNote(invoiceForm({ amounts: { [invoiceId(1)]: '10', [invoiceId(9)]: '5' } }), receivable)).toBe(
      'An invoice you ticked can no longer take money, so it has been left out.',
    );
    expect(leftOutInvoicesNote(invoiceForm({ amounts: { [invoiceId(8)]: '10', [invoiceId(9)]: '5' } }), receivable)).toBe(
      '2 invoices you ticked can no longer take money, so they have been left out.',
    );
  });
  it('says nothing when every ticked invoice is still offered, or none is ticked', () => {
    expect(leftOutInvoicesNote(invoiceForm(), receivable)).toBeNull();
    expect(leftOutInvoicesNote(invoiceForm({ amounts: {} }), receivable)).toBeNull();
  });
});

describe('a draft that someone deleted while it was being changed', () => {
  it('offers to save what was typed as a new receipt: the form forgets the id and the sentence says so', () => {
    const form = incomeForm({ id: DRAFT, notes: 'kept' });
    const after = afterRefusedReceiptSave(form, 'That receipt no longer exists.');
    expect(after.error).toBe('That receipt no longer exists. Save again to record it as a new receipt.');
    expect(after.form).toMatchObject({ notes: 'kept', amount: '50' });
    expect(after.form.id).toBeUndefined();
    expect(cashReceiptPayload(after.form)).not.toHaveProperty('id');
  });
  it('leaves the form and the sentence alone for any other refusal, and for a form with no id', () => {
    const form = incomeForm({ id: DRAFT });
    expect(afterRefusedReceiptSave(form, 'Enter an amount above 0.')).toEqual({ form, error: 'Enter an amount above 0.' });
    const fresh = incomeForm();
    expect(afterRefusedReceiptSave(fresh, 'That receipt no longer exists.')).toEqual({ form: fresh, error: 'That receipt no longer exists.' });
  });
});
