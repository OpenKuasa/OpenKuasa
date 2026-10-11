/**
 * Quotations. A quotation and its lines are saved by one database function.
 * Sending gives it its number and locks what the customer was given; nothing
 * is emailed. After that only the customer's answer is recorded: accepted or
 * declined. An accepted quotation becomes a draft invoice with the same
 * lines. org_id comes from the context.
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

export const QUOTATION_LINES_MAX = DOCUMENT_LINES_MAX;
/** Quotations loaded for a screen, a page at a time. */
export const QUOTATION_PAGE_SIZE = 1000;

export const QUOTATION_MESSAGES = {
  customer: 'Choose a customer.',
  date: LINE_MESSAGES.date,
  dates: 'The valid-until date cannot be before the quotation date.',
  lines: LINE_MESSAGES.lines,
  tooManyLines: `A quotation can have at most ${QUOTATION_LINES_MAX} lines.`,
  description: LINE_MESSAGES.description,
  quantity: LINE_MESSAGES.quantity,
  price: LINE_MESSAGES.price,
  sst: LINE_MESSAGES.sst,
  tooLong: LINE_MESSAGES.tooLong,
  product: LINE_MESSAGES.product,
  gone: 'That quotation no longer exists.',
  // FIN01. A menu offers only what a quotation's status allows, so this reaches a person only when the
  // quotation changed under them in another tab: a draft that was sent meanwhile being saved, sent or
  // deleted, or an answer being recorded that is already the answer. It says what may have happened, not
  // what did, so it is not false of a draft answered by a direct call either; the list behind the message
  // has been refreshed and shows the quotation as it is.
  locked:
    'That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.',
  // FIN04
  notAccepted: 'Only an accepted quotation can be made into an invoice.',
  // FIN13
  hasInvoice: 'This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first.',
  empty: 'A quotation needs at least one line with an amount.',
  numberTaken: 'That quotation number is already used.',
  missing: 'The customer or a product on this quotation no longer exists.',
} as const;

const M = QUOTATION_MESSAGES;

export const saveQuotationInput = z
  .object({
    /** Present to change a draft; absent to create one. */
    id: z.string({ error: M.gone }).uuid(M.gone).optional(),
    customer_id: z.string({ error: M.customer }).uuid(M.customer),
    quote_date: isoDate,
    valid_until: isoDate,
    notes: optionalText.default(null),
    lines: z.array(documentLine, { error: M.lines }).min(1, M.lines).max(QUOTATION_LINES_MAX, M.tooManyLines),
  })
  .refine((v) => v.valid_until >= v.quote_date, { message: M.dates, path: ['valid_until'] });

export const quotationIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN04: M.notAccepted,
  FIN10: M.empty,
  FIN11: M.gone,
  FIN13: M.hasInvoice,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

/**
 * Converting. A unique violation here is not a number (a draft invoice has
 * none): it is the index that allows one invoice per quotation, met by two
 * conversions at the same moment.
 */
const CONVERT_REFUSALS: Record<string, string> = { ...REFUSALS, [PG_UNIQUE]: M.hasInvoice };

function quotationWriteFailed(
  fnName: string,
  error: unknown,
  refusals: Record<string, string> = REFUSALS,
): { ok: false; error: string } {
  const refusal = refusals[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

/** What a person sets. */
export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'declined';

/** `expired` is a sent quotation past its valid-until date; it is worked out, never stored. */
export type QuotationDisplayStatus = QuotationStatus | 'expired';

export type QuotationListRow = {
  id: string;
  /** null while the quotation is a draft. */
  quotation_no: string | null;
  customer_id: string;
  customer_name: string;
  quote_date: string;
  valid_until: string;
  total: number;
  display_status: QuotationDisplayStatus;
  /** The UTC date an accepted quotation was accepted on; null for every other status. */
  accepted_on: string | null;
  /** The invoice made from this quotation, if one stands: a void invoice does not count. */
  invoice_id: string | null;
  /** null when there is no invoice, and while that invoice is still a draft. */
  invoice_no: string | null;
};

export type QuotationLine = DocumentLineRow;

export type QuotationDetail = QuotationListRow & {
  subtotal: number;
  sst: number;
  notes: string | null;
  lines: QuotationLine[];
};

/**
 * The answer to "Save and mark as sent". When the draft was saved but sending
 * it was refused, `draftId` is that draft, so the form goes on editing it
 * instead of saving a second copy.
 */
export type SaveAndSendQuotationResult = FinResult<{ id: string; quotation_no: string }> & { draftId?: string };

const LIST_COLUMNS =
  'id,quotation_no,customer_id,customer_name,quote_date,valid_until,total,display_status,accepted_at,invoice_id,invoice_no';

function toListRow(row: Record<string, unknown>): QuotationListRow {
  const { accepted_at, ...rest } = row;
  return {
    ...(rest as unknown as QuotationListRow),
    total: Number(row.total),
    // A timestamp such as 2026-10-08T03:15:00+00:00: the database answers in UTC, so its first ten characters are the UTC date.
    accepted_on: typeof accepted_at === 'string' ? accepted_at.slice(0, 10) : null,
    invoice_id: (row.invoice_id as string | null) ?? null,
    invoice_no: (row.invoice_no as string | null) ?? null,
  };
}

/** Every quotation in the workspace, newest first, read a page at a time. Drafts are included. */
export async function listQuotations(ctx: FinanceWriteContext): Promise<QuotationListRow[]> {
  const rows: QuotationListRow[] = [];
  for (let from = 0; ; from += QUOTATION_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_quotation_totals')
      .select(LIST_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('quote_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + QUOTATION_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map(toListRow));
    if (page.length < QUOTATION_PAGE_SIZE) return rows;
  }
}

/** One quotation with its lines in the order they were entered; null when it is not in this workspace or the id is not an id. */
export async function getQuotation(ctx: FinanceWriteContext, id: string): Promise<QuotationDetail | null> {
  // The database would throw on casting it; there is simply no such quotation.
  if (!quotationIdInput.safeParse({ id }).success) return null;
  const { data: quotation, error } = await ctx.client
    .from('finance_quotation_totals')
    .select(`${LIST_COLUMNS},subtotal,sst,notes`)
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!quotation) return null;
  const { data: lines, error: linesError } = await ctx.client
    .from('finance_quotation_lines')
    .select(DOCUMENT_LINE_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('quotation_id', id)
    .order('position', { ascending: true })
    .order('id', { ascending: true });
  if (linesError) throw linesError;
  const { subtotal, sst, notes, ...header } = quotation as unknown as Record<string, unknown>;
  return {
    ...toListRow(header),
    subtotal: Number(subtotal),
    sst: Number(sst),
    notes: (notes as string | null) ?? null,
    lines: ((lines ?? []) as unknown as Record<string, unknown>[]).map(toDocumentLine),
  };
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft quotation, or replaces a draft's header and lines. */
export async function saveQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveQuotationInput>,
): Promise<FinResult<{ id: string }>> {
  const { lines, ...quotation } = saveQuotationInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_quotation', {
    target_org: ctx.orgId,
    quotation,
    lines,
  });
  if (error || !data) return quotationWriteFailed('saveQuotation', error);
  return { ok: true, data: { id: data as string } };
}

/** Marks a draft as sent: it gets its number and can no longer be edited. Nothing is emailed. */
export async function sendQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof quotationIdInput>,
): Promise<FinResult<{ id: string; quotation_no: string }>> {
  const { id } = quotationIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_send_quotation', {
    target_org: ctx.orgId,
    target_quotation: id,
  });
  if (error || !data) return quotationWriteFailed('sendQuotation', error);
  return { ok: true, data: { id, quotation_no: data as string } };
}

/** Records the customer's answer. The database lets it be changed from one answer to the other until an invoice is made. */
async function answerQuotation(
  ctx: FinanceWriteContext,
  fnName: string,
  input: z.input<typeof quotationIdInput>,
  status: 'accepted' | 'declined',
): Promise<FinResult<{ id: string }>> {
  const { id } = quotationIdInput.parse(input);
  const now = new Date().toISOString();
  const { data, error } = await ctx.client
    .from('finance_quotations')
    .update({ status, accepted_at: status === 'accepted' ? now : null, updated_at: now })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return quotationWriteFailed(fnName, error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** The customer said yes. Allowed on a sent quotation, expired or not, and on a declined one. */
export async function acceptQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof quotationIdInput>,
): Promise<FinResult<{ id: string }>> {
  return answerQuotation(ctx, 'acceptQuotation', input, 'accepted');
}

/** The customer said no, or the quotation was withdrawn. Refused once the quotation has an invoice. */
export async function declineQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof quotationIdInput>,
): Promise<FinResult<{ id: string }>> {
  return answerQuotation(ctx, 'declineQuotation', input, 'declined');
}

/** Deletes a draft quotation and its lines. */
export async function deleteQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof quotationIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = quotationIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_quotations')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return quotationWriteFailed('deleteQuotation', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Makes a draft invoice from an accepted quotation, with the same lines. Answers with the invoice's id. */
export async function convertQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof quotationIdInput>,
): Promise<FinResult<{ id: string; invoice_id: string }>> {
  const { id } = quotationIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_convert_quotation', {
    target_org: ctx.orgId,
    target_quotation: id,
  });
  if (error || !data) return quotationWriteFailed('convertQuotation', error, CONVERT_REFUSALS);
  return { ok: true, data: { id, invoice_id: data as string } };
}
