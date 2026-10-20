/**
 * Transfers between two of the workspace's bank or cash accounts: the two
 * writes of Banking's "Transfer". A transfer is two finance_transactions
 * rows that share a transfer_id and one TR- number, money out of one account
 * and the same money in to the other. Both are written by one database
 * function, so a transfer is recorded whole or not at all, and voided whole.
 * One Zod schema and one function per write; org_id comes from the context.
 *
 * What the database holds everyone to (20261031090300, 20261030123000):
 * recording and voiding a transfer are an owner's or admin's (FIN14 for any
 * other writer); the two accounts are different, active and the workspace's
 * own, and the amount is above 0 (FIN16, three messages under one code, so
 * the schema here refuses the two a form can cause first, each with its own
 * sentence); only a posted transfer is voided (FIN09). A statement line
 * matched to either side goes back to unmatched when the transfer is voided.
 *
 * Stage 5c (20261122120000): a transfer goes between a ringgit account and an
 * account in another currency, either way, or between two ringgit accounts.
 * With an account in another currency it moves two amounts: `amount` leaves
 * the "From" account in its currency and `to_amount` arrives in the "To"
 * account's (FIN16 when it is missing or not above 0; the form asks first).
 * Both sides hold one ringgit figure, the ringgit side's amount, and the other
 * side's rate is derived from it; no gain or loss is posted. Between two
 * ringgit accounts `to_amount` is left out, as before. Two accounts not in
 * ringgit, the same currency included, are refused (FIN52; the form's "To"
 * list hides them).
 */
import { z } from 'zod';
import { LINE_MESSAGES, isoDate, optionalText, ringgitAmount } from './document-lines';
import {
  type FinResult,
  type FinanceWriteContext,
  FIN_ACCOUNT_ARCHIVED,
  FIN_SIGN_OFF,
  NOT_ALLOWED,
  PG_FORBIDDEN,
  PG_OUT_OF_RANGE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

/** Not two different active accounts of the workspace, or not an amount: `finance_record_transfer`. */
const FIN_TRANSFER_SHAPE = 'FIN16';
const FIN_GONE = 'FIN11';
const FIN_NOT_POSTED = 'FIN09';
/** Stage 5c: a transfer between two accounts that are both not in ringgit. */
const FIN_TWO_FOREIGN = 'FIN52';

export const TRANSFER_MESSAGES = {
  from: 'Choose the account the money leaves.',
  to: 'Choose the account the money goes to.',
  same: 'Choose two different accounts.',
  amount: 'Enter an amount above 0.',
  date: LINE_MESSAGES.date,
  tooLong: LINE_MESSAGES.tooLong,
  // FIN16 once the schema has passed, and FIN37: an account was archived or deleted after the form was opened.
  accounts: 'One of those accounts has been archived or no longer exists. Choose another, then try again.',
  // FIN14, and what the server actions say before anything is read or written.
  needsSignOff: 'Only an owner or admin can record or void a transfer between accounts. Ask one of them to do this.',
  // FIN11, and an id that is not one.
  gone: 'That transfer no longer exists.',
  // FIN09: voided in another tab or by someone else. (A pair made by hand and never posted would get it too.)
  alreadyVoid: 'This transfer has already been voided.',
  // Stage 5c: the amount that arrived, on a transfer with an account in another currency (the form asks it first;
  // FIN16 from the database says the accounts' sentence above).
  toAmount: 'Enter the amount that arrived, in the receiving account’s currency.',
  // FIN52: two accounts not in ringgit. The form's "To" list hides them when "From" is in another currency, so a
  // stale tab or a direct call meets it.
  twoForeign:
    'A transfer goes between a ringgit account and another account. Move money between two accounts in other currencies through a ringgit account.',
} as const;

const M = TRANSFER_MESSAGES;

/**
 * A transfer to record. Both sides are posted at once, dated `txn_date`. `amount` is in the "From" account's
 * currency; `to_amount`, in the "To" account's, only when the two differ.
 */
export const recordTransferInput = z
  .object({
    from_account_id: z.string({ error: M.from }).uuid(M.from),
    to_account_id: z.string({ error: M.to }).uuid(M.to),
    amount: ringgitAmount(M.amount),
    // Stage 5c: what arrived, in the "To" account's currency; sent only when the two accounts' currencies differ.
    to_amount: ringgitAmount(M.toAmount).optional(),
    txn_date: isoDate,
    reference: optionalText.default(null),
    notes: optionalText.default(null),
  })
  .refine((v) => v.from_account_id !== v.to_account_id, { message: M.same, path: ['to_account_id'] });

/** The transfer to void, by the id its two sides share. */
export const voidTransferInput = z.object({ transfer_id: z.string({ error: M.gone }).uuid(M.gone) }, { error: M.gone });

const REFUSALS: Record<string, string> = {
  [FIN_TRANSFER_SHAPE]: M.accounts,
  // The archived-account rule on finance_transactions: finance_record_transfer asks whether both accounts are
  // active itself (FIN16), and this is the same answer from the rule, for an account archived in the moment
  // between that question and the write. For a transfer the cause is "one of those accounts", so it is worded
  // as FIN16 is, not with the shared sentence for a payment's account.
  [FIN_ACCOUNT_ARCHIVED]: M.accounts,
  [FIN_TWO_FOREIGN]: M.twoForeign,
  [FIN_SIGN_OFF]: M.needsSignOff,
  [FIN_GONE]: M.gone,
  [FIN_NOT_POSTED]: M.alreadyVoid,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function transferWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/** What recording answers with: the id both sides share, and their TR- number (null if it could not be read back). */
export type RecordedTransfer = { transfer_id: string; number: string | null };

/**
 * Records a transfer: both sides posted at once with one TR- number. An owner or admin only (FIN14 for anyone
 * else, with nothing written and no number used). The number is read back from one side; if that read fails the
 * transfer still stands, so the answer is a success without a number.
 */
export async function recordTransfer(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordTransferInput>,
): Promise<FinResult<RecordedTransfer>> {
  const transfer = recordTransferInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_record_transfer', { target_org: ctx.orgId, transfer });
  if (error || !data) return transferWriteFailed('recordTransfer', error);
  const transferId = data as string;
  const sides = await ctx.client
    .from('finance_transactions')
    .select('number')
    .eq('org_id', ctx.orgId)
    .eq('transfer_id', transferId)
    .limit(1);
  if (sides.error) console.error('[finance] recordTransfer could not read the number back:', sides.error);
  const number = ((sides.data ?? []) as { number: string | null }[])[0]?.number ?? null;
  return { ok: true, data: { transfer_id: transferId, number } };
}

/**
 * Voids both sides of a posted transfer. An owner or admin only (FIN14 for anyone else). It keeps its number, and
 * a statement line matched to either side goes back to unmatched.
 */
export async function voidTransfer(
  ctx: FinanceWriteContext,
  input: z.input<typeof voidTransferInput>,
): Promise<FinResult<{ transfer_id: string }>> {
  const { transfer_id } = voidTransferInput.parse(input);
  const { error } = await ctx.client.rpc('finance_void_transfer', { target_org: ctx.orgId, target_transfer: transfer_id });
  if (error) return transferWriteFailed('voidTransfer', error);
  return { ok: true, data: { transfer_id } };
}
