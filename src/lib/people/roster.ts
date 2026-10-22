/**
 * Pure helpers for the Shift Calendar and Timesheet screens: which week a URL
 * asks for, the week navigation, the roster grid's unsaved edits, and the
 * hours inputs. No imports beyond dates and types, so the browser components
 * can use them. The database decides every write; these only shape what is
 * sent and what is drawn.
 */
import { addDays, isRealDate, weekStart } from './dates';
import type { ShiftKind } from './types';

const EARLIEST_WEEK = '2000-01-03'; // the first Monday of 2000
const LATEST_WEEK = '2100-12-27';

/**
 * The Monday of the week a `?week=` value names: any real date snaps to its own week's Monday. Anything else (a
 * missing value, the parameter given twice, a date outside 2000 to 2100) is this week.
 */
export function parseWeek(raw: string | string[] | undefined, today: string): string {
  const fallback = weekStart(today);
  if (typeof raw !== 'string' || !isRealDate(raw)) return fallback;
  const monday = weekStart(raw);
  return monday < EARLIEST_WEEK || monday > LATEST_WEEK ? fallback : monday;
}

export type WeekNav = {
  /** The Monday shown. */
  start: string;
  /** Its Sunday. */
  end: string;
  previous: string;
  next: string;
  /** This week's Monday. */
  current: string;
  isCurrent: boolean;
};

export function weekNav(start: string, today: string): WeekNav {
  const current = weekStart(today);
  return {
    start,
    end: addDays(start, 6),
    previous: addDays(start, -7),
    next: addDays(start, 7),
    current,
    isCurrent: start === current,
  };
}

/** `?week=` link for a screen; this week's link carries no parameter. */
export function weekHref(path: string, monday: string, current: string): string {
  return monday === current ? path : `${path}?week=${monday}`;
}

/* ---------------------------------------------------------------- */
/* Roster grid                                                       */
/* ---------------------------------------------------------------- */

/** One cell: an employee on a date. */
export const cellKey = (employeeId: string, date: string) => `${employeeId}|${date}`;

/** What a cell holds: a shift, or null for none. */
export type Cell = ShiftKind | null;

/** Edits the person has made and not saved: cell key to the value they chose. */
export type RosterEdits = Record<string, Cell>;

/** What the grid shows for a cell: the unsaved edit if there is one, else what was saved. */
export function cellValue(saved: Record<string, Cell>, edits: RosterEdits, key: string): Cell {
  return Object.hasOwn(edits, key) ? edits[key] : (saved[key] ?? null);
}

/**
 * Apply one pick to the edits. Picking the value already saved drops the edit, so a cell changed and changed back
 * no longer counts as unsaved.
 */
export function pickCell(saved: Record<string, Cell>, edits: RosterEdits, key: string, value: Cell): RosterEdits {
  const next = { ...edits };
  if ((saved[key] ?? null) === value) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * "Copy last week": for each employee listed and each day of the week, a cell that is empty now (saved and
 * edited) takes the shift that employee had on the same weekday last week. A cell that already holds a shift is
 * never overwritten. Returns the edits with the copies added, and how many cells were filled.
 */
export function copyLastWeek(input: {
  employeeIds: string[];
  weekStart: string;
  saved: Record<string, Cell>;
  edits: RosterEdits;
  /** Last week's shifts, by cell key. */
  previous: Record<string, Cell>;
}): { edits: RosterEdits; filled: number } {
  let edits = input.edits;
  let filled = 0;
  for (const employeeId of input.employeeIds) {
    for (let i = 0; i < 7; i += 1) {
      const date = addDays(input.weekStart, i);
      const key = cellKey(employeeId, date);
      if (cellValue(input.saved, edits, key) !== null) continue;
      const before = input.previous[cellKey(employeeId, addDays(date, -7))] ?? null;
      if (before === null) continue;
      edits = pickCell(input.saved, edits, key, before);
      filled += 1;
    }
  }
  return { edits, filled };
}

export type RosterCellInput = { employee_id: string; work_date: string; shift: Cell };

/** The changed cells only, as the save sends them, in a fixed order. */
export function changedCells(edits: RosterEdits): RosterCellInput[] {
  return Object.keys(edits)
    .sort()
    .map((key) => {
      const [employee_id, work_date] = key.split('|');
      return { employee_id, work_date, shift: edits[key] };
    });
}

/* ---------------------------------------------------------------- */
/* Hours                                                             */
/* ---------------------------------------------------------------- */

/** The first day staff may record their own hours for: last week's Monday. */
export function hoursWindowStart(today: string): string {
  return addDays(weekStart(today), -7);
}

/**
 * Whether the viewer may type hours on this day: HR for any day up to today; staff for their own record from last
 * week's Monday up to today. Never a day still to come, never in the demo. The database decides again on save.
 */
export function mayEditHours(input: {
  date: string;
  today: string;
  isHr: boolean;
  isDemo: boolean;
  own: boolean;
}): boolean {
  if (input.isDemo || input.date > input.today) return false;
  if (input.isHr) return true;
  return input.own && input.date >= hoursWindowStart(input.today);
}

/**
 * An hours field as typed: empty is null (no entry), otherwise a number from 0 to 24 in steps of half an hour.
 * Returns the reason when it is not one.
 */
export function readHours(raw: string, what: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  if (!/^\d{1,2}(\.\d+)?$/.test(text)) return { ok: false, error: `${what} must be a number of hours.` };
  const value = Number(text);
  if (value > 24) return { ok: false, error: `${what} cannot be more than 24.` };
  if (Math.round(value * 2) !== value * 2) return { ok: false, error: `${what} must be in steps of half an hour.` };
  return { ok: true, value };
}

/** A day's hours and billable hours as the save sends them, or the reason they cannot be sent. */
export function toHoursInput(
  employeeId: string,
  date: string,
  hoursText: string,
  billableText: string,
): { ok: true; input: { employee_id: string; work_date: string; hours: number | null; billable_hours: number | null } } | { ok: false; error: string } {
  const hours = readHours(hoursText, 'Hours');
  if (!hours.ok) return hours;
  const billable = readHours(billableText, 'Billable hours');
  if (!billable.ok) return billable;
  if (hours.value === null) {
    // Clearing the hours clears the day; billable alone means nothing.
    if (billable.value !== null && billable.value > 0) return { ok: false, error: 'Enter the hours before the billable hours.' };
    return { ok: true, input: { employee_id: employeeId, work_date: date, hours: null, billable_hours: null } };
  }
  if (billable.value !== null && billable.value > hours.value) {
    return { ok: false, error: 'Billable hours cannot be more than the hours.' };
  }
  return { ok: true, input: { employee_id: employeeId, work_date: date, hours: hours.value, billable_hours: billable.value } };
}

/** A stored number as an input shows it: `8`, `7.5`, or empty for none. */
export const hoursText = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));
