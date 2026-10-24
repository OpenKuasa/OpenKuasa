import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { PEOPLE_NOTE_ENTITY_TYPES, type PeopleNoteEntityType } from '@/lib/people/agent/scan';
import { addDays, todayInMalaysia } from '@/lib/people/dates';
import type { CapResult } from '@/lib/reach/capabilities';

/**
 * The approver's own session the apply path runs Lekiu's agent action under, plus the claimed
 * proposal's id (the note RPC reads the note's text and target from that proposal).
 */
export type PeopleAgentWriteContext = {
  client: SupabaseClient;
  orgId: string;
  userId: string;
  proposalId?: string;
};

export const PEOPLE_NO_LONGER_APPLIES = 'This no longer applies.';
const NOT_ADDED = 'That note could not be added.';

const PAYROLL_TARGET = /^payroll:(\d{4}-\d{2})$/;

export const peopleAgentNoteInput = z
  .object({
    entityType: z.enum(PEOPLE_NOTE_ENTITY_TYPES),
    entityId: z.string().uuid().nullable(),
    employeeId: z.string().uuid().nullable(),
    entityLabel: z.string().min(1).max(120),
    // Never trimmed: the note is written from the stored proposal exactly as it was approved.
    body: z
      .string()
      .min(1)
      .max(500)
      .refine((s) => s.trim().length > 0, 'Write a note'),
    target: z.string().min(1).max(100),
    stage: z.string().min(1).max(40),
    days: z.number().int().min(1).max(120).optional(),
  })
  .refine(
    (v) =>
      v.entityType === 'hr_payroll_month'
        ? v.entityId === null && v.employeeId === null && PAYROLL_TARGET.test(v.target)
        : v.entityId !== null &&
          v.employeeId !== null &&
          v.target === v.entityId &&
          (v.entityType !== 'hr_employee' || v.entityId === v.employeeId),
    { message: 'The note is not about anything it can be left on' },
  );

export type PeopleAgentNoteInput = z.infer<typeof peopleAgentNoteInput>;

type Check = 'stale' | 'live' | 'unreadable';

/** The record each check raises a note on, and what it must still look like. */
type RecordCheck = {
  entityType: PeopleNoteEntityType;
  table: string;
  columns: string;
  stillMatches: (row: Record<string, unknown>, input: PeopleAgentNoteInput, today: string) => boolean;
};

const pending = (row: Record<string, unknown>) => row.status === 'pending';

const RECORD_CHECKS: Record<string, RecordCheck> = {
  document_expiring: {
    entityType: 'hr_document',
    table: 'hr_documents',
    columns: 'employee_id,expires_on',
    stillMatches: (row, input, today) => {
      const on = typeof row.expires_on === 'string' ? row.expires_on.slice(0, 10) : null;
      if (on === null) return false;
      // The stage names the expiry it was raised for: a renewed (or otherwise changed) date is stale.
      const expired = input.stage.startsWith('expired');
      if (input.stage !== `${expired ? 'expired' : 'soon'}:${on}`) return false;
      // An expired note needs it still expired. A soon note needs it not yet expired (its text says
      // "expires <date>"; once past, the next scan raises an expired note) and within the check's N.
      return expired ? on < today : on >= today && on <= addDays(today, input.days ?? 0);
    },
  },
  goal_overdue: { entityType: 'hr_goal', table: 'hr_goals', columns: 'employee_id,status', stillMatches: (r) => r.status !== 'done' },
  leave_waiting: { entityType: 'hr_leave_request', table: 'hr_leave_requests', columns: 'employee_id,status', stillMatches: pending },
  leave_starts_soon: { entityType: 'hr_leave_request', table: 'hr_leave_requests', columns: 'employee_id,status', stillMatches: pending },
  claim_waiting: { entityType: 'hr_claim', table: 'hr_claims', columns: 'employee_id,status', stillMatches: pending },
  overtime_waiting: { entityType: 'hr_overtime_record', table: 'hr_overtime_records', columns: 'employee_id,status', stillMatches: pending },
  letter_draft_stale: { entityType: 'hr_letter', table: 'hr_letters', columns: 'employee_id,status', stillMatches: (r) => r.status === 'draft' },
};

/** The employee is still on the books: their row is there and active. */
async function employeeActive(ctx: PeopleAgentWriteContext, employeeId: string): Promise<Check> {
  const { data, error } = await ctx.client
    .from('hr_employees')
    .select('status')
    .eq('org_id', ctx.orgId)
    .eq('id', employeeId)
    .maybeSingle();
  if (error) return 'unreadable';
  return (data as { status?: string } | null)?.status === 'active' ? 'live' : 'stale';
}

/**
 * Whether the note's target still matches the check that raised it (spec §6, "no longer
 * applies"), read under the approver's session. An inactive or missing employee no longer
 * matches, nor does a record now belonging to someone other than `input.employeeId` (the note
 * goes with that employee, so it must be theirs).
 */
async function stillApplies(ctx: PeopleAgentWriteContext, checkKey: string, input: PeopleAgentNoteInput): Promise<Check> {
  const today = todayInMalaysia(new Date());

  if (checkKey === 'payroll_unpaid') {
    if (input.entityType !== 'hr_payroll_month') return 'unreadable';
    const month = PAYROLL_TARGET.exec(input.target)?.[1];
    if (!month) return 'unreadable';
    const { data, error } = await ctx.client
      .from('hr_payroll_runs')
      .select('status')
      .eq('org_id', ctx.orgId)
      .eq('period_month', `${month}-01`)
      .maybeSingle();
    if (error) return 'unreadable';
    // No run yet still applies; only a paid one settles it.
    return (data as { status?: string } | null)?.status === 'paid' ? 'stale' : 'live';
  }

  const employeeId = input.employeeId;
  if (employeeId === null) return 'unreadable';

  if (checkKey === 'absent_streak') {
    if (input.entityType !== 'hr_employee') return 'unreadable';
    const employee = await employeeActive(ctx, employeeId);
    if (employee !== 'live') return employee;
    const { data, error } = await ctx.client
      .from('hr_attendance_days')
      .select('work_date,status')
      .eq('org_id', ctx.orgId)
      .eq('employee_id', employeeId)
      .order('work_date', { ascending: false })
      .limit(1);
    if (error) return 'unreadable';
    const latest = ((data ?? []) as { status?: string }[])[0];
    return latest?.status === 'absent' ? 'live' : 'stale';
  }

  const spec = Object.hasOwn(RECORD_CHECKS, checkKey) ? RECORD_CHECKS[checkKey] : undefined;
  if (!spec || spec.entityType !== input.entityType || input.entityId === null) return 'unreadable';
  const { data, error } = await ctx.client
    .from(spec.table)
    .select(spec.columns)
    .eq('org_id', ctx.orgId)
    .eq('id', input.entityId)
    .maybeSingle();
  if (error) return 'unreadable';
  if (!data) return 'stale';
  const row = data as unknown as Record<string, unknown>;
  if (row.employee_id !== employeeId || !spec.stillMatches(row, input, today)) return 'stale';
  return employeeActive(ctx, employeeId);
}

/**
 * Leaves the agent's note through the `hr_add_agent_note` RPC, which takes the note's text,
 * record and employee from the approved proposal itself (and refuses unless this owner or admin
 * approved it in the last 10 minutes, once). First re-reads the target under the approver's own
 * session: when it no longer matches its check (renewed, done, decided, issued, back at work,
 * paid, or the person is no longer active) nothing is written and the answer is "This no
 * longer applies." with `stale: true`.
 */
export async function peopleCreateAgentNote(
  ctx: PeopleAgentWriteContext,
  input: PeopleAgentNoteInput,
): Promise<CapResult<{ id: string }>> {
  if (!ctx.proposalId) return { ok: false, error: NOT_ADDED };

  const proposal = await ctx.client
    .from('agent_proposals')
    .select('check_key')
    .eq('org_id', ctx.orgId)
    .eq('id', ctx.proposalId)
    .maybeSingle();
  const checkKey = (proposal.data as { check_key: string | null } | null)?.check_key;
  if (proposal.error || !checkKey) {
    console.error('[people-agent] proposal not read:', proposal.error?.code);
    return { ok: false, error: NOT_ADDED };
  }

  const applies = await stillApplies(ctx, checkKey, input);
  if (applies === 'stale') return { ok: false, error: PEOPLE_NO_LONGER_APPLIES, stale: true };
  if (applies === 'unreadable') return { ok: false, error: NOT_ADDED };

  const { data, error } = await ctx.client.rpc('hr_add_agent_note', {
    target_org: ctx.orgId,
    p_proposal: ctx.proposalId,
  });
  if (error || !data) {
    // The code only: a message could quote the note.
    console.error('[people-agent] note failed:', error?.code);
    return { ok: false, error: NOT_ADDED };
  }
  return { ok: true, data: { id: String(data) } };
}
