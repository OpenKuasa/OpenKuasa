import { describe, expect, it } from 'vitest';
import type { BillListRow } from '@/lib/finance/bills';
import { type FinanceAccount, type PaymentOutRow, recordPaymentOutInput } from '@/lib/finance/money';
import {
  type PayableBill,
  type PaymentForm,
  amountText,
  billsOf,
  chooseSupplier,
  heldByBill,
  keepPayable,
  newPaymentForm,
  payableBills,
  paymentFormError,
  paymentPayload,
  paymentSuppliers,
  paymentTotal,
  toggleAll,
  toggleBill,
} from '@/lib/finance/payment-form';

const LIM = '11111111-1111-4111-8111-111111111111';
const MAJU = '22222222-2222-4222-8222-222222222222';
const BANK = '66666666-6666-4666-8666-666666666666';
const CASH = '77777777-7777-4777-8777-777777777777';
const today = '2026-10-11';

/** 1 → a valid uuid ending in 000000000001. */
const billId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

const bill = (n: number, b: Partial<BillListRow> = {}): BillListRow => ({
  id: billId(n),
  bill_no: `BILL-${String(n).padStart(4, '0')}`,
  supplier_id: LIM,
  supplier_name: 'Lim Hardware',
  bill_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 0,
  balance: 100,
  display_status: 'pending',
  purchase_order_id: null,
  purchase_order_no: null,
  ...b,
});

const paid = (n: number, p: Partial<PaymentOutRow> = {}): PaymentOutRow => ({
  allocation_id: `alloc-${n}-${p.status ?? 'posted'}-${p.amount ?? 100}`,
  transaction_id: `txn-${n}`,
  number: null,
  txn_date: '2026-10-05',
  method: 'fpx',
  amount: 100,
  transaction_amount: 100,
  status: 'posted',
  reference: null,
  account_id: BANK,
  account_name: 'Main Bank',
  bill_id: billId(n),
  bill_no: `BILL-${String(n).padStart(4, '0')}`,
  supplier_name: 'Lim Hardware',
  ...p,
});

const accounts: FinanceAccount[] = [
  { id: CASH, name: 'Cash in hand', kind: 'cash', bank_name: null },
  { id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank' },
];

const form = (payable: PayableBill[], f: Partial<PaymentForm> = {}): PaymentForm => ({
  ...newPaymentForm(payable, accounts, today),
  supplierId: LIM,
  ...f,
});

describe('payableBills', () => {
  it('offers posted bills that still owe something, and no others', () => {
    const payable = payableBills(
      [
        bill(1),
        bill(2, { display_status: 'overdue', due_date: '2026-10-04' }),
        bill(3, { display_status: 'draft', bill_no: null }),
        bill(4, { display_status: 'paid', balance: 0, paid: 100 }),
        bill(5, { display_status: 'void' }),
        bill(6, { balance: 0 }),
      ],
      [],
    );
    expect(payable.map((b) => [b.bill_no, b.overdue, b.payable])).toEqual([
      ['BILL-0002', true, 100],
      ['BILL-0001', false, 100],
    ]);
  });

  it('carries the purchase order a bill is raised against, for the order notes', () => {
    const payable = payableBills([bill(1, { purchase_order_id: 'po-1', purchase_order_no: 'PO-0003' }), bill(2)], []);
    expect(payable.map((b) => [b.bill_no, b.purchase_order_id])).toEqual([
      ['BILL-0001', 'po-1'],
      ['BILL-0002', null],
    ]);
  });

  it('takes scheduled payments off what a bill can still take, and drops a bill they cover', () => {
    const payable = payableBills(
      [bill(1, { balance: 500 }), bill(2, { balance: 300 }), bill(3, { balance: 80.1 })],
      [
        // BILL-0001: RM 200 scheduled in two parts, RM 50 already paid (the balance already reflects it).
        paid(1, { status: 'scheduled', amount: 150 }),
        paid(1, { status: 'scheduled', amount: 50 }),
        paid(1, { status: 'posted', amount: 50 }),
        // BILL-0002: fully scheduled. A payment for it would be refused, so it is not offered.
        paid(2, { status: 'scheduled', amount: 300 }),
        // BILL-0003: a voided payment holds nothing.
        paid(3, { status: 'void', amount: 80.1 }),
      ],
    );
    expect(payable.map((b) => [b.bill_no, b.balance, b.scheduled, b.payable])).toEqual([
      ['BILL-0001', 500, 200, 300],
      ['BILL-0003', 80.1, 0, 80.1],
    ]);
  });

  it('counts a payment still being written or awaiting approval as holding the bill, like the database does', () => {
    const payable = payableBills(
      [bill(1, { balance: 100 })],
      [paid(1, { status: 'draft', amount: 30 }), paid(1, { status: 'pending_approval', amount: 30.5 }), paid(1, { status: 'rejected', amount: 10 })],
    );
    expect(payable[0]).toMatchObject({ scheduled: 60.5, payable: 39.5 });
  });

  it('sorts by supplier, then the earliest due date', () => {
    const payable = payableBills(
      [
        bill(1, { supplier_id: MAJU, supplier_name: 'Maju Jaya', due_date: '2026-10-01' }),
        bill(2, { due_date: '2026-11-15' }),
        bill(3, { due_date: '2026-10-20' }),
      ],
      [],
    );
    expect(payable.map((b) => b.bill_no)).toEqual(['BILL-0003', 'BILL-0002', 'BILL-0001']);
  });
});

describe('heldByBill', () => {
  it('sums the scheduled payments of one bill', () => {
    expect(heldByBill([paid(1, { status: 'scheduled', amount: 150 }), paid(1, { status: 'scheduled', amount: 50.5 })])).toEqual({
      [billId(1)]: 200.5,
    });
  });
  it('ignores paid and void payments, and leaves out a bill with nothing held', () => {
    const held = heldByBill([
      paid(1, { status: 'posted', amount: 50 }),
      paid(2, { status: 'void', amount: 80 }),
      paid(3, { status: 'rejected', amount: 10 }),
      paid(4, { status: 'scheduled', amount: 20 }),
    ]);
    expect(held).toEqual({ [billId(4)]: 20 });
    expect(billId(1) in held).toBe(false);
    expect(heldByBill([])).toEqual({});
  });
  it('counts a payment still being written or awaiting approval, as payableBills does', () => {
    expect(heldByBill([paid(1, { status: 'draft', amount: 30 }), paid(1, { status: 'pending_approval', amount: 30.5 })])).toEqual({
      [billId(1)]: 60.5,
    });
  });
  it('adds to the sen, without floating point drift', () => {
    expect(heldByBill([paid(1, { status: 'scheduled', amount: 0.1 }), paid(1, { status: 'scheduled', amount: 0.2 })])[billId(1)]).toBe(0.3);
  });
});

describe('paymentSuppliers and billsOf', () => {
  const payable = payableBills(
    [bill(1), bill(2), bill(3, { supplier_id: MAJU, supplier_name: 'Maju Jaya' }), bill(4, { supplier_id: 'paid-up', supplier_name: 'Paid Up', display_status: 'paid', balance: 0 })],
    [],
  );

  it('lists only suppliers with a bill to pay, by name, with how many', () => {
    expect(paymentSuppliers(payable)).toEqual([
      { id: LIM, name: 'Lim Hardware', bills: 2 },
      { id: MAJU, name: 'Maju Jaya', bills: 1 },
    ]);
  });
  it('gives one supplier’s bills', () => {
    expect(billsOf(payable, LIM).map((b) => b.bill_no)).toEqual(['BILL-0001', 'BILL-0002']);
    expect(billsOf(payable, 'nobody')).toEqual([]);
  });
});

describe('newPaymentForm', () => {
  const payable = payableBills([bill(1, { balance: 250.5 }), bill(2, { supplier_id: MAJU, supplier_name: 'Maju Jaya' })], []);

  it('starts on today, by bank transfer from the first bank account, paying now, with nothing ticked', () => {
    expect(newPaymentForm(payable, accounts, today)).toEqual({
      supplierId: '',
      amounts: {},
      accountId: BANK,
      date: today,
      method: 'bank_transfer',
      reference: '',
      notes: '',
      scheduled: false,
    });
  });
  it('chooses the supplier when there is only one to pay', () => {
    expect(newPaymentForm(billsOf(payable, MAJU), accounts, today).supplierId).toBe(MAJU);
  });
  it('falls back to a cash account, or none, when there is no bank account', () => {
    expect(newPaymentForm(payable, [accounts[0]], today).accountId).toBe(CASH);
    expect(newPaymentForm(payable, [], today).accountId).toBe('');
  });
  it('opened from a bill row, has that supplier chosen and that bill ticked for all it can take', () => {
    const opened = newPaymentForm(payable, accounts, today, { supplierId: LIM, billId: billId(1) });
    expect(opened.supplierId).toBe(LIM);
    expect(opened.amounts).toEqual({ [billId(1)]: '250.50' });
  });
  it('opened from a bill that can take nothing more, ticks nothing', () => {
    const opened = newPaymentForm(payable, accounts, today, { supplierId: LIM, billId: billId(99) });
    expect(opened.amounts).toEqual({});
  });
});

describe('ticking bills', () => {
  const payable = payableBills([bill(1, { balance: 250.5 }), bill(2, { balance: 80 })], [paid(2, { status: 'scheduled', amount: 30 })]);
  const [first, second] = payable;

  it('ticks a bill for all it can still take, and unticks it', () => {
    const ticked = toggleBill(form(payable), second, true);
    expect(ticked.amounts).toEqual({ [second.id]: '50.00' });
    expect(toggleBill(ticked, second, false).amounts).toEqual({});
  });
  it('ticks and clears every bill at once', () => {
    const all = toggleAll(form(payable), payable, true);
    expect(all.amounts).toEqual({ [first.id]: '250.50', [second.id]: '50.00' });
    expect(toggleAll(all, payable, false).amounts).toEqual({});
  });
  it('starts the ticks again when another supplier is chosen, and keeps them when the same one is', () => {
    const ticked = toggleBill(form(payable), first, true);
    expect(chooseSupplier(ticked, MAJU)).toMatchObject({ supplierId: MAJU, amounts: {} });
    expect(chooseSupplier(ticked, LIM)).toBe(ticked);
  });
  it('adds up the ticked amounts as they are typed, without floating point drift', () => {
    expect(paymentTotal(form(payable, { amounts: { a: '0.10', b: '0.20' } }))).toBe(0.3);
    expect(paymentTotal(form(payable, { amounts: { a: '100', b: '', c: 'abc', d: '-5', e: '1,000' } }))).toBe(100);
    expect(paymentTotal(form(payable))).toBe(0);
  });
  it('writes an amount with two decimals', () => {
    expect(amountText(1200.5)).toBe('1200.50');
    expect(amountText(80)).toBe('80.00');
  });
});

describe('paymentFormError', () => {
  const payable = payableBills([bill(1, { balance: 250.5 }), bill(2, { balance: 80 })], [paid(2, { status: 'scheduled', amount: 30 })]);
  const [first, second] = payable;
  const ready = toggleBill(form(payable), first, true);

  it('passes a form that can be sent', () => {
    expect(paymentFormError(ready, payable)).toBeNull();
    expect(paymentFormError({ ...ready, scheduled: true, reference: 'MBB 8841', notes: 'part one' }, payable)).toBeNull();
  });
  it('asks for a supplier, then at least one bill', () => {
    expect(paymentFormError(form(payable, { supplierId: '' }), payable)).toBe('Choose a supplier.');
    expect(paymentFormError(form(payable), payable)).toBe('Choose at least one bill to pay.');
  });
  it('asks for an amount above 0 on every ticked bill', () => {
    for (const text of ['', '0', '-5', 'abc', '0.004']) {
      expect(paymentFormError({ ...ready, amounts: { [first.id]: text } }, payable), text).toBe('Enter an amount above 0.');
    }
  });
  it('refuses an amount typed with a comma rather than reading it as a smaller number', () => {
    expect(paymentFormError({ ...ready, amounts: { [first.id]: '1,200.50' } }, payable)).toBe('Enter an amount above 0.');
    expect(paymentFormError({ ...ready, amounts: { [first.id]: '2,50' } }, payable)).toBe('Enter an amount above 0.');
  });
  it('refuses more than a bill can still take, to the sen', () => {
    expect(paymentFormError({ ...ready, amounts: { [first.id]: '250.51' } }, payable)).toBe('That is more than is still owed on a bill.');
    expect(paymentFormError({ ...ready, amounts: { [first.id]: '250.50' } }, payable)).toBeNull();
    // RM 80 is owed on the second bill but RM 30 of it is already scheduled.
    expect(paymentFormError({ ...ready, amounts: { [second.id]: '50.01' } }, payable)).toBe('That is more than is still owed on a bill.');
    expect(paymentFormError({ ...ready, amounts: { [second.id]: '50' } }, payable)).toBeNull();
  });
  it('refuses a bill that was paid or voided after the form was opened', () => {
    expect(paymentFormError(ready, billsOf(payable, 'nobody'))).toBe('That is more than is still owed on a bill.');
  });
  it('asks for an account, a real date, and short enough text, in the schema’s words', () => {
    expect(paymentFormError({ ...ready, accountId: '' }, payable)).toBe('Choose the account the money leaves.');
    expect(paymentFormError({ ...ready, date: '' }, payable)).toBe('Enter a valid date.');
    expect(paymentFormError({ ...ready, date: '0202-10-11' }, payable)).toBe('Enter a valid date.');
    expect(paymentFormError({ ...ready, reference: 'x'.repeat(201) }, payable)).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
});

describe('a supplier with many open bills', () => {
  const twenty = payableBills(Array.from({ length: 20 }, (_, i) => bill(i + 1, { balance: 10.1 })), []);
  const sixty = payableBills(Array.from({ length: 60 }, (_, i) => bill(i + 1, { balance: 10.1 })), []);

  it('pays twenty bills in one payment, each in full', () => {
    const all = toggleAll(form(twenty), twenty, true);
    expect(paymentFormError(all, twenty)).toBeNull();
    expect(paymentTotal(all)).toBe(202);
    const payload = paymentPayload(all);
    expect(payload.allocations).toHaveLength(20);
    expect(payload.allocations.every((a) => a.amount === 10.1)).toBe(true);
    expect(recordPaymentOutInput.safeParse(payload).success).toBe(true);
  });
  it('says one payment covers at most fifty when more are ticked', () => {
    expect(paymentFormError(toggleAll(form(sixty), sixty, true), sixty)).toBe('One payment can cover at most 50 bills.');
  });
});

describe('paymentPayload', () => {
  const payable = payableBills([bill(1, { balance: 250.5 }), bill(2, { balance: 80 })], []);

  it('sends numbers, never the text that was typed, and the schema accepts it', () => {
    const filled: PaymentForm = {
      supplierId: LIM,
      amounts: { [payable[0].id]: '200.50', [payable[1].id]: ' 80 ' },
      accountId: BANK,
      date: '2026-10-20',
      method: 'cheque',
      reference: ' CHQ 001 ',
      notes: '',
      scheduled: true,
    };
    const payload = paymentPayload(filled);
    expect(payload).toEqual({
      account_id: BANK,
      txn_date: '2026-10-20',
      method: 'cheque',
      reference: ' CHQ 001 ',
      notes: '',
      scheduled: true,
      allocations: [
        { bill_id: payable[0].id, amount: 200.5 },
        { bill_id: payable[1].id, amount: 80 },
      ],
    });
    expect(recordPaymentOutInput.parse(payload)).toMatchObject({ reference: 'CHQ 001', notes: null, scheduled: true });
  });
  it('sends NaN for a box that is not a number, which the schema refuses with the amount sentence', () => {
    const payload = paymentPayload(form(payable, { amounts: { [payable[0].id]: '1,200' } }));
    expect(Number.isNaN(payload.allocations[0].amount)).toBe(true);
    expect(recordPaymentOutInput.safeParse(payload).error?.issues[0]?.message).toBe('Enter an amount above 0.');
  });
  it('never carries the supplier or a workspace: the server works those out', () => {
    expect(Object.keys(paymentPayload(form(payable))).sort()).toEqual(
      ['account_id', 'allocations', 'method', 'notes', 'reference', 'scheduled', 'txn_date'],
    );
  });
});

describe('keepPayable', () => {
  const payable = payableBills([bill(1, { balance: 250.5 }), bill(2, { balance: 80 })], []);
  const [first, second] = payable;

  it('drops an amount whose bill is no longer payable', () => {
    const ticked = form(payable, { amounts: { [first.id]: '250.50', [second.id]: '80.00' } });
    expect(keepPayable(ticked, [second]).amounts).toEqual({ [second.id]: '80.00' });
  });
  it('keeps everything else about the form untouched', () => {
    const ticked = form(payable, { amounts: { [first.id]: '10', [second.id]: '20' }, reference: 'CHQ 1', notes: 'n' });
    const kept = keepPayable(ticked, [second]);
    expect(kept).toMatchObject({ supplierId: ticked.supplierId, accountId: ticked.accountId, reference: 'CHQ 1', notes: 'n' });
    expect(kept.amounts[second.id]).toBe('20');
  });
  it('returns the same form when nothing is dropped', () => {
    const ticked = form(payable, { amounts: { [first.id]: '10' } });
    expect(keepPayable(ticked, payable)).toBe(ticked);
    const empty = form(payable);
    expect(keepPayable(empty, [])).toBe(empty);
  });
});
