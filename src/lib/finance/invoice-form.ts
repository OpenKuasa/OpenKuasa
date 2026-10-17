/**
 * The invoice form's rules, kept out of the components so they can be
 * tested: what a new form holds, what choosing a customer, a date or a
 * product changes, what is wrong with the form, and what is sent to
 * saveInvoiceAction. Also the small e-Invois form. Pure. What a bill form
 * shares is in document-form.ts.
 */
import { billTotals } from './bill-math';
import { BASE_CURRENCY } from './currencies';
import {
  CURRENCY_MESSAGES,
  type CurrencyFields,
  currencyError,
  currencyPayloadWithSource,
  ringgitFields,
  savedFields,
  sourceError,
  withPartyCurrency,
} from './document-currency';
import {
  type DocumentFormKind,
  type LineDraft,
  emptyLine,
  filledFromProduct,
  followedDueDate,
  lineDraft,
  lineNumbers,
  linePayload,
  savedAsDraft,
  withDueDate,
} from './document-form';
import {
  type EInvoiceStatus,
  INVOICE_MESSAGES,
  type InvoiceDetail,
  type InvoiceListRow,
  saveInvoiceInput,
  setEInvoiceInput,
} from './invoices';
import type { FinanceProduct } from './products';
import { rateDateFor } from './sst-rate';

export type InvoiceForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  customer_id: string;
  invoice_date: string;
  due_date: string;
  /** Once the person sets the due date by hand, it is no longer recalculated. */
  dueEdited: boolean;
  notes: string;
  lines: LineDraft[];
  /** The currency, the rate and, for a typed rate, its source. Ringgit for a new form until the person or the customer's default says otherwise. */
  fx: CurrencyFields;
  /** The date of supply as typed; empty means the invoice date. Only drawn, and only sent, for another currency. */
  supplyDate: string;
};

/** A new invoice dated today with one empty line. The due date follows once a customer is chosen. */
export function newInvoiceForm(today: string, lineKey: string): InvoiceForm {
  return {
    customer_id: '',
    invoice_date: today,
    due_date: today,
    dueEdited: false,
    notes: '',
    lines: [emptyLine(lineKey)],
    fx: ringgitFields(),
    supplyDate: '',
  };
}

/** A saved draft, as the form shows it. Its due date was chosen already, so it is kept. */
export function invoiceFormFromDetail(invoice: InvoiceDetail): InvoiceForm {
  return {
    id: invoice.id,
    customer_id: invoice.customer_id,
    invoice_date: invoice.invoice_date,
    due_date: invoice.due_date,
    dueEdited: true,
    notes: invoice.notes ?? '',
    lines: invoice.lines.map(lineDraft),
    fx: savedFields(invoice),
    supplyDate: invoice.supply_date ?? '',
  };
}

/** The date the invoice's rate is for: the date of supply when one is typed, else the invoice date. */
export function invoiceRateDate(form: InvoiceForm): string {
  return rateDateFor(form.invoice_date, form.fx.currency === BASE_CURRENCY ? '' : form.supplyDate);
}

/** The date of supply was typed or cleared. */
export function withSupplyDate(form: InvoiceForm, supplyDate: string): InvoiceForm {
  return { ...form, supplyDate };
}

/**
 * Choosing a customer moves the due date to their payment terms, unless it was set by hand, and on a new invoice
 * whose currency the person has not picked, the currency to the customer's default, when they have one.
 */
export function withCustomer(
  form: InvoiceForm,
  customer: { id: string; payment_terms_days: number; default_currency?: string | null },
): InvoiceForm {
  return {
    ...form,
    customer_id: customer.id,
    due_date: followedDueDate(form, form.invoice_date, customer.payment_terms_days),
    fx: withPartyCurrency(form.fx, customer.default_currency, !form.id),
  };
}

/**
 * Changing the invoice date moves the due date with it, unless it was set by
 * hand. While the invoice date is half typed the due date stays where it was.
 */
export function withInvoiceDate(form: InvoiceForm, invoiceDate: string, termsDays: number | undefined): InvoiceForm {
  return { ...form, invoice_date: invoiceDate, due_date: followedDueDate(form, invoiceDate, termsDays) };
}

/**
 * Choosing a product fills the line from it: its name, unit, price (what the
 * workspace sells it for) and SST rate. The person can then change any of
 * them. Choosing "no product" only clears the link.
 */
export function withSoldProduct(line: LineDraft, product: FinanceProduct | null): LineDraft {
  return filledFromProduct(line, product, product?.price ?? 0);
}

/**
 * What is sent to saveInvoiceAction. Figures are numbers; a box that is not a number goes as NaN and is refused.
 * The currency part always goes (a ringgit invoice as MYR); the date of supply only for another currency.
 */
export function invoicePayload(form: InvoiceForm) {
  const supply = form.supplyDate.trim();
  return {
    ...(form.id ? { id: form.id } : {}),
    customer_id: form.customer_id,
    invoice_date: form.invoice_date,
    due_date: form.due_date,
    notes: form.notes,
    lines: form.lines.map(linePayload),
    ...currencyPayloadWithSource(form.fx),
    supply_date: form.fx.currency === BASE_CURRENCY || supply === '' ? null : supply,
  };
}

/**
 * The first thing wrong with the form, in the schema's own sentence, or null
 * when it can be sent. A draft may total nothing; an invoice being posted may
 * not, and saying so here saves a draft the database would then refuse to
 * post.
 */
export function invoiceFormError(form: InvoiceForm, posting = false): string | null {
  // The rate box first: a rate that is not a number goes as NaN and would read as the schema's word for it.
  const rate = currencyError(form.fx, posting, CURRENCY_MESSAGES.rateBeforePosting) ?? sourceError(form.fx);
  if (rate) return rate;
  const parsed = saveInvoiceInput.safeParse(invoicePayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? INVOICE_MESSAGES.lines;
  if (posting && billTotals(form.lines.map(lineNumbers)).total <= 0) return INVOICE_MESSAGES.empty;
  return null;
}

/** What the form says when the invoice was saved as a draft but posting it was refused. */
export function invoiceSavedNotPosted(error: string): string {
  return savedAsDraft('invoice', error);
}

/** The invoice form, as the shared card draws it. An invoice has no second reference box. */
export const INVOICE_FORM_KIND: DocumentFormKind<InvoiceForm> = {
  noun: 'invoice',
  party: 'customer',
  dateLabel: 'Invoice date',
  partyId: (form) => form.customer_id,
  date: (form) => form.invoice_date,
  withParty: withCustomer,
  withDate: withInvoiceDate,
  secondDate: { label: 'Due date', get: (form) => form.due_date, set: withDueDate },
  discount: true,
  // One rate per invoice, the SST rule's: Bank Negara's 5 pm selling rate for the date of supply.
  currency: { get: (form) => form.fx, set: (form, fx) => ({ ...form, fx }), figure: 'selling', sources: true },
  rateDate: invoiceRateDate,
  supplyDate: {
    label: 'Date of supply (if not the invoice date)',
    hint: 'When the goods were sold or the service provided. The exchange rate is for this date.',
    get: (form) => form.supplyDate,
    set: withSupplyDate,
  },
  withProduct: withSoldProduct,
  error: invoiceFormError,
  payload: invoicePayload,
  savedNotPosted: invoiceSavedNotPosted,
};

/* ---- e-Invois ----------------------------------------------------------- */

/** What a person has recorded about one posted invoice's e-Invois, as its small form holds it. */
export type EInvoiceForm = { status: EInvoiceStatus; uuid: string };

/** The form opens on what the invoice has now. */
export function eInvoiceForm(invoice: Pick<InvoiceListRow, 'einvoice_status' | 'einvoice_uuid'>): EInvoiceForm {
  return { status: invoice.einvoice_status, uuid: invoice.einvoice_uuid ?? '' };
}

/** Choosing "None" empties the UUID box: an invoice with no e-Invois has no UUID, and the box is then closed. */
export function withEInvoiceStatus(form: EInvoiceForm, status: EInvoiceStatus): EInvoiceForm {
  return status === 'none' ? { status, uuid: '' } : { ...form, status };
}

/** What is sent to setEInvoiceAction. */
export function eInvoicePayload(invoiceId: string, form: EInvoiceForm) {
  return { id: invoiceId, einvoice_status: form.status, einvoice_uuid: form.uuid };
}

/** The first thing wrong with the form, in the schema's own sentence, or null when it can be sent. */
export function eInvoiceFormError(invoiceId: string, form: EInvoiceForm): string | null {
  const parsed = setEInvoiceInput.safeParse(eInvoicePayload(invoiceId, form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? INVOICE_MESSAGES.einvoiceStatus);
}
