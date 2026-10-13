// src/lib/hire/pool.ts
/**
 * The talent pool in words: the three statuses and what each means, the
 * sentence for every answer of the two pool functions, the pool table's
 * search, and the wording of the Approve cards. Pure, and no imports but
 * types: client components, the capabilities, the chat cards and the tests
 * all read the same words from here.
 */
import type { PoolStatus } from './types';

/** The statuses of someone IN the pool. `none` (not in it) is never shown as a status. */
export const POOL_STATUSES = ['available', 'passive', 're_engaged'] as const;
export type InPool = (typeof POOL_STATUSES)[number];
export type PoolLabel = 'Available' | 'Passive' | 'Re-engaged';

export const POOL_LABEL: Record<InPool, PoolLabel> = {
  available: 'Available', passive: 'Passive', re_engaged: 'Re-engaged',
};
/** One plain sentence each: the helper text in every status menu, and what Lekir says when asked. */
export const POOL_MEANING: Record<InPool, string> = {
  available: 'Open to hearing about a role now.',
  passive: 'Not looking right now. Worth keeping in touch for later.',
  re_engaged: 'You have been back in touch and put them forward for a job again.',
};

export const isInPool = (value: unknown): value is InPool =>
  typeof value === 'string' && (POOL_STATUSES as readonly string[]).includes(value);
export const isPoolStatus = (value: unknown): value is PoolStatus => value === 'none' || isInPool(value);

export const POOL_SAVE_FAILED = 'That change could not be saved. Please try again.';
export const POOL_NOT_SENT = 'That change could not be sent. Check your connection and try again.';
export const PICKER_FAILED = 'The list could not be loaded. Check your connection and try again.';
export const PICKER_CAPPED = 'Only the newest 1,000 people on file are listed here, so someone added long ago may be missing.';
export const POOL_READ_CAPPED =
  'Only the newest 1,000 people on file are read, so someone added long ago may be missing from this list and from search.';
const FORBIDDEN = 'You do not have permission to make changes here.';

// ─── after a change ──────────────────────────────────────────────────────────

/** The sentence after a status was set, from where the person was (null: not known) and where they are now. */
export function poolChangedMessage(name: string, from: PoolStatus | null, to: PoolStatus): string {
  const who = name.trim();
  if (to === 'none') {
    return who ? `Removed ${who} from the talent pool. They are still on file.` : 'Removed from the talent pool. They are still on file.';
  }
  const label = POOL_LABEL[to];
  if (from === 'none') return who ? `Added ${who} to the talent pool as ${label}.` : `Added to the talent pool as ${label}.`;
  return who ? `${who} is now marked ${label}.` : `Now marked ${label}.`;
}

/** The sentence after a move to the pipeline. */
export function movedMessage(name: string, job: string | null): string {
  const who = name.trim();
  const title = job?.trim() || 'the job';
  return who
    ? `${who} now has an application for ${title} at Applied, and is marked Re-engaged.`
    : `Added an application for ${title} at Applied, and marked them Re-engaged.`;
}

/** What the person is told for each word the two pool functions answer with. Anything else: the generic sentence. */
export function poolRefusal(
  word: unknown,
  about: { name?: string | null; from?: unknown; job?: string | null; outcome?: unknown } = {},
): string {
  const who = about.name?.trim() || 'This person';
  switch (word) {
    case 'not_found': return 'That candidate could not be found.';
    case 'forbidden': return FORBIDDEN;
    case 'invalid_status': return 'Choose Available, Passive or Re-engaged.';
    case 'already_in_pool':
      return isInPool(about.from)
        ? `${who} is already in the talent pool as ${POOL_LABEL[about.from]}. Nothing was changed.`
        : `${who} is already in the talent pool. Nothing was changed.`;
    case 'same_status':
      return isInPool(about.from)
        ? `${who} is already marked ${POOL_LABEL[about.from]}. Nothing was changed.`
        : `${who} is not in the talent pool. Nothing was changed.`;
    case 'job_not_found': return 'That job could not be found.';
    case 'job_not_open': return 'Only an open or paused job can take a new application.';
    case 'not_in_pool': return `${who} is not in the talent pool. Add them to the pool first.`;
    case 'already_applied': {
      const title = about.job?.trim() || 'that job';
      return about.outcome === 'rejected' || about.outcome === 'withdrawn'
        ? `${who} already has a ${about.outcome} application for ${title}. Reopen it from Applications. Nothing was changed.`
        : `${who} has already applied for ${title}. Nothing was changed.`;
    }
    default: return POOL_SAVE_FAILED;
  }
}

// ─── the pool table's search ─────────────────────────────────────────────────

export const POOL_SEARCH_MAX = 80;

/** The search text from the page's address: the first value, trimmed, cut to 80. Null when there is nothing to search for. */
export function poolSearchText(raw: unknown): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') return null;
  const text = first.trim().slice(0, POOL_SEARCH_MAX).trim();
  return text ? text : null;
}

const has = (value: string | null | undefined, query: string) => (value ?? '').toLowerCase().includes(query);

/** One run of characters, in any letter case, anywhere in the name, the headline, the location, the source or one skill. */
export function matchesPoolSearch(
  person: { name: string; headline: string | null; location: string | null; source: string | null; skills: string[] },
  search: string,
): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return has(person.name, query) || has(person.headline, query) || has(person.location, query)
    || has(person.source, query) || person.skills.some((skill) => has(skill, query));
}

const counted = (n: number) => n.toLocaleString('en-US');

export const poolNoMatch = (search: string) => `No one in the talent pool matches “${search}”.`;

/**
 * The line under the pool table. `shown` is how many rows are drawn, `matched`
 * how many pool members fit the search, `size` the whole pool. Null when a
 * search matched nobody: the table is then replaced by `poolNoMatch`.
 */
export function poolFooter(view: { search: string | null; matched: number; shown: number; size: number }): string | null {
  const { search, matched, shown, size } = view;
  if (search === null) {
    return size > shown ? `Showing the newest ${shown} of ${counted(size)}. Search to find anyone else.` : `Showing ${shown} candidates`;
  }
  if (matched === 0) return null;
  if (matched === 1) return `1 person matches “${search}”.`;
  if (matched > shown) {
    return `Showing the newest ${shown} of ${counted(matched)} people who match “${search}”. Type more to narrow it down.`;
  }
  return `${counted(matched)} people match “${search}”.`;
}

// ─── the Approve cards ───────────────────────────────────────────────────────

/** `who` is already worded ("candidate “Aina”", or the words for someone not in a list). Only a real `true` makes it an add. */
export function poolCardTitle(who: string, status: unknown, onlyIfOutside: unknown): string {
  if (status === 'none') return `Remove ${who} from the talent pool?`;
  if (!isInPool(status)) return `Change the talent pool status of ${who}?`;
  return onlyIfOutside === true
    ? `Add ${who} to the talent pool as ${POOL_LABEL[status]}?`
    : `Mark ${who} as ${POOL_LABEL[status]} in the talent pool?`;
}

export function poolCardDetail(status: unknown): string | null {
  if (status === 'none') return 'They stay on file with their details and applications.';
  return isInPool(status) ? `${POOL_LABEL[status]}: ${POOL_MEANING[status]}` : null;
}

export function pipelineCardTitle(who: string, job: string | null): string {
  return `Move ${who} to the pipeline for ${job ? `“${job}”` : 'a job'}?`;
}

export const PIPELINE_CARD_DETAIL = 'Adds an application at Applied and marks them Re-engaged. They stay in the talent pool.';
