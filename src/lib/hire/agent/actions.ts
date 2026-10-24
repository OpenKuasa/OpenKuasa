import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { HIRE_NOTE_ENTITY_TYPES } from '@/lib/hire/agent/scan';
import type { CapResult } from '@/lib/reach/capabilities';

/**
 * The approver's own session the apply path runs Lekir's agent action under, plus the claimed
 * proposal's id (the note RPC reads the note's text and target from that proposal).
 */
export type HireAgentWriteContext = {
  client: SupabaseClient;
  orgId: string;
  userId: string;
  proposalId?: string;
};

export const HIRE_NO_LONGER_APPLIES = 'This no longer applies.';
const NOT_ADDED = 'That note could not be added.';

export const hireAgentNoteInput = z.object({
  target: z.string().uuid(),
  entity_type: z.enum(HIRE_NOTE_ENTITY_TYPES),
  label: z.string().min(1).max(200),
  // Never trimmed: the note is written from the stored proposal exactly as it was approved.
  body: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => s.trim().length > 0, 'Write a note'),
  stage: z.string().min(1).max(64),
});

export type HireAgentNoteInput = z.infer<typeof hireAgentNoteInput>;

type Check = 'stale' | 'live' | 'unreadable';
type Row = Record<string, unknown>;

/** The record type each check leaves its note on. */
const CHECK_ENTITY: Record<string, HireAgentNoteInput['entity_type']> = {
  application_unscreened: 'hire_application',
  screening_no_interview: 'hire_application',
  application_quiet: 'hire_application',
  offer_waiting: 'hire_application',
  interview_not_updated: 'hire_interview',
  feedback_missing: 'hire_interview',
  job_open_long: 'hire_job',
  job_few_applicants: 'hire_job',
  job_closing_soon: 'hire_job',
  pool_idle: 'hire_candidate',
};

/** One row by id under the approver's session; null data means gone (or not theirs to see). */
async function readOne(ctx: HireAgentWriteContext, table: string, columns: string, id: string): Promise<Row | null | 'error'> {
  const { data, error } = await ctx.client.from(table).select(columns).eq('org_id', ctx.orgId).eq('id', id).maybeSingle();
  if (error) return 'error';
  return (data as Row | null) ?? null;
}

/** Rows of `table` where `column` = `value`, plus extra equality filters, under the approver's session. */
async function readWhere(
  ctx: HireAgentWriteContext,
  table: string,
  columns: string,
  filters: [string, string][],
  limit?: number,
): Promise<Row[] | 'error'> {
  let q = ctx.client.from(table).select(columns).eq('org_id', ctx.orgId);
  for (const [c, v] of filters) q = q.eq(c, v);
  const { data, error } = limit ? await q.limit(limit) : await q;
  if (error) return 'error';
  return (data ?? []) as unknown as Row[];
}

const after = (instant: unknown, since: string) =>
  typeof instant === 'string' && Date.parse(instant) > Date.parse(since);

/** Whether the note's target still matches the check that raised it (spec §5, "no longer applies"). */
async function stillApplies(
  ctx: HireAgentWriteContext,
  checkKey: string,
  input: HireAgentNoteInput,
  proposedAt: string,
): Promise<Check> {
  // A note on the wrong kind of record for its check is never written.
  if (CHECK_ENTITY[checkKey] !== input.entity_type) return 'unreadable';
  const id = input.target;

  switch (checkKey) {
    case 'application_unscreened':
    case 'screening_no_interview':
    case 'application_quiet':
    case 'offer_waiting': {
      const app = await readOne(ctx, 'hire_applications', 'stage,outcome,offered_at', id);
      if (app === 'error') return 'unreadable';
      if (!app || app.outcome !== 'active') return 'stale';
      const stages: Record<string, string[]> = {
        application_unscreened: ['applied'],
        screening_no_interview: ['screening'],
        application_quiet: ['interview', 'offer'],
        offer_waiting: ['offer'],
      };
      if (!stages[checkKey].includes(String(app.stage))) return 'stale';
      if (checkKey === 'screening_no_interview') {
        // An interview booked since: it no longer matches.
        const booked = await readWhere(ctx, 'hire_interviews', 'id', [['application_id', id]], 1);
        if (booked === 'error') return 'unreadable';
        return booked.length > 0 ? 'stale' : 'live';
      }
      if (checkKey === 'application_quiet') {
        // Any activity since the suggestion was made: it is no longer quiet.
        if (after(app.offered_at, proposedAt)) return 'stale';
        const interviews = await readWhere(ctx, 'hire_interviews', 'created_at,updated_at,feedback_at', [['application_id', id]]);
        if (interviews === 'error') return 'unreadable';
        const moved = interviews.some(
          (i) => after(i.created_at, proposedAt) || after(i.updated_at, proposedAt) || after(i.feedback_at, proposedAt),
        );
        return moved ? 'stale' : 'live';
      }
      return 'live';
    }
    case 'interview_not_updated':
    case 'feedback_missing': {
      const interview = await readOne(ctx, 'hire_interviews', 'status,updated_at,feedback_at', id);
      if (interview === 'error') return 'unreadable';
      if (!interview) return 'stale';
      if (checkKey === 'interview_not_updated') {
        return interview.status === 'scheduled' && !after(interview.updated_at, proposedAt) ? 'live' : 'stale';
      }
      return interview.status === 'completed' && interview.feedback_at == null ? 'live' : 'stale';
    }
    case 'job_open_long':
    case 'job_few_applicants':
    case 'job_closing_soon': {
      const job = await readOne(ctx, 'hire_jobs', 'status,closes_on,headcount', id);
      if (job === 'error') return 'unreadable';
      if (!job || job.status !== 'open') return 'stale';
      if (checkKey === 'job_closing_soon') return job.closes_on === input.stage ? 'live' : 'stale';
      if (checkKey === 'job_open_long') {
        const hired = await readWhere(ctx, 'hire_applications', 'id', [
          ['job_id', id],
          ['stage', 'hired'],
          ['outcome', 'active'],
        ]);
        if (hired === 'error') return 'unreadable';
        const headcount = typeof job.headcount === 'number' ? job.headcount : 1;
        return hired.length >= headcount ? 'stale' : 'live';
      }
      return 'live';
    }
    case 'pool_idle': {
      const candidate = await readOne(ctx, 'hire_candidates', 'pool_status', id);
      if (candidate === 'error') return 'unreadable';
      if (!candidate || candidate.pool_status === 'none') return 'stale';
      const current = await readWhere(ctx, 'hire_applications', 'id', [
        ['candidate_id', id],
        ['outcome', 'active'],
      ], 1);
      if (current === 'error') return 'unreadable';
      return current.length > 0 ? 'stale' : 'live';
    }
    default:
      return 'unreadable';
  }
}

/**
 * Leaves the agent's note through the `hire_add_agent_note` RPC, which takes the note's text and
 * target from the approved proposal itself (and refuses unless this person approved it in the
 * last 10 minutes, once). The RPC does not look at the record, so this first re-reads it under the
 * approver's own session: when it no longer matches its check (stage moved, outcome not active,
 * interview updated or feedback in, job closed or filled, candidate out of the pool or in a current
 * application, or gone) nothing is written and the answer is "This no longer applies." with
 * `stale: true`.
 */
export async function hireCreateAgentNote(
  ctx: HireAgentWriteContext,
  input: HireAgentNoteInput,
): Promise<CapResult<{ id: string }>> {
  if (!ctx.proposalId) return { ok: false, error: NOT_ADDED };

  const proposal = await ctx.client
    .from('agent_proposals')
    .select('check_key,created_at')
    .eq('org_id', ctx.orgId)
    .eq('id', ctx.proposalId)
    .maybeSingle();
  const row = proposal.data as { check_key: string | null; created_at: string } | null;
  const checkKey = row?.check_key;
  if (proposal.error || !row || !checkKey) {
    console.error('[hire-agent] proposal not read:', proposal.error?.code);
    return { ok: false, error: NOT_ADDED };
  }

  const applies = await stillApplies(ctx, checkKey, input, row.created_at);
  if (applies === 'stale') return { ok: false, error: HIRE_NO_LONGER_APPLIES, stale: true };
  if (applies === 'unreadable') return { ok: false, error: NOT_ADDED };

  const { data, error } = await ctx.client.rpc('hire_add_agent_note', {
    target_org: ctx.orgId,
    proposal_id: ctx.proposalId,
  });
  if (error || !data) {
    console.error('[hire-agent] note failed:', error?.code);
    return { ok: false, error: NOT_ADDED };
  }
  return { ok: true, data: { id: String(data) } };
}
