/**
 * Month-end FX revaluation (stage 6a, supabase/migrations/20261123100000_bendahara_fx_revaluation.sql). The
 * database decides every rule; this file sends what the person chose and words what comes back.
 *
 * At a month end the owner revalues every foreign-currency item in the books on that day (an open foreign
 * invoice, an open foreign bill, a foreign bank or cash account) at a closing rate, and the difference is posted
 * to Unrealised Exchange Gain or Loss, dated the month end, with its reversal the next day.
 *   * `previewFxRevaluation` (any member, read only): the items, what each carries, what it revalues to and what
 *     a run would post. With no rate sent for a currency it fills BNM's closing rate (`CLOSING_RATE_RULE`).
 *   * `postFxRevaluation` (an owner or admin): posts them in one call, only if the figures still equal what the
 *     preview showed (`expected`: the preview's digest of every item, the number of lines and the net gain; FIN55
 *     otherwise). No draft is kept.
 *   * `listFxRevaluations`: the posted runs, each with its rates and lines. A run is never changed (FIN01).
 *
 * Rates travel as exact decimal text both ways (`rate::text`). The database takes and gives them per ONE unit; the
 * box (and so `closingRatesInput`) is per 100 for a currency BNM quotes per 100 (`quoteUnit`). The schema turns
 * what was typed into text per one unit, ten decimals, as the tables keep it; a preview's rate goes back into the
 * box's unit with `boxRateText` (or `ratesFromPreview`), never as `rate_text` itself, which for JPY would be read
 * per 100 and post a rate 100 times too small. No money is worked out here in floating point: the net gain of a run is added in sen (bigint).
 */
import { z } from 'zod';
import { isIsoDate } from './document-lines';
import { quoteUnit } from './currencies';
import { scaledFromText } from './document-currency';
import { type RevaluationKind, ringgitOf, senFromNumber } from './fx-settlement';
import { type FinResult, type FinanceWriteContext, FIN_SIGN_OFF, NOT_ALLOWED, PG_FORBIDDEN, pgCode, writeFailed } from './result';

export type { RevaluationKind };

/**
 * THE closing rate (plan decision 1): Bank Negara Malaysia's 17:00 selling rate per one unit, the newest on or
 * before the month end. private.finance_fx_closing_rate says the same; change the two together.
 */
export const CLOSING_RATE_RULE = { source: 'bnm', session: '1700', figure: 'selling', date: 'period_end' } as const;

/** A rate the tables keep: ten decimals, above 0, below 10^10 (numeric(20,10)). */
const RATE_PLACES = 10;
const RATE_ONE = BigInt(10) ** BigInt(RATE_PLACES);
const RATE_LIMIT = BigInt(10) ** BigInt(20);

/** Codes this file answers (each worded here, never in a shared map). */
const FIN_MONTH_END = 'FIN53';
const FIN_LATER_RUN = 'FIN54';
const FIN_CHANGED = 'FIN55';
const FIN_NOTHING = 'FIN56';
const FIN_RATE = 'FIN38';
const FIN_NOT_BNM = 'FIN39';
const FIN_POSTED_FIXED = 'FIN01';

/** Fixed names: Intl's short months vary by ICU version ("Sep" or "Sept"), and a sentence must not. */
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date as the sentences show it: "30 Nov 2026", "1 Sep 2026". */
function shortDate(date: string): string {
  if (!isIsoDate(date)) return date;
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${SHORT_MONTHS[Number(m) - 1]} ${y}`;
}

export const FX_REVALUATION_MESSAGES = {
  // FIN53, and what the schema says first.
  monthEnd: 'Choose the last day of a month, on or before today.',
  // FIN54: the newest posted run, read again for the sentence.
  laterRun: (revaluationNo: string, periodEnd: string) =>
    `${revaluationNo} for ${shortDate(periodEnd)} is already posted. Month ends are revalued in order, so an earlier one cannot be revalued now.`,
  // FIN54 when the newest run could not be read back.
  laterRunUnknown: 'A later month end is already posted. Month ends are revalued in order, so an earlier one cannot be revalued now.',
  // FIN55.
  changed: 'The figures changed since this page worked them out: a payment, a document or a rate may have arrived. Look at them again, then post.',
  // FIN56.
  nothing: (periodEnd: string) => `Nothing to post: every foreign-currency balance at ${shortDate(periodEnd)} is already at these rates.`,
  // FIN38, with the currencies the database named when it could.
  rate: (currencies: string | null) =>
    currencies ? `Enter the closing rate for ${currencies} before posting.` : 'Enter the closing rate for each currency before posting.',
  // FIN39.
  notBnmRate:
    'That rate is not Bank Negara Malaysia’s 5 pm selling rate for that month end. Type it in again, or reload the page.',
  // FIN14, and what the server action says before anything is sent.
  needsSignOff: 'Only an owner or admin can post an FX revaluation.',
  // 42501 on a preview, which only reads: a stale session, or someone not in the workspace.
  noAccess: 'You do not have access to this workspace’s books.',
  // FIN01.
  locked: 'A posted FX revaluation is not changed. Run the month end again to post a correction.',
  // The schema's own sentences.
  rateTyped: 'Enter each closing rate as a number above 0.',
  rateDate: 'A Bank Negara Malaysia rate carries its date; a typed rate does not.',
  expected: 'Look at the figures again, then post.',
} as const;

const M = FX_REVALUATION_MESSAGES;

/** Whether a YYYY-MM-DD date is the last day of its month. */
export function isMonthEnd(date: string): boolean {
  if (!isIsoDate(date)) return false;
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000);
  return next.getUTCDate() === 1;
}

/**
 * What was typed in a rate box (per 100 for a currency BNM quotes per 100, else per one), as exact decimal text per
 * ONE unit with ten decimals, rounded half up once past ten places, as the database's round(…, 10) does a rate
 * above 0; undefined when it is not a plain decimal above 0 that the tables can hold.
 */
export function perOneRateText(typed: string, currency: string): string | undefined {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(typed.trim());
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return undefined;
  const fraction = m[2] ?? '';
  const digits = BigInt(`${m[1]}${fraction}` || '0');
  const places = fraction.length + (quoteUnit(currency) === 100 ? 2 : 0);
  let scaled: bigint;
  if (places <= RATE_PLACES) {
    scaled = digits * BigInt(10) ** BigInt(RATE_PLACES - places);
  } else {
    const by = BigInt(10) ** BigInt(places - RATE_PLACES);
    scaled = (digits + by / BigInt(2)) / by;
  }
  if (scaled <= BigInt(0) || scaled >= RATE_LIMIT) return undefined;
  const whole = scaled / RATE_ONE;
  const rest = (scaled % RATE_ONE).toString().padStart(RATE_PLACES, '0');
  return `${whole}.${rest}`;
}

/**
 * A rate per ONE unit, as the database gives it ("0.0295000000"), in the box's unit: per 100 for a currency BNM
 * quotes per 100 ("2.95"), else as it is, trailing zeros dropped. Exact (whole numbers only); undefined when the
 * text is not a plain decimal. `closingRatesInput` reads the answer back to the same rate per one unit.
 */
export function boxRateText(perOneText: string, currency: string): string | undefined {
  const scaled = scaledFromText(perOneText);
  if (scaled === undefined) return undefined;
  const places = RATE_PLACES - (quoteUnit(currency) === 100 ? 2 : 0);
  const unit = BigInt(10) ** BigInt(places);
  const whole = scaled / unit;
  const fraction = (scaled % unit).toString().padStart(places, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

const monthEndDate = z.string({ error: M.monthEnd }).refine(isMonthEnd, M.monthEnd);

const closingRate = z
  .object({
    rate: z.string({ error: M.rateTyped }),
    source: z.enum(['bnm', 'manual'], { error: M.rateTyped }),
    rate_date: z.string().refine(isIsoDate, M.rateDate).nullish(),
  })
  .refine((r) => (r.source === 'bnm') === (r.rate_date != null), { message: M.rateDate });

/**
 * The closing rates, by currency: what was typed (per the box's unit) with its source, and BNM's date for a BNM
 * rate. Each becomes exact text per one unit for the database.
 */
export const closingRatesInput = z
  .record(z.string().regex(/^[A-Z]{3}$/, M.rateTyped).refine((c) => c !== 'MYR', M.rateTyped), closingRate)
  .transform((rates, ctx) => {
    const out: Record<string, { rate: string; source: 'bnm' | 'manual'; rate_date?: string }> = {};
    for (const [currency, r] of Object.entries(rates)) {
      const rate = perOneRateText(r.rate, currency);
      if (rate === undefined) {
        ctx.addIssue({ code: 'custom', message: M.rateTyped, path: [currency, 'rate'] });
        return z.NEVER;
      }
      out[currency] = r.source === 'bnm' ? { rate, source: 'bnm', rate_date: r.rate_date as string } : { rate, source: 'manual' };
    }
    return out;
  });

/** A preview: a month end, and the rates typed so far (BNM's closing rate fills any not sent). */
export const previewFxRevaluationInput = z.object({
  period_end: monthEndDate,
  rates: closingRatesInput.default({}),
});

/** A post: the same, and what the preview showed (the number of lines and the net gain, to the sen). */
export const postFxRevaluationInput = previewFxRevaluationInput.extend({
  expected: z.object(
    {
      lines: z.number({ error: M.expected }).int(M.expected).min(1, M.expected),
      net_gain: z.string({ error: M.expected }).regex(/^-?\d{1,12}(\.\d{1,2})?$/, M.expected),
      // The preview's digest of every item: the post refuses (FIN55) when its items differ from what was shown.
      digest: z.string({ error: M.expected }).regex(/^[0-9a-f]{32}$/, M.expected),
    },
    { error: M.expected },
  ),
});

/**
 * What the schemas give: rates per ONE unit as exact text. The functions below take this, already parsed (the
 * server actions parse; a caller of its own parses with the schema first). It is not parsed twice: parsing turns a
 * rate typed per 100 into one per one unit, which a second parse would divide again.
 */
export type PreviewFxRevaluation = z.output<typeof previewFxRevaluationInput>;
export type PostFxRevaluation = z.output<typeof postFxRevaluationInput>;

export type RevaluationItem = {
  kind: RevaluationKind;
  item_id: string;
  reference: string;
  party: string | null;
  currency: string;
  foreign_balance: number;
  carried_myr: number;
  earlier_myr: number;
  rate_text: string | null;
  rate_source: 'bnm' | 'manual' | null;
  rate_date: string | null;
  bnm_rate_text: string | null;
  bnm_rate_date: string | null;
  revalued_myr: number | null;
  difference: number | null;
  posted_myr: number | null;
  gain: number | null;
  /** The preview's digest of every item (the same on each row); null on a stored line. Sent back as `expected.digest`. */
  digest: string | null;
};

export type RevaluationRun = {
  id: string;
  revaluation_no: string;
  period_end: string;
  posted_at: string;
  posted_by: string | null;
  rates: { currency: string; rate_text: string; rate_source: 'bnm' | 'manual'; rate_date: string | null }[];
  lines: (RevaluationItem & { id: string })[];
  /** The run's net gain (a loss below 0), added in sen. */
  net_gain: number;
};

/** The net gain of some lines, added in sen; null when a line has no figure yet (a rate is missing). */
export function netGain(lines: Pick<RevaluationItem, 'gain'>[]): number | null {
  let sum = BigInt(0);
  for (const l of lines) {
    if (l.gain === null) return null;
    sum += senFromNumber(l.gain);
  }
  return ringgitOf(sum);
}

/**
 * What the post function expects for these lines, as the preview showed them: their digest, how many and the net
 * gain. Null while a rate is missing, or when there is nothing (no digest) to post.
 */
export function expectedOf(
  lines: Pick<RevaluationItem, 'gain' | 'digest'>[],
): { lines: number; net_gain: string; digest: string } | null {
  let sum = BigInt(0);
  for (const l of lines) {
    if (l.gain === null) return null;
    sum += senFromNumber(l.gain);
  }
  const digest = lines[0]?.digest ?? null;
  if (digest === null) return null;
  const negative = sum < BigInt(0);
  const abs = negative ? -sum : sum;
  const text = `${negative ? '-' : ''}${abs / BigInt(100)}.${(abs % BigInt(100)).toString().padStart(2, '0')}`;
  return { lines: lines.length, net_gain: text, digest };
}

/**
 * The rates a preview used, by currency, in the box's unit (`boxRateText`), with their source and BNM's date: what
 * `closingRatesInput` takes, so sending a preview's rates back posts exactly the same rates.
 */
export function ratesFromPreview(
  items: Pick<RevaluationItem, 'currency' | 'rate_text' | 'rate_source' | 'rate_date'>[],
): Record<string, { rate: string; source: 'bnm' | 'manual'; rate_date?: string }> {
  const out: Record<string, { rate: string; source: 'bnm' | 'manual'; rate_date?: string }> = {};
  for (const item of items) {
    if (item.rate_text === null || item.rate_source === null || out[item.currency]) continue;
    const rate = boxRateText(item.rate_text, item.currency);
    if (rate === undefined) continue;
    out[item.currency] =
      item.rate_source === 'bnm' && item.rate_date
        ? { rate, source: 'bnm', rate_date: item.rate_date }
        : { rate, source: 'manual' };
  }
  return out;
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toItem(row: Record<string, unknown>): RevaluationItem {
  return {
    kind: row.kind as RevaluationKind,
    item_id: String(row.item_id),
    reference: String(row.reference),
    party: textOrNull(row.party),
    currency: String(row.currency),
    foreign_balance: num(row.foreign_balance),
    carried_myr: num(row.carried_myr),
    earlier_myr: num(row.earlier_myr),
    rate_text: textOrNull(row.rate_text),
    rate_source: (row.rate_source ?? null) as RevaluationItem['rate_source'],
    rate_date: textOrNull(row.rate_date),
    bnm_rate_text: textOrNull(row.bnm_rate_text),
    bnm_rate_date: textOrNull(row.bnm_rate_date),
    revalued_myr: numOrNull(row.revalued_myr),
    difference: numOrNull(row.difference),
    posted_myr: numOrNull(row.posted_myr),
    gain: numOrNull(row.gain),
    digest: textOrNull(row.digest),
  };
}

/** The currencies a FIN38 from the database named ("enter the closing rate for USD, SGD"), or null. */
function namedCurrencies(error: unknown): string | null {
  const message = (error as { message?: string } | null)?.message ?? '';
  // Only the post function's "enter the closing rate for USD, SGD" names the missing ones; FIN38's other messages
  // (a typed rate with a date, a key that is not a currency) get the general sentence.
  const m = /^enter the closing rate for ([A-Z]{3}(?:, [A-Z]{3})*)$/.exec(message);
  return m ? m[1] : null;
}

/**
 * The sentence for a refusal a preview or a post met, or null when it is not one this screen words. FIN54 and
 * FIN56 need more than the code: `postFxRevaluation` words those itself. `reading` is true for a preview, which
 * changes nothing, so a 42501 there says the books cannot be read rather than that a change is not allowed.
 */
export function fxRevaluationRefusal(error: unknown, reading = false): string | null {
  switch (pgCode(error)) {
    case FIN_MONTH_END:
      return M.monthEnd;
    case FIN_CHANGED:
      return M.changed;
    case FIN_RATE:
      return M.rate(namedCurrencies(error));
    case FIN_NOT_BNM:
      return M.notBnmRate;
    case FIN_SIGN_OFF:
      return M.needsSignOff;
    case FIN_POSTED_FIXED:
      return M.locked;
    case PG_FORBIDDEN:
      return reading ? M.noAccess : NOT_ALLOWED;
    default:
      return null;
  }
}

/**
 * What a run for the month end would post, at the rates sent (BNM's closing rate where none is). Any member.
 * Throws when the read fails or is refused; `fxRevaluationRefusal` words a refusal.
 */
export async function previewFxRevaluation(
  ctx: FinanceWriteContext,
  input: PreviewFxRevaluation,
): Promise<RevaluationItem[]> {
  const { period_end, rates } = input;
  const { data, error } = await ctx.client.rpc('finance_fx_revaluation_preview', {
    target_org: ctx.orgId,
    period_end,
    rates,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(toItem);
}

/** The newest posted run, for FIN54's sentence; null when it cannot be read. */
async function newestRun(ctx: FinanceWriteContext): Promise<{ revaluation_no: string; period_end: string } | null> {
  const { data, error } = await ctx.client
    .from('finance_fx_revaluations')
    .select('revaluation_no,period_end')
    .eq('org_id', ctx.orgId)
    .order('period_end', { ascending: false })
    .order('posted_at', { ascending: false })
    .limit(1);
  if (error) return null;
  const row = ((data ?? []) as { revaluation_no: string; period_end: string }[])[0];
  return row ?? null;
}

/**
 * Posts a run: an owner or admin only (FIN14). Refused when the month end is not one (FIN53), a later month end is
 * posted (FIN54), a needed rate is missing (FIN38) or not BNM's (FIN39), there is nothing to post (FIN56), or the
 * figures differ from `expected` (FIN55). Nothing is written and no number is used when it is refused.
 */
export async function postFxRevaluation(
  ctx: FinanceWriteContext,
  run: PostFxRevaluation,
): Promise<FinResult<{ id: string; revaluation_no: string }>> {
  const { data, error } = await ctx.client.rpc('finance_post_fx_revaluation', { target_org: ctx.orgId, run });
  if (error) {
    const code = pgCode(error);
    if (code === FIN_LATER_RUN) {
      const later = await newestRun(ctx);
      return { ok: false, error: later ? M.laterRun(later.revaluation_no, later.period_end) : M.laterRunUnknown };
    }
    if (code === FIN_NOTHING) return { ok: false, error: M.nothing(run.period_end) };
    const refusal = fxRevaluationRefusal(error);
    return refusal ? { ok: false, error: refusal } : writeFailed('postFxRevaluation', error);
  }
  const row = ((Array.isArray(data) ? data : [data]) as { id: string; revaluation_no: string }[])[0];
  if (!row) return writeFailed('postFxRevaluation', new Error('no run came back'));
  return { ok: true, data: { id: row.id, revaluation_no: row.revaluation_no } };
}

/* ---- reads ------------------------------------------------------------ */

const PAGE_SIZE = 1000;
const RUN_COLUMNS = 'id,revaluation_no,period_end,posted_at,posted_by';
const RATE_COLUMNS = 'revaluation_id,currency,rate_text:rate::text,rate_source,rate_date';
const LINE_COLUMNS =
  'id,revaluation_id,kind,invoice_id,bill_id,account_id,reference,party,currency,foreign_balance,' +
  'rate_text:rate::text,carried_myr,revalued_myr,difference,earlier_myr,posted_myr,gain';

/** Every workspace row of a table, a page at a time, in a stable order. Throws when a read fails. */
async function readAll(
  ctx: FinanceWriteContext,
  table: string,
  columns: string,
  order: string[],
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = ctx.client.from(table).select(columns).eq('org_id', ctx.orgId);
    for (const column of order) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

/** Every posted run, newest month end first, each with its rates and lines. Throws when a read fails. */
export async function listFxRevaluations(ctx: FinanceWriteContext): Promise<RevaluationRun[]> {
  const [runs, rates, lines] = await Promise.all([
    readAll(ctx, 'finance_fx_revaluations', RUN_COLUMNS, ['period_end', 'posted_at', 'id']),
    readAll(ctx, 'finance_fx_revaluation_rates', RATE_COLUMNS, ['revaluation_id', 'currency']),
    readAll(ctx, 'finance_fx_revaluation_lines', LINE_COLUMNS, ['revaluation_id', 'kind', 'currency', 'reference', 'id']),
  ]);
  const ratesOf = new Map<string, RevaluationRun['rates']>();
  for (const r of rates) {
    const list = ratesOf.get(String(r.revaluation_id)) ?? [];
    list.push({
      currency: String(r.currency),
      rate_text: String(r.rate_text),
      rate_source: r.rate_source as 'bnm' | 'manual',
      rate_date: textOrNull(r.rate_date),
    });
    ratesOf.set(String(r.revaluation_id), list);
  }
  const linesOf = new Map<string, RevaluationRun['lines']>();
  for (const l of lines) {
    const runId = String(l.revaluation_id);
    const rate = (ratesOf.get(runId) ?? []).find((r) => r.currency === l.currency && l.rate_text !== null);
    const list = linesOf.get(runId) ?? [];
    list.push({
      ...toItem({
        ...l,
        item_id: l.invoice_id ?? l.bill_id ?? l.account_id,
        rate_source: rate?.rate_source ?? null,
        rate_date: rate?.rate_date ?? null,
        bnm_rate_text: null,
        bnm_rate_date: null,
      }),
      id: String(l.id),
    });
    linesOf.set(runId, list);
  }
  return runs
    .map((r) => {
      const id = String(r.id);
      const runLines = linesOf.get(id) ?? [];
      return {
        id,
        revaluation_no: String(r.revaluation_no),
        period_end: String(r.period_end),
        posted_at: String(r.posted_at),
        posted_by: textOrNull(r.posted_by),
        rates: ratesOf.get(id) ?? [],
        lines: runLines,
        net_gain: netGain(runLines) ?? 0,
      };
    })
    .reverse();
}
