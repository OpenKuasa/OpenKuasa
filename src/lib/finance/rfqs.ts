/**
 * RFQs (requests for quotation). An RFQ and its lines are saved by one
 * database function. Sending gives it its number; nothing is emailed. After
 * that only the supplier's answer is recorded: a price for every line, and
 * then the RFQ is quoted. Unlike a quotation, a line may have no price until
 * the supplier answers, so an RFQ stores no amounts: the totals view works
 * them out for the priced lines. org_id comes from the context.
 */
import { z } from 'zod';
import {
  DOCUMENT_LINES_MAX,
  LINE_MESSAGES,
  documentLine,
  isoDate,
  optionalText,
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

export const RFQ_LINES_MAX = DOCUMENT_LINES_MAX;
/** RFQs loaded for a screen, a page at a time. */
export const RFQ_PAGE_SIZE = 1000;

export const RFQ_MESSAGES = {
  supplier: 'Choose a supplier.',
  date: LINE_MESSAGES.date,
  dates: 'The reply-by date cannot be before the RFQ date.',
  lines: LINE_MESSAGES.lines,
  tooManyLines: `An RFQ can have at most ${RFQ_LINES_MAX} lines.`,
  description: LINE_MESSAGES.description,
  quantity: LINE_MESSAGES.quantity,
  price: LINE_MESSAGES.price,
  sst: LINE_MESSAGES.sst,
  tooLong: LINE_MESSAGES.tooLong,
  product: LINE_MESSAGES.product,
  gone: 'That RFQ no longer exists.',
  // FIN11 on saving a new RFQ that was copied from another: the one it was copied from is not there to copy.
  // The form then lets go of the link (rfqFormAfterRefusal), so saving again saves this RFQ without it.
  copiedFromGone: 'The RFQ this was copied from can no longer be found. Save again to keep this one on its own.',
  // FIN01. A menu offers only what an RFQ's status allows, so this reaches a person only when the RFQ
  // changed under them in another tab. It says what may have happened, not what did.
  locked:
    'That cannot be done to this RFQ as it now stands. It may have been sent, priced or closed since this page was loaded.',
  // FIN10
  empty: 'An RFQ needs at least one line.',
  // FIN19
  unpriced: 'Enter a price for every line before marking the RFQ as quoted.',
  numberTaken: 'That RFQ number is already used.',
  missing: 'The supplier or a product on this RFQ no longer exists.',
  // FIN22, or the database's one-order-per-RFQ key
  hasOrder: 'This RFQ already has a purchase order. Cancel that order first to make another.',
  // Compare quotes, when the group came apart since the page was loaded.
  nothingToCompare: 'There are no other quotes for this request to compare it with.',
} as const;

const M = RFQ_MESSAGES;

/**
 * An RFQ line is a document line whose price may be absent: the supplier has
 * not answered yet. A typed price, 0 included, is rounded to 4 places.
 */
export const rfqLine = documentLine.extend({
  unit_price: z
    .number({ error: M.price })
    .min(0, M.price)
    .max(999_999_999, M.price)
    .transform((v) => Math.round(v * 10 ** 4) / 10 ** 4)
    .nullable(),
});

/** The reply-by date is optional: a real date, or an empty box, or nothing. */
const replyBy = z
  .union([isoDate, z.literal(''), z.null()], { error: M.date })
  .transform((v) => (v === '' ? null : v));

export const saveRfqInput = z
  .object({
    /** Present to change a draft; absent to create one. */
    id: z.string({ error: M.gone }).uuid(M.gone).optional(),
    /** The RFQ a new draft was copied from. Only creating a draft sets it; the database then never changes it. */
    source_rfq_id: z.string({ error: M.gone }).uuid(M.gone).optional(),
    supplier_id: z.string({ error: M.supplier }).uuid(M.supplier),
    rfq_date: isoDate,
    reply_by: replyBy.default(null),
    notes: optionalText.default(null),
    lines: z.array(rfqLine, { error: M.lines }).min(1, M.lines).max(RFQ_LINES_MAX, M.tooManyLines),
  })
  .refine((v) => v.reply_by === null || v.reply_by >= v.rfq_date, { message: M.dates, path: ['reply_by'] });

export const rfqIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

/** The supplier's answer: a price for each line they priced, and their own reference if they gave one. */
export const quoteRfqInput = rfqIdInput.extend({
  supplier_ref: optionalText.default(null),
  prices: z
    .array(
      z.object({
        line_id: z.string({ error: M.gone }).uuid(M.gone),
        unit_price: z.number({ error: M.price }).min(0, M.price).max(999_999_999, M.price),
        /** Absent to keep the rate the line already has. */
        sst_rate: z.number({ error: M.sst }).min(0, M.sst).max(100, M.sst).optional(),
      }),
      { error: M.unpriced },
    )
    .min(1, M.unpriced),
});

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN10: M.empty,
  FIN11: M.gone,
  FIN19: M.unpriced,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function rfqWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

/** What a person sets. */
export type RfqStatus = 'draft' | 'sent' | 'quoted' | 'closed';

/** `overdue` is a sent RFQ past its reply-by date; it is worked out, never stored. */
export type RfqDisplayStatus = RfqStatus | 'overdue';

export type RfqListRow = {
  id: string;
  /** null while the RFQ is a draft. */
  rfq_no: string | null;
  supplier_id: string;
  supplier_name: string;
  rfq_date: string;
  reply_by: string | null;
  supplier_ref: string | null;
  status: RfqStatus;
  line_count: number;
  /** Priced lines only. */
  total: number;
  /**
   * When the supplier's answer was recorded (Record prices); null until then. A price on an RFQ
   * that has none was typed by the buyer, not quoted by the supplier.
   */
  quoted_at: string | null;
  /** The purchase order made from this RFQ, if one stands: a cancelled order does not count. */
  purchase_order_id: string | null;
  /** null when there is no order, and while that order is still a draft. */
  purchase_order_no: string | null;
  /**
   * The first RFQ of this one's group, when it was copied to another supplier: a copy of a copy
   * names the first too. null for the first RFQ itself, and for one that was never copied.
   */
  source_rfq_id: string | null;
};

export type RfqLine = {
  id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  uom: string | null;
  pack_size: string | null;
  /** null until the supplier answers. */
  unit_price: number | null;
  sst_rate: number;
};

export type RfqDetail = RfqListRow & {
  subtotal: number;
  sst_total: number;
  notes: string | null;
  lines: RfqLine[];
};

/**
 * The answer to "Save and mark as sent". When the draft was saved but sending
 * it was refused, `draftId` is that draft, so the form goes on editing it
 * instead of saving a second copy.
 */
export type SaveAndSendRfqResult = FinResult<{ id: string; rfq_no: string }> & { draftId?: string };

const LIST_COLUMNS =
  'id,rfq_no,supplier_id,supplier_name,rfq_date,reply_by,supplier_ref,status,line_count,total,quoted_at,purchase_order_id,purchase_order_no,source_rfq_id';

const LINE_COLUMNS = 'id,product_id,description,quantity,uom,pack_size,unit_price,sst_rate';

function toListRow(row: Record<string, unknown>): RfqListRow {
  return {
    ...(row as unknown as RfqListRow),
    line_count: Number(row.line_count),
    total: Number(row.total),
    quoted_at: (row.quoted_at as string | null) ?? null,
    purchase_order_id: (row.purchase_order_id as string | null) ?? null,
    purchase_order_no: (row.purchase_order_no as string | null) ?? null,
    source_rfq_id: (row.source_rfq_id as string | null) ?? null,
  };
}

function toRfqLine(row: Record<string, unknown>): RfqLine {
  return {
    ...(row as unknown as RfqLine),
    quantity: Number(row.quantity),
    // A null price is not 0: Number(null) would say so.
    unit_price: row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price),
    sst_rate: Number(row.sst_rate),
  };
}

/** Every RFQ in the workspace, newest first, read a page at a time. Drafts are included. */
export async function listRfqs(ctx: FinanceWriteContext): Promise<RfqListRow[]> {
  const rows: RfqListRow[] = [];
  for (let from = 0; ; from += RFQ_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_rfq_totals')
      .select(LIST_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('rfq_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + RFQ_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map(toListRow));
    if (page.length < RFQ_PAGE_SIZE) return rows;
  }
}

/** One RFQ with its lines in the order they were entered; null when it is not in this workspace or the id is not an id. */
export async function getRfq(ctx: FinanceWriteContext, id: string): Promise<RfqDetail | null> {
  // The database would throw on casting it; there is simply no such RFQ.
  if (!rfqIdInput.safeParse({ id }).success) return null;
  const { data: rfq, error } = await ctx.client
    .from('finance_rfq_totals')
    .select(`${LIST_COLUMNS},subtotal,sst_total,notes`)
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!rfq) return null;
  const { data: lines, error: linesError } = await ctx.client
    .from('finance_rfq_lines')
    .select(LINE_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('rfq_id', id)
    .order('position', { ascending: true })
    .order('id', { ascending: true });
  if (linesError) throw linesError;
  const { subtotal, sst_total, notes, ...header } = rfq as unknown as Record<string, unknown>;
  return {
    ...toListRow(header),
    subtotal: Number(subtotal),
    sst_total: Number(sst_total),
    notes: (notes as string | null) ?? null,
    lines: ((lines ?? []) as unknown as Record<string, unknown>[]).map(toRfqLine),
  };
}

/**
 * Every RFQ of one RFQ's group that has gone to its supplier, with its lines, in the order they were
 * made: the first RFQ, then its copies. Drafts are left out, as nothing has been asked of their supplier yet. Empty when
 * the RFQ is not in this workspace or the id is not an id.
 */
export async function getRfqGroup(ctx: FinanceWriteContext, id: string): Promise<RfqDetail[]> {
  const rfq = await getRfq(ctx, id);
  if (!rfq) return [];
  const first = rfq.source_rfq_id ?? rfq.id;
  const { data, error } = await ctx.client
    .from('finance_rfq_totals')
    .select('id')
    .eq('org_id', ctx.orgId)
    .or(`id.eq.${first},source_rfq_id.eq.${first}`)
    .neq('status', 'draft')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  // One read per RFQ: a group is the few suppliers asked for the same thing.
  const group = await Promise.all(((data ?? []) as { id: string }[]).map((row) => getRfq(ctx, row.id)));
  return group.filter((r): r is RfqDetail => r !== null);
}

/* ---- writes ----------------------------------------------------------- */

/**
 * Creates a draft RFQ, or replaces a draft's header and lines. FIN11 on a new RFQ can only be about the
 * RFQ it was copied from: nothing else is looked up when a draft is created. It gets its own sentence,
 * so the person is not told that the RFQ in front of them is gone.
 */
export async function saveRfq(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveRfqInput>,
): Promise<FinResult<{ id: string }>> {
  const { lines, ...rfq } = saveRfqInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_rfq', {
    target_org: ctx.orgId,
    rfq,
    lines,
  });
  if (error || !data) {
    if (pgCode(error) === 'FIN11' && !rfq.id && rfq.source_rfq_id) return { ok: false, error: M.copiedFromGone };
    return rfqWriteFailed('saveRfq', error);
  }
  return { ok: true, data: { id: data as string } };
}

/** Marks a draft as sent: it gets its number and can no longer be edited. Nothing is emailed. */
export async function sendRfq(
  ctx: FinanceWriteContext,
  input: z.input<typeof rfqIdInput>,
): Promise<FinResult<{ id: string; rfq_no: string }>> {
  const { id } = rfqIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_send_rfq', {
    target_org: ctx.orgId,
    target_rfq: id,
  });
  if (error || !data) return rfqWriteFailed('sendRfq', error);
  return { ok: true, data: { id, rfq_no: data as string } };
}

/**
 * Records the supplier's prices on a sent RFQ and marks it quoted. The
 * database function returns nothing, so success is the absence of an error.
 */
export async function quoteRfq(
  ctx: FinanceWriteContext,
  input: z.input<typeof quoteRfqInput>,
): Promise<FinResult<{ id: string }>> {
  const { id, prices, supplier_ref } = quoteRfqInput.parse(input);
  const { error } = await ctx.client.rpc('finance_quote_rfq', {
    target_org: ctx.orgId,
    target_rfq: id,
    prices,
    supplier_reference: supplier_ref,
  });
  if (error) return rfqWriteFailed('quoteRfq', error);
  return { ok: true, data: { id } };
}

/** The supplier declined, or the RFQ was not taken up. The database function returns nothing. */
export async function closeRfq(
  ctx: FinanceWriteContext,
  input: z.input<typeof rfqIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = rfqIdInput.parse(input);
  const { error } = await ctx.client.rpc('finance_close_rfq', {
    target_org: ctx.orgId,
    target_rfq: id,
  });
  if (error) return rfqWriteFailed('closeRfq', error);
  return { ok: true, data: { id } };
}

/** Deletes a draft RFQ and its lines. */
export async function deleteRfq(
  ctx: FinanceWriteContext,
  input: z.input<typeof rfqIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = rfqIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_rfqs')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return rfqWriteFailed('deleteRfq', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/**
 * Makes a draft purchase order from a quoted RFQ: the same supplier, notes and
 * lines, dated today. The RFQ stays quoted. Refused while a purchase order
 * made from it stands; a cancelled one frees it.
 */
export async function convertRfq(
  ctx: FinanceWriteContext,
  input: z.input<typeof rfqIdInput>,
): Promise<FinResult<{ id: string; purchase_order_id: string }>> {
  const { id } = rfqIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_convert_rfq', {
    target_org: ctx.orgId,
    target_rfq: id,
  });
  if (error || !data) {
    // Here a clash on the unique key is the second order for one RFQ, not a taken number.
    const code = pgCode(error);
    if (code === 'FIN22' || code === PG_UNIQUE) return { ok: false, error: M.hasOrder };
    return rfqWriteFailed('convertRfq', error);
  }
  return { ok: true, data: { id, purchase_order_id: data as string } };
}
