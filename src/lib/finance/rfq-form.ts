/**
 * The RFQ form's rules, kept out of the components so they can be tested:
 * what a new form holds, what choosing a supplier, a date or a product
 * changes, what is wrong with the form, and what is sent to saveRfqAction. It
 * also holds the rules of the "Record prices" form, where the supplier's
 * answer is typed in. Pure. What the bill, invoice and quotation forms share
 * with it is in document-form.ts.
 *
 * Unlike every other document, an RFQ line may have no price: an empty price
 * box is sent as null, not as a figure that is refused.
 */
import {
  type DocumentFormKind,
  type DocumentFormWords,
  type LineDraft,
  emptyLine,
  filledFromProduct,
  lineNumbers,
} from './document-form';
import { roundRate } from './document-lines';
import { typedNumber } from './format';
import type { FinanceProduct } from './products';
import { WRITE_FAILED } from './result';
import { RFQ_MESSAGES, type RfqDetail, quoteRfqInput, saveRfqInput } from './rfqs';

export type RfqForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  supplier_id: string;
  rfq_date: string;
  /** Empty when the RFQ names no date to reply by. */
  reply_by: string;
  notes: string;
  lines: LineDraft[];
};

/** A new RFQ dated today, with no reply-by date and one empty line. */
export function newRfqForm(today: string, lineKey: string): RfqForm {
  return { supplier_id: '', rfq_date: today, reply_by: '', notes: '', lines: [emptyLine(lineKey)] };
}

/** A saved draft, as the form shows it. A line with no price shows an empty box. */
export function rfqFormFromDetail(rfq: RfqDetail): RfqForm {
  return {
    id: rfq.id,
    supplier_id: rfq.supplier_id,
    rfq_date: rfq.rfq_date,
    reply_by: rfq.reply_by ?? '',
    notes: rfq.notes ?? '',
    lines: rfq.lines.map((line) => ({
      key: line.id,
      product_id: line.product_id ?? '',
      description: line.description,
      quantity: String(line.quantity),
      uom: line.uom ?? '',
      pack_size: line.pack_size ?? '',
      unit_price: line.unit_price === null ? '' : String(line.unit_price),
      sst_rate: String(line.sst_rate),
    })),
  };
}

/** Choosing a supplier changes nothing else: when a reply is wanted does not depend on who is asked. */
export function withRfqSupplier(form: RfqForm, supplier: { id: string }): RfqForm {
  return { ...form, supplier_id: supplier.id };
}

/** The reply-by date is the person's to set; it does not follow the RFQ date. */
export function withRfqDate(form: RfqForm, rfqDate: string): RfqForm {
  return { ...form, rfq_date: rfqDate };
}

export function withReplyBy(form: RfqForm, replyBy: string): RfqForm {
  return { ...form, reply_by: replyBy };
}

/**
 * Choosing a product fills the line from it: its name, unit and SST rate. The
 * price box stays empty: the supplier is being asked what it costs.
 */
export function withRfqProduct(line: LineDraft, product: FinanceProduct | null): LineDraft {
  return { ...filledFromProduct(line, product, 0), unit_price: product ? '' : line.unit_price };
}

/** The price a person typed: null for an empty box, NaN for text that is not a number (refused). */
function typedPrice(text: string): number | null {
  return text.trim() === '' ? null : (typedNumber(text) ?? Number.NaN);
}

/** What is sent to saveRfqAction. An empty price box is null; a typed 0 is 0. */
export function rfqPayload(form: RfqForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    supplier_id: form.supplier_id,
    rfq_date: form.rfq_date,
    reply_by: form.reply_by,
    notes: form.notes,
    lines: form.lines.map((line) => {
      const { quantity, sst_rate } = lineNumbers(line);
      return {
        product_id: line.product_id,
        description: line.description,
        uom: line.uom,
        pack_size: line.pack_size,
        quantity,
        unit_price: typedPrice(line.unit_price),
        sst_rate,
      };
    }),
  };
}

/**
 * The first thing wrong with the form, in the schema's own sentence, or null
 * when it can be sent. Sending needs no amount: an RFQ may have no prices, so
 * unlike a quotation there is no stricter check for "mark as sent".
 */
export function rfqFormError(form: RfqForm): string | null {
  const parsed = saveRfqInput.safeParse(rfqPayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? RFQ_MESSAGES.lines;
  return null;
}

/** What the form says when the RFQ was saved as a draft but marking it as sent was refused. */
export function rfqSavedNotSent(error: string): string {
  if (error === WRITE_FAILED) return 'The RFQ was saved as a draft, but marking it as sent failed. Please try again.';
  return `The RFQ was saved as a draft, but it was not marked as sent. ${error}`;
}

/** An RFQ is marked as sent, not posted: the shared card says so. */
export const RFQ_FORM_WORDS: DocumentFormWords = {
  newSubtitle: 'Saved as a draft until it is marked as sent',
  draftSubtitle: 'A draft: it gets its number when it is marked as sent',
  post: 'Save and mark as sent',
  posting: 'Marking as sent…',
};

/** The RFQ form, as the shared card draws it. Its second date is when a reply is wanted, and may be left empty. */
export const RFQ_FORM_KIND: DocumentFormKind<RfqForm> = {
  noun: 'RFQ',
  party: 'supplier',
  dateLabel: 'RFQ date',
  partyId: (form) => form.supplier_id,
  date: (form) => form.rfq_date,
  withParty: withRfqSupplier,
  withDate: withRfqDate,
  secondDate: { label: 'Reply by (optional)', optional: true, get: (form) => form.reply_by, set: withReplyBy },
  words: RFQ_FORM_WORDS,
  withProduct: withRfqProduct,
  error: rfqFormError,
  payload: rfqPayload,
  savedNotPosted: rfqSavedNotSent,
};

/* ---- recording the supplier's prices ---------------------------------- */

/** One line of the "Record prices" form: what was asked for, and the boxes for the answer. */
export type PriceDraft = {
  line_id: string;
  description: string;
  quantity: number;
  uom: string | null;
  /** The price box as typed; empty until the supplier's price is entered. */
  unit_price: string;
  sst_rate: string;
};

/** The lines of a sent RFQ, as boxes to fill in. A price already recorded shows; the rest are empty. */
export function priceDrafts(rfq: RfqDetail): PriceDraft[] {
  return rfq.lines.map((line) => ({
    line_id: line.id,
    description: line.description,
    quantity: line.quantity,
    uom: line.uom,
    unit_price: line.unit_price === null ? '' : String(line.unit_price),
    sst_rate: String(line.sst_rate),
  }));
}

/** What the SST box means: empty is no SST, as in the line editor. A box that is not a number goes as NaN and is refused. */
function typedRate(text: string): number {
  return text.trim() === '' ? 0 : roundRate(typedNumber(text) ?? Number.NaN);
}

/** What is sent to quoteRfqAction. */
export function quotePayload(rfqId: string, supplierRef: string, drafts: PriceDraft[]) {
  return {
    id: rfqId,
    supplier_ref: supplierRef,
    prices: drafts.map((d) => ({
      line_id: d.line_id,
      unit_price: typedNumber(d.unit_price) ?? Number.NaN,
      sst_rate: typedRate(d.sst_rate),
    })),
  };
}

/** The first thing wrong with the prices, or null. Every line needs one: an empty box is not 0. */
export function quoteFormError(drafts: PriceDraft[]): string | null {
  if (drafts.length === 0 || drafts.some((d) => d.unit_price.trim() === '')) return RFQ_MESSAGES.unpriced;
  const { prices } = quotePayload('', '', drafts);
  const parsed = quoteRfqInput.shape.prices.safeParse(prices);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? RFQ_MESSAGES.unpriced);
}

/**
 * What "Save prices" does with the boxes: the sentence to show, with nothing
 * to send, or the payload for quoteRfqAction. The card calls this and nothing
 * else, so an unpriced line is refused before any call is made.
 */
export function submitPrices(
  rfqId: string,
  supplierRef: string,
  drafts: PriceDraft[],
): { error: string } | { payload: ReturnType<typeof quotePayload> } {
  const error = quoteFormError(drafts);
  return error ? { error } : { payload: quotePayload(rfqId, supplierRef, drafts) };
}
