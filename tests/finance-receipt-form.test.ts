import { describe, expect, it } from 'vitest';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { type FinanceAccount, type PaymentInRow, recordPaymentInInput } from '@/lib/finance/money';
import {
  PAYMENT_IN_KIND,
  type ReceiptForm,
  type ReceivableInvoice,
  chooseCustomer,
  heldByInvoice,
  invoicesOf,
  keepReceivable,
  newReceiptForm,
  receiptCustomers,
  receiptFormError,
  receiptPayload,
  receiptTotal,
  receivableInvoices,
  toggleAllInvoices,
  toggleInvoice,
} from '@/lib/finance/receipt-form';

const AISYAH = '11111111-1111-4111-8111-111111111111';
const ZAKI = '22222222-2222-4222-8222-222222222222';
const BANK = '66666666-6666-4666-8666-666666666666';
const CASH = '77777777-7777-4777-8777-777777777777';
const today = '2026-10-11';

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

const received = (n: number, p: Partial<PaymentInRow> = {}): PaymentInRow => ({
  allocation_id: `alloc-${n}-${p.status ?? 'posted'}-${p.amount ?? 100}`,
  transaction_id: `txn-${n}`,
  number: 'RC-0001',
  txn_date: '2026-10-05',
  method: 'fpx',
  amount: 100,
  transaction_amount: 100,
  status: 'posted',
  reference: null,
  account_id: BANK,
  account_name: 'Main Bank',
  invoice_id: invoiceId(n),
  invoice_no: `INV-${String(n).padStart(4, '0')}`,
  customer_name: 'Aisyah Trading',
  ...p,
});

const accounts: FinanceAccount[] = [
  { id: CASH, name: 'Cash in hand', kind: 'cash', bank_name: null },
  { id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank' },
];

const form = (receivable: ReceivableInvoice[], f: Partial<ReceiptForm> = {}): ReceiptForm => ({
  ...newReceiptForm(receivable, accounts, today),
  customerId: AISYAH,
  ...f,
});

describe('receivableInvoices, with credit notes', () => {
  it('offers a part-credited invoice for what it still owes, which is its balance', () => {
    const offered = receivableInvoices([invoice(1, { total: 100, credited: 30, balance: 70 })], []);
    expect(offered).toMatchObject([{ balance: 70, held: 0, payable: 70 }]);
  });
  it('does not offer an invoice whose customer is in credit, or one that credit notes settled', () => {
    const inCredit = invoice(2, { total: 100, paid: 100, credited: 30, balance: -30, display_status: 'paid' });
    const settled = invoice(3, { total: 100, credited: 100, balance: 0, display_status: 'paid' });
    expect(receivableInvoices([inCredit, settled], [])).toEqual([]);
  });
});

describe('receivableInvoices', () => {
  it('offers posted invoices that still owe something, and no others', () => {
    const receivable = receivableInvoices(
      [
        invoice(1),
        invoice(2, { display_status: 'overdue', due_date: '2026-10-04' }),
        invoice(3, { display_status: 'draft', invoice_no: null }),
        invoice(4, { display_status: 'paid', balance: 0, paid: 100 }),
        invoice(5, { display_status: 'void' }),
        invoice(6, { balance: 0 }),
      ],
      [],
    );
    expect(receivable.map((i) => [i.invoice_no, i.overdue, i.payable])).toEqual([
      ['INV-0002', true, 100],
      ['INV-0001', false, 100],
    ]);
  });

  it('offers a part-paid invoice for what is left, to the sen', () => {
    const receivable = receivableInvoices([invoice(1, { total: 3500, paid: 1000.1, balance: 2499.9 })], [received(1, { amount: 1000.1 })]);
    expect(receivable[0]).toMatchObject({ balance: 2499.9, held: 0, payable: 2499.9 });
  });

  it('takes off what a payment not yet posted holds, as the database does, and drops an invoice it covers', () => {
    const receivable = receivableInvoices(
      [invoice(1, { balance: 500 }), invoice(2, { balance: 300 }), invoice(3, { balance: 80.1 })],
      [
        received(1, { status: 'draft', amount: 150 }),
        received(1, { status: 'pending_approval', amount: 50 }),
        received(2, { status: 'scheduled', amount: 300 }),
        // A voided payment holds nothing.
        received(3, { status: 'void', amount: 80.1 }),
      ],
    );
    expect(receivable.map((i) => [i.invoice_no, i.balance, i.held, i.payable])).toEqual([
      ['INV-0001', 500, 200, 300],
      ['INV-0003', 80.1, 0, 80.1],
    ]);
    expect(heldByInvoice([received(1, { status: 'draft', amount: 0.1 }), received(1, { status: 'scheduled', amount: 0.2 })])).toEqual({
      [invoiceId(1)]: 0.3,
    });
  });

  it('sorts by customer, then the earliest due date', () => {
    const receivable = receivableInvoices(
      [
        invoice(1, { customer_id: ZAKI, customer_name: 'Zaki Enterprise', due_date: '2026-10-01' }),
        invoice(2, { due_date: '2026-11-15' }),
        invoice(3, { due_date: '2026-10-20' }),
      ],
      [],
    );
    expect(receivable.map((i) => i.invoice_no)).toEqual(['INV-0003', 'INV-0002', 'INV-0001']);
  });
});

describe('receiptCustomers and invoicesOf', () => {
  const receivable = receivableInvoices(
    [invoice(1), invoice(2), invoice(3, { customer_id: ZAKI, customer_name: 'Zaki Enterprise' })],
    [],
  );

  it('lists each customer once with how many invoices are open, and one customer’s invoices', () => {
    expect(receiptCustomers(receivable)).toEqual([
      { id: AISYAH, name: 'Aisyah Trading', open: 2 },
      { id: ZAKI, name: 'Zaki Enterprise', open: 1 },
    ]);
    expect(invoicesOf(receivable, AISYAH).map((i) => i.invoice_no)).toEqual(['INV-0001', 'INV-0002']);
    expect(invoicesOf(receivable, 'nobody')).toEqual([]);
  });
});

describe('newReceiptForm', () => {
  const receivable = receivableInvoices(
    [invoice(1, { balance: 250.5 }), invoice(2), invoice(3, { customer_id: ZAKI, customer_name: 'Zaki Enterprise' })],
    [],
  );

  it('starts with no customer, nothing ticked, the bank account, today, and no scheduling', () => {
    expect(newReceiptForm(receivable, accounts, today)).toEqual({
      customerId: '',
      amounts: {},
      accountId: BANK,
      date: today,
      method: 'bank_transfer',
      reference: '',
      notes: '',
    });
  });
  it('chooses the customer when there is only one', () => {
    expect(newReceiptForm(invoicesOf(receivable, ZAKI), accounts, today).customerId).toBe(ZAKI);
  });
  it('opens from an invoice’s row with that customer chosen and that invoice ticked for all it is owed', () => {
    const opened = newReceiptForm(receivable, accounts, today, { customerId: AISYAH, invoiceId: invoiceId(1) });
    expect(opened).toMatchObject({ customerId: AISYAH, amounts: { [invoiceId(1)]: '250.50' } });
  });
  it('ticks nothing when the invoice from the row is no longer receivable, or belongs to someone else', () => {
    expect(newReceiptForm(receivable, accounts, today, { customerId: AISYAH, invoiceId: invoiceId(9) }).amounts).toEqual({});
    expect(newReceiptForm(receivable, accounts, today, { customerId: AISYAH, invoiceId: invoiceId(3) }).amounts).toEqual({});
  });
  it('falls back to any account, then to none', () => {
    expect(newReceiptForm(receivable, [accounts[0]], today).accountId).toBe(CASH);
    expect(newReceiptForm(receivable, [], today).accountId).toBe('');
  });
});

describe('ticking invoices', () => {
  const receivable = receivableInvoices([invoice(1, { balance: 250.5 }), invoice(2)], []);

  it('ticks an invoice for all it is owed, unticks it, ticks all and clears all', () => {
    const one = toggleInvoice(form(receivable), receivable[0], true);
    expect(one.amounts).toEqual({ [invoiceId(1)]: '250.50' });
    expect(toggleInvoice(one, receivable[0], false).amounts).toEqual({});
    const all = toggleAllInvoices(form(receivable), receivable, true);
    expect(all.amounts).toEqual({ [invoiceId(1)]: '250.50', [invoiceId(2)]: '100.00' });
    expect(receiptTotal(all)).toBe(350.5);
    expect(toggleAllInvoices(all, receivable, false).amounts).toEqual({});
  });
  it('starts the ticks again when another customer is chosen, and keeps them when the same one is chosen', () => {
    const one = toggleInvoice(form(receivable), receivable[0], true);
    expect(chooseCustomer(one, ZAKI)).toMatchObject({ customerId: ZAKI, amounts: {} });
    expect(chooseCustomer(one, AISYAH)).toBe(one);
  });
  it('drops a ticked invoice that was paid off while the form was open', () => {
    const all = toggleAllInvoices(form(receivable), receivable, true);
    const left = keepReceivable(all, [receivable[1]]);
    expect(left.amounts).toEqual({ [invoiceId(2)]: '100.00' });
    expect(receiptTotal(left)).toBe(100);
    expect(keepReceivable(all, receivable)).toBe(all);
  });
});

describe('receiptFormError', () => {
  const receivable = receivableInvoices(
    [invoice(1, { balance: 250.5 }), invoice(2), invoice(3, { customer_id: ZAKI, customer_name: 'Zaki Enterprise' })],
    [],
  );
  const ready = toggleInvoice(form(receivable), receivable[0], true);

  it('passes a form that can be sent', () => {
    expect(receiptFormError(ready, receivable)).toBeNull();
  });
  it('asks for a customer, then at least one invoice', () => {
    expect(receiptFormError(form(receivable, { customerId: '' }), receivable)).toBe('Choose a customer.');
    expect(receiptFormError(form(receivable), receivable)).toBe('Choose at least one invoice this payment is for.');
  });
  it('refuses an empty amount, zero, and one typed with a comma', () => {
    const typed = (text: string) => receiptFormError({ ...ready, amounts: { [invoiceId(1)]: text } }, receivable);
    expect(typed('')).toBe('Enter an amount above 0.');
    expect(typed('0')).toBe('Enter an amount above 0.');
    expect(typed('0.004')).toBe('Enter an amount above 0.');
    expect(typed('1,200.50')).toBe('Enter an amount above 0.');
  });
  it('refuses more than an invoice is owed, to the sen, and takes exactly what is owed', () => {
    const typed = (text: string) => receiptFormError({ ...ready, amounts: { [invoiceId(1)]: text } }, receivable);
    expect(typed('250.51')).toBe('That is more than is still owed on an invoice.');
    expect(typed('250.50')).toBeNull();
    expect(typed('0.01')).toBeNull();
  });
  it('counts in sen on float-tricky figures: 10.05 owed, and 0.3 less 0.1 held', () => {
    const owed = receivableInvoices([invoice(1, { total: 10.05, balance: 10.05 })], []);
    const owedForm = toggleInvoice(form(owed), owed[0], true);
    const typedOwed = (text: string) => receiptFormError({ ...owedForm, amounts: { [invoiceId(1)]: text } }, owed);
    expect(typedOwed('10.05')).toBeNull();
    expect(typedOwed('10.06')).toBe('That is more than is still owed on an invoice.');

    const held = receivableInvoices(
      [invoice(1, { total: 0.3, balance: 0.3 })],
      [received(1, { status: 'draft', amount: 0.1 })],
    );
    expect(held[0].payable).toBe(0.2);
    const heldForm = toggleInvoice(form(held), held[0], true);
    const typedHeld = (text: string) => receiptFormError({ ...heldForm, amounts: { [invoiceId(1)]: text } }, held);
    expect(typedHeld('0.2')).toBeNull();
    expect(typedHeld('0.21')).toBe('That is more than is still owed on an invoice.');
  });
  it('refuses an invoice that is no longer receivable, or that belongs to another customer', () => {
    expect(receiptFormError(ready, invoicesOf(receivable, 'nobody'))).toBe('That is more than is still owed on an invoice.');
    expect(receiptFormError({ ...ready, amounts: { [invoiceId(3)]: '1' } }, receivable)).toBe('That is more than is still owed on an invoice.');
  });
  it('asks for an account and a real date in the schema’s words', () => {
    expect(receiptFormError({ ...ready, accountId: '' }, receivable)).toBe('Choose the account the money went into.');
    expect(receiptFormError({ ...ready, date: '' }, receivable)).toBe('Enter a valid date.');
    expect(receiptFormError({ ...ready, reference: 'x'.repeat(201) }, receivable)).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('takes fifty invoices in one payment and refuses fifty-one', () => {
    const many = Array.from({ length: 51 }, (_, n) => invoice(n + 1));
    const offered = receivableInvoices(many, []);
    expect(receiptFormError(toggleAllInvoices(form(offered), offered.slice(0, 50), true), offered)).toBeNull();
    expect(receiptFormError(toggleAllInvoices(form(offered), offered, true), offered)).toBe('One payment can cover at most 50 invoices.');
  });
});

describe('receiptPayload', () => {
  const receivable = receivableInvoices([invoice(1, { balance: 250.5 }), invoice(2)], []);

  it('sends numbers, one allocation per ticked invoice, and nothing about scheduling', () => {
    const all = { ...toggleAllInvoices(form(receivable), receivable, true), reference: ' TT 88 ', notes: '' };
    const payload = receiptPayload(all);
    expect(payload).toEqual({
      account_id: BANK,
      txn_date: today,
      method: 'bank_transfer',
      reference: ' TT 88 ',
      notes: '',
      allocations: [
        { invoice_id: invoiceId(1), amount: 250.5 },
        { invoice_id: invoiceId(2), amount: 100 },
      ],
    });
    expect('scheduled' in payload).toBe(false);
    expect(recordPaymentInInput.parse(payload)).toMatchObject({ reference: 'TT 88', notes: null });
  });
  it('never carries the customer or a workspace: the database works the customer out from the invoices', () => {
    expect(Object.keys(receiptPayload(form(receivable))).sort()).toEqual(['account_id', 'allocations', 'method', 'notes', 'reference', 'txn_date']);
  });
});

describe('the payment-in form, as the shared card draws it', () => {
  const receivable = receivableInvoices(
    [invoice(1, { balance: 250.5 }), invoice(2, { balance: 500 })],
    [received(2, { status: 'draft', amount: 200 })],
  );

  it('is the payment-in form’s own rules, and cannot be scheduled', () => {
    expect(PAYMENT_IN_KIND.chooseParty).toBe(chooseCustomer);
    expect(PAYMENT_IN_KIND.parties).toBe(receiptCustomers);
    expect(PAYMENT_IN_KIND.documentsOf).toBe(invoicesOf);
    expect(PAYMENT_IN_KIND.toggle).toBe(toggleInvoice);
    expect(PAYMENT_IN_KIND.toggleAll).toBe(toggleAllInvoices);
    expect(PAYMENT_IN_KIND.keep).toBe(keepReceivable);
    expect(PAYMENT_IN_KIND.total).toBe(receiptTotal);
    expect(PAYMENT_IN_KIND.error).toBe(receiptFormError);
    expect(PAYMENT_IN_KIND.payload).toBe(receiptPayload);
    expect(PAYMENT_IN_KIND.schedule).toBeUndefined();
  });
  it('opens from an invoice’s row with that customer chosen and that invoice ticked', () => {
    const opened = PAYMENT_IN_KIND.newForm(receivable, accounts, today, { partyId: AISYAH, documentId: invoiceId(1) });
    expect(opened).toMatchObject({ customerId: AISYAH, amounts: { [invoiceId(1)]: '250.50' } });
    expect(PAYMENT_IN_KIND.partyId(opened)).toBe(AISYAH);
  });
  it('words an invoice: its number, what is owed, and what an unposted payment holds', () => {
    expect(PAYMENT_IN_KIND.number(receivable[0])).toBe('INV-0001');
    expect(PAYMENT_IN_KIND.owed(receivable[0])).toBe('RM 250.50 owed');
    expect(PAYMENT_IN_KIND.owed(receivable[1])).toBe('RM 300.00 owed · RM 200.00 of RM 500.00 held by a payment not yet posted');
    expect(PAYMENT_IN_KIND.amountLabel(receivable[0])).toBe('Amount received for INV-0001');
    expect(PAYMENT_IN_KIND.words).toMatchObject({ party: 'customer', document: 'invoice', documents: 'Invoices paid', account: 'Paid into', date: 'Date received', submit: 'Record payment' });
  });
});
