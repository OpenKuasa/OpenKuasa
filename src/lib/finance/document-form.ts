/**
 * What the bill form and the invoice form share: a line as the person typed
 * it, the due date that follows the other party's payment terms, the sentence
 * for "saved but not posted", and the description of one form
 * (`DocumentFormKind`) that the shared card draws. Pure. Every box is held as
 * the text the person typed.
 */
import { addDaysIso, type LineNumbers } from './bill-math';
import { type DocumentLineRow, isIsoDate, roundRate } from './document-lines';
import { typedNumber } from './format';
import type { FinanceProduct } from './products';
import { WRITE_FAILED } from './result';

export type LineDraft = {
  /** Stable for React while the form is open; never sent. */
  key: string;
  product_id: string;
  description: string;
  quantity: string;
  uom: string;
  /** Not shown in the editor; carried so editing a draft does not drop it. */
  pack_size: string;
  unit_price: string;
  sst_rate: string;
};

export function emptyLine(key: string): LineDraft {
  return { key, product_id: '', description: '', quantity: '1', uom: '', pack_size: '', unit_price: '', sst_rate: '0' };
}

/** A saved line, as the form shows it. */
export function lineDraft(line: DocumentLineRow): LineDraft {
  return {
    key: line.id,
    product_id: line.product_id ?? '',
    description: line.description,
    quantity: String(line.quantity),
    uom: line.uom ?? '',
    pack_size: line.pack_size ?? '',
    unit_price: String(line.unit_price),
    sst_rate: String(line.sst_rate),
  };
}

/**
 * Choosing a product fills the line from it: its name, unit, SST rate and
 * `unitPrice`, which is the product's cost on a bill and its price on an
 * invoice. The person can then change any of them. Choosing "no product"
 * only clears the link.
 */
export function filledFromProduct(line: LineDraft, product: FinanceProduct | null, unitPrice: number): LineDraft {
  if (!product) return { ...line, product_id: '' };
  return {
    ...line,
    product_id: product.id,
    description: product.name,
    uom: product.uom,
    unit_price: String(unitPrice),
    sst_rate: String(product.sst_rate),
  };
}

/** An empty SST box means no SST. The rate keeps two decimals, as it is stored. */
function sstRate(text: string): number {
  return text.trim() === '' ? 0 : roundRate(typedNumber(text) ?? Number.NaN);
}

/** The line's figures for the live total; a box that is not a number is NaN, which counts as nothing. */
export function lineNumbers(line: LineDraft): LineNumbers {
  return {
    quantity: typedNumber(line.quantity) ?? Number.NaN,
    unit_price: typedNumber(line.unit_price) ?? Number.NaN,
    sst_rate: sstRate(line.sst_rate),
  };
}

/** One line as it is sent. Figures are numbers; a box that is not a number goes as NaN and is refused. */
export function linePayload(line: LineDraft) {
  return {
    product_id: line.product_id,
    description: line.description,
    uom: line.uom,
    pack_size: line.pack_size,
    ...lineNumbers(line),
  };
}

/** The document's date plus the other party's payment terms; with no party yet, the date itself. */
export function defaultDueDate(date: string, termsDays: number | undefined): string {
  return addDaysIso(date, termsDays ?? 0);
}

/**
 * The due date after the document's date or its party changed: it follows,
 * unless it was set by hand. While the date is half typed it stays where it
 * was.
 */
export function followedDueDate(
  form: { due_date: string; dueEdited: boolean },
  date: string,
  termsDays: number | undefined,
): string {
  return !form.dueEdited && isIsoDate(date) ? defaultDueDate(date, termsDays) : form.due_date;
}

/** Once the person sets the due date by hand, it is no longer recalculated. */
export function withDueDate<F extends { due_date: string; dueEdited: boolean }>(form: F, dueDate: string): F {
  return { ...form, due_date: dueDate, dueEdited: true };
}

/** What a form says when its document was saved as a draft but posting it was refused. */
export function savedAsDraft(noun: 'bill' | 'invoice', error: string): string {
  if (error === WRITE_FAILED) return `The ${noun} was saved as a draft, but posting it failed. Please try again.`;
  return `The ${noun} was saved as a draft, but it was not posted. ${error}`;
}

/**
 * What every document form holds, whatever it calls its party and its dates.
 * The second date (a due date, or a quotation's valid-until date) is not
 * named here: the card reads and sets it through the kind's `secondDate`.
 */
export type DocumentFormState = {
  /** Present when a saved draft is being changed. */
  id?: string;
  notes: string;
  lines: LineDraft[];
};

/** The words of the card that differ between a document that is posted and one that is marked as sent. */
export type DocumentFormWords = {
  /** Under the title of a new document. */
  newSubtitle: string;
  /** Under the title of a draft being changed. */
  draftSubtitle: string;
  /** The second button: save the draft and take the next step in one go. */
  post: string;
  /** That button while it is working. */
  posting: string;
};

/** What the card says for a bill or an invoice. */
export const POSTING_WORDS: DocumentFormWords = {
  newSubtitle: 'Saved as a draft until it is posted',
  draftSubtitle: 'A draft: it gets its number when it is posted',
  post: 'Save and post',
  posting: 'Posting…',
};

/** A kind's own words, or the posting words when it has none. */
export function documentFormWords(kind: { words?: DocumentFormWords }): DocumentFormWords {
  return kind.words ?? POSTING_WORDS;
}

/** The customer or supplier a document is for, as its picker lists it. */
export type DocumentParty = { id: string; name: string; payment_terms_days: number };

/**
 * The parties a form's picker offers. `parties` are the active ones; a draft
 * being changed may be for one that was archived since it was saved, and that
 * party (`current`) is still the draft's: it goes first, so the picker can
 * show it. Its payment terms are not known here and count as none, which only
 * matters if the person changes the date and has not set the second date by
 * hand. The same list when `current` is absent or already offered.
 */
export function withCurrentParty(parties: DocumentParty[], current?: { id: string; name: string }): DocumentParty[] {
  if (!current || parties.some((p) => p.id === current.id)) return parties;
  return [{ id: current.id, name: current.name, payment_terms_days: 0 }, ...parties];
}

/**
 * One kind of document form, for the shared card: its words, and its rules as
 * the functions of its own module (`bill-form.ts`, `invoice-form.ts`,
 * `quotation-form.ts`), which are what the tests pin.
 */
export type DocumentFormKind<F extends DocumentFormState> = {
  noun: 'bill' | 'invoice' | 'quotation' | 'RFQ' | 'purchase order';
  party: 'supplier' | 'customer';
  dateLabel: string;
  partyId: (form: F) => string;
  date: (form: F) => string;
  withParty: (form: F, party: { id: string; payment_terms_days: number }) => F;
  withDate: (form: F, date: string, termsDays: number | undefined) => F;
  /**
   * The second date box: when a bill or an invoice is due, or until when a quotation is valid. `optional`
   * lets it be empty (an RFQ's reply-by date); absent, the box is required.
   */
  secondDate: { label: string; optional?: boolean; get: (form: F) => string; set: (form: F, value: string) => F };
  /** Present when the document is not posted but marked as sent. Absent, the card uses `POSTING_WORDS`. */
  words?: DocumentFormWords;
  /**
   * More boxes drawn after the dates, each a line of text held in the form: a purchase order's payment terms
   * and delivery address. Absent for a bill, an invoice, a quotation and an RFQ.
   */
  extras?: {
    label: string;
    placeholder?: string;
    inputMode?: 'numeric' | 'text';
    /** A short line under the box, read with it. */
    hint?: string;
    get: (form: F) => string;
    set: (form: F, value: string) => F;
  }[];
  /** A second text box beside the party: the supplier's own reference on a bill. An invoice has none. */
  reference?: { label: string; placeholder: string; get: (form: F) => string; set: (form: F, value: string) => F };
  /** What an empty price box says. Absent, `0.00`; an RFQ's says the supplier fills it in. */
  pricePlaceholder?: string;
  withProduct: (line: LineDraft, product: FinanceProduct | null) => LineDraft;
  /** The first thing wrong with the form, or null. `posting` also refuses a total of nothing. */
  error: (form: F, posting?: boolean) => string | null;
  /** What is sent to the save action. */
  payload: (form: F) => unknown;
  savedNotPosted: (error: string) => string;
  /**
   * What the form holds once a save was refused with this sentence. Absent, a refusal changes nothing; an
   * RFQ copied from one that is gone lets go of that link, so the next save can succeed.
   */
  afterRefusal?: (form: F, error: string) => F;
};
