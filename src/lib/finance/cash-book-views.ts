/**
 * What the Cash Receipts, Payment Vouchers and Expenses screens show, worked
 * out from the rows the data layer reads. Pure, with no server imports, so
 * the client views and the tests both use it. `today` is always a YYYY-MM-DD
 * date. Cash Receipts and Payment Vouchers have a period selector, so their
 * figures, and the rows of their tables, are worked out again in the browser
 * when it changes.
 */
import type { Slice } from '@/components/charts';
import type { CashBookStatus, CashReceiptRow, PaymentVoucherKind, PaymentVoucherRow } from './cash-book';
import { toCsv } from './csv';
import type { ExpenseDisplayStatus, ExpenseRow } from './expenses';
import { rmShort } from './format';
import { PAYMENT_METHOD_LABELS } from './money';
import { type Stat, count, lastMonths, monthOf, sum, thousands } from './view-helpers';

/* ---- the period selector ------------------------------------------- */

export const CASH_BOOK_PERIODS = ['month', 'quarter', 'year', 'all'] as const;
export type CashBookPeriod = (typeof CASH_BOOK_PERIODS)[number];

/** There is no financial-year setting, so the longest dated period is the calendar year; "All time" has no date limit. */
export const CASH_BOOK_PERIOD_LABELS: Record<CashBookPeriod, string> = {
  month: 'This month',
  quarter: 'This quarter',
  year: 'This year',
  all: 'All time',
};

/** The calendar year a date falls in. */
const yearOf = (iso: string) => iso.slice(0, 4);

/** 2026-10-09 → 2026-Q4 */
const quarterOf = (iso: string) => `${yearOf(iso)}-Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;

/** Whether a date falls in the calendar month, quarter or year that today is in. A later date in that period counts too. */
export function inPeriod(iso: string, today: string, period: CashBookPeriod): boolean {
  if (period === 'all') return true;
  if (period === 'month') return monthOf(iso) === monthOf(today);
  if (period === 'quarter') return quarterOf(iso) === quarterOf(today);
  return yearOf(iso) === yearOf(today);
}

/** "Nothing received this month." / "Nothing received yet." for All time. */
export function nothingInPeriod(verb: string, period: CashBookPeriod): string {
  return period === 'all' ? `Nothing ${verb} yet.` : `Nothing ${verb} ${CASH_BOOK_PERIOD_LABELS[period].toLowerCase()}.`;
}

/** What the table says when no row falls in the chosen period; it only suggests a longer period when there is one. */
export function emptyPeriodText(noun: 'receipts' | 'vouchers', period: CashBookPeriod): string {
  return period === 'all' ? 'Nothing here.' : `Nothing in this period. Choose a longer one to see earlier ${noun}.`;
}

/**
 * The line under the table. `shown` of `matching` rows are on screen; `total`
 * is every row the table holds for the period before search and filters, and
 * `keptEarlier` / `keptLater` how many of those are dated outside the period
 * and kept in it anyway (drafts for receipts, money still waiting for
 * vouchers). Null when the workspace has no rows at all, because the table
 * already says so.
 */
export function cashBookCountLine(args: {
  noun: 'receipts' | 'vouchers';
  period: CashBookPeriod;
  workspaceRows: number;
  shown: number;
  matching: number;
  total: number;
  keptEarlier: number;
  keptLater: number;
}): string | null {
  const { noun, period, workspaceRows, shown, matching, total, keptEarlier, keptLater } = args;
  if (workspaceRows === 0) return null;
  const base = `Showing ${shown} of ${matching} ${noun}`;
  const span = period === 'all' ? 'all time' : CASH_BOOK_PERIOD_LABELS[period].toLowerCase();
  const kept = keptEarlier + keptLater;
  let keptText = '';
  if (kept > 0) {
    const which = keptLater === 0 ? 'earlier' : keptEarlier === 0 ? 'later' : null;
    if (noun === 'receipts') {
      keptText = which ? `${kept} ${which} ${kept === 1 ? 'draft' : 'drafts'}` : `${kept} more ${kept === 1 ? 'draft' : 'drafts'} dated outside it`;
    } else {
      keptText = which ? `${kept} ${which} ${kept === 1 ? 'one' : 'ones'} still waiting` : `${kept} more dated outside it, still waiting`;
    }
  }
  const filtered = matching !== total;
  if (kept === 0) return filtered ? `${base} (${total} ${period === 'all' ? 'in all' : span})` : period === 'all' ? `${base}, all time` : `${base} ${span}`;
  const detail = `${span}, and ${keptText}`;
  return filtered ? `${base} (${total} in the table: ${detail})` : `${base}: ${detail}`;
}

const SLICE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-5)', 'var(--chart-3)', 'var(--chart-4)'];

/** How many named slices a donut shows before the rest are added up as one. */
export const DONUT_SLICES = 4;

/**
 * Amounts per account or category as donut slices, largest first. They are
 * grouped by what the thing is (its id), not by its name, so two categories
 * called the same stay two slices. Past `DONUT_SLICES` the rest are one
 * slice, so a workspace with twenty categories still gets a chart that can
 * be read. Entries with nothing against them are left out.
 */
function slices(totals: Map<string, { label: string; value: number }>, restLabel: string): Slice[] {
  const ranked = [...totals.entries()]
    .map(([key, entry]) => ({ key, label: entry.label, value: Math.round(entry.value * 100) / 100 }))
    .filter((entry) => entry.value > 0)
    .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label) || x.key.localeCompare(y.key));
  const named = ranked.slice(0, DONUT_SLICES);
  const rest = ranked.slice(DONUT_SLICES);
  const shown = rest.length ? [...named, { label: restLabel, value: sum(rest, (entry) => entry.value) }] : named;
  return shown.map((entry, i) => ({ key: `slice-${i}`, label: entry.label, value: entry.value, color: SLICE_COLORS[i] }));
}

/** Amounts added up per key (an id), each key carrying the label it is shown under. */
function totalsBy<T>(
  rows: T[],
  key: (row: T) => string,
  label: (row: T) => string,
  amount: (row: T) => number,
): Map<string, { label: string; value: number }> {
  const totals = new Map<string, { label: string; value: number }>();
  for (const row of rows) {
    const k = key(row);
    const entry = totals.get(k) ?? { label: label(row), value: 0 };
    entry.value += amount(row);
    totals.set(k, entry);
  }
  return totals;
}

/**
 * What a voucher is grouped by: a supplier payment or a refund by its kind,
 * a voucher with a category of its own by that category's id, and a voucher
 * that pays expenses by the name of the category those expenses share, within
 * its kind. A voucher with no category to name is grouped by its kind.
 */
function voucherCategoryKey(row: PaymentVoucherRow): string {
  if (row.kind === 'bill' || row.kind === 'refund') return `kind:${row.kind}`;
  if (row.category_id && row.category_name) return `category:${row.category_id}`;
  // A voucher for expenses has no category of its own: the view names the one its expenses share, and gives no id for it.
  return row.category_name ? `name:${row.kind}:${row.category_name}` : `none:${row.kind}`;
}

/* ---- Cash Receipts -------------------------------------------------- */

export type CashReceiptsViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: what was received into bank accounts and into cash. */
  trend: { label: string; bank: number; cash: number }[];
  /** Whether anything was received in those eight months, however little: a small receipt rounds to 0 in `trend`. */
  hasTrend: boolean;
  /** Received in the period per account, in RM. */
  byAccount: Slice[];
  /** Whether anything was received in the period. */
  hasReceived: boolean;
  received: string;
};

/** A receipt is posted the moment money in is recorded on Payments In; one made here can wait as a draft. */
export const CASH_RECEIPT_STATUS_LABELS: Record<CashBookStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  scheduled: 'Scheduled',
  posted: 'Posted',
  rejected: 'Rejected',
  void: 'Void',
};

/** What a receipt is for: the invoices it pays, or its income category. */
export function receiptFor(row: CashReceiptRow): string {
  if (row.kind === 'invoice') return row.documents ?? 'Invoices';
  return row.category_name ?? '—';
}

export function cashReceiptsView(rows: CashReceiptRow[], today: string, period: CashBookPeriod): CashReceiptsViewData {
  // Only money that has actually arrived counts: not a draft, not voided.
  const posted = rows.filter((r) => r.status === 'posted');
  const inRange = posted.filter((r) => inPeriod(r.txn_date, today, period));
  const total = sum(inRange, (r) => r.amount);
  const intoBank = sum(inRange.filter((r) => r.account_kind === 'bank'), (r) => r.amount);
  const drafts = rows.filter((r) => r.status === 'draft');
  const span = CASH_BOOK_PERIOD_LABELS[period].toLowerCase();

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = posted.filter((r) => monthOf(r.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return {
      label,
      bank: thousands(sum(inMonth.filter((r) => r.account_kind === 'bank'), (r) => r.amount)),
      cash: thousands(sum(inMonth.filter((r) => r.account_kind === 'cash'), (r) => r.amount)),
    };
  });

  return {
    stats: [
      { label: 'Received', value: rmShort(total), delta: span, deltaTone: 'flat' },
      {
        label: 'Receipts',
        value: String(inRange.length),
        delta: drafts.length ? `${count(drafts.length, 'draft')} not yet posted` : span,
        deltaTone: 'flat',
      },
      { label: 'Average receipt', value: inRange.length ? rmShort(total / inRange.length) : '—', delta: span, deltaTone: 'flat' },
      {
        label: 'Into the bank',
        value: total ? `${Math.round((intoBank / total) * 100)}%` : '—',
        delta: 'the rest is cash in hand',
        deltaTone: 'flat',
      },
    ],
    trend,
    hasTrend,
    byAccount: slices(totalsBy(inRange, (r) => r.account_id, (r) => r.account_name, (r) => r.amount), 'Other accounts'),
    hasReceived: inRange.length > 0,
    received: rmShort(total),
  };
}

/**
 * The receipts the table lists for a period: the same "is it in the period"
 * test as the cards (`inPeriod` on the receipt's date), so a figure on a card
 * is always found in the table with the same period selected. The one
 * exception is a draft: the Receipts card counts "N drafts not yet posted"
 * whatever date they carry, so a draft stays in the table in every period.
 */
export function cashReceiptsInPeriod(rows: CashReceiptRow[], today: string, period: CashBookPeriod): CashReceiptRow[] {
  return rows.filter((r) => r.status === 'draft' || inPeriod(r.txn_date, today, period));
}

/** `open` is every receipt that is not void: what the table shows until a status is chosen. */
export type CashReceiptFilter = 'open' | 'draft' | 'posted' | 'void';

/** Receipts matching the status filter whose number, payer, invoices, category or reference contains the search text. */
export function filterCashReceipts(rows: CashReceiptRow[], query: string, filter: CashReceiptFilter): CashReceiptRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (filter === 'open' ? r.status !== 'void' : r.status === filter) &&
      `${r.number ?? ''} ${r.party_name ?? ''} ${r.documents ?? ''} ${r.category_name ?? ''} ${r.reference ?? ''}`
        .toLowerCase()
        .includes(q),
  );
}

/** The receipts table as a CSV file, its columns in the table's order. Amounts are numbers, so a spreadsheet can add them up. */
export function cashReceiptsCsv(rows: CashReceiptRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Received from', 'For', 'Account', 'Method', 'Reference', 'Amount', 'Status'],
    rows.map((r) => [
      r.txn_date,
      r.number,
      r.party_name,
      r.kind === 'invoice' ? r.documents : r.category_name,
      r.account_name,
      PAYMENT_METHOD_LABELS[r.method],
      r.reference,
      r.amount,
      CASH_RECEIPT_STATUS_LABELS[r.status],
    ]),
  );
}

/* ---- Payment Vouchers ----------------------------------------------- */

export type PaymentVouchersViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: what was paid out. */
  trend: { label: string; paid: number }[];
  /** Whether anything was paid out in those eight months, however little. */
  hasTrend: boolean;
  /** Paid out in the period per category, in RM. */
  byCategory: Slice[];
  /** Whether anything was paid out in the period. */
  hasPaid: boolean;
  paid: string;
};

/** Money out is a voucher: `scheduled` is one that may be paid and has not been, `posted` one that was. */
export const PAYMENT_VOUCHER_STATUS_LABELS: Record<CashBookStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  scheduled: 'To be paid',
  posted: 'Paid',
  rejected: 'Rejected',
  void: 'Void',
};

export const PAYMENT_VOUCHER_KIND_LABELS: Record<PaymentVoucherKind, string> = {
  bill: 'Supplier payment',
  refund: 'Refund',
  expense: 'Expense',
  other: 'Other payment',
};

/**
 * The screen a voucher is changed on, when that is not this one: a payment
 * to a supplier is marked paid, voided or deleted on Payments Out, and a
 * refund on Refunds. Nothing (null) for the two kinds that belong here.
 */
export function voucherHome(kind: PaymentVoucherKind): { label: string; href: string } | null {
  if (kind === 'bill') return { label: 'Payments Out', href: '/finance/payments-out' };
  if (kind === 'refund') return { label: 'Refunds', href: '/finance/refunds' };
  return null;
}

/** The category a voucher counts under: bills and refunds are a category each, the rest carry their own. */
export function voucherCategory(row: PaymentVoucherRow): string {
  if (row.kind === 'bill') return 'Supplier bills';
  if (row.kind === 'refund') return 'Refunds';
  return row.category_name ?? (row.kind === 'expense' ? 'Several categories' : 'No category');
}

/** Waiting for an owner or admin: recorded, and not yet allowed to be paid. */
export function isWaitingVoucher(row: PaymentVoucherRow): boolean {
  return row.status === 'pending_approval';
}

export function paymentVouchersView(rows: PaymentVoucherRow[], today: string, period: CashBookPeriod): PaymentVouchersViewData {
  // Only money that has actually gone out counts: not waiting, not scheduled, not voided.
  const posted = rows.filter((v) => v.status === 'posted');
  const inRange = posted.filter((v) => inPeriod(v.txn_date, today, period));
  const total = sum(inRange, (v) => v.amount);
  // What is waiting is waiting now, whatever date it carries.
  const waiting = rows.filter(isWaitingVoucher);
  const toPay = rows.filter((v) => v.status === 'scheduled');
  const span = CASH_BOOK_PERIOD_LABELS[period].toLowerCase();

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = posted.filter((v) => monthOf(v.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return { label, paid: thousands(sum(inMonth, (v) => v.amount)) };
  });

  return {
    stats: [
      { label: 'Paid', value: rmShort(total), delta: span, deltaTone: 'flat' },
      {
        label: 'Vouchers',
        value: String(inRange.length),
        delta: toPay.length ? `${toPay.length} more to be paid` : span,
        deltaTone: 'flat',
      },
      {
        label: 'Pending approval',
        value: rmShort(sum(waiting, (v) => v.amount)),
        delta: count(waiting.length, 'voucher'),
        deltaTone: waiting.length ? 'down' : 'flat',
      },
      { label: 'Average voucher', value: inRange.length ? rmShort(total / inRange.length) : '—', delta: span, deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    byCategory: slices(totalsBy(inRange, voucherCategoryKey, voucherCategory, (v) => v.amount), 'Other categories'),
    hasPaid: inRange.length > 0,
    paid: rmShort(total),
  };
}

/**
 * The vouchers the table lists for a period: the same "is it in the period"
 * test as the cards (`inPeriod` on the voucher's date), so a figure on a card
 * is always found in the table with the same period selected. The exception
 * is money still waiting: the Pending approval card and the "more to be paid"
 * line on the Vouchers card count those whatever date they carry (what is
 * waiting is waiting now), so a voucher waiting for approval or still to be
 * paid stays in the table in every period.
 */
export function paymentVouchersInPeriod(rows: PaymentVoucherRow[], today: string, period: CashBookPeriod): PaymentVoucherRow[] {
  return rows.filter((v) => isWaitingVoucher(v) || v.status === 'scheduled' || inPeriod(v.txn_date, today, period));
}

/** `open` is every voucher that is neither void nor rejected: what the table shows until a status is chosen. */
export type PaymentVoucherFilter = 'open' | 'waiting' | 'scheduled' | 'posted' | 'rejected' | 'void';

/**
 * Vouchers matching the status and kind filters whose number, payee, kind
 * (in the words the Kind column shows), category, documents or reference
 * contains the search text. A voucher still being written (`draft`) shows
 * under `open` only.
 */
export function filterPaymentVouchers(
  rows: PaymentVoucherRow[],
  query: string,
  filter: PaymentVoucherFilter,
  kind: 'all' | PaymentVoucherKind = 'all',
): PaymentVoucherRow[] {
  const q = query.trim().toLowerCase();
  const matches = (v: PaymentVoucherRow) => {
    if (filter === 'open') return v.status !== 'void' && v.status !== 'rejected';
    if (filter === 'waiting') return isWaitingVoucher(v);
    return v.status === filter;
  };
  return rows.filter(
    (v) =>
      matches(v) &&
      (kind === 'all' || v.kind === kind) &&
      `${v.number ?? ''} ${v.party_name ?? ''} ${PAYMENT_VOUCHER_KIND_LABELS[v.kind]} ${voucherCategory(v)} ${v.documents ?? ''} ${v.reference ?? ''}`
        .toLowerCase()
        .includes(q),
  );
}

/** The vouchers table as a CSV file. Amounts are numbers. */
export function paymentVouchersCsv(rows: PaymentVoucherRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Paid to', 'Kind', 'Category', 'For', 'Account', 'Method', 'Reference', 'Amount', 'Status'],
    rows.map((v) => [
      v.txn_date,
      v.number,
      v.party_name,
      PAYMENT_VOUCHER_KIND_LABELS[v.kind],
      voucherCategory(v),
      v.documents,
      v.account_name,
      PAYMENT_METHOD_LABELS[v.method],
      v.reference,
      v.amount,
      PAYMENT_VOUCHER_STATUS_LABELS[v.status],
    ]),
  );
}

/* ---- Expenses ------------------------------------------------------- */

export type ExpensesViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: what was entered (rejected left out) and what of it is approved. */
  trend: { label: string; entered: number; approved: number }[];
  /** Whether any expense that was not rejected is dated in those eight months. */
  hasTrend: boolean;
  /** Approved expenses dated this calendar year, in RM, per category. */
  byCategory: Slice[];
  /** Whether any approved expense is dated this year. */
  hasSpend: boolean;
  spendYtd: string;
};

export const EXPENSE_STATUS_LABELS: Record<ExpenseDisplayStatus, string> = {
  pending: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  paid: 'Paid',
};

/** Approved, paid or not: what the workspace has agreed to spend. A pending or rejected expense is not spend yet. */
export function isApprovedExpense(row: ExpenseRow): boolean {
  return row.display_status === 'approved' || row.display_status === 'paid';
}

export function expensesView(rows: ExpenseRow[], today: string): ExpensesViewData {
  const approved = rows.filter(isApprovedExpense);
  const pending = rows.filter((e) => e.display_status === 'pending');
  const ytd = approved.filter((e) => yearOf(e.expense_date) === yearOf(today));
  const mtd = approved.filter((e) => monthOf(e.expense_date) === monthOf(today));
  const ytdTotal = sum(ytd, (e) => e.amount);
  const perCategory = totalsBy(ytd, (e) => e.category_id, (e) => e.category_name, (e) => e.amount);
  const top = [...perCategory.values()].sort((x, y) => y.value - x.value || x.label.localeCompare(y.label))[0];

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const entered = rows.filter((e) => e.display_status !== 'rejected' && monthOf(e.expense_date) === key);
    if (entered.length > 0) hasTrend = true;
    return {
      label,
      entered: thousands(sum(entered, (e) => e.amount)),
      approved: thousands(sum(entered.filter(isApprovedExpense), (e) => e.amount)),
    };
  });

  return {
    stats: [
      { label: 'Total expenses (YTD)', value: rmShort(ytdTotal), delta: count(ytd.length, 'approved expense'), deltaTone: 'flat' },
      { label: 'This month', value: rmShort(sum(mtd, (e) => e.amount)), delta: count(mtd.length, 'approved expense'), deltaTone: 'flat' },
      {
        label: 'Top category',
        value: top ? top.label : '—',
        delta: top && ytdTotal ? `${Math.round((top.value / ytdTotal) * 100)}% of spend this year` : 'this year',
        deltaTone: 'flat',
      },
      {
        label: 'Pending approval',
        value: rmShort(sum(pending, (e) => e.amount)),
        delta: count(pending.length, 'expense'),
        deltaTone: pending.length ? 'down' : 'flat',
      },
    ],
    trend,
    hasTrend,
    byCategory: slices(perCategory, 'Other categories'),
    hasSpend: ytd.length > 0,
    spendYtd: rmShort(ytdTotal),
  };
}

/** The categories the rows name, by name, for the category filter. Two categories with one name stay two choices. */
export function expenseCategories(rows: ExpenseRow[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const row of rows) byId.set(row.category_id, row.category_name);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

/** `open` is every expense that was not rejected: what the table shows until a status is chosen. */
export type ExpenseFilter = 'open' | ExpenseDisplayStatus;

/** Expenses matching the status and category filters whose vendor, category or notes contains the search text. */
export function filterExpenses(rows: ExpenseRow[], query: string, filter: ExpenseFilter, categoryId: string = 'all'): ExpenseRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (e) =>
      (filter === 'open' ? e.display_status !== 'rejected' : e.display_status === filter) &&
      (categoryId === 'all' || e.category_id === categoryId) &&
      `${e.vendor_name} ${e.category_name} ${e.notes ?? ''}`.toLowerCase().includes(q),
  );
}

/** How an expense was paid, as the table shows it: a dash while nothing has been paid. */
export function expenseMethod(row: ExpenseRow): string {
  return row.method ? PAYMENT_METHOD_LABELS[row.method] : '—';
}

/** The expenses table as a CSV file. Amounts are numbers; Method is empty while nothing has been paid. */
export function expensesCsv(rows: ExpenseRow[]): string {
  return toCsv(
    ['Date', 'Category', 'Vendor', 'Amount', 'SST', 'Paid', 'Method', 'Status', 'Notes'],
    rows.map((e) => [
      e.expense_date,
      e.category_name,
      e.vendor_name,
      e.amount,
      e.sst_amount,
      e.paid,
      e.method ? PAYMENT_METHOD_LABELS[e.method] : null,
      EXPENSE_STATUS_LABELS[e.display_status],
      e.notes,
    ]),
  );
}
