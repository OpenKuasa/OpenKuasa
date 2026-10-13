/**
 * Payment vouchers: the writes of the Payment Vouchers screen. A voucher is
 * one finance_transactions row with direction `out`. The one recorded here
 * settles no document: it names an expense category, an amount of its own
 * and who is paid (a contact or a typed name). `finance_record_voucher`
 * records it and moves it on in the same call: for a member it waits for
 * approval, for an owner or admin it is approved and "To be paid". There is
 * no draft to come back to. org_id comes from the context.
 *
 * Approving and rejecting are a change of status and nothing else, which the
 * database refuses to anyone but an owner or admin (FIN14) and signs itself.
 * Each is matched on the voucher as the person was shown it, field by field:
 * the table's `updated_at` is not moved by the database, so it proves
 * nothing. A voucher that has not been paid is deleted; a paid one is not.
 *
 * A payment to a supplier and a refund are vouchers too, recorded, paid,
 * voided and deleted on Payments Out and Refunds (money.ts, refunds.ts). The
 * money-out side of a transfer between accounts is not a voucher: every
 * write here that is given an id is kept to money out that is no side of a
 * transfer, which is what the view `finance_payment_vouchers` shows.
 */
import { z } from 'zod';
import type { CashBookStatus } from './cash-book';
import { LINE_MESSAGES, isoDate, optionalText, ringgitAmount } from './document-lines';
import { PAYMENT_METHODS } from './money';
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

export const VOUCHER_MESSAGES = {
  account: 'Choose the account the money leaves.',
  date: LINE_MESSAGES.date,
  method: 'Choose how it is paid.',
  category: 'Choose an expense category.',
  amount: 'Enter an amount above 0.',
  // Typed into the amount box: a comma, or RM in front.
  amountFormat: 'Enter the amount as a number, without commas or RM: 1200.50.',
  // Typed into the amount box: more than a sen.
  amountDecimals: 'Enter the amount to two decimal places.',
  payee: 'Choose who is paid from your contacts or type a name, not both.',
  payeeMissing: 'Say who is paid: choose a contact or type a name.',
  tooLong: LINE_MESSAGES.tooLong,
  gone: 'That voucher no longer exists.',
  // A decision or a delete that matched no row while the voucher is still there with the status the person saw:
  // some field is not what their screen showed.
  changed: 'This voucher is not as it was shown to you. Check it again before you decide.',
  // The same, when the voucher now holds another status: someone else decided it meanwhile.
  alreadyApproved: 'This voucher has already been approved.',
  alreadyRejected: 'This voucher has already been rejected.',
  // A delete that matched no row because the status is no longer the one the person saw.
  movedOn: 'This voucher has changed since you opened it, so it was not deleted. Check it again.',
  // FIN14 from a decision. The update is matched on "Pending approval" and changes the status only, so the
  // one rule of the guard it can meet is who decides.
  needsDecider: 'Only an owner or admin can approve or reject a voucher. Ask one of them to do this.',
  // FIN09 from deleting: it was paid, or paid and voided, in another tab.
  cannotDelete: 'This voucher has been paid or voided, so it cannot be deleted.',
  // FIN15: the category is not an expense category of the workspace any more.
  categoryGone: 'Choose an expense category that still exists.',
  // 23503 from recording.
  missing: 'The account, the contact or the category on this voucher no longer exists.',
  // 23514 and 23502: a check constraint or an empty column. The schema refuses everything that could meet one, so only a direct call does.
  invalid: 'Check who is paid, the amount and the method, then try again.',
  // FIN37, if the rule that refuses money on an archived account is live (stage 6b part 2): from recording.
  accountArchived: 'That account has been archived. Choose another account.',
  // FIN37 from approving: the account was archived after the voucher was sent.
  accountArchivedSince:
    'The account this voucher is paid from has been archived, so it cannot be approved. Reject or delete it, then record it again from another account.',
} as const;

const M = VOUCHER_MESSAGES;

/** A required column was left empty. */
const PG_NOT_NULL = '23502';
/** Money on an archived account, refused by the rule stage 6b part 2 adds. Until that rule is live this code is never answered. */
const FIN_ARCHIVED_ACCOUNT = 'FIN37';

const id = z.string({ error: M.gone }).uuid(M.gone);

/** A contact's id, or nobody chosen (null, or an empty string from a select). */
const optionalContact = z
  .union([z.string().uuid(M.payee), z.literal(''), z.null()], { error: M.payee })
  .transform((v) => (v === '' ? null : v))
  .default(null);

/**
 * A voucher for money that settles no document. It carries no status: the
 * database decides whether it waits for approval or is approved, by who is
 * recording it. Whoever is paid is a contact or a typed name, exactly one.
 */
export const recordVoucherInput = z
  .object(
    {
      account_id: z.string({ error: M.account }).uuid(M.account),
      txn_date: isoDate,
      method: z.enum(PAYMENT_METHODS, { error: M.method }),
      category_id: z.string({ error: M.category }).uuid(M.category),
      amount: ringgitAmount(M.amount),
      contact_id: optionalContact,
      party_name: optionalText.default(null),
      reference: optionalText.default(null),
      notes: optionalText.default(null),
    },
    { error: M.invalid },
  )
  .superRefine((v, ctx) => {
    if (v.contact_id !== null && v.party_name !== null) {
      ctx.addIssue({ code: 'custom', message: M.payee, path: ['party_name'] });
    } else if (v.contact_id === null && v.party_name === null) {
      ctx.addIssue({ code: 'custom', message: M.payeeMissing, path: ['party_name'] });
    }
  });

const VOUCHER_STATUSES = ['draft', 'pending_approval', 'scheduled', 'posted', 'rejected', 'void'] as const;

/**
 * The voucher a decision is asked on, as its row showed it. `party_name` is
 * the typed name and is null when a contact is named, which is how the table
 * holds the two (the view shows the contact's name in that column).
 */
export const voucherDecisionInput = z.object(
  {
    id,
    amount: z.number({ error: M.changed }).finite(M.changed),
    txn_date: z.string({ error: M.changed }).regex(/^\d{4}-\d{2}-\d{2}$/, M.changed),
    method: z.enum(PAYMENT_METHODS, { error: M.changed }),
    account_id: z.string({ error: M.changed }).uuid(M.changed),
    contact_id: z.string({ error: M.changed }).uuid(M.changed).nullable(),
    party_name: z.string({ error: M.changed }).nullable(),
    category_id: z.string({ error: M.changed }).uuid(M.changed).nullable(),
    reference: z.string({ error: M.changed }).nullable(),
    notes: z.string({ error: M.changed }).nullable(),
  },
  { error: M.gone },
);

/** The voucher to delete, and the status its row showed: it is deleted only while it still has it. */
export const deleteVoucherInput = z.object(
  { id, status: z.enum(VOUCHER_STATUSES, { error: M.movedOn }) },
  { error: M.gone },
);

/** The voucher that was recorded, and how the database left it; null when it could not be read back. */
export type RecordedVoucher = { id: string; status: CashBookStatus | null };

const RECORD_REFUSALS: Record<string, string> = {
  FIN15: M.categoryGone,
  [FIN_ARCHIVED_ACCOUNT]: M.accountArchived,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_CHECK]: M.invalid,
  [PG_NOT_NULL]: M.invalid,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};
const APPROVE_REFUSALS: Record<string, string> = {
  [FIN_SIGN_OFF]: M.needsDecider,
  [FIN_ARCHIVED_ACCOUNT]: M.accountArchivedSince,
  [PG_FORBIDDEN]: NOT_ALLOWED,
};
const REJECT_REFUSALS: Record<string, string> = {
  [FIN_SIGN_OFF]: M.needsDecider,
  [PG_FORBIDDEN]: NOT_ALLOWED,
};
const DELETE_REFUSALS: Record<string, string> = {
  FIN09: M.cannotDelete,
  [PG_FORBIDDEN]: NOT_ALLOWED,
};

function voucherWriteFailed(fnName: string, error: unknown, refusals: Record<string, string>): { ok: false; error: string } {
  const refusal = refusals[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/**
 * The voucher's status as the screen's own view has it now, and whether an owner or admin ever approved or rejected
 * it (`approved_at`, read only when `withApproval`, which only a decision needs); `status` is `undefined` when it is
 * not there, `error` set when the read failed.
 */
async function statusNow(
  ctx: FinanceWriteContext,
  txnId: string,
  withApproval = false,
): Promise<{ status?: CashBookStatus; approved?: boolean; error?: unknown }> {
  const { data, error } = await ctx.client
    .from('finance_payment_vouchers')
    .select(withApproval ? 'status,approved_at' : 'status')
    .eq('org_id', ctx.orgId)
    .eq('transaction_id', txnId)
    .maybeSingle();
  if (error) return { error };
  const row = data as { status?: CashBookStatus; approved_at?: string | null } | null;
  return { status: row?.status, approved: Boolean(row?.approved_at) };
}

/* ---- writes ----------------------------------------------------------- */

/**
 * Records a voucher for a category. The database is asked for "To be paid"
 * and decides the rest by who is asking: an owner's or admin's is approved
 * and scheduled in the same call; anyone else's waits for approval whatever
 * was asked. The status is read back and answered with the id, so the screen
 * says which it was. A read that fails after a save that worked answers
 * `status: null`; the voucher is recorded either way.
 */
export async function recordVoucher(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordVoucherInput>,
): Promise<FinResult<RecordedVoucher>> {
  const voucher = recordVoucherInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_record_voucher', {
    target_org: ctx.orgId,
    voucher: { ...voucher, status: 'scheduled' },
    allocations: [],
  });
  if (error || !data) return voucherWriteFailed('recordVoucher', error, RECORD_REFUSALS);
  const recorded = data as string;
  const now = await statusNow(ctx, recorded);
  return { ok: true, data: { id: recorded, status: now.status ?? null } };
}

/**
 * One decision on the voucher the person was shown (`seen`), kept to the
 * workspace and to money out that is no side of a transfer. The update
 * matches the voucher only while it is waiting for approval and still holds
 * every field the row showed; a column that holds nothing is matched with
 * `is null`, never with equality. When no row matches, the voucher is gone,
 * or it was decided meanwhile, or it is not as it was shown: one more read
 * tells which.
 */
async function decide(
  ctx: FinanceWriteContext,
  fnName: string,
  seen: z.output<typeof voucherDecisionInput>,
  status: 'scheduled' | 'rejected',
  refusals: Record<string, string>,
): Promise<FinResult<{ id: string }>> {
  let update = ctx.client
    .from('finance_transactions')
    // Status and nothing else: the guard refuses a decision that changes anything with it, and signs it itself.
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', seen.id)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .is('transfer_id', null)
    .eq('status', 'pending_approval')
    .eq('amount', seen.amount)
    .eq('txn_date', seen.txn_date)
    .eq('method', seen.method)
    .eq('account_id', seen.account_id);
  update = seen.contact_id === null ? update.is('contact_id', null) : update.eq('contact_id', seen.contact_id);
  update = seen.party_name === null ? update.is('party_name', null) : update.eq('party_name', seen.party_name);
  update = seen.category_id === null ? update.is('category_id', null) : update.eq('category_id', seen.category_id);
  update = seen.reference === null ? update.is('reference', null) : update.eq('reference', seen.reference);
  update = seen.notes === null ? update.is('notes', null) : update.eq('notes', seen.notes);
  const { data, error } = await update.select('id').maybeSingle();
  if (error) return voucherWriteFailed(fnName, error, refusals);
  if (data) return { ok: true, data: { id: (data as { id: string }).id } };
  const now = await statusNow(ctx, seen.id, true);
  if (now.error) return voucherWriteFailed(fnName, now.error, refusals);
  if (now.status === undefined) return { ok: false, error: M.gone };
  if (now.status === 'rejected') return { ok: false, error: M.alreadyRejected };
  // From "Pending approval" a voucher only becomes "To be paid" by being approved; paid and void come after that. One
  // that is "To be paid" or later and was never approved (a supplier payment a member scheduled) was not approved
  // meanwhile: it is simply not as shown.
  if ((now.status === 'scheduled' || now.status === 'posted' || now.status === 'void') && now.approved) {
    return { ok: false, error: M.alreadyApproved };
  }
  return { ok: false, error: M.changed };
}

/** Approves a voucher that is waiting, as it stands: it becomes "To be paid". An owner or admin only (FIN14 for anyone else). */
export async function approveVoucher(
  ctx: FinanceWriteContext,
  input: z.input<typeof voucherDecisionInput>,
): Promise<FinResult<{ id: string }>> {
  return decide(ctx, 'approveVoucher', voucherDecisionInput.parse(input), 'scheduled', APPROVE_REFUSALS);
}

/** Rejects a voucher that is waiting. It is final: a rejected voucher is only deleted. An owner or admin only (FIN14 for anyone else). */
export async function rejectVoucher(
  ctx: FinanceWriteContext,
  input: z.input<typeof voucherDecisionInput>,
): Promise<FinResult<{ id: string }>> {
  return decide(ctx, 'rejectVoucher', voucherDecisionInput.parse(input), 'rejected', REJECT_REFUSALS);
}

/**
 * Deletes a voucher that has not been paid, and with it what it held of each
 * expense or bill. It is deleted only while it still has the status its row
 * showed, so a voucher that was approved meanwhile is not deleted by someone
 * who saw it waiting. A paid one is refused by the database (FIN09).
 */
export async function deleteVoucher(
  ctx: FinanceWriteContext,
  input: z.input<typeof deleteVoucherInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId, status } = deleteVoucherInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .delete()
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .is('transfer_id', null)
    .eq('status', status)
    .select('id')
    .maybeSingle();
  if (error) return voucherWriteFailed('deleteVoucher', error, DELETE_REFUSALS);
  if (data) return { ok: true, data: { id: (data as { id: string }).id } };
  const now = await statusNow(ctx, txnId);
  if (now.error) return voucherWriteFailed('deleteVoucher', now.error, DELETE_REFUSALS);
  if (now.status === undefined) return { ok: false, error: M.gone };
  return { ok: false, error: M.movedOn };
}
