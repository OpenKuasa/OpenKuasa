import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type BnmAnswer, type BnmGet, bnmGet } from './bnm-client';
import { type BnmReading, type FxRateInsert, LATEST_PATH, monthPath, readLatestAnswer, readMonthAnswer } from './fx-bnm';
import { addMonths, daysBetween, hasWeekdayBetween, malaysiaClock, monthOfDate } from './fx-dates';

/**
 * Fetching Bank Negara Malaysia's rates into finance_fx_rates, for the
 * operator's cron (POST /api/finance/fx-rates/fetch). Safe to call every few
 * minutes: it only reaches BNM when something is missing.
 *
 * The latest rates. BNM publishes the 1700 session on working days only; the
 * cron is asked after 17:30 Malaysian time on a weekday, once the newest rate
 * stored is not today's, and at most once an hour (a public holiday answers
 * with the last working day's rates, so a holiday costs about seven calls).
 * Before any rate is stored it is asked at once, whatever the time (and then
 * also at most once an hour).
 *
 * The back-fill. A currency with no rate in the last 7 days (every currency
 * on the first run, or after an outage), or whose newest stored rate is
 * followed by a missed working day before the latest answer's date (one bad
 * evening is enough: the latest request only ever returns the newest day),
 * gets its missing months fetched one
 * at a time, oldest first: from 24 months back on the first run, otherwise
 * from the month of its newest rate. The month reached is kept in
 * finance_fx_fetch_state, so the work goes on across calls. One call does at
 * most `FX_MAX_CALLS` requests in `FX_BUDGET_MS`.
 *
 * Nothing stored is replaced: rows go in with ON CONFLICT DO NOTHING.
 */

/** 17:30 Malaysian time, in minutes. The 1700 session is not out before then. */
export const FX_CUTOFF_MINUTES = 17 * 60 + 30;
/** How long one call to the route may spend, and how many requests it may make to BNM. */
export const FX_BUDGET_MS = 20_000;
export const FX_MAX_CALLS = 30;
/** No request waits longer than this, and none is started with less than `FX_MIN_REQUEST_MS` left. */
export const FX_REQUEST_TIMEOUT_MS = 15_000;
export const FX_MIN_REQUEST_MS = 2_000;
/** A failed or empty attempt at the latest rates is not repeated within the hour. */
export const FX_RETRY_MS = 60 * 60 * 1000;
/** A currency whose newest rate is older than this is back-filled. */
export const FX_STALE_DAYS = 7;
/** How far back the first run goes. */
export const FX_BACKFILL_MONTHS = 24;

/** What the route keeps between calls. `backfill` maps a currency to the next month to fetch, YYYY-MM. */
export type FxFetchState = { last_attempt_at: string | null; backfill: Record<string, string> };

/** The database, as the routine sees it, so the tests can hand it one in memory. */
export type FxStore = {
  readState: () => Promise<FxFetchState>;
  /** The newest 1700 rate date of each currency stored. */
  readNewest: () => Promise<Record<string, string>>;
  /** Inserts the rows that are not there yet; answers how many went in. */
  insert: (rows: FxRateInsert[]) => Promise<number>;
  writeState: (state: FxFetchState) => Promise<void>;
};

export type FxFetchResult = {
  /** False when BNM could not be read or a write failed; the next call tries again. */
  ok: boolean;
  /** Rows stored by this call. */
  stored: number;
  /** Requests made to BNM by this call. */
  calls: number;
  /** Currencies whose back-fill is not finished. */
  pending: number;
};

/** finance_fx_rates and finance_fx_fetch_state through the service client (service_role: select and insert, and update on the state). */
export function supabaseFxStore(client: SupabaseClient): FxStore {
  return {
    async readState() {
      const { data, error } = await client
        .from('finance_fx_fetch_state')
        .select('last_attempt_at, backfill')
        .eq('id', true)
        .maybeSingle();
      if (error) throw error;
      const backfill = (data?.backfill ?? {}) as Record<string, unknown>;
      return {
        last_attempt_at: (data?.last_attempt_at as string | null | undefined) ?? null,
        backfill: Object.fromEntries(
          Object.entries(backfill).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        ),
      };
    },
    async readNewest() {
      const { data, error } = await client.from('finance_fx_latest_rates').select('currency, rate_date');
      if (error) throw error;
      return Object.fromEntries(((data ?? []) as { currency: string; rate_date: string }[]).map((r) => [r.currency, r.rate_date]));
    },
    async insert(rows) {
      if (rows.length === 0) return 0;
      const { data, error } = await client
        .from('finance_fx_rates')
        .upsert(rows, { onConflict: 'source,currency,rate_date,session', ignoreDuplicates: true })
        .select('currency');
      if (error) throw error;
      return (data ?? []).length;
    },
    async writeState(state) {
      const { error } = await client
        .from('finance_fx_fetch_state')
        .upsert({ id: true, ...state, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw error;
    },
  };
}

/**
 * A failure as one word for the log: a database error's code, or an exception's
 * name (TimeoutError, TypeError for a refused connection). Never a message,
 * which could carry a URL or a value.
 */
export function errorLabel(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown } | null;
  if (e && typeof e.code === 'string' && e.code) return e.code;
  if (e && typeof e.name === 'string' && e.name) return e.name;
  return 'unknown';
}

/** Reads one answer from BNM, or says why it could not be read (for the log line, with no header in it). */
function reading(answer: BnmAnswer, read: (body: unknown) => BnmReading): BnmReading & { status: number } {
  if (answer.kind === 'not-json') return { kind: 'unusable', status: answer.status };
  // A 404 counts as "nothing" only when it is BNM's own `{"code":404}`; a 200 must hold rates.
  const result = read(answer.body);
  if (result.kind === 'none' && answer.status !== 404) return { kind: 'unusable', status: answer.status };
  if (result.kind === 'rates' && answer.status !== 200) return { kind: 'unusable', status: answer.status };
  return { ...result, status: answer.status };
}

export async function fetchFxRates(
  store: FxStore,
  options: { get?: BnmGet; now?: () => number } = {},
): Promise<FxFetchResult> {
  const get = options.get ?? bnmGet;
  const now = options.now ?? Date.now;
  const started = now();
  const clock = malaysiaClock(new Date(started));
  const month = monthOfDate(clock.date);
  let stored = 0;
  let calls = 0;
  let ok = true;

  const state = await store.readState();
  const newest = await store.readNewest();
  const backfill = { ...state.backfill };
  let lastAttempt = state.last_attempt_at;

  const remaining = () => FX_BUDGET_MS - (now() - started);
  const canCall = () => calls < FX_MAX_CALLS && remaining() >= FX_MIN_REQUEST_MS;
  const ask = async (path: string) => {
    calls += 1;
    return get(path, Math.min(FX_REQUEST_TIMEOUT_MS, remaining()));
  };

  // ---- the latest rates -----------------------------------------------------
  const newestDate = Object.values(newest).sort().at(-1) ?? null;
  const empty = newestDate === null;
  const weekday = clock.weekday >= 1 && clock.weekday <= 5;
  const triedLately = lastAttempt !== null && started - Date.parse(lastAttempt) < FX_RETRY_MS;
  const due = !triedLately && (empty || (weekday && clock.minutes >= FX_CUTOFF_MINUTES && newestDate !== clock.date));

  if (due && canCall()) {
    lastAttempt = new Date(started).toISOString();
    try {
      const answer = reading(await ask(LATEST_PATH), (body) => readLatestAnswer(body, clock.date));
      if (answer.kind === 'rates') {
        // Which currencies need their past months, decided before today's rows go in.
        for (const row of answer.rows) {
          const last = newest[row.currency];
          if (backfill[row.currency]) continue;
          if (last === undefined) backfill[row.currency] = addMonths(month, -FX_BACKFILL_MONTHS);
          else if (daysBetween(last, clock.date) > FX_STALE_DAYS || hasWeekdayBetween(last, row.rate_date)) {
            // Out for a week, or a working day lies between the newest stored rate and this answer's day.
            backfill[row.currency] = monthOfDate(last);
          }
        }
        stored += await store.insert(answer.rows);
      } else if (answer.kind === 'unusable') {
        ok = false;
        console.error(`[fx-rates] BNM's latest rates could not be read (status ${answer.status}).`);
      }
    } catch (error) {
      ok = false;
      console.error(`[fx-rates] BNM's latest rates could not be fetched or stored: ${errorLabel(error)}`);
    }
  }

  // ---- the back-fill, oldest month first --------------------------------------
  outer: for (const code of Object.keys(backfill).sort()) {
    while (backfill[code] !== undefined) {
      const next = backfill[code];
      if (next > month) {
        delete backfill[code];
        break;
      }
      if (!ok || !canCall()) break outer;
      try {
        const answer = reading(await ask(monthPath(code, next)), (body) => readMonthAnswer(body, code, next, clock.date));
        if (answer.kind === 'unusable') {
          ok = false;
          console.error(`[fx-rates] BNM's ${code} rates for ${next} could not be read (status ${answer.status}).`);
          break outer;
        }
        if (answer.kind === 'rates') stored += await store.insert(answer.rows);
        // A month BNM has nothing for (before the currency was listed) is passed over like a full one.
        backfill[code] = addMonths(next, 1);
      } catch (error) {
        ok = false;
        console.error(`[fx-rates] BNM's ${code} rates for ${next} could not be fetched or stored: ${errorLabel(error)}`);
        break outer;
      }
    }
  }

  await store.writeState({ last_attempt_at: lastAttempt, backfill });
  const pending = Object.keys(backfill).length;
  console.info(`[fx-rates] stored ${stored} rate(s) in ${calls} request(s); ${pending} currency back-fill(s) left.`);
  return { ok, stored, calls, pending };
}
