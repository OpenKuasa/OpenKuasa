/**
 * Expenses. An expense is one `finance_expenses` row: a date, a category, a
 * vendor (a contact or a typed name, exactly one) and an amount with the SST
 * inside it. Anyone who may write saves one (`finance_save_expense`): saved by
 * an owner or admin it is approved in the same call, saved by anyone else it
 * waits as pending. While pending it is changed or deleted by anyone who may
 * write, whoever entered it; a rejected one is deleted, or changed, which
 * sends it for approval again. Approving and rejecting are an owner's or
 * admin's: one change of status, which the expense's own guard checks (FIN14
 * for anyone else) and signs with who decided and when. An approved expense
 * is locked; it can be rejected while no payment stands against it (FIN02).
 * It is paid by a payment voucher. org_id comes from the context.
 */
import { z } from 'zod';
import { LINE_MESSAGES, isoDate, optionalText, ringgitAmount } from './document-lines';
import type { PaymentMethod } from './money';
import {
  type FinResult,
  type FinanceWriteContext,
  FIN_SIGN_OFF,
  NOT_ALLOWED,
  PG_CHECK,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

/** What a person sets. */
export type ExpenseStatus = 'pending' | 'approved' | 'rejected';

/** How an expense reads: `paid` once posted money out covers an approved one. Never stored. */
export type ExpenseDisplayStatus = ExpenseStatus | 'paid';

export const EXPENSE_PAGE_SIZE = 1000;

export type ExpenseRow = {
  id: string;
  expense_date: string;
  category_id: string;
  category_name: string;
  vendor_id: string | null;
  vendor_name: string;
  /** What was paid or is to be paid, SST included. */
  amount: number;
  /** The part of `amount` that is SST. */
  sst_amount: number;
  notes: string | null;
  status: ExpenseStatus;
  display_status: ExpenseDisplayStatus;
  /** Posted money out against it. */
  paid: number;
  /** What payments not yet posted hold of it. */
  held: number;
  /** How the latest posted payment was made; null while nothing has been paid. */
  method: PaymentMethod | null;
  paid_on: string | null;
  /**
   * When the expense was last changed, exactly as the database wrote it. An approval or a rejection sends it
   * back, so that what is decided is the expense the person was shown.
   */
  updated_at: string;
};

export const EXPENSE_MESSAGES = {
  date: LINE_MESSAGES.date,
  category: 'Choose an expense category.',
  vendor: 'Choose the vendor from your contacts or type a name, not both.',
  vendorMissing: 'Say who was paid: choose a contact or type a name.',
  amount: 'Enter an amount above 0.',
  // Typed into a money box: a comma, or RM in front.
  amountFormat: 'Enter the amount as a number, without commas or RM: 1200.50.',
  // Typed into a money box: more than a sen.
  amountDecimals: 'Enter the amount to two decimal places.',
  // The same for the SST box, so it does not send a person to look at an amount that is fine.
  sstFormat: 'Enter the SST as a number, without commas or RM: 72.00.',
  sstDecimals: 'Enter the SST to two decimal places.',
  sst: 'Enter the SST that is inside the amount: 0 or more.',
  sstTooMuch: 'The SST cannot be more than the amount.',
  tooLong: LINE_MESSAGES.tooLong,
  gone: 'That expense no longer exists.',
  // FIN01 from saving: the expense was approved, here or in another tab, and an approved expense is locked.
  locked:
    'This expense has been approved, so it can no longer be changed. An owner or admin can reject it first, while no payment stands against it.',
  // FIN01 from approving: it is approved already, or it was rejected and a rejected expense is edited before it is decided again.
  cannotApprove: 'This expense cannot be approved as it now stands: it is already approved, or it was rejected and has to be edited first.',
  // FIN01 from rejecting: it is rejected already.
  cannotReject: 'This expense has already been rejected.',
  // FIN01 from deleting: it was approved in another tab.
  cannotDelete:
    'An approved expense cannot be deleted. An owner or admin can reject it first, while no payment stands against it.',
  // FIN02: money out, paid or still to be paid, is against it.
  hasPayments: 'This expense has a payment against it, paid or still to be paid, so it cannot be rejected.',
  // An approval or rejection found the expense changed (or decided) since the person's screen was drawn.
  changed: 'This expense was changed after you opened it. Check it again, then approve or reject it.',
  // The same, when the expense now holds a status of its own: someone else decided it, or sent it back.
  alreadyApproved: 'This expense has already been approved.',
  alreadyRejected: 'This expense has already been rejected.',
  pendingAgain: 'This expense is pending again.',
  // FIN14 from the expense's own guard.
  needsDecider: 'Only an owner or admin can approve or reject an expense. Ask one of them to do this.',
  // FIN15: no category, or one that is not an expense category of the workspace any more.
  categoryGone: 'Choose an expense category that still exists.',
  // 23503 from saving.
  missing: 'The category or the vendor on this expense no longer exists.',
  // 23503 from deleting: a payment that was voided still names the expense, and a voided payment is kept.
  keptForPayment: 'This expense has a voided payment against it, so it is kept.',
  // 23514: a check constraint. The schema refuses everything that could meet one, so only a direct call does.
  invalid: 'Check the vendor, the amount and the SST, then try again.',
} as const;

const M = EXPENSE_MESSAGES;

/** A required column was left empty. */
const PG_NOT_NULL = '23502';

const id = z.string({ error: M.gone }).uuid(M.gone);

/** A contact's id, or nobody chosen (null, or an empty string from a select). */
const optionalContact = z
  .union([z.string().uuid(M.vendor), z.literal(''), z.null()], { error: M.vendor })
  .transform((v) => (v === '' ? null : v))
  .default(null);

const toSen = (v: number) => Math.round(v * 100) / 100;

/**
 * An expense, new or being changed (`id`). The amount has its SST inside it;
 * `sst_amount` is that part and is never more than the amount. The vendor is
 * a contact or a typed name: exactly one. Status is never taken from input:
 * the database decides it from who is saving.
 */
export const saveExpenseInput = z
  .object(
    {
      id: id.optional(),
      expense_date: isoDate,
      category_id: z.string({ error: M.category }).uuid(M.category),
      vendor_id: optionalContact,
      vendor_name: optionalText.default(null),
      amount: ringgitAmount(M.amount),
      sst_amount: z
        .number({ error: M.sst })
        .transform(toSen)
        .pipe(z.number().min(0, M.sst).max(999_999_999_999.99, M.sst))
        .default(0),
      notes: optionalText.default(null),
    },
    { error: M.invalid },
  )
  .superRefine((v, ctx) => {
    if (v.vendor_id !== null && v.vendor_name !== null) {
      ctx.addIssue({ code: 'custom', message: M.vendor, path: ['vendor_name'] });
    } else if (v.vendor_id === null && v.vendor_name === null) {
      ctx.addIssue({ code: 'custom', message: M.vendorMissing, path: ['vendor_name'] });
    }
    if (v.sst_amount > v.amount) ctx.addIssue({ code: 'custom', message: M.sstTooMuch, path: ['sst_amount'] });
  });

export const expenseIdInput = z.object({ id }, { error: M.gone });

/**
 * Approving or rejecting an expense: which one, and what the screen showed of it. `updated_at` is kept as the text
 * the database gave (microseconds and offset included). The database does not move `updated_at` on every direct
 * update, so the fields a person decides on go with it: the decision matches the expense only if it still holds
 * all of them. `vendor_name` is the view's, which is the contact's name when there is a contact.
 */
export const expenseDecisionInput = z.object(
  {
    id,
    updated_at: z.iso.datetime({ offset: true, error: M.changed }),
    status: z.enum(['pending', 'approved', 'rejected'], { error: M.changed }),
    amount: z.number({ error: M.changed }).finite(M.changed),
    sst_amount: z.number({ error: M.changed }).finite(M.changed),
    expense_date: z.string({ error: M.changed }).regex(/^\d{4}-\d{2}-\d{2}$/, M.changed),
    category_id: z.string({ error: M.changed }).uuid(M.changed),
    vendor_id: z.string({ error: M.changed }).uuid(M.changed).nullable(),
    vendor_name: z.string({ error: M.changed }).nullable(),
    notes: z.string({ error: M.changed }).nullable(),
  },
  { error: M.gone },
);

/** What a save answers: the expense, and how the database left it (null when that could not be read back). */
export type SavedExpense = { id: string; status: ExpenseStatus | null };

const SAVE_REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN11: M.gone,
  FIN15: M.categoryGone,
  [FIN_SIGN_OFF]: M.needsDecider,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_CHECK]: M.invalid,
  // A required column was left out: the schema asks for every one, so only a direct call meets it.
  [PG_NOT_NULL]: M.invalid,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};
const APPROVE_REFUSALS: Record<string, string> = {
  FIN01: M.cannotApprove,
  [FIN_SIGN_OFF]: M.needsDecider,
  [PG_FORBIDDEN]: NOT_ALLOWED,
};
const REJECT_REFUSALS: Record<string, string> = {
  FIN01: M.cannotReject,
  FIN02: M.hasPayments,
  [FIN_SIGN_OFF]: M.needsDecider,
  [PG_FORBIDDEN]: NOT_ALLOWED,
};
const DELETE_REFUSALS: Record<string, string> = {
  FIN01: M.cannotDelete,
  [PG_FOREIGN_KEY]: M.keptForPayment,
  [PG_FORBIDDEN]: NOT_ALLOWED,
};

function expenseWriteFailed(fnName: string, error: unknown, refusals: Record<string, string>): { ok: false; error: string } {
  const refusal = refusals[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

const EXPENSE_COLUMNS =
  'id,expense_date,category_id,category_name,vendor_id,vendor_name,amount,sst_amount,notes,status,display_status,' +
  'paid,held,method,paid_on,updated_at';

/** Every expense in the workspace, newest first, read a page at a time. */
export async function listExpenses(ctx: FinanceWriteContext): Promise<ExpenseRow[]> {
  const rows: ExpenseRow[] = [];
  for (let from = 0; ; from += EXPENSE_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_expense_totals')
      .select(EXPENSE_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('expense_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + EXPENSE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((row) => ({
        ...(row as unknown as ExpenseRow),
        amount: Number(row.amount),
        sst_amount: Number(row.sst_amount),
        paid: Number(row.paid),
        held: Number(row.held),
      })),
    );
    if (page.length < EXPENSE_PAGE_SIZE) return rows;
  }
}

export type ExpenseCategory = { id: string; name: string };

/** The workspace's active expense categories, by name, for the expense form. */
export async function listExpenseCategories(ctx: FinanceWriteContext): Promise<ExpenseCategory[]> {
  const { data, error } = await ctx.client
    .from('finance_categories')
    .select('id,name')
    .eq('org_id', ctx.orgId)
    .eq('kind', 'expense')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as ExpenseCategory[];
}

/* ---- writes ----------------------------------------------------------- */

/**
 * Creates an expense, or changes one that is pending or was rejected. The
 * database approves it in the same call when an owner or admin is saving, and
 * leaves it pending for anyone else, so the status is read back and answered
 * with the id: the screen says which it was. A read that fails after a save
 * that worked answers `status: null`; the expense is saved either way.
 */
export async function saveExpense(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveExpenseInput>,
): Promise<FinResult<SavedExpense>> {
  const parsed = saveExpenseInput.parse(input);
  const { id: expenseId, expense_date, category_id, vendor_id, vendor_name, amount, sst_amount, notes } = parsed;
  const expense = { ...(expenseId ? { id: expenseId } : {}), expense_date, category_id, vendor_id, vendor_name, amount, sst_amount, notes };
  const { data, error } = await ctx.client.rpc('finance_save_expense', { target_org: ctx.orgId, expense });
  if (error || !data) return expenseWriteFailed('saveExpense', error, SAVE_REFUSALS);
  const saved = data as string;
  const read = await ctx.client.from('finance_expenses').select('status').eq('id', saved).eq('org_id', ctx.orgId).maybeSingle();
  const status = read.error || !read.data ? null : ((read.data as { status: ExpenseStatus }).status ?? null);
  return { ok: true, data: { id: saved, status } };
}

/**
 * One change of status on the expense the person was shown (`seen`: its `updated_at` and the fields the row
 * showed), kept to the workspace. The update matches the expense only while it still holds all of them. When no row
 * matches, the expense is gone, or it was changed since, or it was decided meanwhile: one more read tells which.
 */
async function decide(
  ctx: FinanceWriteContext,
  fnName: string,
  seen: z.output<typeof expenseDecisionInput>,
  status: 'approved' | 'rejected',
  refusals: Record<string, string>,
): Promise<FinResult<{ id: string }>> {
  let update = ctx.client
    .from('finance_expenses')
    // Status and nothing else: the guard refuses a decision that changes anything with it, and signs it itself.
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', seen.id)
    .eq('org_id', ctx.orgId)
    .eq('updated_at', seen.updated_at)
    .eq('status', seen.status)
    .eq('amount', seen.amount)
    .eq('sst_amount', seen.sst_amount)
    .eq('expense_date', seen.expense_date)
    .eq('category_id', seen.category_id);
  // A contact is matched by its id, and the table's own vendor_name is empty then (the view's is the contact's name).
  update = seen.vendor_id === null ? update.is('vendor_id', null).eq('vendor_name', seen.vendor_name ?? '') : update.eq('vendor_id', seen.vendor_id).is('vendor_name', null);
  update = seen.notes === null ? update.is('notes', null) : update.eq('notes', seen.notes);
  const { data, error } = await update.select('id').maybeSingle();
  if (error) return expenseWriteFailed(fnName, error, refusals);
  if (data) return { ok: true, data: { id: (data as { id: string }).id } };
  const still = await ctx.client.from('finance_expenses').select('id,status').eq('id', seen.id).eq('org_id', ctx.orgId).maybeSingle();
  if (still.error) return expenseWriteFailed(fnName, still.error, refusals);
  if (!still.data) return { ok: false, error: M.gone };
  const now = (still.data as { status?: ExpenseStatus }).status;
  if (now === 'approved' && seen.status !== 'approved') return { ok: false, error: M.alreadyApproved };
  if (now === 'rejected' && seen.status !== 'rejected') return { ok: false, error: M.alreadyRejected };
  if (now === 'pending' && seen.status !== 'pending') return { ok: false, error: M.pendingAgain };
  return { ok: false, error: M.changed };
}

/** Approves a pending expense as it stands. An owner or admin only (FIN14 for anyone else). */
export async function approveExpense(
  ctx: FinanceWriteContext,
  input: z.input<typeof expenseDecisionInput>,
): Promise<FinResult<{ id: string }>> {
  return decide(ctx, 'approveExpense', expenseDecisionInput.parse(input), 'approved', APPROVE_REFUSALS);
}

/**
 * Rejects a pending expense, or an approved one that no payment stands
 * against (FIN02 otherwise). An owner or admin only (FIN14 for anyone else).
 */
export async function rejectExpense(
  ctx: FinanceWriteContext,
  input: z.input<typeof expenseDecisionInput>,
): Promise<FinResult<{ id: string }>> {
  return decide(ctx, 'rejectExpense', expenseDecisionInput.parse(input), 'rejected', REJECT_REFUSALS);
}

/** Deletes a pending or rejected expense. An approved one is refused (FIN01): it is rejected first. */
export async function deleteExpense(
  ctx: FinanceWriteContext,
  input: z.input<typeof expenseIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: expenseId } = expenseIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_expenses')
    .delete()
    .eq('id', expenseId)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return expenseWriteFailed('deleteExpense', error, DELETE_REFUSALS);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: (data as { id: string }).id } };
}
