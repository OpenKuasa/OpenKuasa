/**
 * Purchase orders. An order and its lines are saved by one database function.
 * Submitting gives it its number and sends it for approval; an owner or admin
 * (not the person who raised or submitted it) approves, or rejects it back to
 * draft with a reason. Once approved it records what has arrived and is
 * billed against, then it is closed. Unlike an RFQ, every line has a price.
 * org_id comes from the context.
 */
import { z } from 'zod';
import { addDaysIso } from './bill-math';
import { BILL_MESSAGES, saveBill } from './bills';
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
  NOT_ALLOWED,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const PURCHASE_ORDER_LINES_MAX = DOCUMENT_LINES_MAX;
/** Purchase orders loaded for a screen, a page at a time. */
export const PURCHASE_ORDER_PAGE_SIZE = 1000;

export const PURCHASE_ORDER_MESSAGES = {
  supplier: 'Choose a supplier.',
  date: LINE_MESSAGES.date,
  dates: 'The expected delivery date cannot be before the order date.',
  terms: 'Enter payment terms from 0 to 365 days, or leave them empty.',
  address: 'Keep the delivery address to 500 characters or fewer.',
  lines: LINE_MESSAGES.lines,
  tooManyLines: `A purchase order can have at most ${PURCHASE_ORDER_LINES_MAX} lines.`,
  description: LINE_MESSAGES.description,
  quantity: LINE_MESSAGES.quantity,
  price: LINE_MESSAGES.price,
  sst: LINE_MESSAGES.sst,
  tooLong: LINE_MESSAGES.tooLong,
  product: LINE_MESSAGES.product,
  // FIN11
  gone: 'That purchase order no longer exists.',
  // FIN01. A menu offers only what an order's status allows, so this reaches a person only when the order
  // changed under them in another tab. It says what may have happened, not what did.
  locked:
    'That cannot be done to this purchase order as it now stands. It may have been submitted, approved, closed or cancelled since this page was loaded.',
  // FIN10
  empty: 'A purchase order needs at least one line with an amount.',
  reason: 'Say why the order is rejected.',
  // FIN14: approving, rejecting and closing are an owner's or admin's; so are withdrawing or cancelling someone else's.
  needsSignOff: 'Only an owner or admin can do that to a purchase order.',
  // FIN18
  ownOrder: 'You raised or submitted this purchase order, so someone else has to approve it.',
  // FIN20
  hasBills: 'This purchase order has bills against it. Void those bills, or delete them if they are drafts, first.',
  received: 'Enter how much has been received for each line, 0 or more.',
  // FIN21
  billFailed: 'A bill can only be raised against an approved purchase order.',
  numberTaken: 'That purchase order number is already used.',
  missing: 'The supplier or a product on this purchase order no longer exists.',
} as const;

const M = PURCHASE_ORDER_MESSAGES;

/** The expected delivery date is optional: a real date, or an empty box, or nothing. */
const expectedDate = z
  .union([isoDate, z.literal(''), z.null()], { error: M.date })
  .transform((v) => (v === '' ? null : v));

/** Payment terms in whole days. Empty (null) takes the supplier's terms on a new order. */
const paymentTerms = z.number({ error: M.terms }).int(M.terms).min(0, M.terms).max(365, M.terms).nullable();

/** Optional text of up to 500 characters: trimmed, and an empty box is stored as null. */
const deliveryAddress = z
  .string({ error: M.address })
  .trim()
  .max(500, M.address)
  .transform((v) => (v === '' ? null : v))
  .nullable();

const orderId = z.string({ error: M.gone }).uuid(M.gone);

export const savePurchaseOrderInput = z
  .object({
    /** Present to change a draft; absent to create one. */
    id: orderId.optional(),
    supplier_id: z.string({ error: M.supplier }).uuid(M.supplier),
    po_date: isoDate,
    expected_date: expectedDate.default(null),
    payment_terms_days: paymentTerms.default(null),
    delivery_address: deliveryAddress.default(null),
    notes: optionalText.default(null),
    lines: z.array(documentLine, { error: M.lines }).min(1, M.lines).max(PURCHASE_ORDER_LINES_MAX, M.tooManyLines),
  })
  .refine((v) => v.expected_date === null || v.expected_date >= v.po_date, { message: M.dates, path: ['expected_date'] });

export const purchaseOrderIdInput = z.object({ id: orderId });

/** Approve, or reject with the reason the person gives. A reason sent with an approval is dropped. */
export const decidePurchaseOrderInput = purchaseOrderIdInput
  .extend({
    approve: z.boolean({ error: M.locked }),
    reason: optionalText.default(null),
  })
  .refine((v) => v.approve || v.reason !== null, { message: M.reason, path: ['reason'] })
  .transform((v) => ({ ...v, reason: v.approve ? null : v.reason }));

/** What has arrived: for each line, the total received so far (not this delivery's share). */
export const receivePurchaseOrderInput = purchaseOrderIdInput.extend({
  receipts: z
    .array(
      z.object({
        line_id: orderId,
        received_quantity: z
          .number({ error: M.received })
          .transform((v) => Math.round(v * 10 ** 3) / 10 ** 3)
          .pipe(z.number().min(0, M.received).max(99_999_999, M.received)),
      }),
      { error: M.received },
    )
    .min(1, M.received),
});

export const billFromPurchaseOrderInput = purchaseOrderIdInput.extend({ bill_date: isoDate });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN10: M.empty,
  FIN11: M.gone,
  [FIN_SIGN_OFF]: M.needsSignOff,
  FIN18: M.ownOrder,
  FIN20: M.hasBills,
  FIN21: M.billFailed,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

/**
 * FIN10 means something different to a decision (a rejection with no reason) and to a delivery (nothing
 * recorded) than to a save or a submit (no amount), so those two say what was missing.
 */
function orderWriteFailed(
  fnName: string,
  error: unknown,
  empty: string = M.empty,
): { ok: false; error: string } {
  const code = pgCode(error) ?? '';
  const refusal = code === 'FIN10' ? empty : REFUSALS[code];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

export type PurchaseOrderStatus = 'draft' | 'pending_approval' | 'approved' | 'closed' | 'cancelled';

/** How much of an order has arrived, worked out from its lines; never stored. */
export type PurchaseOrderDelivery = 'pending' | 'partial' | 'delivered';

export type PurchaseOrderListRow = {
  id: string;
  /** null while the order has never been submitted. A rejected or withdrawn order keeps its number. */
  po_no: string | null;
  supplier_id: string;
  supplier_name: string;
  /** The RFQ this order was made from, if any. */
  rfq_id: string | null;
  rfq_no: string | null;
  po_date: string;
  expected_date: string | null;
  status: PurchaseOrderStatus;
  created_by: string | null;
  submitted_by: string | null;
  /** The last rejection's reason; cleared when the order is submitted again. */
  rejection_reason: string | null;
  payment_terms_days: number | null;
  delivery_address: string | null;
  total: number;
  delivery: PurchaseOrderDelivery;
  /** What has arrived, at the order's prices and SST. */
  received_total: number;
  /** Every bill raised against the order that has not been voided, drafts included. */
  billed_total: number;
  /** Billed for more than the order is worth. */
  over_billed: boolean;
  /** Billed for more than has been received. */
  billed_over_received: boolean;
};

export type PurchaseOrderLine = DocumentLineRow & { received_quantity: number };

export type PurchaseOrderDetail = PurchaseOrderListRow & {
  subtotal: number;
  sst_total: number;
  notes: string | null;
  lines: PurchaseOrderLine[];
};

/**
 * The answer to "Save and submit for approval". When the draft was saved but
 * submitting it was refused, `draftId` is that draft, so the form goes on
 * editing it instead of saving a second copy.
 */
export type SaveAndSubmitPurchaseOrderResult = FinResult<{ id: string; po_no: string }> & { draftId?: string };

const LIST_COLUMNS =
  'id,po_no,supplier_id,supplier_name,rfq_id,rfq_no,po_date,expected_date,status,created_by,submitted_by,rejection_reason,payment_terms_days,delivery_address,total,delivery,received_total,billed_total,over_billed,billed_over_received';

function toListRow(row: Record<string, unknown>): PurchaseOrderListRow {
  return {
    ...(row as unknown as PurchaseOrderListRow),
    // A null is not 0 days: Number(null) would say so.
    payment_terms_days: row.payment_terms_days === null || row.payment_terms_days === undefined ? null : Number(row.payment_terms_days),
    total: Number(row.total),
    received_total: Number(row.received_total),
    billed_total: Number(row.billed_total),
  };
}

function toOrderLine(row: Record<string, unknown>): PurchaseOrderLine {
  return { ...toDocumentLine(row), received_quantity: Number(row.received_quantity) };
}

/** Every purchase order in the workspace, newest first, read a page at a time. Drafts are included. */
export async function listPurchaseOrders(ctx: FinanceWriteContext): Promise<PurchaseOrderListRow[]> {
  const rows: PurchaseOrderListRow[] = [];
  for (let from = 0; ; from += PURCHASE_ORDER_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_purchase_order_totals')
      .select(LIST_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('po_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PURCHASE_ORDER_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map(toListRow));
    if (page.length < PURCHASE_ORDER_PAGE_SIZE) return rows;
  }
}

/** One order with its lines in the order they were entered; null when it is not in this workspace or the id is not an id. */
export async function getPurchaseOrder(ctx: FinanceWriteContext, id: string): Promise<PurchaseOrderDetail | null> {
  // The database would throw on casting it; there is simply no such order.
  if (!purchaseOrderIdInput.safeParse({ id }).success) return null;
  const { data: order, error } = await ctx.client
    .from('finance_purchase_order_totals')
    .select(`${LIST_COLUMNS},subtotal,sst_total,notes`)
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!order) return null;
  const { data: lines, error: linesError } = await ctx.client
    .from('finance_purchase_order_lines')
    .select(`${DOCUMENT_LINE_COLUMNS},received_quantity`)
    .eq('org_id', ctx.orgId)
    .eq('purchase_order_id', id)
    .order('position', { ascending: true })
    .order('id', { ascending: true });
  if (linesError) throw linesError;
  const { subtotal, sst_total, notes, ...header } = order as unknown as Record<string, unknown>;
  return {
    ...toListRow(header),
    subtotal: Number(subtotal),
    sst_total: Number(sst_total),
    notes: (notes as string | null) ?? null,
    lines: ((lines ?? []) as unknown as Record<string, unknown>[]).map(toOrderLine),
  };
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft order, or replaces a draft's header and lines. */
export async function savePurchaseOrder(
  ctx: FinanceWriteContext,
  input: z.input<typeof savePurchaseOrderInput>,
): Promise<FinResult<{ id: string }>> {
  const { lines, ...purchase_order } = savePurchaseOrderInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_purchase_order', {
    target_org: ctx.orgId,
    purchase_order,
    lines,
  });
  if (error || !data) return orderWriteFailed('savePurchaseOrder', error);
  return { ok: true, data: { id: data as string } };
}

/** Sends a draft for approval. It gets its number the first time; a rejected order keeps it. */
export async function submitPurchaseOrder(
  ctx: FinanceWriteContext,
  input: z.input<typeof purchaseOrderIdInput>,
): Promise<FinResult<{ id: string; po_no: string }>> {
  const { id } = purchaseOrderIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_submit_purchase_order', {
    target_org: ctx.orgId,
    target_po: id,
  });
  if (error || !data) return orderWriteFailed('submitPurchaseOrder', error);
  return { ok: true, data: { id, po_no: data as string } };
}

/**
 * Approves an order waiting for approval, or rejects it back to draft with a
 * reason. The database function returns nothing, so success is the absence of
 * an error. The database refuses an approval by the person who raised or
 * submitted the order, unless they own the workspace.
 */
export async function decidePurchaseOrder(
  ctx: FinanceWriteContext,
  input: z.input<typeof decidePurchaseOrderInput>,
): Promise<FinResult<{ id: string }>> {
  const { id, approve, reason } = decidePurchaseOrderInput.parse(input);
  const { error } = await ctx.client.rpc('finance_decide_purchase_order', {
    target_org: ctx.orgId,
    target_po: id,
    approve,
    reason,
  });
  if (error) return orderWriteFailed('decidePurchaseOrder', error, M.reason);
  return { ok: true, data: { id } };
}

/** Takes an order back from approval so it can be corrected. */
export async function withdrawPurchaseOrder(
  ctx: FinanceWriteContext,
  input: z.input<typeof purchaseOrderIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = purchaseOrderIdInput.parse(input);
  const { error } = await ctx.client.rpc('finance_withdraw_purchase_order', {
    target_org: ctx.orgId,
    target_po: id,
  });
  if (error) return orderWriteFailed('withdrawPurchaseOrder', error);
  return { ok: true, data: { id } };
}

/** Records what has arrived on an approved order: the total so far for each line. */
export async function receivePurchaseOrder(
  ctx: FinanceWriteContext,
  input: z.input<typeof receivePurchaseOrderInput>,
): Promise<FinResult<{ id: string }>> {
  const { id, receipts } = receivePurchaseOrderInput.parse(input);
  const { error } = await ctx.client.rpc('finance_receive_purchase_order', {
    target_org: ctx.orgId,
    target_po: id,
    receipts,
  });
  if (error) return orderWriteFailed('receivePurchaseOrder', error, M.received);
  return { ok: true, data: { id } };
}

/** No more deliveries or bills are expected. */
export async function closePurchaseOrder(
  ctx: FinanceWriteContext,
  input: z.input<typeof purchaseOrderIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = purchaseOrderIdInput.parse(input);
  const { error } = await ctx.client.rpc('finance_close_purchase_order', {
    target_org: ctx.orgId,
    target_po: id,
  });
  if (error) return orderWriteFailed('closePurchaseOrder', error);
  return { ok: true, data: { id } };
}

/** Cancels an order. Refused while it has bills that are not void. */
export async function cancelPurchaseOrder(
  ctx: FinanceWriteContext,
  input: z.input<typeof purchaseOrderIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = purchaseOrderIdInput.parse(input);
  const { error } = await ctx.client.rpc('finance_cancel_purchase_order', {
    target_org: ctx.orgId,
    target_po: id,
  });
  if (error) return orderWriteFailed('cancelPurchaseOrder', error);
  return { ok: true, data: { id } };
}

/** Deletes a draft order and its lines. A draft that has been numbered (rejected or withdrawn) is refused: cancel it. */
export async function deletePurchaseOrder(
  ctx: FinanceWriteContext,
  input: z.input<typeof purchaseOrderIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = purchaseOrderIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_purchase_orders')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return orderWriteFailed('deletePurchaseOrder', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/**
 * Raises a draft bill from an approved order: its supplier, its lines at the
 * order's prices, the order's id, dated `bill_date` and due after the order's
 * payment terms, else its supplier's (none of either means due that day). The bill is a draft; the person
 * edits and posts it on Supplier Bills.
 */
export async function billFromPurchaseOrder(
  ctx: FinanceWriteContext,
  input: z.input<typeof billFromPurchaseOrderInput>,
): Promise<FinResult<{ id: string; bill_id: string }>> {
  const { id, bill_date } = billFromPurchaseOrderInput.parse(input);
  const order = await getPurchaseOrder(ctx, id);
  if (!order) return { ok: false, error: M.gone };
  if (order.status !== 'approved') return { ok: false, error: M.billFailed };
  // An order saved with its terms box empty takes its supplier's terms (as the form says); only when those cannot be read is it due that day.
  let terms = order.payment_terms_days;
  if (terms === null) {
    const { data } = await ctx.client
      .from('finance_contacts')
      .select('payment_terms_days')
      .eq('org_id', ctx.orgId)
      .eq('id', order.supplier_id)
      .maybeSingle();
    const read = (data as { payment_terms_days?: unknown } | null)?.payment_terms_days;
    terms = typeof read === 'number' ? read : null;
  }
  const saved = await saveBill(ctx, {
    supplier_id: order.supplier_id,
    bill_date,
    due_date: addDaysIso(bill_date, terms ?? 0),
    purchase_order_id: order.id,
    lines: order.lines.map((line) => ({
      product_id: line.product_id,
      description: line.description,
      quantity: line.quantity,
      uom: line.uom,
      pack_size: line.pack_size,
      unit_price: line.unit_price,
      sst_rate: line.sst_rate,
    })),
  });
  if (!saved.ok) {
    // FIN21 reaches here as the bill form's sentence about choosing an order; here the order was chosen for them.
    return saved.error === BILL_MESSAGES.order ? { ok: false, error: M.billFailed } : saved;
  }
  return { ok: true, data: { id, bill_id: saved.data.id } };
}
