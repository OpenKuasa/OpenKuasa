// src/lib/hire/candidate-search.ts
/**
 * Finding candidates by name across the whole workspace. The list read keeps
 * only the newest HIRE_READ_CAP rows, so a lookup by name over it could miss
 * someone added long ago. This one asks the database for the name itself.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ZERO_WIDTH, escapeRegex } from './namesakes';
import { HIRE_READ_CAP } from './types';
import type { Candidate, CandidateSearch, CandidateSearchResult, HireData } from './types';

/** How many matches one lookup returns. More than this and the answer says `more`. */
export const CANDIDATE_SEARCH_LIMIT = 50;

/** The columns of `hire_candidates` that make a {@link Candidate}, for selects. */
export const CANDIDATE_COLUMNS = 'id,name,email,phone,headline,location,skills,source,pool_status,created_at';

/** The text as the lookup uses it: trimmed, without characters that take no room. */
const cleaned = (text: string) => text.replace(ZERO_WIDTH, '').trim();

/**
 * The pattern for the database's case-insensitive match (`imatch`): the text as plain letters, found anywhere in the
 * name. Every sign a pattern reads specially is escaped, so `%`, `_`, `*` or `.` in a name are only themselves.
 */
export const searchPattern = (text: string) => escapeRegex(cleaned(text));

const NOTHING: CandidateSearchResult = { rows: [], more: false };

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
  const { data, error } = await request.order('created_at', { ascending: false }).limit(CANDIDATE_SEARCH_LIMIT + 1);
  if (error) throw error;
  const read = ((data ?? []) as unknown as Candidate[]).map((c) => ({ ...c, skills: c.skills ?? [] }));
  return { rows: read.slice(0, CANDIDATE_SEARCH_LIMIT), more: read.length > CANDIDATE_SEARCH_LIMIT };
}

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
  return { rows: matches.slice(0, CANDIDATE_SEARCH_LIMIT), more: matches.length > CANDIDATE_SEARCH_LIMIT };
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
