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
 */
import { z } from 'zod';
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

/**
 * A new account. `opening_balance` and `opening_date` are left out by anyone
 * who may not set them: an absent balance is stored as 0 and an absent date
 * as the database's own date, which means nothing while the balance is 0.
 */
export const createBankAccountInput = z.object({
  name,
  kind,
  bank_name: text(BANK_ACCOUNT_BANK_MAX, M.bankTooLong).default(null),
  account_no: text(BANK_ACCOUNT_NUMBER_MAX, M.numberTooLong).default(null),
  opening_balance: openingBalance.optional(),
  opening_date: openingDate.optional(),
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
});

export const setBankAccountActiveInput = z.object({ id, active: z.boolean({ error: M.gone }) }, { error: M.gone });

/** True when a new account would start with money in it, or owing: an owner's or admin's to say. */
export function setsOpeningBalance(input: z.output<typeof createBankAccountInput>): boolean {
  return input.opening_balance !== undefined && input.opening_balance !== 0;
}

/** True when a change carries an opening balance or its date at all: only an owner's or admin's form sends either. */
export function changesOpeningBalance(input: z.output<typeof updateBankAccountInput>): boolean {
  return input.opening_balance !== undefined || input.opening_date !== undefined;
}

const REFUSALS: Record<string, string> = {
  [PG_UNIQUE]: M.nameTaken,
  [FIN_SIGN_OFF]: M.needsSignOff,
  [FIN_BANK_ACCOUNT_IN_USE]: M.inUse,
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
  const { opening_balance, opening_date, ...fields } = createBankAccountInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_accounts')
    .insert({
      ...fields,
      ...(opening_balance === undefined ? {} : { opening_balance }),
      ...(opening_date === undefined ? {} : { opening_date }),
      org_id: ctx.orgId,
    })
    .select(SAVED_COLUMNS)
    .maybeSingle();
  if (error || !data) return bankAccountWriteFailed('createBankAccount', error);
  return { ok: true, data: data as unknown as SavedBankAccount };
}

/** Changes an account's name and bank details, and its opening balance and date when they are sent. */
export async function updateBankAccount(
  ctx: FinanceWriteContext,
  input: z.input<typeof updateBankAccountInput>,
): Promise<FinResult<SavedBankAccount>> {
  const { id: accountId, opening_balance, opening_date, ...fields } = updateBankAccountInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_accounts')
    .update({
      ...fields,
      ...(opening_balance === undefined ? {} : { opening_balance }),
      ...(opening_date === undefined ? {} : { opening_date }),
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
