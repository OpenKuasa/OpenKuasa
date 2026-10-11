/**
 * The bill form's rules, kept out of the components so they can be tested:
 * what a new form holds, what choosing a supplier, a date or a product
 * changes, what is wrong with the form, and what is sent to saveBillAction.
 * Pure. What an invoice form shares is in document-form.ts.
 */
import { billTotals } from './bill-math';
import { type BillDetail, BILL_MESSAGES, saveBillInput } from './bills';
import {
  type DocumentFormKind,
  type LineDraft,
  defaultDueDate,
  emptyLine,
  filledFromProduct,
  followedDueDate,
  lineDraft,
  lineNumbers,
  linePayload,
  savedAsDraft,
} from './document-form';
import type { FinanceProduct } from './products';

// Defined in document-form.ts, which the invoice form shares; kept exported from here because the purchase-side tests import them from this module.
export { type LineDraft, defaultDueDate, emptyLine, lineNumbers, withDueDate } from './document-form';

export type BillForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  supplier_id: string;
  supplier_ref: string;
  bill_date: string;
  due_date: string;
  /** Once the person sets the due date by hand, it is no longer recalculated. */
  dueEdited: boolean;
  notes: string;
  lines: LineDraft[];
};

/** A new bill dated today with one empty line. The due date follows once a supplier is chosen. */
export function newBillForm(today: string, lineKey: string): BillForm {
  return {
    supplier_id: '',
    supplier_ref: '',
    bill_date: today,
    due_date: today,
    dueEdited: false,
    notes: '',
    lines: [emptyLine(lineKey)],
  };
}

/** A saved draft, as the form shows it. Its due date was chosen already, so it is kept. */
export function billFormFromDetail(bill: BillDetail): BillForm {
  return {
    id: bill.id,
    supplier_id: bill.supplier_id,
    supplier_ref: bill.supplier_ref ?? '',
    bill_date: bill.bill_date,
    due_date: bill.due_date,
    dueEdited: true,
    notes: bill.notes ?? '',
    lines: bill.lines.map(lineDraft),
  };
}

/**
 * Choosing a supplier moves the due date to their terms, unless it was set by hand.
 * The due-date rule is deliberately its own: it blanks the due date when the bill
 * date is empty, which the invoice form's `withCustomer` does not do. Do not
 * "tidy" it onto `followedDueDate`.
 */
export function withSupplier(form: BillForm, supplier: { id: string; payment_terms_days: number }): BillForm {
  return {
    ...form,
    supplier_id: supplier.id,
    due_date: form.dueEdited ? form.due_date : defaultDueDate(form.bill_date, supplier.payment_terms_days),
  };
}

/**
 * Changing the bill date moves the due date with it, unless it was set by
 * hand. While the bill date is half typed the due date stays where it was.
 */
export function withBillDate(form: BillForm, billDate: string, termsDays: number | undefined): BillForm {
  return { ...form, bill_date: billDate, due_date: followedDueDate(form, billDate, termsDays) };
}

/**
 * Choosing a product fills the line from it: its name, unit, cost (what the
 * workspace pays for it) and SST rate. The person can then change any of
 * them. Choosing "no product" only clears the link.
 */
export function withProduct(line: LineDraft, product: FinanceProduct | null): LineDraft {
  return filledFromProduct(line, product, product?.cost ?? 0);
}

/** What is sent to saveBillAction. Figures are numbers; a box that is not a number goes as NaN and is refused. */
export function billPayload(form: BillForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    supplier_id: form.supplier_id,
    supplier_ref: form.supplier_ref,
    bill_date: form.bill_date,
    due_date: form.due_date,
    notes: form.notes,
    lines: form.lines.map(linePayload),
  };
}

/**
 * The first thing wrong with the form, in the schema's own sentence, or null
 * when it can be sent. A draft may total nothing; a bill being posted may not,
 * and saying so here saves a draft the database would then refuse to post.
 */
export function billFormError(form: BillForm, posting = false): string | null {
  const parsed = saveBillInput.safeParse(billPayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? BILL_MESSAGES.lines;
  if (posting && billTotals(form.lines.map(lineNumbers)).total <= 0) return BILL_MESSAGES.empty;
  return null;
}

/** What the form says when the bill was saved as a draft but posting it was refused. */
export function savedNotPosted(error: string): string {
  return savedAsDraft('bill', error);
}

/** The bill form, as the shared card draws it. */
export const BILL_FORM_KIND: DocumentFormKind<BillForm> = {
  noun: 'bill',
  party: 'supplier',
  dateLabel: 'Bill date',
  partyId: (form) => form.supplier_id,
  date: (form) => form.bill_date,
  withParty: withSupplier,
  withDate: withBillDate,
  reference: {
    label: 'Supplier’s reference',
    placeholder: 'Their invoice no.',
    get: (form) => form.supplier_ref,
    set: (form, value) => ({ ...form, supplier_ref: value }),
  },
  withProduct,
  error: billFormError,
  payload: billPayload,
  savedNotPosted,
};
