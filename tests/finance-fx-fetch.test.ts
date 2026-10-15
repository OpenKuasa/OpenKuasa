import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BnmAnswer, BnmGet } from '@/lib/finance/bnm-client';
import type { FxRateInsert } from '@/lib/finance/fx-bnm';
import { FX_MAX_CALLS, type FxFetchState, type FxStore, fetchFxRates } from '@/lib/finance/fx-fetch';

// The routine is handed a recorded BNM (`get`) and a database in memory
// (`store`), so nothing here reaches the network: tests/setup/no-network.ts
// would fail the file if it did.

const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/bnm', name), 'utf8')) as unknown;
const LATEST = fixture('latest-1700-2026-10-15.json');
const JPY_SEPTEMBER = fixture('jpy-1700-2026-09.json');
const ok = (body: unknown): BnmAnswer => ({ kind: 'json', status: 200, body });
const NONE: BnmAnswer = { kind: 'json', status: 404, body: { message: 'No records found.', code: 404 } };
const HTML: BnmAnswer = { kind: 'not-json', status: 200 };

/** 2026-10-15 is a Thursday. 09:30 UTC is 17:30 in Malaysia. */
const at = (iso: string) => () => Date.parse(iso);
const THURSDAY_1745 = at('2026-10-15T09:45:00Z');
const THURSDAY_1000 = at('2026-10-15T02:00:00Z');
const SATURDAY_1900 = at('2026-10-17T11:00:00Z');

/** A database in memory: rows keyed as the primary key is, inserted with ON CONFLICT DO NOTHING. */
function memoryStore(rows: FxRateInsert[] = [], state: FxFetchState = { last_attempt_at: null, backfill: {} }) {
  const table = new Map(rows.map((r) => [`${r.currency}|${r.rate_date}|${r.session}`, r]));
  const saved: { state: FxFetchState } = { state };
  const store: FxStore = {
    readState: async () => structuredClone(saved.state),
    readNewest: async () => {
      const newest: Record<string, string> = {};
      for (const r of table.values()) if (r.session === '1700' && !(newest[r.currency] >= r.rate_date)) newest[r.currency] = r.rate_date;
      return newest;
    },
    insert: async (incoming) => {
      let n = 0;
      for (const r of incoming) {
        const key = `${r.currency}|${r.rate_date}|${r.session}`;
        if (!table.has(key)) {
          table.set(key, r);
          n += 1;
        }
      }
      return n;
    },
    writeState: async (next) => {
      saved.state = structuredClone(next);
    },
  };
  return { store, table, saved };
}

/** One stored 1700 rate. */
const rate = (currency: string, rate_date: string, value = '4.0000000000'): FxRateInsert => ({
  currency,
  rate_date,
  session: '1700',
  unit: 1,
  buying_rate: null,
  selling_rate: null,
  middle_rate: value.slice(0, 8),
  rate: value,
});

/** Every currency of the recorded answer, stored up to `date`. */
const allUpTo = (date: string) =>
  (LATEST as { data: { currency_code: string }[] }).data.map((d) => rate(d.currency_code, date));

let paths: string[];
const recorded = (answer: (path: string) => BnmAnswer): BnmGet => async (path) => {
  paths.push(path);
  return answer(path);
};

beforeEach(() => {
  paths = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the latest rates', () => {
  it('are not asked for before 17:30 on a working day once rates are stored', async () => {
    const { store } = memoryStore(allUpTo('2026-10-14'));
    const result = await fetchFxRates(store, { get: recorded(() => ok(LATEST)), now: THURSDAY_1000 });
    expect(paths).toEqual([]);
    expect(result).toEqual({ ok: true, stored: 0, calls: 0, pending: 0 });
  });

  it('are asked for after 17:30 when today has none, and stored under the date BNM gives', async () => {
    const { store, table, saved } = memoryStore(allUpTo('2026-10-14'));
    const result = await fetchFxRates(store, { get: recorded(() => ok(LATEST)), now: THURSDAY_1745 });
    expect(paths).toEqual(['/exchange-rate?session=1700']);
    expect(result).toEqual({ ok: true, stored: 27, calls: 1, pending: 0 });
    expect(table.get('USD|2026-10-15|1700')?.rate).toBe('4.0815000000');
    expect(saved.state.last_attempt_at).toBe('2026-10-15T09:45:00.000Z');
  });

  it('are not asked for again once today is stored', async () => {
    const { store } = memoryStore(allUpTo('2026-10-15'));
    await fetchFxRates(store, { get: recorded(() => ok(LATEST)), now: THURSDAY_1745 });
    expect(paths).toEqual([]);
  });

  it('are asked for at most once an hour while they are still yesterday’s', async () => {
    const { store } = memoryStore(allUpTo('2026-10-14'), { last_attempt_at: '2026-10-15T09:31:00.000Z', backfill: {} });
    await fetchFxRates(store, { get: recorded(() => ok(LATEST)), now: THURSDAY_1745 });
    expect(paths).toEqual([]);
    await fetchFxRates(store, { get: recorded(() => ok(LATEST)), now: at('2026-10-15T10:32:00Z') });
    expect(paths).toEqual(['/exchange-rate?session=1700']);
  });

  it('are asked for at most once an hour even when no rate is stored yet', async () => {
    const { store } = memoryStore([], { last_attempt_at: '2026-10-15T09:31:00.000Z', backfill: {} });
    await fetchFxRates(store, { get: recorded(() => HTML), now: THURSDAY_1745 });
    expect(paths).toEqual([]);
  });

  it('are not asked for on a weekend', async () => {
    const { store } = memoryStore(allUpTo('2026-10-16'));
    await fetchFxRates(store, { get: recorded(() => ok(LATEST)), now: SATURDAY_1900 });
    expect(paths).toEqual([]);
  });

  it('change nothing when BNM answers with HTML, and the attempt still counts for the hour', async () => {
    const { store, table, saved } = memoryStore(allUpTo('2026-10-14'));
    const result = await fetchFxRates(store, { get: recorded(() => HTML), now: THURSDAY_1745 });
    expect(result).toEqual({ ok: false, stored: 0, calls: 1, pending: 0 });
    expect(table.size).toBe(27);
    expect(saved.state.last_attempt_at).toBe('2026-10-15T09:45:00.000Z');
    expect(console.error).toHaveBeenCalledWith("[fx-rates] BNM's latest rates could not be read (status 200).");
  });

  it('change nothing when the call fails or times out', async () => {
    const { store } = memoryStore(allUpTo('2026-10-14'));
    const timeout: BnmGet = async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    };
    const result = await fetchFxRates(store, { get: timeout, now: THURSDAY_1745 });
    expect(result.ok).toBe(false);
    expect(console.error).toHaveBeenCalledWith("[fx-rates] BNM's latest rates could not be fetched or stored: TimeoutError");
  });

  it('never replace a stored rate', async () => {
    const { store, table } = memoryStore([rate('USD', '2026-10-15', '4.1000000000')]);
    await fetchFxRates(store, { get: recorded(() => ok(LATEST)), now: THURSDAY_1000 });
    expect(table.get('USD|2026-10-15|1700')?.rate).toBe('4.1000000000');
  });
});

describe('a missed working day', () => {
  const answer = (path: string) => (path === '/exchange-rate?session=1700' ? ok(LATEST) : NONE);

  it('is back-filled on the next call: stored up to Tuesday, the latest answer is Thursday', async () => {
    const { store, saved } = memoryStore(allUpTo('2026-10-13'));
    const result = await fetchFxRates(store, { get: recorded(answer), now: THURSDAY_1745 });
    expect(paths[0]).toBe('/exchange-rate?session=1700');
    expect(paths[1]).toBe('/exchange-rate/AED/year/2026/month/10?session=1700');
    // One month call for each of the 27 currencies, all in the current month, and the latest request.
    expect(paths).toHaveLength(28);
    expect(result.ok).toBe(true);
    expect(result.pending).toBe(0);
    expect(saved.state.backfill).toEqual({});
  });

  it('is fetched by the month call and stored', async () => {
    const stored = [...allUpTo('2026-10-14').filter((r) => r.currency !== 'JPY'), rate('JPY', '2026-10-13')];
    const { store, table } = memoryStore(stored);
    const wednesday = JSON.parse(JSON.stringify(JPY_SEPTEMBER)) as { data: { rate: { date: string }[] } };
    wednesday.data.rate = [{ ...wednesday.data.rate[0], date: '2026-10-14' }];
    await fetchFxRates(store, {
      get: recorded((path) =>
        path === '/exchange-rate?session=1700' ? ok(LATEST) : path.includes('/JPY/year/2026/month/10?') ? ok(wednesday) : NONE,
      ),
      now: THURSDAY_1745,
    });
    expect(paths).toEqual(['/exchange-rate?session=1700', '/exchange-rate/JPY/year/2026/month/10?session=1700']);
    expect(table.has('JPY|2026-10-14|1700')).toBe(true);
  });

  it('is not looked for over an ordinary weekend: Friday stored, Monday answered', async () => {
    const latestMonday = JSON.parse(JSON.stringify(LATEST).replaceAll('2026-10-15', '2026-10-19')) as unknown;
    const { store, saved } = memoryStore(allUpTo('2026-10-16'));
    const result = await fetchFxRates(store, { get: recorded(() => ok(latestMonday)), now: at('2026-10-19T09:45:00Z') });
    expect(paths).toEqual(['/exchange-rate?session=1700']);
    expect(result).toEqual({ ok: true, stored: 27, calls: 1, pending: 0 });
    expect(saved.state.backfill).toEqual({});
  });

  it('still holds to the call limit: the rest waits for the next call', async () => {
    const { store, saved } = memoryStore(allUpTo('2026-09-28'));
    const result = await fetchFxRates(store, { get: recorded(answer), now: THURSDAY_1745 });
    expect(result.calls).toBe(FX_MAX_CALLS);
    expect(result.pending).toBe(Object.keys(saved.state.backfill).length);
    expect(result.pending).toBeGreaterThan(0);
  });
});

describe('the back-fill', () => {
  it('starts on the first run at any hour: the latest rates, then 24 months back for every currency, oldest first', async () => {
    const { store, saved } = memoryStore();
    const result = await fetchFxRates(store, {
      get: recorded((path) => (path === '/exchange-rate?session=1700' ? ok(LATEST) : NONE)),
      now: THURSDAY_1000,
    });
    expect(paths[0]).toBe('/exchange-rate?session=1700');
    // AED is first by code: its 25 months, October 2024 to October 2026, oldest first; then AUD until the
    // call budget is spent. AED is done and forgotten; the other 26 wait for the next call.
    expect(paths[1]).toBe('/exchange-rate/AED/year/2024/month/10?session=1700');
    expect(paths[25]).toBe('/exchange-rate/AED/year/2026/month/10?session=1700');
    expect(paths[26]).toBe('/exchange-rate/AUD/year/2024/month/10?session=1700');
    expect(result.calls).toBe(FX_MAX_CALLS);
    expect(result.pending).toBe(26);
    expect(saved.state.backfill.AED).toBeUndefined();
    expect(saved.state.backfill.AUD).toBe('2025-02');
    expect(saved.state.backfill.USD).toBe('2024-10');
  });

  it('goes on from where the last call stopped, through the current month, and then forgets the currency', async () => {
    const { store, table, saved } = memoryStore(allUpTo('2026-10-15'), { last_attempt_at: null, backfill: { JPY: '2026-09' } });
    const result = await fetchFxRates(store, {
      get: recorded((path) => (path.includes('/JPY/year/2026/month/9?') ? ok(JPY_SEPTEMBER) : NONE)),
      now: THURSDAY_1745,
    });
    expect(paths).toEqual([
      '/exchange-rate/JPY/year/2026/month/9?session=1700',
      '/exchange-rate/JPY/year/2026/month/10?session=1700',
    ]);
    expect(result).toEqual({ ok: true, stored: 21, calls: 2, pending: 0 });
    expect(table.get('JPY|2026-09-01|1700')?.rate).toBe('0.0252610000');
    expect(saved.state.backfill).toEqual({});
  });

  it('after an outage, picks up a currency from the month of its newest rate', async () => {
    const stored = [...allUpTo('2026-10-14').filter((r) => r.currency !== 'JPY'), rate('JPY', '2026-09-20')];
    const { store, saved } = memoryStore(stored);
    await fetchFxRates(store, { get: recorded((path) => (path === '/exchange-rate?session=1700' ? ok(LATEST) : NONE)), now: THURSDAY_1745 });
    expect(paths).toEqual([
      '/exchange-rate?session=1700',
      '/exchange-rate/JPY/year/2026/month/9?session=1700',
      '/exchange-rate/JPY/year/2026/month/10?session=1700',
    ]);
    expect(saved.state.backfill).toEqual({});
  });

  it('stops at the first failure and keeps the month it had reached', async () => {
    const { store, saved } = memoryStore(allUpTo('2026-10-15'), { last_attempt_at: null, backfill: { JPY: '2026-08', USD: '2026-09' } });
    const result = await fetchFxRates(store, { get: recorded(() => HTML), now: THURSDAY_1745 });
    expect(paths).toEqual(['/exchange-rate/JPY/year/2026/month/8?session=1700']);
    expect(result).toEqual({ ok: false, stored: 0, calls: 1, pending: 2 });
    expect(saved.state.backfill).toEqual({ JPY: '2026-08', USD: '2026-09' });
  });

  it('stops when its 20 seconds are spent', async () => {
    let clock = Date.parse('2026-10-15T09:45:00Z');
    const slow: BnmGet = async (path) => {
      paths.push(path);
      clock += 7_000;
      return NONE;
    };
    const { store } = memoryStore(allUpTo('2026-10-15'), { last_attempt_at: null, backfill: { JPY: '2025-01' } });
    const result = await fetchFxRates(store, { get: slow, now: () => clock });
    // 7 s, 14 s, then 21 s: past the budget, so no fourth request.
    expect(result.calls).toBe(3);
    expect(result.pending).toBe(1);
  });
});
