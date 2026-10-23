/**
 * Matching a receipt: making an expense or a draft supplier bill from it,
 * tying it to an expense or a bill that exists, and untying it. Each write is
 * one database function that locks the receipt first, so the document and the
 * match are one transaction (`finance_receipt_to_expense`,
 * `finance_receipt_to_bill`, `finance_attach_receipt`,
 * `finance_detach_receipt`). An expense made here follows the expense's own
 * rules: saved by an owner or admin it is approved in the same call, saved by
 * anyone else it waits as pending. A bill made here is a draft and nothing
 * here posts it. A receipt backs one document; a document may hold several
 * receipts. Only an owner or admin unties a receipt from an approved expense
 * or a posted bill (FIN14 from the receipt's guard). org_id comes from the
 * context.
 *
 * Client-safe: the inbox's cards import the schemas' messages and the pure
 * rules below.
 */
import { z } from 'zod';
import { can } from '@/lib/auth/permissions';
import type { OrgRole } from '@/lib/auth/current-org';
import { type BillForm, newBillForm, withSupplier } from './bill-form';
import { amountText } from './allocation-form';
import { BILL_MESSAGES, type BillDisplayStatus, type BillListRow, saveBillInput } from './bills';
import { BASE_CURRENCY } from './currencies';
import { emptyLine } from './document-form';
import { type ExpenseForm, TYPED_VENDOR } from './expense-form';
import {
  EXPENSE_MESSAGES,
  type ExpenseDisplayStatus,
  type ExpenseRow,
  type ExpenseStatus,
  type SavedExpense,
  saveExpenseInput,
} from './expenses';
import { money } from './format';
import { RECEIPT_INBOX_MESSAGES, receiptIdInput } from './receipt-inbox';
import { INBOX_RECEIPT_PAGE_SIZE, type InboxReceiptRow, type InboxReceiptType } from './receipts';
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
  WRITE_FAILED,
  pgCode,
  settingsRefusal,
} from './result';
import { displayDate } from './view-helpers';

export const RECEIPT_MATCH_MESSAGES = {
  gone: RECEIPT_INBOX_MESSAGES.gone,
  // FIN23 from making an expense or a bill, or attaching: someone matched the receipt meanwhile.
  alreadyMatched: 'This receipt is already matched. Untie it first.',
  // The attach form sent with nothing chosen.
  choose: 'Choose an expense or a bill to attach the receipt to.',
  // 23503 from attaching: the expense or the bill was deleted meanwhile.
  documentGone: 'That expense or bill no longer exists. Choose another.',
  // FIN25: the bill was voided meanwhile.
  voidBill: 'A void bill takes no receipt. Choose another bill.',
  // FIN14 from untying.
  needsDecider:
    'Only an owner or admin can untie a receipt from an approved expense or a posted bill. Ask one of them to do this.',
  // 23514 and 22023 from a direct call: the schemas refuse everything that could meet them.
  invalid: 'Check what was entered, then try again.',
} as const;

const M = RECEIPT_MATCH_MESSAGES;

const receiptId = z.string({ error: M.gone }).uuid(M.gone);

/** An expense to make from a receipt: the receipt, and the expense as the expense form sends it. An `id` in it is dropped. */
export const receiptToExpenseInput = z.object({ receipt_id: receiptId, expense: saveExpenseInput }, { error: M.invalid });

/** A draft bill to make from a receipt: the receipt, and the bill as the bill form sends it. An `id` in it is dropped. */
export const receiptToBillInput = z.object({ receipt_id: receiptId, bill: saveBillInput }, { error: M.invalid });

/** Tying a receipt to a document that exists: an expense or a bill of the workspace. */
export const attachReceiptInput = z.object(
  {
    receipt_id: receiptId,
    kind: z.enum(['expense', 'bill'], { error: M.choose }),
    document_id: z.string({ error: M.choose }).uuid(M.choose),
  },
  { error: M.choose },
);

/*
 * What each action refreshes. A `'use server'` file may export only async
 * functions, so these cannot be imported from `actions.ts`: they are written
 * again here, and `tests/finance-receipt-match.test.ts` fails if either drifts
 * from that file's EXPENSE_PATHS and BILL_PATHS.
 */
/** An expense made from a receipt moves what saving an expense moves. KEEP IN STEP with EXPENSE_PATHS in actions.ts. */
export const RECEIPT_EXPENSE_PATHS = [
  '/finance/expenses',
  '/finance/receipts-inbox',
  '/finance/payment-vouchers',
  '/finance/banking',
  '/finance/chart-of-accounts',
  '/finance/journals',
  '/finance/reports',
];
/** A draft bill made from a receipt moves what saving a bill moves. KEEP IN STEP with BILL_PATHS in actions.ts. */
export const RECEIPT_BILL_PATHS = [
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/customers-suppliers',
  '/finance/payment-vouchers',
  '/finance/banking',
  '/finance/chart-of-accounts',
  '/finance/journals',
  '/finance/reports',
  '/finance/purchase-orders',
  '/finance/receipts-inbox',
];
/** Tying and untying change the inbox and the paperclip on the two document screens, and no figure anywhere. */
export const RECEIPT_TIE_PATHS = ['/finance/receipts-inbox', '/finance/expenses', '/finance/supplier-bills'];

const FIN_GONE = 'FIN11';
const FIN_STATE = 'FIN23';
const FIN_VOID_BILL = 'FIN25';
/** `finance_attach_receipt` given both documents or neither. */
const PG_BAD_PARAMETER = '22023';
const PG_NOT_NULL = '23502';

const TO_EXPENSE_REFUSALS: Record<string, string> = {
  [FIN_GONE]: M.gone,
  [FIN_STATE]: M.alreadyMatched,
  FIN15: EXPENSE_MESSAGES.categoryGone,
  [PG_FOREIGN_KEY]: EXPENSE_MESSAGES.missing,
  [PG_CHECK]: EXPENSE_MESSAGES.invalid,
  [PG_NOT_NULL]: EXPENSE_MESSAGES.invalid,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};
const TO_BILL_REFUSALS: Record<string, string> = {
  [FIN_GONE]: M.gone,
  [FIN_STATE]: M.alreadyMatched,
  FIN10: BILL_MESSAGES.lines,
  FIN21: BILL_MESSAGES.order,
  FIN26: BILL_MESSAGES.category,
  [PG_FOREIGN_KEY]: BILL_MESSAGES.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};
const ATTACH_REFUSALS: Record<string, string> = {
  [FIN_GONE]: M.gone,
  [FIN_STATE]: M.alreadyMatched,
  [FIN_VOID_BILL]: M.voidBill,
  [PG_FOREIGN_KEY]: M.documentGone,
  [PG_BAD_PARAMETER]: M.choose,
  [PG_CHECK]: M.invalid,
  [PG_FORBIDDEN]: NOT_ALLOWED,
};
const DETACH_REFUSALS: Record<string, string> = {
  [FIN_GONE]: M.gone,
  [FIN_SIGN_OFF]: M.needsDecider,
  [PG_FORBIDDEN]: NOT_ALLOWED,
};

function matchFailed(fnName: string, error: unknown, refusals: Record<string, string>): { ok: false; error: string } {
  // A settings refusal first: an owner's expense is approved as it is made, so a date in a locked period is FIN63.
  const s = settingsRefusal(error);
  if (s) return { ok: false, error: s };
  const refusal = refusals[pgCode(error) ?? ''];
  if (refusal) return { ok: false, error: refusal };
  // The code only: a constraint's message quotes the values it refused, and those are a vendor's name and an amount.
  console.error(`[finance] ${fnName} failed:`, pgCode(error) ?? 'no code');
  return { ok: false, error: WRITE_FAILED };
}

/* ---- writes ----------------------------------------------------------- */

/**
 * Makes a new expense from a receipt and ties the receipt to it, in one
 * transaction. The database approves the expense in the same call when an
 * owner or admin is saving and leaves it pending for anyone else, so the
 * status is read back and answered with the id, as `saveExpense` does. A read
 * that fails after a save that worked answers `status: null`.
 */
export async function receiptToExpense(
  ctx: FinanceWriteContext,
  input: z.input<typeof receiptToExpenseInput>,
): Promise<FinResult<SavedExpense>> {
  const parsed = receiptToExpenseInput.parse(input);
  // Never an id: this makes an expense, it does not change one.
  const { expense_date, category_id, vendor_id, vendor_name, amount, sst_amount, notes } = parsed.expense;
  const { data, error } = await ctx.client.rpc('finance_receipt_to_expense', {
    target_org: ctx.orgId,
    target_receipt: parsed.receipt_id,
    expense: { expense_date, category_id, vendor_id, vendor_name, amount, sst_amount, notes },
  });
  if (error || typeof data !== 'string') return matchFailed('receiptToExpense', error, TO_EXPENSE_REFUSALS);
  const read = await ctx.client.from('finance_expenses').select('status').eq('id', data).eq('org_id', ctx.orgId).maybeSingle();
  const status = read.error || !read.data ? null : ((read.data as { status: ExpenseStatus }).status ?? null);
  return { ok: true, data: { id: data, status } };
}

/**
 * Makes a new draft supplier bill from a receipt and ties the receipt to it,
 * in one transaction. The bill is a draft with no number: it is finished and
 * posted on Supplier Bills, by an owner or admin, like any draft.
 */
export async function receiptToBill(
  ctx: FinanceWriteContext,
  input: z.input<typeof receiptToBillInput>,
): Promise<FinResult<{ id: string }>> {
  const parsed = receiptToBillInput.parse(input);
  // Never an id: this makes a draft, it does not change one. The lines travel beside the bill, as the function takes them.
  const { supplier_id, supplier_ref, bill_date, due_date, purchase_order_id, category_id, notes, lines } = parsed.bill;
  const { data, error } = await ctx.client.rpc('finance_receipt_to_bill', {
    target_org: ctx.orgId,
    target_receipt: parsed.receipt_id,
    bill: { supplier_id, supplier_ref, bill_date, due_date, purchase_order_id: purchase_order_id ?? null, category_id: category_id ?? null, notes },
    lines,
  });
  if (error || typeof data !== 'string') return matchFailed('receiptToBill', error, TO_BILL_REFUSALS);
  return { ok: true, data: { id: data } };
}

/** Ties a receipt that is tied to nothing to an expense or a bill of the workspace. */
export async function attachReceipt(
  ctx: FinanceWriteContext,
  input: z.input<typeof attachReceiptInput>,
): Promise<FinResult<{ id: string }>> {
  const parsed = attachReceiptInput.parse(input);
  const { error } = await ctx.client.rpc('finance_attach_receipt', {
    target_org: ctx.orgId,
    target_receipt: parsed.receipt_id,
    target_expense: parsed.kind === 'expense' ? parsed.document_id : null,
    target_bill: parsed.kind === 'bill' ? parsed.document_id : null,
  });
  if (error) return matchFailed('attachReceipt', error, ATTACH_REFUSALS);
  return { ok: true, data: { id: parsed.receipt_id } };
}

/** Unties a matched receipt, which goes back to Unmatched. One that is tied to nothing is left as it is. */
export async function detachReceipt(
  ctx: FinanceWriteContext,
  input: z.input<typeof receiptIdInput>,
): Promise<FinResult<{ id: string }>> {
  const parsed = receiptIdInput.parse(input);
  const { error } = await ctx.client.rpc('finance_detach_receipt', { target_org: ctx.orgId, target_receipt: parsed.id });
  if (error) return matchFailed('detachReceipt', error, DETACH_REFUSALS);
  return { ok: true, data: { id: parsed.id } };
}

/* ---- the read --------------------------------------------------------- */

/** A matched receipt, as a document's row shows it: enough to name it and to download it. Never its path. */
export type AttachedReceipt = {
  id: string;
  /** The uploader's device's name for the file. Render it as text only. */
  file_name: string;
  mime_type: InboxReceiptType;
  /** False only on the demo's sample rows. */
  has_file: boolean;
  expense_id: string | null;
  bill_id: string | null;
};

const ATTACHED_COLUMNS = 'id,file_name,mime_type,has_file,expense_id,bill_id';

/** Every matched receipt of the workspace, oldest upload first, read a page at a time. */
export async function listAttachedReceipts(ctx: FinanceWriteContext): Promise<AttachedReceipt[]> {
  const rows: AttachedReceipt[] = [];
  for (let from = 0; ; from += INBOX_RECEIPT_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_receipt_inbox')
      .select(ATTACHED_COLUMNS)
      .eq('org_id', ctx.orgId)
      // Matched is exactly "tied to one document" (a check constraint), so no filter on a nullable column is needed.
      .eq('status', 'matched')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + INBOX_RECEIPT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as AttachedReceipt[];
    rows.push(...page);
    if (page.length < INBOX_RECEIPT_PAGE_SIZE) return rows;
  }
}

/** A document's receipts, by the document's id: one map for expenses and bills alike (their ids never collide). */
export type ReceiptsByDocument = Record<string, AttachedReceipt[]>;

export function receiptsByDocument(attached: AttachedReceipt[]): ReceiptsByDocument {
  const by: ReceiptsByDocument = {};
  for (const receipt of attached) {
    const doc = receipt.expense_id ?? receipt.bill_id;
    if (doc) (by[doc] ??= []).push(receipt);
  }
  return by;
}

/* ---- how a matched receipt's document stands --------------------------- */

/** The document a matched receipt is tied to, as the inbox needs it. */
export type MatchedDocument = {
  kind: 'expense' | 'bill';
  id: string;
  /** How the document stands, in the words of its own screen. */
  label: string;
  /** An approved expense or a posted bill: only an owner or admin unties its receipt. Also when the document could not be read. */
  locked: boolean;
};

const EXPENSE_STATE_LABELS: Record<ExpenseDisplayStatus, string> = {
  pending: 'Pending approval',
  approved: 'Approved',
  paid: 'Paid',
  rejected: 'Rejected',
};
const BILL_STATE_LABELS: Record<BillDisplayStatus, string> = {
  draft: 'Draft',
  pending: 'Posted',
  overdue: 'Posted, overdue',
  paid: 'Paid',
  void: 'Void',
};

/**
 * For each matched receipt, the document it is tied to and how that stands,
 * by receipt id. A document missing from the lists (deleted a moment ago, or
 * past what was read) is `locked` with no label: the screen then offers
 * "Untie" only to an owner or admin, and the database decides either way.
 */
export function matchedDocuments(
  attached: AttachedReceipt[],
  expenses: Pick<ExpenseRow, 'id' | 'status' | 'display_status'>[],
  bills: Pick<BillListRow, 'id' | 'display_status'>[],
): Record<string, MatchedDocument> {
  const expenseById = new Map(expenses.map((e) => [e.id, e]));
  const billById = new Map(bills.map((b) => [b.id, b]));
  const out: Record<string, MatchedDocument> = {};
  for (const receipt of attached) {
    if (receipt.expense_id) {
      const expense = expenseById.get(receipt.expense_id);
      out[receipt.id] = {
        kind: 'expense',
        id: receipt.expense_id,
        label: expense ? EXPENSE_STATE_LABELS[expense.display_status] : '',
        locked: expense ? expense.status === 'approved' : true,
      };
    } else if (receipt.bill_id) {
      const bill = billById.get(receipt.bill_id);
      out[receipt.id] = {
        kind: 'bill',
        id: receipt.bill_id,
        label: bill ? BILL_STATE_LABELS[bill.display_status] : '',
        // Posted is every state but draft and void.
        locked: bill ? bill.display_status !== 'draft' && bill.display_status !== 'void' : true,
      };
    }
  }
  return out;
}

export type ReceiptMatchAction = 'expense' | 'bill' | 'attach' | 'untie';

/**
 * What a receipt's row menu offers someone who may edit, beside Review and
 * Delete. The database's rules, so nothing is offered that it would refuse:
 *  - tied to nothing (in review or unmatched): make an expense, make a draft
 *    bill, or attach it to a document that exists;
 *  - matched: untie, unless its document is an approved expense or a posted
 *    bill and the person is not an owner or admin.
 */
export function receiptMatchActions(
  row: Pick<InboxReceiptRow, 'status'>,
  document: MatchedDocument | undefined,
  canDecide: boolean,
): ReceiptMatchAction[] {
  if (row.status !== 'matched') return ['expense', 'bill', 'attach'];
  // A matched receipt whose document is not known is treated as locked.
  return canDecide || (document && !document.locked) ? ['untie'] : [];
}

/** Said in a matched receipt's row to someone who may edit but is not offered "Untie". The rule, so it is true whenever it shows. */
export const UNTIE_NEEDS_DECIDER = 'Only an owner or admin can untie a receipt from an approved expense or a posted bill.';

/* ---- the forms, pre-filled from a receipt ------------------------------ */

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** An amount as a form's box holds it: to the sen, as the other forms show one they open, and nothing for none. */
const boxText = (value: number | null) => (value === null || !(value > 0) ? '' : amountText(value));

type ReceiptDetails = Pick<InboxReceiptRow, 'vendor' | 'receipt_date' | 'amount' | 'sst_amount'>;

/**
 * What the expense form starts with for a receipt: its date (today, the
 * person's own, when it has none), its vendor as a typed name, or as the
 * contact when exactly one active contact has that very name, and its amount
 * and SST. The category is the person's to choose.
 */
export function expenseFormFromReceipt(
  row: ReceiptDetails,
  contacts: { id: string; name: string }[],
  today: string,
): Partial<ExpenseForm> {
  const named = row.vendor ? contacts.filter((c) => sameName(c.name, row.vendor ?? '')) : [];
  return {
    date: row.receipt_date ?? today,
    vendor: named.length === 1 ? named[0].id : TYPED_VENDOR,
    vendorName: named.length === 1 ? '' : (row.vendor ?? ''),
    amount: boxText(row.amount),
    sst: boxText(row.sst_amount),
  };
}

/** A bill line's description is at most 200 characters. */
const LINE_DESCRIPTION_MAX = 200;

/**
 * What the bill form starts with for a receipt: one line whose unit price is
 * the receipt's amount, SST rate 0 (a receipt's amount has its SST inside it;
 * a bill line's SST goes on top, so the person splits it if they want it
 * shown), the receipt's date as the bill date, and the supplier when exactly
 * one of the suppliers on offer has the vendor's very name. Everything is the
 * person's to change before saving.
 */
export function billFormFromReceipt(
  row: ReceiptDetails,
  suppliers: { id: string; name: string; payment_terms_days: number }[],
  today: string,
  defaultCategoryId = '',
): BillForm {
  const form = newBillForm(row.receipt_date ?? today, 'receipt-0', defaultCategoryId);
  const description = (row.vendor ? `Receipt: ${row.vendor}` : 'Receipt').slice(0, LINE_DESCRIPTION_MAX);
  const withLine: BillForm = { ...form, lines: [{ ...emptyLine('receipt-0'), description, unit_price: boxText(row.amount) }] };
  const named = row.vendor ? suppliers.filter((s) => sameName(s.name, row.vendor ?? '')) : [];
  // A receipt's amount is ringgit: the supplier's default currency does not move it.
  return named.length === 1 ? { ...withSupplier(withLine, named[0]), fx: withLine.fx } : withLine;
}

/* ---- the attach picker ------------------------------------------------- */

/** A document a receipt can be attached to, as the picker lists it. */
export type AttachCandidate = {
  kind: 'expense' | 'bill';
  id: string;
  /** "Expense · Travel", "Bill BILL-0007", "Draft bill". */
  title: string;
  /** Who, when and how it stands, as text. */
  detail: string;
  /** In `currency`: an expense is ringgit; a bill is in its own currency. */
  amount: number;
  /** ISO 4217 code. A receipt is ringgit, so only a ringgit document can be "the same amount". */
  currency: string;
  date: string;
  /** An approved expense or a posted bill: once attached, only an owner or admin unties it. */
  locked: boolean;
};

/**
 * The documents the picker offers: expenses that are pending or approved
 * (paid ones included) and bills that are not void. A rejected expense is
 * about to be changed or deleted and a void bill takes no receipt (FIN25).
 * Newest first.
 */
export function attachCandidates(expenses: ExpenseRow[], bills: BillListRow[]): AttachCandidate[] {
  const fromExpenses = expenses
    .filter((e) => e.status !== 'rejected')
    .map((e): AttachCandidate => ({
      kind: 'expense',
      id: e.id,
      title: `Expense · ${e.category_name}`,
      detail: `${e.vendor_name} · ${displayDate(e.expense_date)} · ${EXPENSE_STATE_LABELS[e.display_status]}`,
      amount: e.amount,
      currency: BASE_CURRENCY,
      date: e.expense_date,
      locked: e.status === 'approved',
    }));
  const fromBills = bills
    .filter((b) => b.display_status !== 'void')
    .map((b): AttachCandidate => ({
      kind: 'bill',
      id: b.id,
      title: b.bill_no ? `Bill ${b.bill_no}` : 'Draft bill',
      detail: `${b.supplier_name} · ${displayDate(b.bill_date)} · ${BILL_STATE_LABELS[b.display_status]}`,
      amount: b.total,
      currency: b.currency,
      date: b.bill_date,
      locked: b.display_status !== 'draft',
    }));
  return [...fromExpenses, ...fromBills].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)));
}

const sen = (n: number) => Math.round(n * 100);

/**
 * True when the document's amount is the receipt's, to the sen. A receipt is ringgit, so a bill in another
 * currency is never the same amount, whatever its figure.
 */
export function sameAmount(candidate: AttachCandidate, receiptAmount: number | null): boolean {
  return candidate.currency === BASE_CURRENCY && receiptAmount !== null && sen(candidate.amount) === sen(receiptAmount);
}

/** How many candidates the picker lists at once; the rest are found by searching. */
export const ATTACH_LIST_MAX = 8;

/**
 * The candidates of one kind whose title, detail or amount contains the
 * search text, with those of the receipt's own amount first (the likeliest
 * match), each group newest first.
 */
export function filterAttachCandidates(
  candidates: AttachCandidate[],
  kind: 'expense' | 'bill',
  query: string,
  receiptAmount: number | null,
): AttachCandidate[] {
  const q = query.trim().toLowerCase();
  const kept = candidates.filter(
    (c) => c.kind === kind && `${c.title} ${c.detail} ${money(c.amount, c.currency)} ${c.amount.toFixed(2)}`.toLowerCase().includes(q),
  );
  return [...kept.filter((c) => sameAmount(c, receiptAmount)), ...kept.filter((c) => !sameAmount(c, receiptAmount))];
}

/** Said under the picker when the chosen document is locked and the person could not untie the receipt afterwards. */
export function attachLockNote(candidate: AttachCandidate | undefined, canDecide: boolean): string | null {
  if (!candidate || !candidate.locked || canDecide) return null;
  return candidate.kind === 'expense'
    ? 'This expense is approved: once the receipt is attached, only an owner or admin can untie it.'
    : 'This bill is posted: once the receipt is attached, only an owner or admin can untie it.';
}

/* ---- what the screen says after a match -------------------------------- */

/** What was just done to a receipt, kept so the screen can say so and tell whether its row is still drawn. */
export type MatchWritten =
  | { kind: 'expense'; receiptId: string; fileName: string; status: ExpenseStatus | null }
  | { kind: 'bill'; receiptId: string; fileName: string }
  | { kind: 'attached'; receiptId: string; fileName: string; title: string }
  | { kind: 'untied'; receiptId: string; fileName: string };

/**
 * The note's title and its sentence. It names the screen that shows what was
 * made and carries no link: the receipt components hold no `href` at all, so
 * that nothing in them can ever point the page at a stored file.
 */
export function matchNote(written: MatchWritten): { title: string; body: string } {
  if (written.kind === 'expense') {
    const body =
      written.status === 'approved'
        ? 'The expense was saved and approved, and the receipt is matched to it. It is on Expenses.'
        : written.status === 'pending'
          ? 'The expense was saved and waits for an owner or admin to approve it. The receipt is matched to it. It is on Expenses.'
          : 'The expense was saved and the receipt is matched to it. It is on Expenses.';
    return { title: 'Expense made from the receipt', body };
  }
  if (written.kind === 'bill') {
    return {
      title: 'Draft bill made from the receipt',
      body: 'The bill was saved as a draft and the receipt is matched to it. Nothing was posted: finish the draft on Supplier Bills, where an owner or admin posts it.',
    };
  }
  if (written.kind === 'attached') {
    return { title: 'Receipt attached', body: `The receipt is now matched to ${written.title}.` };
  }
  return { title: 'Receipt untied', body: 'The receipt is back under Unmatched. Its expense or bill was not changed.' };
}

/**
 * A sentence for when the receipt just matched or untied is not among the
 * rows on the screen, or null when it is, or when the list has not caught up
 * with it yet. `listed` is every receipt the screen has; `shown` is the rows drawn.
 */
export function matchHiddenNote(written: MatchWritten, listed: { id: string }[], shown: { id: string }[]): string | null {
  if (!listed.some((r) => r.id === written.receiptId) || shown.some((r) => r.id === written.receiptId)) return null;
  const where = written.kind === 'untied' ? 'Unmatched' : 'Matched';
  return `It is not in the rows below: choose ${where} or All receipts in the status filter, clear the search, or choose View all.`;
}

/* ---- what the inbox's screen reads and offers --------------------------- */

/**
 * What the Receipts Inbox screen reads and who is given what, worked out in one place so a test can pin it.
 * `canEdit` is the writer's menu, forms and picker: anyone who may edit data in a real workspace, never the
 * demo and never a viewer. `canDecide` only chooses what to offer (Untie from an approved expense or a posted
 * bill); the database decides again. With no receipt there is nothing to match, so no document is read.
 */
export function receiptInboxPlan(viewer: { role: OrgRole; isDemo: boolean }, hasReceipts: boolean) {
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  return {
    canEdit,
    canDecide: canEdit && can(viewer.role, 'sign-off-finance'),
    readsDocuments: hasReceipts,
    readsForms: hasReceipts && canEdit,
  };
}

/** What the forms and the picker are offered of the contacts: an archived contact is offered nowhere. */
export function offeredContacts<C extends { id: string; name: string; active: boolean; is_supplier: boolean }>(
  contacts: C[],
) {
  const active = contacts.filter((c) => c.active);
  return {
    contacts: active.map((c) => ({ id: c.id, name: c.name })),
    suppliers: active.filter((c) => c.is_supplier),
  };
}

/**
 * Expenses and Supplier Bills show a paperclip for each receipt tied to a row, but they must load without it:
 * a failed read of the inbox's view gives no paperclips, says so in the server log, and nothing else changes.
 */
export async function attachedReceiptsOrNone(
  read: () => Promise<AttachedReceipt[]>,
  log: (message: string, error: unknown) => void = console.error,
): Promise<AttachedReceipt[]> {
  try {
    return await read();
  } catch (error) {
    log('[finance] the receipts tied to documents could not be read:', error);
    return [];
  }
}
