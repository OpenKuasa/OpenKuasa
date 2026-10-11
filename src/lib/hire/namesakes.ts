// src/lib/hire/namesakes.ts
/**
 * The rows that share a name with one row: what a deletion's approval card
 * needs to know to say which of them it is about. Read by id and by name,
 * never from a whole list, so no page size can make the answer wrong.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Application, Candidate, Namesake, Namesakes } from './types';

/** How many same-named rows are read. More than this and the answer is marked `cut`. */
export const NAMESAKE_LIMIT = 50;

const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/**
 * Two names are one when they differ only in letter case, in spacing, or in
 * how the same letters are encoded (NFKC, and characters that take no room).
 */
export const sameText = (value: string) =>
  value.normalize('NFKC').replace(ZERO_WIDTH, '').trim().replace(/\s+/g, ' ').toLowerCase();

const escapeRegex = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A pattern for the database's case-insensitive match that fits this text
 * whatever its letter case and spacing: its words, in order, with any run of
 * spaces between and around them. The text is tried as stored and in three
 * Unicode forms. The database only narrows the rows: `sameText` in code then
 * decides, so a pattern that lets a few too many through does no harm.
 */
export function nameRegex(text: string): string {
  const forms = new Set([text, text.normalize('NFC'), text.normalize('NFD'), text.normalize('NFKC')]);
  const patterns = [...forms]
    .map((form) => form.replace(ZERO_WIDTH, '').trim().split(/\s+/).filter(Boolean).map(escapeRegex).join('\\s+'))
    .filter(Boolean);
  return `^\\s*(${[...new Set(patterns)].join('|')})\\s*$`;
}

const NOBODY: Namesakes = { target: null, others: [], cut: false };

type Person = Pick<Candidate, 'id' | 'name' | 'email' | 'location' | 'headline' | 'created_at'>;
const ofCandidate = (c: Person): Namesake => ({
  id: c.id, name: c.name, job: null, email: c.email ?? null, location: c.location ?? null, headline: c.headline ?? null, added_at: c.created_at,
});

/**
 * The same answer from rows already in memory, for a provider that holds all
 * of its rows (the sample data, a test). Never used over a list that a page
 * size may have cut: the database provider has its own read below.
 */
export function namesakesFromLists(
  kind: 'application' | 'candidate',
  id: unknown,
  candidates: readonly Person[],
  applications: readonly Pick<Application, 'id' | 'candidate_id' | 'candidate_name' | 'job_title' | 'applied_at'>[],
): Namesakes {
  if (kind === 'candidate') {
    const row = candidates.find((c) => c.id === id);
    if (!row) return NOBODY;
    const name = sameText(row.name);
    return { target: ofCandidate(row), others: candidates.filter((c) => c.id !== row.id && sameText(c.name) === name).map(ofCandidate), cut: false };
  }
  const people = new Map(candidates.map((c) => [c.id, c]));
  const ofApplication = (a: (typeof applications)[number]): Namesake => {
    const person = people.get(a.candidate_id);
    return {
      id: a.id, name: a.candidate_name, job: a.job_title,
      email: person?.email ?? null, location: person?.location ?? null, headline: person?.headline ?? null, added_at: a.applied_at,
    };
  };
  const row = applications.find((a) => a.id === id);
  if (!row) return NOBODY;
  const [name, job] = [sameText(row.candidate_name), sameText(row.job_title)];
  return {
    target: ofApplication(row),
    others: applications
      .filter((a) => a.id !== row.id && sameText(a.candidate_name) === name && sameText(a.job_title) === job)
      .map(ofApplication),
    cut: false,
  };
}

const PERSON = 'id,name,email,location,headline,created_at';

/**
 * The read against the database, with the member's own client (row-level
 * security and the workspace filter apply, as for every other hiring read).
 * A failed query throws; the caller refuses the deletion.
 */
export async function readNamesakes(
  client: SupabaseClient,
  orgId: string,
  kind: 'application' | 'candidate',
  id: unknown,
): Promise<Namesakes> {
  if (typeof id !== 'string' || !id) return NOBODY;

  /** The candidates whose name is this one, by the exact rule; `cut` when the database had more than were read. */
  const peopleCalled = async (name: string): Promise<{ rows: Person[]; cut: boolean }> => {
    const { data, error } = await client
      .from('hire_candidates')
      .select(PERSON)
      .eq('org_id', orgId)
      .filter('name', 'imatch', nameRegex(name))
      .order('created_at', { ascending: false })
      .limit(NAMESAKE_LIMIT + 1);
    if (error) throw error;
    const read = (data ?? []) as unknown as Person[];
    return { rows: read.filter((c) => sameText(c.name) === sameText(name)), cut: read.length > NAMESAKE_LIMIT };
  };

  if (kind === 'candidate') {
    const found = await client.from('hire_candidates').select(PERSON).eq('org_id', orgId).eq('id', id).maybeSingle();
    if (found.error) throw found.error;
    const row = found.data as unknown as Person | null;
    if (!row) return NOBODY;
    const called = await peopleCalled(row.name);
    return { target: ofCandidate(row), others: called.rows.filter((c) => c.id !== row.id).map(ofCandidate), cut: called.cut };
  }

  const found = await client
    .from('hire_applications')
    .select('id,candidate_id,job_id,applied_at,candidate:hire_candidates(name,email,location,headline),job:hire_jobs(title)')
    .eq('org_id', orgId)
    .eq('id', id)
    .maybeSingle();
  if (found.error) throw found.error;
  const row = found.data as unknown as {
    id: string; candidate_id: string; job_id: string; applied_at: string; job: { title: string } | null;
    candidate: { name: string; email: string | null; location: string | null; headline: string | null } | null;
  } | null;
  if (!row || !row.candidate || !row.job) return NOBODY;
  const [name, title] = [row.candidate.name, row.job.title];

  // Everyone of that name, and every job of that title; then the applications that join one of each.
  const called = await peopleCalled(name);
  const jobs = await client
    .from('hire_jobs')
    .select('id,title')
    .eq('org_id', orgId)
    .filter('title', 'imatch', nameRegex(title))
    .limit(NAMESAKE_LIMIT + 1);
  if (jobs.error) throw jobs.error;
  const jobsRead = (jobs.data ?? []) as unknown as { id: string; title: string }[];
  const jobIds = jobsRead.filter((j) => sameText(j.title) === sameText(title)).map((j) => j.id);
  const people = new Map(called.rows.map((c) => [c.id, c]));
  const twins = await client
    .from('hire_applications')
    .select('id,candidate_id,applied_at')
    .eq('org_id', orgId)
    .neq('id', id)
    .in('candidate_id', [...people.keys()])
    .in('job_id', jobIds)
    .order('applied_at', { ascending: false })
    .limit(NAMESAKE_LIMIT + 1);
  if (twins.error) throw twins.error;
  const twinsRead = (twins.data ?? []) as unknown as { id: string; candidate_id: string; applied_at: string }[];
  const of = (a: { id: string; candidate_id: string; applied_at: string }): Namesake => {
    const person = people.get(a.candidate_id);
    return {
      id: a.id, name: person?.name ?? name, job: title,
      email: person?.email ?? null, location: person?.location ?? null, headline: person?.headline ?? null, added_at: a.applied_at,
    };
  };
  return {
    // The row itself is described from its own read, whoever else was or was not among the people read.
    target: {
      id: row.id, name, job: title,
      email: row.candidate.email ?? null, location: row.candidate.location ?? null, headline: row.candidate.headline ?? null, added_at: row.applied_at,
    },
    others: twinsRead.slice(0, NAMESAKE_LIMIT).map(of),
    cut: called.cut || jobsRead.length > NAMESAKE_LIMIT || twinsRead.length > NAMESAKE_LIMIT,
  };
}
