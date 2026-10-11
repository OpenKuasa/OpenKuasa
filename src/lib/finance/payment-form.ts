/**
 * The payment-out form's rules, kept out of the component so they can be
 * tested: which bills can still take a payment, what each defaults to, what
 * is wrong with the form, and what is sent to recordPaymentOutAction. Pure.
 * What a payment in shares is in allocation-form.ts.
 */
import {
  type AllocationFormKind,
  amountText,
  amountsError,
  amountsTotal,
  defaultAccount,
  heldBy,
  keptOffered,
  partiesOf,
  round2,
  ticked,
  tickedAll,
  typedAmounts,
} from './allocation-form';
import { BILL_MESSAGES, type BillListRow } from './bills';
import { rm } from './format';
import {
  type FinanceAccount,
  MONEY_MESSAGES,
  type PaymentMethod,
  type PaymentOutRow,
  recordPaymentOutInput,
} from './money';

// Defined in allocation-form.ts, which the payment-in form shares; kept exported from here because the purchase-side tests import it from this module.
export { amountText } from './allocation-form';

export type PayableBill = {
  id: string;
  bill_no: string;
  supplier_id: string;
  supplier_name: string;
  due_date: string;
  overdue: boolean;
  /** Still owed after every paid payment. */
  balance: number;
  /** Promised by payments that are scheduled but not yet paid. */
  scheduled: number;
  /** What a new payment may take: the balance less what is already scheduled. */
  payable: number;
};

export type PaymentForm = {
  supplierId: string;
  /** The ticked bills, each with the amount as typed. */
  amounts: Record<string, string>;
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
  /** False to pay now; true to schedule for later. */
  scheduled: boolean;
};

/**
 * What payments that have not been paid yet already hold of each bill, to the
 * sen, by bill id. A bill with nothing held is not in the answer. Supplier
 * Bills shows it under a balance, so a bill with no Pay choice says why.
 */
export function heldByBill(payments: PaymentOutRow[]): Record<string, number> {
  return heldBy(payments, (p) => p.bill_id);
}

/**
 * The bills a payment can be recorded against: posted, not fully paid, and not
 * already covered by scheduled payments. The database refuses a payment for
 * more than balance − scheduled, so that is what the form offers.
 */
export function payableBills(bills: BillListRow[], payments: PaymentOutRow[]): PayableBill[] {
  const held = heldByBill(payments);
  return bills
    .filter((b) => (b.display_status === 'pending' || b.display_status === 'overdue') && b.balance > 0)
    .map((b) => {
      const scheduled = held[b.id] ?? 0;
      return {
        id: b.id,
        bill_no: b.bill_no ?? '—',
        supplier_id: b.supplier_id,
        supplier_name: b.supplier_name,
        due_date: b.due_date,
        overdue: b.display_status === 'overdue',
        balance: b.balance,
        scheduled,
        payable: round2(b.balance - scheduled),
      };
    })
    .filter((b) => b.payable > 0)
    .sort(
      (x, y) =>
        x.supplier_name.localeCompare(y.supplier_name) ||
        x.due_date.localeCompare(y.due_date) ||
        x.bill_no.localeCompare(y.bill_no),
    );
}

/** The suppliers that have at least one bill to pay, by name. */
export function paymentSuppliers(payable: PayableBill[]): { id: string; name: string; bills: number }[] {
  return partiesOf(
    payable,
    (b) => b.supplier_id,
    (b) => b.supplier_name,
  ).map(({ id, name, open }) => ({ id, name, bills: open }));
}

/** One supplier's payable bills, the earliest due first. */
export function billsOf(payable: PayableBill[], supplierId: string): PayableBill[] {
  return payable.filter((b) => b.supplier_id === supplierId);
}

/**
 * A fresh form. The account defaults to the first bank account. With
 * `preselect` (the Pay choice on a bill row) the supplier is chosen and that
 * bill ticked for all it can still take.
 */
export function newPaymentForm(
  payable: PayableBill[],
  accounts: FinanceAccount[],
  today: string,
  preselect?: { supplierId: string; billId: string },
): PaymentForm {
  const suppliers = paymentSuppliers(payable);
  const bill = preselect ? payable.find((b) => b.id === preselect.billId && b.supplier_id === preselect.supplierId) : undefined;
  return {
    supplierId: preselect?.supplierId ?? (suppliers.length === 1 ? suppliers[0].id : ''),
    amounts: bill ? { [bill.id]: amountText(bill.payable) } : {},
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    notes: '',
    scheduled: false,
  };
}

/** Choosing another supplier starts the ticks again: one payment pays one supplier. */
export function chooseSupplier(form: PaymentForm, supplierId: string): PaymentForm {
  return supplierId === form.supplierId ? form : { ...form, supplierId, amounts: {} };
}

/** Ticks a bill for all it can still take, or unticks it. */
export function toggleBill(form: PaymentForm, bill: PayableBill, on: boolean): PaymentForm {
  return ticked(form, bill, on);
}

/** Ticks every bill of the chosen supplier, or clears them all. */
export function toggleAll(form: PaymentForm, bills: PayableBill[], on: boolean): PaymentForm {
  return tickedAll(form, bills, on);
}

/**
 * After a refresh, a ticked bill that was paid off or voided meanwhile is no
 * longer in `bills`. Its amount goes, so the total, the count and the save
 * stay true to what the person can see. The same form when nothing goes.
 */
export function keepPayable(form: PaymentForm, bills: PayableBill[]): PaymentForm {
  return keptOffered(form, bills);
}

/** The running total: every ticked amount that is a number above 0. */
export function paymentTotal(form: PaymentForm): number {
  return amountsTotal(form.amounts);
}

/** What is sent to recordPaymentOutAction. Amounts are numbers; a box that is not a number goes as NaN and is refused. */
export function paymentPayload(form: PaymentForm) {
  return {
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reference: form.reference,
    notes: form.notes,
    scheduled: form.scheduled,
    allocations: typedAmounts(form.amounts).map(({ id, amount }) => ({ bill_id: id, amount })),
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent.
 */
export function paymentFormError(form: PaymentForm, payable: PayableBill[]): string | null {
  if (!form.supplierId) return BILL_MESSAGES.supplier;
  if (Object.keys(form.amounts).length === 0) return MONEY_MESSAGES.bills;
  // A bill that is no longer payable was paid or voided since the form opened.
  const problem = amountsError(form.amounts, billsOf(payable, form.supplierId), MONEY_MESSAGES);
  if (problem) return problem;
  const parsed = recordPaymentOutInput.safeParse(paymentPayload(form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? MONEY_MESSAGES.amount);
}

/** The payment-out form, as the shared card draws it. */
export const PAYMENT_OUT_KIND: AllocationFormKind<PaymentForm, PayableBill> = {
  words: {
    subtitle: 'Pay a supplier\'s bills, now or later',
    party: 'supplier',
    document: 'bill',
    documents: 'Bills to pay',
    nothing: 'There is no bill to pay. A bill can be paid once it is posted, and until payments cover it in full.',
    account: 'Paid from',
    date: 'Date paid',
    submit: 'Record payment',
  },
  newForm: (payable, accounts, today, preselect) =>
    newPaymentForm(
      payable,
      accounts,
      today,
      preselect ? { supplierId: preselect.partyId, billId: preselect.documentId } : undefined,
    ),
  partyId: (form) => form.supplierId,
  chooseParty: chooseSupplier,
  parties: (payable) => paymentSuppliers(payable).map(({ id, name, bills }) => ({ id, name, open: bills })),
  documentsOf: billsOf,
  number: (bill) => bill.bill_no,
  owed: (bill) =>
    `${rm(bill.payable)} to pay${bill.scheduled > 0 ? ` · ${rm(bill.scheduled)} of ${rm(bill.balance)} already scheduled` : ''}`,
  amountLabel: (bill) => `Amount to pay on ${bill.bill_no}`,
  toggle: toggleBill,
  toggleAll,
  keep: keepPayable,
  total: paymentTotal,
  error: paymentFormError,
  payload: paymentPayload,
  schedule: { is: (form) => form.scheduled, set: (form, scheduled) => ({ ...form, scheduled }) },
};
