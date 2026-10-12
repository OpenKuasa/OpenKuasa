/**
 * The purchase order form's rules, kept out of the components so they can be
 * tested: what a new form holds, what choosing a supplier, a date or a product
 * changes, what is wrong with the form, and what is sent to
 * savePurchaseOrderAction. It also holds the rules of the "Record delivery"
 * form, where what has arrived is typed in. Pure. What the bill, invoice,
 * quotation and RFQ forms share with it is in document-form.ts.
 *
 * An order's lines are priced, like a bill's, and a product fills a line from
 * its cost. The order also carries payment terms (which start from the
 * supplier's) and a delivery address.
 */
import { billTotals } from './bill-math';
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
import { typedNumber } from './format';
import type { FinanceProduct } from './products';
import {
  PURCHASE_ORDER_MESSAGES,
  type PurchaseOrderDetail,
  receivePurchaseOrderInput,
  savePurchaseOrderInput,
} from './purchase-orders';
import { WRITE_FAILED } from './result';

export type PurchaseOrderForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  supplier_id: string;
  po_date: string;
  /** Empty when the order names no delivery date. */
  expected_date: string;
  /** Whole days, as typed; empty for none (a new order then takes the supplier's). */
  payment_terms_days: string;
  /** Once the person sets the terms by hand, choosing another supplier no longer changes them. */
  termsEdited: boolean;
  delivery_address: string;
  notes: string;
  lines: LineDraft[];
};

/** A new order dated today, with no expected date, no terms yet and one empty line. */
export function newPurchaseOrderForm(today: string, lineKey: string): PurchaseOrderForm {
  return {
    supplier_id: '',
    po_date: today,
    expected_date: '',
    payment_terms_days: '',
    termsEdited: false,
    delivery_address: '',
    notes: '',
    lines: [emptyLine(lineKey)],
  };
}

/** A saved draft, as the form shows it. Its terms were chosen already, so they are kept. */
export function purchaseOrderFormFromDetail(order: PurchaseOrderDetail): PurchaseOrderForm {
  return {
    id: order.id,
    supplier_id: order.supplier_id,
    po_date: order.po_date,
    expected_date: order.expected_date ?? '',
    payment_terms_days: order.payment_terms_days === null ? '' : String(order.payment_terms_days),
    termsEdited: true,
    delivery_address: order.delivery_address ?? '',
    notes: order.notes ?? '',
    lines: order.lines.map(lineDraft),
  };
}

/** Choosing a supplier fills the payment terms from theirs, unless the person set them by hand. */
export function withOrderSupplier(form: PurchaseOrderForm, supplier: { id: string; payment_terms_days: number }): PurchaseOrderForm {
  return {
    ...form,
    supplier_id: supplier.id,
    payment_terms_days: form.termsEdited ? form.payment_terms_days : String(supplier.payment_terms_days),
  };
}

/** The expected delivery date is the person's to set; it does not follow the order date or the terms. */
export function withOrderDate(form: PurchaseOrderForm, poDate: string): PurchaseOrderForm {
  return { ...form, po_date: poDate };
}

export function withExpectedDate(form: PurchaseOrderForm, expectedDate: string): PurchaseOrderForm {
  return { ...form, expected_date: expectedDate };
}

/** Typing in the terms box, an empty one included, is the person's decision: it is no longer replaced. */
export function withTerms(form: PurchaseOrderForm, terms: string): PurchaseOrderForm {
  return { ...form, payment_terms_days: terms, termsEdited: true };
}

/** Choosing a product fills the line from it: its name, unit, cost (what the workspace pays for it) and SST rate. */
export function withOrderProduct(line: LineDraft, product: FinanceProduct | null): LineDraft {
  return filledFromProduct(line, product, product?.cost ?? 0);
}

/** The terms a person typed: null for an empty box, NaN for text that is not a number (refused). */
function typedTerms(text: string): number | null {
  return text.trim() === '' ? null : (typedNumber(text) ?? Number.NaN);
}

/** What is sent to savePurchaseOrderAction. Figures are numbers; a box that is not a number goes as NaN and is refused. */
export function purchaseOrderPayload(form: PurchaseOrderForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    supplier_id: form.supplier_id,
    po_date: form.po_date,
    expected_date: form.expected_date,
    payment_terms_days: typedTerms(form.payment_terms_days),
    delivery_address: form.delivery_address,
    notes: form.notes,
    lines: form.lines.map(linePayload),
  };
}

/**
 * The first thing wrong with the form, in the schema's own sentence, or null
 * when it can be sent. A draft may total nothing; an order being submitted
 * may not, and saying so here saves a draft the database would then refuse
 * to submit.
 */
export function purchaseOrderFormError(form: PurchaseOrderForm, submitting = false): string | null {
  const parsed = savePurchaseOrderInput.safeParse(purchaseOrderPayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? PURCHASE_ORDER_MESSAGES.lines;
  if (submitting && billTotals(form.lines.map(lineNumbers)).total <= 0) return PURCHASE_ORDER_MESSAGES.empty;
  return null;
}

/** What the form says when the order was saved as a draft but submitting it was refused. */
export function purchaseOrderSavedNotSubmitted(error: string): string {
  if (error === WRITE_FAILED) return 'The purchase order was saved as a draft, but submitting it failed. Please try again.';
  return `The purchase order was saved as a draft, but it was not submitted for approval. ${error}`;
}

/** An order is submitted for approval, not posted: the shared card says so. */
export const PURCHASE_ORDER_FORM_WORDS: DocumentFormWords = {
  newSubtitle: 'Saved as a draft until it is submitted for approval',
  draftSubtitle: 'A draft: it gets its number when it is submitted',
  post: 'Save and submit for approval',
  posting: 'Submitting…',
};

/** The purchase order form, as the shared card draws it. Its second date is when delivery is expected, and may be left empty. */
export const PURCHASE_ORDER_FORM_KIND: DocumentFormKind<PurchaseOrderForm> = {
  noun: 'purchase order',
  party: 'supplier',
  dateLabel: 'Order date',
  partyId: (form) => form.supplier_id,
  date: (form) => form.po_date,
  withParty: withOrderSupplier,
  withDate: withOrderDate,
  secondDate: { label: 'Expected delivery (optional)', optional: true, get: (form) => form.expected_date, set: withExpectedDate },
  extras: [
    {
      label: 'Payment terms (days)',
      placeholder: 'e.g. 30',
      inputMode: 'numeric',
      hint: "Leave empty to use the supplier's terms.",
      get: (form) => form.payment_terms_days,
      set: withTerms,
    },
    {
      label: 'Delivery address (optional)',
      inputMode: 'text',
      get: (form) => form.delivery_address,
      set: (form, value) => ({ ...form, delivery_address: value }),
    },
  ],
  words: PURCHASE_ORDER_FORM_WORDS,
  withProduct: withOrderProduct,
  error: purchaseOrderFormError,
  payload: purchaseOrderPayload,
  savedNotPosted: purchaseOrderSavedNotSubmitted,
};

/* ---- recording what has arrived --------------------------------------- */

/** One line of the "Record delivery" form: what was ordered, and the box for the total that has arrived so far. */
export type ReceiptDraft = {
  line_id: string;
  description: string;
  uom: string | null;
  ordered: number;
  /** The box as typed. It holds the total received so far, not this delivery's share. */
  received: string;
};

/** The lines of an approved order, as boxes to fill in, each showing what has arrived already. */
export function receiptDrafts(order: PurchaseOrderDetail): ReceiptDraft[] {
  return order.lines.map((line) => ({
    line_id: line.id,
    description: line.description,
    uom: line.uom,
    ordered: line.quantity,
    received: String(line.received_quantity),
  }));
}

/** What is sent to receivePurchaseOrderAction. A box that is not a number goes as NaN and is refused; an empty box is not 0. */
export function receivePayload(orderId: string, drafts: ReceiptDraft[]) {
  return {
    id: orderId,
    receipts: drafts.map((d) => ({ line_id: d.line_id, received_quantity: typedNumber(d.received) ?? Number.NaN })),
  };
}

/** The first thing wrong with the boxes, or null. */
export function receiveFormError(drafts: ReceiptDraft[]): string | null {
  if (drafts.length === 0) return PURCHASE_ORDER_MESSAGES.received;
  const parsed = receivePurchaseOrderInput.shape.receipts.safeParse(receivePayload('', drafts).receipts);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? PURCHASE_ORDER_MESSAGES.received);
}

/**
 * What "Save delivery" does with the boxes: the sentence to show, with nothing
 * to send, or the payload for receivePurchaseOrderAction. The card calls this
 * and nothing else, so a bad box is refused before any call is made.
 */
export function submitReceipts(
  orderId: string,
  drafts: ReceiptDraft[],
): { error: string } | { payload: ReturnType<typeof receivePayload> } {
  const error = receiveFormError(drafts);
  return error ? { error } : { payload: receivePayload(orderId, drafts) };
}
