/**
 * The rules of the Payment Vouchers screen that are not the database's, kept
 * out of the components so they can be tested: what a new voucher form
 * holds (for an expense category or for a supplier's bills, new or a draft
 * being edited), what is wrong with it and what is sent to
 * recordVoucherAction or saveVoucherAction; what a row's menu offers each
 * person; what a decision sends of the row it was
 * asked on; the words of the questions; the over-billing notes for the
 * vouchers that pay supplier bills; and what the screen says about a voucher
 * that was just written and is not in the list. Pure.
 *
 * Stage 5b: a new voucher for a category may be paid from an account in another currency, in that currency, with
 * the movement's rate, recorded paid by an owner or admin (a member is told first: FIN47). Vouchers for bills and
 * drafts list ringgit accounts (FIN50 on a draft there).
 */
import type { OrgRole } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import { amountText, amountsError, amountsTotal, defaultAccount, keptOffered, typedAmounts } from './allocation-form';
import type { BillListRow } from './bills';
import { type PaymentVoucherRow, cashBookCurrency } from './cash-book';
import { BASE_CURRENCY } from './currencies';
import { type CashBookPeriod, type PaymentVoucherFilter, inPeriod, voucherHome } from './cash-book-views';
import { type CurrencyFields, ringgitFields } from './document-currency';
import type { ExpenseCategory } from './expenses';
import { money, rm, typedNumber } from './format';
import { PAYMENT_METHOD_LABELS, type FinanceAccount, type PaymentMethod, type PaymentOutRow } from './money';
import {
  fxForAccount,
  movementRateError,
  movementRatePayload,
  movementRinggitNote,
  onForeignAccount,
} from './movement-rate';
import { type PayableBill, billsOf, payableBills } from './payment-form';
import { type OrderBilling, orderNotesForBills } from './purchase-views';
import { displayDate } from './view-helpers';
import { VOUCHER_MESSAGES, recordVoucherInput, saveVoucherInput } from './vouchers';

const M = VOUCHER_MESSAGES;

/** The payee picker's value for "not one of the contacts": the name is typed. */
export const TYPED_PAYEE = 'typed';

/** What a voucher made on this screen is for: an expense category, or one supplier's bills. */
export type VoucherFormKind = 'category' | 'bills';

export type VoucherForm = {
  /** The draft being changed; null for a new voucher. */
  id: string | null;
  kind: VoucherFormKind;
  /** For bills: the supplier, and the ticked bills, each with the amount as typed. */
  supplierId: string;
  amounts: Record<string, string>;
  /** A contact's id, or `TYPED_PAYEE` with the name in `payeeName`. */
  payee: string;
  payeeName: string;
  categoryId: string;
  /** The amount as typed. */
  amount: string;
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
  /** "Paid now" on a new voucher for a category: recorded as paid on `date`. Only an owner or admin is offered it; absent means "To be paid". */
  paidNow?: boolean;
  /** The chosen account's currency and the movement's rate (stage 5b). Absent, or ringgit: a ringgit account. */
  fx?: CurrencyFields;
};

/** A fresh form: from the first bank account, by bank transfer, dated today (the person's own date); the category chosen when there is only one. */
export function newVoucherForm(accounts: FinanceAccount[], categories: ExpenseCategory[], today: string): VoucherForm {
  return {
    fx: ringgitFields(),
    id: null,
    kind: 'category',
    supplierId: '',
    amounts: {},
    payee: TYPED_PAYEE,
    payeeName: '',
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
 * The bills a voucher can be saved against. A bill can take what is owed on
 * it less what payments, drafts and waiting vouchers already hold; the draft
 * being edited (`draftId`) holds its own part, which it may take again.
 * Bills in ringgit only, through all of stage 4: a bill in another currency is
 * paid on Payments Out on the day the money leaves, never through a voucher
 * that waits for approval (FIN41 in stage 4a, FIN47 after).
 */
export function voucherPayableBills(bills: BillListRow[], payments: PaymentOutRow[], draftId: string | null): PayableBill[] {
  return payableBills(
    bills.filter((b) => b.currency === BASE_CURRENCY),
    draftId ? payments.filter((p) => p.transaction_id !== draftId) : payments,
  );
}

/**
 * The expense categories the form's box offers: the active ones, and, for a
 * draft being edited whose category was archived since, that category too,
 * first and marked "(archived)", so the box shows what the draft is filed
 * under and it can be kept or changed. A new voucher is offered the active
 * ones only. The same list when the draft has no category or it is offered.
 */
export function voucherCategoryChoices(
  categories: ExpenseCategory[],
  draft: Pick<PaymentVoucherRow, 'category_id' | 'category_name'> | null,
): ExpenseCategory[] {
  if (!draft?.category_id || categories.some((c) => c.id === draft.category_id)) return categories;
  return [{ id: draft.category_id, name: draft.category_name ? `${draft.category_name} (archived)` : 'Archived category' }, ...categories];
}

/**
 * The form for a draft being edited, from its row and, for one that pays
 * bills, the Payments Out rows that name its bills. An account that has been
 * archived since is not among `accounts` and is left unchosen, so the form
 * asks for another. A draft made elsewhere without a category opens with
 * none chosen.
 */
export function draftVoucherForm(
  row: PaymentVoucherRow,
  payments: Pick<PaymentOutRow, 'transaction_id' | 'bill_id' | 'amount'>[],
  bills: Pick<BillListRow, 'id' | 'supplier_id'>[],
  accounts: FinanceAccount[],
): VoucherForm {
  const split = payments.filter((p) => p.transaction_id === row.transaction_id);
  const isBills = row.kind === 'bill';
  return {
    id: row.transaction_id,
    kind: isBills ? 'bills' : 'category',
    supplierId: isBills ? (bills.find((b) => b.id === split[0]?.bill_id)?.supplier_id ?? row.contact_id ?? '') : '',
    amounts: isBills ? Object.fromEntries(split.map((p) => [p.bill_id, amountText(p.amount)])) : {},
    payee: isBills ? TYPED_PAYEE : (row.contact_id ?? TYPED_PAYEE),
    payeeName: isBills || row.contact_id ? '' : (row.party_name ?? ''),
    categoryId: row.category_id ?? '',
    amount: isBills ? '' : amountText(row.amount),
    accountId: accounts.some((a) => a.id === row.account_id) ? row.account_id : '',
    date: row.txn_date,
    method: row.method,
    reference: row.reference ?? '',
    notes: row.notes ?? '',
  };
}

/** The line under a bill on the form: what a voucher may take of it, and why that may be less than its balance. */
export function voucherBillOwed(bill: PayableBill): string {
  const held = bill.scheduled > 0 ? ` · ${rm(bill.scheduled)} of ${rm(bill.balance)} held by payments and vouchers not yet paid` : '';
  return `${rm(bill.payable)} to pay${held}`;
}

/** True when the voucher is paid from an account in another currency (stage 5b). */
export function voucherOnForeignAccount(form: Pick<VoucherForm, 'fx'>): boolean {
  return onForeignAccount(form.fx);
}

/**
 * The accounts the form offers (stage 5b): every account for a new voucher for a category (one in another currency
 * is paid now, by an owner or admin); ringgit accounts for a voucher for bills and for a draft (FIN50 there), with
 * the account already chosen.
 */
export function voucherAccounts(form: Pick<VoucherForm, 'kind' | 'id' | 'accountId'>, accounts: FinanceAccount[]): FinanceAccount[] {
  if (form.kind === 'category' && form.id === null) return accounts;
  return accounts.filter((a) => a.currency === BASE_CURRENCY || a.id === form.accountId);
}

/**
 * The account chosen. One in another currency takes the rate box in its currency, and is paid now. Going back to a
 * ringgit account from one lets go of the "Paid now" that account set: the voucher is To be paid again.
 */
export function chooseVoucherAccount(form: VoucherForm, account: FinanceAccount): VoucherForm {
  const fx = fxForAccount(form.fx, account.currency);
  if (onForeignAccount(fx)) return { ...form, accountId: account.id, fx, paidNow: true };
  return { ...form, accountId: account.id, fx, ...(voucherOnForeignAccount(form) ? { paidNow: undefined } : {}) };
}

/** The rate part, as typed or as BNM's answer left it. */
export function withVoucherFx(form: VoucherForm, fx: CurrencyFields): VoucherForm {
  return { ...form, fx };
}

/** Under the rate box: the voucher in ringgit at the rate, as "about". */
export function voucherRateNotes(form: VoucherForm): string[] {
  const note = voucherOnForeignAccount(form) ? movementRinggitNote(form.amount, form.fx) : null;
  return note === null ? [] : [note];
}

/**
 * Choosing the other kind keeps the account, date, method, reference and notes. A voucher for bills is paid from a
 * ringgit account (stage 5b): an account in another currency is let go, and one is chosen again.
 */
export function chooseVoucherKind(form: VoucherForm, kind: VoucherFormKind): VoucherForm {
  if (kind === form.kind) return form;
  if (kind === 'bills' && voucherOnForeignAccount(form)) {
    return { ...form, kind, accountId: '', fx: ringgitFields(), paidNow: undefined };
  }
  return { ...form, kind };
}

/** Choosing another supplier starts the ticks again: one voucher pays one supplier. */
export function chooseVoucherSupplier(form: VoucherForm, supplierId: string): VoucherForm {
  return supplierId === form.supplierId ? form : { ...form, supplierId, amounts: {} };
}

/** After a refresh, a ticked bill that can no longer take a payment is dropped, with its amount. */
export function keepVoucherBills(form: VoucherForm, payable: PayableBill[]): VoucherForm {
  return form.kind === 'bills' ? keptOffered(form, billsOf(payable, form.supplierId)) : form;
}

/** What the voucher comes to: the ticked amounts for bills, the amount box for a category (0 until it is a number). */
export function voucherTotal(form: VoucherForm): number {
  return form.kind === 'bills' ? amountsTotal(form.amounts) : Math.max(typedNumber(form.amount) ?? 0, 0);
}

/**
 * Which write the form's first button makes. A new voucher for a category is
 * recorded in one step (`record`: approved at once for an owner or admin,
 * waiting for anyone else). A voucher for bills, and any draft being edited,
 * is saved and sent for approval in one call (`send`), whoever sends it.
 */
export function voucherFirstWrite(form: Pick<VoucherForm, 'kind' | 'id'>): 'record' | 'send' {
  return form.kind === 'category' && form.id === null ? 'record' : 'send';
}

/**
 * Whether the first button records the voucher as paid: "Paid now" was
 * chosen, on a new voucher for a category, by someone who may sign off. A
 * draft and a voucher for bills are never paid from the form.
 */
export function voucherPaysNow(canDecide: boolean, form: Pick<VoucherForm, 'kind' | 'id' | 'paidNow'> & { fx?: CurrencyFields }): boolean {
  // Stage 5b: a voucher from an account in another currency is always paid now.
  const now = form.paidNow === true || voucherOnForeignAccount(form);
  return canDecide && now && voucherFirstWrite(form) === 'record';
}

/**
 * What is sent to saveVoucherAction: the voucher as a draft, or, with `send`,
 * saved and sent for approval. Every field is sent every time, so a field
 * that was emptied is stored empty. An amount box that is not a number goes
 * as NaN and is refused.
 */
export function voucherSavePayload(form: VoucherForm, send: boolean) {
  const shared = {
    ...(form.id ? { id: form.id } : {}),
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reference: form.reference,
    notes: form.notes,
    send,
  };
  if (form.kind === 'bills') {
    return { kind: 'bills' as const, ...shared, allocations: typedAmounts(form.amounts).map(({ id, amount }) => ({ bill_id: id, amount })) };
  }
  const { category_id, amount, contact_id, party_name } = voucherPayload(form);
  return { kind: 'category' as const, ...shared, category_id, amount, contact_id, party_name };
}

/**
 * What is sent to recordVoucherAction. The amount is a number: a box that is
 * not a number (a number input drops a typed comma, so "1,200.50" arrives
 * empty) goes as NaN and is refused. Whoever is paid is a contact or a typed
 * name, never both. No status is sent: the database decides it. `paid_now`
 * is sent only when the voucher is to be recorded as paid (`voucherPaysNow`).
 */
export function voucherPayload(form: VoucherForm, paidNow = false) {
  const typed = form.payee === TYPED_PAYEE;
  return {
    ...(paidNow ? { paid_now: true } : {}),
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    category_id: form.categoryId,
    amount: typedNumber(form.amount) ?? Number.NaN,
    contact_id: typed ? null : form.payee,
    party_name: typed ? form.payeeName : null,
    reference: form.reference,
    notes: form.notes,
    // Stage 5b: from an account in another currency, the movement's rate.
    ...movementRatePayload(form.fx),
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema would use,
 * or null when it can be sent. In the order of the form: who is paid, the
 * category, the amount, then whatever the schema finds (the account, the
 * date, a text that is too long).
 */
export function voucherFormError(form: VoucherForm, payable: PayableBill[] = [], canDecide = true): string | null {
  if (form.kind === 'bills') {
    if (!form.supplierId) return M.supplier;
    if (Object.keys(form.amounts).length === 0) return M.bills;
    // A ticked bill that is no longer offered was paid, voided or taken up by another payment since the form opened.
    const problem = amountsError(form.amounts, billsOf(payable, form.supplierId), M);
    if (problem) return problem;
    if (!form.accountId) return M.account;
    const saved = saveVoucherInput.safeParse(voucherSavePayload(form, false));
    return saved.success ? null : (saved.error.issues[0]?.message ?? M.invalid);
  }
  if (form.payee === TYPED_PAYEE && form.payeeName.trim() === '') return M.payeeMissing;
  if (!form.categoryId) return M.category;
  if (/[,$]|^\s*(rm|myr)/i.test(form.amount)) return M.amountFormat;
  if (/\.\d{3,}\s*$/.test(form.amount)) return M.amountDecimals;
  if (!form.accountId) return M.account;
  // Stage 5b: from an account in another currency, recorded paid by an owner or admin (FIN47), with its rate.
  if (voucherOnForeignAccount(form)) {
    if (!canDecide) return M.payNowAccount;
    const rate = movementRateError(form.fx);
    if (rate) return rate;
  }
  const parsed = recordVoucherInput.safeParse(voucherPayload(form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? M.invalid);
}

export const BILLS_HINT =
  'Sending this for approval is a choice: it waits as Pending approval until an owner or admin approves or rejects it, and once approved it is To be paid on Payments Out. To schedule a supplier payment without approval, record it on Payments Out instead.';
export const DRAFT_HINT =
  'A draft is yours to change until it is sent for approval. After that it cannot be changed, only approved, rejected or deleted.';
export const FOREIGN_ACCOUNT_HINT =
  'A voucher from an account in another currency is recorded as paid, on the date above, in that currency at the rate below. It gets its payment voucher number and moves the books in ringgit, and from then on it can only be voided.';
export const PAID_NOW_HINT =
  'A voucher you save as paid is approved and paid at once, on the date above: you are an owner or admin. It gets its payment voucher number and moves the books, and from then on it cannot be changed or deleted, only voided. A draft is not paid.';

/**
 * What the form says under its fields, before anything is written: what its
 * buttons will do for this person. For bills, and for a draft being edited,
 * the first button sends for approval whoever presses it; for a new category
 * voucher it does what recording does for this person.
 */
export function voucherSaveHint(
  canDecide: boolean,
  form?: Pick<VoucherForm, 'kind' | 'id' | 'paidNow'> & { fx?: CurrencyFields },
): string[] {
  // Stage 5b: an account in another currency is paid now, by an owner or admin; a member is told before sending.
  if (form && voucherOnForeignAccount(form)) return canDecide ? [FOREIGN_ACCOUNT_HINT] : [M.payNowAccount];
  if (form?.kind === 'bills') return [BILLS_HINT, DRAFT_HINT];
  if (form?.id) return [DRAFT_HINT];
  if (form && voucherPaysNow(canDecide, form)) return [PAID_NOW_HINT, DRAFT_HINT];
  return [
    canDecide
      ? 'A voucher you save is approved at once and reads To be paid: you are an owner or admin. Nothing is paid until it is marked paid.'
      : 'This voucher waits as Pending approval until an owner or admin approves or rejects it. Until then it cannot be changed, only deleted.',
    DRAFT_HINT,
  ];
}

/** The form's first button, by what it does for this person: only a new category voucher is approved, or paid, by an owner's or admin's save. */
export function voucherSubmitLabel(
  canDecide: boolean,
  form?: Pick<VoucherForm, 'kind' | 'id' | 'paidNow'> & { fx?: CurrencyFields },
): string {
  if (form && voucherPaysNow(canDecide, form)) return 'Save as paid';
  return canDecide && (!form || voucherFirstWrite(form) === 'record') ? 'Save voucher' : 'Send for approval';
}

/** The date field's label: the day it was paid when it is recorded as paid, the day it is planned for otherwise. */
export function voucherDateLabel(paysNow: boolean): string {
  return paysNow ? 'Date paid' : 'Date to pay';
}

/** The form's second button: a new voucher is saved as a draft, a draft being edited is saved. */
export function voucherDraftLabel(form: Pick<VoucherForm, 'id'>): string {
  return form.id ? 'Save draft' : 'Save as draft';
}

/* ---- the row ---------------------------------------------------------- */

export type VoucherAction = 'edit' | 'submit' | 'approve' | 'reject' | 'markPaid' | 'delete' | 'void';

/** Before "To be paid": the statuses Payments Out and Refunds offer nothing on, so a voucher in one of them is changed here whatever it pays. */
const BEFORE_TO_BE_PAID: ReadonlySet<PaymentVoucherRow['status']> = new Set(['draft', 'pending_approval', 'rejected']);

/**
 * What a voucher's row menu offers, by its status, its kind and whether the
 * person may decide (an owner or admin). The database's rules, so nothing is
 * offered that it would refuse, and nothing that another screen also offers:
 *  - a draft that pays bills or carries a category: anyone who may write edits
 *    it or sends it for approval, whoever saved it. A draft that pays
 *    expenses or refunds a customer is made by no screen and is only deleted;
 *  - waiting for approval, whatever it pays: an owner or admin approves or
 *    rejects it. No other screen has those two;
 *  - a draft, waiting or rejected, whatever it pays: anyone who may write
 *    deletes it, whoever recorded it. Payments Out and Refunds offer nothing
 *    on a payment before it is "To be paid", so without this a rejected
 *    payment to a supplier could never be removed;
 *  - "To be paid", of a kind that belongs here (for a category, or paying
 *    expenses): an owner or admin marks it paid, and anyone who may write
 *    deletes it. A payment to a supplier and a refund are then marked paid or
 *    deleted on their own screens (`voucherHome`), so their rows offer
 *    nothing here;
 *  - paid, of a kind that belongs here: an owner or admin voids it. A paid
 *    payment to a supplier or refund is voided on its own screen;
 *  - void: nothing. It is final.
 */
export function voucherActions(row: PaymentVoucherRow, canDecide: boolean): VoucherAction[] {
  const actions: VoucherAction[] = [];
  const ours = voucherHome(row.kind) === null;
  if (row.status === 'draft' && (row.kind === 'bill' || row.kind === 'other')) actions.push('edit', 'submit');
  if (row.status === 'pending_approval' && canDecide) actions.push('approve', 'reject');
  if (row.status === 'scheduled' && ours && canDecide) actions.push('markPaid');
  if (BEFORE_TO_BE_PAID.has(row.status) || (row.status === 'scheduled' && ours)) actions.push('delete');
  if (row.status === 'posted' && ours && canDecide) actions.push('void');
  return actions;
}

/** What the Payment Vouchers screen draws for someone who may write and for someone who may not. */
export function voucherControls(canWrite: boolean) {
  return { newButton: canWrite, actionsColumn: canWrite, columns: canWrite ? 9 : 8 };
}

/**
 * What an approval or a rejection sends of the row it was asked on: the row
 * as shown, so the database decides that very voucher. The row's
 * `party_name` is the contact's name when a contact is named; the table
 * holds no typed name then, so none is sent.
 */
export function voucherDecisionPayload(row: PaymentVoucherRow) {
  return {
    id: row.transaction_id,
    amount: row.amount,
    txn_date: row.txn_date,
    method: row.method,
    account_id: row.account_id,
    contact_id: row.contact_id,
    party_name: row.contact_id ? null : row.party_name,
    category_id: row.category_id,
    reference: row.reference,
    notes: row.notes,
  };
}

/** True for the answers that mean the voucher is no longer as the row showed it: the question is closed and the row refreshed. */
export function voucherAnswerIsStale(error: string): boolean {
  return (
    [
      M.changed, M.alreadyApproved, M.alreadyRejected, M.movedOn, M.gone, M.draftChanged, M.notDraftSend,
      M.alreadyPaid, M.alreadyVoided,
    ] as string[]
  ).includes(error);
}

/** One run of a question's words; `strong` ones are drawn in bold. */
export type QuestionPart = { text: string; strong?: boolean };

/** "the payment of RM 300.00 to Tenaga Nasional", in parts; nobody is named when the voucher names nobody. */
function paymentOf(row: PaymentVoucherRow): QuestionPart[] {
  // In the account's currency (stage 5b).
  const parts: QuestionPart[] = [{ text: 'the payment of ' }, { text: money(row.amount, cashBookCurrency(row)), strong: true }];
  if (row.party_name) parts.push({ text: ' to ' }, { text: row.party_name, strong: true });
  return parts;
}

const DELETE_STATE: Record<PaymentVoucherRow['status'], string> = {
  draft: ' that is a draft',
  pending_approval: ' that is waiting for approval',
  scheduled: ' that is still to be paid',
  rejected: ' that was rejected',
  // Not offered: a paid or void voucher has no Delete.
  posted: '',
  void: '',
};

/** What marking a voucher paid does, said under the question before it is done. */
export function voucherPaidEffect(row: Pick<PaymentVoucherRow, 'kind'>): string {
  const expenses = row.kind === 'expense' ? ' What it holds of its expenses is then paid.' : '';
  return `It gets its payment voucher number and moves the books on that date.${expenses} After this it cannot be changed or deleted, only voided.`;
}

/**
 * The question asked in a voucher's row before it is sent, approved,
 * rejected, marked paid, deleted or voided. The figures are the row's, as it
 * is now. A voucher that pays documents names them, and deleting one that
 * holds part of expenses or bills says they are freed. The question for
 * marking paid ends where the date field follows it: "… as paid on".
 */
export function voucherQuestion(kind: Exclude<VoucherAction, 'edit'>, row: PaymentVoucherRow): QuestionPart[] {
  const what = paymentOf(row);
  if (kind === 'markPaid') {
    return [{ text: 'Mark ' }, ...what, { text: ', from ' }, { text: row.account_name, strong: true }, { text: ', as paid on' }];
  }
  if (kind === 'void') {
    // Only posted money counts as paid on an expense, so voiding puts back what this voucher paid of each.
    const owed = row.kind === 'expense' ? ' The expenses it paid are owed that amount again, and can be marked paid again on Expenses.' : '';
    return [
      { text: 'Void ' },
      ...(row.number ? [{ text: row.number, strong: true }, { text: ', ' }] : []),
      ...what,
      { text: `, paid on ${displayDate(row.txn_date)} from ` },
      { text: row.account_name, strong: true },
      { text: `? The money counts as back in the account and the books reverse it.${owed} It is kept as Void (find it under Void in the status filter), and this cannot be undone.` },
    ];
  }
  if (kind === 'submit') {
    return [
      { text: 'Send ' },
      ...what,
      ...(row.documents ? [{ text: ` for ${row.documents}` }] : []),
      { text: `, dated ${displayDate(row.txn_date)}, from ` },
      { text: row.account_name, strong: true },
      { text: ', for approval? It then waits as Pending approval and cannot be changed, only approved, rejected or deleted.' },
    ];
  }
  if (kind === 'approve') {
    return [
      { text: 'Approve ' },
      ...what,
      ...(row.documents ? [{ text: ` for ${row.documents}` }] : []),
      { text: `, dated ${displayDate(row.txn_date)}, from ` },
      { text: row.account_name, strong: true },
      { text: '? It is then To be paid, exactly as it stands: it cannot be changed after this, only paid or deleted.' },
    ];
  }
  if (kind === 'reject') {
    return [
      { text: 'Reject ' },
      ...what,
      { text: '? It stays in the list as Rejected and cannot be brought back: to pay it after all, record it again.' },
    ];
  }
  // A rejected voucher holds nothing: the guard on allocations does not count it.
  const held = row.status === 'rejected' ? null : row.kind === 'expense' ? 'expenses' : row.kind === 'bill' ? 'bills' : null;
  const frees = held ? ` What it held of its ${held} is freed.` : '';
  return [{ text: 'Delete ' }, ...what, { text: `${DELETE_STATE[row.status]}? Nothing has been paid.${frees} This cannot be undone.` }];
}

/**
 * What sending a draft and a decision are matched on and the table does not
 * draw: the voucher's category, its method, and its reference and notes when
 * they hold something. One line under the Send, the Approve and the Reject
 * question, so the person acts on all of it. Plain text; the caller renders
 * it as text.
 */
export function voucherDetailsLine(row: PaymentVoucherRow): string {
  const parts: string[] = [];
  if (row.category_name) parts.push(`Category: ${row.category_name}`);
  parts.push(`Method: ${PAYMENT_METHOD_LABELS[row.method]}`);
  if (row.reference?.trim()) parts.push(`Reference: ${row.reference.trim()}`);
  if (row.notes?.trim()) parts.push(`Notes: ${row.notes.trim()}`);
  return parts.join(' · ');
}

/**
 * The link in a row's Kind cell: a payment to a supplier and a refund have a
 * screen of their own. Its tooltip says the voucher is managed there only
 * from "To be paid" on; before that (a draft, waiting, rejected) its own menu
 * acts here, so the tooltip is left out. Nothing for the two kinds that
 * belong here.
 */
export function voucherKindLink(row: Pick<PaymentVoucherRow, 'kind' | 'status'>): { label: string; href: string; title: string | null } | null {
  const home = voucherHome(row.kind);
  if (!home) return null;
  const managedThere = row.status === 'scheduled' || row.status === 'posted' || row.status === 'void';
  return { ...home, title: managedThere ? `Managed on ${home.label}` : null };
}

/** How a voucher is named to a screen reader: "the payment of RM 300.00 to Tenaga Nasional". */
export function voucherName(row: PaymentVoucherRow): string {
  return paymentOf(row)
    .map((part) => part.text)
    .join('');
}

/* ---- the over-billing note ------------------------------------------- */

/**
 * For each voucher that is waiting for approval and pays supplier bills, the
 * advice about the purchase orders behind those bills: the sentences of
 * `orderNotesForBills`, the same ones Payments Out shows before a payment is
 * marked paid. `payments` is the Payments Out rows (one per bill a payment
 * pays), which is where a voucher's bills are named by id. A voucher with
 * nothing to say is not in the answer.
 */
export function orderNotesByVoucher(
  payments: Pick<PaymentOutRow, 'transaction_id' | 'bill_id' | 'status'>[],
  bills: { id: string; bill_no: string | null; purchase_order_id: string | null }[],
  orders: OrderBilling[],
): Record<string, string[]> {
  const billIds = new Map<string, string[]>();
  for (const p of payments) {
    if (p.status !== 'pending_approval') continue;
    billIds.set(p.transaction_id, [...(billIds.get(p.transaction_id) ?? []), p.bill_id]);
  }
  const notes: Record<string, string[]> = {};
  for (const [transactionId, ids] of billIds) {
    const found = orderNotesForBills(
      bills.filter((b) => ids.includes(b.id)),
      orders,
    );
    if (found.length) notes[transactionId] = found;
  }
  return notes;
}

/** Whether any voucher that pays supplier bills is waiting for approval: only then are bills and purchase orders read. */
export function hasBillVoucherWaiting(rows: Pick<PaymentVoucherRow, 'kind' | 'status'>[]): boolean {
  return rows.some((row) => row.kind === 'bill' && row.status === 'pending_approval');
}

/* ---- after a write ---------------------------------------------------- */

/** A voucher the person just recorded, approved, rejected, marked paid or voided, kept so the screen can tell whether it is in the list. */
export type WrittenVoucher = {
  id: string;
  /** How the database left it; null when a save could not read it back. */
  status: PaymentVoucherRow['status'] | null;
  /** Whether the person recorded it just now (true) or decided, paid or voided it (false). */
  recorded: boolean;
  payee: string | null;
  amount: number;
  /** Its date as the list now has it: for one just marked paid, the day it was paid. */
  date: string;
};

/** What happened to it, in the words the note uses. */
function did(written: WrittenVoucher): string {
  if (written.status === 'draft') return 'was saved as a draft';
  if (written.status === 'rejected') return 'was rejected';
  if (written.status === 'pending_approval') return 'was sent and waits for approval';
  if (written.status === 'scheduled') return written.recorded ? 'was saved and is To be paid' : 'was approved and is To be paid';
  if (written.status === 'posted') return written.recorded ? 'was saved as paid' : 'was marked paid';
  if (written.status === 'void') return 'was voided';
  return 'was saved';
}

/** What happened to it, as a title for the note. */
export function writtenVoucherTitle(written: WrittenVoucher): string {
  if (written.status === 'draft') return 'Draft saved';
  if (written.status === 'rejected') return 'Voucher rejected';
  if (written.status === 'pending_approval') return 'Voucher sent for approval';
  if (written.status === 'scheduled') return written.recorded ? 'Voucher saved' : 'Voucher approved';
  if (written.status === 'posted') return written.recorded ? 'Voucher saved as paid' : 'Voucher marked paid';
  if (written.status === 'void') return 'Voucher voided';
  return 'Voucher saved';
}

/**
 * Where a rejected, a paid and a void voucher are listed: under which status
 * filters, and what to choose when the one chosen is not among them. Each is
 * also left out of a period its date is not in.
 */
const LISTED_UNDER: Partial<Record<PaymentVoucherRow['status'], { filters: PaymentVoucherFilter[]; choose: string }>> = {
  rejected: { filters: ['rejected'], choose: 'Rejected' },
  posted: { filters: ['open', 'posted'], choose: 'All but void and rejected' },
  void: { filters: ['void'], choose: 'Void' },
};

/**
 * What to say about the voucher just written when it is not among the rows
 * on screen; null when it is, so there is nothing to say. Worked out at
 * render from the rows listed now, so changing the period, a filter or the
 * search updates it. `inMatching` is whether it is among the rows the
 * period, the filters and the search keep; `inShown` whether it is among
 * those on screen (the table shows ten until "View all"). A draft is in the
 * list only in a period its date is in, and under no status filter but the
 * first. A voucher that is
 * waiting or "To be paid" is in every period; a rejected one is left out of
 * the list until Rejected is chosen, a void one until Void is, a paid one
 * while a status that is not its own is, and each of the three out of a
 * period its date is not in, so each of those is said in so many words.
 * Anything else that hides it is the search, a filter or the ten-row limit.
 */
export function voucherHiddenNote(
  written: WrittenVoucher,
  today: string,
  period: CashBookPeriod,
  filter: PaymentVoucherFilter,
  inMatching: boolean,
  inShown: boolean,
): string | null {
  if (inShown) return null;
  const what = `The payment of ${rm(written.amount)}${written.payee ? ` to ${written.payee}` : ''}, dated ${displayDate(written.date)},`;
  if (inMatching) return `${what} ${did(written)}. Choose View all to see it.`;
  const listed = written.status ? LISTED_UNDER[written.status] : undefined;
  if (listed) {
    const outside = !inPeriod(written.date, today, period);
    if (!listed.filters.includes(filter)) {
      return `${what} ${did(written)}. Choose ${listed.choose} in the status filter${outside ? ' and a longer period' : ''} to see it.`;
    }
    if (outside) return `${what} ${did(written)}. Choose a longer period to see it.`;
    // Its status is chosen and its date is in the period: only the search or the Kind filter can be hiding it.
    return `${what} ${did(written)}. Clear the search and the Kind filter to see it.`;
  }
  if (written.status === 'draft') {
    // A draft is listed in every period, so only the status filter, the search or the Kind filter can hide it.
    if (filter !== 'open') {
      return `${what} ${did(written)}. Choose All but void and rejected in the status filter to see it.`;
    }
    return `${what} ${did(written)}. Clear the search and the Kind filter to see it.`;
  }
  return `${what} ${did(written)}. Clear the search and the filters to see it.`;
}

/* ---- what the loader gives a person ---------------------------------- */

/**
 * What the Payment Vouchers loader reads and hands over for someone: whether
 * they get a `writer` (the form, Delete) at all, whether they may approve and
 * reject, whether what the form offers is read (`readsForm`: accounts,
 * contacts, categories, and the bills, payments and purchase orders behind
 * a voucher for a supplier's bills), and whether the over-billing note of the
 * Approve question is worked out from those bills and orders (`readsOrders`).
 * The demo workspace is only ever read. Someone who cannot decide is never
 * asked a question that note belongs to, and it is not worked out while no
 * supplier payment waits.
 */
export function voucherAccess(
  viewer: { isDemo: boolean; role: OrgRole },
  rows: Pick<PaymentVoucherRow, 'kind' | 'status'>[],
): { writer: boolean; canDecide: boolean; readsForm: boolean; readsOrders: boolean } {
  const writer = !viewer.isDemo && can(viewer.role, 'edit-data');
  const canDecide = writer && can(viewer.role, 'sign-off-finance');
  return { writer, canDecide, readsForm: writer, readsOrders: canDecide && hasBillVoucherWaiting(rows) };
}
