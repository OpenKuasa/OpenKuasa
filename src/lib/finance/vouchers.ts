/**
 * Payment vouchers: the writes of the Payment Vouchers screen. A voucher is
 * one finance_transactions row with direction `out`. Two kinds are written
 * here. One settles no document: it names an expense category, an amount of
 * its own and who is paid (a contact or a typed name). The other pays one
 * supplier's posted bills: its amount is the sum of its split and whoever is
 * paid is the bills' supplier.
 *
 * `finance_record_voucher` records a category voucher and moves it on in the
 * same call: for a member it waits for approval, for an owner or admin it is
 * approved and "To be paid". `finance_save_voucher` saves either kind as a
 * draft, or changes a draft, and when asked sends it for approval in the same
 * call; it never schedules and never pays. A draft is also sent for approval
 * from its row, which is a change of status and nothing else. A supplier
 * payment that needs no approval is still recorded on Payments Out
 * (`recordPaymentOut` in money.ts). org_id comes from the context.
 *
 * Approving and rejecting are a change of status and nothing else, which the
 * database refuses to anyone but an owner or admin (FIN14) and signs itself.
 * Each is matched on the voucher as the person was shown it, field by field:
 * the table's `updated_at` is not moved by the database, so it proves
 * nothing. A voucher that has not been paid is deleted; a paid one is not.
 *
 * Paying and voiding are a sign-off: an owner or admin only (FIN14 for anyone
 * else). A new voucher for a category can be recorded as paid now. One that is
 * "To be paid" is marked paid by `finance_mark_payment_paid`, which gives it
 * its PV- number and the date it was paid and changes nothing else; it needs
 * no match on what was shown, because the database holds a payment still from
 * the moment it leaves draft (FIN14 on an approved one, FIN28 on any other),
 * so the voucher paid is the voucher the row showed. A paid voucher is voided
 * by one change of status: what it paid of its expenses is owed again, and
 * the books reverse it. Both are kept to the two kinds that belong to this
 * screen, a voucher for a category and one that pays expenses.
 *
 * A payment to a supplier and a refund are vouchers too, recorded, paid,
 * voided and deleted on Payments Out and Refunds (money.ts, refunds.ts). The
 * money-out side of a transfer between accounts is not a voucher: every
 * write here that is given an id is kept to money out that is no side of a
 * transfer, which is what the view `finance_payment_vouchers` shows.
 */
import { z } from 'zod';
import type { CashBookStatus } from './cash-book';
import { LINE_MESSAGES, isIsoDate, isoDate, optionalText, ringgitAmount } from './document-lines';
import { PAYMENT_BILLS_MAX, PAYMENT_METHODS } from './money';
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
  kind: 'Choose what this voucher is for: a supplier’s bills, or an expense category.',
  supplier: 'Choose the supplier whose bills this voucher pays.',
  bills: 'Choose at least one bill this voucher pays.',
  tooManyBills: `One voucher can pay at most ${PAYMENT_BILLS_MAX} bills.`,
  // Also 23505 from saving: the same bill twice in one split, which the schema refuses first.
  duplicate: 'Each bill can appear once on a voucher.',
  // FIN05, and the form's own check. A draft and a voucher that waits hold their part of a bill, as a payment to be paid does.
  tooMuch: 'That is more than is still owed on a bill, counting what payments and vouchers not yet paid already hold.',
  // FIN04: the bill was voided, or put back to a draft, since the form opened.
  notPosted: 'A voucher can only pay a posted bill.',
  // FIN06: a bill is not in the workspace any more, or the bills are two suppliers' (the form offers one supplier's).
  oneSupplier: 'The bills on one voucher must all be one supplier’s, and must still exist.',
  // FIN09 from saving a change to a draft: it was sent, approved, rejected or paid meanwhile.
  notDraft: 'This voucher is no longer a draft, so it cannot be changed. Check it again.',
  // Sending a draft from its row matched no row while it is still a draft: some field is not what the row showed.
  draftChanged: 'This draft is not as it was shown to you, so it was not sent. Check it again.',
  // The same, when it is no longer a draft: someone sent it, or it was decided or paid meanwhile.
  notDraftSend: 'This voucher is no longer a draft, so it was not sent for approval. Check it again.',
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
  // FIN37 from sending a draft from its row: its account was archived after the draft was saved.
  accountArchivedDraft:
    'The account this draft is paid from has been archived, so it cannot be sent for approval. Edit it and choose another account.',
  // A new voucher sent as paid now by someone who is not an owner or admin. The form offers them no such choice, so only a direct call does.
  paidNowNeedsSignOff: 'Only an owner or admin can record a voucher as paid.',
  // Marking paid with no date, or with one that is not a date.
  paidOn: 'Enter the date it was paid.',
  // Marking paid or voiding a payment to a supplier or a refund. The screen offers neither, so only a direct call does.
  notHere: 'A payment to a supplier is paid and voided on Payments Out, and a refund on Refunds.',
  // FIN09 from marking paid, when the voucher now reads Paid: someone else marked it paid meanwhile. Said of one
  // recorded as paid too, by a direct call, so it does not say "marked".
  alreadyPaid: 'This voucher has already been paid.',
  // The same when it now reads Void, and a void that matched no row when it reads Void: it was voided meanwhile.
  alreadyVoided: 'This voucher has already been voided.',
  // FIN09 from marking paid a voucher that is a draft, waits or was rejected. The menu offers Mark as paid only on
  // one that is To be paid, and none of those three comes after that, so only a direct call does.
  notToBePaid: 'Only a voucher that is To be paid can be marked paid.',
  // A void that matched no row while the voucher is not paid. The menu offers Void only on a paid one, and a paid
  // voucher only becomes void, so only a direct call does.
  notPaid: 'Only a paid voucher can be voided. One that has not been paid is deleted instead.',
  // FIN04 or FIN05 from marking paid: the guard on what a voucher pays refused. Not met while this was written.
  cannotPay: 'What this voucher pays can no longer take this payment, so it was not marked paid. Delete the voucher and record it again.',
  // FIN37 from marking paid. An account with a voucher still to be paid cannot be archived (FIN30), so only a race or a direct call does.
  accountArchivedPay:
    'The account this voucher is paid from has been archived, so it cannot be marked paid. Restore the account on Banking, then try again.',
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
 * recording it. `paid_now` asks for it to be recorded as paid, which only an
 * owner or admin is given. Whoever is paid is a contact or a typed name,
 * exactly one.
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
      // True when it has been paid already, on `txn_date`: an owner or admin only, which the action asks first.
      // Left out, it is not in what is parsed either.
      paid_now: z.boolean({ error: M.invalid }).optional(),
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

/** True when no id is there twice. The database reads an id whatever its capitals, so they are compared without them. */
function eachOnce(ids: string[]): boolean {
  return new Set(ids.map((value) => value.toLowerCase())).size === ids.length;
}

/** What both kinds of saved voucher carry. `id` is present when a draft is being changed; `send` sends it for approval in the same call. */
const savedShared = {
  id: id.optional(),
  account_id: z.string({ error: M.account }).uuid(M.account),
  txn_date: isoDate,
  method: z.enum(PAYMENT_METHODS, { error: M.method }),
  reference: optionalText.default(null),
  notes: optionalText.default(null),
  send: z.boolean({ error: M.invalid }).default(false),
};

/**
 * A voucher saved as a draft, new or being changed, and sent for approval in
 * the same call when `send` is true. `kind` says which of the two it is; the
 * database is not sent it, and tells them apart by whether there is a split.
 * A voucher for bills has no amount, payee or category of its own: it is the
 * sum of its split and is paid to the bills' supplier.
 *
 * Saving a change replaces everything the draft held: a field left out is
 * stored empty (`reference` and `notes` default to null), so a caller that
 * changes a draft always sends every field, as the form does.
 */
export const saveVoucherInput = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('bills'),
      ...savedShared,
      allocations: z
        .array(
          z.object({ bill_id: z.string({ error: M.bills }).uuid(M.bills), amount: ringgitAmount(M.amount) }, { error: M.bills }),
          { error: M.bills },
        )
        .min(1, M.bills)
        .max(PAYMENT_BILLS_MAX, M.tooManyBills)
        .refine((rows) => eachOnce(rows.map((r) => r.bill_id)), M.duplicate),
    }),
    z
      .object({
        kind: z.literal('category'),
        ...savedShared,
        category_id: z.string({ error: M.category }).uuid(M.category),
        amount: ringgitAmount(M.amount),
        contact_id: optionalContact,
        party_name: optionalText.default(null),
      })
      .superRefine((v, ctx) => {
        if (v.contact_id !== null && v.party_name !== null) {
          ctx.addIssue({ code: 'custom', message: M.payee, path: ['party_name'] });
        } else if (v.contact_id === null && v.party_name === null) {
          ctx.addIssue({ code: 'custom', message: M.payeeMissing, path: ['party_name'] });
        }
      }),
  ],
  { error: M.kind },
);

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

/** The voucher to mark paid, and the day it was paid: the person's own date, as typed. */
export const markVoucherPaidInput = z.object(
  { id, paid_on: z.string({ error: M.paidOn }).refine(isIsoDate, M.paidOn) },
  { error: M.gone },
);

/** The voucher to void. */
export const voidVoucherInput = z.object({ id }, { error: M.gone });

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
/**
 * What the database can answer to `finance_save_voucher`. FIN15 is the
 * category's, whichever kind was sent: a voucher for bills carries none, so
 * the function never answers it for one. FIN03 (the split is more than the
 * voucher) cannot be met: the function makes the amount the sum of the split.
 */
const SAVE_REFUSALS: Record<string, string> = {
  FIN04: M.notPosted,
  FIN05: M.tooMuch,
  FIN06: M.oneSupplier,
  FIN09: M.notDraft,
  FIN11: M.gone,
  FIN15: M.categoryGone,
  [FIN_ARCHIVED_ACCOUNT]: M.accountArchived,
  [PG_UNIQUE]: M.duplicate,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_CHECK]: M.invalid,
  [PG_NOT_NULL]: M.invalid,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};
/** Sending a draft from its row. Any writer may, so FIN14 has no sentence here: it is not one of the answers. */
const SEND_REFUSALS: Record<string, string> = {
  [FIN_ARCHIVED_ACCOUNT]: M.accountArchivedDraft,
  [PG_FORBIDDEN]: NOT_ALLOWED,
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
/** Marking paid. FIN09 is not here: what it means depends on what the voucher now reads, which one more read tells. */
const PAY_REFUSALS: Record<string, string> = {
  FIN04: M.cannotPay,
  FIN05: M.cannotPay,
  FIN11: M.gone,
  [FIN_SIGN_OFF]: NEEDS_SIGN_OFF,
  [FIN_ARCHIVED_ACCOUNT]: M.accountArchivedPay,
  [PG_FORBIDDEN]: NOT_ALLOWED,
};
const VOID_REFUSALS: Record<string, string> = {
  [FIN_SIGN_OFF]: NEEDS_SIGN_OFF,
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

/**
 * Paying and voiding here are for a voucher for a category and one that pays
 * expenses. Null when the voucher is one of those; otherwise the refusal: it
 * is not there, or it is a payment to a supplier or a refund, which have
 * screens of their own. What a voucher pays cannot change once it has left
 * draft, so the kind read here is the kind of the voucher that is written.
 */
async function refusalUnlessOurs(ctx: FinanceWriteContext, fnName: string, txnId: string): Promise<{ ok: false; error: string } | null> {
  const { data, error } = await ctx.client
    .from('finance_payment_vouchers')
    .select('kind')
    .eq('org_id', ctx.orgId)
    .eq('transaction_id', txnId)
    .maybeSingle();
  if (error) return writeFailed(fnName, error);
  const kind = (data as { kind?: string } | null)?.kind;
  if (!kind) return { ok: false, error: M.gone };
  return kind === 'expense' || kind === 'other' ? null : { ok: false, error: M.notHere };
}

/* ---- writes ----------------------------------------------------------- */

/**
 * Records a voucher for a category. The database is asked for "To be paid",
 * or for paid when `paid_now`, and decides the rest by who is asking: an
 * owner's or admin's is approved and scheduled, or paid and numbered, in the
 * same call; anyone else's waits for approval whatever was asked. The status
 * is read back and answered with the id, so the screen says which it was. A
 * read that fails after a save that worked answers `status: null`; the
 * voucher is recorded either way.
 */
export async function recordVoucher(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordVoucherInput>,
): Promise<FinResult<RecordedVoucher>> {
  const { paid_now, ...voucher } = recordVoucherInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_record_voucher', {
    target_org: ctx.orgId,
    voucher: { ...voucher, status: paid_now ? 'posted' : 'scheduled' },
    allocations: [],
  });
  if (error || !data) return voucherWriteFailed('recordVoucher', error, RECORD_REFUSALS);
  const recorded = data as string;
  const now = await statusNow(ctx, recorded);
  return { ok: true, data: { id: recorded, status: now.status ?? null } };
}

/**
 * Saves a voucher as a draft, or changes one that is still a draft, and sends
 * it for approval in the same call when `send` is true: one database
 * function, so it is saved and sent or neither. The status is read back and
 * answered with the id. A read that fails after a save that worked answers
 * `status: null`; the voucher is saved either way.
 */
export async function saveVoucher(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveVoucherInput>,
): Promise<FinResult<RecordedVoucher>> {
  const parsed = saveVoucherInput.parse(input);
  const shared = {
    ...(parsed.id ? { id: parsed.id } : {}),
    account_id: parsed.account_id,
    txn_date: parsed.txn_date,
    method: parsed.method,
    reference: parsed.reference,
    notes: parsed.notes,
    status: parsed.send ? 'pending_approval' : 'draft',
  };
  const { data, error } = await ctx.client.rpc('finance_save_voucher', {
    target_org: ctx.orgId,
    voucher:
      parsed.kind === 'bills'
        ? shared
        : { ...shared, category_id: parsed.category_id, amount: parsed.amount, contact_id: parsed.contact_id, party_name: parsed.party_name },
    allocations: parsed.kind === 'bills' ? parsed.allocations : [],
  });
  if (error || !data) return voucherWriteFailed('saveVoucher', error, SAVE_REFUSALS);
  const saved = data as string;
  const now = await statusNow(ctx, saved);
  return { ok: true, data: { id: saved, status: now.status ?? null } };
}

/**
 * One change of status on the voucher the person was shown (`seen`), kept to
 * the workspace and to money out that is no side of a transfer. The update
 * matches the voucher only while it has the status it is moved `from` and
 * still holds every field the row showed; a column that holds nothing is
 * matched with `is null`, never with equality. Answers the id when a row
 * matched, null when none did, or the database's refusal.
 */
async function moveAsSeen(
  ctx: FinanceWriteContext,
  seen: z.output<typeof voucherDecisionInput>,
  from: 'draft' | 'pending_approval',
  status: 'pending_approval' | 'scheduled' | 'rejected',
): Promise<{ id: string | null; error?: unknown }> {
  let update = ctx.client
    .from('finance_transactions')
    // Status and nothing else: the guard refuses a decision that changes anything with it, and signs it itself.
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', seen.id)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .is('transfer_id', null)
    .eq('status', from)
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
  if (error) return { id: null, error };
  return { id: (data as { id: string } | null)?.id ?? null };
}

/**
 * One decision on the voucher the person was shown, matched while it is
 * waiting for approval. When no row matches, the voucher is gone, or it was
 * decided meanwhile, or it is not as it was shown: one more read tells which.
 */
async function decide(
  ctx: FinanceWriteContext,
  fnName: string,
  seen: z.output<typeof voucherDecisionInput>,
  status: 'scheduled' | 'rejected',
  refusals: Record<string, string>,
): Promise<FinResult<{ id: string }>> {
  const moved = await moveAsSeen(ctx, seen, 'pending_approval', status);
  if (moved.error) return voucherWriteFailed(fnName, moved.error, refusals);
  if (moved.id) return { ok: true, data: { id: moved.id } };
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

/**
 * Sends a draft for approval from its row, as the row showed it: it becomes
 * "Pending approval" and from then on cannot be changed, only approved,
 * rejected or deleted. Anyone who may write can do this. The fields of the
 * row are matched; the bills behind it and what each takes are not (a draft's
 * split can be changed by anyone who may write until it is sent), which is
 * why what is approved is matched again, on a voucher that can no longer
 * change. When no row matches, one more read tells why.
 */
export async function submitVoucher(
  ctx: FinanceWriteContext,
  input: z.input<typeof voucherDecisionInput>,
): Promise<FinResult<{ id: string }>> {
  const seen = voucherDecisionInput.parse(input);
  const moved = await moveAsSeen(ctx, seen, 'draft', 'pending_approval');
  if (moved.error) return voucherWriteFailed('submitVoucher', moved.error, SEND_REFUSALS);
  if (moved.id) return { ok: true, data: { id: moved.id } };
  const now = await statusNow(ctx, seen.id);
  if (now.error) return voucherWriteFailed('submitVoucher', now.error, SEND_REFUSALS);
  if (now.status === undefined) return { ok: false, error: M.gone };
  return { ok: false, error: now.status === 'draft' ? M.draftChanged : M.notDraftSend };
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

/**
 * A voucher that is "To be paid" has now been paid, on `paid_on`: it gets its
 * PV- number and that date, and nothing else of it changes. What it holds of
 * its expenses is then paid. An owner or admin only (FIN14 for anyone else).
 * The database refuses one that is not "To be paid" (FIN09); one more read
 * tells whether it was paid or voided meanwhile.
 */
export async function markVoucherPaid(
  ctx: FinanceWriteContext,
  input: z.input<typeof markVoucherPaidInput>,
): Promise<FinResult<{ id: string; number: string }>> {
  const { id: txnId, paid_on } = markVoucherPaidInput.parse(input);
  const refusal = await refusalUnlessOurs(ctx, 'markVoucherPaid', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client.rpc('finance_mark_payment_paid', {
    target_org: ctx.orgId,
    target_txn: txnId,
    paid_on,
  });
  if (!error && data) return { ok: true, data: { id: txnId, number: data as string } };
  if (pgCode(error) !== 'FIN09') return voucherWriteFailed('markVoucherPaid', error, PAY_REFUSALS);
  const now = await statusNow(ctx, txnId);
  if (now.error) return voucherWriteFailed('markVoucherPaid', now.error, PAY_REFUSALS);
  if (now.status === undefined) return { ok: false, error: M.gone };
  if (now.status === 'posted') return { ok: false, error: M.alreadyPaid };
  if (now.status === 'void') return { ok: false, error: M.alreadyVoided };
  return { ok: false, error: M.notToBePaid };
}

/**
 * Voids a paid voucher: one change of status, matched while it is still
 * paid. What it paid of its expenses is owed again (an expense reads paid
 * only while posted money covers it), and the books reverse it. It keeps its
 * number and stays in the list as Void. An owner or admin only (FIN14 for
 * anyone else). When no row matches, one more read tells why.
 */
export async function voidVoucher(
  ctx: FinanceWriteContext,
  input: z.input<typeof voidVoucherInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = voidVoucherInput.parse(input);
  const refusal = await refusalUnlessOurs(ctx, 'voidVoucher', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .is('transfer_id', null)
    .eq('status', 'posted')
    .select('id')
    .maybeSingle();
  if (error) return voucherWriteFailed('voidVoucher', error, VOID_REFUSALS);
  if (data) return { ok: true, data: { id: (data as { id: string }).id } };
  const now = await statusNow(ctx, txnId);
  if (now.error) return voucherWriteFailed('voidVoucher', now.error, VOID_REFUSALS);
  if (now.status === undefined) return { ok: false, error: M.gone };
  return { ok: false, error: now.status === 'void' ? M.alreadyVoided : M.notPaid };
}
