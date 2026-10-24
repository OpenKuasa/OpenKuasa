'use client';

import { useCallback, useEffect, useState } from 'react';
import { hourInMalaysia, todayInMalaysia, weekdayName } from '@/lib/people/dates';
import {
  clearStoredLocation,
  locationChoice,
  readStoredLocation,
  writeStoredLocation,
  type LocationChoice,
} from '@/lib/greeting/location-store';
import { timeOfDayPhrase } from '@/lib/greeting/time-of-day';
import type { WeatherCondition } from '@/lib/greeting/types';
import { weatherPhrase } from '@/lib/greeting/weather';

const TIMEOUT_MS = 1500;
const CONDITIONS: readonly string[] = ['clear', 'cloudy', 'rain', 'storm', 'haze'];

type WeatherBody = { condition?: unknown; hot?: unknown; place?: unknown };

async function fetchPhrase(
  location: { lat: number; lon: number } | null,
  signal: AbortSignal,
): Promise<string | null> {
  const query = location ? `?lat=${location.lat}&lon=${location.lon}` : '';
  const res = await fetch(`/api/weather${query}`, { signal });
  if (!res.ok) return null;
  const body = (await res.json()) as WeatherBody;
  if (typeof body.condition !== 'string' || !CONDITIONS.includes(body.condition)) return null;
  const now = new Date();
  return weatherPhrase(
    {
      condition: body.condition as WeatherCondition,
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
 * always "no phrase, choice unset"; browser storage is read in an effect. It
 * never prompts for location on its own and never holds the greeting up.
 */
export function useGreetingWeather(opts: { enabled: boolean }): {
  phrase: string | null;
  canAskLocation: boolean;
  choice: LocationChoice;
  useDeviceLocation: () => void;
  useCityInstead: () => void;
} {
  const { enabled } = opts;
  const [phrase, setPhrase] = useState<string | null>(null);
  const [choice, setChoice] = useState<LocationChoice>('unset');
  // Bumped to refetch after the person changes their choice.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    setChoice(locationChoice());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    fetchPhrase(readStoredLocation(), controller.signal)
      .then((text) => setPhrase(text))
      .catch(() => setPhrase(null))
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
        () => {
          clearStoredLocation();
          setChoice('city');
        },
        { timeout: 8000, maximumAge: 600000 },
      );
    } catch {
      // Geolocation unavailable: keep the workspace city.
    }
  }, []);

  const useCityInstead = useCallback(() => {
    clearStoredLocation();
    setChoice('city');
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
