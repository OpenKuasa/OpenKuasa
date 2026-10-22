import type { SupabaseClient } from '@supabase/supabase-js';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { feedbackOf } from './interview-feedback';
import { applicationColumns, readApplicationSearch, readContacts, toApplication } from './application-search';
import { CANDIDATE_COLUMNS, readCandidateSearch, readPool } from './candidate-search';
import { readInterviewCard, readNamesakes } from './namesakes';
import { createSeedHireData } from './seed';
import { DEFAULT_HIRE_SETTINGS, HIRE_READ_CAP, JOB_COLUMNS, SETTINGS_COLUMNS } from './types';
import type {
  ApplicationOutcome, ApplicationStage, Candidate, HireData, HireSettings, Interview, Job, PoolStatus,
} from './types';

/** The API answers with at most this many rows per request. */
const PAGE_SIZE = HIRE_READ_CAP;

const INTERVIEW_COLUMNS =
  'id,application_id,scheduled_at,duration_minutes,kind,place,interviewer_name,notes,status,created_at,updated_at,' +
  'feedback_rating,feedback_recommendation,feedback_comments,feedback_at,' +
  'application:hire_applications(stage,outcome,candidate:hire_candidates(name),job:hire_jobs(title))';

type Named = { name?: string | null } | null | undefined;
type Titled = { title?: string | null } | null | undefined;
type InterviewRow = Omit<Interview, 'candidate_name' | 'job_title' | 'application_stage' | 'application_outcome' | 'feedback'> & {
  feedback_rating?: number | null;
  feedback_recommendation?: string | null;
  feedback_comments?: string | null;
  feedback_at?: string | null;
  application: { stage?: ApplicationStage | null; outcome?: ApplicationOutcome | null; candidate: Named; job: Titled } | null;
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
      (await rows<Parameters<typeof toApplication>[0]>('hire_applications', applicationColumns(), { col: 'applied_at', asc: false }))
        .map(toApplication),
    listInterviews: async () =>
      // Read newest-first so the row ceiling drops the oldest interviews, then hand back soonest-first.
      [...(await rows<InterviewRow>('hire_interviews', INTERVIEW_COLUMNS, { col: 'scheduled_at', asc: false }))]
        .reverse()
        .map(({ application, feedback_rating, feedback_recommendation, feedback_comments, feedback_at, ...row }) => {
          // The four columns become one value. A row without feedback gets no key at all.
          const feedback = feedbackOf({ feedback_rating, feedback_recommendation, feedback_comments, feedback_at });
          return {
            ...row,
            ...(feedback ? { feedback } : {}),
            candidate_name: application?.candidate?.name ?? UNKNOWN,
            job_title: application?.job?.title ?? UNKNOWN,
            // The foreign key means an interview always has its application. Should one ever be unreadable, the row
            // is treated as applied and active: every change is still checked by the database.
            application_stage: application?.stage ?? 'applied',
            application_outcome: application?.outcome ?? 'active',
          };
        }),
    getSettings: async () => {
      const { data, error } = await client
        .from('hire_settings').select(SETTINGS_COLUMNS).eq('org_id', orgId).maybeSingle();
      if (error) throw error;
      return { org_id: orgId, ...DEFAULT_HIRE_SETTINGS, ...((data ?? {}) as Partial<HireSettings>) };
    },
    namesakes: (kind, id) => readNamesakes(client, orgId, kind, id),
    poolStatusOf: (id) => readPoolStatus(client, orgId, id),
    interviewCard: (id) => readInterviewCard(client, orgId, id),
    searchCandidates: (query) => readCandidateSearch(client, orgId, query),
    listPool: () => readPool(client, orgId),
    searchApplications: (query) => readApplicationSearch(client, orgId, query),
    contactsOf: (ids) => readContacts(client, orgId, ids),
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
