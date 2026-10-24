'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { hourInMalaysia, todayInMalaysia, weekdayName } from '@/lib/people/dates';
import {
  clearStoredLocation,
  locationChoice,
  readStoredLocation,
  removeStoredLocation,
  subscribeLocationChoice,
  writeStoredLocation,
  type LocationChoice,
} from '@/lib/greeting/location-store';
import { timeOfDayPhrase } from '@/lib/greeting/time-of-day';
import { WEATHER_CONDITIONS, weatherPhrase } from '@/lib/greeting/weather';

const TIMEOUT_MS = 1500;

const serverChoice = (): 'loading' => 'loading';

type WeatherBody = { condition?: unknown; hot?: unknown; place?: unknown };

async function fetchPhrase(
  location: { lat: number; lon: number } | null,
  signal: AbortSignal,
): Promise<string | null> {
  const query = location ? `?lat=${location.lat}&lon=${location.lon}` : '';
  const res = await fetch(`/api/weather${query}`, { signal });
  if (!res.ok) return null;
  const body = (await res.json()) as WeatherBody;
  const condition = WEATHER_CONDITIONS.find((c) => c === body.condition);
  if (!condition) return null;
  const now = new Date();
  return weatherPhrase(
    {
      condition,
      hot: body.hot === true,
      place: typeof body.place === 'string' ? body.place : null,
    },
    {
      window: timeOfDayPhrase(hourInMalaysia(now)).window,
      weekday: weekdayName(todayInMalaysia(now)),
    },
  );
}

/**
 * The greeting's opt-in weather remark. Hydration-safe: the first render is
 * always "no phrase, choice loading" (the server snapshot); the saved choice is
 * read from browser storage only after hydration. It never prompts for
 * location on its own and never holds the greeting up.
 */
export function useGreetingWeather(opts: { enabled: boolean }): {
  phrase: string | null;
  canAskLocation: boolean;
  /** 'loading' until the mount effect has read this browser's saved choice. */
  choice: LocationChoice | 'loading';
  useDeviceLocation: () => void;
  useCityInstead: () => void;
} {
  const { enabled } = opts;
  const [phrase, setPhrase] = useState<string | null>(null);
  const choice = useSyncExternalStore<LocationChoice | 'loading'>(
    subscribeLocationChoice,
    locationChoice,
    serverChoice,
  );
  // Bumped to refetch after the person changes their choice.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    fetchPhrase(readStoredLocation(), controller.signal)
      .then((text) => {
        if (!controller.signal.aborted) setPhrase(text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPhrase(null);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, version]);

  const useDeviceLocation = useCallback(() => {
    try {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          writeStoredLocation(pos.coords.latitude, pos.coords.longitude);
          setVersion((v) => v + 1);
        },
        (err) => {
          // Only a real refusal is remembered; a timeout or no-signal can be retried.
          if (err.code === err.PERMISSION_DENIED) clearStoredLocation();
        },
        { timeout: 8000, maximumAge: 600000 },
      );
    } catch {
      // Geolocation unavailable: keep the workspace city.
    }
  }, []);

  const useCityInstead = useCallback(() => {
    removeStoredLocation();
    setVersion((v) => v + 1);
  }, []);

  return {
    phrase: enabled ? phrase : null,
    canAskLocation: enabled,
    choice,
    useDeviceLocation,
    useCityInstead,
  };
}
