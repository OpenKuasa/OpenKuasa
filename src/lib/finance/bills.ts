/**
 * Supplier bills. A bill and its lines are saved by one database function, so
 * a failure cannot leave half a bill. Posting gives the bill its number and
 * locks it; after that it can only be voided. org_id comes from the context.
 *
 * A bill may be in another currency (stage 4a of multi-currency): its lines
 * are typed in that currency, and its one rate (ringgit per one unit, the
 * rule's: Bank Negara Malaysia's 5 pm selling rate for the bill date,
 * src/lib/finance/sst-rate.ts, or one typed by hand with its source) gives
 * the ringgit figures the books use, worked out by the database. Nothing pays
 * a foreign bill yet: payments out of one arrive in the next stage.
 */
import { z } from 'zod';
import { BASE_CURRENCY } from './currencies';
import { CURRENCY_MESSAGES, type RateSource, wholeUnitsError } from './document-currency';
import { CURRENCY_INPUT_KEYS, currencyInputIssues, currencyInputKeys } from './document-currency-input';
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
import { EINVOICE_RATE_MAX } from './einvoice-fields';
import { RATE_REFERENCE_MAX, type RateProvider } from './sst-rate';

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
  // FIN32
  hasContra: 'A contra entry sets this off. Void the contra entry first.',
  empty: 'A bill needs at least one line with an amount.',
  numberTaken: 'That bill number is already used.',
  missing: 'The supplier or a product on this bill no longer exists.',
  product: LINE_MESSAGES.product,
  // FIN21
  order: 'Choose an approved purchase order from this supplier, or none.',
  // FIN26
  category: 'Choose an expense category for the bill.',
  currency: 'Choose a currency.',
  rate: CURRENCY_MESSAGES.rate,
  // FIN38. The form says it first; the database says it for a direct call, or a draft saved without a rate and
  // then posted from the list.
  rateBeforePosting: CURRENCY_MESSAGES.rateBeforePosting,
  // FIN39. The form marks a rate as Bank Negara's only when it is the rule's own answer for the date it asked,
  // so this is met by a direct call, or a draft whose date was moved before its BNM date by one. It says what
  // to do, not what happened.
  notBnmRate:
    "That rate is not Bank Negara Malaysia's 5 pm selling rate for the bill date. Type it in again with its source, and save.",
  // FIN43. The form says it first.
  rateSource: CURRENCY_MESSAGES.rateSource,
  // The table's e-Invoice check (23514) says it for a direct call; the schema says it first.
  rateTooLong: `Enter an exchange rate of at most ${EINVOICE_RATE_MAX} characters, as the e-Invoice takes it (such as 4.0815).`,
  referenceTooLong: `Keep the bank's name or the reference to ${RATE_REFERENCE_MAX} characters or fewer.`,
  // FIN49. The form keeps a bill with an order in the order's currency, so this is met by a direct call.
  orderCurrency: "A bill raised against a purchase order is in the order's currency.",
  // The assistant never edits a draft in another currency: its lines would be read as ringgit.
  foreignDraftByAssistant:
    'This bill is not in ringgit. Edit it on the Supplier Bills screen, where its currency and exchange rate are shown.',
} as const;

const M = BILL_MESSAGES;

/** The purchase order a bill is raised against: an id, or an empty box or null for none. */
const purchaseOrderLink = z
  .union([z.string().uuid(M.order), z.literal(''), z.null()], { error: M.order })
  .transform((v) => (v === '' ? null : v));

/** The expense category a bill's cost lands in: an id, or an empty box or null to take the workspace's default. */
const categoryLink = z
  .union([z.string().uuid(M.category), z.literal(''), z.null()], { error: M.category })
  .transform((v) => (v === '' ? null : v));

const saveBillBase = z.object({
  /** Present to change a draft; absent to create one. */
  id: z.string({ error: M.gone }).uuid(M.gone).optional(),
  supplier_id: z.string({ error: M.supplier }).uuid(M.supplier),
  supplier_ref: optionalText.default(null),
  bill_date: isoDate,
  due_date: isoDate,
  /** Left out when the input has none, so changing a draft keeps the order it is linked to. */
  purchase_order_id: purchaseOrderLink.optional(),
  /** Left out when the input has none: a new bill then gets Purchases and a draft keeps the category it has. */
  category_id: categoryLink.optional(),
  notes: optionalText.default(null),
  lines: z.array(documentLine, { error: M.lines }).min(1, M.lines).max(BILL_LINES_MAX, M.tooManyLines),
  // The currency keys, all optional with no default: a caller that sends no currency (the finance assistant,
  // which writes ringgit, the receipts inbox, and the code deployed before stage 4a) leaves a draft's currency
  // and rate as they are, and a new bill in ringgit (document-currency-input.ts).
  ...currencyInputKeys(M),
});
const dueNotBefore = (v: { bill_date: string; due_date: string }) => v.due_date >= v.bill_date;

export const saveBillInput = saveBillBase
  .refine(dueNotBefore, { message: M.dates, path: ['due_date'] })
  // Whole units, and a typed rate's source; with no currency sent saveBill checks the stored one.
  .superRefine(currencyInputIssues(M));

/**
 * What the finance assistant may send: the form's fields without a currency or a rate. It writes ringgit only,
 * so those keys are not in the schema the model sees and a call that carries them has them stripped.
 */
export const saveBillToolInput = saveBillBase
  .omit(CURRENCY_INPUT_KEYS)
  .refine(dueNotBefore, { message: M.dates, path: ['due_date'] });

export const billIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN02: M.hasPayments,
  FIN32: M.hasContra,
  FIN10: M.empty,
  FIN11: M.gone,
  FIN21: M.order,
  FIN26: M.category,
  FIN38: M.rateBeforePosting,
  FIN39: M.notBnmRate,
  FIN43: M.rateSource,
  FIN49: M.orderCurrency,
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
  /**
   * Set off by posted contra entries: no money moved, and it is not in `paid`. The reads always give it; it is
   * optional so that rows made by hand (samples, tests) need not.
   */
  set_off?: number;
  /** total − paid − set_off. */
  balance: number;
  display_status: BillDisplayStatus;
  /** The purchase order the bill is raised against, with its number; null when it has none. */
  purchase_order_id: string | null;
  purchase_order_no: string | null;
  /**
   * The expense category the bill's cost lands in, with its name. Every bill has one; null only if it could
   * not be read.
   */
  category_id: string | null;
  category_name: string | null;
  /** ISO 4217 code: the currency the amounts above are in. MYR for every bill made before stage 4a. */
  currency: string;
  /** Ringgit per one unit: 1 for ringgit; null on a draft in another currency with no rate yet. For display. */
  fx_rate: number | null;
  /** The same rate as the database's exact text ("4.0830000000"): what money is worked from. */
  fx_rate_text: string | null;
  /** null for ringgit and while there is no rate. */
  fx_rate_source: RateSource | null;
  /** The date of BNM's rate when it is BNM's; null otherwise. */
  fx_rate_date: string | null;
  /** Where a rate typed by hand came from; null otherwise. */
  fx_rate_provider: RateProvider | null;
  /** The bank's or central bank's name, or Customs' approval reference. */
  fx_rate_reference: string | null;
  /** The lines and their SST in ringgit at the bill's rate; null while a foreign draft has no rate. */
  subtotal_myr: number | null;
  sst_myr: number | null;
  /** The total in ringgit; null while a foreign draft has no rate. Equal to `total` for ringgit. */
  total_myr: number | null;
  /** What is still owed, in ringgit; null while a foreign draft has no rate. Equal to `balance` for ringgit. */
  balance_myr: number | null;
  /**
   * Posted money out, in ringgit: what each payment carried off the bill; equal to `paid` for ringgit. The reads
   * always give it; it is optional so that rows made by hand (samples, tests) need not.
   */
  paid_myr?: number | null;
};

/**
 * A bill's total and balance in ringgit, for every figure that adds bills up. A foreign draft with no rate yet
 * counts nothing: it is a draft.
 */
export function billRinggit(row: Pick<BillListRow, 'total_myr' | 'balance_myr'>): { total: number; balance: number } {
  return { total: row.total_myr ?? 0, balance: row.balance_myr ?? 0 };
}

export type BillLine = DocumentLineRow;

export type BillDetail = BillListRow & { supplier_ref: string | null; notes: string | null; lines: BillLine[] };

/**
 * The answer to "Save and post". When the draft was saved but posting it was
 * refused, `draftId` is that draft, so the form goes on editing it instead of
 * saving a second copy.
 */
export type SaveAndPostResult = FinResult<{ id: string; bill_no: string }> & { draftId?: string };

const LIST_COLUMNS =
  'id,bill_no,supplier_id,supplier_name,bill_date,due_date,total,paid,set_off,balance,display_status,' +
  // The rate twice: as a number to show, and as exact text (PostgREST's cast) to work money from.
  'currency,fx_rate,fx_rate_text:fx_rate::text,fx_rate_source,fx_rate_date,fx_rate_provider,fx_rate_reference,' +
  'subtotal_myr,sst_myr,total_myr,balance_myr,paid_myr';

/** A numeric column as a number, keeping null. */
const numberOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

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

export type ExpenseCategory = { id: string; name: string };

/** The workspace's active expense categories, by name, for the bill form's picker. */
export async function listExpenseCategories(ctx: FinanceWriteContext): Promise<ExpenseCategory[]> {
  const { data, error } = await ctx.client
    .from('finance_categories')
    .select('id,name')
    .eq('org_id', ctx.orgId)
    .eq('kind', 'expense')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as ExpenseCategory[];
}

/** Each bill's category: bill id → the category's id and name. */
type BillCategories = Map<string, { id: string; name: string | null }>;

/**
 * The category of each bill, read from the bills themselves because the totals view the list reads does not
 * carry it, and the names from the categories. `billId` narrows the bill read to one bill. Throws when a read
 * fails, like the others here.
 */
async function readCategories(ctx: FinanceWriteContext, billId?: string): Promise<BillCategories> {
  const names = new Map<string, string>();
  for (let from = 0; ; from += BILL_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_categories')
      .select('id,name')
      .eq('org_id', ctx.orgId)
      .order('id', { ascending: true })
      .range(from, from + BILL_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as { id: string; name: string }[];
    for (const c of page) names.set(c.id, c.name);
    if (page.length < BILL_PAGE_SIZE) break;
  }
  const categories: BillCategories = new Map();
  for (let from = 0; ; from += BILL_PAGE_SIZE) {
    let query = ctx.client.from('supplier_bills').select('id,category_id').eq('org_id', ctx.orgId);
    if (billId) query = query.eq('id', billId);
    const { data, error } = await query.order('id', { ascending: true }).range(from, from + BILL_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as { id: string; category_id: string | null }[];
    for (const b of page) if (b.category_id) categories.set(b.id, { id: b.category_id, name: names.get(b.category_id) ?? null });
    if (page.length < BILL_PAGE_SIZE) return categories;
  }
}

function toListRow(row: Record<string, unknown>, links: BillOrderLinks, categories: BillCategories): BillListRow {
  const order = links.get(row.id as string);
  const category = categories.get(row.id as string);
  return {
    ...(row as unknown as BillListRow),
    purchase_order_id: order?.id ?? null,
    purchase_order_no: order?.no ?? null,
    category_id: category?.id ?? null,
    category_name: category?.name ?? null,
    total: Number(row.total),
    paid: Number(row.paid),
    set_off: Number(row.set_off ?? 0),
    balance: Number(row.balance),
    currency: (row.currency as string | undefined) ?? BASE_CURRENCY,
    fx_rate: numberOrNull(row.fx_rate),
    fx_rate_text: (row.fx_rate_text as string | null | undefined) ?? null,
    fx_rate_source: (row.fx_rate_source as RateSource | null | undefined) ?? null,
    fx_rate_date: (row.fx_rate_date as string | null | undefined) ?? null,
    fx_rate_provider: (row.fx_rate_provider as RateProvider | null | undefined) ?? null,
    fx_rate_reference: (row.fx_rate_reference as string | null | undefined) ?? null,
    subtotal_myr: numberOrNull(row.subtotal_myr),
    sst_myr: numberOrNull(row.sst_myr),
    total_myr: numberOrNull(row.total_myr),
    balance_myr: numberOrNull(row.balance_myr),
    paid_myr: numberOrNull(row.paid_myr),
  };
}

/** Every bill in the workspace, newest first, read a page at a time. */
export async function listBills(ctx: FinanceWriteContext): Promise<BillListRow[]> {
  const rows: BillListRow[] = [];
  const links = await readOrderLinks(ctx);
  const categories = await readCategories(ctx);
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
    rows.push(...page.map((r) => toListRow(r, links, categories)));
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
  const categories = await readCategories(ctx, id);
  const header = bill as unknown as Record<string, unknown>;
  return {
    ...toListRow(header, links, categories),
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
  // No currency sent for an existing draft: it keeps its own, so the whole-units rule is its own too.
  if (bill.id && bill.currency === undefined) {
    const stored = await storedCurrency(ctx, bill.id);
    if (!stored.ok) return stored;
    const problem = stored.data ? wholeUnitsError(stored.data, lines) : null;
    if (problem) return { ok: false, error: problem };
  }
  const { data, error } = await ctx.client.rpc('finance_save_bill', {
    target_org: ctx.orgId,
    bill,
    lines,
  });
  if (error || !data) return billWriteFailed('saveBill', error);
  return { ok: true, data: { id: data as string } };
}

/** The currency a bill is stored in; null when it is not there (the save then says so). */
async function storedCurrency(ctx: FinanceWriteContext, id: string): Promise<FinResult<string | null>> {
  const { data, error } = await ctx.client
    .from('supplier_bills')
    .select('currency')
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) return billWriteFailed('saveBill', error);
  return { ok: true, data: (data as { currency?: string } | null)?.currency ?? null };
}

/**
 * The finance assistant's save: ringgit only. A new bill is in ringgit; a draft that is in another currency is
 * refused, because the lines the assistant writes are in ringgit.
 */
export async function saveBillInRinggit(ctx: FinanceWriteContext, input: unknown): Promise<FinResult<{ id: string }>> {
  const parsed = saveBillToolInput.parse(input);
  if (parsed.id) {
    const stored = await storedCurrency(ctx, parsed.id);
    if (!stored.ok) return stored;
    if (stored.data !== null && stored.data !== BASE_CURRENCY) return { ok: false, error: M.foreignDraftByAssistant };
  }
  return saveBill(ctx, parsed);
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
