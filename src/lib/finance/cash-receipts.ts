/**
 * Cash receipts: the writes of the Cash Receipts screen. A receipt is one
 * finance_transactions row with direction `in`. It is for one customer's
 * posted invoices, split across them, or for an income category, with an
 * amount of its own and a payer who is a contact, a typed name, or nobody.
 * It is saved as a draft (`finance_save_cash_receipt`), posted, which gives
 * it its RC- number (`finance_post_cash_receipt`), and after that only
 * voided; a draft is deleted. Posting and voiding need an owner or admin:
 * the database refuses anyone else with FIN14. org_id comes from the context.
 *
 * A payment recorded on Payments In is the same kind of row, posted at once
 * by `recordPaymentIn` in money.ts. The two sides of a transfer between
 * accounts are money in too and are not receipts: every write here that is
 * given an id asks the view `finance_cash_receipts` first and refuses
 * anything it does not show, without writing.
 */
import { z } from 'zod';
import { LINE_MESSAGES, isoDate, optionalText, ringgitAmount } from './document-lines';
import { PAYMENT_INVOICES_MAX, PAYMENT_METHODS } from './money';
import {
  type FinResult,
  type FinanceWriteContext,
  FIN_SIGN_OFF,
  NEEDS_SIGN_OFF,
  NOT_ALLOWED,
  PG_CHECK,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const CASH_RECEIPT_MESSAGES = {
  kind: 'Choose what this receipt is for: a customer’s invoices, or other income.',
  account: 'Choose the account the money went into.',
  date: LINE_MESSAGES.date,
  method: 'Choose how it was paid.',
  invoices: 'Choose at least one invoice this receipt is for.',
  tooManyInvoices: `One receipt can cover at most ${PAYMENT_INVOICES_MAX} invoices.`,
  duplicate: 'Each invoice can appear once on a receipt.',
  category: 'Choose an income category.',
  amount: 'Enter an amount above 0.',
  payer: 'Choose a contact or type a name, not both.',
  tooLong: LINE_MESSAGES.tooLong,
  gone: 'That receipt no longer exists.',
  // FIN03
  overSplit: 'The amounts against the invoices add up to more than the receipt.',
  // FIN04
  notPosted: 'A receipt can only go against a posted invoice.',
  // FIN05. A draft receipt holds its part of an invoice, so "still owed" is less what other drafts hold.
  tooMuch: 'That is more than is still owed on an invoice, counting what other receipts not yet posted already hold.',
  // FIN06: the invoices belong to two customers, or one of them is not in the workspace any more.
  oneCustomer: 'The invoices on one receipt must all be one customer’s, and must still exist.',
  // FIN09 from saving or posting. The menu offers Edit and Post on a draft only, so this reaches a person
  // when the receipt was posted, or posted and voided, in another tab.
  locked: 'This receipt has been posted or voided, so that can no longer be done.',
  // FIN09 from voiding: the receipt is a draft, or it was voided in another tab.
  cannotVoid: 'This receipt cannot be voided as it now stands: it has already been voided, or it is still a draft.',
  // FIN09 from deleting: it was posted, or posted and then voided, in another tab.
  cannotDelete: 'This receipt has been posted or voided, so it cannot be deleted.',
  // FIN15. The form sends invoices or a category, never both and never neither, so through the app this is a
  // category that is no longer an income category of the workspace, or a draft made elsewhere that is not
  // exactly its split when it is posted.
  shape: 'A receipt needs either invoices that add up to its amount, or an income category that still exists. Edit it and try again.',
  // 23503
  missing: 'The account, the contact or an invoice on this receipt no longer exists.',
  // 23514: a check constraint. The schema refuses everything that could meet one, so only a direct call does.
  invalid: 'Check the amount, the method and who it is from, then try again.',
} as const;

const M = CASH_RECEIPT_MESSAGES;

/** A required column was left empty. */
const PG_NOT_NULL = '23502';

const id = z.string({ error: M.gone }).uuid(M.gone);

/** A contact's id, or nobody chosen (null, or an empty string from a select). */
const optionalContact = z
  .union([z.string().uuid(M.payer), z.literal(''), z.null()], { error: M.payer })
  .transform((v) => (v === '' ? null : v))
  .default(null);

/** What both kinds of receipt carry. `id` is present when a draft is being changed. */
const shared = {
  id: id.optional(),
  account_id: z.string({ error: M.account }).uuid(M.account),
  txn_date: isoDate,
  method: z.enum(PAYMENT_METHODS, { error: M.method }),
  reference: optionalText.default(null),
  notes: optionalText.default(null),
};

/** True when no id is there twice. The database reads an id whatever its capitals, so they are compared without them. */
function eachOnce(ids: string[]): boolean {
  return new Set(ids.map((value) => value.toLowerCase())).size === ids.length;
}

/**
 * A draft cash receipt, new or being changed. `kind` says which of the two it
 * is; the database is not sent it, and tells them apart by whether there is a
 * split. A receipt for invoices has no amount of its own: it is the sum of
 * its split, and its payer is the invoices' customer.
 */
export const saveCashReceiptInput = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('invoice'),
      ...shared,
      allocations: z
        .array(
          z.object(
            { invoice_id: z.string({ error: M.invoices }).uuid(M.invoices), amount: ringgitAmount(M.amount) },
            { error: M.invoices },
          ),
          { error: M.invoices },
        )
        .min(1, M.invoices)
        .max(PAYMENT_INVOICES_MAX, M.tooManyInvoices)
        .refine((rows) => eachOnce(rows.map((r) => r.invoice_id)), M.duplicate),
    }),
    z
      .object({
        kind: z.literal('income'),
        ...shared,
        category_id: z.string({ error: M.category }).uuid(M.category),
        amount: ringgitAmount(M.amount),
        contact_id: optionalContact,
        party_name: optionalText.default(null),
      })
      .refine((v) => v.contact_id === null || v.party_name === null, { message: M.payer, path: ['party_name'] }),
  ],
  { error: M.kind },
);

export const cashReceiptIdInput = z.object({ id }, { error: M.gone });

export type SaveAndPostCashReceiptResult = FinResult<{ id: string; number: string }> & { draftId?: string };

const REFUSALS: Record<string, string> = {
  FIN03: M.overSplit,
  FIN04: M.notPosted,
  FIN05: M.tooMuch,
  FIN06: M.oneCustomer,
  FIN09: M.locked,
  FIN11: M.gone,
  FIN15: M.shape,
  [FIN_SIGN_OFF]: NEEDS_SIGN_OFF,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_CHECK]: M.invalid,
  // A required column was left out: the schema asks for every one, so only a direct call meets it.
  [PG_NOT_NULL]: M.invalid,
  // The same invoice twice on one receipt: the number comes from finance_next_number under a lock.
  [PG_UNIQUE]: M.duplicate,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};
// A clash from posting could only be on the receipt's number, never on an invoice appearing twice.
const POST_REFUSALS: Record<string, string> = Object.fromEntries(Object.entries(REFUSALS).filter(([code]) => code !== PG_UNIQUE));
const VOID_REFUSALS: Record<string, string> = { ...REFUSALS, FIN09: M.cannotVoid };
const DELETE_REFUSALS: Record<string, string> = { ...REFUSALS, FIN09: M.cannotDelete };

function receiptWriteFailed(
  fnName: string,
  error: unknown,
  refusals: Record<string, string> = REFUSALS,
): { ok: false; error: string } {
  const refusal = refusals[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

export type IncomeCategory = { id: string; name: string };

/** The workspace's active income categories, by name, for the receipt form. */
export async function listIncomeCategories(ctx: FinanceWriteContext): Promise<IncomeCategory[]> {
  const { data, error } = await ctx.client
    .from('finance_categories')
    .select('id,name')
    .eq('org_id', ctx.orgId)
    .eq('kind', 'income')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as IncomeCategory[];
}

/**
 * The transaction must be a receipt: money in that the cash receipts view
 * shows. One side of a transfer between accounts is money in too and is
 * never in that view. Anything it does not show is refused, without writing.
 */
async function refusalUnlessCashReceipt(
  ctx: FinanceWriteContext,
  fnName: string,
  txnId: string,
): Promise<{ ok: false; error: string } | null> {
  const { data, error } = await ctx.client
    .from('finance_cash_receipts')
    .select('transaction_id')
    .eq('org_id', ctx.orgId)
    .eq('transaction_id', txnId)
    .limit(1);
  if (error) return receiptWriteFailed(fnName, error);
  if (!data || data.length === 0) return { ok: false, error: M.gone };
  return null;
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft receipt, or replaces a draft's details and split. Nothing is posted and no number is taken. */
export async function saveCashReceipt(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveCashReceiptInput>,
): Promise<FinResult<{ id: string }>> {
  const parsed = saveCashReceiptInput.parse(input);
  if (parsed.id) {
    const refusal = await refusalUnlessCashReceipt(ctx, 'saveCashReceipt', parsed.id);
    if (refusal) return refusal;
  }
  const { id: draftId, account_id, txn_date, method, reference, notes } = parsed;
  const details = { ...(draftId ? { id: draftId } : {}), account_id, txn_date, method, reference, notes };
  // A receipt for invoices is sent no amount, payer or category: the database works them out from the split.
  const receipt =
    parsed.kind === 'invoice'
      ? details
      : {
          ...details,
          category_id: parsed.category_id,
          amount: parsed.amount,
          contact_id: parsed.contact_id,
          party_name: parsed.party_name,
        };
  const allocations = parsed.kind === 'invoice' ? parsed.allocations : [];
  const { data, error } = await ctx.client.rpc('finance_save_cash_receipt', {
    target_org: ctx.orgId,
    receipt,
    allocations,
  });
  if (error || !data) return receiptWriteFailed('saveCashReceipt', error);
  return { ok: true, data: { id: data as string } };
}

/** Posts a draft receipt: it gets its RC- number and is locked. An owner or admin only (FIN14 for anyone else). */
export async function postCashReceipt(
  ctx: FinanceWriteContext,
  input: z.input<typeof cashReceiptIdInput>,
): Promise<FinResult<{ id: string; number: string }>> {
  const { id: txnId } = cashReceiptIdInput.parse(input);
  const refusal = await refusalUnlessCashReceipt(ctx, 'postCashReceipt', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client.rpc('finance_post_cash_receipt', {
    target_org: ctx.orgId,
    target_txn: txnId,
  });
  if (error || !data) return receiptWriteFailed('postCashReceipt', error, POST_REFUSALS);
  return { ok: true, data: { id: txnId, number: data as string } };
}

/**
 * Voids a posted receipt of either kind: one status change on
 * finance_transactions, kept to money in. Invoices it paid owe that amount
 * again. An owner or admin only (FIN14 for anyone else).
 */
export async function voidCashReceipt(
  ctx: FinanceWriteContext,
  input: z.input<typeof cashReceiptIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = cashReceiptIdInput.parse(input);
  const refusal = await refusalUnlessCashReceipt(ctx, 'voidCashReceipt', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'in')
    .select('id')
    .maybeSingle();
  if (error) return receiptWriteFailed('voidCashReceipt', error, VOID_REFUSALS);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Deletes a draft receipt, and with it what it held of each invoice. A posted one is refused: void it. */
export async function deleteCashReceipt(
  ctx: FinanceWriteContext,
  input: z.input<typeof cashReceiptIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = cashReceiptIdInput.parse(input);
  const refusal = await refusalUnlessCashReceipt(ctx, 'deleteCashReceipt', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .delete()
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'in')
    .select('id')
    .maybeSingle();
  if (error) return receiptWriteFailed('deleteCashReceipt', error, DELETE_REFUSALS);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
