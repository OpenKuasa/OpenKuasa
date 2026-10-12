// src/lib/hire/pool-dialog-state.ts
/**
 * Everything the talent pool's menu, dialogs and search box decide, as plain
 * functions: the tests run with no DOM, so a decision made inside a component
 * could not be tested. Pure.
 */
import type { PickerPerson } from './lists';
import { PICKER_FAILED, POOL_LABEL, POOL_SAVE_FAILED, isInPool, poolSearchText, type InPool } from './pool';
import type { PoolStatus } from './types';

// ─── what a change answered ──────────────────────────────────────────────────

/** An action's answer as the screen uses it: the sentence, or the refusal. Anything malformed fails closed. */
export function changeResult(result: unknown): { ok: true; message: string } | { ok: false; error: string } {
  const failed = { ok: false as const, error: POOL_SAVE_FAILED };
  if (!result || typeof result !== 'object') return failed;
  const answer = result as { ok?: unknown; data?: unknown; error?: unknown };
  if (answer.ok === false) return typeof answer.error === 'string' && answer.error ? { ok: false, error: answer.error } : failed;
  const message = answer.ok === true && answer.data && typeof answer.data === 'object'
    ? (answer.data as { message?: unknown }).message
    : null;
  return typeof message === 'string' && message ? { ok: true, message } : failed;
}

// ─── adding ──────────────────────────────────────────────────────────────────

/** An add always carries the switch: someone already in the pool is refused and left as they are. */
export const addInput = (id: string, status: InPool) => ({ id, status, only_if_outside: true as const });
/** From the board and the Applications panel: as Available. The status is chosen later, on the Talent Pool screen. */
export const addToPoolInput = (candidateId: string) => addInput(candidateId, 'available');
export const addedLabel = (status: InPool) => `Added as ${POOL_LABEL[status]}`;
export const addName = (name: string) => `Add ${name} to the talent pool`;
export const addLabel = (busy: boolean) => (busy ? 'Adding…' : 'Add');
/** Where the person stands, for the board card and the Applications panel. Null: not in the pool (or not known), so the add is offered. */
export const boardPoolLine = (poolStatus: PoolStatus | undefined) =>
  isInPool(poolStatus) ? `In the talent pool: ${POOL_LABEL[poolStatus]}` : null;

// ─── the picker ──────────────────────────────────────────────────────────────

export type PickerState =
  | { state: 'loading' }
  | { state: 'ready'; people: PickerPerson[]; capped: boolean }
  | { state: 'failed'; error: string };

export const PICKER_LOADING: PickerState = { state: 'loading' };
export const PICKER_ROWS = 50;

const textOrNull = (value: unknown) => (typeof value === 'string' ? value : null);

/** The answer of the picker's action as a state. Only the six fields of a person are kept. */
export function pickerFrom(result: unknown): PickerState {
  const failed: PickerState = { state: 'failed', error: PICKER_FAILED };
  if (!result || typeof result !== 'object') return failed;
  const answer = result as { ok?: unknown; data?: unknown; error?: unknown };
  if (answer.ok === false && typeof answer.error === 'string' && answer.error) return { state: 'failed', error: answer.error };
  if (answer.ok !== true || !answer.data || typeof answer.data !== 'object') return failed;
  const data = answer.data as { people?: unknown; capped?: unknown };
  if (!Array.isArray(data.people)) return failed;
  const people: PickerPerson[] = [];
  for (const row of data.people as unknown[]) {
    const p = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.name !== 'string') return failed;
    people.push({
      id: p.id,
      name: p.name,
      headline: textOrNull(p.headline),
      location: textOrNull(p.location),
      skills: Array.isArray(p.skills) ? p.skills.filter((skill): skill is string => typeof skill === 'string') : [],
      source: textOrNull(p.source),
    });
  }
  return { state: 'ready', people, capped: data.capped === true };
}

const has = (value: string | null, query: string) => (value ?? '').toLowerCase().includes(query);

/** Any part of the name, the headline or one skill, in any letter case. A blank query keeps everyone. */
export function pickerMatches(people: PickerPerson[], query: string): PickerPerson[] {
  const q = query.trim().toLowerCase();
  if (!q) return people;
  return people.filter((p) => has(p.name, q) || has(p.headline, q) || p.skills.some((skill) => has(skill, q)));
}

/** What the picker's list shows: the rows drawn, the count line under them, or the one sentence that replaces them. */
export function pickerView(people: PickerPerson[], query: string): { rows: PickerPerson[]; line: string | null; empty: string | null } {
  if (people.length === 0) return { rows: [], line: null, empty: 'Everyone on file is already in the talent pool.' };
  const matches = pickerMatches(people, query);
  if (matches.length === 0) return { rows: [], line: null, empty: `No one matches “${query.trim()}”.` };
  return {
    rows: matches.slice(0, PICKER_ROWS),
    line: matches.length > PICKER_ROWS
      ? `Showing ${PICKER_ROWS} of ${matches.length.toLocaleString('en-US')}. Type to narrow the list.`
      : null,
    empty: null,
  };
}

/** Headline and place, on one line. */
export const personLine = (person: Pick<PickerPerson, 'headline' | 'location'>) =>
  [person.headline, person.location].filter(Boolean).join(' · ');

/**
 * Whether the picker is open after something asked for `wanted` (Escape, Done and a click outside all ask for
 * false). While an add is being saved it stays open: closed, it could not show that add's refusal.
 */
export const pickerOpenAfter = (wanted: boolean, adding: boolean): boolean => wanted || adding;

/** After an add: the id of the next row down that is still to be added, or null (focus then goes to the search field). */
export function nextAddFocus(rows: PickerPerson[], added: Record<string, unknown>, justAdded: string): string | null {
  const at = rows.findIndex((row) => row.id === justAdded);
  if (at < 0) return null;
  return rows.slice(at + 1).find((row) => !Object.hasOwn(added, row.id))?.id ?? null;
}

// ─── the row menu ────────────────────────────────────────────────────────────

/** What choosing a status in a row's menu sends: nothing for the one they have, or for a word that is not a status. */
export function statusChangeInput(id: string, current: PoolStatus, chosen: string): { id: string; status: InPool } | null {
  if (!isInPool(chosen) || chosen === current) return null;
  return { id, status: chosen };
}

export const SHORTLISTED_NOTE = 'Shown as Shortlisted while they have a live application at Interview or beyond.';
/** Only a row whose label is the derived "Shortlisted" needs the line that says why. */
export const shortlistedNote = (label: string) => (label === 'Shortlisted' ? SHORTLISTED_NOTE : null);

export const removeInput = (id: string) => ({ id, status: 'none' as const });
export const removeTitle = (name: string) => `Remove ${name} from the talent pool?`;
export const REMOVE_BODY = 'They stay on file with their details and applications. You can add them back with Add to Pool.';
export const removeLabel = (busy: boolean) => (busy ? 'Removing…' : 'Remove from pool');

// ─── move to pipeline ────────────────────────────────────────────────────────

export type PoolJob = { id: string; title: string; status: 'open' | 'paused' };

export const moveTitle = (name: string) => `Move ${name} to pipeline`;
export const moveBody = (name: string) =>
  `${name} gets a new application at Applied and is marked Re-engaged. They stay in the talent pool.`;
export const jobOption = (job: PoolJob) => (job.status === 'paused' ? `${job.title} (paused)` : job.title);
export const CHOOSE_A_JOB = 'Choose a job.';
export const NO_JOBS = 'There are no open or paused jobs. Open a job first.';
export const moveLabel = (busy: boolean) => (busy ? 'Moving…' : 'Move to pipeline');

/** What the dialog sends, or null while no job from its own list is chosen. */
export function moveInput(candidateId: string, jobId: string, jobs: PoolJob[]): { id: string; job_id: string } | null {
  return jobId && jobs.some((job) => job.id === jobId) ? { id: candidateId, job_id: jobId } : null;
}

// ─── the search box ──────────────────────────────────────────────────────────

/** The page's address for a search: `?q=` with the text trimmed and cut to 80, or no `q` at all. */
export function searchHref(pathname: string, text: string): string {
  const query = poolSearchText(text);
  return query === null ? pathname : `${pathname}?q=${encodeURIComponent(query)}`;
}

/**
 * The search box: the text in it, and the searches it has itself put in the
 * address that the address may still be on its way to (the oldest is the one
 * the address was last seen at). Each is as the address shows it: trimmed, cut
 * to 80, null for no search.
 */
export type SearchBox = { text: string; sent: (string | null)[] };

/** The box as the page is first drawn: it shows what the address searches for. */
export const searchBox = (search: string | null): SearchBox => ({ text: search ?? '', sent: [search] });

/** The box after it put `text` in the address itself (typing, Enter, Clear search). What is shown is not touched. */
export const boxSent = (box: SearchBox, text: string): SearchBox => ({ text: box.text, sent: [...box.sent, poolSearchText(text)] });

/** True when the address shows a search the box did not ask for: a nav link, Back or Forward. */
export const fromOutside = (sent: (string | null)[], incoming: string | null): boolean => !sent.includes(incoming);

/**
 * The box once the address reads `incoming`. A search the box itself asked for
 * (now, or one it has since typed past) leaves the text exactly as typed, so
 * typing never loses a character or the caret. Anything else came from outside
 * the box, and the text follows it: otherwise an old word would sit above a
 * list it did not filter.
 */
export function followAddress(box: SearchBox, incoming: string | null): SearchBox {
  const at = box.sent.lastIndexOf(incoming);
  if (at < 0) return searchBox(incoming);
  // Searches older than the one the address now shows have been passed.
  return at === 0 ? box : { text: box.text, sent: box.sent.slice(at) };
}
