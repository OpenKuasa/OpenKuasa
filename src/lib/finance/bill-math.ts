/**
 * Bill arithmetic for the form's live totals. Pure, and exact: the sums are
 * done in whole numbers, so the figure on the form is the figure the database
 * stores, to the sen.
 */
// From document-lines.ts itself (bills.ts re-exports them), so bills.ts can use the document-currency helpers.
import { isIsoDate, roundRate } from './document-lines';

export type LineNumbers = {
  quantity: number;
  unit_price: number;
  sst_rate: number;
  /**
   * A discount on a sales line (invoices and quotations only; bills, RFQs and
   * purchase orders leave these unset). At most one is given: a percentage of
   * the line (0–100), or a fixed ringgit amount off it. Both the amount and
   * the SST are taken on the line net of the discount.
   */
  discount_pct?: number | null;
  discount_amount?: number | null;
  /**
   * This line's share of a discount on the whole document, in ringgit (sales
   * only; 0 or unset otherwise). It comes off the line after its own discount,
   * before rounding: amount = round(v - share, 2), SST on (v - share).
   */
  doc_discount_share?: number;
};
/** A discount on a whole sales document: a percentage (0–100] or a fixed amount, at most one set. */
export type DocDiscount = { pct: number | null; amount: number | null };
export type DocumentTotals = { subtotal: number; discount: number; sst: number; total: number };

export const DOC_DISCOUNT_LEAVES_NOTHING = 'A discount on the whole document must leave something to pay.';
export type LineAmounts = { amount: number; sst: number };
export type BillTotals = { subtotal: number; sst: number; total: number };

/** A whole number of 10^-places units; 0 for anything that is not a number above 0. */
function units(value: number, places: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return BigInt(0);
  const scaled = Math.round(value * 10 ** places);
  return Number.isFinite(scaled) ? BigInt(scaled) : BigInt(0);
}

/** Divides and rounds half up, as Postgres rounds a numeric. Both numbers are 0 or more. */
function divideRounded(value: bigint, by: bigint): bigint {
  return (value + by / BigInt(2)) / by;
}

/** Rounds half away from zero, as Postgres rounds a numeric; a share can take a line a fraction of a sen below 0. */
function roundSigned(value: bigint, by: bigint): bigint {
  return value < BigInt(0) ? -divideRounded(-value, by) : divideRounded(value, by);
}

/**
 * A line's value after its own discount, unrounded, as a whole number of
 * units, with how many of those units make a sen.
 */
function lineNet(line: LineNumbers): { net: bigint; perSen: bigint } {
  // Quantity keeps 3 decimals, unit price 4 and the SST rate 2, as saveBillInput rounds them.
  const product = units(line.quantity, 3) * units(line.unit_price, 4); // qty * price, in 10^-7 ringgit
  const pct = line.discount_pct;
  const fixed = line.discount_amount;

  // A percentage discount scales the whole product by (1 - pct/100), kept exact
  // as (10000 - pct*100)/10000. Mirrors qty*price*(1-pct/100).
  if (pct != null && pct > 0) {
    let keep = BigInt(10_000) - units(pct, 2);
    if (keep < BigInt(0)) keep = BigInt(0); // a pct over 100 (the schema refuses it) means nothing left
    return { net: product * keep, perSen: BigInt(100_000) * BigInt(10_000) }; // in 10^-11 ringgit
  }

  // A fixed discount is taken off the line, never below zero. Mirrors
  // greatest(qty*price - discount_amount, 0).
  if (fixed != null && fixed > 0) {
    const net = product - units(fixed, 2) * BigInt(100_000); // discount sen -> 10^-7 ringgit
    return { net: net < BigInt(0) ? BigInt(0) : net, perSen: BigInt(100_000) };
  }

  return { net: product, perSen: BigInt(100_000) };
}

/** amount = round(v - share, 2) and sst = round((v - share) * rate / 100, 2), in sen. */
function lineSenWithShare(line: LineNumbers, shareSen: bigint): { amount: bigint; sst: bigint } {
  const { net, perSen } = lineNet(line);
  const value = net - shareSen * perSen;
  const rate = units(roundRate(line.sst_rate), 2); // percent, in 10^-2
  return {
    amount: roundSigned(value, perSen),
    sst: roundSigned(value * rate, perSen * BigInt(10_000)),
  };
}

export function lineSen(line: LineNumbers): { amount: bigint; sst: bigint } {
  return lineSenWithShare(line, units(line.doc_discount_share ?? 0, 2));
}

/**
 * The document discount D and each line's share of it, in sen, in the lines'
 * order. Mirrors private.finance_doc_discount_split: each line's net is its
 * rounded amount after its own discount (any doc_discount_share it carries is
 * ignored); D is round(Σ net × pct / 100, 2) or the fixed amount, capped at
 * Σ net; share = floor(D × net / Σ net), and the sen left over go one each to
 * the largest remainders, ties to the lower index.
 */
export function docDiscountSen(lines: LineNumbers[], d: DocDiscount): { discount: bigint; shares: bigint[] } {
  const zero = BigInt(0);
  const nets = lines.map((line) => lineSenWithShare(line, zero).amount);
  const sum = nets.reduce((a, b) => a + b, zero);

  // The schema allows only one of the two; a percentage wins if both are given.
  let discount = zero;
  if (d.pct != null && d.pct > 0) discount = divideRounded(sum * units(d.pct, 2), BigInt(10_000));
  else if (d.amount != null && d.amount > 0) discount = units(d.amount, 2);
  if (discount > sum) discount = sum; // the form shows DOC_DISCOUNT_LEAVES_NOTHING; the split itself never fails
  if (discount === zero) return { discount, shares: nets.map(() => zero) };

  const shares = nets.map((net) => (discount * net) / sum);
  const remainders = nets.map((net) => (discount * net) % sum);
  let left = discount - shares.reduce((a, b) => a + b, zero);
  const order = nets
    .map((_, i) => i)
    .sort((a, b) => (remainders[a] === remainders[b] ? a - b : remainders[a] > remainders[b] ? -1 : 1));
  for (const i of order) {
    if (left === zero) break;
    shares[i] += BigInt(1);
    left -= BigInt(1);
  }
  return { discount, shares };
}

/**
 * A sales document's totals with its whole-document discount: the subtotal of
 * the lines before their shares, D, the SST on each line after its share, and
 * subtotal - D + SST. With no document discount these are billTotals' figures.
 */
export function documentTotals(lines: LineNumbers[], d: DocDiscount): DocumentTotals {
  const { discount, shares } = docDiscountSen(lines, d);
  let subtotal = BigInt(0);
  let sst = BigInt(0);
  lines.forEach((line, i) => {
    subtotal += lineSenWithShare(line, BigInt(0)).amount;
    sst += lineSenWithShare(line, shares[i]).sst;
  });
  return {
    subtotal: Number(subtotal) / 100,
    discount: Number(discount) / 100,
    sst: Number(sst) / 100,
    total: Number(subtotal - discount + sst) / 100,
  };
}

/**
 * One line's amount and SST. With no discount these mirror the generated columns
 * supplier_bill_lines.amount = round(quantity * unit_price, 2) and
 * .sst_amount = round(quantity * unit_price * sst_rate / 100, 2); with a sales
 * discount they mirror finance_invoice_lines / finance_quotation_lines, which
 * take both on the line net of the discount.
 */
export function lineAmounts(line: LineNumbers): LineAmounts {
  const sen = lineSen(line);
  return { amount: Number(sen.amount) / 100, sst: Number(sen.sst) / 100 };
}

/** Subtotal, SST and total: the sum of each line's rounded amounts, as supplier_bill_totals adds them. */
export function billTotals(lines: LineNumbers[]): BillTotals {
  let subtotal = BigInt(0);
  let sst = BigInt(0);
  for (const line of lines) {
    const sen = lineSen(line);
    subtotal += sen.amount;
    sst += sen.sst;
  }
  return { subtotal: Number(subtotal) / 100, sst: Number(sst) / 100, total: Number(subtotal + sst) / 100 };
}

/** 2026-10-11 plus 30 days is 2026-11-10. A date that is not valid comes back unchanged. */
export function addDaysIso(iso: string, days: number): string {
  if (!isIsoDate(iso) || !Number.isFinite(days)) return iso;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.trunc(days));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

/**
 * The date on the person's own calendar, as YYYY-MM-DD. Form defaults use it:
 * the UTC date is still yesterday until 08:00 in Malaysia.
 */
export function localIsoDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
