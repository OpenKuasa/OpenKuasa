/**
 * Refunds. A refund is money out to a customer: one finance_transactions row
 * with direction `out`, allocated to one invoice or to one credit note, with
 * a reason. It can be no more than the customer is in credit on that invoice.
 * Pending is a scheduled payment; refunded is a posted one, numbered PV- like
 * any other money out. A pending refund is marked paid or deleted; a refund
 * that was paid out can only be voided. These are the same database function,
 * update and delete a payment to a supplier uses, kept to money out and
 * worded for a refund. org_id comes from the context.
 *
 * A refund on an invoice in another currency, or on a credit note of one
 * (stage 3c), is paid from a ringgit account: the amount is in the invoice's
 * currency and `amount_myr` is the ringgit that left the account. The
 * database shares it over the split and works out what the invoice carried
 * and the realised gain or loss. It is paid out now, never scheduled (FIN47).
 */
import { z } from 'zod';
import { BASE_CURRENCY } from './currencies';
import { LINE_MESSAGES, isoDate, optionalText, ringgitAmount } from './document-lines';
import {
  PAYMENT_METHODS,
  PAYMENT_PAGE_SIZE,
  type PaymentInRow,
  type PaymentMethod,
  markPaymentPaidInput,
  paymentIdInput,
  ringgitTextInput,
} from './money';
import {
  type FinResult,
  type FinanceWriteContext,
  ACCOUNT_ARCHIVED,
  FIN_ACCOUNT_ARCHIVED,
  FIN_SIGN_OFF,
  NEEDS_SIGN_OFF,
  NOT_ALLOWED,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const REFUND_REASONS = ['order_cancelled', 'damaged_goods', 'wrong_item', 'overpayment', 'other'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const REFUND_REASON_LABELS: Record<RefundReason, string> = {
  order_cancelled: 'Order cancelled',
  damaged_goods: 'Damaged goods',
  wrong_item: 'Wrong item',
  overpayment: 'Overpayment',
  other: 'Other',
};

export const REFUND_MESSAGES = {
  document: 'Choose the invoice or the credit note this refund is for.',
  // FIN47. The refund form offers only "Pay out now" for an invoice in another currency, so this is met from a
  // direct call.
  payNow: 'A refund on an invoice in another currency is recorded as paid, on the day the money leaves.',
  // FIN46, and what the form says first: a refund on an invoice in another currency is paid in ringgit, and the
  // payment is the ringgit that left the account.
  ringgitPaidOut: 'Enter the ringgit that left the account.',
  // The finance assistant records refunds in ringgit only; it says this before the database is asked.
  foreignByAssistant: 'This invoice is not in ringgit. Record its refund on the Refunds screen.',
  account: 'Choose the account the money leaves.',
  date: LINE_MESSAGES.date,
  method: 'Choose how it was paid.',
  reason: 'Choose a reason.',
  amount: 'Enter an amount above 0.',
  tooLong: LINE_MESSAGES.tooLong,
  gone: 'That refund no longer exists.',
  // FIN04, when a refund is recorded: the customer is not in credit on the invoice, the invoice is not
  // posted, or the credit note is not issued. The form offers only what can be refunded, so this reaches a
  // person when that changed in another tab.
  notInCredit: 'A refund needs a posted invoice, or an issued credit note, whose customer is in credit.',
  // FIN05, when a refund is recorded: more than the customer's credit on the invoice, counting refunds
  // that are pending, or more than is left of the credit note.
  tooMuch: 'That is more than the customer is in credit, or more than is left of the credit note.',
  // FIN04, when a pending refund is paid out. Only markRefundPaid answers with it.
  cannotPayOut: 'This refund can no longer be paid out: its invoice is no longer posted, or its credit note is no longer issued. Delete it.',
  // FIN05, when a pending refund is paid out: the credit it was recorded against has gone since, most
  // often because the payment in behind it was voided. Only markRefundPaid answers with it. Nothing may be
  // left of the credit, so it does not say a new refund can be recorded, only when one can.
  creditGone:
    'This refund no longer fits in what the customer is in credit, or in what is left of its credit note, so it cannot be paid out. Delete it. If the customer is still in credit, a new refund can be recorded for no more than that.',
  // FIN06
  notFound: 'The invoice or credit note for this refund no longer exists.',
  // FIN09. A menu offers only what a refund's status allows, so this reaches a person only when the refund
  // changed in another tab: a pending one that was paid out meanwhile being marked paid or deleted, or a
  // paid one that was voided meanwhile being voided again. It says what may have happened, not what did,
  // so it reads sensibly from all three buttons and is not false of a pending refund voided by a direct call.
  locked: 'That cannot be done to this refund as it now stands. It may have been paid out or voided since this page was loaded.',
  missing: 'The account on this refund no longer exists.',
} as const;

const M = REFUND_MESSAGES;

/** An invoice's or a credit note's id, or nothing chosen (null, or an empty string from a select). */
const optionalDocument = z
  .union([z.string().uuid(M.document), z.literal(''), z.null()], { error: M.document })
  .transform((v) => (v === '' ? null : v))
  .default(null);

const refundBase = z.object({
  invoice_id: optionalDocument,
  credit_note_id: optionalDocument,
  account_id: z.string({ error: M.account }).uuid(M.account),
  txn_date: isoDate,
  method: z.enum(PAYMENT_METHODS, { error: M.method }),
  reason: z.enum(REFUND_REASONS, { error: M.reason }),
  /** In the invoice's currency (ringgit for a ringgit invoice). */
  amount: ringgitAmount(M.amount),
  reference: optionalText.default(null),
  notes: optionalText.default(null),
  /** True for a refund still to be paid out; it holds the customer's credit until it is marked paid or deleted. */
  scheduled: z.boolean().default(false),
  /**
   * For an invoice in another currency, or a credit note of one: the ringgit that left the account (every account
   * is ringgit until stage 5). Left out for a ringgit refund, whose payment is its amount. The database asks for
   * it when the invoice is foreign (FIN46), and pays such a refund out now (FIN47).
   */
  amount_myr: ringgitTextInput(M.ringgitPaidOut).optional(),
});

const oneDocument = (v: { invoice_id: string | null; credit_note_id: string | null }) =>
  (v.invoice_id === null) !== (v.credit_note_id === null);

/** Money out to a customer against one invoice or one credit note: paid out now, or pending. */
export const recordRefundInput = refundBase.refine(oneDocument, { message: M.document, path: ['invoice_id'] });

/** What the finance assistant may send: ringgit invoices only, so no ringgit-paid-out figure. */
export const recordRefundToolInput = refundBase
  .omit({ amount_myr: true })
  .refine(oneDocument, { message: M.document, path: ['invoice_id'] });

const REFUSALS: Record<string, string> = {
  FIN04: M.notInCredit,
  FIN05: M.tooMuch,
  FIN06: M.notFound,
  FIN09: M.locked,
  FIN11: M.gone,
  FIN46: M.ringgitPaidOut,
  FIN47: M.payNow,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [FIN_SIGN_OFF]: NEEDS_SIGN_OFF,
  // The account was archived after the form was opened or the draft was saved.
  [FIN_ACCOUNT_ARCHIVED]: ACCOUNT_ARCHIVED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

/**
 * Paying a pending refund out. The database looks at the credit again, and
 * the two codes then mean "this refund no longer fits", which a person fixes
 * by deleting it, not by typing a smaller amount.
 */
const PAY_OUT_REFUSALS: Record<string, string> = { ...REFUSALS, FIN04: M.cannotPayOut, FIN05: M.creditGone };

function refundWriteFailed(
  fnName: string,
  error: unknown,
  refusals: Record<string, string> = REFUSALS,
): { ok: false; error: string } {
  const refusal = refusals[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

/**
 * One refund. `allocation_id` is the row's key. `invoice_id` is the invoice
 * whichever way the refund was recorded; `credit_note_id` is set when it was
 * put against a credit note. A voided refund is included; callers filter.
 */
export type RefundRow = {
  allocation_id: string;
  transaction_id: string;
  number: string | null;
  txn_date: string;
  method: PaymentMethod;
  amount: number;
  transaction_amount: number;
  status: PaymentInRow['status'];
  reference: string | null;
  reason: RefundReason;
  notes: string | null;
  account_id: string;
  account_name: string;
  invoice_id: string;
  invoice_no: string | null;
  credit_note_id: string | null;
  credit_note_no: string | null;
  customer_id: string;
  customer_name: string;
  /**
   * The invoice's currency, which `amount` is in; `transaction_amount` is always ringgit. The reads always give
   * these four; they are optional so that rows made by hand (samples, tests) need not, and are then ringgit.
   */
  currency?: string;
  /** What this refund used of the ringgit paid out; `amount` for a ringgit invoice; null until a foreign one is settled. */
  amount_myr?: number | null;
  /** The ringgit the invoice carried for the part refunded; `amount` for a ringgit invoice. */
  carried_myr?: number | null;
  /** carried_myr − amount_myr: realised gain (above 0) or loss; 0 for a ringgit invoice. */
  realised_myr?: number | null;
};

/** What a refund adds to a ringgit figure: the ringgit paid out, which for a ringgit invoice is its amount. */
export function refundRinggit(row: Pick<RefundRow, 'amount' | 'currency' | 'amount_myr'>): number {
  if (row.amount_myr !== undefined && row.amount_myr !== null) return row.amount_myr;
  return (row.currency ?? BASE_CURRENCY) === BASE_CURRENCY ? row.amount : 0;
}

const REFUND_COLUMNS =
  'allocation_id,transaction_id,number,txn_date,method,amount,transaction_amount,status,reference,reason,notes,' +
  'account_id,account_name,invoice_id,invoice_no,credit_note_id,credit_note_no,customer_id,customer_name,' +
  'currency,amount_myr,carried_myr,realised_myr';

/** A numeric column as a number, keeping null. */
const numberOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Every refund in the workspace, newest first, read a page at a time. */
export async function listRefunds(ctx: FinanceWriteContext): Promise<RefundRow[]> {
  const rows: RefundRow[] = [];
  for (let from = 0; ; from += PAYMENT_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_refunds')
      .select(REFUND_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('txn_date', { ascending: false })
      .order('allocation_id', { ascending: true })
      .range(from, from + PAYMENT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((row) => ({
        ...(row as unknown as RefundRow),
        amount: Number(row.amount),
        transaction_amount: Number(row.transaction_amount),
        currency: (row.currency as string | undefined) ?? BASE_CURRENCY,
        amount_myr: numberOrNull(row.amount_myr),
        carried_myr: numberOrNull(row.carried_myr),
        realised_myr: numberOrNull(row.realised_myr),
      })),
    );
    if (page.length < PAYMENT_PAGE_SIZE) return rows;
  }
}

/**
 * The transaction must be a refund: money out to a customer, which the refunds
 * view shows. The writes below are kept to money out, but a payment to a
 * supplier is money out too, so they ask the view first and refuse anything it
 * does not show, without writing.
 */
async function refusalUnlessRefund(
  ctx: FinanceWriteContext,
  fnName: string,
  id: string,
): Promise<{ ok: false; error: string } | null> {
  const { data, error } = await ctx.client
    .from('finance_refunds')
    .select('transaction_id')
    .eq('org_id', ctx.orgId)
    .eq('transaction_id', id)
    .limit(1);
  if (error) return refundWriteFailed(fnName, error);
  if (!data || data.length === 0) return { ok: false, error: M.gone };
  return null;
}

/* ---- writes ----------------------------------------------------------- */

/**
 * Records a refund, paid out now or pending, against one invoice or one credit note. For an invoice in another
 * currency `amount_myr` is the ringgit that left the account, and the amount is in the invoice's currency.
 */
export async function recordRefund(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordRefundInput>,
): Promise<FinResult<{ id: string }>> {
  const { scheduled, amount_myr, ...rest } = recordRefundInput.parse(input);
  // The key is sent only when there is a figure: the database reads a missing key as "none".
  const refund = amount_myr === undefined ? rest : { ...rest, amount_myr };
  const { data, error } = await ctx.client.rpc('finance_record_refund', {
    target_org: ctx.orgId,
    refund: { ...refund, status: scheduled ? 'scheduled' : 'posted' },
  });
  if (error || !data) return refundWriteFailed('recordRefund', error);
  return { ok: true, data: { id: data as string } };
}

/**
 * The finance assistant's refund: ringgit invoices only. A refund on an invoice in another currency (or on a
 * credit note of one) needs the ringgit paid out, which the assistant does not send, so it is refused in its own
 * words before the database is asked.
 */
export async function recordRefundInRinggit(ctx: FinanceWriteContext, input: unknown): Promise<FinResult<{ id: string }>> {
  const parsed = recordRefundToolInput.parse(input);
  let invoiceId = parsed.invoice_id;
  if (parsed.credit_note_id !== null) {
    const { data, error } = await ctx.client
      .from('finance_credit_notes')
      .select('invoice_id')
      .eq('org_id', ctx.orgId)
      .eq('id', parsed.credit_note_id)
      .maybeSingle();
    if (error) return refundWriteFailed('recordRefundInRinggit', error);
    invoiceId = (data as { invoice_id?: string } | null)?.invoice_id ?? null;
  }
  if (invoiceId !== null) {
    const { data, error } = await ctx.client
      .from('finance_invoices')
      .select('currency')
      .eq('org_id', ctx.orgId)
      .eq('id', invoiceId)
      .maybeSingle();
    if (error) return refundWriteFailed('recordRefundInRinggit', error);
    const currency = (data as { currency?: string } | null)?.currency;
    if (currency !== undefined && currency !== BASE_CURRENCY) return { ok: false, error: M.foreignByAssistant };
  }
  return recordRefund(ctx, parsed);
}

/**
 * A pending refund has now been paid out: it gets its PV- number and the
 * invoice shows it. The database looks at the customer's credit once more,
 * and refuses if it has gone since the refund was recorded.
 */
export async function markRefundPaid(
  ctx: FinanceWriteContext,
  input: z.input<typeof markPaymentPaidInput>,
): Promise<FinResult<{ id: string; number: string }>> {
  const { id, paid_on } = markPaymentPaidInput.parse(input);
  const refusal = await refusalUnlessRefund(ctx, 'markRefundPaid', id);
  if (refusal) return refusal;
  const { data, error } = await ctx.client.rpc('finance_mark_payment_paid', {
    target_org: ctx.orgId,
    target_txn: id,
    paid_on,
  });
  if (error || !data) return refundWriteFailed('markRefundPaid', error, PAY_OUT_REFUSALS);
  return { ok: true, data: { id, number: data as string } };
}

/** Voids a refund that was paid out: the customer is in credit by that amount again. */
export async function voidRefund(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = paymentIdInput.parse(input);
  const refusal = await refusalUnlessRefund(ctx, 'voidRefund', id);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .select('id')
    .maybeSingle();
  if (error) return refundWriteFailed('voidRefund', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Deletes a pending refund. One that was paid out is refused: void it. */
export async function deleteRefund(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = paymentIdInput.parse(input);
  const refusal = await refusalUnlessRefund(ctx, 'deleteRefund', id);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .select('id')
    .maybeSingle();
  if (error) return refundWriteFailed('deleteRefund', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
