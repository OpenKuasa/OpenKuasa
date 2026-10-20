/**
 * Money moving in and out. Each movement is one finance_transactions row,
 * split across the documents it pays by finance_allocations: a payment out
 * against one supplier's bills, or a payment in against one customer's
 * invoices. A posted payment is locked and can only be voided; a scheduled
 * payment out can be deleted. Money in is never scheduled: it is recorded
 * once it has arrived.
 *
 * Stage 5b: money may move on an account in another currency, in that currency, paid now, for documents in that
 * currency, with the movement's rate (movement-rate.ts). The database puts it into ringgit at the rate.
 */
import { z } from 'zod';
import { isIsoDate } from './bills';
import { BASE_CURRENCY } from './currencies';
import { MOVEMENT_MESSAGES, movementRateFields, movementRateKeys } from './movement-rate';
import {
  type FinResult,
  type FinanceWriteContext,
  ACCOUNT_ARCHIVED,
  FIN_ACCOUNT_ARCHIVED,
  FIN_FOREIGN_ACCOUNT,
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
  // FIN44: one payment's split names documents in two currencies. The payment form offers one currency's bills at a
  // time (the first ticked sets it), so this is met from a direct call.
  oneCurrency: 'One payment can only settle bills in one currency. Record a separate payment for each currency.',
  // FIN46, and what the form says first (stage 4b): a bill in another currency is paid from a ringgit account,
  // and the payment is the ringgit that left it.
  ringgitPaidOut: 'Enter the ringgit that left the account.',
  // FIN47 (stage 4b): a payment of a bill in another currency asked as scheduled. The form offers only paying now
  // for one, so this is met from a direct call.
  payNow: 'A payment of a bill in another currency is recorded as paid, on the day the money leaves.',
  // The finance assistant records payments out in ringgit only; it says this before the database is asked.
  foreignBillByAssistant: 'This bill is not in ringgit. Record its payment on the Payments Out screen.',
  // FIN50 (narrowed in stage 5b): a draft on an account in another currency, or one moved onto it. Payments are
  // recorded paid there, with their rate; the draft forms list ringgit accounts.
  foreignAccount: MOVEMENT_MESSAGES.draft,
  // FIN38, FIN39 and FIN47 on an account in another currency (stage 5b): the form says the first and the last first.
  rate: MOVEMENT_MESSAGES.rate,
  notBnmRate: MOVEMENT_MESSAGES.notBnmRate,
  payNowAccount: MOVEMENT_MESSAGES.payNow,
  // FIN51 (stage 5b): the form offers only the account's currency's bills, so this is met from a direct call.
  foreignAccountBills: 'Money out of an account in another currency can only pay bills in that currency.',
  // The finance assistant moves money on ringgit accounts only; it says this before the database is asked.
  foreignAccountByAssistant: 'This account is not in ringgit. Record this on the screen, where its currency and rate are shown.',
} as const;

const M = MONEY_MESSAGES;

/** The sentences of a payment in. Where a payment out says the same thing, it is the same sentence. */
export const RECEIPT_MESSAGES = {
  account: 'Choose the account the money went into.',
  // FIN44. The payment form offers one currency's invoices at a time (the first ticked sets it), so this is met
  // from a direct call.
  oneCurrency: 'One payment can only settle invoices in one currency. Record a separate payment for each currency.',
  // FIN46, and what the form says first: an invoice in another currency is paid in ringgit, and the payment is
  // the ringgit that arrived.
  ringgitReceived: 'Enter the ringgit that arrived in the account.',
  // FIN48, when a payment in on an invoice in another currency is voided while a credit note issued after it
  // stands on that invoice (stage 3c): the credit note's ringgit was worked out against what the payment left.
  creditNoteAfter:
    'A credit note on this invoice was issued after this payment. Void the credit note first, then the payment; issue the credit note again after.',
  // The finance assistant records payments in ringgit only; it says this before the database is asked.
  foreignByAssistant: 'This invoice is not in ringgit. Record its payment on the Invoices screen.',
  // FIN51 (stage 5b): the form offers only the account's currency's invoices, so this is met from a direct call.
  foreignAccountInvoices: 'Money into an account in another currency can only pay invoices in that currency.',
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
  // FIN09 from voiding. A payment recorded on Payments In is posted at once and its row offers Void only
  // while it is posted, so through the app this is a second attempt to void a payment someone has already
  // voided. A draft receipt against invoices (made on Cash Receipts, where it is posted or deleted) is on
  // Payments In too, with nothing offered; sent here by a direct call it gets the same code.
  locked: 'This payment cannot be voided as it now stands: it has already been voided, or it is still a draft.',
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

const paymentOutBase = z.object({
  account_id: z.string({ error: M.account }).uuid(M.account),
  txn_date: date,
  method: z.enum(PAYMENT_METHODS, { error: M.method }),
  reference: text.default(null),
  notes: text.default(null),
  /** True for a payment to be made later; it does not reduce the bill until marked paid. */
  scheduled: z.boolean().default(false),
  /**
   * For bills in another currency (stage 4b): the ringgit that left the account (every account is ringgit until
   * stage 5); the amounts below are then in the bills' currency, and the payment is paid now (FIN47). Left out for
   * ringgit bills, whose payment is the sum of its split. The database asks for it when a bill is foreign (FIN46).
   */
  amount_myr: ringgitTextInput(M.ringgitPaidOut).optional(),
  /**
   * Stage 5b: on an account in another currency, the movement's rate (per one unit, exact text), BNM's with its
   * date or typed. The payment is then in the account's currency, the sum of its split, and paid now.
   */
  ...movementRateFields,
  allocations: z
    .array(z.object({ bill_id: z.string({ error: M.bills }).uuid(M.bills), amount }), { error: M.bills })
    .min(1, M.bills)
    .max(PAYMENT_BILLS_MAX, M.tooManyBills)
    .refine((rows) => eachOnce(rows.map((r) => r.bill_id)), M.duplicate),
});

/** A payment to one supplier, split across that supplier's posted bills, paid now or scheduled. */
export const recordPaymentOutInput = paymentOutBase;

/** What the finance assistant may send: ringgit bills on a ringgit account only, so no ringgit-paid-out figure or rate. */
export const recordPaymentOutToolInput = paymentOutBase.omit({
  amount_myr: true,
  fx_rate: true,
  fx_rate_source: true,
  fx_rate_date: true,
});

/**
 * A ringgit figure (what arrived, or what left: a refund in stage 3c), as decimal text with at most two places
 * ("2883.50"), so no float stands between the box and the database. Above 0.
 */
export function ringgitTextInput(message: string) {
  return z
    .string({ error: message })
    .trim()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, message)
    .refine((v) => /[1-9]/.test(v), message);
}

const ringgitText = ringgitTextInput(R.ringgitReceived);

const paymentInBase = z.object({
  account_id: z.string({ error: R.account }).uuid(R.account),
  txn_date: date,
  method: z.enum(PAYMENT_METHODS, { error: R.method }),
  reference: text.default(null),
  notes: text.default(null),
  /**
   * For invoices in another currency: the ringgit that arrived in the account (every account is ringgit until
   * stage 5); the amounts below are then in the invoices' currency. Left out for ringgit invoices, whose
   * payment is the sum of its split. The database asks for it when an invoice is foreign (FIN46).
   */
  amount_myr: ringgitText.optional(),
  /** Stage 5b: on an account in another currency, the movement's rate; the payment is then its split, in that currency. */
  ...movementRateFields,
  allocations: z
    .array(z.object({ invoice_id: z.string({ error: R.invoices }).uuid(R.invoices), amount }), { error: R.invoices })
    .min(1, R.invoices)
    .max(PAYMENT_INVOICES_MAX, R.tooManyInvoices)
    .refine((rows) => eachOnce(rows.map((r) => r.invoice_id)), R.duplicate),
});

/** Money received from one customer, split across that customer's posted invoices. It is posted at once. */
export const recordPaymentInInput = paymentInBase;

/** What the finance assistant may send: ringgit invoices into a ringgit account only, so no ringgit-received figure or rate. */
export const recordPaymentInToolInput = paymentInBase.omit({
  amount_myr: true,
  fx_rate: true,
  fx_rate_source: true,
  fx_rate_date: true,
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
  // The account was archived after the form was opened or the draft was saved.
  [FIN_ACCOUNT_ARCHIVED]: ACCOUNT_ARCHIVED,
  // Stage 5b: on an account in another currency. FIN50 is a draft there (a stale tab or a direct call); FIN38 a
  // movement there with no rate; FIN39 a rate marked BNM's that is not its figure for the day.
  [FIN_FOREIGN_ACCOUNT]: M.foreignAccount,
  FIN38: M.rate,
  FIN39: M.notBnmRate,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

/**
 * Recording a payment out. A unique violation here can only be the same bill
 * twice on one payment: the number comes from finance_next_number under a
 * lock. Marking a payment paid or voiding it keeps the plain map.
 */
const RECORD_OUT_REFUSALS: Record<string, string> = {
  ...REFUSALS,
  [PG_UNIQUE]: M.duplicate,
  FIN44: M.oneCurrency,
  FIN46: M.ringgitPaidOut,
  FIN47: M.payNow,
  FIN51: M.foreignAccountBills,
};

/** A payment out on an account in another currency (stage 5b): FIN47 is that account's "paid now", not a bill's. */
const RECORD_OUT_ACCOUNT_REFUSALS: Record<string, string> = { ...RECORD_OUT_REFUSALS, FIN47: M.payNowAccount };

/** The same database codes, worded for money in: the documents are invoices and the party is a customer. */
const RECEIPT_REFUSALS: Record<string, string> = {
  ...REFUSALS,
  FIN03: R.overSplit,
  FIN04: R.notPosted,
  FIN05: R.tooMuch,
  FIN06: R.oneCustomer,
  FIN09: R.locked,
  FIN44: R.oneCurrency,
  FIN46: R.ringgitReceived,
  FIN48: R.creditNoteAfter,
  FIN51: R.foreignAccountInvoices,
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

/** An active bank or cash account. `currency` is the one it was added in (stage 5a): MYR for ringgit. */
export type FinanceAccount = { id: string; name: string; kind: 'bank' | 'cash'; bank_name: string | null; currency: string };

/** The workspace's active accounts, each with its currency. */
export async function listAccounts(ctx: FinanceWriteContext): Promise<FinanceAccount[]> {
  const { data, error } = await ctx.client
    .from('finance_accounts')
    .select('id,name,kind,bank_name,currency')
    .eq('org_id', ctx.orgId)
    .eq('active', true)
    .order('kind', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as FinanceAccount[]).map((a) => ({ ...a, currency: a.currency ?? BASE_CURRENCY }));
}

/**
 * The accounts a form that moves ringgit only may offer: the expense payment, the transfer form, and the draft
 * forms (stage 5b: a draft on an account in another currency is FIN50).
 */
export function ringgitAccounts<A extends { currency: string }>(accounts: A[]): A[] {
  return accounts.filter((a) => a.currency === BASE_CURRENCY);
}

/** The workspace's active ringgit accounts, for the pickers of the forms that move ringgit only. */
export async function listRinggitAccounts(ctx: FinanceWriteContext): Promise<FinanceAccount[]> {
  return ringgitAccounts(await listAccounts(ctx));
}

/**
 * The assistant's refusal of a payment on an account in another currency, read before the database is asked;
 * null when the account is in ringgit or is not the workspace's (the database answers that one).
 */
export async function foreignAccountRefusal(
  ctx: FinanceWriteContext,
  accountId: string,
  fnName: string,
  refusals: Record<string, string>,
): Promise<{ ok: false; error: string } | null> {
  const { data, error } = await ctx.client
    .from('finance_accounts')
    .select('id,currency')
    .eq('org_id', ctx.orgId)
    .eq('id', accountId)
    .maybeSingle();
  if (error) return moneyWriteFailed(fnName, error, refusals);
  const code = (data as { currency?: string } | null)?.currency;
  return code !== undefined && code !== BASE_CURRENCY ? { ok: false, error: M.foreignAccountByAssistant } : null;
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
  /**
   * The bill's currency, which `amount` is in. `transaction_amount` is in the account's currency,
   * `transaction_currency` (ringgit until stage 5b put money on accounts in other currencies), and
   * `transaction_amount_myr` is the whole movement in ringgit. The reads always give these; they are optional so
   * that rows made by hand (samples, tests) need not, and are then ringgit.
   */
  currency?: string;
  /** What this row used of the ringgit paid out; `amount` for a ringgit bill; null until a foreign split is settled. */
  amount_myr?: number | null;
  /** The ringgit the bill carried for the part paid; `amount` for a ringgit bill. */
  carried_myr?: number | null;
  /** carried_myr − amount_myr: realised gain (above 0) or loss; 0 for a ringgit bill. */
  realised_myr?: number | null;
  /** The account's currency, which `transaction_amount` is in (stage 5b). */
  transaction_currency?: string;
  /** The whole movement in ringgit: `transaction_amount` on a ringgit account. */
  transaction_amount_myr?: number;
};

/**
 * What a payment out paid of one bill, in ringgit: the amount for a ringgit bill, its share of the ringgit paid out
 * otherwise (0 until a foreign split is settled, which a posted one always is).
 */
export function paymentOutRinggit(row: Pick<PaymentOutRow, 'amount' | 'currency' | 'amount_myr'>): number {
  return (row.currency ?? 'MYR') === 'MYR' ? row.amount : (row.amount_myr ?? 0);
}

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
  /**
   * The invoice's currency, which `amount` is in. `transaction_amount` is in the account's currency,
   * `transaction_currency` (stage 5b), and `transaction_amount_myr` is the whole movement in ringgit. The reads
   * always give these; they are optional so that rows made by hand (samples, tests) need not, and are then ringgit.
   */
  currency?: string;
  /** What this row used of the ringgit received; `amount` for a ringgit invoice; null until a foreign split is settled. */
  amount_myr?: number | null;
  /** The ringgit the invoice carried for the part paid; `amount` for a ringgit invoice. */
  carried_myr?: number | null;
  /** amount_myr − carried_myr: realised gain (above 0) or loss; 0 for a ringgit invoice. */
  realised_myr?: number | null;
  /** The account's currency, which `transaction_amount` is in (stage 5b). */
  transaction_currency?: string;
  /** The whole movement in ringgit: `transaction_amount` on a ringgit account. */
  transaction_amount_myr?: number;
};

/** What a payment-in row adds to a ringgit figure: its ringgit, which for a ringgit invoice is its amount. */
export function paymentInRinggit(row: Pick<PaymentInRow, 'amount' | 'currency' | 'amount_myr'>): number {
  if (row.amount_myr !== undefined && row.amount_myr !== null) return row.amount_myr;
  return (row.currency ?? 'MYR') === 'MYR' ? row.amount : 0;
}

/**
 * The ringgit that actually arrived for each invoice: the sum, in whole sen, of its posted payments' ringgit
 * (`paymentInRinggit`). This is Bendahara's "received", which for a foreign invoice differs from what the
 * payments carried off the invoice (`paid_myr`); the balance still counts the carried amount.
 */
export function receivedRinggitByInvoice(rows: PaymentInRow[]): Map<string, number> {
  const sen = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== 'posted') continue;
    sen.set(row.invoice_id, (sen.get(row.invoice_id) ?? 0) + Math.round(paymentInRinggit(row) * 100));
  }
  return new Map([...sen].map(([id, s]) => [id, s / 100] as const));
}

const PAYMENT_COLUMNS =
  'allocation_id,transaction_id,number,txn_date,method,amount,transaction_amount,status,reference,account_id,account_name';
const PAYMENT_OUT_COLUMNS =
  `${PAYMENT_COLUMNS},bill_id,bill_no,supplier_name,currency,amount_myr,carried_myr,realised_myr,` +
  'transaction_currency,transaction_amount_myr';
const PAYMENT_IN_COLUMNS =
  `${PAYMENT_COLUMNS},invoice_id,invoice_no,customer_name,currency,amount_myr,carried_myr,realised_myr,` +
  'transaction_currency,transaction_amount_myr';

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
        // The ringgit figures, kept null where the view says null.
        ...('amount_myr' in r
          ? {
              amount_myr: r.amount_myr === null ? null : Number(r.amount_myr),
              carried_myr: r.carried_myr === null ? null : Number(r.carried_myr),
              realised_myr: r.realised_myr === null ? null : Number(r.realised_myr),
            }
          : {}),
        // The movement's currency and its ringgit (stage 5b).
        ...('transaction_amount_myr' in r
          ? {
              transaction_currency: (r.transaction_currency as string | null) ?? BASE_CURRENCY,
              transaction_amount_myr: Number(r.transaction_amount_myr),
            }
          : {}),
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

/**
 * Records a payment out, paid now or scheduled, split across one supplier's bills. For bills in another currency
 * paid from a ringgit account `amount_myr` is the ringgit that left the account, the amounts are in their
 * currency, and it is paid now. From an account in another currency (stage 5b) the bills are in its currency, the
 * rate is sent, and it is paid now.
 */
export async function recordPaymentOut(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordPaymentOutInput>,
): Promise<FinResult<{ id: string }>> {
  const { allocations, scheduled, amount_myr, fx_rate, fx_rate_source, fx_rate_date, ...rest } =
    recordPaymentOutInput.parse(input);
  // Each key is sent only when there is a figure: the database reads a missing key as "none".
  const payment = {
    ...rest,
    status: scheduled ? 'scheduled' : 'posted',
    ...(amount_myr === undefined ? {} : { amount_myr }),
    ...movementRateKeys({ fx_rate, fx_rate_source, fx_rate_date }),
  };
  const { data, error } = await ctx.client.rpc('finance_record_payment_out', {
    target_org: ctx.orgId,
    payment,
    allocations,
  });
  // A rate is sent only for an account in another currency, whose FIN47 is its own "paid now".
  const refusals = fx_rate === undefined ? RECORD_OUT_REFUSALS : RECORD_OUT_ACCOUNT_REFUSALS;
  if (error || !data) return moneyWriteFailed('recordPaymentOut', error, refusals);
  return { ok: true, data: { id: data as string } };
}

/**
 * The finance assistant's payment out: ringgit bills only. A bill in another currency is refused in its own words
 * before the database is asked, since the assistant has no ringgit-paid-out figure to send.
 */
export async function recordPaymentOutInRinggit(ctx: FinanceWriteContext, input: unknown): Promise<FinResult<{ id: string }>> {
  const parsed = recordPaymentOutToolInput.parse(input);
  // Stage 5a: the account first. Money on an account in another currency is the screen's, with its rate.
  const foreign = await foreignAccountRefusal(ctx, parsed.account_id, 'recordPaymentOutInRinggit', RECORD_OUT_REFUSALS);
  if (foreign) return foreign;
  const ids = parsed.allocations.map((a) => a.bill_id);
  const { data, error } = await ctx.client.from('supplier_bills').select('id,currency').eq('org_id', ctx.orgId).in('id', ids);
  if (error) return moneyWriteFailed('recordPaymentOutInRinggit', error, RECORD_OUT_REFUSALS);
  if ((data ?? []).some((row) => (row as { currency?: string }).currency !== 'MYR')) {
    return { ok: false, error: M.foreignBillByAssistant };
  }
  return recordPaymentOut(ctx, parsed);
}

/**
 * Records money received from one customer, split across that customer's posted invoices. It is posted at once.
 * For invoices in another currency `amount_myr` is the ringgit that arrived, and the amounts are in their currency.
 */
export async function recordPaymentIn(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordPaymentInInput>,
): Promise<FinResult<{ id: string }>> {
  const { allocations, amount_myr, fx_rate, fx_rate_source, fx_rate_date, ...rest } = recordPaymentInInput.parse(input);
  // Each key is sent only when there is a figure: the database reads a missing key as "none".
  const payment = {
    ...rest,
    ...(amount_myr === undefined ? {} : { amount_myr }),
    ...movementRateKeys({ fx_rate, fx_rate_source, fx_rate_date }),
  };
  const { data, error } = await ctx.client.rpc('finance_record_payment_in', {
    target_org: ctx.orgId,
    payment,
    allocations,
  });
  if (error || !data) return moneyWriteFailed('recordPaymentIn', error, RECEIPT_REFUSALS);
  return { ok: true, data: { id: data as string } };
}

/**
 * The finance assistant's payment in: ringgit invoices only. An invoice in another currency is refused in its
 * own words before the database is asked, since the assistant has no ringgit-received figure to send.
 */
export async function recordPaymentInRinggit(ctx: FinanceWriteContext, input: unknown): Promise<FinResult<{ id: string }>> {
  const parsed = recordPaymentInToolInput.parse(input);
  // Stage 5a: the account first. Money on an account in another currency is the screen's, with its rate.
  const foreign = await foreignAccountRefusal(ctx, parsed.account_id, 'recordPaymentInRinggit', RECEIPT_REFUSALS);
  if (foreign) return foreign;
  const ids = parsed.allocations.map((a) => a.invoice_id);
  const { data, error } = await ctx.client
    .from('finance_invoices')
    .select('id,currency')
    .eq('org_id', ctx.orgId)
    .in('id', ids);
  if (error) return moneyWriteFailed('recordPaymentInRinggit', error, RECEIPT_REFUSALS);
  if ((data ?? []).some((row) => (row as { currency?: string }).currency !== 'MYR')) {
    return { ok: false, error: R.foreignByAssistant };
  }
  return recordPaymentIn(ctx, parsed);
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
