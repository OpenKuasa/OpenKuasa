/**
 * The SST-02 return for one taxable period, service tax or sales tax, worked out on invoice basis from plain
 * invoice-line and credit-note rows. Pure, with no server imports, so the screen and the tests both use it.
 *
 * Every sum is made in whole sen and turned back into ringgit at the edge, as reports.ts does. Only the ringgit
 * columns are read (amount_myr, sst_amount_myr): a foreign line has nothing else here to read.
 *
 * Periods: an invoice line counts by its invoice date, a credit note by its credit date. A voided invoice
 * counts nowhere, whenever it was voided: the database refuses a void while the invoice's return is marked
 * filed (FIN71), so a void is either a correction before filing or part of an amended return (Pindaan), and
 * a later sale that falls through is a credit note. A voided credit note counts nowhere too, for the same reason:
 * the database refuses its void while its return is marked filed (FIN74). So 13(a) is the tax of the live credit
 * notes dated in the period, and never below zero.
 *
 * Typed-in figures (11(e) cards, 13(b), 13(c), 13(d), 13A) come in as a fifth argument: 11(e) joins item 12, the rest come off item 14.
 *
 * Payment basis (#222 stage 3): a service tax return of a workspace that counts tax when the money arrives
 * follows the receipts instead of the invoice dates, and `paid` carries each invoice with every receipt and
 * credit note dated up to the period's end. Tax to date is the invoice's own tax on the share of what it still
 * owes that has been paid, so it stops at the invoice's tax and falls only when a credit note takes something
 * off. A period's figure is the change between the period's first day and its last, which is how the periods
 * add up to the invoice's tax with no rounding left over. A fall goes to 13(a) and never to a negative B2 line:
 * a sale that drops after the tax was counted is corrected by a credit note, not by a value below zero.
 */
import { type SstBasis, type SstPeriod, type SstSettings, type SstTaxType, sstPeriodFor, taxTypeForRate } from './sst';

export type SstReturnType = 'service' | 'sales';

export type SstLineRow = {
  id: string;
  invoice_id: string;
  product_id: string | null;
  description: string;
  sst_rate: number;
  tax_type: SstTaxType | null;
  sst_code: string | null;
  amount_myr: number;
  sst_amount_myr: number;
  invoice_date: string;
  invoice_status: 'posted' | 'void';
  /** Malaysian YYYY-MM-DD. */
  voided_on: string | null;
};

export type SstCreditRow = {
  id: string;
  credit_date: string;
  status: 'issued' | 'void';
  /** Malaysian YYYY-MM-DD. */
  voided_on: string | null;
  amount_myr: number;
  invoice_total_myr: number;
  invoice_sst_myr: Record<SstReturnType, number>;
};

/**
 * One invoice a payment-basis return follows: its own totals, every receipt and credit note dated up to the
 * period's end (the receipts from the invoice's first one, not only those inside the period), and its own lines
 * for Part B1.
 */
export type SstPaidInvoice = {
  invoice_id: string;
  invoice_date: string;
  total_myr: number;
  sst_myr: Record<SstReturnType, number>;
  /** Posted receipts against the invoice, oldest first, each the ringgit it settled. */
  receipts: { id: string; paid_on: string; amount_myr: number }[];
  /** Issued credit notes on the invoice, oldest first, gross as the note's amount stands on the invoice. */
  credits: { credit_date: string; amount_myr: number }[];
  /** The invoice's lines, for Part B1 and the rate items. */
  rows: SstLineRow[];
};

/**
 * Money received in the period with no invoice behind it: a receipt that names an income category and settles
 * nothing (FIN15), so no line carries a rate and the return has nowhere to put it. Ringgit.
 */
export type SstNoInvoiceMoney = { count: number; amount_myr: number };

/** Which basis the workspace files service tax on, the invoices a payment-basis return follows, and the money it cannot count. */
export type SstReturnOptions = { basis?: SstBasis; paid?: SstPaidInvoice[]; noInvoice?: SstNoInvoiceMoney };

export type SstFormLine = { item: string; label: string; value: number | null; tax: number; typed?: boolean };

export type SstB1Row = { key: string; description: string; code: string | null; value: number; ownUse: number };

export type SstReturn = {
  type: SstReturnType;
  period: SstPeriod;
  b1: SstB1Row[];
  b1Total: number;
  b2: SstFormLine[];
  item12: number;
  deductions: SstFormLine[];
  item14: number;
  offForm: { count: number; value: number; tax: number };
  untyped: { count: number; value: number };
  /** Money received in the period that settles no invoice, so it is on no item of the form. */
  noInvoice: { count: number; amount: number };
};

/** The form's rate items per return: a line of the type at any other rate is off the form. */
export const SST_FORM_ITEMS: Record<SstReturnType, { rate: number; item: string; label: string }[]> = {
  service: [
    { rate: 6, item: '11(c)', label: 'Service tax 6%' },
    { rate: 8, item: '11(d)', label: 'Service tax 8%' },
  ],
  sales: [
    { rate: 5, item: '11(a)', label: 'Sales tax 5%' },
    { rate: 10, item: '11(b)', label: 'Sales tax 10%' },
  ],
};

/** The typed-in SST-02 figures of one return; ringgit amounts, and a whole number of cards. */
export type SstTypedFigures = {
  cards11e: number;
  deduction13b: number;
  deduction13c: number;
  badDebt13d: number;
  adjustment13a: number;
};

export const NO_TYPED_FIGURES: SstTypedFigures = { cards11e: 0, deduction13b: 0, deduction13c: 0, badDebt13d: 0, adjustment13a: 0 };

/** 11(e) is a number of cards, never ringgit: "0 cards", "1 card", "1,200 cards". */
export const sstCards = (n: number) => `${n.toLocaleString('en-MY')} ${n === 1 ? 'card' : 'cards'}`;

/** Service tax charged on each credit or charge card, in sen. */
const CARD_TAX_SEN = 2500;

const CARD_ITEM: SstFormLine = { item: '11(e)', label: 'Credit and charge cards, RM25 each', value: null, tax: 0, typed: true };
const CREDIT_NOTES = { item: '13(a)', label: 'Tax deduction from credit note' };
const BAD_DEBT: SstFormLine = { item: '13(d)', label: 'Bad debt relief (approved)', value: null, tax: 0, typed: true };
const TYPED_DEDUCTIONS: Record<SstReturnType, SstFormLine[]> = {
  service: [{ item: '13(c)', label: 'Approved service tax deduction', value: null, tax: 0, typed: true }, BAD_DEBT],
  sales: [
    { item: '13(b)', label: 'Sales tax deduction', value: null, tax: 0, typed: true },
    { item: '13A', label: 'Adjustment under sales tax deduction', value: null, tax: 0, typed: true },
    BAD_DEBT,
  ],
};

const toSen = (amount: number) => Math.round(amount * 100);
const fromSen = (sen: number) => sen / 100;

const within = (date: string, p: SstPeriod) => date >= p.start && date <= p.end;

/** A credit note's share of its invoice's tax of one type, in sen: amount × tax ÷ invoice total, rounded. */
function creditTaxSen(c: SstCreditRow, type: SstReturnType): number {
  const total = toSen(c.invoice_total_myr);
  if (total === 0) return 0;
  return Math.round((toSen(c.amount_myr) * toSen(c.invoice_sst_myr[type])) / total);
}

export function buildSstReturn(
  type: SstReturnType,
  period: SstPeriod,
  lines: SstLineRow[],
  credits: SstCreditRow[],
  figures: SstTypedFigures = NO_TYPED_FIGURES,
  options: SstReturnOptions = {},
): SstReturn {
  const items = SST_FORM_ITEMS[type];
  const b2Sen = items.map(() => ({ value: 0, tax: 0 }));
  const groups = new Map<string, { label: string; labelDate: string; labelId: string; code: string | null; value: number }>();
  const offForm = { count: 0, value: 0, tax: 0 };
  const untyped = { count: 0, value: 0 };
  let creditNotesSen = 0;
  // The basis is a service tax setting: sales tax is always counted when the invoice is issued.
  const paymentBasis = type === 'service' && options.basis === 'payment';

  for (const l of lines) {
    // A voided invoice counts nowhere (see the top of this file).
    if (l.invoice_status === 'void' || !within(l.invoice_date, period)) continue;
    if (paymentBasis) continue; // counted when its money arrives, below.
    const effective = l.tax_type ?? taxTypeForRate(l.sst_rate);
    if (effective === null) {
      if (l.sst_rate > 0) {
        untyped.count += 1;
        untyped.value += toSen(l.amount_myr);
      }
      continue;
    }
    if (effective !== type || l.sst_rate === 0) continue;
    const at = items.findIndex((i) => i.rate === l.sst_rate);
    if (at < 0) {
      offForm.count += 1;
      offForm.value += toSen(l.amount_myr);
      offForm.tax += toSen(l.sst_amount_myr);
      continue;
    }
    b2Sen[at].value += toSen(l.amount_myr);
    b2Sen[at].tax += toSen(l.sst_amount_myr);

    const description = l.description.trim();
    const key = `${l.product_id !== null ? `p:${l.product_id}` : `d:${description.toLowerCase()}`}\u0000${l.sst_code ?? ''}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { label: description, labelDate: l.invoice_date, labelId: l.id, code: l.sst_code, value: toSen(l.amount_myr) });
    } else {
      g.value += toSen(l.amount_myr);
      if (l.invoice_date > g.labelDate || (l.invoice_date === g.labelDate && l.id > g.labelId)) {
        g.label = description;
        g.labelDate = l.invoice_date;
        g.labelId = l.id;
      }
    }
  }

  for (const c of credits) {
    // A voided credit note counts nowhere (see the top of this file).
    if (c.status === 'void' || !within(c.credit_date, period)) continue;
    // On payment basis a credit note lowers what its invoice still owes, so the fall in the running total is
    // the 13(a) figure; counting creditTaxSen here as well would count the same money twice.
    if (paymentBasis) continue;
    creditNotesSen += creditTaxSen(c, type);
  }

  if (paymentBasis) {
    const firstDay = previousDay(period.start);
    for (const inv of options.paid ?? []) {
      const totalSen = toSen(inv.total_myr);
      const rows = inv.rows.filter((r) => r.invoice_status !== 'void');
      if (totalSen <= 0 || rows.length === 0) continue;
      /**
       * What has been counted by `date`, as a share of the invoice's own total: the money in, capped at what the
       * invoice still owes after its credit notes. Tax and value at a date are the invoice's own figures times it.
       */
      const counted = (date: string) => {
        const received = inv.receipts.reduce((s, r) => (r.paid_on <= date ? s + toSen(r.amount_myr) : s), 0);
        const credited = inv.credits.reduce((s, c) => (c.credit_date <= date ? s + toSen(c.amount_myr) : s), 0);
        const owed = Math.max(0, totalSen - credited);
        return Math.min(received, owed) / totalSen;
      };
      const shareBefore = counted(firstDay);
      const shareAfter = counted(period.end);
      if (shareBefore === shareAfter) continue;

      for (const [at, formItem] of items.entries()) {
        const ofItem = rows.filter((r) => (r.tax_type ?? taxTypeForRate(r.sst_rate)) === type && r.sst_rate === formItem.rate);
        const itemTaxSen = ofItem.reduce((s, r) => s + toSen(r.sst_amount_myr), 0);
        if (itemTaxSen === 0) continue;
        // The invoice's own tax at each share; what it lost is 13(a), never a value below zero.
        const taxDelta = Math.round(itemTaxSen * shareAfter) - Math.round(itemTaxSen * shareBefore);
        if (taxDelta < 0) {
          creditNotesSen -= taxDelta;
          continue;
        }
        if (taxDelta === 0) continue;
        b2Sen[at].tax += taxDelta;
        const itemValueSen = ofItem.reduce((s, r) => s + toSen(r.amount_myr), 0);
        const valueDelta = Math.round(itemValueSen * shareAfter) - Math.round(itemValueSen * shareBefore);
        if (valueDelta <= 0) continue;
        b2Sen[at].value += valueDelta;

        // Part B1: the item's own lines, each at the share it has been paid; the largest line takes the
        // rounding difference so the lines add up to the item's value.
        const parts = ofItem.map((r) => {
          const description = r.description.trim();
          return {
            key: `${r.product_id !== null ? `p:${r.product_id}` : `d:${description.toLowerCase()}`}\u0000${r.sst_code ?? ''}`,
            description,
            code: r.sst_code,
            id: r.id,
            date: r.invoice_date,
            delta: Math.round(toSen(r.amount_myr) * shareAfter) - Math.round(toSen(r.amount_myr) * shareBefore),
          };
        });
        const partsSen = parts.reduce((s, p) => s + p.delta, 0);
        const largest = parts.reduce((a, b) => (b.delta > a.delta ? b : a));
        for (const p of parts) {
          const move = p === largest ? p.delta + (valueDelta - partsSen) : p.delta;
          if (move === 0) continue;
          const g = groups.get(p.key);
          if (!g) {
            groups.set(p.key, { label: p.description, labelDate: p.date, labelId: p.id, code: p.code, value: move });
            continue;
          }
          g.value += move;
          if (p.date > g.labelDate || (p.date === g.labelDate && p.id > g.labelId)) {
            g.label = p.description;
            g.labelDate = p.date;
            g.labelId = p.id;
          }
        }
      }

      // Lines that land on no item still need their "Not on the form" note: each counts once, at the part of
      // its value (and tax) paid in this period, as invoice basis counts it once in the period it is issued.
      for (const r of rows) {
        if (r.sst_rate === 0) continue;
        const effective = r.tax_type ?? taxTypeForRate(r.sst_rate);
        const onForm = effective === type && items.some((i) => i.rate === r.sst_rate);
        if (onForm || (effective !== null && effective !== type)) continue;
        const valueDelta = Math.round(toSen(r.amount_myr) * shareAfter) - Math.round(toSen(r.amount_myr) * shareBefore);
        if (valueDelta <= 0) continue;
        if (effective === null) {
          untyped.count += 1;
          untyped.value += valueDelta;
          continue;
        }
        offForm.count += 1;
        offForm.value += valueDelta;
        offForm.tax += Math.round(toSen(r.sst_amount_myr) * shareAfter) - Math.round(toSen(r.sst_amount_myr) * shareBefore);
      }
    }
  }

  const b1 = [...groups.entries()]
    .map(([key, g]) => ({ key, description: g.label, code: g.code, valueSen: g.value }))
    .sort((a, b) => {
      const da = a.description.toLowerCase();
      const db = b.description.toLowerCase();
      if (da !== db) return da < db ? -1 : 1;
      const ca = a.code ?? '';
      const cb = b.code ?? '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  const b1TotalSen = b1.reduce((s, r) => s + r.valueSen, 0);
  const cards = type === 'service' ? figures.cards11e : 0;
  const cardsTaxSen = cards * CARD_TAX_SEN;
  const item12Sen = b2Sen.reduce((s, r) => s + r.tax, 0) + cardsTaxSen;
  // Each typed deduction's amount in ringgit; the other type's figures are ignored.
  const typedAmount: Record<string, number> =
    type === 'service'
      ? { '13(c)': figures.deduction13c, '13(d)': figures.badDebt13d }
      : { '13(b)': figures.deduction13b, '13A': figures.adjustment13a, '13(d)': figures.badDebt13d };
  const typed = TYPED_DEDUCTIONS[type].map((d) => ({ ...d, tax: fromSen(toSen(typedAmount[d.item] ?? 0)) }));
  const item14Sen = item12Sen - creditNotesSen - typed.reduce((s, d) => s + toSen(d.tax), 0);

  const b2: SstFormLine[] = items.map((i, n) => ({ item: i.item, label: i.label, value: fromSen(b2Sen[n].value), tax: fromSen(b2Sen[n].tax) }));
  if (type === 'service') b2.push({ ...CARD_ITEM, value: cards > 0 ? cards : null, tax: fromSen(cardsTaxSen) });

  return {
    type,
    period,
    b1: b1.map((r) => ({ key: r.key, description: r.description, code: r.code, value: fromSen(r.valueSen), ownUse: 0 })),
    b1Total: fromSen(b1TotalSen),
    b2,
    item12: fromSen(item12Sen),
    deductions: [{ ...CREDIT_NOTES, value: null, tax: fromSen(creditNotesSen) }, ...typed],
    item14: fromSen(item14Sen),
    offForm: { count: offForm.count, value: fromSen(offForm.value), tax: fromSen(offForm.tax) },
    untyped: { count: untyped.count, value: fromSen(untyped.value) },
    noInvoice: { count: options.noInvoice?.count ?? 0, amount: fromSen(toSen(options.noInvoice?.amount_myr ?? 0)) },
  };
}

/** The first day of the month before the one `date` (YYYY-MM-DD) falls in. */
function monthBefore(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, '0')}-01`;
}

/** The day before `date` (YYYY-MM-DD). */
function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The current period (by `today`, Malaysian) and those before it, newest first. */
export function recentSstPeriods(today: string, startMonth: number, count = 12): SstPeriod[] {
  const out: SstPeriod[] = [];
  let p = sstPeriodFor(today, startMonth);
  for (let i = 0; i < count; i += 1) {
    out.push(p);
    p = sstPeriodFor(monthBefore(p.start), startMonth);
  }
  return out;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-01$/;

/**
 * Which return the screen shows: `tax` ('service' | 'sales') when given, else sales when only a sales tax
 * number is set, else service; `period` when it is a real period start not after the current one, else the
 * current period (by `today`, Malaysian).
 */
export function pickSstView(
  params: Record<string, string | string[] | undefined>,
  settings: SstSettings,
  today: string,
): { type: SstReturnType; period: SstPeriod } {
  const m = settings.period_start_month;
  const tax = first(params.tax);
  const type: SstReturnType =
    tax === 'service' || tax === 'sales' ? tax : settings.sales_tax_no && !settings.service_tax_no ? 'sales' : 'service';
  const current = sstPeriodFor(today, m);
  const asked = first(params.period);
  const period =
    asked !== undefined && DATE_PATTERN.test(asked) && sstPeriodFor(asked, m).start === asked && asked <= current.start
      ? sstPeriodFor(asked, m)
      : current;
  return { type, period };
}
