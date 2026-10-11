/**
 * Dates for Lekiu, as plain `YYYY-MM-DD` strings. The HR tables store dates,
 * not moments, and "today" for a Malaysian business is today in Malaysia, so
 * every comparison starts from {@link todayInMalaysia} and stays in strings.
 */

import type { Weekday } from './types';

/** Malaysia is UTC+8 all year, with no daylight saving, so no locale data is needed. */
const MALAYSIA_OFFSET = 8 * 3_600_000;
const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

/** True for a date that exists as `YYYY-MM-DD`: 2026-02-31 matches the pattern but is not a day. */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = ms(value);
  return !Number.isNaN(time) && iso(time) === value;
}

/** Today's date in Kuala Lumpur. */
export function todayInMalaysia(now: Date): string {
  return iso(now.getTime() + MALAYSIA_OFFSET);
}

/** The time now in Kuala Lumpur, as `HH:MM`. */
export function timeInMalaysia(now: Date): string {
  return clockTime(now.toISOString());
}

/** The `YYYY-MM-DD` an instant falls on in Malaysia. */
export function malaysiaDate(instant: string): string {
  if (Number.isNaN(Date.parse(instant))) return '';
  return iso(Date.parse(instant) + MALAYSIA_OFFSET);
}

export function addDays(date: string, days: number): string {
  return iso(ms(date) + days * DAY);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((ms(to) - ms(from)) / DAY);
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The first of the month `months` away from the month `date` is in. */
export function addMonths(date: string, months: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  return iso(Date.UTC(year, month + months, 1));
}

/** The Monday of the week `date` is in. */
export function weekStart(date: string): string {
  const day = new Date(ms(date)).getUTCDay(); // 0 is Sunday
  return addDays(date, -((day + 6) % 7));
}

export function isWeekday(date: string): boolean {
  const day = new Date(ms(date)).getUTCDay();
  return day !== 0 && day !== 6;
}

/** `09 Oct`. Built by hand so it reads the same whatever locale data the server has. */
export function formatDay(date: string): string {
  return `${date.slice(8, 10)} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

export function monthLabel(date: string): string {
  return MONTHS[Number(date.slice(5, 7)) - 1];
}

/** `09 Oct 2026`. */
export function formatDate(date: string): string {
  return `${formatDay(date)} ${date.slice(0, 4)}`;
}

/** `October 2026`. */
export function monthYearLabel(date: string): string {
  return `${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const WEEKDAY_KEYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** `fri`: the key `hr_settings.work_week` uses for the date's weekday. */
export function weekdayKey(date: string): Weekday {
  return WEEKDAY_KEYS[new Date(ms(date)).getUTCDay()];
}

/** `Friday`. */
export function weekdayName(date: string): string {
  return WEEKDAY_NAMES[new Date(ms(date)).getUTCDay()];
}

/** `08:59`, on the Malaysian clock. */
export function clockTime(instant: string): string {
  if (Number.isNaN(Date.parse(instant))) return '—';
  return new Date(Date.parse(instant) + MALAYSIA_OFFSET).toISOString().slice(11, 16);
}

/** Hours between two instants, to 1 decimal; 0 when the end is not after the start. */
export function hoursBetween(startIso: string, endIso: string): number {
  const span = Date.parse(endIso) - Date.parse(startIso);
  if (!(span > 0)) return 0; // also false for NaN
  return Math.round(span / 360_000) / 10;
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Hours between two `HH:MM[:SS]` times of one day, to 2 decimals; 0 when the end is not after the start. */
export function hoursBetweenTimes(start: string, end: string): number {
  const span = minutesOf(end) - minutesOf(start);
  if (!(span > 0)) return 0;
  return Math.round((span / 60) * 100) / 100;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** `just now`, `5 minutes ago`, `2 hours ago`, `yesterday`, `3 days ago`, `2 weeks ago`, then the date. */
export function relativeTime(instant: string, now: Date): string {
  if (Number.isNaN(Date.parse(instant))) return '—';
  const seconds = Math.floor((now.getTime() - Date.parse(instant)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return plural(Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return plural(Math.floor(seconds / 3600), 'hour');
  const days = Math.floor(seconds / 86_400);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return plural(Math.floor(days / 7), 'week');
  return formatDate(malaysiaDate(instant));
}
