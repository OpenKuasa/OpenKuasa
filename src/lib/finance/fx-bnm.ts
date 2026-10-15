/**
 * Bank Negara Malaysia's exchange-rate answers, read into the rows of
 * finance_fx_rates. Pure: the call itself is in bnm-client.ts.
 *
 * Shape (the API's own specification, and live answers read on 2026-10-15):
 * `{ data, meta: { quote, session, last_updated, total_result } }`. `data` is
 * a list of `{ currency_code, unit, rate: { date, buying_rate, selling_rate,
 * middle_rate } }` for every currency; for one currency and one month it is
 * one object whose `rate` is a list of `{ date, … }`. The rate is ringgit per
 * `unit` (1 or 100) of the currency. SDR has no buying or selling rate (null).
 * Numbers carry binary noise (4.9168000000000003), so published rates are
 * kept to 6 decimals and the rate per one unit to 10.
 */
import { z } from 'zod';

/** The session every rate is taken from: the end of the day, middle rate (owner's decision, 2026-10-15). */
export const BNM_SESSION = '1700';
/** BNM's API, with no key. Every request names the session. */
export const BNM_BASE_URL = 'https://api.bnm.gov.my/public';
/** Without this header BNM answers with its portal's HTML page. */
export const BNM_ACCEPT = 'application/vnd.BNM.API.v1+json';

/** One row of finance_fx_rates as the route inserts it; `fetched_at` and `source` are the database's defaults. */
export type FxRateInsert = {
  currency: string;
  rate_date: string;
  session: string;
  unit: number;
  /** Ringgit per `unit`, as published, to 6 decimals; null when BNM gives none. Strings keep them exact. */
  buying_rate: string | null;
  selling_rate: string | null;
  middle_rate: string;
  /** Ringgit per one unit: the middle rate divided by `unit`, to 10 decimals. */
  rate: string;
};

const published = z.number().finite().positive().nullable();
const rateOnDay = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  buying_rate: published,
  selling_rate: published,
  middle_rate: published,
});
const currency = z.string().regex(/^[A-Z]{3}$/);
const unit = z.number().int().positive();
const meta = z.object({ session: z.literal(BNM_SESSION) });

const latestAnswer = z.object({
  data: z.array(z.object({ currency_code: currency, unit, rate: rateOnDay })),
  meta,
});
const monthAnswer = z.object({
  data: z.object({ currency_code: currency, unit, rate: z.array(rateOnDay) }),
  meta,
});
/** BNM's answer when it has nothing for the request: a weekend date, or a month with no rates. */
const noRecords = z.object({ code: z.literal(404) });

/** A published figure to 6 decimals, without the float's noise. */
function sixDecimals(n: number): string {
  return n.toFixed(6);
}

/** One currency's rate on one day, or null when BNM gave no middle rate. */
export function fxRateRow(code: string, perUnit: number, day: z.infer<typeof rateOnDay>): FxRateInsert | null {
  if (day.middle_rate === null) return null;
  const middle = Number(sixDecimals(day.middle_rate));
  return {
    currency: code,
    rate_date: day.date,
    session: BNM_SESSION,
    unit: perUnit,
    buying_rate: day.buying_rate === null ? null : sixDecimals(day.buying_rate),
    selling_rate: day.selling_rate === null ? null : sixDecimals(day.selling_rate),
    middle_rate: sixDecimals(day.middle_rate),
    rate: (middle / perUnit).toFixed(10),
  };
}

/** What one answer from BNM came to: rows, "nothing for that" (a 404 BNM sent on purpose), or unusable. */
export type BnmReading = { kind: 'rates'; rows: FxRateInsert[] } | { kind: 'none' } | { kind: 'unusable' };

/** The latest rates of every currency (`/exchange-rate?session=1700`). */
export function readLatestAnswer(body: unknown, today?: string): BnmReading {
  if (noRecords.safeParse(body).success) return { kind: 'none' };
  const parsed = latestAnswer.safeParse(body);
  if (!parsed.success) return { kind: 'unusable' };
  // Nothing is ever replaced once stored, so a date from the future is refused rather than kept.
  if (today !== undefined && parsed.data.data.some((item) => item.rate.date > today)) return { kind: 'unusable' };
  const rows = parsed.data.data.map((item) => fxRateRow(item.currency_code, item.unit, item.rate));
  return { kind: 'rates', rows: rows.filter((row): row is FxRateInsert => row !== null) };
}

/** One currency's rates for one month (`/exchange-rate/{code}/year/{y}/month/{m}?session=1700`). */
export function readMonthAnswer(body: unknown, expectedCurrency: string, month?: string, today?: string): BnmReading {
  if (noRecords.safeParse(body).success) return { kind: 'none' };
  const parsed = monthAnswer.safeParse(body);
  if (!parsed.success || parsed.data.data.currency_code !== expectedCurrency) return { kind: 'unusable' };
  const { currency_code, unit: perUnit, rate } = parsed.data.data;
  // Every day must fall in the month asked for and not after today (Malaysian date), or the answer is refused whole.
  if (rate.some((day) => (month !== undefined && day.date.slice(0, 7) !== month) || (today !== undefined && day.date > today))) {
    return { kind: 'unusable' };
  }
  const rows = rate.map((day) => fxRateRow(currency_code, perUnit, day));
  return { kind: 'rates', rows: rows.filter((row): row is FxRateInsert => row !== null) };
}

/** The path of one currency's month, e.g. /exchange-rate/USD/year/2026/month/9?session=1700. */
export function monthPath(code: string, month: string): string {
  return `/exchange-rate/${code}/year/${Number(month.slice(0, 4))}/month/${Number(month.slice(5, 7))}?session=${BNM_SESSION}`;
}

export const LATEST_PATH = `/exchange-rate?session=${BNM_SESSION}`;
