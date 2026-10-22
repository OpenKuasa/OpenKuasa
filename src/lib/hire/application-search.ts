// src/lib/hire/application-search.ts
/**
 * Finding applications by the candidate's name (and, when asked, by the job's
 * title) across the whole workspace. The list read keeps only the newest
 * HIRE_READ_CAP applications, so a lookup over it could miss an older one. This
 * one asks the database for the name itself.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanSearchName, searchPattern } from './candidate-search';
import { HIRE_READ_CAP } from './types';
import type { Application, ApplicationSearch, ApplicationSearchResult, Candidate, HireData, PoolStatus } from './types';

/** How many applications one lookup returns. More than this and the answer says `more`. */
export const APPLICATION_SEARCH_LIMIT = 50;

const BASE_COLUMNS =
  'id,candidate_id,job_id,stage,outcome,reject_reason,rating,source,applied_at,offered_at,hired_at,created_at,' +
  'cover_letter,cv_url,cv_path,portfolio_url,expected_salary_cents,consented_at';

/**
 * The columns of `hire_applications` that make an {@link Application}, with the candidate's name and pool status and
 * the job's title joined in. `inner`: the join a filter is put on, so that only rows whose joined row matches come back.
 */
export const applicationColumns = (inner?: 'candidate' | 'job') =>
  `${BASE_COLUMNS},candidate:hire_candidates${inner === 'candidate' ? '!inner' : ''}(name,pool_status),` +
  `job:hire_jobs${inner === 'job' ? '!inner' : ''}(title)`;

type Pooled = { name?: string | null; pool_status?: PoolStatus | null } | null | undefined;
type Titled = { title?: string | null } | null | undefined;
type ApplicationRow = Omit<Application, 'candidate_name' | 'job_title' | 'candidate_pool_status'> & { candidate: Pooled; job: Titled };

const UNKNOWN = 'Unknown';

/** A row as read, with the joined name, pool status and title flattened onto it. */
export const toApplication = ({ candidate, job, ...row }: ApplicationRow): Application => ({
  ...row,
  candidate_name: candidate?.name ?? UNKNOWN,
  candidate_pool_status: candidate?.pool_status ?? 'none',
  job_title: job?.title ?? UNKNOWN,
});

const NOTHING: ApplicationSearchResult = { rows: [], more: false };

/** How many rows a lookup keeps: APPLICATION_SEARCH_LIMIT unless asked for more, never above HIRE_READ_CAP. */
const boundOf = (query: ApplicationSearch) => Math.min(query.limit ?? APPLICATION_SEARCH_LIMIT, HIRE_READ_CAP);

/** Newest first; the id breaks a tie, so the order never depends on which read a row came from. */
const newestFirst = (a: Application, b: Application) =>
  (a.applied_at < b.applied_at ? 1 : a.applied_at > b.applied_at ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The read against the database, with the member's own client (row-level security and the workspace filter apply,
 * as for every other hiring read). By the candidate's name; with `alsoJob`, a second read by the job's title, and
 * the two merged. Never one `or` with the typed text in it. A failed query throws.
 */
export async function readApplicationSearch(
  client: SupabaseClient,
  orgId: string,
  query: ApplicationSearch,
): Promise<ApplicationSearchResult> {
  if (!cleanSearchName(query.name)) return NOTHING;
  const bound = boundOf(query);
  // One more than kept, to tell "exactly this many" from "more". The API never answers with more than HIRE_READ_CAP.
  const asked = Math.min(bound + 1, HIRE_READ_CAP);
  const pattern = searchPattern(query.name);
  async function by(on: 'candidate' | 'job'): Promise<Application[]> {
    let request = client
      .from('hire_applications')
      .select(applicationColumns(on))
      .eq('org_id', orgId)
      .filter(on === 'candidate' ? 'candidate.name' : 'job.title', 'imatch', pattern);
    if (query.stage) request = request.eq('stage', query.stage);
    if (query.outcome) request = request.eq('outcome', query.outcome);
    const { data, error } = await request.order('applied_at', { ascending: false }).order('id', { ascending: true }).limit(asked);
    if (error) throw error;
    return ((data ?? []) as unknown as ApplicationRow[]).map(toApplication);
  }
  const reads = await Promise.all(query.alsoJob ? [by('candidate'), by('job')] : [by('candidate')]);
  const merged = new Map<string, Application>();
  for (const row of reads.flat()) if (!merged.has(row.id)) merged.set(row.id, row);
  const rows = [...merged.values()].sort(newestFirst);
  return {
    rows: rows.slice(0, bound),
    // A read that came back full had more behind it: past the bound, or at the API's own ceiling.
    more: rows.length > bound || reads.some((read) => read.length >= asked),
  };
}

/**
 * The same answer from rows already in memory, for a provider that holds all of its rows (the sample data, a test).
 * `list` is taken as newest first, as the providers hand it back.
 */
export function searchApplicationsFromList(list: readonly Application[], query: ApplicationSearch): ApplicationSearchResult {
  const text = cleanSearchName(query.name).toLowerCase();
  if (!text) return NOTHING;
  const matches = list.filter(
    (a) =>
      (a.candidate_name.toLowerCase().includes(text) || (query.alsoJob === true && a.job_title.toLowerCase().includes(text))) &&
      (!query.stage || a.stage === query.stage) &&
      (!query.outcome || a.outcome === query.outcome),
  );
  const bound = boundOf(query);
  return { rows: matches.slice(0, bound), more: matches.length > bound || matches.length >= HIRE_READ_CAP };
}

/**
 * A lookup through whichever provider is in use. `capped` is true only when the provider has no search of its own
 * and its list came back full: an older match may then be missing.
 */
export async function findApplications(
  data: Pick<HireData, 'listApplications' | 'searchApplications'>,
  query: ApplicationSearch,
): Promise<ApplicationSearchResult & { capped: boolean }> {
  if (data.searchApplications) return { ...(await data.searchApplications(query)), capped: false };
  const list = await data.listApplications();
  return { ...searchApplicationsFromList(list, query), capped: list.length >= HIRE_READ_CAP };
}

/** The email and phone of these candidates, by id, in this workspace; each id asked once. A failed query throws. */
export async function readContacts(
  client: SupabaseClient,
  orgId: string,
  ids: readonly string[],
): Promise<Pick<Candidate, 'id' | 'email' | 'phone'>[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const { data, error } = await client.from('hire_candidates').select('id,email,phone').eq('org_id', orgId).in('id', unique);
  if (error) throw error;
  return (data ?? []) as Pick<Candidate, 'id' | 'email' | 'phone'>[];
}
