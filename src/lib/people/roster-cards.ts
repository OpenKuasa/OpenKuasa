/**
 * The words on an approval card for a roster, hours, shift type or shift swap change, and the names those rows go
 * by in a lookup's result. Pure and import-light: the server words a change a specialist prepared, and the chat words
 * one it finds in a message. Every name comes from a lookup in the conversation, never from the model's own words.
 */
import type { NameFinder } from '@/lib/chat/change-titles';
import { isRealDate, monthLabel, weekStart, weekdayName } from './dates';
import { hhmm } from './loose-input';

/** The roster, hours, shift type and swap change tools. */
export const ROSTER_CHANGE_TOOLS = [
  'setShifts',
  'logHours',
  'saveShiftType',
  'archiveShiftType',
  'requestShiftSwap',
  'replyShiftSwap',
  'decideShiftSwap',
  'cancelShiftSwap',
] as const;

const ROSTER_SET: ReadonlySet<string> = new Set(ROSTER_CHANGE_TOOLS);
export const isRosterTool = (toolName: string): boolean => ROSTER_SET.has(toolName);

const UNLISTED_TYPE = 'a shift type that was not in the list above';
const UNLISTED_SHIFT = 'a shift that was not in the list above';
const UNLISTED_SWAP = 'a shift swap that was not in the list above';

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** "Mon, 26 Oct 2026"; null unless a real date. */
export function rosterDay(value: unknown): string | null {
  if (typeof value !== 'string' || !isRealDate(value)) return null;
  return `${weekdayName(value).slice(0, 3)}, ${Number(value.slice(8, 10))} ${monthLabel(value)} ${value.slice(0, 4)}`;
}

/** "26 Oct": the Monday a week is named by. */
function weekWords(date: string): string {
  const monday = weekStart(date);
  return `${Number(monday.slice(8, 10))} ${monthLabel(monday)}`;
}

/** "8 hours", "1 hour", "0 hours"; null unless a number from 0 to 24. */
export function hoursWords(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 24) return null;
  return `${value} ${value === 1 ? 'hour' : 'hours'}`;
}

/** `09:00–18:00`, with "(overnight)" when it ends at or before its start; null without both times. */
function timesOf(start: unknown, end: unknown): string | null {
  const s = hhmm(start);
  const e = hhmm(end);
  if (!s || !e) return null;
  return e <= s ? `${s}–${e} (overnight)` : `${s}–${e}`;
}

/** A shift type as a card names it: "Morning · 09:00–18:00", or just the name for one with no times. */
function typeWords(name: unknown, times: string | null): string | null {
  const n = text(name);
  if (!n) return null;
  return times ? `${n} · ${times}` : n;
}

/** What a swap is called, kept as facts so a title can name the two people. */
type SwapFacts = { label: string; requester: string; colleague: string };

/**
 * The name of a roster row in a lookup's result, by the kind of thing it is: a shift type ("Morning · 09:00–18:00"),
 * a shift a swap may offer or ask for ("Faiz · 28 Oct · Night · 21:00–06:00"), or a swap (its facts as JSON, with a
 * `label` for a card row). Null for a row that is not one.
 */
export function rosterLabel(row: Record<string, unknown>, kind: 'shift-type' | 'shift' | 'swap'): string | null {
  if (kind === 'shift-type') {
    return typeWords(row.name, text(row.times) ?? timesOf(row.start_time, row.end_time));
  }
  if (kind === 'shift') return text(row.shift);
  const requester = text(row.requester);
  const colleague = text(row.colleague);
  const gives = text(row.gives);
  const takes = text(row.takes);
  if (!requester || !colleague || !gives || !takes) return null;
  const facts: SwapFacts = { label: `${requester}'s ${gives} for ${colleague}'s ${takes}`, requester, colleague };
  return JSON.stringify(facts);
}

function swapFacts(find: NameFinder, id: unknown): SwapFacts | null {
  const raw = find(id, 'swap');
  if (!raw) return null;
  try {
    const facts = JSON.parse(raw) as Partial<SwapFacts>;
    return typeof facts.label === 'string' && typeof facts.requester === 'string' && typeof facts.colleague === 'string'
      ? (facts as SwapFacts)
      : null;
  } catch {
    return null;
  }
}

const between = (facts: SwapFacts | null) => (facts ? `the shift swap between ${facts.requester} and ${facts.colleague}` : UNLISTED_SWAP);

/** "Aina", "Aina and Faiz", "Aina, Faiz and Siti", "Aina, Faiz and 3 others". */
function peopleWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
}

/** The question on the card, or null for a tool that is not a roster change. */
export function rosterCardTitle(toolName: string, i: Record<string, unknown>, find: NameFinder): string | null {
  switch (toolName) {
    case 'setShifts': {
      const cells = Array.isArray(i.cells) ? (i.cells as Record<string, unknown>[]).filter((c) => c && typeof c === 'object') : [];
      const ids = [...new Set(cells.map((c) => c.employee_id).filter((v): v is string => typeof v === 'string'))];
      const names = ids.map((id) => find(id, 'employee') ?? 'an employee not in the list above');
      const first = cells.map((c) => c.work_date).find((d): d is string => typeof d === 'string' && isRealDate(d));
      const week = first ? ` for the week of ${weekWords(first)}` : '';
      const clearing = cells.length > 0 && cells.every((c) => c.shift_type_id === null || c.shift_type_id === undefined);
      if (ids.length === 1) return `${clearing ? 'Clear' : 'Set'} ${names[0]}'s shifts${week}?`;
      if (ids.length === 0) return `Change the roster${week}?`;
      return `${clearing ? 'Clear' : 'Set'} shifts for ${peopleWords(names)}${week}?`;
    }
    case 'logHours': {
      // No employee is the caller's own; one no lookup named never reads like theirs.
      const own = i.employee_id === undefined || i.employee_id === null || i.employee_id === '';
      const who = own ? 'yourself' : (find(i.employee_id, 'employee') ?? 'this employee');
      const whose = own ? 'your' : who === 'this employee' ? "this employee's" : `${who}'s`;
      const day = rosterDay(i.work_date);
      const on = day ? ` on ${day}` : '';
      if (i.hours === null || i.hours === undefined) return `Clear ${whose} hours${on}?`;
      const hours = hoursWords(i.hours);
      return `Log ${hours ?? 'hours'} for ${who}${on}?`;
    }
    case 'saveShiftType': {
      const now = typeWords(i.name, i.is_off === true ? null : timesOf(i.start_time, i.end_time)) ?? 'a shift type';
      const id = text(i.id);
      if (!id) return i.is_off === true ? `Add the off type “${now}”?` : `Add shift type ${now}?`;
      return `Change shift type ${find(id, 'shift-type') ?? UNLISTED_TYPE} to ${now}?`;
    }
    case 'archiveShiftType': {
      const type = find(i.id, 'shift-type');
      return i.archived === false
        ? `Bring back shift type ${type ?? UNLISTED_TYPE}?`
        : `Archive shift type ${type ?? UNLISTED_TYPE}?`;
    }
    case 'requestShiftSwap': {
      const mine = find(i.my_shift_id, 'shift') ?? UNLISTED_SHIFT;
      const theirs = find(i.their_shift_id, 'shift') ?? UNLISTED_SHIFT;
      return `Ask to swap your ${mine} for ${theirs}?`;
    }
    case 'replyShiftSwap':
      return `${i.accept === true ? 'Accept' : 'Decline'} ${between(swapFacts(find, i.id))}?`;
    case 'decideShiftSwap':
      return `${i.approve === true ? 'Approve' : 'Reject'} ${between(swapFacts(find, i.id))}?`;
    case 'cancelShiftSwap':
      return `Cancel ${between(swapFacts(find, i.id))}?`;
    default:
      return null;
  }
}

/** The line under the question, or null when there is none (or the tool is not a roster change). */
export function rosterCardDetail(toolName: string, i: Record<string, unknown>, find?: NameFinder): string | null {
  const note = text(i.note);
  const swap = find ? swapFacts(find, i.id) : null;
  switch (toolName) {
    case 'setShifts':
      return 'Only the days listed change; the rest of the week stays as it is. Anyone whose shifts change from today on is told.';
    case 'logHours': {
      if (i.hours === null || i.hours === undefined) return 'The entry for that day is removed.';
      const billable = hoursWords(i.billable_hours);
      return billable ? `Billable: ${billable}` : null;
    }
    case 'saveShiftType':
      return text(i.id) ? 'Shifts already on the roster with this type show the new name and times.' : null;
    case 'archiveShiftType':
      return i.archived === false
        ? 'It can be picked on the roster again.'
        : 'Shifts already on the roster keep this type, but it can no longer be picked.';
    case 'requestShiftSwap':
      return [`The colleague is asked first, then an owner, an admin or their manager decides.`, note && `Note: “${note}”`]
        .filter(Boolean)
        .join(' · ');
    case 'replyShiftSwap':
      return swap ? `${swap.label}${i.accept === true ? '. An owner, an admin or a manager of you both then decides.' : ''}` : null;
    case 'decideShiftSwap': {
      const parts = [swap?.label, i.approve === true ? 'The two shifts are exchanged on approval.' : null, i.approve === false && note ? `Note: “${note}”` : null];
      const line = parts.filter(Boolean).join(' · ');
      return line || null;
    }
    case 'cancelShiftSwap':
      return swap?.label ?? null;
    default:
      return null;
  }
}
