import type { WeatherResult } from './types';
import { conditionFromWmo, isHot } from './weather';

export type WeatherQuery = { lat: number; lon: number } | { city: string; state?: string | null };
export type WeatherDeps = { fetchImpl: typeof fetch; now?: () => number };

const TTL_MS = 30 * 60_000;
const cache = new Map<string, { at: number; value: WeatherResult | null }>();

export function __resetWeatherCacheForTest(): void {
  cache.clear();
}

/** A log-safe label for an error: its code or name, never its message (which could carry a URL). */
export function errorLabel(e: unknown): string {
  const err = e as { code?: unknown; name?: unknown } | null;
  if (err && typeof err.code === 'string' && err.code) return err.code;
  if (err && typeof err.name === 'string' && err.name) return err.name;
  return 'unknown';
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function forecast(fetchImpl: typeof fetch, lat: number, lon: number) {
  const body = (await getJson(
    fetchImpl,
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code,temperature_2m`,
  )) as { current?: { weather_code?: unknown; temperature_2m?: unknown } };
  const code = body?.current?.weather_code;
  const temp = body?.current?.temperature_2m;
  if (typeof code !== 'number' || typeof temp !== 'number') throw new Error('bad forecast');
  return { condition: conditionFromWmo(code), hot: isHot(temp) };
}

type GeoResult = { country_code?: string; name?: string; latitude?: number; longitude?: number };

function cacheKey(q: WeatherQuery): string {
  if ('city' in q) return `city:${q.city.trim().toLowerCase()}`;
  return `${q.lat.toFixed(2)},${q.lon.toFixed(2)}`;
}

/** Current weather for coords or a city; null when unknown or on any failure. Never throws. */
export async function fetchWeather(query: WeatherQuery, deps: WeatherDeps): Promise<WeatherResult | null> {
  const now = deps.now ?? Date.now;
  const key = cacheKey(query);
  const hit = cache.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.value;

  try {
    let value: WeatherResult | null;
    if ('city' in query) {
      const geo = (await getJson(
        deps.fetchImpl,
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.city)}&count=5&language=en`,
      )) as { results?: GeoResult[] };
      const results = Array.isArray(geo?.results) ? geo.results : [];
      const pick = results.find((r) => r.country_code === 'MY') ?? results[0];
      if (!pick || typeof pick.latitude !== 'number' || typeof pick.longitude !== 'number') {
        value = null;
      } else {
        const f = await forecast(deps.fetchImpl, pick.latitude, pick.longitude);
        value = { ...f, place: pick.name ?? null };
      }
    } else {
      const f = await forecast(deps.fetchImpl, query.lat, query.lon);
      let place: string | null = null;
      try {
        const rev = (await getJson(
          deps.fetchImpl,
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${query.lat}&longitude=${query.lon}&localityLanguage=en`,
        )) as { city?: string; locality?: string };
        place = rev?.city || rev?.locality || null;
      } catch (error) {
        console.error(`[greeting-weather] reverse geocode failed: ${errorLabel(error)}`);
      }
      value = { ...f, place };
    }
    cache.set(key, { at: now(), value });
    return value;
  } catch (error) {
    console.error(`[greeting-weather] weather could not be fetched: ${errorLabel(error)}`);
    return null;
  }
}
