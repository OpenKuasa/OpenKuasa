/**
 * Bank and cash accounts: the writes of the account form on Banking. An
 * account is one finance_accounts row, written directly under row-level
 * security. One Zod schema and one function per write; org_id comes from the
 * context.
 *
 * What the database holds everyone to (20261114110000): an opening balance
 * is set, changed or removed by an owner or admin only (FIN14 for any other
 * writer); an account is not archived while a payment on it, in either
 * direction, is still to be paid or waits for approval (FIN30); bank or cash is chosen when the account
 * is added and is not a column anyone signed in can change afterwards. The
 * account number cannot be read through the table: a writer asks
 * `finance_account_numbers`, and nobody else gets a row.
 *
 * Stage 5a (20261122100000): an account may be in another currency, chosen when it is added and never changed
 * (`currency` is granted for insert only: 42501 on a change). Its opening balance is in that currency and is put
 * into ringgit at a rate: Bank Negara Malaysia's 17:00 selling rate for the opening date (`bnm`, with the rate's
 * date), or one typed by hand (`manual`). The rate is the opening balance's, so it is an owner's or admin's too
 * (FIN14); a balance in another currency with no rate is FIN38, and a rate marked as BNM's that is not the rule's
 * figure for its date is FIN39. The rate travels as exact decimal text, never a float.
 */
import { z } from 'zod';
import { BASE_CURRENCY, isDocumentCurrency, minorUnits } from './currencies';
import { CURRENCY_MESSAGES, scaledFromText } from './document-currency';
import { isIsoDate } from './document-lines';
import {
  type FinResult,
  type FinanceWriteContext,
  FIN_SIGN_OFF,
  NOT_ALLOWED,
  PG_CHECK,
  PG_FORBIDDEN,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export type BankAccountKind = 'bank' | 'cash';

export const BANK_ACCOUNT_NAME_MAX = 80;
export const BANK_ACCOUNT_BANK_MAX = 80;
/** An IBAN is at most 34 characters; a Malaysian account number is far shorter. */
export const BANK_ACCOUNT_NUMBER_MAX = 34;
/** What numeric(14,2) holds, either side of zero. */
const MAX_BALANCE = 999_999_999_999.99;

/** An account with a payment on it, in either direction, still to be paid or waiting for approval is not archived. */
export const FIN_BANK_ACCOUNT_IN_USE = 'FIN30';
/** An opening balance in another currency with no exchange rate (stage 5a). */
const FIN_OPENING_RATE = 'FIN38';
/** A rate marked as Bank Negara Malaysia's that is not the rule's figure for its date, or dated after the opening date. */
const FIN_NOT_BNM_RATE = 'FIN39';

export const BANK_ACCOUNT_MESSAGES = {
  name: 'Enter a name for the bank or cash account.',
  nameTooLong: `Keep the name to ${BANK_ACCOUNT_NAME_MAX} characters or fewer.`,
  kind: 'Choose Bank or Cash.',
  bankTooLong: `Keep the bank’s name to ${BANK_ACCOUNT_BANK_MAX} characters or fewer.`,
  numberTooLong: `Keep the account number to ${BANK_ACCOUNT_NUMBER_MAX} characters or fewer.`,
  opening: 'Enter the opening balance as a number, or leave it empty for none. Use a minus sign for an overdraft.',
  date: 'Enter the date the opening balance was true.',
  gone: 'That bank or cash account no longer exists.',
  // 23505
  nameTaken: 'Another bank or cash account already has that name. Archived accounts keep their names.',
  // FIN14, and what the server action says before anything is written.
  needsSignOff: 'Only an owner or admin can set or change an opening balance. If you are one, sign in again with your second step.',
  // FIN30
  inUse: 'This account has payments that are still to be paid or waiting for approval. Pay, reject or delete them, then archive it.',
  // 23514: a check constraint. The schema refuses everything that could meet one, so only a direct call does.
  invalid: 'Check the opening balance, then try again.',
  currency: 'Choose a currency from the list.',
  // FIN38, and what the form says first: an opening balance in another currency needs its rate.
  rate: 'Enter the exchange rate for the opening balance.',
  rateNumber: 'Enter the exchange rate as a number above 0, such as 4.4620.',
  // FIN39: only a direct call meets it; the form marks a rate as BNM's only while it holds BNM's figure.
  notBnmRate: "That rate is not Bank Negara Malaysia's 5 pm selling rate for that day. Type it in again, and save.",
} as const;

const M = BANK_ACCOUNT_MESSAGES;

const id = z.string({ error: M.gone }).uuid(M.gone);
const name = z.string({ error: M.name }).trim().min(1, M.name).max(BANK_ACCOUNT_NAME_MAX, M.nameTooLong);
const kind = z.enum(['bank', 'cash'], { error: M.kind });
/** Optional text: trimmed, and an empty box is stored as null. */
const text = (max: number, message: string) =>
  z
    .string({ error: message })
    .trim()
    .max(max, message)
    .transform((v) => (v === '' ? null : v))
    .nullable();
/** Rounded to the sen first, then it must fit the column. It may be negative (an overdraft) or zero (none). */
const openingBalance = z
  .number({ error: M.opening })
  .transform((v) => Math.round(v * 100) / 100)
  .pipe(z.number().min(-MAX_BALANCE, M.opening).max(MAX_BALANCE, M.opening));
const openingDate = z.string({ error: M.date }).refine(isIsoDate, M.date);
const currency = z.string({ error: M.currency }).refine(isDocumentCurrency, M.currency);
/** Ringgit per one unit as exact decimal text (numeric(20,10)): ten digits either side of the point, above 0. */
const openingRate = z
  .string({ error: M.rateNumber })
  .trim()
  .regex(/^\d{1,10}(\.\d{1,10})?$/, M.rateNumber)
  .refine((v) => (scaledFromText(v) ?? BigInt(0)) > BigInt(0), M.rateNumber);
const openingRateSource = z.enum(['bnm', 'manual'], { error: M.rate });
const openingRateDate = z.string({ error: M.rate }).refine(isIsoDate, M.rate);

/** True when a balance has cents in a currency with none (JPY 1.5). */
function centsWithout(code: string, balance: number | undefined): boolean {
  return balance !== undefined && minorUnits(code) === 0 && !Number.isInteger(balance);
}

/**
 * A new account. `opening_balance` and `opening_date` are left out by anyone
 * who may not set them: an absent balance is stored as 0 and an absent date
 * as the database's own date, which means nothing while the balance is 0.
 */
export const createBankAccountInput = z
  .object({
    name,
    kind,
    bank_name: text(BANK_ACCOUNT_BANK_MAX, M.bankTooLong).default(null),
    account_no: text(BANK_ACCOUNT_NUMBER_MAX, M.numberTooLong).default(null),
    opening_balance: openingBalance.optional(),
    opening_date: openingDate.optional(),
    // Stage 5a: chosen here and never changed. The rate keys go only with an opening balance in another currency.
    currency: currency.default(BASE_CURRENCY),
    opening_rate: openingRate.optional(),
    opening_rate_source: openingRateSource.optional(),
    opening_rate_date: openingRateDate.optional(),
  })
  .superRefine((v, ctx) => {
    if (centsWithout(v.currency, v.opening_balance)) {
      ctx.addIssue({ code: 'custom', message: CURRENCY_MESSAGES.wholeUnits(v.currency), path: ['opening_balance'] });
    }
    const balance = v.opening_balance !== undefined && v.opening_balance !== 0;
    if (v.currency !== BASE_CURRENCY && balance && (v.opening_rate === undefined || v.opening_rate_source === undefined)) {
      ctx.addIssue({ code: 'custom', message: M.rate, path: ['opening_rate'] });
    }
  });

/**
 * An account being changed: its name and bank details always, its opening
 * balance and date only when they are sent. Bank or cash is not here: it was
 * chosen when the account was added. A bank name or number that is left out
 * is cleared, not kept: the form always sends both, so a change that omits
 * them is a change to none (pinned by a unit test).
 */
export const updateBankAccountInput = z.object({
  id,
  name,
  bank_name: text(BANK_ACCOUNT_BANK_MAX, M.bankTooLong).default(null),
  account_no: text(BANK_ACCOUNT_NUMBER_MAX, M.numberTooLong).default(null),
  opening_balance: openingBalance.optional(),
  opening_date: openingDate.optional(),
  // Stage 5a: the opening balance's rate, sent with it by an owner's or admin's form. Never the currency.
  opening_rate: openingRate.optional(),
  opening_rate_source: openingRateSource.optional(),
  opening_rate_date: openingRateDate.optional(),
});

export const setBankAccountActiveInput = z.object({ id, active: z.boolean({ error: M.gone }) }, { error: M.gone });

/** True when a new account would start with money in it, or owing: an owner's or admin's to say. */
export function setsOpeningBalance(input: z.output<typeof createBankAccountInput>): boolean {
  return input.opening_balance !== undefined && input.opening_balance !== 0;
}

/** True when a change carries an opening balance, its date or its rate at all: only an owner's or admin's form sends any. */
export function changesOpeningBalance(input: z.output<typeof updateBankAccountInput>): boolean {
  return (
    input.opening_balance !== undefined ||
    input.opening_date !== undefined ||
    input.opening_rate !== undefined ||
    input.opening_rate_source !== undefined ||
    input.opening_rate_date !== undefined
  );
}

/** The rate keys as the database stores them: a BNM rate keeps its date, a typed one has none. */
function rateColumns(input: { opening_rate?: string; opening_rate_source?: 'bnm' | 'manual'; opening_rate_date?: string }) {
  if (input.opening_rate === undefined) return {};
  const source = input.opening_rate_source ?? 'manual';
  return {
    opening_rate: input.opening_rate,
    opening_rate_source: source,
    opening_rate_date: source === 'bnm' ? (input.opening_rate_date ?? null) : null,
  };
}

const REFUSALS: Record<string, string> = {
  [PG_UNIQUE]: M.nameTaken,
  [FIN_SIGN_OFF]: M.needsSignOff,
  [FIN_BANK_ACCOUNT_IN_USE]: M.inUse,
  [FIN_OPENING_RATE]: M.rate,
  [FIN_NOT_BNM_RATE]: M.notBnmRate,
  [PG_CHECK]: M.invalid,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function bankAccountWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/** What a write answers with: enough to name the account in a message. Never `*`: account_no cannot be read back. */
const SAVED_COLUMNS = 'id,name,active';
export type SavedBankAccount = { id: string; name: string; active: boolean };

/* ---- reads ------------------------------------------------------------ */

/**
 * The account numbers of the workspace, by account id, for someone who may
 * write there; an account with no number is left out. A viewer and an
 * outsider get nothing: the function answers them with no row.
 */
export async function listBankAccountNumbers(ctx: FinanceWriteContext): Promise<Record<string, string>> {
  const { data, error } = await ctx.client.rpc('finance_account_numbers', { target_org: ctx.orgId });
  if (error) throw error;
  const rows = (data ?? []) as { account_id: string; account_no: string | null }[];
  return Object.fromEntries(rows.filter((r) => r.account_no).map((r) => [r.account_id, r.account_no as string]));
}

/* ---- writes ----------------------------------------------------------- */

/** Adds an account. A balance or date that was not sent is not written, so the column's default stands. */
export async function createBankAccount(
  ctx: FinanceWriteContext,
  input: z.input<typeof createBankAccountInput>,
): Promise<FinResult<SavedBankAccount>> {
  const { opening_balance, opening_date, currency: code, opening_rate, opening_rate_source, opening_rate_date, ...fields } =
    createBankAccountInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_accounts')
    .insert({
      ...fields,
      ...(opening_balance === undefined ? {} : { opening_balance }),
      ...(opening_date === undefined ? {} : { opening_date }),
      // A ringgit account sends what it always did: the column's default is ringgit.
      ...(code === BASE_CURRENCY ? {} : { currency: code, ...rateColumns({ opening_rate, opening_rate_source, opening_rate_date }) }),
      org_id: ctx.orgId,
    })
    .select(SAVED_COLUMNS)
    .maybeSingle();
  if (error || !data) return bankAccountWriteFailed('createBankAccount', error);
  return { ok: true, data: data as unknown as SavedBankAccount };
}

/** Changes an account's name and bank details, and its opening balance, date and rate when they are sent. */
export async function updateBankAccount(
  ctx: FinanceWriteContext,
  input: z.input<typeof updateBankAccountInput>,
): Promise<FinResult<SavedBankAccount>> {
  const { id: accountId, opening_balance, opening_date, opening_rate, opening_rate_source, opening_rate_date, ...fields } =
    updateBankAccountInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_accounts')
    .update({
      ...fields,
      ...(opening_balance === undefined ? {} : { opening_balance }),
      ...(opening_date === undefined ? {} : { opening_date }),
      ...rateColumns({ opening_rate, opening_rate_source, opening_rate_date }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', accountId)
    .eq('org_id', ctx.orgId)
    .select(SAVED_COLUMNS)
    .maybeSingle();
  if (error) return bankAccountWriteFailed('updateBankAccount', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: data as unknown as SavedBankAccount };
}

/** Archives an account, or restores it. An archived account keeps its movements, its balance and its name. */
export async function setBankAccountActive(
  ctx: FinanceWriteContext,
  input: z.input<typeof setBankAccountActiveInput>,
): Promise<FinResult<SavedBankAccount>> {
  const { id: accountId, active } = setBankAccountActiveInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_accounts')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', accountId)
    .eq('org_id', ctx.orgId)
    .select(SAVED_COLUMNS)
    .maybeSingle();
  if (error) return bankAccountWriteFailed('setBankAccountActive', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: data as unknown as SavedBankAccount };
}
