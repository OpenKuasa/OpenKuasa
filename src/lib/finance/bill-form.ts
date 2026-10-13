/**
 * The bill form's rules, kept out of the components so they can be tested:
 * what a new form holds, what choosing a supplier, a date or a product
 * changes, what is wrong with the form, and what is sent to saveBillAction.
 * Pure. What an invoice form shares is in document-form.ts.
 */
import { billTotals } from './bill-math';
import { type BillDetail, BILL_MESSAGES, saveBillInput } from './bills';
import { rm } from './format';
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
  withDueDate,
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
  /** The purchase order the bill is raised against; '' for none. */
  purchase_order_id: string;
  /** The expense category the bill's cost lands in; '' for the workspace's default. */
  category_id: string;
  lines: LineDraft[];
};

/**
 * A new bill dated today with one empty line, in the default category when the screen names one. The due date
 * follows once a supplier is chosen.
 */
export function newBillForm(today: string, lineKey: string, defaultCategoryId = ''): BillForm {
  return {
    supplier_id: '',
    supplier_ref: '',
    bill_date: today,
    due_date: today,
    dueEdited: false,
    notes: '',
    purchase_order_id: '',
    category_id: defaultCategoryId,
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
    purchase_order_id: bill.purchase_order_id ?? '',
    category_id: bill.category_id ?? '',
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
    // An order belongs to one supplier, so choosing another one leaves it behind.
    purchase_order_id: supplier.id === form.supplier_id ? form.purchase_order_id : '',
    due_date: form.dueEdited ? form.due_date : defaultDueDate(form.bill_date, supplier.payment_terms_days),
  };
}

/**
 * Choosing a category. "Default" (an empty choice) becomes the default category's own id when the screen names
 * one: an empty `category_id` is read by the database as "keep the draft's current category", so it would leave
 * the bill where it was while the form said default.
 */
export function withCategory(form: BillForm, id: string, defaultCategoryId?: string): BillForm {
  return { ...form, category_id: id || defaultCategoryId || '' };
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
    // Always sent, so that choosing none unlinks; callers that leave it out leave the link alone.
    purchase_order_id: form.purchase_order_id,
    // Empty takes the workspace's default category.
    category_id: form.category_id,
    notes: form.notes,
    lines: form.lines.map(linePayload),
  };
}

/** An order the picker can offer: what the label and the warnings need. */
export type BillOrderOption = {
  id: string;
  po_no: string | null;
  supplier_id: string;
  status: string;
  total: number;
  billed_total: number;
  received_total: number;
};

/**
 * The orders the picker offers for the chosen supplier: their approved ones, labelled with number, total and
 * billed so far, and the order this draft is already linked to even if it has since been closed, so saving
 * does not drop the link.
 */
export function ordersForSupplier(orders: BillOrderOption[], supplierId: string, currentId: string): { id: string; label: string }[] {
  if (!supplierId) return [];
  return orders
    .filter((o) => o.supplier_id === supplierId && (o.status === 'approved' || o.id === currentId))
    .map((o) => ({ id: o.id, label: `${o.po_no ?? 'Purchase order'} · ${rm(o.total)} · billed ${rm(o.billed_total)}` }));
}

/**
 * How much of the chosen order's billed figure is this very bill: its saved total, when the saved bill with
 * `billId` is linked to that order; nothing for a bill never saved or linked elsewhere. Read from the list's
 * rows rather than the draft the form opened with, because a save that leaves the form open changes them.
 */
export function ownCountedTotal(
  rows: { id: string; purchase_order_id: string | null; total: number }[],
  billId: string | undefined,
  orderId: string,
): number {
  if (!billId || !orderId) return 0;
  const saved = rows.find((b) => b.id === billId);
  return saved && saved.purchase_order_id === orderId ? saved.total : 0;
}

const cents = (n: number) => Math.round(n * 100);

/**
 * What to tell the person, in sentences, when this bill would take its order past what was ordered or past
 * what has arrived. `ownBilled` is how much of the order's `billed_total` is this bill's own saved total
 * (when a linked draft is being changed), so it is not counted twice. Advisory only: it never blocks saving.
 */
export function billOrderWarnings(lines: LineDraft[], order: BillOrderOption | null, ownBilled: number): string[] {
  if (!order) return [];
  const total = billTotals(lines.map(lineNumbers)).total;
  if (!(total > 0)) return [];
  const afterThis = cents(total) + cents(order.billed_total) - cents(ownBilled);
  const no = order.po_no ?? 'this order';
  const warnings: string[] = [];
  if (afterThis > cents(order.total)) warnings.push(`This takes the bills for ${no} over its total of ${rm(order.total)}.`);
  if (afterThis > cents(order.received_total)) warnings.push(`This is more than has been received on ${no} so far (${rm(order.received_total)}).`);
  return warnings;
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
  secondDate: { label: 'Due date', get: (form) => form.due_date, set: withDueDate },
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
