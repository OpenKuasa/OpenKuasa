/**
 * Pure helpers for the Shift Calendar and Timesheet screens: which week a URL
 * asks for, the week navigation, the roster grid's unsaved edits, and the
 * hours inputs. No imports beyond dates and types, so the browser components
 * can use them. The database decides every write; these only shape what is
 * sent and what is drawn.
 */
import { addDays, isRealDate, weekStart } from './dates';
import { SHIFT_COLORS, type ShiftColor, type ShiftType } from './types';

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
/* Shift types                                                       */
/* ---------------------------------------------------------------- */

export type ShiftTypeRow = {
  id: string;
  name: string;
  start_time: string | null;
  end_time: string | null;
  is_off: boolean;
  color: string;
  archived_at: string | null;
};

/** A shift type row as the app holds it: times as `HH:MM`, an unknown colour as slate. */
export function shiftTypeOf(row: ShiftTypeRow): ShiftType {
  const hm = (t: string | null) => (t && /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : null);
  return {
    id: row.id,
    name: row.name,
    start_time: hm(row.start_time),
    end_time: hm(row.end_time),
    is_off: row.is_off,
    color: (SHIFT_COLORS as readonly string[]).includes(row.color) ? (row.color as ShiftColor) : 'slate',
    archived: row.archived_at !== null && row.archived_at !== undefined,
  };
}

/** The classes each palette colour draws with: a light fill and readable text, in both themes. */
export const SHIFT_COLOR_CLASS: Record<ShiftColor, string> = {
  sky: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  cyan: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  teal: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  emerald: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  lime: 'bg-lime-500/15 text-lime-700 dark:text-lime-300',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  orange: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  red: 'bg-red-500/15 text-red-700 dark:text-red-300',
  rose: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  slate: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
  stone: 'bg-stone-500/15 text-stone-700 dark:text-stone-300',
};

export const SHIFT_COLOR_LABEL: Record<ShiftColor, string> = {
  sky: 'Sky', blue: 'Blue', cyan: 'Cyan', teal: 'Teal', emerald: 'Emerald', lime: 'Lime',
  amber: 'Amber', orange: 'Orange', red: 'Red', rose: 'Rose', slate: 'Slate', stone: 'Stone',
};

/** True when a shift ends at or before its start: it runs past midnight. */
export const crossesMidnight = (start: string, end: string) => end <= start;

/** `09:00–18:00`, `21:00–06:00 (overnight)`, or null for a type with no times. */
export function shiftTimes(type: Pick<ShiftType, 'start_time' | 'end_time'>): string | null {
  if (!type.start_time || !type.end_time) return null;
  const span = `${type.start_time}–${type.end_time}`;
  return crossesMidnight(type.start_time, type.end_time) ? `${span} (overnight)` : span;
}

/** A type as a picker lists it: its name and its times. */
export function shiftTypeLabel(type: Pick<ShiftType, 'name' | 'start_time' | 'end_time'>): string {
  const times = shiftTimes(type);
  return times ? `${type.name} · ${times}` : type.name;
}

/** The form's fields for a type, as typed. */
export type ShiftTypeDraft = { name: string; is_off: boolean; start_time: string; end_time: string; color: ShiftColor };

/** What the save sends for a type, or the reason it cannot be sent. Empty times mean none. */
export function toShiftTypeInput(
  draft: ShiftTypeDraft,
):
  | { ok: true; input: { name: string; is_off: boolean; start_time: string | null; end_time: string | null; color: ShiftColor } }
  | { ok: false; error: string } {
  const name = draft.name.trim();
  if (name === '') return { ok: false, error: 'Give the shift type a name.' };
  if (name.length > 40) return { ok: false, error: 'Keep the name to 40 characters.' };
  const start = draft.is_off ? '' : draft.start_time.trim();
  const end = draft.is_off ? '' : draft.end_time.trim();
  if ((start === '') !== (end === '')) return { ok: false, error: 'Give both a start and an end time, or neither.' };
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (start !== '' && (!hm.test(start) || !hm.test(end))) return { ok: false, error: 'Times must be times of day, as HH:MM.' };
  return {
    ok: true,
    input: { name, is_off: draft.is_off, start_time: start || null, end_time: end || null, color: draft.color },
  };
}

/* ---------------------------------------------------------------- */
/* Roster grid                                                       */
/* ---------------------------------------------------------------- */

/** One cell: an employee on a date. */
export const cellKey = (employeeId: string, date: string) => `${employeeId}|${date}`;

/** What a cell holds: a shift type's id, or null for none. */
export type Cell = string | null;

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

export type RosterCellInput = { employee_id: string; work_date: string; shift_type_id: Cell };

/** The changed cells only, as the save sends them, in a fixed order. */
export function changedCells(edits: RosterEdits): RosterCellInput[] {
  return Object.keys(edits)
    .sort()
    .map((key) => {
      const [employee_id, work_date] = key.split('|');
      return { employee_id, work_date, shift_type_id: edits[key] };
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
