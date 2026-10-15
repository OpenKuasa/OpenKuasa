/**
 * Contra entries (migration 20261119100000): what a contact owes us on invoices set off against what we owe the
 * same contact on bills, with no money moving. A contra entry is a draft, then posted (it takes a CT- number and
 * lowers each invoice's and bill's balance, as a payment would), then voided; it is never edited once posted.
 * Only an owner or admin writes one; every member reads them. The database decides every rule (the guard on
 * finance_contras); the pure functions here only shape what the screen offers. org_id comes from the context.
 *
 * Nothing here writes a payment, an allocation or an account: a contra entry moves no bank balance.
 */
import { z } from 'zod';
import { DOCUMENT_LINES_MAX, isoDate, ringgitAmount } from './document-lines';
import {
  type FinResult,
  type FinanceWriteContext,
  FIN_SIGN_OFF,
  PG_FORBIDDEN,
  PG_OUT_OF_RANGE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

/** Invoices plus bills on one contra entry. */
export const CONTRA_LINES_MAX = DOCUMENT_LINES_MAX;
export const CONTRA_PAGE_SIZE = 1000;

export const CONTRA_MESSAGES = {
  contact: 'Choose a contact who is both a customer and a supplier.',
  date: 'Enter a valid date.',
  // FIN29 on save; Zod says it first.
  amount: 'Enter an amount above zero for the contra entry and for each invoice and bill.',
  reference: 'Keep the reference to 100 characters.',
  notes: 'Keep the note to 1,000 characters.',
  document: 'Choose an invoice or a bill for each line.',
  duplicate: 'Each invoice and each bill can be on a contra entry once.',
  tooManyLines: `A contra entry can set off at most ${CONTRA_LINES_MAX} invoices and bills.`,
  // FIN29 on post
  unbalanced:
    "Before posting, choose at least one invoice and one bill, and make each side add up to the contra entry's amount.",
  // FIN31
  wrongContact:
    "A contra entry is for one contact who is both a customer and a supplier, and sets off that contact's own invoices and bills.",
  // FIN04
  notPosted: 'One of the invoices or bills is no longer posted. Reload the page and choose again.',
  // FIN05
  tooMuch: 'One of the invoices or bills owes less than the amount set off against it now. Reload the page to see what each still owes.',
  // FIN01. A menu offers only what the status allows, so this reaches a person only when the contra entry changed
  // under them in another tab. It says what may have happened, not what did.
  locked: 'That cannot be done to this contra entry as it now stands. It may have been posted or voided since this page was loaded.',
  // FIN11
  gone: 'That contra entry no longer exists.',
  // FIN33
  refundsDepend: 'Refunds paid on one of its invoices depend on this contra entry, so it cannot be voided.',
  // FIN14, 42501
  needsSignOff: 'Only an owner or admin can record, post or void contra entries.',
} as const;

const M = CONTRA_MESSAGES;

/* ---- inputs ----------------------------------------------------------- */

const contraId = z.string({ error: M.gone }).uuid(M.gone);
const documentId = z.string({ error: M.document }).uuid(M.document);

/** Text that may be empty: trimmed, at most `max` characters, and an empty box is stored as null. */
function boundedText(max: number, message: string) {
  return z
    .string({ error: message })
    .trim()
    .max(max, message)
    .transform((v) => (v === '' ? null : v))
    .nullable();
}

const invoiceLine = z.object({ invoice_id: documentId, amount: ringgitAmount(M.amount) });
const billLine = z.object({ bill_id: documentId, amount: ringgitAmount(M.amount) });

/**
 * A draft contra entry, saved whole each time: the header and every line. It may be saved unfinished (no bill
 * yet, or sides that do not add up); posting is where the database asks for both. Every caller sends every
 * field: `reference` and `notes` default to null, so leaving one out clears it.
 */
export const saveContraInput = z
  .object({
    /** Present to change a draft; absent to create one. */
    id: contraId.optional(),
    contact_id: z.string({ error: M.contact }).uuid(M.contact),
    contra_date: isoDate,
    amount: ringgitAmount(M.amount),
    reference: boundedText(100, M.reference).default(null),
    notes: boundedText(1000, M.notes).default(null),
    invoices: z.array(invoiceLine, { error: M.document }).max(CONTRA_LINES_MAX, M.tooManyLines),
    bills: z.array(billLine, { error: M.document }).max(CONTRA_LINES_MAX, M.tooManyLines),
  })
  .refine((v) => v.invoices.length + v.bills.length <= CONTRA_LINES_MAX, { message: M.tooManyLines, path: ['invoices'] })
  .refine((v) => new Set(v.invoices.map((l) => l.invoice_id)).size === v.invoices.length, {
    message: M.duplicate,
    path: ['invoices'],
  })
  .refine((v) => new Set(v.bills.map((l) => l.bill_id)).size === v.bills.length, { message: M.duplicate, path: ['bills'] });

export const contraIdInput = z.object({ id: contraId });

/* ---- refusals --------------------------------------------------------- */

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN04: M.notPosted,
  FIN05: M.tooMuch,
  FIN11: M.gone,
  [FIN_SIGN_OFF]: M.needsSignOff,
  [PG_FORBIDDEN]: M.needsSignOff,
  FIN29: M.unbalanced,
  FIN31: M.wrongContact,
  FIN33: M.refundsDepend,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

/**
 * FIN29 is raised for two things: an amount that is not above zero (save) and sides that do not add up (post).
 * Zod refuses the first before the database is asked, so on save the database's FIN29 is a direct call's, and
 * the amount sentence is the true one; on post it is the sides.
 */
function contraWriteFailed(fnName: string, error: unknown, on: 'save' | 'other' = 'other'): { ok: false; error: string } {
  const code = pgCode(error) ?? '';
  const refusal = code === 'FIN29' && on === 'save' ? M.amount : REFUSALS[code];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- types ------------------------------------------------------------ */

export type ContraStatus = 'draft' | 'posted' | 'void';

export type ContraLine = {
  id: string;
  kind: 'invoice' | 'bill';
  /** The invoice's or the bill's id. */
  document_id: string;
  /** INV-0001 or BILL-0001; null if the document could not be read. */
  document_no: string | null;
  amount: number;
};

export type ContraRow = {
  id: string;
  /** null while it is a draft. */
  contra_no: string | null;
  contra_date: string;
  contact_id: string;
  contact_name: string;
  amount: number;
  reference: string | null;
  notes: string | null;
  status: ContraStatus;
  posted_at: string | null;
  voided_at: string | null;
  invoices: ContraLine[];
  bills: ContraLine[];
};

/**
 * The answer to "Save and post". When the draft was saved but posting it was refused, `draftId` is that
 * draft, so the form goes on editing it instead of saving a second copy.
 */
export type SaveAndPostContraResult = FinResult<{ id: string; contra_no: string }> & { draftId?: string };

const CONTRA_COLUMNS = 'id,contra_no,contra_date,contact_id,amount,reference,notes,status,posted_at,voided_at';
const LINE_COLUMNS = 'id,contra_id,invoice_id,bill_id,amount';

/* ---- reads ------------------------------------------------------------ */

/** Most ids sent in one `in (...)` filter, so no request line grows with the number of contras. */
export const CONTRA_ID_CHUNK = 100;

/** Every row of a workspace table, a page at a time. Throws when a read fails, like the ledger's reads. */
async function readAll(
  ctx: FinanceWriteContext,
  table: string,
  columns: string,
  narrow?: { column: string; values: string[] },
): Promise<Record<string, unknown>[]> {
  if (!narrow) return readPages(ctx, table, columns);
  const rows: Record<string, unknown>[] = [];
  // Ids go CONTRA_ID_CHUNK at a time: the length of a request never depends on how many contras exist.
  for (let at = 0; at < narrow.values.length; at += CONTRA_ID_CHUNK) {
    const values = narrow.values.slice(at, at + CONTRA_ID_CHUNK);
    rows.push(...(await readPages(ctx, table, columns, { column: narrow.column, values })));
  }
  return rows;
}

async function readPages(
  ctx: FinanceWriteContext,
  table: string,
  columns: string,
  narrow?: { column: string; values: string[] },
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += CONTRA_PAGE_SIZE) {
    let query = ctx.client.from(table).select(columns).eq('org_id', ctx.orgId);
    if (narrow) query = query.in(narrow.column, narrow.values);
    const { data, error } = await query.order('id', { ascending: true }).range(from, from + CONTRA_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < CONTRA_PAGE_SIZE) return rows;
  }
}

const unique = (values: unknown[]) => [...new Set(values.filter((v): v is string => typeof v === 'string'))];

/** Every contra entry of the workspace, newest date first, each with its invoices and bills. */
export async function listContras(ctx: FinanceWriteContext): Promise<ContraRow[]> {
  const [contras, lines] = await Promise.all([
    readAll(ctx, 'finance_contras', CONTRA_COLUMNS),
    readAll(ctx, 'finance_contra_lines', LINE_COLUMNS),
  ]);
  const [contacts, invoices, bills] = await Promise.all([
    readAll(ctx, 'finance_contacts', 'id,name', { column: 'id', values: unique(contras.map((c) => c.contact_id)) }),
    readAll(ctx, 'finance_invoices', 'id,invoice_no', { column: 'id', values: unique(lines.map((l) => l.invoice_id)) }),
    readAll(ctx, 'supplier_bills', 'id,bill_no', { column: 'id', values: unique(lines.map((l) => l.bill_id)) }),
  ]);
  const name = new Map(contacts.map((c) => [c.id as string, String(c.name ?? '')]));
  const invoiceNo = new Map(invoices.map((i) => [i.id as string, (i.invoice_no as string | null) ?? null]));
  const billNo = new Map(bills.map((b) => [b.id as string, (b.bill_no as string | null) ?? null]));
  return contras
    .map((c) => {
      const own = lines.filter((l) => l.contra_id === c.id);
      const line = (l: Record<string, unknown>): ContraLine =>
        l.invoice_id
          ? { id: l.id as string, kind: 'invoice', document_id: l.invoice_id as string, document_no: invoiceNo.get(l.invoice_id as string) ?? null, amount: Number(l.amount) }
          : { id: l.id as string, kind: 'bill', document_id: l.bill_id as string, document_no: billNo.get(l.bill_id as string) ?? null, amount: Number(l.amount) };
      return {
        id: c.id as string,
        contra_no: (c.contra_no as string | null) ?? null,
        contra_date: c.contra_date as string,
        contact_id: c.contact_id as string,
        contact_name: name.get(c.contact_id as string) ?? '',
        amount: Number(c.amount),
        reference: (c.reference as string | null) ?? null,
        notes: (c.notes as string | null) ?? null,
        status: c.status as ContraStatus,
        posted_at: (c.posted_at as string | null) ?? null,
        voided_at: (c.voided_at as string | null) ?? null,
        invoices: own.filter((l) => l.invoice_id).map(line),
        bills: own.filter((l) => l.bill_id).map(line),
      };
    })
    .sort((a, b) => b.contra_date.localeCompare(a.contra_date) || (b.contra_no ?? '').localeCompare(a.contra_no ?? ''));
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft contra entry, or replaces a draft's header and lines. */
export async function saveContra(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveContraInput>,
): Promise<FinResult<{ id: string }>> {
  const { invoices, bills, ...contra } = saveContraInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_contra', {
    target_org: ctx.orgId,
    contra,
    lines: [...invoices, ...bills],
  });
  if (error || !data) return contraWriteFailed('saveContra', error, 'save');
  return { ok: true, data: { id: data as string } };
}

/** Posts a draft: it takes its CT- number, lowers what each invoice and bill owes, and enters the books. */
export async function postContra(
  ctx: FinanceWriteContext,
  input: z.input<typeof contraIdInput>,
): Promise<FinResult<{ id: string; contra_no: string }>> {
  const { id } = contraIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_post_contra', { target_org: ctx.orgId, target_contra: id });
  if (error || !data) return contraWriteFailed('postContra', error);
  return { ok: true, data: { id, contra_no: data as string } };
}

/** Saves the draft, then posts it. A refused post leaves the draft saved and says which one it is. */
export async function saveAndPostContra(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveContraInput>,
): Promise<SaveAndPostContraResult> {
  const saved = await saveContra(ctx, input);
  if (!saved.ok) return saved;
  const posted = await postContra(ctx, { id: saved.data.id });
  return posted.ok ? posted : { ...posted, draftId: saved.data.id };
}

/**
 * Voids a posted contra entry: its invoices and bills owe again what it had set off, and the books reverse it
 * on today's date (the database's, UTC).
 */
export async function voidContra(
  ctx: FinanceWriteContext,
  input: z.input<typeof contraIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = contraIdInput.parse(input);
  const { error } = await ctx.client.rpc('finance_void_contra', { target_org: ctx.orgId, target_contra: id });
  if (error) return contraWriteFailed('voidContra', error);
  return { ok: true, data: { id } };
}

/** Deletes a draft contra entry and its lines. A posted one is refused (void it). */
export async function deleteContra(
  ctx: FinanceWriteContext,
  input: z.input<typeof contraIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = contraIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_contras')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return contraWriteFailed('deleteContra', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id as string } };
}

/* ---- pure helpers for the screen --------------------------------------- */

export type ContraContact = { id: string; name: string; is_customer: boolean; is_supplier: boolean; active: boolean };

/** The contacts a contra entry can be for: active, and both a customer and a supplier. By name. */
export function contraContacts<T extends ContraContact>(contacts: T[]): T[] {
  return contacts
    .filter((c) => c.active && c.is_customer && c.is_supplier)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const toSen = (n: number) => Math.round(n * 100);

/**
 * The two sides of a contra entry against its amount, in ringgit, worked out in sen so that 0.1 + 0.2 is 0.3.
 * `ready` is what posting asks: at least one invoice and one bill, each side exactly the amount.
 */
export function contraSides(input: {
  amount: number;
  invoices: { amount: number }[];
  bills: { amount: number }[];
}): { invoiceSide: number; billSide: number; invoiceShort: number; billShort: number; ready: boolean } {
  const amount = toSen(input.amount);
  const invoiceSide = input.invoices.reduce((t, l) => t + toSen(l.amount), 0);
  const billSide = input.bills.reduce((t, l) => t + toSen(l.amount), 0);
  return {
    invoiceSide: invoiceSide / 100,
    billSide: billSide / 100,
    invoiceShort: (amount - invoiceSide) / 100,
    billShort: (amount - billSide) / 100,
    ready: amount > 0 && input.invoices.length > 0 && input.bills.length > 0 && invoiceSide === amount && billSide === amount,
  };
}

export type ContraAction = 'edit' | 'post' | 'delete' | 'void';

/** What a contra entry's row menu offers, in order: nothing without the sign-off. The database asks again. */
export function contraActions(status: ContraStatus, canSignOff: boolean): ContraAction[] {
  if (!canSignOff) return [];
  if (status === 'draft') return ['edit', 'post', 'delete'];
  if (status === 'posted') return ['void'];
  return [];
}
