import type { SupabaseClient } from '@supabase/supabase-js';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { readNamesakes } from './namesakes';
import { createSeedHireData } from './seed';
import { DEFAULT_HIRE_SETTINGS, HIRE_READ_CAP, JOB_COLUMNS, SETTINGS_COLUMNS } from './types';
import type { Application, Candidate, HireData, HireSettings, Interview, Job, PoolStatus } from './types';

/** The API answers with at most this many rows per request. */
const PAGE_SIZE = HIRE_READ_CAP;

const CANDIDATE_COLUMNS = 'id,name,email,phone,headline,location,skills,source,pool_status,created_at';
const APPLICATION_COLUMNS =
  'id,candidate_id,job_id,stage,outcome,reject_reason,rating,source,applied_at,offered_at,hired_at,created_at,' +
  'cover_letter,cv_url,cv_path,portfolio_url,expected_salary_cents,consented_at,' +
  'candidate:hire_candidates(name,pool_status),job:hire_jobs(title)';
const INTERVIEW_COLUMNS =
  'id,application_id,scheduled_at,kind,interviewer_name,status,created_at,' +
  'application:hire_applications(candidate:hire_candidates(name),job:hire_jobs(title))';

type Named = { name?: string | null } | null | undefined;
type Titled = { title?: string | null } | null | undefined;
type Pooled = { name?: string | null; pool_status?: PoolStatus | null } | null | undefined;
type ApplicationRow = Omit<Application, 'candidate_name' | 'job_title' | 'candidate_pool_status'> & { candidate: Pooled; job: Titled };
type InterviewRow = Omit<Interview, 'candidate_name' | 'job_title'> & {
  application: { candidate: Named; job: Titled } | null;
};

const UNKNOWN = 'Unknown';

/**
 * One candidate's stored talent pool status, read by id with the member's own client (row-level security and the
 * workspace filter apply). Null when the row is not there, or the id is not one. A failed query throws.
 */
export async function readPoolStatus(client: SupabaseClient, orgId: string, id: unknown): Promise<PoolStatus | null> {
  if (typeof id !== 'string' || !id) return null;
  const { data, error } = await client
    .from('hire_candidates')
    .select('pool_status')
    .eq('org_id', orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as { pool_status: PoolStatus } | null)?.pool_status ?? null;
}

/**
 * RLS-scoped {@link HireData} over Supabase. Reads are filtered to `orgId` (the
 * caller's current org); Postgres RLS independently guarantees no other org's
 * rows are reachable, so `orgId` is a workspace selector, not the security
 * boundary.
 */
export function createSupabaseHireData(client: SupabaseClient, orgId: string): HireData {
  async function rows<T>(table: string, columns: string, order: { col: string; asc: boolean }): Promise<T[]> {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .eq('org_id', orgId)
      .order(order.col, { ascending: order.asc })
      .limit(PAGE_SIZE);
    if (error) throw error;
    return (data ?? []) as T[];
  }

  return {
    listJobs: () => rows<Job>('hire_jobs', JOB_COLUMNS, { col: 'created_at', asc: false }),
    listCandidates: async () =>
      (await rows<Candidate>('hire_candidates', CANDIDATE_COLUMNS, { col: 'created_at', asc: false })).map(
        (candidate) => ({ ...candidate, skills: candidate.skills ?? [] }),
      ),
    listApplications: async () =>
      (await rows<ApplicationRow>('hire_applications', APPLICATION_COLUMNS, { col: 'applied_at', asc: false })).map(
        ({ candidate, job, ...row }) => ({
          ...row,
          candidate_name: candidate?.name ?? UNKNOWN,
          candidate_pool_status: candidate?.pool_status ?? 'none',
          job_title: job?.title ?? UNKNOWN,
        }),
      ),
    listInterviews: async () =>
      // Read newest-first so the row ceiling drops the oldest interviews, then hand back soonest-first.
      [...(await rows<InterviewRow>('hire_interviews', INTERVIEW_COLUMNS, { col: 'scheduled_at', asc: false }))]
        .reverse()
        .map(({ application, ...row }) => ({
          ...row,
          candidate_name: application?.candidate?.name ?? UNKNOWN,
          job_title: application?.job?.title ?? UNKNOWN,
        })),
    getSettings: async () => {
      const { data, error } = await client
        .from('hire_settings').select(SETTINGS_COLUMNS).eq('org_id', orgId).maybeSingle();
      if (error) throw error;
      return { org_id: orgId, ...DEFAULT_HIRE_SETTINGS, ...((data ?? {}) as Partial<HireSettings>) };
    },
    namesakes: (kind, id) => readNamesakes(client, orgId, kind, id),
    poolStatusOf: (id) => readPoolStatus(client, orgId, id),
  };
}

const EMPTY_HIRE_DATA: HireData = {
  listJobs: async () => [],
  listCandidates: async () => [],
  listApplications: async () => [],
  listInterviews: async () => [],
  getSettings: async () => ({ org_id: null, ...DEFAULT_HIRE_SETTINGS }),
};

/**
 * Request-scoped provider selection: RLS-scoped Supabase in prod, the sample
 * data only when no project is configured (dev, preview, tests). One place, so
 * the route and every screen stay consistent.
 */
export async function getHireData(client: SupabaseClient): Promise<HireData> {
  if (!hasSupabaseEnv()) return createSeedHireData();
  const org = await getCurrentOrg(client);
  // Signed in but not yet in a workspace: show nothing, never the fictional data.
  return org ? createSupabaseHireData(client, org.orgId) : EMPTY_HIRE_DATA;
}
