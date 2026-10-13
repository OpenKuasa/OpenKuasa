// src/lib/hire/namesakes.ts
/**
 * The rows that share a name with one row: what a deletion's approval card
 * needs to know to say which of them it is about. Read by id and by name,
 * never from a whole list, so no page size can make the answer wrong.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { feedbackOf } from './interview-feedback';
import type {
  Application, ApplicationOutcome, Candidate, Interview, InterviewCardRead, InterviewCardRow, InterviewKind, InterviewStatus, Namesake, Namesakes,
} from './types';

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

// ─── which interview an approval card is about ───────────────────────────────

const NO_INTERVIEW: InterviewCardRead = { target: null, others: [], cut: false, also: [], alsoClosed: [], application_outcome: null };

/**
 * The same answer from interviews already in memory, for a provider that holds all of its rows (the sample data,
 * a test). Never used over a list that a page size may have cut: the database provider has its own read below.
 */
export function interviewCardFromLists(
  id: unknown,
  interviews: readonly Pick<
    Interview,
    'id' | 'application_id' | 'candidate_name' | 'job_title' | 'scheduled_at' | 'kind' | 'status' | 'duration_minutes' | 'place' | 'application_outcome' | 'feedback'
  >[],
  /** Which candidate each application is of. Left out, only the interview's own application is known to be the same person's. */
  applications: readonly Pick<Application, 'id' | 'candidate_id'>[] = [],
): InterviewCardRead {
  const describe = (i: (typeof interviews)[number]): InterviewCardRow => ({
    id: i.id, application_id: i.application_id, candidate: i.candidate_name, job: i.job_title, scheduled_at: i.scheduled_at, kind: i.kind,
    status: i.status, duration_minutes: i.duration_minutes, place: i.place,
    // Only when there is feedback, and never its comments: a card line says the rating, the recommendation and when it was saved.
    ...(i.feedback ? { feedback: { rating: i.feedback.rating, recommendation: i.feedback.recommendation, recorded_at: i.feedback.recorded_at } } : {}),
  });
  const row = interviews.find((i) => i.id === id);
  if (!row) return NO_INTERVIEW;
  const [name, job] = [sameText(row.candidate_name), sameText(row.job_title)];
  const sameName = interviews.filter((i) => i.id !== row.id && sameText(i.candidate_name) === name);
  const candidateOf = new Map(applications.map((a) => [a.id, a.candidate_id]));
  const candidate = candidateOf.get(row.application_id);
  const sameCandidate = (applicationId: string) =>
    applicationId === row.application_id || (candidate !== undefined && candidateOf.get(applicationId) === candidate);
  const theirs = interviews
    .filter((i) => i.id !== row.id && sameCandidate(i.application_id))
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
  return {
    target: describe(row),
    others: sameName.filter((i) => sameText(i.job_title) === job).map(describe),
    cut: false,
    // The same person is the same candidate, never the same name: a namesake's interview is not this person's.
    also: theirs.filter((i) => i.status === 'scheduled').map(describe),
    alsoClosed: theirs.filter((i) => i.status !== 'scheduled').map(describe),
    application_outcome: row.application_outcome,
  };
}

/** The ids of the rows of one table whose name (or title) is this text, by the exact rule; `cut` when the database had more than were read. */
async function idsCalled(
  client: SupabaseClient,
  orgId: string,
  table: 'hire_candidates' | 'hire_jobs',
  column: 'name' | 'title',
  text: string,
): Promise<{ ids: string[]; cut: boolean }> {
  const { data, error } = await client
    .from(table)
    .select(`id,${column}`)
    .eq('org_id', orgId)
    .filter(column, 'imatch', nameRegex(text))
    .limit(NAMESAKE_LIMIT + 1);
  if (error) throw error;
  const read = (data ?? []) as unknown as Record<string, string>[];
  // The database only narrows the rows: `sameText` decides.
  return { ids: read.filter((row) => sameText(row[column] ?? '') === sameText(text)).map((row) => row.id), cut: read.length > NAMESAKE_LIMIT };
}

/** What a card says of one interview. No contact detail and no notes. */
const CARD_COLUMNS = 'id,application_id,scheduled_at,kind,status,duration_minutes,place';
/** The target's own read also says what feedback it has: the rating, the recommendation and when it was saved. Never the comments. */
const TARGET_COLUMNS = `${CARD_COLUMNS},feedback_rating,feedback_recommendation,feedback_at`;
type CardColumns = {
  id: string; application_id: string; scheduled_at: string; kind: InterviewKind; status: InterviewStatus; duration_minutes: number; place: string | null;
};

/**
 * One interview by its id, and every other interview that could be taken for it: those of anyone with the same
 * name, for a job with the same title, whether of the same application (a second round) or of a namesake's. Then
 * every other interview still scheduled with this very candidate (by the candidate's id), for any job: what the card
 * lists beside it. A namesake's interviews are not this person's and are not listed.
 * Read by id and by name with the member's own client (row-level security and the workspace filter apply), never
 * from a whole list, so no page size can make the answer wrong. No contact detail and no notes are read. A failed
 * query throws; the caller then prepares no change.
 */
export async function readInterviewCard(client: SupabaseClient, orgId: string, id: unknown): Promise<InterviewCardRead> {
  if (typeof id !== 'string' || !id) return NO_INTERVIEW;

  const found = await client
    .from('hire_interviews')
    .select(`${TARGET_COLUMNS},application:hire_applications(outcome,candidate_id,candidate:hire_candidates(name),job:hire_jobs(title))`)
    .eq('org_id', orgId)
    .eq('id', id)
    .maybeSingle();
  if (found.error) throw found.error;
  const row = found.data as unknown as (CardColumns & {
    feedback_rating?: number | null; feedback_recommendation?: string | null; feedback_at?: string | null;
    application: { outcome: ApplicationOutcome | null; candidate_id: string | null; candidate: { name: string } | null; job: { title: string } | null } | null;
  }) | null;
  const name = row?.application?.candidate?.name;
  const title = row?.application?.job?.title;
  // An interview that cannot be named cannot be described on a card.
  if (!row || !name || !title) return NO_INTERVIEW;

  // Everyone of that name, and every job of that title; then the applications that join one of each.
  const people = await idsCalled(client, orgId, 'hire_candidates', 'name', name);
  const jobs = await idsCalled(client, orgId, 'hire_jobs', 'title', title);
  const applications = await client
    .from('hire_applications')
    .select('id')
    .eq('org_id', orgId)
    .in('candidate_id', people.ids)
    .in('job_id', jobs.ids)
    .limit(NAMESAKE_LIMIT + 1);
  if (applications.error) throw applications.error;
  const applicationsRead = (applications.data ?? []) as unknown as { id: string }[];
  // The interview's own application first, whatever was or was not among the rows read: a second round is the common case.
  const applicationIds = [...new Set([row.application_id, ...applicationsRead.slice(0, NAMESAKE_LIMIT).map((a) => a.id)])];

  const twins = await client
    .from('hire_interviews')
    .select(CARD_COLUMNS)
    .eq('org_id', orgId)
    .neq('id', id)
    .in('application_id', applicationIds)
    .order('scheduled_at', { ascending: true })
    .limit(NAMESAKE_LIMIT + 1);
  if (twins.error) throw twins.error;
  const twinsRead = (twins.data ?? []) as unknown as CardColumns[];

  // Every application of this candidate, with its job's title; then the other interviews of those applications.
  // By the candidate's id: someone else with the same name is someone else.
  const titleOf = new Map<string, string>([[row.application_id, title]]);
  const candidateId = row.application?.candidate_id;
  if (candidateId) {
    const theirApplications = await client
      .from('hire_applications')
      .select('id,job:hire_jobs(title)')
      .eq('org_id', orgId)
      .eq('candidate_id', candidateId)
      .limit(NAMESAKE_LIMIT + 1);
    if (theirApplications.error) throw theirApplications.error;
    for (const a of ((theirApplications.data ?? []) as unknown as { id: string; job: { title: string } | null }[]).slice(0, NAMESAKE_LIMIT)) {
      if (!titleOf.has(a.id)) titleOf.set(a.id, a.job?.title ?? title);
    }
  }
  const theirs = await client
    .from('hire_interviews')
    .select(CARD_COLUMNS)
    .eq('org_id', orgId)
    .neq('id', id)
    .in('application_id', [...titleOf.keys()])
    .order('scheduled_at', { ascending: true })
    .limit(NAMESAKE_LIMIT + 1);
  if (theirs.error) throw theirs.error;
  const theirsRead = ((theirs.data ?? []) as unknown as CardColumns[]).slice(0, NAMESAKE_LIMIT);

  const describe = (i: CardColumns, job: string): InterviewCardRow => ({
    id: i.id, application_id: i.application_id, candidate: name, job, scheduled_at: i.scheduled_at, kind: i.kind,
    status: i.status, duration_minutes: i.duration_minutes, place: i.place ?? null,
  });
  return {
    target: (() => {
      const own = feedbackOf(row);
      return { ...describe(row, title), ...(own ? { feedback: { rating: own.rating, recommendation: own.recommendation, recorded_at: own.recorded_at } } : {}) };
    })(),
    // The others are of the same name and title by the rule above, so they are worded as the target is.
    others: twinsRead.slice(0, NAMESAKE_LIMIT).map((i) => describe(i, title)),
    cut: people.cut || jobs.cut || applicationsRead.length > NAMESAKE_LIMIT || twinsRead.length > NAMESAKE_LIMIT,
    // A list for the person to read, not a promise: more than were read are simply not all listed.
    also: theirsRead.filter((i) => i.status === 'scheduled').map((i) => describe(i, titleOf.get(i.application_id) ?? title)),
    alsoClosed: theirsRead.filter((i) => i.status !== 'scheduled').map((i) => describe(i, titleOf.get(i.application_id) ?? title)),
    application_outcome: row.application?.outcome ?? null,
  };
}
