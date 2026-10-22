// src/lib/hire/candidate-search.ts
/**
 * Finding candidates by name across the whole workspace. The list read keeps
 * only the newest HIRE_READ_CAP rows, so a lookup by name over it could miss
 * someone added long ago. This one asks the database for the name itself.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ZERO_WIDTH, escapeRegex } from './namesakes';
import { HIRE_READ_CAP } from './types';
import type { PickerPerson } from './lists';
import type { Candidate, CandidateSearch, CandidateSearchResult, HireData } from './types';

/** How many matches one lookup returns. More than this and the answer says `more`. */
export const CANDIDATE_SEARCH_LIMIT = 50;

/** The columns of `hire_candidates` that make a {@link Candidate}, for selects. */
export const CANDIDATE_COLUMNS = 'id,name,email,phone,headline,location,skills,source,pool_status,created_at';

const NUL = /\u0000/g;

/**
 * The name as a lookup uses it: trimmed, without characters that take no room and without NUL bytes. A caller that
 * also filters rows by the name in memory uses this same text, so the database and the filter agree.
 */
export const cleanSearchName = (text: string) => text.replace(ZERO_WIDTH, '').replace(NUL, '').trim();
const cleaned = cleanSearchName;

/**
 * The pattern for the database's case-insensitive match (`imatch`): the text as plain letters, found anywhere in the
 * name. Every sign a pattern reads specially is escaped, so `%`, `_`, `*` or `.` in a name are only themselves.
 */
export const searchPattern = (text: string) => escapeRegex(cleaned(text));

/** How many people the "Add to pool" picker shows for one search. */
export const POOL_PICKER_LIMIT = 50;

/** The columns the picker reads: who someone is and when they were put on file, never how to reach them. */
const PICKER_COLUMNS = 'id,name,headline,location,skills,source,created_at';

type PickerRow = Omit<PickerPerson, 'skills'> & { skills: string[] | null; created_at: string };

/** Newest on file first; the id breaks a tie, as the database orders it, so the order never depends on which read a row came from. */
const newestOnFile = (a: PickerRow, b: PickerRow) =>
  (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The people the "Add to pool" picker offers for a search: not in the pool, newest on file first, at most
 * POOL_PICKER_LIMIT, whose name or headline holds the text (any letter case). A blank text: the newest ones. `more`
 * when there were more than that. The name and the headline are read apart, never with one `or` holding the typed
 * text, and merged. The member's own client; a failed query throws.
 */
export async function readPoolPicker(
  client: SupabaseClient,
  orgId: string,
  text: string,
): Promise<{ people: PickerPerson[]; more: boolean }> {
  const asked = POOL_PICKER_LIMIT + 1;
  async function read(on: 'name' | 'headline' | null): Promise<PickerRow[]> {
    let request = client.from('hire_candidates').select(PICKER_COLUMNS).eq('org_id', orgId).eq('pool_status', 'none');
    if (on) request = request.filter(on, 'imatch', searchPattern(text));
    const { data, error } = await request.order('created_at', { ascending: false }).order('id', { ascending: true }).limit(asked);
    if (error) throw error;
    return (data ?? []) as unknown as PickerRow[];
  }
  const reads = await Promise.all(cleaned(text) ? [read('name'), read('headline')] : [read(null)]);
  const merged = new Map<string, PickerRow>();
  for (const row of reads.flat()) if (!merged.has(row.id)) merged.set(row.id, row);
  const rows = [...merged.values()].sort(newestOnFile);
  return {
    // Each field is named: nothing else that rode along (not even when they were put on file) can reach the browser.
    people: rows.slice(0, POOL_PICKER_LIMIT).map((p) => ({
      id: p.id, name: p.name, headline: p.headline, location: p.location, skills: p.skills ?? [], source: p.source,
    })),
    // A read that came back full had more behind it.
    more: rows.length > POOL_PICKER_LIMIT || reads.some((r) => r.length >= asked),
  };
}

const NOTHING: CandidateSearchResult = { rows: [], more: false };

/** Rows as read, with `skills` never null. */
const asCandidates = (data: unknown) => ((data ?? []) as Candidate[]).map((c) => ({ ...c, skills: c.skills ?? [] }));

/**
 * Everyone in the talent pool, newest on file first, up to HIRE_READ_CAP: the pool itself, so people put on file
 * long ago are not lost behind the newest page of everyone. The member's own client; a failed query throws.
 */
export async function readPool(client: SupabaseClient, orgId: string): Promise<Candidate[]> {
  const { data, error } = await client
    .from('hire_candidates')
    .select(CANDIDATE_COLUMNS)
    .eq('org_id', orgId)
    .neq('pool_status', 'none')
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(HIRE_READ_CAP);
  if (error) throw error;
  return asCandidates(data);
}

/**
 * The read against the database, with the member's own client (row-level security and the workspace filter apply,
 * as for every other hiring read). A failed query throws.
 */
export async function readCandidateSearch(
  client: SupabaseClient,
  orgId: string,
  query: CandidateSearch,
): Promise<CandidateSearchResult> {
  if (!cleaned(query.name)) return NOTHING;
  let request = client
    .from('hire_candidates')
    .select(CANDIDATE_COLUMNS)
    .eq('org_id', orgId)
    .filter('name', 'imatch', searchPattern(query.name));
  if (query.poolStatus) request = request.eq('pool_status', query.poolStatus);
  else if (query.inPool) request = request.neq('pool_status', 'none');
  const bound = boundOf(query);
  // One more than kept, to tell "exactly this many" from "more". The API never answers with more than
  // HIRE_READ_CAP rows, so a read that asks for the cap counts as "more" when it comes back full.
  const { data, error } = await request.order('created_at', { ascending: false }).order('id', { ascending: true }).limit(Math.min(bound + 1, HIRE_READ_CAP));
  if (error) throw error;
  return cut(asCandidates(data), bound);
}

/** How many rows a lookup keeps: CANDIDATE_SEARCH_LIMIT unless asked for more, never above HIRE_READ_CAP. */
const boundOf = (query: CandidateSearch) => Math.min(query.limit ?? CANDIDATE_SEARCH_LIMIT, HIRE_READ_CAP);

const cut = (rows: Candidate[], bound: number): CandidateSearchResult => ({
  rows: rows.slice(0, bound),
  more: rows.length > bound || rows.length >= HIRE_READ_CAP,
});

/**
 * The same answer from rows already in memory, for a provider that holds all of its rows (the sample data, a test).
 * `list` is taken as newest first, as the providers hand it back.
 */
export function searchCandidatesFromList(list: readonly Candidate[], query: CandidateSearch): CandidateSearchResult {
  const text = cleaned(query.name).toLowerCase();
  if (!text) return NOTHING;
  const matches = list.filter(
    (c) =>
      c.name.toLowerCase().includes(text) &&
      (query.poolStatus ? c.pool_status === query.poolStatus : !query.inPool || c.pool_status !== 'none'),
  );
  return cut(matches, boundOf(query));
}

/**
 * A lookup by name through whichever provider is in use. `capped` is true only when the provider has no search of
 * its own and its list came back full: an older match may then be missing.
 */
export async function findCandidates(
  data: Pick<HireData, 'listCandidates' | 'searchCandidates'>,
  query: CandidateSearch,
): Promise<CandidateSearchResult & { capped: boolean }> {
  if (data.searchCandidates) return { ...(await data.searchCandidates(query)), capped: false };
  const list = await data.listCandidates();
  return { ...searchCandidatesFromList(list, query), capped: list.length >= HIRE_READ_CAP };
}
