/**
 * What the FX Revaluation screen shows and sends (stage 6b), worked out in plain functions so they can be tested
 * without a browser. The database decides every figure (stage 6a, supabase/migrations/20261123100000_bendahara_fx_revaluation.sql,
 * through src/lib/finance/fx-revaluation.ts); this file only arranges what a preview gave, recomputes it in the
 * browser while a typed rate waits for the next preview (the bigint twin, revaluationLine), and builds what Post
 * sends.
 *
 * Two rules hold everything together:
 *   * Rates are per ONE unit in the database and per the unit BNM quotes in the box (per 100 for JPY and the like).
 *     A preview's rate goes into the box with `boxRateText`, and what is sent to an action is always box text,
 *     which the action's schema turns back into per-one text. A preview's `rate_text` is never sent as it is.
 *   * What posts is what the last preview showed. The post is built from a preview's items only
 *     (`postPayload`: its rates, read back with `ratesFromPreview`, and its digest, lines and net gain). While the
 *     boxes hold rates the preview was not worked out at, `withTypedRates` shows the browser's own figures and
 *     drops the digest, so nothing can be posted until the server has answered at those rates.
 *
 * Money is added in sen (bigint) and rates are worked in 10^-10 units; numbers are only for display.
 */
import { toCsv } from './csv';
import { quoteUnit } from './currencies';
import {
  type CurrencyFields,
  farRateQuestion,
  rateNotes,
  ringgitFields,
  scaledFromText,
  withRateConfirmed,
  withRateTyped,
} from './document-currency';
import { longDate } from './fx-rates';
import {
  FX_REVALUATION_MESSAGES,
  type RevaluationItem,
  type RevaluationKind,
  type RevaluationRun,
  boxRateText,
  expectedOf,
  isMonthEnd,
  perOneRateText,
  ratesFromPreview,
} from './fx-revaluation';
import { revaluationLine, ringgitOf, senFromNumber } from './fx-settlement';
import { addDays } from './view-helpers';

const ZERO = BigInt(0);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Nov 2026": the short date the confirm sentence and the history use. */
export function shortDay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/* ---- month ends ------------------------------------------------------------------------------------------- */

/** The last day of the month a YYYY-MM-DD date is in. */
function monthEndOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The last month end on or before today (Malaysia's date): today when it is one, else the end of last month. */
export function defaultMonthEnd(todayMalaysia: string): string {
  if (isMonthEnd(todayMalaysia)) return todayMalaysia;
  return addDays(`${todayMalaysia.slice(0, 7)}-01`, -1);
}

/**
 * Every month end from the one of `firstDate`'s month to the last on or before today, newest first. Never one
 * after today in Malaysia (the database refuses that, FIN53), and always at least the newest.
 */
export function monthEndsBetween(firstDate: string, todayMalaysia: string): string[] {
  const last = defaultMonthEnd(todayMalaysia);
  const first = monthEndOf(firstDate);
  const out: string[] = [last];
  let at = last;
  while (true) {
    const previous = addDays(`${at.slice(0, 7)}-01`, -1);
    if (previous < first) return out;
    out.push(previous);
    at = previous;
  }
}

/* ---- closing rates ---------------------------------------------------------------------------------------- */

/** One closing-rate box: a currency with a foreign balance that is not 0 on the month end needs a rate. */
export type RateRow = { currency: string; fields: CurrencyFields };

/** The box's label: "Closing rate (RM per 100 JPY)". */
export function closingRateLabel(currency: string): string {
  const unit = quoteUnit(currency);
  return `Closing rate (RM per ${unit === 1 ? currency : `${unit} ${currency}`})`;
}

/** The currencies whose items have a foreign balance that is not 0 (the ones a rate is asked for), sorted. */
export function neededCurrencies(items: Pick<RevaluationItem, 'currency' | 'foreign_balance'>[]): string[] {
  return [...new Set(items.filter((i) => i.foreign_balance !== 0).map((i) => i.currency))].sort();
}

/**
 * One box per needed currency, as a preview gave it: the rate it used (BNM's closing rate when none was sent), in
 * the box's unit, with BNM's own figure and date beside it so the form's notes ("Bank Negara Malaysia's 5 pm
 * selling rate of 30 October 2026.", the stale note, "Typed by hand. …") read as on every other rate box.
 */
export function rateRowsFrom(items: RevaluationItem[], periodEnd: string): RateRow[] {
  return neededCurrencies(items).map((currency) => {
    const item = items.find((i) => i.currency === currency && i.foreign_balance !== 0) as RevaluationItem;
    const bnmText = item.bnm_rate_text;
    const box = item.rate_text === null ? undefined : boxRateText(item.rate_text, currency);
    const source = item.rate_source ?? 'bnm';
    return {
      currency,
      fields: {
        ...ringgitFields(),
        currency,
        currencyEdited: true,
        rate: box ?? '',
        rateSource: box === undefined ? 'bnm' : source,
        rateDate: box !== undefined && source === 'bnm' ? item.rate_date : null,
        // BNM was asked for this currency and month end: its answer is the preview's.
        answered: `${currency}|${periodEnd}`,
        bnm:
          bnmText !== null && item.bnm_rate_date !== null
            ? { rate: Number(bnmText), rate_text: bnmText, rate_date: item.bnm_rate_date, unit: quoteUnit(currency), figure: 'selling' }
            : null,
      },
    };
  });
}

/**
 * The boxes after a new preview: a currency still needed keeps what was typed in it, a newly needed one gets the
 * preview's rate, and one no longer needed goes.
 */
export function mergeRateRows(current: RateRow[], fresh: RateRow[]): RateRow[] {
  return fresh.map((row) => current.find((c) => c.currency === row.currency) ?? row);
}

/** The person typed in a currency's box. Typing BNM's own figure back makes it BNM's again. */
export function withRowTyped(rows: RateRow[], currency: string, text: string): RateRow[] {
  return rows.map((r) => (r.currency === currency ? { ...r, fields: withRateTyped(r.fields, text) } : r));
}

/** What the form says under a box: BNM's rate and date, the stale note, or "Typed by hand". */
export function rateRowNotes(row: RateRow, periodEnd: string): string[] {
  return rateNotes(row.fields, periodEnd, 'selling');
}

/** A box's rate per one unit as exact text, ten decimals; undefined when it is empty or not a usable rate. */
function rowPerOne(row: RateRow): string | undefined {
  return perOneRateText(row.fields.rate, row.currency);
}

/** BNM's mark goes with a rate only while the box holds BNM's figure for a date the form knows. */
function rowSource(row: RateRow): { source: 'bnm' | 'manual'; rate_date: string | null } {
  return row.fields.rateSource === 'bnm' && row.fields.rateDate !== null
    ? { source: 'bnm', rate_date: row.fields.rateDate }
    : { source: 'manual', rate_date: null };
}

/** The first currency whose box is empty or not a rate above 0, or null when every box holds one. */
export function missingRate(rows: RateRow[]): string | null {
  return rows.find((r) => rowPerOne(r) === undefined)?.currency ?? null;
}

/**
 * What a preview is sent for these boxes: `closingRatesInput`'s shape, the rate as typed in the box's unit (the
 * schema turns it into per-one text). Null while a box is empty or unusable: a preview sent no rate fills BNM's,
 * which is not what the box shows.
 */
export function previewRates(rows: RateRow[]): Record<string, { rate: string; source: 'bnm' | 'manual'; rate_date?: string }> | null {
  if (missingRate(rows) !== null) return null;
  const out: Record<string, { rate: string; source: 'bnm' | 'manual'; rate_date?: string }> = {};
  for (const row of rows) {
    const { source, rate_date } = rowSource(row);
    out[row.currency] = source === 'bnm' ? { rate: row.fields.rate.trim(), source, rate_date: rate_date as string } : { rate: row.fields.rate.trim(), source };
  }
  return out;
}

/** Whether every box holds exactly the rate (and source and date) the preview's items were worked out at. */
export function ratesMatch(items: RevaluationItem[], rows: RateRow[]): boolean {
  if (neededCurrencies(items).join() !== rows.map((r) => r.currency).sort().join()) return false;
  return rows.every((row) => {
    const item = items.find((i) => i.currency === row.currency && i.foreign_balance !== 0);
    const typed = rowPerOne(row);
    if (!item || item.rate_text === null || typed === undefined) return false;
    const { source, rate_date } = rowSource(row);
    return (
      scaledFromText(item.rate_text) === scaledFromText(typed) &&
      item.rate_source === source &&
      (source === 'manual' || item.rate_date === rate_date)
    );
  });
}

/**
 * The items at the rates in the boxes. When they are the preview's own rates, the preview's items as they came
 * (digest and all). Otherwise each line is worked out again in the browser as the database would
 * (revaluationLine), and every digest is dropped: the server has not seen these rates, so nothing can be posted
 * until the next preview answers. A currency whose box is not a usable rate gets no figures.
 */
export function withTypedRates(items: RevaluationItem[], rows: RateRow[]): RevaluationItem[] {
  if (ratesMatch(items, rows)) return items;
  return items.map((item) => {
    const row = rows.find((r) => r.currency === item.currency);
    const perOne = row ? rowPerOne(row) : undefined;
    const scaled = perOne === undefined ? null : (scaledFromText(perOne) ?? null);
    const line = revaluationLine(
      item.kind,
      senFromNumber(item.foreign_balance),
      senFromNumber(item.carried_myr),
      senFromNumber(item.earlier_myr),
      scaled,
    );
    const { source, rate_date } = row ? rowSource(row) : { source: null, rate_date: null };
    return {
      ...item,
      rate_text: perOne ?? null,
      rate_source: perOne === undefined ? null : source,
      rate_date: perOne === undefined ? null : rate_date,
      revalued_myr: line ? ringgitOf(line.revalued) : null,
      difference: line ? ringgitOf(line.difference) : null,
      posted_myr: line ? ringgitOf(line.posted) : null,
      gain: line ? ringgitOf(line.gain) : null,
      digest: null,
    };
  });
}

/**
 * The question asked once before posting a rate more than 20% from BNM's (the form's own rule), or null. The
 * rows come back marked as asked, so the next Post goes ahead.
 */
export function farRatesQuestion(rows: RateRow[]): { question: string; rows: RateRow[] } | null {
  const far = rows.find((r) => farRateQuestion(r.fields) !== null);
  if (!far) return null;
  const question = (farRateQuestion(far.fields) as string).replace('Save again to keep it.', 'Post again to keep it.');
  return { question, rows: rows.map((r) => (r.currency === far.currency ? { ...r, fields: withRateConfirmed(r.fields) } : r)) };
}

/* ---- figures ---------------------------------------------------------------------------------------------- */

export type RevaluationTotals = {
  lines: number;
  /** The net unrealised gain (a loss below 0) these lines post. Null while a figure is missing. */
  netGain: number | null;
  gains: number;
  losses: number;
  /** The ringgit worth of the foreign items at the closing rates: invoices and accounts, less bills. */
  revaluedMyr: number;
  /** How many lines post something (a figure that is not 0). */
  toPost: number;
  currencies: string[];
  /** Every line has its figures (every needed currency has a rate). */
  complete: boolean;
};

/** The screen's tiles, added in sen. */
export function revaluationTotals(items: RevaluationItem[]): RevaluationTotals {
  let net = ZERO;
  let gains = ZERO;
  let losses = ZERO;
  let revalued = ZERO;
  let toPost = 0;
  let complete = true;
  for (const item of items) {
    if (item.gain === null || item.revalued_myr === null || item.posted_myr === null) {
      complete = false;
      continue;
    }
    const gain = senFromNumber(item.gain);
    net += gain;
    if (gain > ZERO) gains += gain;
    if (gain < ZERO) losses += gain;
    const value = senFromNumber(item.revalued_myr);
    revalued += item.kind === 'bill' ? -value : value;
    if (item.posted_myr !== 0) toPost += 1;
  }
  return {
    lines: items.length,
    netGain: complete ? ringgitOf(net) : null,
    gains: ringgitOf(gains),
    losses: ringgitOf(losses),
    revaluedMyr: ringgitOf(revalued),
    toPost,
    currencies: neededCurrencies(items),
    complete,
  };
}

/** The sentence a converted account carries: no foreign money left, the ringgit left is the gain or loss on converting. */
export function itemNote(item: Pick<RevaluationItem, 'kind' | 'currency' | 'foreign_balance' | 'carried_myr'>): string | null {
  if (item.kind !== 'account' || item.foreign_balance !== 0 || item.carried_myr === 0) return null;
  return `Converted: no ${item.currency} left; the ringgit left is the gain or loss on converting.`;
}

export const KIND_LABELS: Record<RevaluationKind, string> = {
  invoice: 'Invoices',
  bill: 'Supplier bills',
  account: 'Bank and cash accounts',
};
const KIND_ONE: Record<RevaluationKind, string> = { invoice: 'Invoice', bill: 'Supplier bill', account: 'Account' };
const KIND_ORDER: RevaluationKind[] = ['invoice', 'bill', 'account'];

/** The items grouped by kind (invoices, bills, accounts), each in reference order, with what the group posts. */
export function groupItems<T extends RevaluationItem>(items: T[]): { kind: RevaluationKind; label: string; items: T[]; gain: number | null }[] {
  return KIND_ORDER.map((kind) => {
    const of = items.filter((i) => i.kind === kind).sort((a, b) => a.reference.localeCompare(b.reference) || a.currency.localeCompare(b.currency));
    let sum = ZERO;
    let known = true;
    for (const i of of) {
      if (i.gain === null) known = false;
      else sum += senFromNumber(i.gain);
    }
    return { kind, label: KIND_LABELS[kind], items: of, gain: known ? ringgitOf(sum) : null };
  }).filter((g) => g.items.length > 0);
}

/** A rate per one unit as the table shows it: in the box's unit, to 4 places ("4.4800", "2.9500 per 100"). */
export function rateShown(perOneText: string | null, currency: string): string {
  if (perOneText === null) return '—';
  const scaled = scaledFromText(perOneText);
  if (scaled === undefined) return '—';
  const per100 = quoteUnit(currency) === 100;
  // Ten decimals per one; per 100 moves the point two places. Rounded half up to four places.
  const inBox = per100 ? scaled * BigInt(100) : scaled;
  const by = BigInt(10) ** BigInt(6);
  const four = (inBox + by / BigInt(2)) / by;
  const whole = four / BigInt(10000);
  const fraction = (four % BigInt(10000)).toString().padStart(4, '0');
  return `${whole}.${fraction}${per100 ? ' per 100' : ''}`;
}

/* ---- posting ---------------------------------------------------------------------------------------------- */

/** FIN54's sentence before anything is asked: a later month end is already posted. Null when none is. */
export function laterRunBlock(periodEnd: string, runs: Pick<RevaluationRun, 'revaluation_no' | 'period_end'>[]): string | null {
  const later = runs.filter((r) => r.period_end > periodEnd).sort((a, b) => (a.period_end < b.period_end ? 1 : -1))[0];
  return later ? FX_REVALUATION_MESSAGES.laterRun(later.revaluation_no, later.period_end) : null;
}

/**
 * Why Post cannot be pressed for these items, or null when it can: a rate missing, a later month end posted,
 * nothing to post (no line posts a figure that is not 0: two lines that offset each other still post), or the
 * figures not yet worked out by the server at the rates in the boxes.
 */
export function postBlock(items: RevaluationItem[], rows: RateRow[], periodEnd: string, runs: RevaluationRun[]): string | null {
  const later = laterRunBlock(periodEnd, runs);
  if (later) return later;
  const missing = missingRate(rows);
  if (missing) return FX_REVALUATION_MESSAGES.rate(missing);
  const totals = revaluationTotals(items);
  if (!totals.complete) return FX_REVALUATION_MESSAGES.rate(null);
  if (totals.toPost === 0) return FX_REVALUATION_MESSAGES.nothing(periodEnd);
  if (expectedOf(items) === null) return WORKING_OUT;
  return null;
}

/** Said while a typed rate waits for the server's figures. */
export const WORKING_OUT = 'Working out the figures at these rates…';

/**
 * What Post sends, built from a preview's items only: the rates that preview used, back in the box's unit
 * (`ratesFromPreview`; the action's schema reads them per one unit again), and what it showed (`expectedOf`: the
 * digest, unchanged, the number of lines and the net gain). Null when those items cannot be posted as they are.
 */
export function postPayload(periodEnd: string, items: RevaluationItem[]) {
  const expected = expectedOf(items);
  if (expected === null) return null;
  // Only the rates the screen shows a box for (a currency with a balance): one for a converted account at 0 is
  // never sent, so a refusal can only be about a rate the person saw.
  const needed = new Set(neededCurrencies(items));
  const rates = Object.fromEntries(Object.entries(ratesFromPreview(items)).filter(([currency]) => needed.has(currency)));
  return { period_end: periodEnd, rates, expected };
}

/** "Post FX revaluation for 31 October 2026? It is dated 31 Oct 2026 and reversed on 1 Nov 2026." */
export function postQuestion(periodEnd: string): string {
  return `Post FX revaluation for ${longDate(periodEnd)}? It is dated ${shortDay(periodEnd)} and reversed on ${shortDay(addDays(periodEnd, 1))}.`;
}

/** What the screen says when a month end has nothing to revalue. */
export function emptyNote(periodEnd: string | null): string {
  return periodEnd
    ? `No foreign-currency invoices, bills or accounts at ${longDate(periodEnd)}. Nothing to revalue.`
    : 'No foreign-currency invoices, bills or accounts. Nothing to revalue.';
}

/* ---- history ---------------------------------------------------------------------------------------------- */

/** A posted run's lines as a CSV file, one row per item. */
export function revaluationCsv(run: RevaluationRun): string {
  return toCsv(
    ['Kind', 'Reference', 'Party', 'Currency', 'Foreign balance', 'Rate (RM per 1 unit)', 'Carried RM', 'Revalued RM', 'Earlier RM', 'Posted RM', 'Gain RM'],
    groupItems(run.lines).flatMap((g) =>
      g.items.map((l) => [
        KIND_ONE[l.kind],
        l.reference,
        l.party,
        l.currency,
        l.foreign_balance,
        l.rate_text,
        l.carried_myr,
        l.revalued_myr,
        l.earlier_myr,
        l.posted_myr,
        l.gain,
      ]),
    ),
  );
}
