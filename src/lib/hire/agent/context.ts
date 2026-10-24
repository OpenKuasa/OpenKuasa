import type { SupabaseClient } from '@supabase/supabase-js';
import { readBack, validatePlan, type FocusPlan } from '@/lib/agents/focus/plan';
import { HIRE_FOCUS } from '@/lib/agents/types';
import { HIRE_FOCUS_MENU } from '@/lib/hire/agent/checks';
import type { ApplicationOutcome, ApplicationStage, JobStatus, PoolStatus } from '@/lib/hire/types';

/**
 * Everything Lekir's scan needs, read once per run with the service client. Only stages,
 * statuses, dates, counts, the candidate's name and the job's title: the service role cannot read
 * anything else of a candidate (spec §7.3). Names are plain data (never escaped here).
 */
export type HireAgentRaw = {
  /** Null unless the owner confirmed a focus (`focus_confirmed_at` is set). */
  plan: FocusPlan | null;
  /** Every application of the workspace, any outcome, with the candidate's name and the job's title joined in. */
  applications: {
    id: string;
    candidateId: string;
    jobId: string;
    candidate: string;
    job: string;
    stage: ApplicationStage;
    outcome: ApplicationOutcome;
    appliedAt: string;
    offeredAt: string | null;
    hiredAt: string | null;
  }[];
  /** Every interview of the workspace (`status`: scheduled, completed, cancelled, no_show). */
  interviews: {
    id: string;
    applicationId: string;
    scheduledAt: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    feedbackAt: string | null;
  }[];
  /** Every job; `openedAt` is null for a job opened before the column was filled (use `createdAt`). */
  jobs: {
    id: string;
    title: string;
    status: JobStatus;
    openedAt: string | null;
    createdAt: string;
    closesOn: string | null;
    /** Null is read as 1. */
    headcount: number | null;
  }[];
  /** Every candidate on file. */
  candidates: { id: string; name: string; poolStatus: PoolStatus; createdAt: string }[];
};

/** PostgREST returns at most this many rows per request. */
const PAGE = 1000;

type Rows = { data: unknown[] | null; error: unknown };

/** Throws on any read error, so a run never works from a partial snapshot. */
function rowsOf(result: Rows): Record<string, unknown>[] {
  if (result.error) throw result.error;
  return (result.data ?? []) as Record<string, unknown>[];
}

/** Reads every page of a query, so the 1000-row response cap cannot hide older rows. */
async function readAll(page: (from: number, to: number) => PromiseLike<Rows>): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = rowsOf(await page(from, from + PAGE - 1));
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const headcountOf = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? null : n;
};

/**
 * Service-role read of the workspace for Lekir's agent. Reads ONLY the columns `service_role`
 * was granted for it (the hire agent service-reads migration); add a grant before adding a
 * column here. `service` MUST be the service-role client.
 */
export async function buildHireAgentContext(
  service: SupabaseClient,
  orgId: string,
): Promise<{ context: string; raw: HireAgentRaw }> {
  const config = await service
    .from('agent_configs')
    .select('focus_plan,focus_confirmed_at')
    .eq('org_id', orgId)
    .eq('agent_key', HIRE_FOCUS)
    .maybeSingle();
  if (config.error) throw config.error;
  const row = config.data as { focus_plan: unknown; focus_confirmed_at: string | null } | null;
  // Re-validated on every read: the stored plan is never trusted as-is.
  const plan = row?.focus_confirmed_at ? validatePlan(HIRE_FOCUS_MENU, row.focus_plan).plan : null;

  const [applicationRows, interviewRows, jobRows, candidateRows] = await Promise.all([
    readAll((from, to) =>
      service
        .from('hire_applications')
        .select('id,candidate_id,job_id,stage,outcome,applied_at,offered_at,hired_at')
        .eq('org_id', orgId)
        .order('applied_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    readAll((from, to) =>
      service
        .from('hire_interviews')
        .select('id,application_id,scheduled_at,status,created_at,updated_at,feedback_at')
        .eq('org_id', orgId)
        .order('scheduled_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    readAll((from, to) =>
      service
        .from('hire_jobs')
        .select('id,title,status,opened_at,created_at,closes_on,headcount')
        .eq('org_id', orgId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    readAll((from, to) =>
      service
        .from('hire_candidates')
        .select('id,name,pool_status,created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ]);

  const candidates: HireAgentRaw['candidates'] = candidateRows.map((r) => ({
    id: String(r.id),
    name: str(r.name) ?? 'A candidate',
    poolStatus: String(r.pool_status) as PoolStatus,
    createdAt: String(r.created_at),
  }));
  const jobs: HireAgentRaw['jobs'] = jobRows.map((r) => ({
    id: String(r.id),
    title: str(r.title) ?? 'A job',
    status: String(r.status) as JobStatus,
    openedAt: str(r.opened_at),
    createdAt: String(r.created_at),
    closesOn: str(r.closes_on),
    headcount: headcountOf(r.headcount),
  }));
  const nameOf = new Map(candidates.map((c) => [c.id, c.name]));
  const titleOf = new Map(jobs.map((j) => [j.id, j.title]));

  const raw: HireAgentRaw = {
    plan,
    applications: applicationRows.map((r) => ({
      id: String(r.id),
      candidateId: String(r.candidate_id),
      jobId: String(r.job_id),
      candidate: nameOf.get(String(r.candidate_id)) ?? 'A candidate',
      job: titleOf.get(String(r.job_id)) ?? 'a job',
      stage: String(r.stage) as ApplicationStage,
      outcome: String(r.outcome) as ApplicationOutcome,
      appliedAt: String(r.applied_at),
      offeredAt: str(r.offered_at),
      hiredAt: str(r.hired_at),
    })),
    interviews: interviewRows.map((r) => ({
      id: String(r.id),
      applicationId: String(r.application_id),
      scheduledAt: String(r.scheduled_at),
      status: String(r.status),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      feedbackAt: str(r.feedback_at),
    })),
    jobs,
    candidates,
  };

  // Counts only: no names, no ids, never the focus text.
  const active = raw.applications.filter((a) => a.outcome === 'active' && a.stage !== 'hired').length;
  const scheduled = raw.interviews.filter((i) => i.status === 'scheduled').length;
  const open = raw.jobs.filter((j) => j.status === 'open').length;
  const pool = raw.candidates.filter((c) => c.poolStatus !== 'none').length;
  let context =
    `Active applications: ${active}. Interviews scheduled: ${scheduled}. ` +
    `Open jobs: ${open}. People in the talent pool: ${pool}.`;
  if (plan) {
    context += `\nWhat the owner asked to watch:\n${readBack(HIRE_FOCUS_MENU, plan)
      .map((line) => `- ${line}`)
      .join('\n')}`;
  }
  return { context, raw };
}
