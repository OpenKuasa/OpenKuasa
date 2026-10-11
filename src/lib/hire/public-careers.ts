/**
 * What the public job board shows a visitor who is not signed in. A visitor
 * has no access to any table: each read goes through one of the two database
 * functions made for the purpose, which decide what a stranger may see.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ApplicationFormValues } from './application-form';
import type { EmploymentType, WorkArrangement } from './types';

export const DEFAULT_HEADLINE = 'Join our team';

export type PublicJobSummary = {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  workArrangement: WorkArrangement | null;
  employmentType: EmploymentType;
  /** Last day to apply, as YYYY-MM-DD. */
  closesOn: string | null;
  /** False once the closing date has passed. */
  accepting: boolean;
};
export type PublicCareers = { orgName: string; headline: string | null; tagline: string | null; jobs: PublicJobSummary[] };
export type PublicJob = PublicJobSummary & {
  orgName: string; headline: string | null; tagline: string | null;
  description: string;
  /** Monthly, in sen. Null when the workspace does not show the salary. */
  salaryMinCents: number | null;
  salaryMaxCents: number | null;
  /** What the apply form asks for. */
  form: ApplicationFormValues;
};

type Row = {
  org_name: string | null; headline: string | null; tagline: string | null;
  job_id: string | null; title: string | null; department: string | null; location: string | null;
  work_arrangement: WorkArrangement | null; employment_type: EmploymentType | null;
  closes_on: string | null; accepting: boolean | null;
  description?: string | null; salary_min_cents?: number | null; salary_max_cents?: number | null;
  require_cv?: boolean | null; require_cover_letter?: boolean | null;
  ask_portfolio?: boolean | null; ask_expected_salary?: boolean | null;
};

const isUuid = (value: string) => z.uuid().safeParse(value).success;

function summary(row: Row): PublicJobSummary | null {
  if (!row.job_id || !row.title) return null;
  return {
    id: row.job_id, title: row.title, department: row.department, location: row.location,
    workArrangement: row.work_arrangement, employmentType: row.employment_type ?? 'full_time',
    closesOn: row.closes_on, accepting: row.accepting !== false,
  };
}

/** What a call to one of the public functions gave: its data, or the fact that it failed. */
type Answer = { ok: true; data: unknown } | { ok: false };

/**
 * Calls one of the public functions. A read that fails, by an error in the
 * answer or by throwing, is logged and comes back as not ok: a visitor is
 * never shown an error. Only the database's error is logged.
 */
async function read(client: SupabaseClient, fn: string, args: Record<string, string>): Promise<Answer> {
  try {
    const { data, error } = await client.rpc(fn, args);
    if (!error) return { ok: true, data };
    console.error(`[public-careers] ${fn} failed:`, error);
  } catch (error) {
    console.error(`[public-careers] ${fn} failed:`, error);
  }
  return { ok: false };
}

/** The board of a workspace, or null when it has none to show. A failed read is also null (and logged). */
export async function getPublicCareers(client: SupabaseClient, orgId: string): Promise<PublicCareers | null> {
  if (!isUuid(orgId)) return null;
  const answer = await read(client, 'get_public_careers', { p_org_id: orgId });
  const rows = (answer.ok && Array.isArray(answer.data) ? answer.data : []) as Row[];
  const first = rows[0];
  if (!first?.org_name) return null;
  return {
    orgName: first.org_name, headline: first.headline, tagline: first.tagline,
    jobs: rows.map(summary).filter((job): job is PublicJobSummary => job !== null),
  };
}

/**
 * One open job on a workspace's board, and why not when there is none:
 * `missing` when nothing is there to show (an id that cannot be one, no row,
 * a row that is not a job), `failed` when the read itself did not work (and
 * was logged). The two are kept apart so that a read that failed is never
 * taken for a job that has closed.
 */
export async function readPublicJob(
  client: SupabaseClient,
  orgId: string,
  jobId: string,
): Promise<{ state: 'found'; job: PublicJob } | { state: 'missing' } | { state: 'failed' }> {
  if (!isUuid(orgId) || !isUuid(jobId)) return { state: 'missing' };
  const answer = await read(client, 'get_public_job', { p_org_id: orgId, p_job_id: jobId });
  if (!answer.ok) return { state: 'failed' };
  const row = (Array.isArray(answer.data) ? answer.data[0] : answer.data) as Row | null | undefined;
  const base = row ? summary(row) : null;
  if (!row?.org_name || !base) return { state: 'missing' };
  return {
    state: 'found',
    job: {
      ...base, orgName: row.org_name, headline: row.headline, tagline: row.tagline,
      description: row.description ?? '',
      salaryMinCents: row.salary_min_cents ?? null, salaryMaxCents: row.salary_max_cents ?? null,
      form: {
        require_cv: row.require_cv === true, require_cover_letter: row.require_cover_letter === true,
        ask_portfolio: row.ask_portfolio === true, ask_expected_salary: row.ask_expected_salary === true,
      },
    },
  };
}

/** One open job on a workspace's board, or null: to a page, a missing job and a failed read are both "not available". */
export async function getPublicJob(client: SupabaseClient, orgId: string, jobId: string): Promise<PublicJob | null> {
  const answer = await readPublicJob(client, orgId, jobId);
  return answer.state === 'found' ? answer.job : null;
}

/* ---- addresses ------------------------------------------------------- */

export const careersPath = (orgId: string) => `/careers/${orgId}`;
export const careersJobPath = (orgId: string, jobId: string) => `${careersPath(orgId)}/${jobId}`;
/** The full link to share, for a site served from `origin`. */
export const careersUrl = (origin: string, orgId: string) => `${origin.replace(/\/+$/, '')}${careersPath(orgId)}`;

/* ---- words ----------------------------------------------------------- */

export const ARRANGEMENT_LABEL: Record<WorkArrangement, string> = { onsite: 'On-site', hybrid: 'Hybrid', remote: 'Remote' };
export const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', internship: 'Internship',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** "31 October 2026" from "2026-10-31". A fixed month list: no locale, no time zone. */
export function formatLongDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : null;
}

/** Whole ringgit with thousands commas; sen only when not zero. */
export function ringgit(cents: number): string {
  const whole = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sen = cents % 100;
  return `RM ${whole}${sen ? `.${String(sen).padStart(2, '0')}` : ''}`;
}

/** "RM 4,000 – RM 6,000 a month", or null when there is nothing to show. */
export function formatSalary(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) return `${ringgit(min)} – ${ringgit(max)} a month`;
  if (min !== null) return `From ${ringgit(min)} a month`;
  if (max !== null) return `Up to ${ringgit(max)} a month`;
  return null;
}
