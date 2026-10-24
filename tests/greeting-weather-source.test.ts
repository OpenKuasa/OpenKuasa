import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetWeatherCacheForTest, fetchWeather } from '../src/lib/greeting/weather-source';

const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

function stub(routes: { forecast?: unknown; reverse?: unknown; geocode?: unknown }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://geocoding-api.open-meteo.com/')) return json(routes.geocode);
    if (url.startsWith('https://api.open-meteo.com/')) return json(routes.forecast);
    if (url.includes('bigdatacloud')) return json(routes.reverse);
    throw new Error(`unexpected url ${url}`);
  });
}

const rainy = { current: { weather_code: 61, temperature_2m: 27 } };

describe('fetchWeather', () => {
  beforeEach(() => __resetWeatherCacheForTest());
  afterEach(() => vi.restoreAllMocks());

  it('reads coords, reverse-geocodes, and caches', async () => {
    const fetchImpl = stub({ forecast: rainy, reverse: { city: 'Shah Alam' } });
    const q = { lat: 3.0733, lon: 101.5185 };
    expect(await fetchWeather(q, { fetchImpl })).toEqual({ condition: 'rain', hot: false, place: 'Shah Alam' });
    const calls = fetchImpl.mock.calls.length;
    await fetchWeather(q, { fetchImpl });
    expect(fetchImpl.mock.calls.length).toBe(calls);
    __resetWeatherCacheForTest();
    await fetchWeather(q, { fetchImpl });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls);
  });

  it('prefers the MY geocode result for a city', async () => {
    const fetchImpl = stub({
      geocode: {
        results: [
          { country_code: 'US', name: 'Georgetown', latitude: 38.9, longitude: -77.0 },
          { country_code: 'MY', name: 'George Town', latitude: 5.41, longitude: 100.33 },
        ],
      },
      forecast: rainy,
    });
    const r = await fetchWeather({ city: 'Georgetown' }, { fetchImpl });
    expect(r?.place).toBe('George Town');
    const forecastUrl = String(fetchImpl.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('https://api.open-meteo.com/')));
    expect(forecastUrl).toContain('latitude=5.41');
    expect(forecastUrl).toContain('longitude=100.33');
  });

  it('returns null when no geocode result is in Malaysia', async () => {
    const fetchImpl = stub({
      geocode: { results: [{ country_code: 'US', name: 'Georgetown', latitude: 38.9, longitude: -77 }] },
      forecast: rainy,
    });
    expect(await fetchWeather({ city: 'Georgetown' }, { fetchImpl })).toBeNull();
  });

  it('returns null for no geocode results', async () => {
    const fetchImpl = stub({ geocode: { results: [] } });
    expect(await fetchWeather({ city: 'Nowhere' }, { fetchImpl })).toBeNull();
  });

  it('returns null when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await fetchWeather({ lat: 1, lon: 2 }, { fetchImpl })).toBeNull();
  });

  it('refetches after the 30 minute TTL', async () => {
    const fetchImpl = stub({ forecast: rainy, reverse: { locality: 'Klang' } });
    let t = 1_000;
    const deps = { fetchImpl, now: () => t };
    const q = { lat: 3.04, lon: 101.44 };
    await fetchWeather(q, deps);
    const calls = fetchImpl.mock.calls.length;
    t += 29 * 60_000;
    await fetchWeather(q, deps);
    expect(fetchImpl.mock.calls.length).toBe(calls);
    t += 2 * 60_000;
    await fetchWeather(q, deps);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls);
  });
});
