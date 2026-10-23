/**
 * Supplier credit notes (20261123110000). A supplier credit note is one amount
 * against one posted supplier bill, with a reason and the supplier's own
 * reference: an overpayment, returned goods, a short delivery. Issuing gives it
 * its SCN- number, puts it in the books, and applies it to its own bill up to
 * what that bill still owes. What is left is open credit on the supplier: an
 * owner or admin applies it to a later posted bill of the same supplier, and
 * can take it off again. A note is voided only while its credit is on nothing
 * but its own bill (FIN57). Issuing, voiding, applying and taking off need an
 * owner or admin (FIN14); anyone who may write saves and deletes a draft.
 * Supplier credit notes are in ringgit. org_id comes from the context.
 */
import { z } from 'zod';
import { round2 } from './allocation-form';
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

export const SUPPLIER_CREDIT_REASONS = ['overpaid', 'returned_goods', 'short_delivery', 'other'] as const;
export type SupplierCreditReason = (typeof SUPPLIER_CREDIT_REASONS)[number];

export const SUPPLIER_CREDIT_REASON_LABELS: Record<SupplierCreditReason, string> = {
  overpaid: 'Overpaid',
  returned_goods: 'Returned goods',
  short_delivery: 'Short delivery',
  other: 'Other',
};

/** Supplier credit notes, and their applications, loaded for a screen a page at a time. */
export const SUPPLIER_CREDIT_PAGE_SIZE = 1000;

export const SUPPLIER_CREDIT_MESSAGES = {
  bill: 'Choose the bill this credit note is against.',
  date: LINE_MESSAGES.date,
  reason: 'Choose a reason.',
  amount: 'Enter an amount above 0.',
  tooLong: LINE_MESSAGES.tooLong,
  gone: 'That credit note no longer exists.',
  // FIN01: it changed in another tab since this page was loaded.
  locked: 'That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded.',
  // FIN04
  notPosted: 'A supplier credit note goes against a posted bill, and only an issued one has credit to apply.',
  // FIN05, from saving or issuing.
  tooMuch: 'That is more than this bill has left to credit.',
  // FIN05, from applying.
  tooMuchApplied: 'That is more than the credit note has left, or more than the bill still owes.',
  // FIN57
  usedElsewhere: 'Its credit is on a later bill. Take it off that bill first, then void the credit note.',
  // FIN58
  otherSupplier: 'Credit can only go on a bill from the same supplier.',
  numberTaken: 'That credit note number is already used.',
  missing: 'The bill on this credit note no longer exists.',
  // Applying: no bill chosen, or an amount that is not above 0.
  applyBill: 'Choose the bill to put this credit on.',
  // Applying to a bill that already has this note's credit (one row per note and bill).
  alreadyOnBill: 'Some of this credit is already on that bill. Take it off first, then apply the new amount.',
  // Taking off: the credit was already taken off, here or in another tab.
  notApplied: 'That credit is no longer on this bill.',
} as const;

const M = SUPPLIER_CREDIT_MESSAGES;

const noteId = z.string({ error: M.gone }).uuid(M.gone);

export const saveSupplierCreditNoteInput = z.object({
  /** Present to change a draft; absent to create one. */
  id: noteId.optional(),
  bill_id: z.string({ error: M.bill }).uuid(M.bill),
  credit_date: isoDate,
  reason: z.enum(SUPPLIER_CREDIT_REASONS, { error: M.reason }),
  amount: ringgitAmount(M.amount),
  supplier_ref: optionalText.default(null),
  notes: optionalText.default(null),
});

export const supplierCreditNoteIdInput = z.object({ id: noteId });

/** Putting some of a note's open credit on a bill of the same supplier. */
export const applySupplierCreditInput = z.object({
  credit_note_id: noteId,
  bill_id: z.string({ error: M.applyBill }).uuid(M.applyBill),
  amount: ringgitAmount(M.amount),
});

/** Taking a note's credit off one bill: all of what it put there. */
export const unapplySupplierCreditInput = z.object({
  credit_note_id: noteId,
  bill_id: z.string({ error: M.notApplied }).uuid(M.notApplied),
});

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN04: M.notPosted,
  FIN05: M.tooMuch,
  FIN11: M.gone,
  FIN57: M.usedElsewhere,
  FIN58: M.otherSupplier,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [FIN_SIGN_OFF]: NEEDS_SIGN_OFF,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function noteWriteFailed(fnName: string, error: unknown, extra: Record<string, string> = {}): { ok: false; error: string } {
  const code = pgCode(error) ?? '';
  const refusal = extra[code] ?? REFUSALS[code];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

export type SupplierCreditStatus = 'draft' | 'issued' | 'void';

/** Where some of a note's credit went: a bill, and how much. Its own bill is one of these once it is issued. */
export type SupplierCreditApplication = { bill_id: string; bill_no: string | null; amount: number };

export type SupplierCreditNoteRow = {
  id: string;
  /** null while the credit note is a draft. */
  credit_note_no: string | null;
  bill_id: string;
  bill_no: string | null;
  supplier_id: string;
  supplier_name: string;
  credit_date: string;
  reason: SupplierCreditReason;
  amount: number;
  /** The supplier's own number for the credit note. */
  supplier_ref: string | null;
  notes: string | null;
  status: SupplierCreditStatus;
  /** Put on bills so far. */
  applied: number;
  /** What is still to apply: amount − applied while issued; 0 for a draft or a void one. */
  open_amount: number;
  /** Each bill its credit is on, its own bill first. */
  applications: SupplierCreditApplication[];
};

/**
 * Before a void, the confirm row asks whether the credit is on a later bill: the database refuses to void it then
 * (FIN57), so the menu says so first.
 */
export function creditOnOtherBills(note: Pick<SupplierCreditNoteRow, 'bill_id' | 'applications'>): SupplierCreditApplication[] {
  return note.applications.filter((a) => a.bill_id !== note.bill_id);
}

const LIST_COLUMNS =
  'id,credit_note_no,bill_id,bill_no,supplier_id,supplier_name,credit_date,reason,amount,supplier_ref,notes,status,applied,open_amount';

type ApplicationRead = { credit_note_id: string; bill_id: string; amount: number };

async function readApplications(ctx: FinanceWriteContext): Promise<ApplicationRead[]> {
  const rows: ApplicationRead[] = [];
  for (let from = 0; ; from += SUPPLIER_CREDIT_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_supplier_credit_applications')
      .select('credit_note_id,bill_id,amount')
      .eq('org_id', ctx.orgId)
      .order('id', { ascending: true })
      .range(from, from + SUPPLIER_CREDIT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map((r) => ({ credit_note_id: r.credit_note_id as string, bill_id: r.bill_id as string, amount: Number(r.amount) })));
    if (page.length < SUPPLIER_CREDIT_PAGE_SIZE) return rows;
  }
}

/** The numbers of these bills, read a slice at a time so the request stays short. */
async function readBillNumbers(ctx: FinanceWriteContext, ids: string[]): Promise<Map<string, string | null>> {
  const numbers = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await ctx.client
      .from('supplier_bills')
      .select('id,bill_no')
      .eq('org_id', ctx.orgId)
      .in('id', ids.slice(i, i + 100));
    if (error) throw error;
    for (const b of (data ?? []) as { id: string; bill_no: string | null }[]) numbers.set(b.id, b.bill_no);
  }
  return numbers;
}

/**
 * Every page of rows from the supplier credit note totals, newest first. `openOnly` keeps issued notes with credit
 * left, the only ones that count towards a supplier's open credit.
 */
async function readNoteTotals(ctx: FinanceWriteContext, columns: string, openOnly = false): Promise<Record<string, unknown>[]> {
  const notes: Record<string, unknown>[] = [];
  for (let from = 0; ; from += SUPPLIER_CREDIT_PAGE_SIZE) {
    let q = ctx.client.from('finance_supplier_credit_note_totals').select(columns).eq('org_id', ctx.orgId);
    if (openOnly) q = q.eq('status', 'issued').gt('open_amount', 0);
    const { data, error } = await q
      .order('credit_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + SUPPLIER_CREDIT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    notes.push(...page);
    if (page.length < SUPPLIER_CREDIT_PAGE_SIZE) break;
  }
  return notes;
}

/** Every supplier credit note in the workspace, newest first, with where its credit went. Drafts and void ones are included. */
export async function listSupplierCreditNotes(ctx: FinanceWriteContext): Promise<SupplierCreditNoteRow[]> {
  // The two reads do not depend on each other, so they run together.
  const [notes, applications] = await Promise.all([readNoteTotals(ctx, LIST_COLUMNS), readApplications(ctx)]);
  if (notes.length === 0) return [];

  // The note's own bill number is in the view; only bills credit was moved to need a read.
  const known = new Map(notes.map((n) => [n.bill_id as string, (n.bill_no as string | null) ?? null]));
  const unknown = [...new Set(applications.map((a) => a.bill_id))].filter((id) => !known.has(id));
  const numbers = unknown.length ? await readBillNumbers(ctx, unknown) : new Map<string, string | null>();
  const billNo = (id: string) => (known.has(id) ? known.get(id)! : (numbers.get(id) ?? null));

  const byNote = new Map<string, SupplierCreditApplication[]>();
  for (const a of applications) {
    const list = byNote.get(a.credit_note_id) ?? [];
    list.push({ bill_id: a.bill_id, bill_no: billNo(a.bill_id), amount: a.amount });
    byNote.set(a.credit_note_id, list);
  }

  return notes.map((n) => {
    const own = n.bill_id as string;
    const applied = (byNote.get(n.id as string) ?? []).sort(
      (x, y) => Number(y.bill_id === own) - Number(x.bill_id === own) || (x.bill_no ?? '').localeCompare(y.bill_no ?? '', undefined, { numeric: true }),
    );
    return {
      ...(n as unknown as SupplierCreditNoteRow),
      amount: Number(n.amount),
      applied: Number(n.applied),
      open_amount: Number(n.open_amount),
      supplier_ref: (n.supplier_ref as string | null) ?? null,
      notes: (n.notes as string | null) ?? null,
      applications: applied,
    };
  });
}

/**
 * The supplier credit notes for a page that only shows them alongside something else (Supplier Bills):
 * a failed read is logged and gives none, so the page still loads.
 */
export async function supplierCreditNotesOrNone<T>(
  read: () => Promise<T[]>,
  log: (message: string, error: unknown) => void = console.error,
): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    log('[finance] the supplier credit notes could not be read:', error);
    return [];
  }
}

/** What a supplier's open credit is worked out from. */
export type OpenSupplierCredit = Pick<SupplierCreditNoteRow, 'supplier_id' | 'status' | 'open_amount'>;

/**
 * Only what Supplier Bills needs to say how much credit a supplier has open: issued notes with credit left.
 * Lighter than listSupplierCreditNotes, which also reads where credit went and those bills' numbers.
 */
export async function listOpenSupplierCredit(ctx: FinanceWriteContext): Promise<OpenSupplierCredit[]> {
  const rows = await readNoteTotals(ctx, 'supplier_id,status,open_amount', true);
  return rows.map((r) => ({
    supplier_id: r.supplier_id as string,
    status: r.status as SupplierCreditNoteRow['status'],
    open_amount: Number(r.open_amount),
  }));
}

/** Open credit by supplier: what issued notes still have to apply. Suppliers with none are left out. */
export function openCreditBySupplier(rows: OpenSupplierCredit[]): Record<string, number> {
  const open: Record<string, number> = {};
  for (const r of rows) {
    if (r.status !== 'issued' || r.open_amount <= 0) continue;
    open[r.supplier_id] = round2((open[r.supplier_id] ?? 0) + r.open_amount);
  }
  return open;
}

/* ---- writes ----------------------------------------------------------- */

/** The answer to "Save and issue": when the draft was saved but issuing it was refused, `draftId` is that draft. */
export type SaveAndIssueSupplierCreditResult = FinResult<{ id: string; credit_note_no: string }> & { draftId?: string };

/** Creates a draft supplier credit note, or replaces a draft. */
export async function saveSupplierCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveSupplierCreditNoteInput>,
): Promise<FinResult<{ id: string }>> {
  const note = saveSupplierCreditNoteInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_supplier_credit_note', { target_org: ctx.orgId, note });
  if (error || !data) return noteWriteFailed('saveSupplierCreditNote', error);
  return { ok: true, data: { id: data as string } };
}

/** Issues a draft: it gets its number, is in the books, and is applied to its own bill up to what that bill owes. */
export async function issueSupplierCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof supplierCreditNoteIdInput>,
): Promise<FinResult<{ id: string; credit_note_no: string }>> {
  const { id } = supplierCreditNoteIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_issue_supplier_credit_note', { target_org: ctx.orgId, target_note: id });
  if (error || !data) return noteWriteFailed('issueSupplierCreditNote', error);
  return { ok: true, data: { id, credit_note_no: data as string } };
}

/** Voids an issued note: its own bill owes what it took again. Refused while its credit is on a later bill (FIN57). */
export async function voidSupplierCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof supplierCreditNoteIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = supplierCreditNoteIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_supplier_credit_notes')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return noteWriteFailed('voidSupplierCreditNote', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: (data as { id: string }).id } };
}

/** Deletes a draft. */
export async function deleteSupplierCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof supplierCreditNoteIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = supplierCreditNoteIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_supplier_credit_notes')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return noteWriteFailed('deleteSupplierCreditNote', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: (data as { id: string }).id } };
}

/**
 * Puts some of a note's open credit on a posted bill of the same supplier. One row per note and bill: credit
 * already on that bill is changed by taking it off and applying it again (PG_UNIQUE says so), so each step is
 * one write the guard checks whole.
 */
export async function applySupplierCredit(
  ctx: FinanceWriteContext,
  input: z.input<typeof applySupplierCreditInput>,
): Promise<FinResult<{ credit_note_id: string; bill_id: string }>> {
  const { credit_note_id, bill_id, amount } = applySupplierCreditInput.parse(input);
  const { error } = await ctx.client
    .from('finance_supplier_credit_applications')
    .insert({ org_id: ctx.orgId, credit_note_id, bill_id, amount });
  if (error) return noteWriteFailed('applySupplierCredit', error, { FIN05: M.tooMuchApplied, [PG_UNIQUE]: M.alreadyOnBill });
  return { ok: true, data: { credit_note_id, bill_id } };
}

/** Takes a note's credit off one bill: that bill owes it again, and the note has it open to apply elsewhere. */
export async function unapplySupplierCredit(
  ctx: FinanceWriteContext,
  input: z.input<typeof unapplySupplierCreditInput>,
): Promise<FinResult<{ credit_note_id: string; bill_id: string }>> {
  const { credit_note_id, bill_id } = unapplySupplierCreditInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_supplier_credit_applications')
    .delete()
    .eq('org_id', ctx.orgId)
    .eq('credit_note_id', credit_note_id)
    .eq('bill_id', bill_id)
    .select('bill_id');
  if (error) return noteWriteFailed('unapplySupplierCredit', error);
  if (!data || (data as unknown[]).length === 0) return { ok: false, error: M.notApplied };
  return { ok: true, data: { credit_note_id, bill_id } };
}
