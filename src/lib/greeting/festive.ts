/**
 * Built-in Malaysian festive calendar for the personal greeting.
 *
 * Dates are taken from the official gazette (Malaysian public-holiday
 * declarations). Lunar and Islamic dates (CNY, Hari Raya, Aidiladha, Wesak,
 * Deepavali) follow official moon-sighting confirmation and may shift by a
 * day, so treat them as subject to official confirmation.
 *
 * Only the actual wish days are listed; replacement holidays are not.
 *
 * TODO: add 2028 before 2027-12, or the calendar goes silent in 2028.
 */

import { addDays } from '@/lib/people/dates';

export type Festival = { key: string; wish: string; emoji: string; major: boolean };

const CNY: Festival = { key: 'cny', wish: 'Gong Xi Fa Cai', emoji: '🧧', major: true };
const RAYA: Festival = { key: 'raya', wish: 'Selamat Hari Raya', emoji: '🌙', major: true };
const RAYA_HAJI: Festival = { key: 'raya-haji', wish: 'Selamat Hari Raya Aidiladha', emoji: '🌙', major: false };
const WESAK: Festival = { key: 'wesak', wish: 'Happy Wesak Day', emoji: '🪷', major: false };
const DEEPAVALI: Festival = { key: 'deepavali', wish: 'Happy Deepavali', emoji: '🪔', major: true };
const CHRISTMAS: Festival = { key: 'christmas', wish: 'Merry Christmas', emoji: '🎄', major: true };
const MERDEKA: Festival = { key: 'merdeka', wish: 'Selamat Hari Merdeka', emoji: '🇲🇾', major: false };
const MALAYSIA_DAY: Festival = { key: 'malaysia-day', wish: 'Selamat Hari Malaysia', emoji: '🇲🇾', major: false };

const FESTIVALS: Record<string, Festival> = {
  '2026-02-17': CNY,
  '2026-02-18': CNY,
  '2027-02-06': CNY,
  '2027-02-07': CNY,
  '2026-03-21': RAYA,
  '2026-03-22': RAYA,
  '2027-03-10': RAYA,
  '2027-03-11': RAYA,
  '2026-05-27': RAYA_HAJI,
  '2027-05-17': RAYA_HAJI,
  '2026-05-31': WESAK,
  '2027-05-20': WESAK,
  '2026-11-08': DEEPAVALI,
  '2027-10-28': DEEPAVALI,
  '2026-12-25': CHRISTMAS,
  '2027-12-25': CHRISTMAS,
  '2026-08-31': MERDEKA,
  '2027-08-31': MERDEKA,
  '2026-09-16': MALAYSIA_DAY,
  '2027-09-16': MALAYSIA_DAY,
};

/** Dates of the major festivals, sorted ascending (string order is date order). */
const MAJOR = Object.keys(FESTIVALS)
  .filter((date) => FESTIVALS[date].major)
  .sort();

/**
 * The festival to wish on `date` (`YYYY-MM-DD`, KL date). The built-in list
 * wins; otherwise a workspace holiday on that day becomes
 * `Selamat <name>` (a workspace-defined holiday, never a major one).
 */
export function festiveOn(
  date: string,
  workspaceHolidays: { date: string; name: string }[] = [],
): Festival | null {
  const builtIn = FESTIVALS[date];
  if (builtIn) return builtIn;
  const holiday = workspaceHolidays.find((entry) => entry.date === date);
  if (holiday) return { key: 'workspace', wish: `Selamat ${holiday.name}`, emoji: '🎉', major: false };
  return null;
}

/** The nearest major festival within `days` days after `date` (today excluded), else null. */
export function festivalWithin(date: string, days: number): Festival | null {
  const end = addDays(date, days);
  const next = MAJOR.find((day) => day > date && day <= end);
  return next ? FESTIVALS[next] : null;
}
