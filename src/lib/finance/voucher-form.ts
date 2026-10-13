/**
 * The rules of the Payment Vouchers screen that are not the database's, kept
 * out of the components so they can be tested: what a new voucher form
 * holds, what is wrong with it and what is sent to recordVoucherAction; what
 * a row's menu offers each person; what a decision sends of the row it was
 * asked on; the words of the three questions; the over-billing notes for the
 * vouchers that pay supplier bills; and what the screen says about a voucher
 * that was just written and is not in the list. Pure.
 */
import type { OrgRole } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import { defaultAccount } from './allocation-form';
import type { PaymentVoucherRow } from './cash-book';
import { type CashBookPeriod, type PaymentVoucherFilter, inPeriod, voucherHome } from './cash-book-views';
import type { ExpenseCategory } from './expenses';
import { rm, typedNumber } from './format';
import { PAYMENT_METHOD_LABELS, type FinanceAccount, type PaymentMethod, type PaymentOutRow } from './money';
import { type OrderBilling, orderNotesForBills } from './purchase-views';
import { displayDate } from './view-helpers';
import { VOUCHER_MESSAGES, recordVoucherInput } from './vouchers';

const M = VOUCHER_MESSAGES;

/** The payee picker's value for "not one of the contacts": the name is typed. */
export const TYPED_PAYEE = 'typed';

export type VoucherForm = {
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
};

/** A fresh form: from the first bank account, by bank transfer, dated today (the person's own date); the category chosen when there is only one. */
export function newVoucherForm(accounts: FinanceAccount[], categories: ExpenseCategory[], today: string): VoucherForm {
  return {
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
 * What is sent to recordVoucherAction. The amount is a number: a box that is
 * not a number (a number input drops a typed comma, so "1,200.50" arrives
 * empty) goes as NaN and is refused. Whoever is paid is a contact or a typed
 * name, never both. No status is sent: the database decides it.
 */
export function voucherPayload(form: VoucherForm) {
  const typed = form.payee === TYPED_PAYEE;
  return {
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    category_id: form.categoryId,
    amount: typedNumber(form.amount) ?? Number.NaN,
    contact_id: typed ? null : form.payee,
    party_name: typed ? form.payeeName : null,
    reference: form.reference,
    notes: form.notes,
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema would use,
 * or null when it can be sent. In the order of the form: who is paid, the
 * category, the amount, then whatever the schema finds (the account, the
 * date, a text that is too long).
 */
export function voucherFormError(form: VoucherForm): string | null {
  if (form.payee === TYPED_PAYEE && form.payeeName.trim() === '') return M.payeeMissing;
  if (!form.categoryId) return M.category;
  if (/[,$]|^\s*(rm|myr)/i.test(form.amount)) return M.amountFormat;
  if (/\.\d{3,}\s*$/.test(form.amount)) return M.amountDecimals;
  if (!form.accountId) return M.account;
  const parsed = recordVoucherInput.safeParse(voucherPayload(form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? M.invalid);
}

/** What the form says under its fields, before anything is recorded: what recording will do for this person. */
export function voucherSaveHint(canDecide: boolean): string {
  return canDecide
    ? 'A voucher you save is approved at once and reads To be paid: you are an owner or admin. Nothing is paid until it is marked paid.'
    : 'This voucher waits as Pending approval until an owner or admin approves or rejects it. Until then it cannot be changed, only deleted.';
}

/** The button that records the voucher, by what recording does for this person. */
export function voucherSubmitLabel(canDecide: boolean): string {
  return canDecide ? 'Save voucher' : 'Send for approval';
}

/* ---- the row ---------------------------------------------------------- */

export type VoucherAction = 'approve' | 'reject' | 'delete';

/** Before "To be paid": the statuses Payments Out and Refunds offer nothing on, so a voucher in one of them is changed here whatever it pays. */
const BEFORE_TO_BE_PAID: ReadonlySet<PaymentVoucherRow['status']> = new Set(['draft', 'pending_approval', 'rejected']);

/**
 * What a voucher's row menu offers, by its status, its kind and whether the
 * person may decide (an owner or admin). The database's rules, so nothing is
 * offered that it would refuse, and nothing that another screen also offers:
 *  - waiting for approval, whatever it pays: an owner or admin approves or
 *    rejects it. No other screen has those two;
 *  - a draft, waiting or rejected, whatever it pays: anyone who may write
 *    deletes it, whoever recorded it. Payments Out and Refunds offer nothing
 *    on a payment before it is "To be paid", so without this a rejected
 *    payment to a supplier could never be removed;
 *  - "To be paid": deleted here only when it is of a kind that belongs here.
 *    A payment to a supplier and a refund are then marked paid or deleted on
 *    their own screens (`voucherHome`), so their rows offer nothing here;
 *  - paid or void: nothing here yet.
 */
export function voucherActions(row: PaymentVoucherRow, canDecide: boolean): VoucherAction[] {
  const actions: VoucherAction[] = [];
  if (row.status === 'pending_approval' && canDecide) actions.push('approve', 'reject');
  if (BEFORE_TO_BE_PAID.has(row.status) || (row.status === 'scheduled' && voucherHome(row.kind) === null)) actions.push('delete');
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
  return ([M.changed, M.alreadyApproved, M.alreadyRejected, M.movedOn, M.gone] as string[]).includes(error);
}

/** One run of a question's words; `strong` ones are drawn in bold. */
export type QuestionPart = { text: string; strong?: boolean };

/** "the payment of RM 300.00 to Tenaga Nasional", in parts; nobody is named when the voucher names nobody. */
function paymentOf(row: PaymentVoucherRow): QuestionPart[] {
  const parts: QuestionPart[] = [{ text: 'the payment of ' }, { text: rm(row.amount), strong: true }];
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

/**
 * The question asked in a voucher's row before it is approved, rejected or
 * deleted. The figures are the row's, as it is now. A voucher that pays
 * documents names them, and deleting one that holds part of expenses or
 * bills says they are freed.
 */
export function voucherQuestion(kind: VoucherAction, row: PaymentVoucherRow): QuestionPart[] {
  const what = paymentOf(row);
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
 * What a decision is matched on and the table does not draw: the voucher's
 * category, its method, and its reference and notes when they hold
 * something. One line under the Approve and the Reject question, so the
 * person decides on all of it. Plain text; the caller renders it as text.
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

/** A voucher the person just recorded, approved or rejected, kept so the screen can tell whether it is in the list. */
export type WrittenVoucher = {
  id: string;
  /** How the database left it; null when a save could not read it back. */
  status: PaymentVoucherRow['status'] | null;
  /** Whether the person recorded it just now (true) or decided it (false). */
  recorded: boolean;
  payee: string | null;
  amount: number;
  date: string;
};

/** What happened to it, in the words the note uses. */
function did(written: WrittenVoucher): string {
  if (written.status === 'rejected') return 'was rejected';
  if (written.status === 'pending_approval') return 'was sent and waits for approval';
  if (written.status === 'scheduled') return written.recorded ? 'was saved and is To be paid' : 'was approved and is To be paid';
  return 'was saved';
}

/** What happened to it, as a title for the note. */
export function writtenVoucherTitle(written: WrittenVoucher): string {
  if (written.status === 'rejected') return 'Voucher rejected';
  if (written.status === 'pending_approval') return 'Voucher sent for approval';
  if (written.status === 'scheduled') return written.recorded ? 'Voucher saved' : 'Voucher approved';
  return 'Voucher saved';
}

/**
 * What to say about the voucher just written when it is not among the rows
 * on screen; null when it is, so there is nothing to say. Worked out at
 * render from the rows listed now, so changing the period, a filter or the
 * search updates it. `inMatching` is whether it is among the rows the
 * period, the filters and the search keep; `inShown` whether it is among
 * those on screen (the table shows ten until "View all"). A voucher that is
 * waiting or "To be paid" is in every period; a rejected one is left out of
 * the list until Rejected is chosen, and out of a period its date is not in,
 * so each of those is said in so many words. Anything else that hides it is
 * the search, a filter or the ten-row limit.
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
  if (written.status === 'rejected') {
    const outside = !inPeriod(written.date, today, period);
    if (filter !== 'rejected') {
      return `${what} ${did(written)}. Choose Rejected in the status filter${outside ? ' and a longer period' : ''} to see it.`;
    }
    if (outside) return `${what} ${did(written)}. Choose a longer period to see it.`;
    // Rejected is chosen and its date is in the period: only the search or the Kind filter can be hiding it.
    return `${what} ${did(written)}. Clear the search and the Kind filter to see it.`;
  }
  return `${what} ${did(written)}. Clear the search and the filters to see it.`;
}

/* ---- what the loader gives a person ---------------------------------- */

/**
 * What the Payment Vouchers loader reads and hands over for someone: whether
 * they get a `writer` (the form, Delete) at all, whether they may approve and
 * reject, whether the form's accounts, contacts and categories are read, and
 * whether the bills and purchase orders behind a waiting supplier payment are
 * read for the over-billing note. The demo workspace is only ever read.
 * Someone who cannot decide is never asked a question the note belongs to,
 * and nothing is read for the note while no supplier payment waits.
 */
export function voucherAccess(
  viewer: { isDemo: boolean; role: OrgRole },
  rows: Pick<PaymentVoucherRow, 'kind' | 'status'>[],
): { writer: boolean; canDecide: boolean; readsForm: boolean; readsOrders: boolean } {
  const writer = !viewer.isDemo && can(viewer.role, 'edit-data');
  const canDecide = writer && can(viewer.role, 'sign-off-finance');
  return { writer, canDecide, readsForm: writer, readsOrders: canDecide && hasBillVoucherWaiting(rows) };
}
