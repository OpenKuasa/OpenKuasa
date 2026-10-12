/**
 * The rules of the Expenses screen that are not the database's, kept out of
 * the components so they can be tested: what a new expense form holds, what
 * one being changed holds, what is wrong with it, what is sent to
 * saveExpenseAction; what a row's menu offers each person; and the words the
 * screen uses for an expense that is paid in part, for a save, and for an
 * expense that was written and is not in the list. Pure.
 */
import { type ExpenseCategory, EXPENSE_MESSAGES, type ExpenseRow, type ExpenseStatus, saveExpenseInput } from './expenses';
import { can } from '@/lib/auth/permissions';
import type { OrgRole } from '@/lib/auth/current-org';
import { rm, typedNumber } from './format';
import { displayDate } from './view-helpers';

const M = EXPENSE_MESSAGES;

/** The vendor picker's value for "not one of the contacts": the name is typed. */
export const TYPED_VENDOR = 'typed';

export type ExpenseForm = {
  /** Present when a saved expense is being changed. */
  id?: string;
  date: string;
  categoryId: string;
  /** A contact's id, or `TYPED_VENDOR` with the name in `vendorName`. */
  vendor: string;
  vendorName: string;
  /** The amount as typed, SST included. */
  amount: string;
  /** The SST inside the amount, as typed; empty is none. */
  sst: string;
  notes: string;
};

/** An amount as a form holds it: no trailing zeros beyond the sen, and nothing for zero. */
function amountText(value: number): string {
  return value ? String(Math.round(value * 100) / 100) : '';
}

/** A fresh form, dated today (the person's own date); the category is chosen when there is only one. */
export function newExpenseForm(categories: ExpenseCategory[], today: string): ExpenseForm {
  return {
    date: today,
    categoryId: categories.length === 1 ? categories[0].id : '',
    vendor: TYPED_VENDOR,
    vendorName: '',
    amount: '',
    sst: '',
    notes: '',
  };
}

/** The form for an expense being changed, from its row on the screen: every field the form has is in the row. */
export function editExpenseForm(row: ExpenseRow): ExpenseForm {
  return {
    id: row.id,
    date: row.expense_date,
    categoryId: row.category_id,
    vendor: row.vendor_id ?? TYPED_VENDOR,
    vendorName: row.vendor_id ? '' : row.vendor_name,
    amount: amountText(row.amount),
    sst: amountText(row.sst_amount),
    notes: row.notes ?? '',
  };
}

/**
 * What is sent to saveExpenseAction. Amounts are numbers: a box that is not a
 * number (a number input drops a typed comma, so "1,200.50" arrives empty)
 * goes as NaN and is refused; an empty SST box is 0. The vendor is a contact
 * or a typed name, never both.
 */
export function expensePayload(form: ExpenseForm) {
  const typed = form.vendor === TYPED_VENDOR;
  return {
    ...(form.id ? { id: form.id } : {}),
    expense_date: form.date,
    category_id: form.categoryId,
    vendor_id: typed ? null : form.vendor,
    vendor_name: typed ? form.vendorName : null,
    amount: typedNumber(form.amount) ?? Number.NaN,
    sst_amount: form.sst.trim() === '' ? 0 : (typedNumber(form.sst) ?? Number.NaN),
    notes: form.notes,
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema would use,
 * or null when it can be sent. In the order of the form: category, vendor,
 * then whatever the schema finds (date, amount, SST, a text that is too long).
 */
export function expenseFormError(form: ExpenseForm): string | null {
  if (!form.categoryId) return M.category;
  if (form.vendor === TYPED_VENDOR && form.vendorName.trim() === '') return M.vendorMissing;
  const parsed = saveExpenseInput.safeParse(expensePayload(form));
  // A wrong date is reported before a money box, as the form reads.
  if (!parsed.success && parsed.error.issues[0]?.path[0] === 'expense_date') return parsed.error.issues[0].message;
  const typed = moneyBoxError(form.amount, M.amountFormat, M.amountDecimals) ?? moneyBoxError(form.sst, M.sstFormat, M.sstDecimals);
  if (typed) return typed;
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? M.invalid);
}

/** What is wrong with the way a money box was typed, when it is not just "not a number": a comma or RM, or more than a sen. */
function moneyBoxError(text: string, format: string, decimals: string): string | null {
  if (/[,$]|^\s*(rm|myr)/i.test(text)) return format;
  if (/\.\d{3,}\s*$/.test(text)) return decimals;
  return null;
}

/**
 * After a save that was refused. An expense that someone deleted meanwhile
 * answers "no longer exists" on every try; the form then forgets the id, so
 * the next save records what was typed as a new expense, and the sentence
 * says so. Any other refusal changes nothing.
 */
export function afterRefusedExpenseSave(form: ExpenseForm, error: string): { form: ExpenseForm; error: string } {
  if (error !== M.gone || !form.id) return { form, error };
  return { form: { ...form, id: undefined }, error: `${M.gone} Save again to record it as a new expense.` };
}

/**
 * What the form says under its fields, before anything is saved: what saving
 * will do for this person. An owner or admin approves by saving, whoever
 * entered the expense; anyone else sends it for approval.
 */
export function expenseSaveHint(canDecide: boolean, editing: ExpenseRow | undefined): string {
  if (canDecide) {
    if (!editing) return 'An expense you save is approved at once: you are an owner or admin.';
    const leave = editing.status === 'rejected' ? 'rejected' : 'waiting';
    return `Saving approves this expense as you leave it: you are an owner or admin. To leave it ${leave}, cancel.`;
  }
  if (editing?.status === 'rejected') return 'Saving sends this expense for approval again. An owner or admin approves or rejects it.';
  // Not "your": the form does not know who entered an expense it is changing.
  return 'This expense waits as Pending approval until an owner or admin approves it. Until then anyone who may edit can change or delete it.';
}

/* ---- the row ---------------------------------------------------------- */

export type ExpenseAction = 'edit' | 'approve' | 'reject' | 'delete';

/**
 * What an expense's row menu offers, by its status and by whether the person
 * may decide (an owner or admin). The database's rules, so nothing is offered
 * that it would refuse:
 *  - pending: anyone who may write edits or deletes it, whoever entered it;
 *    an owner or admin also approves or rejects it;
 *  - rejected: edited (which sends it for approval again) or deleted;
 *    it is not approved as it stands;
 *  - approved, with nothing paid and nothing held by a payment: an owner or
 *    admin may reject it, which is its only way back; nobody edits or deletes it;
 *  - approved with a payment against it, paid or still to be paid, and paid:
 *    nothing.
 */
export function expenseActions(row: ExpenseRow, canDecide: boolean): ExpenseAction[] {
  if (row.status === 'pending') return canDecide ? ['edit', 'approve', 'reject', 'delete'] : ['edit', 'delete'];
  if (row.status === 'rejected') return ['edit', 'delete'];
  return canDecide && row.paid === 0 && row.held === 0 ? ['reject'] : [];
}

/** Who is given the expense form and the row menus: anyone who may edit data in a real workspace, never the demo. */
export function canEditExpenses(role: OrgRole, isDemo: boolean): boolean {
  return !isDemo && can(role, 'edit-data');
}

/** True for the answers that mean the expense is no longer as the row showed it: the question is closed and the row refreshed. */
export function decisionIsStale(error: string): boolean {
  return ([M.changed, M.alreadyApproved, M.alreadyRejected, M.pendingAgain] as string[]).includes(error);
}

/** What an approval or a rejection sends of the row it was asked on: the row as shown, so the database decides that very expense. */
export function expenseDecisionPayload(row: ExpenseRow) {
  return {
    id: row.id,
    updated_at: row.updated_at,
    status: row.status,
    amount: row.amount,
    sst_amount: row.sst_amount,
    expense_date: row.expense_date,
    category_id: row.category_id,
    vendor_id: row.vendor_id,
    vendor_name: row.vendor_name,
    notes: row.notes,
  };
}

/** What the Expenses screen draws for someone who may write and for someone who may not. */
export function expenseControls(canWrite: boolean) {
  return { newButton: canWrite, actionsColumn: canWrite, columns: canWrite ? 7 : 6 };
}

/** One run of a question's words; `strong` ones are drawn in bold. */
export type QuestionPart = { text: string; strong?: boolean };

/**
 * The question asked in an expense's row before it is approved, rejected or deleted, in the words the owner
 * approved. The figures are the row's, as it is now.
 */
export function expenseQuestion(kind: 'approve' | 'reject' | 'delete', row: ExpenseRow): QuestionPart[] {
  const who = (before: string, after: string): QuestionPart[] => [
    { text: before },
    { text: rm(row.amount), strong: true },
    { text: ' to ' },
    { text: row.vendor_name, strong: true },
    { text: after },
  ];
  if (kind === 'approve') {
    return who(
      'Approve the expense of ',
      `, dated ${displayDate(row.expense_date)}? It is then locked: it can be paid, and only rejected while nothing has been paid.`,
    );
  }
  if (kind === 'reject') {
    return who(
      row.status === 'approved' ? 'Reject this approved expense of ' : 'Reject the expense of ',
      '? It stays in the list as Rejected. Whoever entered it can edit it and send it again, or delete it.',
    );
  }
  return who('Delete the expense of ', '? This cannot be undone.');
}

/** How an expense is named in a question and to a screen reader: "the expense of RM 120.00 to Kedai Ali". */
export function expenseName(row: ExpenseRow): string {
  return `the expense of ${rm(row.amount)} to ${row.vendor_name}`;
}

/** True for an approved expense that posted money out covers in part. */
export function isPartPaid(row: ExpenseRow): boolean {
  return row.display_status === 'approved' && row.paid > 0;
}

/**
 * What stands against an approved expense that is not simply paid or unpaid,
 * for the line under its status: what was paid, what payments not yet made
 * hold, and what is left with no payment at all. null for an expense with no
 * payment, for one paid in full, and for a pending or rejected one.
 */
export function expensePaymentNote(row: ExpenseRow): string | null {
  if (row.display_status !== 'approved' || (row.paid === 0 && row.held === 0)) return null;
  const left = Math.round((row.amount - row.paid - row.held) * 100) / 100;
  const parts: string[] = [];
  if (row.paid > 0) parts.push(`${rm(row.paid)} paid`);
  if (row.held > 0) parts.push(`${rm(row.held)} to be paid`);
  if (left > 0) parts.push(`${rm(left)} with no payment yet`);
  return parts.join(' · ');
}

/* ---- after a write ---------------------------------------------------- */

/** An expense the person just saved, approved or rejected, kept so the screen can tell whether it is in the list. */
export type WrittenExpense = {
  id: string;
  /** How the database left it; null when a save could not read it back. */
  status: ExpenseStatus | null;
  vendor: string;
  amount: number;
  date: string;
};

/** What happened to it, as a title for the note. */
export function writtenExpenseTitle(written: WrittenExpense): string {
  if (written.status === 'approved') return 'Expense approved';
  if (written.status === 'rejected') return 'Expense rejected';
  if (written.status === 'pending') return 'Expense sent for approval';
  return 'Expense saved';
}

/**
 * What to say about the expense just written when it is not among the rows on
 * screen; null when it is, so there is nothing to say. Worked out at render
 * from the rows listed now, so changing a filter or the search updates it.
 * `inMatching` is whether it is among the rows the filters and the search
 * keep; `inShown` whether it is among those on screen (the table shows ten
 * until "View all"). A rejected expense is left out of the list until
 * Rejected is chosen, so that is said in so many words.
 */
export function expenseHiddenNote(written: WrittenExpense, inMatching: boolean, inShown: boolean): string | null {
  if (inShown) return null;
  const what = `The expense of ${rm(written.amount)} to ${written.vendor}, dated ${displayDate(written.date)},`;
  const did =
    written.status === 'approved'
      ? 'was approved'
      : written.status === 'rejected'
        ? 'was rejected'
        : written.status === 'pending'
          ? 'was saved and waits for approval'
          : 'was saved';
  if (!inMatching) {
    return written.status === 'rejected'
      ? `${what} ${did}. Choose Rejected in the status filter to see it.`
      : `${what} ${did}. Clear the search and the filters to see it.`;
  }
  return `${what} ${did}. Choose View all to see it.`;
}
