import type { TimeOfDay } from './time-of-day';
import type { WeatherCondition, WeatherResult } from './types';

/** Every condition, in one place (the weather route and client both read this). */
export const WEATHER_CONDITIONS: readonly WeatherCondition[] = [
  'clear',
  'cloudy',
  'rain',
  'storm',
  'haze',
];

/** Map a WMO weather code to a coarse condition. Unknown codes read as cloudy. */
export function conditionFromWmo(code: number): WeatherCondition {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'haze';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code === 95 || code === 96 || code === 99) return 'storm';
  return 'cloudy';
}

export function isHot(tempC: number): boolean {
  return tempC >= 33;
}

const WINDOW_WORD: Record<TimeOfDay['window'], string> = {
  pagi: 'morning',
  'tengah-hari': 'afternoon',
  petang: 'evening',
  malam: 'evening',
};

/** A short weather remark, or null when the weather is not notable. */
export function weatherPhrase(
  w: WeatherResult,
  labels: { window: TimeOfDay['window']; weekday: string },
): string | null {
  const inPlace = w.place ? ` in ${w.place}` : '';
  const word = WINDOW_WORD[labels.window];
  if (w.condition === 'storm') return `Stormy ${labels.weekday} ⛈️`;
  if (w.condition === 'rain') return `Rainy ${labels.weekday}${inPlace} ☔`;
  if (w.condition === 'haze') return `Hazy ${word} 🌫️`;
  if (w.hot) return `Hot ${word}${inPlace} ☀️`;
  return null;
}
