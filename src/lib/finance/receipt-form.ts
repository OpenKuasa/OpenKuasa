/**
 * The payment-in form's rules, kept out of the component so they can be
 * tested: which invoices can still take a payment, what each defaults to,
 * what is wrong with the form, and what is sent to recordPaymentInAction.
 * Pure. Money in is recorded once it has arrived, so there is no scheduling.
 * What a payment out shares is in allocation-form.ts.
 *
 * An invoice in another currency (stage 3b) is paid from a ringgit account:
 * the amounts ticked are in the invoice's currency, and the form also asks
 * for the ringgit that arrived. One payment is in one currency: the first
 * invoice ticked sets it, and only that currency's invoices are offered
 * until every tick is cleared.
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
import { BASE_CURRENCY, minorUnits } from './currencies';
import { CURRENCY_MESSAGES } from './document-currency';
import { money, rm, typedNumber } from './format';
import { settlementPreview } from './fx-settlement';
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
  /** The invoice's currency: balance, held and payable are in it. */
  currency: string;
  /** The invoice's rate as the database's exact text; "1.0000000000" for ringgit. */
  fx_rate_text: string | null;
  /** What is still owed in ringgit (posted payments only): what the closing payment carries. */
  balance_myr: number;
};

export type ReceiptForm = {
  customerId: string;
  /** The ticked invoices, each with the amount as typed, in `currency`. */
  amounts: Record<string, string>;
  /** The currency of the ticked invoices: the first one ticked sets it. Read only while something is ticked. */
  currency: string;
  /** For invoices in another currency: the ringgit that arrived, as typed. */
  ringgit: string;
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
  // Any currency (stage 3b): an invoice in another currency is paid from a ringgit account with the ringgit
  // received. A posted invoice always has its rate.
  return invoices
    .filter(
      (i) =>
        (i.display_status === 'sent' || i.display_status === 'overdue') &&
        i.balance > 0 &&
        (i.currency === BASE_CURRENCY || i.fx_rate_text !== null),
    )
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
        currency: i.currency,
        fx_rate_text: i.fx_rate_text,
        balance_myr: i.balance_myr ?? i.balance,
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

/** The currency the ticked amounts are in; null while nothing is ticked. */
export function receiptCurrency(form: ReceiptForm): string | null {
  return Object.keys(form.amounts).length > 0 ? form.currency : null;
}

/** True when the ticked invoices are in another currency, so the ringgit received is asked for. */
export function needsRinggit(form: ReceiptForm): boolean {
  const currency = receiptCurrency(form);
  return currency !== null && currency !== BASE_CURRENCY;
}

/**
 * The chosen customer's invoices the form lists: all of them while nothing is ticked, then only those in the
 * ticked invoices' currency (one payment, one currency: FIN44).
 */
export function offeredInvoices(form: ReceiptForm, receivable: ReceivableInvoice[]): ReceivableInvoice[] {
  const mine = invoicesOf(receivable, form.customerId);
  const currency = receiptCurrency(form);
  return currency === null ? mine : mine.filter((i) => i.currency === currency);
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
    currency: invoice?.currency ?? BASE_CURRENCY,
    ringgit: '',
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    notes: '',
  };
}

/** Choosing another customer starts the ticks again: one payment is from one customer. */
export function chooseCustomer(form: ReceiptForm, customerId: string): ReceiptForm {
  return customerId === form.customerId ? form : { ...form, customerId, amounts: {}, ringgit: '' };
}

/**
 * Ticks an invoice for all it can still take, or unticks it. The first invoice ticked sets the payment's
 * currency; an invoice in another currency than the ones ticked starts the ticks again with it.
 */
export function toggleInvoice(form: ReceiptForm, invoice: ReceivableInvoice, on: boolean): ReceiptForm {
  const current = receiptCurrency(form);
  const base = on && current !== null && current !== invoice.currency ? { ...form, amounts: {}, ringgit: '' } : form;
  return ticked(on ? { ...base, currency: invoice.currency } : base, invoice, on);
}

/** Ticks every invoice given (the ones offered, so of one currency), or clears them all. */
export function toggleAllInvoices(form: ReceiptForm, invoices: ReceivableInvoice[], on: boolean): ReceiptForm {
  const currency = on ? (receiptCurrency(form) ?? invoices[0]?.currency ?? form.currency) : form.currency;
  return tickedAll({ ...form, currency }, on ? invoices.filter((i) => i.currency === currency) : invoices, on);
}

/** The ringgit box, as typed. */
export function withRinggit(form: ReceiptForm, text: string): ReceiptForm {
  return { ...form, ringgit: text };
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

/**
 * What is sent to recordPaymentInAction. Amounts are numbers; a box that is not a number goes as NaN and is
 * refused. For invoices in another currency the ringgit received goes as the text typed (commas dropped), so
 * no float stands between the box and the database.
 */
export function receiptPayload(form: ReceiptForm) {
  return {
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reference: form.reference,
    notes: form.notes,
    ...(needsRinggit(form) ? { amount_myr: form.ringgit.replace(/,/g, '').trim() } : {}),
    allocations: typedAmounts(form.amounts).map(({ id, amount }) => ({ invoice_id: id, amount })),
  };
}

/**
 * Under the ringgit box: what the database will make of the payment, worked in whole sen (fx-settlement.ts),
 * as "about" (a payment posted first can change it). Empty for ringgit and while a figure is not a number.
 */
export function receiptPreview(form: ReceiptForm, receivable: ReceivableInvoice[]): string[] {
  if (!needsRinggit(form)) return [];
  const parts = Object.entries(form.amounts).map(([id, amount]) => {
    const invoice = receivable.find((i) => i.id === id);
    return {
      id,
      amount: amount.replace(/,/g, ''),
      rateText: invoice?.fx_rate_text ?? null,
      openForeign: invoice?.balance ?? 0,
      openRinggit: invoice?.balance_myr ?? 0,
    };
  });
  const preview = settlementPreview(form.ringgit.replace(/,/g, ''), parts);
  if (!preview) return [];
  const at = `The ${preview.parts.length === 1 ? 'invoice carries' : 'invoices carry'} about ${rm(preview.carried)} for what is paid.`;
  if (preview.realised === 0) return [at, 'No exchange gain or loss.'];
  const word = preview.realised > 0 ? 'gain' : 'loss';
  return [at, `Realised exchange ${word} of about ${rm(Math.abs(preview.realised))}.`];
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent.
 */
export function receiptFormError(form: ReceiptForm, receivable: ReceivableInvoice[]): string | null {
  if (!form.customerId) return INVOICE_MESSAGES.customer;
  if (Object.keys(form.amounts).length === 0) return RECEIPT_MESSAGES.invoices;
  // An invoice that is no longer receivable was paid or voided since the form opened.
  const problem = amountsError(form.amounts, offeredInvoices(form, receivable), RECEIPT_MESSAGES);
  if (problem) return problem;
  const currency = receiptCurrency(form);
  if (currency !== null && minorUnits(currency) === 0) {
    const whole = Object.values(form.amounts).every((text) => Number.isInteger(typedNumber(text)));
    if (!whole) return CURRENCY_MESSAGES.wholeUnits(currency);
  }
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
    `${money(invoice.payable, invoice.currency)} owed` +
    (invoice.currency === BASE_CURRENCY ? '' : ` (≈ ${rm(invoice.balance_myr)} still carried)`) +
    (invoice.held > 0
      ? ` · ${money(invoice.held, invoice.currency)} of ${money(invoice.balance, invoice.currency)} held by a payment not yet posted`
      : ''),
  amountLabel: (invoice) => `Amount received for ${invoice.invoice_no}`,
  toggle: toggleInvoice,
  toggleAll: toggleAllInvoices,
  keep: keepReceivable,
  total: receiptTotal,
  error: receiptFormError,
  payload: receiptPayload,
  currency: {
    of: (form) => receiptCurrency(form) ?? BASE_CURRENCY,
    offered: offeredInvoices,
    ringgit: {
      needed: needsRinggit,
      value: (form) => form.ringgit,
      set: withRinggit,
      label: 'Ringgit received',
      hint: 'What arrived in the account, in RM. The amounts above are in the invoices’ currency.',
      notes: receiptPreview,
    },
  },
};
