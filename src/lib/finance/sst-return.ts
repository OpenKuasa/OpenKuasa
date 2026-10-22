/**
 * The SST-02 return for one taxable period, service tax or sales tax, worked out on invoice basis from plain
 * invoice-line and credit-note rows. Pure, with no server imports, so the screen and the tests both use it.
 *
 * Every sum is made in whole sen and turned back into ringgit at the edge, as reports.ts does. Only the ringgit
 * columns are read (amount_myr, sst_amount_myr): a foreign line has nothing else here to read.
 *
 * Periods: an invoice line counts by its invoice date, a credit note by its credit date. A document voided in
 * the period it was dated in counts nowhere. One voided in a later period counts in its own period, and the
 * void period's 13(a) moves by its tax: up for an invoice, down for a credit note (13(a) may go below 0).
 * An off-form line voided later moves nothing, because its tax was never in item 12.
 *
 * Typed-in figures (11(e) cards, 13(b), 13(c), 13(d), 13A) come in as a fifth argument: 11(e) joins item 12, the rest come off item 14.
 */
import { type SstPeriod, type SstSettings, type SstTaxType, sstPeriodFor, taxTypeForRate } from './sst';

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
  /** The part of 13(a), in ringgit, from invoice lines of earlier periods voided in this one; 0 otherwise. */
  voidedTax: number;
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
const CREDIT_NOTES = { item: '13(a)', label: 'Tax from credit notes' };
const BAD_DEBT: SstFormLine = { item: '13(d)', label: 'Bad debt relief (approved)', value: null, tax: 0, typed: true };
const TYPED_DEDUCTIONS: Record<SstReturnType, SstFormLine[]> = {
  service: [{ item: '13(c)', label: 'Approved service tax deduction', value: null, tax: 0, typed: true }, BAD_DEBT],
  sales: [
    { item: '13(b)', label: 'Sales tax deduction', value: null, tax: 0, typed: true },
    { item: '13A', label: 'Adjustment to the sales tax deduction', value: null, tax: 0, typed: true },
    BAD_DEBT,
  ],
};

const toSen = (amount: number) => Math.round(amount * 100);
const fromSen = (sen: number) => sen / 100;

const within = (date: string, p: SstPeriod) => date >= p.start && date <= p.end;

/**
 * How a document dated `date` stands in period p: 'counts' when it belongs to p's return as normal,
 * 'reversed' when it was dated before p and voided within p, else null. A void with no void date is treated
 * as voided where it was dated, so counts nowhere.
 */
function standing(date: string, isVoid: boolean, voidedOn: string | null, p: SstPeriod): 'counts' | 'reversed' | null {
  if (within(date, p)) {
    if (!isVoid) return 'counts';
    return voidedOn !== null && voidedOn > p.end ? 'counts' : null;
  }
  if (isVoid && voidedOn !== null && date < p.start && within(voidedOn, p)) return 'reversed';
  return null;
}

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
): SstReturn {
  const items = SST_FORM_ITEMS[type];
  const b2Sen = items.map(() => ({ value: 0, tax: 0 }));
  const groups = new Map<string, { label: string; labelDate: string; labelId: string; code: string | null; value: number }>();
  const offForm = { count: 0, value: 0, tax: 0 };
  const untyped = { count: 0, value: 0 };
  let creditNotesSen = 0;
  let voidedSen = 0;

  for (const l of lines) {
    const where = standing(l.invoice_date, l.invoice_status === 'void', l.voided_on, period);
    if (where === null) continue;
    const effective = l.tax_type ?? taxTypeForRate(l.sst_rate);
    if (effective === null) {
      if (where === 'counts' && l.sst_rate > 0) {
        untyped.count += 1;
        untyped.value += toSen(l.amount_myr);
      }
      continue;
    }
    if (effective !== type || l.sst_rate === 0) continue;
    const at = items.findIndex((i) => i.rate === l.sst_rate);
    if (where === 'reversed') {
      // Only tax that was on the form (item 12) of its own period comes back through 13(a).
      if (at >= 0) {
        creditNotesSen += toSen(l.sst_amount_myr);
        voidedSen += toSen(l.sst_amount_myr);
      }
      continue;
    }
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
    const where = standing(c.credit_date, c.status === 'void', c.voided_on, period);
    if (where === 'counts') creditNotesSen += creditTaxSen(c, type);
    else if (where === 'reversed') creditNotesSen -= creditTaxSen(c, type);
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
    voidedTax: fromSen(voidedSen),
  };
}

/** The first day of the month before the one `date` (YYYY-MM-DD) falls in. */
function monthBefore(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, '0')}-01`;
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
