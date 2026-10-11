/**
 * Money moving in and out. Each movement is one finance_transactions row,
 * split across the documents it pays by finance_allocations: a payment out
 * against one supplier's bills, or a payment in against one customer's
 * invoices. A posted payment is locked and can only be voided; a scheduled
 * payment out can be deleted. Money in is never scheduled: it is recorded
 * once it has arrived.
 */
import { z } from 'zod';
import { isIsoDate } from './bills';
import {
  type FinResult,
  type FinanceWriteContext,
  FIN_SIGN_OFF,
  NEEDS_SIGN_OFF,
  NOT_ALLOWED,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const PAYMENT_METHODS = ['bank_transfer', 'fpx', 'duitnow', 'card', 'ewallet', 'cash', 'cheque'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: 'Bank Transfer',
  fpx: 'FPX',
  duitnow: 'DuitNow',
  card: 'Card',
  ewallet: 'E-Wallet',
  cash: 'Cash',
  cheque: 'Cheque',
};

export const PAYMENT_BILLS_MAX = 50;
export const PAYMENT_INVOICES_MAX = 50;
export const PAYMENT_PAGE_SIZE = 1000;

export const MONEY_MESSAGES = {
  account: 'Choose the account the money leaves.',
  date: 'Enter a valid date.',
  method: 'Choose how it was paid.',
  bills: 'Choose at least one bill to pay.',
  tooManyBills: `One payment can cover at most ${PAYMENT_BILLS_MAX} bills.`,
  amount: 'Enter an amount above 0.',
  duplicate: 'Each bill can appear once on a payment.',
  tooLong: 'That is too long. Keep it to 200 characters or fewer.',
  gone: 'That payment no longer exists.',
  overSplit: 'The amounts against the bills add up to more than the payment.',
  notPosted: 'A payment can only go against a posted bill.',
  tooMuch: 'That is more than is still owed on a bill.',
  oneSupplier: 'One payment can only pay bills from one supplier.',
  locked: 'This payment is posted and can no longer be changed. Void it instead.',
  missing: 'The account or a bill on this payment no longer exists.',
} as const;

const M = MONEY_MESSAGES;

/** The sentences of a payment in. Where a payment out says the same thing, it is the same sentence. */
export const RECEIPT_MESSAGES = {
  account: 'Choose the account the money went into.',
  date: M.date,
  method: M.method,
  invoices: 'Choose at least one invoice this payment is for.',
  tooManyInvoices: `One payment can cover at most ${PAYMENT_INVOICES_MAX} invoices.`,
  amount: M.amount,
  duplicate: 'Each invoice can appear once on a payment.',
  tooLong: M.tooLong,
  gone: M.gone,
  overSplit: 'The amounts against the invoices add up to more than the payment.',
  notPosted: 'A payment can only go against a posted invoice.',
  tooMuch: 'That is more than is still owed on an invoice.',
  oneCustomer: 'One payment can only pay invoices from one customer.',
  // FIN09. Money in is posted at once and has no edit or delete, so through the app this is only ever
  // a second attempt to void a payment someone has already voided.
  locked: 'This payment has already been voided.',
  missing: 'The account or an invoice on this payment no longer exists.',
} as const;

const R = RECEIPT_MESSAGES;

const date = z.string({ error: M.date }).refine(isIsoDate, M.date);
const text = z
  .string({ error: M.tooLong })
  .trim()
  .max(200, M.tooLong)
  .transform((v) => (v === '' ? null : v))
  .nullable();
const amount = z
  .number({ error: M.amount })
  .transform((v) => Math.round(v * 100) / 100)
  .pipe(z.number().gt(0, M.amount).max(999_999_999_999.99, M.amount));
const id = z.string({ error: M.gone }).uuid(M.gone);

/** True when no id is there twice. The database reads an id whatever its capitals, so they are compared without them. */
function eachOnce(ids: string[]): boolean {
  return new Set(ids.map((value) => value.toLowerCase())).size === ids.length;
}

export const recordPaymentOutInput = z.object({
  account_id: z.string({ error: M.account }).uuid(M.account),
  txn_date: date,
  method: z.enum(PAYMENT_METHODS, { error: M.method }),
  reference: text.default(null),
  notes: text.default(null),
  /** True for a payment to be made later; it does not reduce the bill until marked paid. */
  scheduled: z.boolean().default(false),
  allocations: z
    .array(z.object({ bill_id: z.string({ error: M.bills }).uuid(M.bills), amount }), { error: M.bills })
    .min(1, M.bills)
    .max(PAYMENT_BILLS_MAX, M.tooManyBills)
    .refine((rows) => eachOnce(rows.map((r) => r.bill_id)), M.duplicate),
});

/** Money received from one customer, split across that customer's posted invoices. It is posted at once. */
export const recordPaymentInInput = z.object({
  account_id: z.string({ error: R.account }).uuid(R.account),
  txn_date: date,
  method: z.enum(PAYMENT_METHODS, { error: R.method }),
  reference: text.default(null),
  notes: text.default(null),
  allocations: z
    .array(z.object({ invoice_id: z.string({ error: R.invoices }).uuid(R.invoices), amount }), { error: R.invoices })
    .min(1, R.invoices)
    .max(PAYMENT_INVOICES_MAX, R.tooManyInvoices)
    .refine((rows) => eachOnce(rows.map((r) => r.invoice_id)), R.duplicate),
});

export const markPaymentPaidInput = z.object({ id, paid_on: date });
export const paymentIdInput = z.object({ id });

const REFUSALS: Record<string, string> = {
  FIN03: M.overSplit,
  FIN04: M.notPosted,
  FIN05: M.tooMuch,
  FIN06: M.oneSupplier,
  FIN09: M.locked,
  FIN11: M.gone,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [FIN_SIGN_OFF]: NEEDS_SIGN_OFF,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

/**
 * Recording a payment out. A unique violation here can only be the same bill
 * twice on one payment: the number comes from finance_next_number under a
 * lock. Marking a payment paid or voiding it keeps the plain map.
 */
const RECORD_OUT_REFUSALS: Record<string, string> = { ...REFUSALS, [PG_UNIQUE]: M.duplicate };

/** The same database codes, worded for money in: the documents are invoices and the party is a customer. */
const RECEIPT_REFUSALS: Record<string, string> = {
  ...REFUSALS,
  FIN03: R.overSplit,
  FIN04: R.notPosted,
  FIN05: R.tooMuch,
  FIN06: R.oneCustomer,
  FIN09: R.locked,
  [PG_FOREIGN_KEY]: R.missing,
  // The same invoice twice on one payment; see RECORD_OUT_REFUSALS.
  [PG_UNIQUE]: R.duplicate,
};

function moneyWriteFailed(
  fnName: string,
  error: unknown,
  refusals: Record<string, string> = REFUSALS,
): { ok: false; error: string } {
  const refusal = refusals[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

export type FinanceAccount = { id: string; name: string; kind: 'bank' | 'cash'; bank_name: string | null };

/** The workspace's active accounts, for the "paid from" picker. */
export async function listAccounts(ctx: FinanceWriteContext): Promise<FinanceAccount[]> {
  const { data, error } = await ctx.client
    .from('finance_accounts')
    .select('id,name,kind,bank_name')
    .eq('org_id', ctx.orgId)
    .eq('active', true)
    .order('kind', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as FinanceAccount[];
}

type TransactionStatus = 'draft' | 'pending_approval' | 'scheduled' | 'posted' | 'rejected' | 'void';

/** One row per bill a payment out pays. A voided payment is included; callers filter. */
export type PaymentOutRow = {
  allocation_id: string;
  transaction_id: string;
  number: string | null;
  txn_date: string;
  method: PaymentMethod;
  amount: number;
  transaction_amount: number;
  status: TransactionStatus;
  reference: string | null;
  account_id: string;
  account_name: string;
  bill_id: string;
  bill_no: string | null;
  supplier_name: string;
};

/**
 * One row per invoice a payment in pays. `allocation_id` is the row's key: a
 * payment split across invoices is several rows with one `transaction_id`,
 * whose amounts add up to `transaction_amount`. A voided payment is included;
 * callers filter.
 */
export type PaymentInRow = {
  allocation_id: string;
  transaction_id: string;
  number: string | null;
  txn_date: string;
  method: PaymentMethod;
  amount: number;
  transaction_amount: number;
  status: TransactionStatus;
  reference: string | null;
  account_id: string;
  account_name: string;
  invoice_id: string;
  invoice_no: string | null;
  customer_name: string;
};

const PAYMENT_COLUMNS =
  'allocation_id,transaction_id,number,txn_date,method,amount,transaction_amount,status,reference,account_id,account_name';
const PAYMENT_OUT_COLUMNS = `${PAYMENT_COLUMNS},bill_id,bill_no,supplier_name`;
const PAYMENT_IN_COLUMNS = `${PAYMENT_COLUMNS},invoice_id,invoice_no,customer_name`;

/** Every row of one of the two payment views, newest first, read a page at a time. */
async function listPaymentRows<T extends { amount: number; transaction_amount: number }>(
  ctx: FinanceWriteContext,
  view: 'finance_payments_out' | 'finance_payments_in',
  columns: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAYMENT_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from(view)
      .select(columns)
      .eq('org_id', ctx.orgId)
      .order('txn_date', { ascending: false })
      .order('allocation_id', { ascending: true })
      .range(from, from + PAYMENT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((r) => ({
        ...(r as unknown as T),
        amount: Number(r.amount),
        transaction_amount: Number(r.transaction_amount),
      })),
    );
    if (page.length < PAYMENT_PAGE_SIZE) return rows;
  }
}

export async function listPaymentsOut(ctx: FinanceWriteContext): Promise<PaymentOutRow[]> {
  return listPaymentRows<PaymentOutRow>(ctx, 'finance_payments_out', PAYMENT_OUT_COLUMNS);
}

export async function listPaymentsIn(ctx: FinanceWriteContext): Promise<PaymentInRow[]> {
  return listPaymentRows<PaymentInRow>(ctx, 'finance_payments_in', PAYMENT_IN_COLUMNS);
}

/**
 * The transaction must be a payment to a supplier: money out against a bill,
 * which the payments-out view shows. A refund is money out too, and it is
 * never in that view, which joins each allocation to its bill. The three
 * writes below ask the view first and refuse anything it does not show,
 * without writing. A refund has its own writes, in refunds.ts, which ask the
 * refunds view the same way. One row is asked for: a payment split across
 * bills is several rows there.
 */
async function refusalUnlessPaymentOut(
  ctx: FinanceWriteContext,
  fnName: string,
  txnId: string,
): Promise<{ ok: false; error: string } | null> {
  const { data, error } = await ctx.client
    .from('finance_payments_out')
    .select('transaction_id')
    .eq('org_id', ctx.orgId)
    .eq('transaction_id', txnId)
    .limit(1);
  if (error) return moneyWriteFailed(fnName, error);
  if (!data || data.length === 0) return { ok: false, error: M.gone };
  return null;
}

/**
 * The transaction must be a payment against invoices, which the payments-in
 * view shows. Money in can also be a receipt for income that settles no
 * invoice; that is on Cash Receipts and never in this view, which joins each
 * allocation to its invoice. Voiding a payment in asks the view first and
 * refuses anything it does not show, without writing. One row is asked for: a
 * payment split across invoices is several rows there.
 */
async function refusalUnlessPaymentIn(
  ctx: FinanceWriteContext,
  fnName: string,
  txnId: string,
): Promise<{ ok: false; error: string } | null> {
  const { data, error } = await ctx.client
    .from('finance_payments_in')
    .select('transaction_id')
    .eq('org_id', ctx.orgId)
    .eq('transaction_id', txnId)
    .limit(1);
  if (error) return moneyWriteFailed(fnName, error, RECEIPT_REFUSALS);
  if (!data || data.length === 0) return { ok: false, error: R.gone };
  return null;
}

/* ---- writes ----------------------------------------------------------- */

/** Records a payment out, paid now or scheduled, split across one supplier's bills. */
export async function recordPaymentOut(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordPaymentOutInput>,
): Promise<FinResult<{ id: string }>> {
  const { allocations, scheduled, ...payment } = recordPaymentOutInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_record_payment_out', {
    target_org: ctx.orgId,
    payment: { ...payment, status: scheduled ? 'scheduled' : 'posted' },
    allocations,
  });
  if (error || !data) return moneyWriteFailed('recordPaymentOut', error, RECORD_OUT_REFUSALS);
  return { ok: true, data: { id: data as string } };
}

/** Records money received from one customer, split across that customer's posted invoices. It is posted at once. */
export async function recordPaymentIn(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordPaymentInInput>,
): Promise<FinResult<{ id: string }>> {
  const { allocations, ...payment } = recordPaymentInInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_record_payment_in', {
    target_org: ctx.orgId,
    payment,
    allocations,
  });
  if (error || !data) return moneyWriteFailed('recordPaymentIn', error, RECEIPT_REFUSALS);
  return { ok: true, data: { id: data as string } };
}

/** A scheduled payment has now been made: it gets its number and reduces the bill. */
export async function markPaymentPaid(
  ctx: FinanceWriteContext,
  input: z.input<typeof markPaymentPaidInput>,
): Promise<FinResult<{ id: string; number: string }>> {
  const { id: txnId, paid_on } = markPaymentPaidInput.parse(input);
  const refusal = await refusalUnlessPaymentOut(ctx, 'markPaymentPaid', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client.rpc('finance_mark_payment_paid', {
    target_org: ctx.orgId,
    target_txn: txnId,
    paid_on,
  });
  if (error || !data) return moneyWriteFailed('markPaymentPaid', error);
  return { ok: true, data: { id: txnId, number: data as string } };
}

/**
 * Voids a posted payment to a supplier: one status change on
 * finance_transactions, kept to money out. The bills it paid owe that amount
 * again. Anything the payments-out view does not show is refused first.
 */
export async function voidPayment(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = paymentIdInput.parse(input);
  const refusal = await refusalUnlessPaymentOut(ctx, 'voidPayment', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .select('id')
    .maybeSingle();
  if (error) return moneyWriteFailed('voidPayment', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/**
 * Voids a payment in: the same status change, kept to money in and worded
 * for it. The invoices it paid owe that amount again. There is no delete and
 * no edit: money in is posted the moment it is recorded. Anything the
 * payments-in view does not show is refused first.
 */
export async function voidPaymentIn(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = paymentIdInput.parse(input);
  const refusal = await refusalUnlessPaymentIn(ctx, 'voidPaymentIn', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'in')
    .select('id')
    .maybeSingle();
  if (error) return moneyWriteFailed('voidPaymentIn', error, RECEIPT_REFUSALS);
  if (!data) return { ok: false, error: R.gone };
  return { ok: true, data: { id: data.id } };
}

/**
 * Deletes a payment to a supplier that has not been made yet. A paid one is
 * refused: void it. Anything the payments-out view does not show is refused
 * first.
 */
export async function deleteScheduledPayment(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = paymentIdInput.parse(input);
  const refusal = await refusalUnlessPaymentOut(ctx, 'deleteScheduledPayment', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .delete()
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .select('id')
    .maybeSingle();
  if (error) return moneyWriteFailed('deleteScheduledPayment', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
