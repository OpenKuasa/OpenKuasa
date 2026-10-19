/**
 * Comparing the quotes for one request side by side. Copy to another supplier
 * makes a group: the first RFQ, and every RFQ that names it as its source (a
 * copy of a copy names the first too). Compare quotes lays a group's lines out
 * as rows and its suppliers as columns, and marks the lowest price on each
 * line. It marks figures only: the cheapest is not always the supplier chosen
 * (delivery time, past service), so the choice is the person's. Pure.
 *
 * Quotes may be in different currencies (stage 4p). Each is shown in its own
 * currency; what is compared is ringgit, at each RFQ's own indicative rate.
 * A quote with no exchange rate is shown but not compared: there is no
 * ringgit to compare it by. Quotes all in one currency are compared in it.
 */
import { lineAmounts } from './bill-math';
import { BASE_CURRENCY } from './currencies';
import { scaledFromText } from './document-currency';
import { money, rm } from './format';
import { rfqActions } from './purchase-views';
import type { RfqDetail, RfqListRow } from './rfqs';

/** The id a group goes by: the first RFQ's. */
export function rfqGroupId(row: Pick<RfqListRow, 'id' | 'source_rfq_id'>): string {
  return row.source_rfq_id ?? row.id;
}

/**
 * The RFQs whose quotes can be compared: those that have gone to their supplier, in a group where at
 * least one other has too. A draft has asked nobody anything yet, so it neither counts nor is offered.
 */
export function comparableRfqIds(rows: RfqListRow[]): Set<string> {
  const sent = rows.filter((row) => row.status !== 'draft');
  const counts = new Map<string, number>();
  for (const row of sent) counts.set(rfqGroupId(row), (counts.get(rfqGroupId(row)) ?? 0) + 1);
  return new Set(sent.filter((row) => (counts.get(rfqGroupId(row)) ?? 0) > 1).map((row) => row.id));
}

/**
 * How many RFQs were copied from this one, in any status: those that name it as the first of their
 * group. None for a copy, as a copy of a copy names the first RFQ and not the copy.
 */
export function rfqCopyCount(rows: RfqListRow[], row: Pick<RfqListRow, 'id'>): number {
  return rows.filter((other) => other.source_rfq_id === row.id).length;
}

/**
 * What deleting an RFQ costs its copies, for the question asked before a draft is deleted; null when
 * nothing was copied from it. Deleting the first RFQ of a group clears the link on every copy for good:
 * each is then a group of its own, which only copies made from it later can join.
 */
export function rfqDeleteWarning(rows: RfqListRow[], row: Pick<RfqListRow, 'id'>): string | null {
  const copies = rfqCopyCount(rows, row);
  if (copies === 0) return null;
  if (copies === 1) {
    return '1 RFQ was copied from this one. Deleting it leaves that RFQ on its own: its quote can then be compared only with RFQs copied from it afterwards.';
  }
  return `${copies} RFQs were copied from this one. Deleting it means their quotes cannot be compared with each other.`;
}

/**
 * The RFQ a "Make purchase order" question in the comparison is about, as the group now reads; null
 * when nothing is being asked, or that RFQ has left the group or can no longer be made into an order.
 * The group is read again after a refused order, so a question whose RFQ got an order meanwhile goes.
 */
export function orderableRfq(rfqs: RfqDetail[], id: string | null): RfqDetail | null {
  return rfqs.find((rfq) => rfq.id === id && rfqActions(rfq).includes('convert')) ?? null;
}

/** One supplier's answer on one line. */
export type QuoteCell = {
  quantity: number;
  /** null until the supplier's answer is recorded: a price typed on the RFQ before then is not a quote. */
  unit_price: number | null;
  sst_rate: number;
  /** The line's amount plus its SST, as the RFQ totals it; null when unpriced. */
  total: number | null;
  /** The lowest unit price on this line, SST included. Every supplier tied at the lowest is marked. */
  lowest: boolean;
  /**
   * This supplier's own description of the line, when it is not the row's: lines matched by product
   * can be worded differently, and a substitute is told apart only by its description. null when it
   * reads as the row's does.
   */
  description: string | null;
};

export type ComparisonRow = {
  key: string;
  description: string;
  uom: string | null;
  pack_size: string | null;
  /** One per RFQ, in the order given; null where that RFQ does not ask for this item. */
  cells: (QuoteCell | null)[];
};

const words = (text: string | null) => (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Which item a line asks for: its product, or else its description, in the same unit and pack size.
 * A copy keeps both, and a description edited by a space or a capital still matches. Two lines for
 * the same item on one RFQ stay two rows, matched in the order they were entered.
 */
function itemKeys(lines: RfqDetail['lines']): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const key = `${line.product_id ?? words(line.description)}|${words(line.uom)}|${words(line.pack_size)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return `${key}#${n}`;
  });
}

/**
 * What one unit costs once SST is paid, in whole 10^-6 ringgit, so prices compare exactly: SST on a
 * purchase is a cost, as no input tax is claimed back. Unit price keeps 4 decimals and the rate 2.
 */
function unitCost(price: number, rate: number): bigint {
  return BigInt(Math.round(price * 10 ** 4)) * BigInt(Math.round((100 + rate) * 100));
}

/** One unit of the RFQ's currency in ringgit, in 10^-10 units: exact, from the rate's text; null with no rate. */
function ringgitPerUnit(rfq: Pick<RfqListRow, 'currency' | 'fx_rate' | 'fx_rate_text'>): bigint | null {
  if (rfq.currency === BASE_CURRENCY) return BigInt(10) ** BigInt(10);
  if (rfq.fx_rate_text !== null) return scaledFromText(rfq.fx_rate_text) ?? null;
  return rfq.fx_rate === null ? null : (scaledFromText(rfq.fx_rate.toFixed(10)) ?? null);
}

/**
 * True when the RFQs whose answer was recorded are in more than one currency. An RFQ not yet quoted has no
 * figure to compare, so its currency does not make a ringgit-only comparison a mixed one.
 */
export function quotesInSeveralCurrencies(rfqs: Pick<RfqListRow, 'currency' | 'quoted_at'>[]): boolean {
  return new Set(rfqs.filter((r) => r.quoted_at !== null).map((r) => r.currency)).size > 1;
}

/** One supplier's total, as the comparison's last rows show it. */
export type QuoteTotal = {
  /** The total in the RFQ's own currency; null until the supplier's answer is recorded. */
  total: string | null;
  /** "≈ RM …" beside a total in another currency, "No exchange rate" when it has none; null for ringgit and unquoted. */
  ringgit: string | null;
  /**
   * The lowest ringgit total, when the quotes are in more than one currency and at least two have a ringgit total.
   * Every quote tied at the lowest is marked. Quotes all in one currency are read side by side as they always were.
   */
  lowest: boolean;
};

/**
 * Each RFQ's total in its own currency, its ringgit beside it when it is foreign, and, across currencies, the
 * lowest ringgit total marked. Only a quote whose answer was recorded counts; a foreign one with no rate is shown
 * but not ranked.
 */
export function quoteTotals(rfqs: RfqDetail[]): QuoteTotal[] {
  const mixed = quotesInSeveralCurrencies(rfqs);
  const ringgit = rfqs.map((r) => {
    if (r.quoted_at === null) return null;
    const myr = r.currency === BASE_CURRENCY ? (r.total_myr ?? r.total) : r.total_myr;
    // Whole sen, to compare: the figures are the database's, already rounded to the sen.
    return myr === null ? null : Math.round(myr * 100);
  });
  const ranked = ringgit.filter((sen): sen is number => sen !== null);
  const lowest = mixed && ranked.length >= 2 ? Math.min(...ranked) : null;
  return rfqs.map((r, i) => {
    if (r.quoted_at === null) return { total: null, ringgit: null, lowest: false };
    return {
      total: money(r.total, r.currency),
      ringgit: r.currency === BASE_CURRENCY ? null : r.total_myr === null ? 'No exchange rate' : `≈ ${rm(r.total_myr)}`,
      lowest: lowest !== null && ringgit[i] === lowest,
    };
  });
}

/**
 * The group's lines as rows, in the order the first RFQ lists them and then any line only a later RFQ
 * has, with one cell per RFQ. Only an RFQ whose answer was recorded (`quoted_at`) has prices here: the
 * form lets a buyer type a price before sending, and that is not the supplier's. The lowest price on a
 * line is marked only when at least two suppliers priced it: a price nobody else gave is not a comparison.
 * A row goes by the description on the first RFQ that has it; a cell worded differently keeps its own.
 */
export function compareQuotes(rfqs: RfqDetail[]): ComparisonRow[] {
  const rows = new Map<string, ComparisonRow>();
  rfqs.forEach((rfq, column) => {
    const keys = itemKeys(rfq.lines);
    rfq.lines.forEach((line, index) => {
      let row = rows.get(keys[index]);
      if (!row) {
        row = { key: keys[index], description: line.description, uom: line.uom, pack_size: line.pack_size, cells: rfqs.map(() => null) };
        rows.set(keys[index], row);
      }
      const unit_price = rfq.quoted_at === null ? null : line.unit_price;
      let total: number | null = null;
      if (unit_price !== null) {
        const { amount, sst } = lineAmounts({ quantity: line.quantity, unit_price, sst_rate: line.sst_rate });
        total = Math.round((amount + sst) * 100) / 100;
      }
      const description = words(line.description) === words(row.description) ? null : line.description;
      row.cells[column] = { quantity: line.quantity, unit_price, sst_rate: line.sst_rate, total, lowest: false, description };
    });
  });

  // One currency throughout: prices compare as they are. Else each in ringgit at its RFQ's rate, and a price
  // whose RFQ has no rate is left out (it cannot be put into ringgit).
  const oneCurrency = !quotesInSeveralCurrencies(rfqs);
  const perUnit = rfqs.map((r) => (oneCurrency ? BigInt(1) : ringgitPerUnit(r)));
  for (const row of rows.values()) {
    const priced = row.cells
      .map((c, column) => ({ c, rate: perUnit[column] }))
      .filter((p): p is { c: QuoteCell & { unit_price: number }; rate: bigint } => p.c !== null && p.c.unit_price !== null && p.rate !== null);
    if (priced.length < 2) continue;
    const costs = priced.map(({ c, rate }) => unitCost(c.unit_price, c.sst_rate) * rate);
    const lowest = costs.reduce((a, b) => (b < a ? b : a));
    priced.forEach(({ c }, i) => {
      c.lowest = costs[i] === lowest;
    });
  }
  return [...rows.values()];
}
