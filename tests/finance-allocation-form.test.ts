import { describe, expect, it } from 'vitest';
import {
  amountText,
  amountsError,
  amountsTotal,
  defaultAccount,
  heldBy,
  keptOffered,
  partiesOf,
  ticked,
  tickedAll,
  typedAmounts,
} from '@/lib/finance/allocation-form';
import type { FinanceAccount } from '@/lib/finance/money';
import {
  PAYMENT_OUT_KIND,
  type PayableBill,
  amountText as paymentAmountText,
  billsOf,
  chooseSupplier,
  keepPayable,
  paymentFormError,
  paymentPayload,
  paymentTotal,
  toggleAll,
  toggleBill,
} from '@/lib/finance/payment-form';

const LIM = '11111111-1111-4111-8111-111111111111';
const MAJU = '22222222-2222-4222-8222-222222222222';
const BANK = '66666666-6666-4666-8666-666666666666';
const CASH = '77777777-7777-4777-8777-777777777777';

const accounts: FinanceAccount[] = [
  { id: CASH, name: 'Cash in hand', kind: 'cash', bank_name: null },
  { id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank' },
];

const doc = (id: string, payable: number) => ({ id, payable });
const messages = { amount: 'Enter an amount above 0.', tooMuch: 'That is more than is still owed.' };

describe('what the two payment forms share', () => {
  it('is one definition: payment-form.ts hands on the same amountText', () => {
    expect(paymentAmountText).toBe(amountText);
    expect(amountText(1200.5)).toBe('1200.50');
  });

  it('adds up what unposted payments hold of each document, to the sen, by whatever id it is given', () => {
    const rows = [
      { status: 'scheduled' as const, amount: 0.1, invoice_id: 'a' },
      { status: 'draft' as const, amount: 0.2, invoice_id: 'a' },
      { status: 'pending_approval' as const, amount: 5, invoice_id: 'b' },
      { status: 'posted' as const, amount: 99, invoice_id: 'a' },
      { status: 'void' as const, amount: 99, invoice_id: 'c' },
      { status: 'rejected' as const, amount: 99, invoice_id: 'c' },
    ];
    expect(heldBy(rows, (r) => r.invoice_id)).toEqual({ a: 0.3, b: 5 });
    expect(heldBy([], () => 'x')).toEqual({});
  });

  it('lists each party once, by name, with how many documents are open', () => {
    const docs = [
      { party: MAJU, name: 'Maju Jaya' },
      { party: LIM, name: 'Lim Hardware' },
      { party: LIM, name: 'Lim Hardware' },
    ];
    expect(partiesOf(docs, (d) => d.party, (d) => d.name)).toEqual([
      { id: LIM, name: 'Lim Hardware', open: 2 },
      { id: MAJU, name: 'Maju Jaya', open: 1 },
    ]);
  });

  it('defaults to the first bank account, then to any account, then to none', () => {
    expect(defaultAccount(accounts)).toBe(BANK);
    expect(defaultAccount([accounts[0]])).toBe(CASH);
    expect(defaultAccount([])).toBe('');
  });

  it('ticks a document for all it can take, unticks it, and ticks or clears them all, keeping the rest of the form', () => {
    const form = { partyId: LIM, amounts: { a: '10.00' } };
    expect(ticked(form, doc('b', 80.1), true)).toEqual({ partyId: LIM, amounts: { a: '10.00', b: '80.10' } });
    expect(ticked(form, doc('a', 10), false)).toEqual({ partyId: LIM, amounts: {} });
    expect(tickedAll(form, [doc('b', 1), doc('c', 2.5)], true).amounts).toEqual({ b: '1.00', c: '2.50' });
    expect(tickedAll(form, [doc('b', 1)], false)).toEqual({ partyId: LIM, amounts: {} });
  });

  it('drops a ticked document that is no longer offered, and is the same form when nothing goes', () => {
    const form = { amounts: { a: '10.00', b: '5.00' } };
    expect(keptOffered(form, [{ id: 'a' }])).toEqual({ amounts: { a: '10.00' } });
    expect(keptOffered(form, [{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(form);
  });

  it('totals in whole sen, counting only amounts that are numbers above 0', () => {
    expect(amountsTotal({ a: '0.10', b: '0.20' })).toBe(0.3);
    expect(amountsTotal({ a: '1,200.50', b: '', c: '-5', d: '7' })).toBe(7);
    expect(amountsTotal({})).toBe(0);
  });

  it('reads the typed amounts as numbers, and a box that is not a number as NaN', () => {
    const typed = typedAmounts({ a: '12.50', b: '1,200.50' });
    expect(typed[0]).toEqual({ id: 'a', amount: 12.5 });
    expect(typed[1].id).toBe('b');
    expect(Number.isNaN(typed[1].amount)).toBe(true);
  });

  it('refuses an amount that is not above 0, one typed with a comma, and a sen more than a document can take', () => {
    const offered = [doc('a', 100), doc('b', 80.1)];
    expect(amountsError({ a: '100.00', b: '80.10' }, offered, messages)).toBeNull();
    expect(amountsError({ a: '' }, offered, messages)).toBe(messages.amount);
    expect(amountsError({ a: '0' }, offered, messages)).toBe(messages.amount);
    expect(amountsError({ a: '0.004' }, offered, messages)).toBe(messages.amount);
    expect(amountsError({ a: '1,200.50' }, offered, messages)).toBe(messages.amount);
    expect(amountsError({ b: '80.11' }, offered, messages)).toBe(messages.tooMuch);
    // Paid off or voided since the form opened: no longer offered.
    expect(amountsError({ c: '1' }, offered, messages)).toBe(messages.tooMuch);
  });
});

describe('the payment-out form, as the shared card draws it', () => {
  const bill = (n: number, b: Partial<PayableBill> = {}): PayableBill => ({
    id: `bill-${n}`,
    bill_no: `BILL-000${n}`,
    supplier_id: LIM,
    supplier_name: 'Lim Hardware',
    due_date: '2026-10-31',
    overdue: false,
    balance: 100,
    scheduled: 0,
    payable: 100,
    ...b,
  });
  const payable = [bill(1), bill(2, { balance: 500, scheduled: 200, payable: 300 }), bill(3, { supplier_id: MAJU, supplier_name: 'Maju Jaya' })];

  it('is the payment form’s own rules, not a second set', () => {
    expect(PAYMENT_OUT_KIND.chooseParty).toBe(chooseSupplier);
    expect(PAYMENT_OUT_KIND.documentsOf).toBe(billsOf);
    expect(PAYMENT_OUT_KIND.toggle).toBe(toggleBill);
    expect(PAYMENT_OUT_KIND.toggleAll).toBe(toggleAll);
    expect(PAYMENT_OUT_KIND.keep).toBe(keepPayable);
    expect(PAYMENT_OUT_KIND.total).toBe(paymentTotal);
    expect(PAYMENT_OUT_KIND.error).toBe(paymentFormError);
    expect(PAYMENT_OUT_KIND.payload).toBe(paymentPayload);
  });

  it('opens from a bill’s row with that supplier chosen and that bill ticked for all it can take', () => {
    const form = PAYMENT_OUT_KIND.newForm(payable, accounts, '2026-10-11', { partyId: LIM, documentId: 'bill-2' });
    expect(form).toMatchObject({ supplierId: LIM, amounts: { 'bill-2': '300.00' }, accountId: BANK, date: '2026-10-11', scheduled: false });
    expect(PAYMENT_OUT_KIND.partyId(form)).toBe(LIM);
    expect(PAYMENT_OUT_KIND.newForm(payable, accounts, '2026-10-11').supplierId).toBe('');
  });

  it('lists the suppliers with how many bills are open', () => {
    expect(PAYMENT_OUT_KIND.parties(payable)).toEqual([
      { id: LIM, name: 'Lim Hardware', open: 2 },
      { id: MAJU, name: 'Maju Jaya', open: 1 },
    ]);
  });

  it('words a bill as the form always has: what it can take, and what is waiting to be paid', () => {
    expect(PAYMENT_OUT_KIND.number(payable[0])).toBe('BILL-0001');
    expect(PAYMENT_OUT_KIND.owed(payable[0])).toBe('RM 100.00 to pay');
    expect(PAYMENT_OUT_KIND.owed(payable[1])).toBe('RM 300.00 to pay · RM 200.00 of RM 500.00 in payments to be paid');
    expect(PAYMENT_OUT_KIND.amountLabel(payable[0])).toBe('Amount to pay on BILL-0001');
    expect(PAYMENT_OUT_KIND.words).toMatchObject({
      subtitle: 'Pay a supplier\'s bills, now or later',
      party: 'supplier',
      document: 'bill',
      documents: 'Bills to pay',
      account: 'Paid from',
      date: 'Date paid',
      submit: 'Record payment',
    });
  });

  it('can be scheduled for later', () => {
    const form = PAYMENT_OUT_KIND.newForm(payable, accounts, '2026-10-11');
    const later = PAYMENT_OUT_KIND.schedule?.set(form, true);
    expect(later).toEqual({ ...form, scheduled: true });
    expect(later ? PAYMENT_OUT_KIND.schedule?.is(later) : undefined).toBe(true);
    expect(PAYMENT_OUT_KIND.schedule?.is(form)).toBe(false);
  });
});
