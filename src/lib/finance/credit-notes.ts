/**
 * Credit notes. A credit note is one amount against one posted invoice, with
 * a reason. Issuing gives it its number and takes its amount off what the
 * invoice owes; after that it can only be voided, and not while a refund
 * depends on it. All the issued credit notes of an invoice together never
 * exceed the invoice's total. org_id comes from the context.
 *
 * A credit note on an invoice in another currency (stage 3c) is in the
 * invoice's currency, at the invoice's rate: the database sets both, whatever
 * is sent, and works out the ringgit it takes off when it is issued
 * (amount_myr), so issuing one makes no exchange difference.
 */
import { z } from 'zod';
import { BASE_CURRENCY } from './currencies';
import { LINE_MESSAGES, isoDate, optionalText, ringgitAmount } from './document-lines';
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

export const CREDIT_NOTE_REASONS = ['returns', 'pricing_adjustment', 'overbilling', 'goodwill', 'other'] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];

export const CREDIT_NOTE_REASON_LABELS: Record<CreditNoteReason, string> = {
  returns: 'Returns',
  pricing_adjustment: 'Pricing adjustment',
  overbilling: 'Overbilling',
  goodwill: 'Goodwill',
  other: 'Other',
};

/** Credit notes loaded for a screen, a page at a time. */
export const CREDIT_NOTE_PAGE_SIZE = 1000;

export const CREDIT_NOTE_MESSAGES = {
  invoice: 'Choose the invoice this credit note is against.',
  // The finance assistant writes credit notes in ringgit only; it says this before the database is asked.
  foreignByAssistant: 'This invoice is not in ringgit. Record its credit note on the Credit Notes screen.',
  date: LINE_MESSAGES.date,
  reason: 'Choose a reason.',
  amount: 'Enter an amount above 0.',
  tooLong: LINE_MESSAGES.tooLong,
  gone: 'That credit note no longer exists.',
  // FIN01. A menu offers only what a credit note's status allows, so this reaches a person only when the
  // credit note changed in another tab: a draft that was issued meanwhile being saved, issued or deleted, or
  // an issued one that was voided meanwhile being voided again. It says what may have happened, not what
  // did, so it reads sensibly from all four buttons and is not false of a draft voided by a direct call.
  locked: 'That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded.',
  // FIN02
  hasRefunds: 'A refund depends on this credit note. Void or delete that refund on Refunds before voiding it.',
  // FIN04
  notPosted: 'A credit note can only go against a posted invoice.',
  // FIN05
  tooMuch: 'That is more than this invoice has left to credit.',
  numberTaken: 'That credit note number is already used.',
  missing: 'The invoice on this credit note no longer exists.',
} as const;

const M = CREDIT_NOTE_MESSAGES;

export const saveCreditNoteInput = z.object({
  /** Present to change a draft; absent to create one. */
  id: z.string({ error: M.gone }).uuid(M.gone).optional(),
  invoice_id: z.string({ error: M.invoice }).uuid(M.invoice),
  credit_date: isoDate,
  reason: z.enum(CREDIT_NOTE_REASONS, { error: M.reason }),
  amount: ringgitAmount(M.amount),
  notes: optionalText.default(null),
});

export const creditNoteIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN02: M.hasRefunds,
  FIN04: M.notPosted,
  FIN05: M.tooMuch,
  FIN11: M.gone,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [FIN_SIGN_OFF]: NEEDS_SIGN_OFF,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function creditNoteWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

export type CreditNoteStatus = 'draft' | 'issued' | 'void';

export type CreditNoteRow = {
  id: string;
  /** null while the credit note is a draft. */
  credit_note_no: string | null;
  invoice_id: string;
  /** The invoice is posted, so it always has a number; the type allows for one that somehow has none. */
  invoice_no: string | null;
  customer_id: string;
  customer_name: string;
  credit_date: string;
  reason: CreditNoteReason;
  amount: number;
  /** Posted refunds put against this credit note itself. A refund put against its invoice is not counted here. */
  refunded: number;
  status: CreditNoteStatus;
  notes: string | null;
  /**
   * The invoice's currency, which `amount` and `refunded` are in, and its rate. The reads always give these three;
   * they are optional so that rows made by hand (samples, tests) need not, and are then ringgit.
   */
  currency?: string;
  fx_rate?: number;
  /** What it takes off the invoice in ringgit: `amount` for a ringgit invoice; null while a foreign one is a draft. */
  amount_myr?: number | null;
};

/** What a credit note adds to a ringgit figure: its ringgit, which for a ringgit invoice is its amount. */
export function creditNoteRinggit(row: Pick<CreditNoteRow, 'amount' | 'currency' | 'amount_myr'>): number {
  if (row.amount_myr !== undefined && row.amount_myr !== null) return row.amount_myr;
  return (row.currency ?? BASE_CURRENCY) === BASE_CURRENCY ? row.amount : 0;
}

/**
 * The answer to "Save and issue". When the draft was saved but issuing it was
 * refused, `draftId` is that draft, so the form goes on editing it instead of
 * saving a second copy.
 */
export type SaveAndIssueCreditNoteResult = FinResult<{ id: string; credit_note_no: string }> & { draftId?: string };

const LIST_COLUMNS =
  'id,credit_note_no,invoice_id,invoice_no,customer_id,customer_name,credit_date,reason,amount,refunded,status,notes,' +
  'currency,fx_rate,amount_myr';

/** Every credit note in the workspace, newest first, read a page at a time. Drafts and void ones are included. */
export async function listCreditNotes(ctx: FinanceWriteContext): Promise<CreditNoteRow[]> {
  const rows: CreditNoteRow[] = [];
  for (let from = 0; ; from += CREDIT_NOTE_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_credit_note_totals')
      .select(LIST_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('credit_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + CREDIT_NOTE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((row) => ({
        ...(row as unknown as CreditNoteRow),
        amount: Number(row.amount),
        refunded: Number(row.refunded),
        notes: (row.notes as string | null) ?? null,
        currency: (row.currency as string | undefined) ?? BASE_CURRENCY,
        fx_rate: row.fx_rate === undefined || row.fx_rate === null ? 1 : Number(row.fx_rate),
        amount_myr: row.amount_myr === undefined || row.amount_myr === null ? null : Number(row.amount_myr),
      })),
    );
    if (page.length < CREDIT_NOTE_PAGE_SIZE) return rows;
  }
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft credit note, or replaces a draft. */
export async function saveCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveCreditNoteInput>,
): Promise<FinResult<{ id: string }>> {
  const note = saveCreditNoteInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_credit_note', { target_org: ctx.orgId, note });
  if (error || !data) return creditNoteWriteFailed('saveCreditNote', error);
  return { ok: true, data: { id: data as string } };
}

/**
 * The finance assistant's save: ringgit invoices only. A credit note on an invoice in another currency is in
 * that currency, and the assistant writes ringgit, so it is refused in its own words before the database is asked.
 */
export async function saveCreditNoteInRinggit(ctx: FinanceWriteContext, input: unknown): Promise<FinResult<{ id: string }>> {
  const parsed = saveCreditNoteInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_invoices')
    .select('currency')
    .eq('org_id', ctx.orgId)
    .eq('id', parsed.invoice_id)
    .maybeSingle();
  if (error) return creditNoteWriteFailed('saveCreditNoteInRinggit', error);
  const currency = (data as { currency?: string } | null)?.currency;
  if (currency !== undefined && currency !== BASE_CURRENCY) return { ok: false, error: M.foreignByAssistant };
  return saveCreditNote(ctx, parsed);
}

/** Issues a draft: it gets its number, and the invoice owes that much less. */
export async function issueCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof creditNoteIdInput>,
): Promise<FinResult<{ id: string; credit_note_no: string }>> {
  const { id } = creditNoteIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_issue_credit_note', {
    target_org: ctx.orgId,
    target_note: id,
  });
  if (error || !data) return creditNoteWriteFailed('issueCreditNote', error);
  return { ok: true, data: { id, credit_note_no: data as string } };
}

/** Voids an issued credit note: the invoice owes its amount again. Refused while a refund depends on it. */
export async function voidCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof creditNoteIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = creditNoteIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_credit_notes')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return creditNoteWriteFailed('voidCreditNote', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Deletes a draft credit note. */
export async function deleteCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof creditNoteIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = creditNoteIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_credit_notes')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return creditNoteWriteFailed('deleteCreditNote', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
