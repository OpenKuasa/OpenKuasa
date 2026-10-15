/**
 * Bill arithmetic for the form's live totals. Pure, and exact: the sums are
 * done in whole numbers, so the figure on the form is the figure the database
 * stores, to the sen.
 */
import { isIsoDate, roundRate } from './bills';

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
};
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

export function lineSen(line: LineNumbers): { amount: bigint; sst: bigint } {
  // Quantity keeps 3 decimals, unit price 4 and the SST rate 2, as saveBillInput rounds them.
  const product = units(line.quantity, 3) * units(line.unit_price, 4); // qty * price, in 10^-7 ringgit
  const rate = units(roundRate(line.sst_rate), 2);
  const pct = line.discount_pct;
  const fixed = line.discount_amount;

  // A percentage discount scales the whole product by (1 - pct/100), kept exact
  // as (10000 - pct*100)/10000. Mirrors amount = round(qty*price*(1-pct/100), 2).
  if (pct != null && pct > 0) {
    let keep = BigInt(10_000) - units(pct, 2);
    if (keep < BigInt(0)) keep = BigInt(0); // a pct over 100 (the schema refuses it) means nothing left
    const net = product * keep; // in 10^-11 ringgit
    return {
      amount: divideRounded(net, BigInt(100_000) * BigInt(10_000)),
      sst: divideRounded(net * rate, BigInt(1_000_000_000) * BigInt(10_000)),
    };
  }

  // A fixed discount is taken off the line, never below zero. Mirrors
  // amount = round(greatest(qty*price - discount_amount, 0), 2).
  if (fixed != null && fixed > 0) {
    let net = product - units(fixed, 2) * BigInt(100_000); // discount sen -> 10^-7 ringgit
    if (net < BigInt(0)) net = BigInt(0);
    return {
      amount: divideRounded(net, BigInt(100_000)),
      sst: divideRounded(net * rate, BigInt(1_000_000_000)),
    };
  }

  return {
    amount: divideRounded(product, BigInt(100_000)),
    sst: divideRounded(product * rate, BigInt(1_000_000_000)),
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
