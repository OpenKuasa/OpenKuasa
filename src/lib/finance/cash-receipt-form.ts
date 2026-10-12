/**
 * The cash receipt form's rules, kept out of the component so they can be
 * tested: what a new form holds, what a draft being changed holds, which
 * invoices it may be put against and for how much, what is wrong with the
 * form, and what is sent to saveCashReceiptAction. Pure. A receipt is for one
 * customer's invoices or for an income category; the form holds both sides
 * while it is open, so switching between them loses nothing typed, and sends
 * only the side that is chosen.
 */
import { amountText, amountsError, amountsTotal, defaultAccount, keptOffered, sen, ticked, tickedAll, typedAmounts } from './allocation-form';
import type { CashReceiptKind, CashReceiptRow } from './cash-book';
import { CASH_RECEIPT_MESSAGES, type IncomeCategory, saveCashReceiptInput } from './cash-receipts';
import { typedNumber } from './format';
import { INVOICE_MESSAGES, type InvoiceListRow } from './invoices';
import type { FinanceAccount, PaymentInRow, PaymentMethod } from './money';
import { type ReceivableInvoice, invoicesOf, receiptCustomers, receivableInvoices } from './receipt-form';
import { DRAFT_NEEDS_SIGN_OFF, WRITE_FAILED } from './result';

const M = CASH_RECEIPT_MESSAGES;

/** The payer picker's value for "not one of the contacts": the name is typed, or left empty. */
export const TYPED_PAYER = 'typed';

export type CashReceiptForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  kind: CashReceiptKind;
  /** For invoices: the customer, and the ticked invoices each with the amount as typed. */
  customerId: string;
  amounts: Record<string, string>;
  /** For income: a contact's id, or `TYPED_PAYER` with the name in `payerName` (which may be empty: nobody is named). */
  payer: string;
  payerName: string;
  categoryId: string;
  /** The amount as typed. */
  amount: string;
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
};

/**
 * The invoices a receipt may be put against, and how much each can take. The
 * same rule as the payment-in form (`receivableInvoices`), with one
 * difference: a draft being changed holds its own part of each of its
 * invoices, and saving it replaces that part, so its own split is not counted
 * against it. `editingId` is that draft's transaction id.
 */
export function receivableFor(invoices: InvoiceListRow[], payments: PaymentInRow[], editingId?: string): ReceivableInvoice[] {
  return receivableInvoices(invoices, editingId ? payments.filter((p) => p.transaction_id !== editingId) : payments);
}

/**
 * The invoices the form can put a receipt against, from every invoice: posted
 * ("Sent" or "Overdue") and still owing. Only these are sent to the browser.
 * `receivableInvoices` applies the same test, so the form offers what it did
 * before; a draft's own invoices are among them while it is being changed,
 * because they are still posted and still owe.
 */
export function receiptInvoicesForForm(invoices: InvoiceListRow[]): InvoiceListRow[] {
  return invoices.filter((i) => (i.display_status === 'sent' || i.display_status === 'overdue') && i.balance > 0);
}

/**
 * The payment rows the form reads, from every payment in: the ones that hold
 * part of an invoice without being posted (what `heldBy` counts, and every
 * draft receipt's split). The rest never reach the browser.
 */
export function receiptPaymentsForForm(payments: PaymentInRow[]): PaymentInRow[] {
  return payments.filter((p) => p.status === 'draft' || p.status === 'pending_approval' || p.status === 'scheduled');
}

/**
 * A fresh form: for other income, into the first bank account, by bank transfer; the category chosen when there is only one.
 * Given the invoices that can take a receipt, the customer is chosen too when exactly one has open invoices, as on Payments In.
 */
export function newCashReceiptForm(
  accounts: FinanceAccount[],
  categories: IncomeCategory[],
  today: string,
  receivable: ReceivableInvoice[] = [],
): CashReceiptForm {
  const customers = receiptCustomers(receivable);
  return {
    kind: 'income',
    customerId: customers.length === 1 ? customers[0].id : '',
    amounts: {},
    payer: TYPED_PAYER,
    payerName: '',
    categoryId: categories.length === 1 ? categories[0].id : '',
    amount: '',
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    notes: '',
  };
}

/**
 * The form for a draft being changed, from its row on the screen and, for a
 * receipt against invoices, the rows Payments In has for it (one per invoice
 * it is split across). The side that is not the draft's starts empty.
 */
export function editCashReceiptForm(row: CashReceiptRow, payments: PaymentInRow[]): CashReceiptForm {
  const split = payments.filter((p) => p.transaction_id === row.transaction_id);
  const forInvoices = row.kind === 'invoice';
  return {
    id: row.transaction_id,
    kind: row.kind,
    customerId: forInvoices ? (row.contact_id ?? '') : '',
    amounts: forInvoices ? Object.fromEntries(split.map((p) => [p.invoice_id, amountText(p.amount)])) : {},
    payer: !forInvoices && row.contact_id ? row.contact_id : TYPED_PAYER,
    payerName: !forInvoices && !row.contact_id ? (row.party_name ?? '') : '',
    categoryId: forInvoices ? '' : (row.category_id ?? ''),
    amount: forInvoices ? '' : amountText(row.amount),
    accountId: row.account_id,
    date: row.txn_date,
    method: row.method,
    reference: row.reference ?? '',
    notes: row.notes ?? '',
  };
}

/**
 * A picker's list with the draft's own choice in it. The lists hold what is
 * active; a draft may name an account, a contact or a category that was
 * archived since it was saved, and that is still the draft's: it goes first,
 * so the picker can show it. The same list when `current` is absent or
 * already offered.
 */
export function withCurrent<T extends { id: string }>(items: T[], current?: T | null): T[] {
  if (!current || items.some((item) => item.id === current.id)) return items;
  return [current, ...items];
}

/** Choosing another customer starts the ticks again: one receipt is from one customer. */
export function chooseReceiptCustomer(form: CashReceiptForm, customerId: string): CashReceiptForm {
  return customerId === form.customerId ? form : { ...form, customerId, amounts: {} };
}

/** Ticks an invoice for all it can still take, or unticks it. */
export function toggleReceiptInvoice(form: CashReceiptForm, invoice: ReceivableInvoice, on: boolean): CashReceiptForm {
  return ticked(form, invoice, on);
}

/** Ticks every invoice of the chosen customer, or clears them all. */
export function toggleAllReceiptInvoices(form: CashReceiptForm, invoices: ReceivableInvoice[], on: boolean): CashReceiptForm {
  return tickedAll(form, invoices, on);
}

/** After a refresh, a ticked invoice that was paid off or voided meanwhile goes; see `keptOffered`. */
export function keepReceiptInvoices(form: CashReceiptForm, receivable: ReceivableInvoice[]): CashReceiptForm {
  return keptOffered(form, receivable);
}

/** What the receipt comes to: the ticked amounts for invoices, the amount box for income. Nothing while it is not a number above 0. */
export function cashReceiptTotal(form: CashReceiptForm): number {
  if (form.kind === 'invoice') return amountsTotal(form.amounts);
  const amount = typedNumber(form.amount);
  return amount !== null && amount > 0 ? sen(amount) / 100 : 0;
}

/**
 * What is sent to saveCashReceiptAction: the chosen side only. Amounts are
 * numbers; a box that is not a number goes as NaN and is refused. A payer is
 * a contact or a typed name, never both.
 */
export function cashReceiptPayload(form: CashReceiptForm) {
  const shared = {
    ...(form.id ? { id: form.id } : {}),
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reference: form.reference,
    notes: form.notes,
  };
  if (form.kind === 'invoice') {
    return {
      kind: 'invoice' as const,
      ...shared,
      allocations: typedAmounts(form.amounts).map(({ id, amount }) => ({ invoice_id: id, amount })),
    };
  }
  const typed = form.payer === TYPED_PAYER;
  return {
    kind: 'income' as const,
    ...shared,
    category_id: form.categoryId,
    amount: typedNumber(form.amount) ?? Number.NaN,
    contact_id: typed ? null : form.payer,
    party_name: typed ? form.payerName : null,
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent. What the receipt is for
 * comes first, as it is first on the form.
 */
export function cashReceiptFormError(form: CashReceiptForm, receivable: ReceivableInvoice[]): string | null {
  if (form.kind === 'invoice') {
    if (!form.customerId) return INVOICE_MESSAGES.customer;
    if (Object.keys(form.amounts).length === 0) return M.invoices;
    // An invoice that is no longer receivable was paid or voided since the form opened.
    const problem = amountsError(form.amounts, invoicesOf(receivable, form.customerId), M);
    if (problem) return problem;
  } else if (!form.categoryId) {
    return M.category;
  }
  const parsed = saveCashReceiptInput.safeParse(cashReceiptPayload(form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? M.amount);
}

/** What the form says when the receipt was saved as a draft but posting it was refused. */
export function receiptSavedNotPosted(error: string): string {
  if (error === WRITE_FAILED) return 'The receipt was saved as a draft, but posting it failed. Please try again.';
  // Already says it was saved; reached only when the person's role changed while the form was open.
  if (error === DRAFT_NEEDS_SIGN_OFF) return 'The receipt was saved as a draft. Only an owner or admin can post it.';
  return `The receipt was saved as a draft, but it was not posted. ${error}`;
}

/** Says, in one sentence, that ticked invoices were left out because they can no longer take money; null when none was. */
export function leftOutInvoicesNote(form: CashReceiptForm, receivable: ReceivableInvoice[]): string | null {
  const left = Object.keys(form.amounts).length - Object.keys(keepReceiptInvoices(form, receivable).amounts).length;
  if (left <= 0) return null;
  // "On this draft" is true only of a saved draft; a new receipt that was never saved has none.
  const ticked = form.id ? 'ticked on this draft' : 'you ticked';
  return left === 1
    ? `An invoice ${ticked} can no longer take money, so it has been left out.`
    : `${left} invoices ${ticked} can no longer take money, so they have been left out.`;
}

/**
 * After a save that was refused. A draft that someone deleted meanwhile
 * answers "no longer exists" on every try; the form then forgets the id, so
 * the next save records what was typed as a new receipt, and the sentence
 * says so. Any other refusal changes nothing.
 */
export function afterRefusedReceiptSave(form: CashReceiptForm, error: string): { form: CashReceiptForm; error: string } {
  if (error !== M.gone || !form.id) return { form, error };
  return { form: { ...form, id: undefined }, error: `${M.gone} Save again to record it as a new receipt.` };
}
