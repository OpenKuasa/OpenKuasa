/**
 * The quotation form's rules, kept out of the components so they can be
 * tested: what a new form holds, what choosing a customer, a date or a
 * product changes, what is wrong with the form, and what is sent to
 * saveQuotationAction. Pure. What a bill and an invoice form share with it is
 * in document-form.ts.
 */
import { addDaysIso, billTotals } from './bill-math';
import {
  type DocumentFormKind,
  type DocumentFormWords,
  type LineDraft,
  emptyLine,
  filledFromProduct,
  lineDraft,
  lineNumbers,
  linePayload,
} from './document-form';
import { isIsoDate } from './document-lines';
import type { FinanceProduct } from './products';
import { QUOTATION_MESSAGES, type QuotationDetail, saveQuotationInput } from './quotations';
import { WRITE_FAILED } from './result';

/** How long a new quotation is valid for, until the person says otherwise. */
export const QUOTATION_VALID_DAYS = 30;

export type QuotationForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  customer_id: string;
  quote_date: string;
  valid_until: string;
  /** Once the person sets the valid-until date by hand, it no longer follows the quotation date. */
  validEdited: boolean;
  notes: string;
  lines: LineDraft[];
};

/** The quotation date plus thirty days. A customer's payment terms say when an invoice is due, not how long a price holds. */
export function defaultValidUntil(quoteDate: string): string {
  return addDaysIso(quoteDate, QUOTATION_VALID_DAYS);
}

/** A new quotation dated today, valid for thirty days, with one empty line. */
export function newQuotationForm(today: string, lineKey: string): QuotationForm {
  return {
    customer_id: '',
    quote_date: today,
    valid_until: defaultValidUntil(today),
    validEdited: false,
    notes: '',
    lines: [emptyLine(lineKey)],
  };
}

/** A saved draft, as the form shows it. Its valid-until date was chosen already, so it is kept. */
export function quotationFormFromDetail(quotation: QuotationDetail): QuotationForm {
  return {
    id: quotation.id,
    customer_id: quotation.customer_id,
    quote_date: quotation.quote_date,
    valid_until: quotation.valid_until,
    validEdited: true,
    notes: quotation.notes ?? '',
    lines: quotation.lines.map(lineDraft),
  };
}

/** Choosing a customer changes nothing else: how long the quotation is valid does not depend on who it is for. */
export function withQuotationCustomer(form: QuotationForm, customer: { id: string }): QuotationForm {
  return { ...form, customer_id: customer.id };
}

/**
 * Changing the quotation date moves the valid-until date with it, unless it
 * was set by hand. While the quotation date is half typed the valid-until
 * date stays where it was.
 */
export function withQuoteDate(form: QuotationForm, quoteDate: string): QuotationForm {
  return {
    ...form,
    quote_date: quoteDate,
    valid_until: !form.validEdited && isIsoDate(quoteDate) ? defaultValidUntil(quoteDate) : form.valid_until,
  };
}

/** Once the person sets the valid-until date by hand, it is no longer recalculated. */
export function withValidUntil(form: QuotationForm, validUntil: string): QuotationForm {
  return { ...form, valid_until: validUntil, validEdited: true };
}

/**
 * Choosing a product fills the line from it: its name, unit, price (what the
 * workspace sells it for) and SST rate, as on an invoice. The person can then
 * change any of them. Choosing "no product" only clears the link.
 */
export function withQuotedProduct(line: LineDraft, product: FinanceProduct | null): LineDraft {
  return filledFromProduct(line, product, product?.price ?? 0);
}

/** What is sent to saveQuotationAction. Figures are numbers; a box that is not a number goes as NaN and is refused. */
export function quotationPayload(form: QuotationForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    customer_id: form.customer_id,
    quote_date: form.quote_date,
    valid_until: form.valid_until,
    notes: form.notes,
    lines: form.lines.map(linePayload),
  };
}

/**
 * The first thing wrong with the form, in the schema's own sentence, or null
 * when it can be sent. A draft may total nothing; a quotation being marked as
 * sent may not, and saying so here saves a draft the database would then
 * refuse to send.
 */
export function quotationFormError(form: QuotationForm, sending = false): string | null {
  const parsed = saveQuotationInput.safeParse(quotationPayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? QUOTATION_MESSAGES.lines;
  if (sending && billTotals(form.lines.map(lineNumbers)).total <= 0) return QUOTATION_MESSAGES.empty;
  return null;
}

/** What the form says when the quotation was saved as a draft but marking it as sent was refused. */
export function quotationSavedNotSent(error: string): string {
  if (error === WRITE_FAILED) return 'The quotation was saved as a draft, but marking it as sent failed. Please try again.';
  return `The quotation was saved as a draft, but it was not marked as sent. ${error}`;
}

/** A quotation is marked as sent, not posted: the shared card says so. */
export const QUOTATION_FORM_WORDS: DocumentFormWords = {
  newSubtitle: 'Saved as a draft until it is marked as sent',
  draftSubtitle: 'A draft: it gets its number when it is marked as sent',
  post: 'Save and mark as sent',
  posting: 'Marking as sent…',
};

/** The quotation form, as the shared card draws it. Its second date is how long the price holds, not when money is due. */
export const QUOTATION_FORM_KIND: DocumentFormKind<QuotationForm> = {
  noun: 'quotation',
  party: 'customer',
  dateLabel: 'Quotation date',
  partyId: (form) => form.customer_id,
  date: (form) => form.quote_date,
  withParty: withQuotationCustomer,
  withDate: withQuoteDate,
  secondDate: { label: 'Valid until', get: (form) => form.valid_until, set: withValidUntil },
  words: QUOTATION_FORM_WORDS,
  withProduct: withQuotedProduct,
  error: quotationFormError,
  payload: quotationPayload,
  savedNotPosted: quotationSavedNotSent,
};
