/**
 * The payment-in form's rules, kept out of the component so they can be
 * tested: which invoices can still take a payment, what each defaults to,
 * what is wrong with the form, and what is sent to recordPaymentInAction.
 * Pure. Money in is recorded once it has arrived, so there is no scheduling.
 * What a payment out shares is in allocation-form.ts.
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
import { rm } from './format';
import { INVOICE_MESSAGES, type InvoiceListRow } from './invoices';
import {
  type FinanceAccount,
  type PaymentInRow,
  type PaymentMethod,
  RECEIPT_MESSAGES,
  recordPaymentInInput,
} from './money';

export type ReceivableInvoice = {
  id: string;
  invoice_no: string;
  customer_id: string;
  customer_name: string;
  due_date: string;
  overdue: boolean;
  /** Still owed after every payment received. */
  balance: number;
  /** Held by payments that are not yet posted. The app never makes one; the database counts them all the same. */
  held: number;
  /** What a new payment may take: the balance less what is held. */
  payable: number;
};

export type ReceiptForm = {
  customerId: string;
  /** The ticked invoices, each with the amount as typed. */
  amounts: Record<string, string>;
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
};

/** What payments in that are not yet posted hold of each invoice, to the sen, by invoice id. */
export function heldByInvoice(payments: PaymentInRow[]): Record<string, number> {
  return heldBy(payments, (p) => p.invoice_id);
}

/**
 * The invoices a payment can be recorded against: posted ("Sent" or
 * "Overdue"), not paid in full, and not already covered by a payment that is
 * not yet posted. The database refuses a payment for more than is still owed,
 * so that is what the form offers.
 */
export function receivableInvoices(invoices: InvoiceListRow[], payments: PaymentInRow[]): ReceivableInvoice[] {
  const heldNow = heldByInvoice(payments);
  return invoices
    .filter((i) => (i.display_status === 'sent' || i.display_status === 'overdue') && i.balance > 0)
    .map((i) => {
      const held = heldNow[i.id] ?? 0;
      return {
        id: i.id,
        invoice_no: i.invoice_no ?? '—',
        customer_id: i.customer_id,
        customer_name: i.customer_name,
        due_date: i.due_date,
        overdue: i.display_status === 'overdue',
        balance: i.balance,
        held,
        payable: round2(i.balance - held),
      };
    })
    .filter((i) => i.payable > 0)
    .sort(
      (x, y) =>
        x.customer_name.localeCompare(y.customer_name) ||
        x.due_date.localeCompare(y.due_date) ||
        x.invoice_no.localeCompare(y.invoice_no),
    );
}

/** The customers that have at least one invoice to pay, by name, with how many. */
export function receiptCustomers(receivable: ReceivableInvoice[]): { id: string; name: string; open: number }[] {
  return partiesOf(
    receivable,
    (i) => i.customer_id,
    (i) => i.customer_name,
  );
}

/** One customer's receivable invoices, the earliest due first. */
export function invoicesOf(receivable: ReceivableInvoice[], customerId: string): ReceivableInvoice[] {
  return receivable.filter((i) => i.customer_id === customerId);
}

/**
 * A fresh form. The account defaults to the first bank account. With
 * `preselect` (the Record payment choice on an invoice row) the customer is
 * chosen and that invoice ticked for all it can still take.
 */
export function newReceiptForm(
  receivable: ReceivableInvoice[],
  accounts: FinanceAccount[],
  today: string,
  preselect?: { customerId: string; invoiceId: string },
): ReceiptForm {
  const customers = receiptCustomers(receivable);
  const invoice = preselect
    ? receivable.find((i) => i.id === preselect.invoiceId && i.customer_id === preselect.customerId)
    : undefined;
  return {
    customerId: preselect?.customerId ?? (customers.length === 1 ? customers[0].id : ''),
    amounts: invoice ? { [invoice.id]: amountText(invoice.payable) } : {},
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    notes: '',
  };
}

/** Choosing another customer starts the ticks again: one payment is from one customer. */
export function chooseCustomer(form: ReceiptForm, customerId: string): ReceiptForm {
  return customerId === form.customerId ? form : { ...form, customerId, amounts: {} };
}

/** Ticks an invoice for all it can still take, or unticks it. */
export function toggleInvoice(form: ReceiptForm, invoice: ReceivableInvoice, on: boolean): ReceiptForm {
  return ticked(form, invoice, on);
}

/** Ticks every invoice of the chosen customer, or clears them all. */
export function toggleAllInvoices(form: ReceiptForm, invoices: ReceivableInvoice[], on: boolean): ReceiptForm {
  return tickedAll(form, invoices, on);
}

/**
 * After a refresh, a ticked invoice that was paid off or voided meanwhile is
 * no longer in `invoices`. Its amount goes, so the total, the count and the
 * save stay true to what the person can see. The same form when nothing goes.
 */
export function keepReceivable(form: ReceiptForm, invoices: ReceivableInvoice[]): ReceiptForm {
  return keptOffered(form, invoices);
}

/** The running total: every ticked amount that is a number above 0. */
export function receiptTotal(form: ReceiptForm): number {
  return amountsTotal(form.amounts);
}

/** What is sent to recordPaymentInAction. Amounts are numbers; a box that is not a number goes as NaN and is refused. */
export function receiptPayload(form: ReceiptForm) {
  return {
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reference: form.reference,
    notes: form.notes,
    allocations: typedAmounts(form.amounts).map(({ id, amount }) => ({ invoice_id: id, amount })),
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent.
 */
export function receiptFormError(form: ReceiptForm, receivable: ReceivableInvoice[]): string | null {
  if (!form.customerId) return INVOICE_MESSAGES.customer;
  if (Object.keys(form.amounts).length === 0) return RECEIPT_MESSAGES.invoices;
  // An invoice that is no longer receivable was paid or voided since the form opened.
  const problem = amountsError(form.amounts, invoicesOf(receivable, form.customerId), RECEIPT_MESSAGES);
  if (problem) return problem;
  const parsed = recordPaymentInInput.safeParse(receiptPayload(form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? RECEIPT_MESSAGES.amount);
}

/** The payment-in form, as the shared card draws it. It has no `schedule`: money in is never scheduled. */
export const PAYMENT_IN_KIND: AllocationFormKind<ReceiptForm, ReceivableInvoice> = {
  words: {
    subtitle: 'Money received from a customer, against their invoices',
    party: 'customer',
    document: 'invoice',
    documents: 'Invoices paid',
    nothing:
      'There is no invoice to take a payment for. An invoice can be paid once it is posted, and until payments cover it in full.',
    account: 'Paid into',
    date: 'Date received',
    submit: 'Record payment',
  },
  newForm: (receivable, accounts, today, preselect) =>
    newReceiptForm(
      receivable,
      accounts,
      today,
      preselect ? { customerId: preselect.partyId, invoiceId: preselect.documentId } : undefined,
    ),
  partyId: (form) => form.customerId,
  chooseParty: chooseCustomer,
  parties: receiptCustomers,
  documentsOf: invoicesOf,
  number: (invoice) => invoice.invoice_no,
  owed: (invoice) =>
    `${rm(invoice.payable)} owed${invoice.held > 0 ? ` · ${rm(invoice.held)} of ${rm(invoice.balance)} held by a payment not yet posted` : ''}`,
  amountLabel: (invoice) => `Amount received for ${invoice.invoice_no}`,
  toggle: toggleInvoice,
  toggleAll: toggleAllInvoices,
  keep: keepReceivable,
  total: receiptTotal,
  error: receiptFormError,
  payload: receiptPayload,
};
