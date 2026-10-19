/**
 * The bill form's rules, kept out of the components so they can be tested:
 * what a new form holds, what choosing a supplier, a date or a product
 * changes, what is wrong with the form, and what is sent to saveBillAction.
 * Pure. What an invoice form shares is in document-form.ts.
 */
import { billTotals } from './bill-math';
import { type BillDetail, BILL_MESSAGES, saveBillInput } from './bills';
import { BASE_CURRENCY } from './currencies';
import {
  CURRENCY_MESSAGES,
  type CurrencyFields,
  currencyError,
  currencyPayloadWithSource,
  ringgitFields,
  savedFields,
  sourceError,
  withCurrency,
  withPartyCurrency,
} from './document-currency';
import { money } from './format';
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
  /**
   * The currency, the rate and, for a typed rate, its source. Ringgit for a new form until the person or the
   * supplier's default says otherwise; a bill with a purchase order is in the order's currency.
   */
  fx: CurrencyFields;
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
    fx: ringgitFields(),
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
    fx: savedFields(bill),
  };
}

/**
 * Choosing a supplier moves the due date to their terms, unless it was set by hand, and on a new bill whose
 * currency the person has not picked and that has no purchase order, the currency to the supplier's default.
 * The due-date rule is deliberately its own: it blanks the due date when the bill
 * date is empty, which the invoice form's `withCustomer` does not do. Do not
 * "tidy" it onto `followedDueDate`.
 */
export function withSupplier(
  form: BillForm,
  supplier: { id: string; payment_terms_days: number; default_currency?: string | null },
): BillForm {
  // An order belongs to one supplier, so choosing another one leaves it behind.
  const purchase_order_id = supplier.id === form.supplier_id ? form.purchase_order_id : '';
  return {
    ...form,
    supplier_id: supplier.id,
    purchase_order_id,
    due_date: form.dueEdited ? form.due_date : defaultDueDate(form.bill_date, supplier.payment_terms_days),
    fx: purchase_order_id ? form.fx : withPartyCurrency(form.fx, supplier.default_currency, !form.id),
  };
}

/**
 * Choosing the purchase order the bill is raised against. A bill against an order is in the order's currency
 * (the database says so too: FIN49), so choosing one puts the bill in it (stage 4p: orders carry a currency;
 * the rate is then asked of Bank Negara for the bill date, as for any change of currency). Choosing none leaves
 * the currency where it is, free to change again.
 */
export function withPurchaseOrder(form: BillForm, id: string, orderCurrency: string = BASE_CURRENCY): BillForm {
  if (!id) return { ...form, purchase_order_id: '' };
  return { ...form, purchase_order_id: id, fx: withCurrency(form.fx, orderCurrency, true) };
}

/** Said beside a currency picker that cannot change: a bill with a purchase order is in the order's currency. */
export function billCurrencyLock(form: Pick<BillForm, 'purchase_order_id'>): string | null {
  return form.purchase_order_id ? 'In the order’s currency.' : null;
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

/**
 * What is sent to saveBillAction. Figures are numbers; a box that is not a number goes as NaN and is refused.
 * The currency part always goes (a ringgit bill as MYR), with a typed rate's source.
 */
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
    ...currencyPayloadWithSource(form.fx),
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
  /** The order's currency: its figures are in it, and so is every bill raised against it (FIN49). */
  currency: string;
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
    .map((o) => ({
      id: o.id,
      label: `${o.po_no ?? 'Purchase order'} · ${money(o.total, o.currency)} · billed ${money(o.billed_total, o.currency)}`,
    }));
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
  // The bill is in the order's currency (FIN49), so its total and the order's figures are in the same units.
  const m = (n: number) => money(n, order.currency);
  if (afterThis > cents(order.total)) warnings.push(`This takes the bills for ${no} over its total of ${m(order.total)}.`);
  if (afterThis > cents(order.received_total)) warnings.push(`This is more than has been received on ${no} so far (${m(order.received_total)}).`);
  return warnings;
}

/**
 * The first thing wrong with the form, in the schema's own sentence, or null
 * when it can be sent. A draft may total nothing; a bill being posted may not,
 * and saying so here saves a draft the database would then refuse to post.
 */
export function billFormError(form: BillForm, posting = false): string | null {
  // The rate box first: a rate that is not a number goes as NaN and would read as the schema's word for it.
  const rate = currencyError(form.fx, posting, CURRENCY_MESSAGES.rateBeforePosting) ?? sourceError(form.fx);
  if (rate) return rate;
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
  // One rate per bill, the rule's: Bank Negara's 5 pm selling rate for the bill date, or one typed with its source.
  currency: {
    get: (form) => form.fx,
    set: (form, fx) => ({ ...form, fx }),
    figure: 'selling',
    sources: true,
    locked: billCurrencyLock,
  },
  withProduct,
  error: billFormError,
  payload: billPayload,
  savedNotPosted,
};

/**
 * The bill form with no currency: a bill made from a receipt, whose amount is ringgit. No picker is drawn, and
 * choosing a supplier leaves the form in ringgit whatever their default currency.
 */
export const BILL_FORM_KIND_RINGGIT: DocumentFormKind<BillForm> = {
  ...BILL_FORM_KIND,
  currency: undefined,
  withParty: (form, supplier) => ({ ...withSupplier(form, supplier), fx: form.fx }),
};
