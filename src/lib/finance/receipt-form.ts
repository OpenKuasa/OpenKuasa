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
 *
 * Stage 5b: invoices in another currency may also be paid into an account in that currency. The account picker
 * then lists it beside the ringgit ones; choosing it offers that currency's invoices only and asks no ringgit but
 * the movement's rate (BNM's selling rate for the date, or typed).
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
import { CURRENCY_MESSAGES, type CurrencyFields, ringgitFields } from './document-currency';
import { money, rm, typedNumber } from './format';
import { settlementPreview } from './fx-settlement';
import {
  fxForAccount,
  movementAccounts,
  movementRateError,
  movementRatePayload,
  movementRinggit,
  movementRinggitNote,
  onForeignAccount,
} from './movement-rate';
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
  /** The chosen account's currency and the movement's rate (stage 5b); ringgit, with no rate, on a ringgit account. */
  fx: CurrencyFields;
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

/** True when the payment is into an account in another currency (stage 5b): the rate is asked instead of the ringgit. */
export function intoForeignAccount(form: Pick<ReceiptForm, 'fx'>): boolean {
  return onForeignAccount(form.fx);
}

/** True when the ticked invoices are in another currency and paid into a ringgit account, so the ringgit received is asked for. */
export function needsRinggit(form: ReceiptForm): boolean {
  const currency = receiptCurrency(form);
  return currency !== null && currency !== BASE_CURRENCY && !intoForeignAccount(form);
}

/**
 * The chosen customer's invoices the form lists: all of them while nothing is ticked, then only those in the
 * ticked invoices' currency (one payment, one currency: FIN44).
 */
export function offeredInvoices(form: ReceiptForm, receivable: ReceivableInvoice[]): ReceivableInvoice[] {
  const mine = invoicesOf(receivable, form.customerId);
  // Stage 5b: into an account in another currency, that currency's invoices only (FIN51).
  const currency = intoForeignAccount(form) ? form.fx.currency : receiptCurrency(form);
  return currency === null ? mine : mine.filter((i) => i.currency === currency);
}

/**
 * The accounts the form offers (stage 5b): the ringgit ones, and those in the ticked invoices' currency when it is
 * another one (the account chosen stays offered).
 */
export function receiptAccounts(form: ReceiptForm, accounts: FinanceAccount[]): FinanceAccount[] {
  return movementAccounts(accounts, receiptCurrency(form), form.accountId);
}

/** The account chosen. One in another currency takes the rate box in its currency and keeps only that currency's ticks. */
export function chooseReceiptAccount(form: ReceiptForm, account: FinanceAccount): ReceiptForm {
  const fx = fxForAccount(form.fx, account.currency);
  const next = { ...form, accountId: account.id, fx };
  if (!onForeignAccount(fx)) return next;
  const keep = receiptCurrency(form) === account.currency;
  return { ...next, currency: account.currency, ringgit: '', ...(keep ? {} : { amounts: {} }) };
}

/** The rate part, as typed or as BNM's answer left it. */
export function withReceiptFx(form: ReceiptForm, fx: CurrencyFields): ReceiptForm {
  return { ...form, fx };
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
    fx: ringgitFields(),
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

/**
 * Under the list, while nothing is ticked and the customer's invoices are in more than one currency: what "Tick
 * all" will do, since one payment settles one currency (it ticks the first invoice's currency). Empty otherwise.
 */
export function currencyListNotes(form: ReceiptForm, receivable: ReceivableInvoice[]): string[] {
  if (receiptCurrency(form) !== null) return [];
  const offered = offeredInvoices(form, receivable);
  if (new Set(offered.map((i) => i.currency)).size < 2) return [];
  return [
    `One payment settles invoices in one currency: Tick all ticks the ${offered[0].currency} invoices, and ticking one invoice lists only those in its currency.`,
  ];
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
    // Stage 5b: into an account in another currency, the movement's rate.
    ...movementRatePayload(form.fx),
    allocations: typedAmounts(form.amounts).map(({ id, amount }) => ({ invoice_id: id, amount })),
  };
}

/** The parts of a payment as the previews read them: each ticked invoice's amount, rate and what is still open on it. */
function receiptParts(form: ReceiptForm, receivable: ReceivableInvoice[]) {
  return Object.entries(form.amounts).map(([id, amount]) => {
    const invoice = receivable.find((i) => i.id === id);
    return {
      id,
      amount: amount.replace(/,/g, ''),
      rateText: invoice?.fx_rate_text ?? null,
      openForeign: invoice?.balance ?? 0,
      openRinggit: invoice?.balance_myr ?? 0,
    };
  });
}

/** The realised difference of a preview, in the form's words. */
function receiptWords(preview: { parts: unknown[]; carried: number; realised: number }): string[] {
  const at = `The ${preview.parts.length === 1 ? 'invoice carries' : 'invoices carry'} about ${rm(preview.carried)} for what is paid.`;
  if (preview.realised === 0) return [at, 'No exchange gain or loss.'];
  const word = preview.realised > 0 ? 'gain' : 'loss';
  return [at, `Realised exchange ${word} of about ${rm(Math.abs(preview.realised))}.`];
}

/**
 * Under the rate box, on an account in another currency (stage 5b): the payment in ringgit at the rate, and the
 * realised difference worked through `settlementPreview` with that ringgit, as "about".
 */
export function receiptAccountNotes(form: ReceiptForm, receivable: ReceivableInvoice[]): string[] {
  if (!intoForeignAccount(form) || receiptCurrency(form) === null) return [];
  const total = amountText(receiptTotal(form));
  const notes = [movementRinggitNote(total, form.fx)].filter((n): n is string => n !== null);
  const ringgit = movementRinggit(total, form.fx);
  const preview = ringgit === null ? null : settlementPreview(ringgit, receiptParts(form, receivable));
  return preview ? [...notes, ...receiptWords(preview)] : notes;
}

/**
 * Under the ringgit box: what the database will make of the payment, worked in whole sen (fx-settlement.ts),
 * as "about" (a payment posted first can change it). Empty for ringgit and while a figure is not a number.
 */
export function receiptPreview(form: ReceiptForm, receivable: ReceivableInvoice[]): string[] {
  if (!needsRinggit(form)) return [];
  const preview = settlementPreview(form.ringgit.replace(/,/g, ''), receiptParts(form, receivable));
  return preview ? receiptWords(preview) : [];
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
  // Stage 5b: into an account in another currency, that currency's invoices with the movement's rate.
  if (intoForeignAccount(form)) {
    if (currency !== null && currency !== form.fx.currency) return RECEIPT_MESSAGES.foreignAccountInvoices;
    const rate = movementRateError(form.fx);
    if (rate) return rate;
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
    of: (form) => (intoForeignAccount(form) ? form.fx.currency : (receiptCurrency(form) ?? BASE_CURRENCY)),
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
  account: {
    offered: receiptAccounts,
    choose: chooseReceiptAccount,
    fx: (form) => form.fx,
    setFx: withReceiptFx,
    notes: receiptAccountNotes,
  },
};
