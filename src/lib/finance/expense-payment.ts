/**
 * Marking an approved expense as paid. Paying is recording a payment voucher
 * against the expense, paid now: `finance_record_voucher` with status
 * `posted` and one allocation `{ expense_id, amount }`. It is the function
 * the Payment Vouchers screen's rows come from, so the payment shows there
 * (kind `expense`, numbered PV-) and on Banking, and it is voided there. The
 * database says who may: recording a voucher as paid is a sign-off, an
 * owner's or admin's (FIN14 for anyone else, with nothing left behind). It
 * also has the last word on the amount: never more than is left of the
 * expense, counting payments that are not made yet (FIN05), and only against
 * an approved expense (FIN04).
 *
 * Who is paid is the expense's own vendor, read from the database when the
 * payment is recorded and never taken from the browser. The data-layer
 * function and the Mark paid card's rules are both here; the rules are pure.
 * org_id comes from the context.
 */
import { z } from 'zod';
import { amountText, defaultAccount } from './allocation-form';
import { isoDate, optionalText, ringgitAmount } from './document-lines';
import { expenseLeft, moneyBoxError } from './expense-form';
import { EXPENSE_MESSAGES, type ExpenseRow } from './expenses';
import { rm, typedNumber } from './format';
import { type FinanceAccount, MONEY_MESSAGES, PAYMENT_METHODS, type PaymentMethod } from './money';
import {
  ACCOUNT_ARCHIVED,
  type FinResult,
  type FinanceWriteContext,
  FIN_ACCOUNT_ARCHIVED,
  FIN_FOREIGN_ACCOUNT,
  FIN_SIGN_OFF,
  NEEDS_SIGN_OFF,
  NOT_ALLOWED,
  PG_CHECK,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const EXPENSE_PAYMENT_MESSAGES = {
  account: MONEY_MESSAGES.account,
  noAccount: 'There is no account to pay from. Add a bank or cash account on Banking first.',
  date: MONEY_MESSAGES.date,
  method: MONEY_MESSAGES.method,
  amount: EXPENSE_MESSAGES.amount,
  amountFormat: EXPENSE_MESSAGES.amountFormat,
  amountDecimals: EXPENSE_MESSAGES.amountDecimals,
  tooLong: MONEY_MESSAGES.tooLong,
  gone: EXPENSE_MESSAGES.gone,
  // The expense is pending or rejected now: it was rejected, or rejected and sent again, since the screen was drawn. Also FIN04.
  notApproved: 'This expense is not approved any more, so it cannot be paid.',
  // The expense is approved and is not the one the screen showed: it was rejected, changed and approved again.
  changed: 'This expense was changed after you opened it. Check it again, then mark it paid.',
  // The form's own check, and FIN05: the amount is above what is left, counting payments not made yet.
  tooMuch: 'That is more than is still to pay on this expense.',
  // Nothing is left: paid in full, or the rest is held by a payment still to be paid.
  nothingLeft: 'Nothing is left to pay on this expense.',
  // 23503: the account was deleted. (The vendor cannot be: the expense itself holds the contact.)
  missing: 'That account no longer exists. Choose another account.',
  // 23514 and 23502: a check or a required column. The schema refuses everything that could meet one.
  invalid: 'Check the account, the method and the amount, then try again.',
  // Stage 5b: an expense is paid from a ringgit account. The card lists ringgit accounts, so an account in another
  // currency (FIN51; FIN38 first when no rate is sent, which the card never sends; FIN50) is a stale tab or a direct call.
  ringgitAccount: 'Expenses are paid from a ringgit account. Choose a ringgit account.',
} as const;

const M = EXPENSE_PAYMENT_MESSAGES;

/** A required column was left empty. */
const PG_NOT_NULL = '23502';

/**
 * One payment of one approved expense, paid now. `updated_at` is the
 * expense's, as the screen showed it (the text the database gave): the
 * payment is recorded only while the expense is still that one. Who is paid,
 * the status and the workspace are never taken from input.
 */
export const markExpensePaidInput = z.object(
  {
    id: z.string({ error: M.gone }).uuid(M.gone),
    updated_at: z.iso.datetime({ offset: true, error: M.changed }),
    account_id: z.string({ error: M.account }).uuid(M.account),
    txn_date: isoDate,
    method: z.enum(PAYMENT_METHODS, { error: M.method }),
    reference: optionalText.default(null),
    amount: ringgitAmount(M.amount),
  },
  { error: M.invalid },
);

/** What marking paid answers: the expense, the voucher that paid it, and its PV- number (null when it could not be read back). */
export type PaidExpense = { id: string; voucher_id: string; number: string | null };

const REFUSALS: Record<string, string> = {
  FIN04: M.notApproved,
  FIN05: M.tooMuch,
  // The function found no expense of that id in the workspace.
  FIN06: M.gone,
  [FIN_SIGN_OFF]: NEEDS_SIGN_OFF,
  // The account was archived after the card was opened.
  [FIN_ACCOUNT_ARCHIVED]: ACCOUNT_ARCHIVED,
  // Stage 5b: an account in another currency, from a stale tab or a direct call (the card lists ringgit ones).
  [FIN_FOREIGN_ACCOUNT]: M.ringgitAccount,
  FIN38: M.ringgitAccount,
  FIN51: M.ringgitAccount,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_CHECK]: M.invalid,
  [PG_NOT_NULL]: M.invalid,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function payFailed(error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed('markExpensePaid', error);
}

/**
 * Records a payment voucher, paid now, against one approved expense. The
 * expense is read first, as the person was shown it (`updated_at`): its
 * vendor is who is paid, a contact or a typed name. When that read finds
 * nothing, one more read says why: the expense is gone, is not approved any
 * more, or was changed. An owner or admin only (FIN14 for anyone else).
 */
export async function markExpensePaid(
  ctx: FinanceWriteContext,
  input: z.input<typeof markExpensePaidInput>,
): Promise<FinResult<PaidExpense>> {
  const { id: expenseId, updated_at, account_id, txn_date, method, reference, amount } = markExpensePaidInput.parse(input);
  const shown = await ctx.client
    .from('finance_expenses')
    .select('id,vendor_id,vendor_name')
    .eq('id', expenseId)
    .eq('org_id', ctx.orgId)
    .eq('status', 'approved')
    .eq('updated_at', updated_at)
    .maybeSingle();
  if (shown.error) return payFailed(shown.error);
  if (!shown.data) {
    const still = await ctx.client.from('finance_expenses').select('id,status').eq('id', expenseId).eq('org_id', ctx.orgId).maybeSingle();
    if (still.error) return payFailed(still.error);
    if (!still.data) return { ok: false, error: M.gone };
    return { ok: false, error: (still.data as { status?: string }).status === 'approved' ? M.changed : M.notApproved };
  }
  const vendor = shown.data as { vendor_id: string | null; vendor_name: string | null };
  const voucher = {
    account_id,
    txn_date,
    method,
    reference,
    status: 'posted',
    // Exactly one of the two, as the expense has exactly one.
    ...(vendor.vendor_id ? { contact_id: vendor.vendor_id } : { party_name: vendor.vendor_name }),
  };
  const { data, error } = await ctx.client.rpc('finance_record_voucher', {
    target_org: ctx.orgId,
    voucher,
    allocations: [{ expense_id: expenseId, amount }],
  });
  if (error || !data) return payFailed(error);
  const voucherId = data as string;
  const read = await ctx.client.from('finance_transactions').select('number').eq('id', voucherId).eq('org_id', ctx.orgId).maybeSingle();
  const number = read.error || !read.data ? null : ((read.data as { number: string | null }).number ?? null);
  return { ok: true, data: { id: expenseId, voucher_id: voucherId, number } };
}

/* ---- the Mark paid card ------------------------------------------------- */

export type ExpensePayForm = {
  accountId: string;
  /** The date paid, YYYY-MM-DD. */
  date: string;
  method: PaymentMethod;
  reference: string;
  /** The amount as typed. */
  amount: string;
};

/** A fresh form: the first bank account, today (the person's own date), a bank transfer, and all that is left of the expense. */
export function newExpensePayForm(row: ExpenseRow, accounts: FinanceAccount[], today: string): ExpensePayForm {
  const left = expenseLeft(row);
  return {
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    amount: left > 0 ? amountText(left) : '',
  };
}

/** What is sent to markExpensePaidAction. The amount is a number: a box that is not a number goes as NaN and is refused. */
export function expensePayPayload(row: ExpenseRow, form: ExpensePayForm) {
  return {
    id: row.id,
    updated_at: row.updated_at,
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reference: form.reference,
    amount: typedNumber(form.amount) ?? Number.NaN,
  };
}

/**
 * The expense the card is for, as the list reads now: a refresh may have moved what is left of it, or taken it out of
 * the list altogether (rejected and deleted by someone else). `gone` is true then, and `row` is the one the card opened with.
 */
export function expensePayCurrent(opened: ExpenseRow, rows: ExpenseRow[]): { row: ExpenseRow; gone: boolean } {
  const now = rows.find((e) => e.id === opened.id);
  return now ? { row: now, gone: false } : { row: opened, gone: true };
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent. `row` is the expense as
 * the screen has it now, so a payment someone else recorded meanwhile is
 * counted once the screen has refreshed.
 */
export function expensePayError(row: ExpenseRow, form: ExpensePayForm, accounts: FinanceAccount[], gone = false): string | null {
  if (gone) return M.gone;
  if (row.status !== 'approved') return M.notApproved;
  const left = expenseLeft(row);
  if (left <= 0) return M.nothingLeft;
  if (accounts.length === 0) return M.noAccount;
  if (!form.accountId) return M.account;
  const parsed = markExpensePaidInput.safeParse(expensePayPayload(row, form));
  // A wrong date is reported before the money box, as the form reads.
  if (!parsed.success && parsed.error.issues[0]?.path[0] === 'txn_date') return parsed.error.issues[0].message;
  const typed = moneyBoxError(form.amount, M.amountFormat, M.amountDecimals);
  if (typed) return typed;
  // More than is left is said before the schema's amount sentence: a number too big for the column is above 0, and more than is left.
  const typedAmount = typedNumber(form.amount);
  if (typedAmount !== null && Number.isFinite(typedAmount) && Math.round(typedAmount * 100) > Math.round(left * 100)) return M.tooMuch;
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.invalid;
  return parsed.data.amount > left ? M.tooMuch : null;
}

/**
 * What the card says under its fields: what is still to pay, what already
 * stands against the expense, and what marking paid records. "To be paid" is
 * a payment that is recorded and not made yet (scheduled, or waiting on
 * Payment Vouchers). It ends with where a wrong payment is undone: the card
 * is an owner's or admin's, who can void the voucher on Payment Vouchers. An
 * expense that can no longer be paid (the list refreshed under the open card)
 * says only that.
 */
export function expensePayHint(row: ExpenseRow, gone = false): string {
  if (gone) return M.gone;
  if (row.status !== 'approved') return M.notApproved;
  const left = expenseLeft(row);
  if (left <= 0) return M.nothingLeft;
  const against: string[] = [];
  if (row.paid > 0) against.push(`${rm(row.paid)} is paid`);
  if (row.held > 0) against.push(`${rm(row.held)} is in a payment not yet paid`);
  const still = `${rm(left)} is still to pay on this expense`;
  return (
    `${against.length ? `${still}: ${against.join(' and ')}.` : `${still}.`} Paying less leaves the rest for another payment. ` +
    'This records a payment voucher, paid now: it shows on Payment Vouchers and Banking. To undo a wrong one, void it on Payment Vouchers.'
  );
}

/** What was just paid, for the note the screen shows afterwards. */
export type ExpensePaidNote = {
  /** The expense that was paid. */
  expenseId: string;
  amount: number;
  vendor: string;
  account: string;
  /** The voucher's PV- number; null when it could not be read back. */
  number: string | null;
  /** What was paid on the expense before this payment, as the card showed it. */
  paidBefore: number;
};

const cents = (n: number) => Math.round(n * 100);

/**
 * "Expense paid" or "Part of the expense paid" is said only from the list as it reads now, once it includes this
 * payment: the row the card opened with can be out of date (a payment held against the expense may have been
 * deleted since), and what the write answers does not say what is left. Until the list shows the payment, or when the
 * expense cannot be found in it, the note says only that a payment was recorded.
 */
export function expensePaidTitle(note: ExpensePaidNote, current?: ExpenseRow | null): string {
  if (!current || cents(current.paid) < cents(note.paidBefore + note.amount)) return 'Payment recorded';
  return cents(current.paid) >= cents(current.amount) ? 'Expense paid' : 'Part of the expense paid';
}

/** The note's sentence. The payment is a voucher: it is on Payment Vouchers and Banking, which is where the link goes. */
export function expensePaidText(note: ExpensePaidNote): string {
  const as = note.number ? ` as ${note.number}` : '';
  return `${rm(note.amount)} to ${note.vendor} was paid from ${note.account}${as}. The payment is on Banking and on`;
}
