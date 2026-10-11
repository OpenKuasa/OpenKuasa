/**
 * Sales invoices. An invoice and its lines are saved by one database
 * function, so a failure cannot leave half an invoice. Posting gives the
 * invoice its number and locks it; after that it can only be voided, and only
 * while no money is allocated to it. org_id comes from the context.
 */
import { z } from 'zod';
import {
  DOCUMENT_LINES_MAX,
  DOCUMENT_LINE_COLUMNS,
  type DocumentLineRow,
  LINE_MESSAGES,
  documentLine,
  isoDate,
  optionalText,
  toDocumentLine,
} from './document-lines';
import {
  type FinResult,
  type FinanceWriteContext,
  NOT_ALLOWED,
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
  locked: 'This invoice is posted and can no longer be changed. Void it instead.',
  hasPayments: 'This invoice has payments. Void them before voiding it.',
  empty: 'An invoice needs at least one line with an amount.',
  numberTaken: 'That invoice number is already used.',
  missing: 'The customer or a product on this invoice no longer exists.',
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
    lines: z.array(documentLine, { error: M.lines }).min(1, M.lines).max(INVOICE_LINES_MAX, M.tooManyLines),
  })
  .refine((v) => v.due_date >= v.invoice_date, { message: M.dates, path: ['due_date'] });

export const invoiceIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN02: M.hasPayments,
  FIN10: M.empty,
  FIN11: M.gone,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function invoiceWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

/** `sent` is a posted invoice that is not yet paid in full and not past its due date. */
export type InvoiceDisplayStatus = 'draft' | 'sent' | 'overdue' | 'paid' | 'void';

/** What a person has recorded about the invoice's e-Invois at LHDN. Nothing is submitted by this app. */
export type EInvoiceStatus = 'none' | 'pending' | 'validated' | 'rejected';

export type InvoiceListRow = {
  id: string;
  /** null while the invoice is a draft. */
  invoice_no: string | null;
  customer_id: string;
  customer_name: string;
  invoice_date: string;
  due_date: string;
  total: number;
  paid: number;
  balance: number;
  display_status: InvoiceDisplayStatus;
  einvoice_status: EInvoiceStatus;
};

export type InvoiceLine = DocumentLineRow;

export type InvoiceDetail = InvoiceListRow & {
  subtotal: number;
  sst: number;
  notes: string | null;
  einvoice_uuid: string | null;
  lines: InvoiceLine[];
};

const LIST_COLUMNS =
  'id,invoice_no,customer_id,customer_name,invoice_date,due_date,total,paid,balance,display_status,einvoice_status';

function toListRow(row: Record<string, unknown>): InvoiceListRow {
  return {
    ...(row as unknown as InvoiceListRow),
    total: Number(row.total),
    paid: Number(row.paid),
    balance: Number(row.balance),
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
    .select(`${LIST_COLUMNS},subtotal,sst,notes,einvoice_uuid`)
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!invoice) return null;
  const { data: lines, error: linesError } = await ctx.client
    .from('finance_invoice_lines')
    .select(DOCUMENT_LINE_COLUMNS)
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
    einvoice_uuid: (header.einvoice_uuid as string | null) ?? null,
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
