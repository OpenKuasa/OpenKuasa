/**
 * Supplier bills. A bill and its lines are saved by one database function, so
 * a failure cannot leave half a bill. Posting gives the bill its number and
 * locks it; after that it can only be voided. org_id comes from the context.
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

// Defined in document-lines.ts, which invoices share; exported from here for this module's existing importers.
export { isIsoDate, roundRate } from './document-lines';

export const BILL_LINES_MAX = DOCUMENT_LINES_MAX;
/** Bills loaded for a screen, a page at a time. */
export const BILL_PAGE_SIZE = 1000;

export const BILL_MESSAGES = {
  supplier: 'Choose a supplier.',
  date: LINE_MESSAGES.date,
  dates: 'The due date cannot be before the bill date.',
  lines: LINE_MESSAGES.lines,
  tooManyLines: `A bill can have at most ${BILL_LINES_MAX} lines.`,
  description: LINE_MESSAGES.description,
  quantity: LINE_MESSAGES.quantity,
  price: LINE_MESSAGES.price,
  sst: LINE_MESSAGES.sst,
  tooLong: LINE_MESSAGES.tooLong,
  gone: 'That bill no longer exists.',
  locked: 'This bill is posted and can no longer be changed. Void it instead.',
  hasPayments: 'This bill has payments. Void or delete them before voiding it.',
  empty: 'A bill needs at least one line with an amount.',
  numberTaken: 'That bill number is already used.',
  missing: 'The supplier or a product on this bill no longer exists.',
  product: LINE_MESSAGES.product,
  // FIN21
  order: 'Choose an approved purchase order from this supplier, or none.',
} as const;

const M = BILL_MESSAGES;

/** The purchase order a bill is raised against: an id, or an empty box or null for none. */
const purchaseOrderLink = z
  .union([z.string().uuid(M.order), z.literal(''), z.null()], { error: M.order })
  .transform((v) => (v === '' ? null : v));

export const saveBillInput = z
  .object({
    /** Present to change a draft; absent to create one. */
    id: z.string({ error: M.gone }).uuid(M.gone).optional(),
    supplier_id: z.string({ error: M.supplier }).uuid(M.supplier),
    supplier_ref: optionalText.default(null),
    bill_date: isoDate,
    due_date: isoDate,
    /** Left out when the input has none, so changing a draft keeps the order it is linked to. */
    purchase_order_id: purchaseOrderLink.optional(),
    notes: optionalText.default(null),
    lines: z.array(documentLine, { error: M.lines }).min(1, M.lines).max(BILL_LINES_MAX, M.tooManyLines),
  })
  .refine((v) => v.due_date >= v.bill_date, { message: M.dates, path: ['due_date'] });

export const billIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN02: M.hasPayments,
  FIN10: M.empty,
  FIN11: M.gone,
  FIN21: M.order,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [FIN_SIGN_OFF]: NEEDS_SIGN_OFF,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function billWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

export type BillDisplayStatus = 'draft' | 'pending' | 'overdue' | 'paid' | 'void';

export type BillListRow = {
  id: string;
  bill_no: string | null;
  supplier_id: string;
  supplier_name: string;
  bill_date: string;
  due_date: string;
  total: number;
  paid: number;
  balance: number;
  display_status: BillDisplayStatus;
  /** The purchase order the bill is raised against, with its number; null when it has none. */
  purchase_order_id: string | null;
  purchase_order_no: string | null;
};

export type BillLine = DocumentLineRow;

export type BillDetail = BillListRow & { supplier_ref: string | null; notes: string | null; lines: BillLine[] };

/**
 * The answer to "Save and post". When the draft was saved but posting it was
 * refused, `draftId` is that draft, so the form goes on editing it instead of
 * saving a second copy.
 */
export type SaveAndPostResult = FinResult<{ id: string; bill_no: string }> & { draftId?: string };

const LIST_COLUMNS = 'id,bill_no,supplier_id,supplier_name,bill_date,due_date,total,paid,balance,display_status';

/** Who a bill's order is: bill id → the order's id and number. */
type BillOrderLinks = Map<string, { id: string; no: string | null }>;

/**
 * The order of each linked bill, read from its own view because the totals view the list reads does not carry
 * it. `billId` narrows the read to one bill. Like the other reads here it throws when it fails: a list that
 * quietly showed every bill as unlinked would be wrong, not just incomplete.
 */
async function readOrderLinks(ctx: FinanceWriteContext, billId?: string): Promise<BillOrderLinks> {
  const links: BillOrderLinks = new Map();
  for (let from = 0; ; from += BILL_PAGE_SIZE) {
    let query = ctx.client.from('finance_bill_purchase_orders').select('bill_id,purchase_order_id,po_no').eq('org_id', ctx.orgId);
    if (billId) query = query.eq('bill_id', billId);
    const { data, error } = await query.order('bill_id', { ascending: true }).range(from, from + BILL_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as { bill_id: string; purchase_order_id: string; po_no: string | null }[];
    for (const l of page) links.set(l.bill_id, { id: l.purchase_order_id, no: l.po_no });
    if (page.length < BILL_PAGE_SIZE) return links;
  }
}

function toListRow(row: Record<string, unknown>, links: BillOrderLinks): BillListRow {
  const order = links.get(row.id as string);
  return {
    ...(row as unknown as BillListRow),
    purchase_order_id: order?.id ?? null,
    purchase_order_no: order?.no ?? null,
    total: Number(row.total),
    paid: Number(row.paid),
    balance: Number(row.balance),
  };
}

/** Every bill in the workspace, newest first, read a page at a time. */
export async function listBills(ctx: FinanceWriteContext): Promise<BillListRow[]> {
  const rows: BillListRow[] = [];
  const links = await readOrderLinks(ctx);
  for (let from = 0; ; from += BILL_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('supplier_bill_totals')
      .select(LIST_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('bill_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + BILL_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map((r) => toListRow(r, links)));
    if (page.length < BILL_PAGE_SIZE) return rows;
  }
}

/** One bill with its lines, for the form; null when it is not in this workspace or the id is not an id. */
export async function getBill(ctx: FinanceWriteContext, id: string): Promise<BillDetail | null> {
  // The database would throw on casting it; there is simply no such bill.
  if (!billIdInput.safeParse({ id }).success) return null;
  const { data: bill, error } = await ctx.client
    .from('supplier_bill_totals')
    .select(`${LIST_COLUMNS},supplier_ref,notes`)
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!bill) return null;
  const { data: lines, error: linesError } = await ctx.client
    .from('supplier_bill_lines')
    .select(DOCUMENT_LINE_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('bill_id', id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (linesError) throw linesError;
  const links = await readOrderLinks(ctx, id);
  const header = bill as unknown as Record<string, unknown>;
  return {
    ...toListRow(header, links),
    supplier_ref: (header.supplier_ref as string | null) ?? null,
    notes: (header.notes as string | null) ?? null,
    lines: ((lines ?? []) as unknown as Record<string, unknown>[]).map(toDocumentLine),
  };
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft bill, or replaces a draft's header and lines. */
export async function saveBill(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveBillInput>,
): Promise<FinResult<{ id: string }>> {
  const { lines, ...bill } = saveBillInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_bill', {
    target_org: ctx.orgId,
    bill,
    lines,
  });
  if (error || !data) return billWriteFailed('saveBill', error);
  return { ok: true, data: { id: data as string } };
}

/** Posts a draft: it gets its number and can no longer be edited. */
export async function postBill(
  ctx: FinanceWriteContext,
  input: z.input<typeof billIdInput>,
): Promise<FinResult<{ id: string; bill_no: string }>> {
  const { id } = billIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_post_bill', {
    target_org: ctx.orgId,
    target_bill: id,
  });
  if (error || !data) return billWriteFailed('postBill', error);
  return { ok: true, data: { id, bill_no: data as string } };
}

/** Voids a posted bill. Refused while it has payments. */
export async function voidBill(
  ctx: FinanceWriteContext,
  input: z.input<typeof billIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = billIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('supplier_bills')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return billWriteFailed('voidBill', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Deletes a draft bill and its lines. */
export async function deleteBill(
  ctx: FinanceWriteContext,
  input: z.input<typeof billIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = billIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('supplier_bills')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return billWriteFailed('deleteBill', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
