/**
 * Sales invoices. An invoice and its lines are saved by one database
 * function, so a failure cannot leave half an invoice. Posting gives the
 * invoice its number and locks it; after that it can only be voided, and only
 * while no money is allocated to it. org_id comes from the context.
 */
import { z } from 'zod';
import {
  DOCUMENT_LINES_MAX,
  type DocumentLineRow,
  LINE_MESSAGES,
  SALES_LINE_COLUMNS,
  isoDate,
  optionalText,
  salesDocumentLine,
  toDocumentLine,
} from './document-lines';
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

export const INVOICE_LINES_MAX = DOCUMENT_LINES_MAX;
/** Invoices loaded for a screen, a page at a time. */
export const INVOICE_PAGE_SIZE = 1000;
/** What a person can record about an invoice's e-Invois at LHDN. Nothing is submitted by this app. */
export const EINVOICE_STATUSES = ['none', 'pending', 'validated', 'rejected'] as const;
/** LHDN's own UUIDs are 26 characters; the column is plain text, so this is only a sane ceiling. */
export const EINVOICE_UUID_MAX = 100;

export const INVOICE_MESSAGES = {
  customer: 'Choose a customer.',
  date: LINE_MESSAGES.date,
  dates: 'The due date cannot be before the invoice date.',
  lines: LINE_MESSAGES.lines,
  tooManyLines: `An invoice can have at most ${INVOICE_LINES_MAX} lines.`,
  description: LINE_MESSAGES.description,
  quantity: LINE_MESSAGES.quantity,
  price: LINE_MESSAGES.price,
  sst: LINE_MESSAGES.sst,
  tooLong: LINE_MESSAGES.tooLong,
  product: LINE_MESSAGES.product,
  gone: 'That invoice no longer exists.',
  // FIN01. The menus offer only what an invoice's status allows, so this reaches a person only when the
  // invoice changed under them: a draft posted or a posted invoice voided in another tab. True of each.
  locked: 'This invoice has been posted or voided, so that can no longer be done.',
  // FIN02. Money in against the invoice, or a refund put against the invoice itself.
  hasPayments: 'This invoice has payments or refunds. Void the payments on Payments In, and void or delete the refunds on Refunds, before voiding it.',
  // FIN12. A draft credit note holds the invoice as much as an issued one does.
  hasCreditNotes: 'This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it.',
  empty: 'An invoice needs at least one line with an amount.',
  numberTaken: 'That invoice number is already used.',
  missing: 'The customer or a product on this invoice no longer exists.',
  einvoiceStatus: 'Choose an e-Invois status.',
  einvoiceUuid: `Keep the UUID to ${EINVOICE_UUID_MAX} characters or fewer.`,
  einvoiceNone: 'An invoice with no e-Invois status has no UUID. Clear the UUID, or choose a status.',
  einvoiceDraft: 'e-Invois details can be recorded once the invoice is posted.',
} as const;

const M = INVOICE_MESSAGES;

export const saveInvoiceInput = z
  .object({
    /** Present to change a draft; absent to create one. */
    id: z.string({ error: M.gone }).uuid(M.gone).optional(),
    customer_id: z.string({ error: M.customer }).uuid(M.customer),
    invoice_date: isoDate,
    due_date: isoDate,
    notes: optionalText.default(null),
    lines: z.array(salesDocumentLine, { error: M.lines }).min(1, M.lines).max(INVOICE_LINES_MAX, M.tooManyLines),
  })
  .refine((v) => v.due_date >= v.invoice_date, { message: M.dates, path: ['due_date'] });

export const invoiceIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

/** What a person has recorded about a posted invoice's e-Invois: its status at LHDN and the UUID LHDN gave it. */
export const setEInvoiceInput = z
  .object({
    id: z.string({ error: M.gone }).uuid(M.gone),
    einvoice_status: z.enum(EINVOICE_STATUSES, { error: M.einvoiceStatus }),
    /** Trimmed; an empty box is stored as null. */
    einvoice_uuid: z
      .string({ error: M.einvoiceUuid })
      .trim()
      .max(EINVOICE_UUID_MAX, M.einvoiceUuid)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .default(null),
  })
  .refine((v) => v.einvoice_status !== 'none' || v.einvoice_uuid === null, {
    message: M.einvoiceNone,
    path: ['einvoice_uuid'],
  });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN02: M.hasPayments,
  FIN10: M.empty,
  FIN11: M.gone,
  FIN12: M.hasCreditNotes,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [FIN_SIGN_OFF]: NEEDS_SIGN_OFF,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function invoiceWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

/**
 * `sent` is a posted invoice that is still owed and not past its due date.
 * `paid` is a posted invoice with nothing left to pay: settled by money in,
 * by credit notes, or both. Its balance is zero, or below zero when the
 * customer is in credit.
 */
export type InvoiceDisplayStatus = 'draft' | 'sent' | 'overdue' | 'paid' | 'void';

/** What a person has recorded about the invoice's e-Invois at LHDN. Nothing is submitted by this app. */
export type EInvoiceStatus = (typeof EINVOICE_STATUSES)[number];

export type InvoiceListRow = {
  id: string;
  /** null while the invoice is a draft. */
  invoice_no: string | null;
  customer_id: string;
  customer_name: string;
  invoice_date: string;
  due_date: string;
  total: number;
  /** Posted money in. */
  paid: number;
  /** Issued credit notes. */
  credited: number;
  /** Posted refunds, put against the invoice itself or against one of its credit notes. */
  refunded: number;
  /** total − paid − credited + refunded. Below zero, the customer is in credit by that much. */
  balance: number;
  display_status: InvoiceDisplayStatus;
  einvoice_status: EInvoiceStatus;
  /** The UUID LHDN gave the e-Invois, as a person typed it in; null when none was recorded. */
  einvoice_uuid: string | null;
};

export type InvoiceLine = DocumentLineRow;

export type InvoiceDetail = InvoiceListRow & {
  subtotal: number;
  sst: number;
  notes: string | null;
  lines: InvoiceLine[];
};

/**
 * The answer to "Save and post". When the draft was saved but posting it was
 * refused, `draftId` is that draft, so the form goes on editing it instead of
 * saving a second copy.
 */
export type SaveAndPostInvoiceResult = FinResult<{ id: string; invoice_no: string }> & { draftId?: string };

const LIST_COLUMNS =
  'id,invoice_no,customer_id,customer_name,invoice_date,due_date,total,paid,credited,refunded,balance,display_status,einvoice_status,einvoice_uuid';

function toListRow(row: Record<string, unknown>): InvoiceListRow {
  return {
    ...(row as unknown as InvoiceListRow),
    total: Number(row.total),
    paid: Number(row.paid),
    credited: Number(row.credited),
    refunded: Number(row.refunded),
    balance: Number(row.balance),
    einvoice_uuid: (row.einvoice_uuid as string | null) ?? null,
  };
}

/** Every invoice in the workspace, newest first, read a page at a time. Drafts and void ones are included. */
export async function listInvoices(ctx: FinanceWriteContext): Promise<InvoiceListRow[]> {
  const rows: InvoiceListRow[] = [];
  for (let from = 0; ; from += INVOICE_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_invoice_totals')
      .select(LIST_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + INVOICE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map(toListRow));
    if (page.length < INVOICE_PAGE_SIZE) return rows;
  }
}

/** One invoice with its lines in the order they were entered; null when it is not in this workspace or the id is not an id. */
export async function getInvoice(ctx: FinanceWriteContext, id: string): Promise<InvoiceDetail | null> {
  // The database would throw on casting it; there is simply no such invoice.
  if (!invoiceIdInput.safeParse({ id }).success) return null;
  const { data: invoice, error } = await ctx.client
    .from('finance_invoice_totals')
    .select(`${LIST_COLUMNS},subtotal,sst,notes`)
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!invoice) return null;
  const { data: lines, error: linesError } = await ctx.client
    .from('finance_invoice_lines')
    .select(SALES_LINE_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('invoice_id', id)
    .order('position', { ascending: true })
    .order('id', { ascending: true });
  if (linesError) throw linesError;
  const header = invoice as unknown as Record<string, unknown>;
  return {
    ...toListRow(header),
    subtotal: Number(header.subtotal),
    sst: Number(header.sst),
    notes: (header.notes as string | null) ?? null,
    lines: ((lines ?? []) as unknown as Record<string, unknown>[]).map(toDocumentLine),
  };
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft invoice, or replaces a draft's header and lines. */
export async function saveInvoice(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveInvoiceInput>,
): Promise<FinResult<{ id: string }>> {
  const { lines, ...invoice } = saveInvoiceInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_invoice', {
    target_org: ctx.orgId,
    invoice,
    lines,
  });
  if (error || !data) return invoiceWriteFailed('saveInvoice', error);
  return { ok: true, data: { id: data as string } };
}

/** Posts a draft: it gets its number and can no longer be edited. */
export async function postInvoice(
  ctx: FinanceWriteContext,
  input: z.input<typeof invoiceIdInput>,
): Promise<FinResult<{ id: string; invoice_no: string }>> {
  const { id } = invoiceIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_post_invoice', {
    target_org: ctx.orgId,
    target_invoice: id,
  });
  if (error || !data) return invoiceWriteFailed('postInvoice', error);
  return { ok: true, data: { id, invoice_no: data as string } };
}

/** Voids a posted invoice. Refused while it has payments. */
export async function voidInvoice(
  ctx: FinanceWriteContext,
  input: z.input<typeof invoiceIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = invoiceIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_invoices')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return invoiceWriteFailed('voidInvoice', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Deletes a draft invoice and its lines. */
export async function deleteInvoice(
  ctx: FinanceWriteContext,
  input: z.input<typeof invoiceIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = invoiceIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_invoices')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return invoiceWriteFailed('deleteInvoice', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/**
 * Records what a person knows of a posted invoice's e-Invois. These two
 * columns, with updated_at, are all the database lets change on a posted
 * invoice. Nothing is sent to LHDN.
 */
export async function setEInvoice(
  ctx: FinanceWriteContext,
  input: z.input<typeof setEInvoiceInput>,
): Promise<FinResult<{ id: string }>> {
  const { id, einvoice_status, einvoice_uuid } = setEInvoiceInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_invoices')
    .update({ einvoice_status, einvoice_uuid, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  // A draft has not gone anywhere, so the table's check constraint refuses an e-Invois on it.
  if (pgCode(error) === PG_CHECK) return { ok: false, error: M.einvoiceDraft };
  if (error) return invoiceWriteFailed('setEInvoice', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
