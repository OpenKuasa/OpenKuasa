/**
 * Comparing the quotes for one request side by side. Copy to another supplier
 * makes a group: the first RFQ, and every RFQ that names it as its source (a
 * copy of a copy names the first too). Compare quotes lays a group's lines out
 * as rows and its suppliers as columns, and marks the lowest price on each
 * line. The cheapest is not always the supplier chosen (delivery time, past
 * service), so the choice is the person's: a split only starts on the lowest. Pure.
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
  /** The RFQ line this answers: what Split between suppliers chooses. */
  line_id: string;
  quantity: number;
  /** null until the supplier's answer is recorded: a price typed on the RFQ before then is not a quote. */
  unit_price: number | null;
  sst_rate: number;
  /** The line's amount plus its SST, as the RFQ totals it; null when unpriced. */
  total: number | null;
  /** The lowest unit price on this line, SST included. Every supplier tied at the lowest is marked. */
  lowest: boolean;
  /**
   * What one unit costs in the terms `lowest` compares by (see unitCost, in ringgit when the quotes are in several
   * currencies); null when unpriced, or when its RFQ has no exchange rate to put it into ringgit.
   */
  cost: bigint | null;
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

const RATE_SCALE = BigInt(10) ** BigInt(10);

/** One unit of the RFQ's currency in ringgit, in 10^-10 units: exact, from the rate's text; null with no rate. */
function ringgitPerUnit(rfq: Pick<RfqListRow, 'currency' | 'fx_rate' | 'fx_rate_text'>): bigint | null {
  if (rfq.currency === BASE_CURRENCY) return RATE_SCALE;
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
      row.cells[column] = { line_id: line.id, quantity: line.quantity, unit_price, sst_rate: line.sst_rate, total, lowest: false, cost: null, description };
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
    const costs = priced.map(({ c, rate }) => unitCost(c.unit_price, c.sst_rate) * rate);
    priced.forEach(({ c }, i) => {
      c.cost = costs[i];
    });
    if (priced.length < 2) continue;
    const lowest = costs.reduce((a, b) => (b < a ? b : a));
    priced.forEach(({ c }, i) => {
      c.lowest = costs[i] === lowest;
    });
  }
  return [...rows.values()];
}

/* ---- splitting between suppliers ---------------------------------------- */

/** The line chosen for each row: the row's key, then the id of the RFQ whose answer it is. A row not in it is not ordered. */
export type SplitChoice = Record<string, string>;

/** Chooses an RFQ's answer for a row, taking the row from whichever had it; choosing the same again clears the row. */
export function toggleChoice(choice: SplitChoice, key: string, rfqId: string): SplitChoice {
  const { [key]: current, ...rest } = choice;
  return current === rfqId ? rest : { ...rest, [key]: rfqId };
}

/**
 * Where choosing starts. A row starts on the one supplier marked lowest on it or, when no price is marked, the one
 * supplier who quoted it. A tie marks every tied cell, so a tie starts on none, as does a row nobody quoted: those are
 * the person's to decide. With an order already made from the request nothing starts chosen: this screen can't tell
 * which lines that order holds, and the database doesn't stop a row being ordered twice across separate splits.
 */
export function startingChoice(rows: ComparisonRow[], rfqs: RfqDetail[]): SplitChoice {
  const choice: SplitChoice = {};
  if (rfqs.some((r) => r.purchase_order_id !== null)) return choice;
  for (const row of rows) {
    const quoted = row.cells.flatMap((c, i) => (c && c.unit_price !== null ? [i] : []));
    const lowest = quoted.filter((i) => row.cells[i]?.lowest);
    const only = lowest.length > 0 ? lowest : quoted;
    if (only.length === 1 && rfqActions(rfqs[only[0]]).includes('convert')) choice[row.key] = rfqs[only[0]].id;
  }
  return choice;
}

/**
 * Whether ordering this cell needs a reason, as the database decides it for a split (finance_award_rfq_lines): another
 * RFQ's comparable price for the same row is strictly lower ('lower'), or, with the quotes in several currencies, this
 * one has no exchange rate to compare by and another RFQ quoted the row ('no_rate'). A tie, or a row only this RFQ
 * quoted, needs none. tests/bendahara-rfq-split.test.ts holds this to the database.
 */
export function cellNeedsReason(row: ComparisonRow, column: number, mixed: boolean): 'lower' | 'no_rate' | null {
  const cell = row.cells[column];
  if (!cell || cell.unit_price === null) return null;
  const others = row.cells.filter((c, j): c is QuoteCell => j !== column && c !== null && c.unit_price !== null);
  if (mixed && cell.cost === null) return others.length > 0 ? 'no_rate' : null;
  const cost = cell.cost;
  return cost !== null && others.some((o) => o.cost !== null && o.cost < cost) ? 'lower' : null;
}

/** One draft order a split would make: the lines chosen from one RFQ. */
export type SplitOrder = {
  rfq: RfqDetail;
  /** The chosen lines, in row order. */
  lines: { row: ComparisonRow; cell: QuoteCell }[];
  /** How many lines this RFQ quoted, chosen or not. */
  quoted: number;
  /** The chosen lines' amounts and SST, in whole sen of the RFQ's own currency. */
  sen: number;
  /** The items that need a reason: another supplier quoted them for less, or this quote has no exchange rate. */
  lower: string[];
  noRate: string[];
};

export type SplitPlan = {
  /** One per supplier with a chosen line, in the order of the columns. */
  orders: SplitOrder[];
  /** The quotes are in several currencies: figures are then ringgit at each RFQ's own indicative rate. */
  mixed: boolean;
  /** What `totalSen` and `rowSen` are in. */
  currency: string;
  /** Each chosen row's amount in sen, in `currency`; null when its RFQ has no rate (mixed only). A row not chosen is absent. */
  rowSen: Record<string, number | null>;
  /** The chosen lines added up, leaving out those in `unrated`. */
  totalSen: number;
  /** Chosen lines with no exchange rate, left out of `totalSen` because they cannot be put into ringgit. */
  unrated: number;
  /** Rows nobody quoted, so nothing to order. */
  noQuote: number;
  /** Rows somebody quoted that no line is chosen for. */
  notChosen: number;
};

/** The label of the button that makes the split's orders. */
export const makeSplitLabel = (n: number) => (n === 1 ? 'Make purchase order' : `Make ${n} purchase orders`);

/** The label of the button that opens the question before them. */
export const reviewSplitLabel = (n: number) => (n === 1 ? 'Review purchase order' : n === 0 ? 'Review purchase orders' : `Review ${n} purchase orders`);

/** What the split sends: each order's RFQ, lines and the reason typed for it, which the input schema trims. */
export function splitAwards(plan: Pick<SplitPlan, 'orders'>, reasons: Record<string, string>) {
  return plan.orders.map((o) => ({ rfq_id: o.rfq.id, line_ids: o.lines.map((l) => l.cell.line_id), reason: reasons[o.rfq.id] }));
}

/** The sentence under an order's reason box, when it needs one; null when it doesn't. */
export function splitReasonHint(order: Pick<SplitOrder, 'lower' | 'noRate'>): string | null {
  const says = (items: string[], what: string) => (items.length ? `${items.join(', ')} ${items.length === 1 ? 'has' : 'have'} ${what}` : null);
  const needs = [says(order.lower, 'a lower quote'), says(order.noRate, 'no exchange rate to compare')].filter((text) => text !== null);
  return needs.length ? `Needs a reason: ${needs.join('. ')}.` : null;
}

/**
 * What choosing these lines would do: the orders, the figures beside the comparison and the lines left out. A
 * choice whose RFQ can no longer be ordered, or whose cell is gone, is ignored, so a group read again after a
 * refusal needs no tidying. Indicative: the order itself is converted at its own date's rate by the database.
 */
export function splitPlan(rfqs: RfqDetail[], rows: ComparisonRow[], choice: SplitChoice): SplitPlan {
  const mixed = quotesInSeveralCurrencies(rfqs);
  const orders: SplitOrder[] = rfqs.map((rfq) => ({ rfq, lines: [], quoted: 0, sen: 0, lower: [], noRate: [] }));
  const plan: SplitPlan = {
    orders: [],
    mixed,
    currency: mixed ? BASE_CURRENCY : (rfqs.find((r) => r.quoted_at !== null)?.currency ?? BASE_CURRENCY),
    rowSen: {},
    totalSen: 0,
    unrated: 0,
    noQuote: 0,
    notChosen: 0,
  };
  for (const row of rows) {
    row.cells.forEach((c, i) => {
      if (c && c.unit_price !== null) orders[i].quoted += 1;
    });
    if (!row.cells.some((c) => c && c.unit_price !== null)) {
      plan.noQuote += 1;
      continue;
    }
    const column = rfqs.findIndex((r) => r.id === choice[row.key]);
    const cell = column < 0 ? null : row.cells[column];
    if (!cell || cell.total === null || !rfqActions(rfqs[column]).includes('convert')) {
      plan.notChosen += 1;
      continue;
    }
    const order = orders[column];
    const own = Math.round(cell.total * 100);
    order.lines.push({ row, cell });
    order.sen += own;
    const needs = cellNeedsReason(row, column, mixed);
    if (needs) (needs === 'lower' ? order.lower : order.noRate).push(row.description);
    const rate = mixed ? ringgitPerUnit(rfqs[column]) : RATE_SCALE;
    if (rate === null) {
      plan.rowSen[row.key] = null;
      plan.unrated += 1;
    } else {
      // Whole sen, rounded half up: a cell's amount is never negative.
      const sen = Number((BigInt(own) * rate + RATE_SCALE / BigInt(2)) / RATE_SCALE);
      plan.rowSen[row.key] = sen;
      plan.totalSen += sen;
    }
  }
  plan.orders = orders.filter((o) => o.lines.length > 0);
  return plan;
}
