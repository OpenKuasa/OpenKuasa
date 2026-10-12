// src/lib/hire/interview-time.ts
/**
 * Interview times. Kuala Lumpur is UTC+8 all year and has had no daylight
 * saving since 1982, so its wall-clock time and an instant convert with a
 * fixed offset. Nothing here reads the process's own time zone: a date and a
 * time are joined as text, and an instant is read by adding eight hours and
 * taking the UTC parts. Pure, and with no imports: the form, the capabilities,
 * the invitation, the calendar file and the Approve cards all use it.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const KL_OFFSET_MS = 8 * 60 * MINUTE_MS;

export const ZONE_LABEL = 'Kuala Lumpur time (GMT+8)';

/** A new interview may start up to this long ago: a slow form, or a clock that is slightly off. */
export const PAST_TOLERANCE_MS = 300_000;
/** A new interview may be at most this many days ahead. The database applies the same limit. */
export const MAX_AHEAD_DAYS = 366;
/** A past interview may be recorded at most this many days back. The database applies the same limit. */
export const MAX_BACK_DAYS = 366;

// Fixed lists: a locale's own names vary ("Sep" or "Sept"), and none of this may depend on the machine.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;
// An instant says its own zone: `Z`, or an offset. Seconds and decimals are optional (the database writes six).
// The groups: the date, the hour and minute, the seconds, and the offset's hours and minutes.
const INSTANT_SHAPE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * An instant as milliseconds, or NaN for text that is not one. Text with no
 * zone of its own (`2026-10-20T15:00`, `2026-10-20`, `Oct 20 2026`) is not an
 * instant: `Date.parse` would read it in the machine's zone, and the answer
 * would then differ between a laptop in Kuala Lumpur and a server in UTC.
 * Nor is text whose day or time of day does not exist: `Date.parse` reads
 * 30 February as 2 March and 24:00 as the next day, and a shifted time is
 * worse than none. Every other function here reads an instant through this.
 */
export function instantMs(iso: string): number {
  const parts = typeof iso === 'string' ? INSTANT_SHAPE.exec(iso) : null;
  if (!parts) return Number.NaN;
  const [, date, clock, seconds, offsetHours, offsetMinutes] = parts;
  if (!isRealDate(date) || !TIME_SHAPE.test(clock)) return Number.NaN;
  if (Number(seconds ?? 0) > 59 || Number(offsetHours ?? 0) > 23 || Number(offsetMinutes ?? 0) > 59) return Number.NaN;
  return Date.parse(iso);
}

/** Whether a YYYY-MM-DD string names a day that exists: 31 February and month 13 do not. */
export function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  // Some dates that do not exist roll over to a later day, others do not parse at all.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * A Kuala Lumpur date (`2026-10-20`) and time (`15:00`, 24-hour) as one
 * instant: `2026-10-20T15:00:00+08:00`. Null when the date is not a real day
 * or the time is not HH:MM from 00:00 to 23:59. The two are joined as text, so
 * the answer is the same on a server in any zone.
 */
export function klInstant(date: string, time: string): string | null {
  if (typeof date !== 'string' || typeof time !== 'string') return null;
  if (!DATE_SHAPE.test(date) || !isRealDate(date) || !TIME_SHAPE.test(time)) return null;
  return `${date}T${time}:00+08:00`;
}

type KlParts = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };

/** The Kuala Lumpur wall clock at `ms`: eight hours are added, then the UTC parts are read. */
function partsAt(ms: number): KlParts | null {
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + KL_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) return null;
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}
const partsOf = (iso: string) => partsAt(instantMs(iso));
const two = (n: number) => String(n).padStart(2, '0');
const dateText = (p: KlParts) => `${String(p.year).padStart(4, '0')}-${two(p.month + 1)}-${two(p.day)}`;
const clockText = (p: KlParts) => `${p.hour % 12 === 0 ? 12 : p.hour % 12}:${two(p.minute)} ${p.hour < 12 ? 'am' : 'pm'}`;

/** The Kuala Lumpur date of an instant, as YYYY-MM-DD. Empty when the text is not an instant. */
export function klDateOf(iso: string): string {
  const p = partsOf(iso);
  return p ? dateText(p) : '';
}

/** The Kuala Lumpur time of an instant, as HH:MM (24-hour). Empty when the text is not an instant. */
export function klTimeOf(iso: string): string {
  const p = partsOf(iso);
  return p ? `${two(p.hour)}:${two(p.minute)}` : '';
}

/**
 * Why a new interview cannot be at this instant: more than five minutes ago,
 * or more than 366 days ahead. Null when it can. Text that is not an instant
 * is refused, never let through.
 */
export function timeProblem(iso: string, now: Date): 'in_past' | 'too_far_ahead' | null {
  const at = instantMs(iso);
  if (Number.isNaN(at) || at < now.getTime() - PAST_TOLERANCE_MS) return 'in_past';
  if (at > now.getTime() + MAX_AHEAD_DAYS * DAY_MS) return 'too_far_ahead';
  return null;
}

/**
 * Why an interview cannot be recorded as already held at this instant: it is
 * later than now, or more than 366 days ago. Null when it can. Text that is
 * not an instant is refused.
 */
export function pastProblem(iso: string, now: Date): 'not_past' | 'too_far_back' | null {
  const at = instantMs(iso);
  if (Number.isNaN(at) || at > now.getTime()) return 'not_past';
  if (at < now.getTime() - MAX_BACK_DAYS * DAY_MS) return 'too_far_back';
  return null;
}

/** "Tuesday, 20 October 2026", in Kuala Lumpur. Text that is not an instant is given back as it is. */
export function longDate(iso: string): string {
  const p = partsOf(iso);
  return p ? `${WEEKDAYS[p.weekday]}, ${p.day} ${MONTHS[p.month]} ${p.year}` : iso;
}

/** "Tue 20 Oct 2026, 3:00 pm", in Kuala Lumpur. */
export function shortWhen(iso: string): string {
  const p = partsOf(iso);
  return p ? `${WEEKDAYS_SHORT[p.weekday]} ${p.day} ${MONTHS_SHORT[p.month]} ${p.year}, ${clockText(p)}` : iso;
}

/** "3:00 pm", in Kuala Lumpur: how a time is written to a candidate. */
export function clock12(iso: string): string {
  const p = partsOf(iso);
  return p ? clockText(p) : iso;
}

/** "3:00 pm to 4:00 pm", or "11:30 pm to 12:30 am the next day" when the end falls on a later date. */
export function timeRange(iso: string, minutes: number): string {
  const startMs = instantMs(iso);
  const start = partsAt(startMs);
  const end = partsAt(startMs + minutes * MINUTE_MS);
  if (!start || !end) return iso;
  const nextDay = dateText(end) !== dateText(start);
  return `${clockText(start)} to ${clockText(end)}${nextDay ? ' the next day' : ''}`;
}

/** "45 minutes", "1 hour", "1 hour 30 minutes", "2 hours". */
export function durationText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (rest > 0 || hours === 0) parts.push(`${rest} ${rest === 1 ? 'minute' : 'minutes'}`);
  return parts.join(' ');
}

/**
 * "Monday, 2026-10-12, and the time there is 10:15": the end of the sentence
 * "Today in Malaysia is …" that the scheduling tools carry, so a model can
 * count "Tuesday at 3" and "in an hour" from the right day and time.
 */
export function klTodayWords(now: Date): string {
  const p = partsAt(now.getTime());
  return p ? `${WEEKDAYS[p.weekday]}, ${dateText(p)}, and the time there is ${two(p.hour)}:${two(p.minute)}` : '';
}
