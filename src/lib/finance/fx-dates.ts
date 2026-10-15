/**
 * Dates and times for exchange rates. Bank Negara Malaysia dates its rates by
 * the Malaysian calendar, so the fetch route asks what day and time it is in
 * Malaysia, not on the server. Pure.
 */

/** Malaysia has one time zone and no daylight saving. */
export const MALAYSIA_TIME_ZONE = 'Asia/Kuala_Lumpur';

export type MalaysiaClock = {
  /** The Malaysian date, YYYY-MM-DD. */
  date: string;
  /** Minutes since midnight, Malaysian time. */
  minutes: number;
  /** 0 = Sunday … 6 = Saturday, Malaysian calendar. */
  weekday: number;
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** What day and time it is in Malaysia at `now`. */
export function malaysiaClock(now: Date): MalaysiaClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MALAYSIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
    weekday: WEEKDAYS[part('weekday')] ?? 0,
  };
}

/** Whole days from `from` to `to`, both YYYY-MM-DD; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Whether a Monday-to-Friday lies strictly between two YYYY-MM-DD dates: Friday to Monday has none, Tuesday to
 * Thursday has Wednesday. (A public holiday counts as a working day here; the worst it costs is a needless look.)
 */
export function hasWeekdayBetween(from: string, to: string): boolean {
  for (let d = 1; d < daysBetween(from, to); d += 1) {
    const day = new Date(Date.parse(`${from}T00:00:00Z`) + d * 86_400_000).getUTCDay();
    if (day >= 1 && day <= 5) return true;
  }
  return false;
}

/** The month of a YYYY-MM-DD date, as YYYY-MM. */
export function monthOfDate(date: string): string {
  return date.slice(0, 7);
}

/** A YYYY-MM month moved by `n` months (negative goes back). */
export function addMonths(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + n;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}
