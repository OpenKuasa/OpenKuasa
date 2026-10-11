'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import {
  type CapResult,
  type ReachWriteContext,
  createAppointment,
  createAppointmentInput,
  createCampaign,
  createCampaignInput,
  createCreative,
  createCreativeInput,
  createForm,
  createFormInput,
  createLead,
  createLeadInput,
  deleteAppointment,
  deleteAppointmentInput,
  deleteCampaign,
  deleteCampaignInput,
  deleteCreative,
  deleteCreativeInput,
  deleteForm,
  deleteFormInput,
  deleteFormSubmission,
  deleteFormSubmissionInput,
  deleteLead,
  deleteLeadInput,
  promoteLeadToContact,
  promoteLeadToContactInput,
  setAppointmentStatus,
  setAppointmentStatusInput,
  setCampaignStatus,
  setCampaignStatusInput,
  setFormStatus,
  setFormStatusInput,
  setLeadStage,
  setLeadStageInput,
  updateAdSettings,
  updateAdSettingsInput,
  updateAppointment,
  updateAppointmentInput,
  updateCampaign,
  updateCampaignInput,
  updateCreative,
  updateCreativeInput,
  updateForm,
  updateFormInput,
  updateLead,
  updateLeadInput,
} from '@/lib/reach/capabilities';
import {
  setAgentCadence,
  setAgentCadenceInput,
  setAgentCap,
  setAgentCapInput,
  setAgentEnabled,
  setAgentEnabledInput,
} from '@/lib/agents/config';
import {
  cancelSchedule,
  cancelScheduleInput,
  createSchedule,
  createScheduleInput,
  pauseSchedule,
  pauseScheduleInput,
  resumeSchedule,
  resumeScheduleInput,
  setWorkspaceCaps,
  setWorkspaceCapsInput,
  syncCadenceSchedule,
  updateSchedule,
  updateScheduleInput,
} from '@/lib/reach/schedule-capabilities';
import { serviceClient } from '@/lib/supabase/service';
import { runWeeklyStudio } from '@/lib/agents/weekly-studio';
import { runProposalAction } from '@/lib/agents/apply-proposal';
import { RUN_MAX_AGE_MS } from '@/lib/agents/runner';
import { createSupabaseReachData, getReachData } from '@/lib/reach/supabase';
import { FORM_MESSAGES } from '@/lib/reach/forms';
import { leadsToCsv } from '@/lib/reach/csv';
import type { FormSubmission } from '@/lib/reach/types';
import type { ReportRange } from '@/lib/reach/reports';
import type { ZodType } from 'zod';
import { z } from 'zod';

const FORBIDDEN: CapResult<never> = { ok: false, error: 'You do not have permission to make changes here.' };
const INVALID: CapResult<never> = { ok: false, error: 'That input was not valid.' };

/** Resolve a write context after checking the viewer may edit data. */
async function writeCtx(): Promise<(ReachWriteContext & { userId: string }) | null> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'edit-data')) return null;
  const client = await createClient();
  return { client, orgId: viewer.orgId, userId: viewer.userId };
}

/** Parse → guard → capability → revalidate. The screens pass a typed object. */
async function run<I, O>(
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: ReachWriteContext, parsed: I) => Promise<CapResult<O>>,
): Promise<CapResult<O>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return INVALID;
  const result = await fn(ctx, parsed.data);
  if (result.ok) {
    revalidatePath('/reach/ad-studio');
    revalidatePath('/reach/creative-bank');
    revalidatePath('/reach/ad-settings');
  }
  return result;
}

export async function createCampaignAction(input: unknown) {
  return run(createCampaignInput, input, createCampaign);
}
export async function updateCampaignAction(input: unknown) {
  return run(updateCampaignInput, input, updateCampaign);
}
export async function setCampaignStatusAction(input: unknown) {
  return run(setCampaignStatusInput, input, setCampaignStatus);
}
export async function deleteCampaignAction(input: unknown) {
  return run(deleteCampaignInput, input, deleteCampaign);
}
export async function createCreativeAction(input: unknown) {
  return run(createCreativeInput, input, createCreative);
}
export async function updateCreativeAction(input: unknown) {
  return run(updateCreativeInput, input, updateCreative);
}
export async function deleteCreativeAction(input: unknown) {
  return run(deleteCreativeInput, input, deleteCreative);
}

export async function updateAdSettingsAction(input: unknown) {
  return run(updateAdSettingsInput, input, updateAdSettings);
}

// ─── lead forms ──────────────────────────────────────────────────────────────

/** The one screen behind both products' Lead Forms item. */
const LEAD_FORMS_PATHS = ['/reach/lead-forms', '/crm/lead-forms'];

/**
 * Same order as {@link run} (guard → parse → capability → revalidate), but a
 * rejected input answers with the schema's own message, which is written for
 * the person filling the form in, and both Lead Forms routes are refreshed.
 */
async function runForm<I, O>(
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: ReachWriteContext, parsed: I) => Promise<CapResult<O>>,
): Promise<CapResult<O>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That input was not valid.' };
  }
  const result = await fn(ctx, parsed.data);
  if (result.ok) for (const path of LEAD_FORMS_PATHS) revalidatePath(path);
  return result;
}

export async function createFormAction(input: unknown) {
  return runForm(createFormInput, input, createForm);
}
export async function updateFormAction(input: unknown) {
  return runForm(updateFormInput, input, updateForm);
}
export async function setFormStatusAction(input: unknown) {
  return runForm(setFormStatusInput, input, setFormStatus);
}
export async function deleteFormAction(input: unknown) {
  return runForm(deleteFormInput, input, deleteForm);
}

// ─── leads ───────────────────────────────────────────────────────────────────

const LEADS_PATHS = ['/reach/leads'];

/** Same shape as {@link runForm}, refreshing the Leads screen. */
async function runLeads<I, O>(
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: ReachWriteContext, parsed: I) => Promise<CapResult<O>>,
): Promise<CapResult<O>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That input was not valid.' };
  }
  const result = await fn(ctx, parsed.data);
  if (result.ok) for (const path of LEADS_PATHS) revalidatePath(path);
  return result;
}

export async function createLeadAction(input: unknown) {
  return runLeads(createLeadInput, input, createLead);
}
export async function updateLeadAction(input: unknown) {
  return runLeads(updateLeadInput, input, updateLead);
}
export async function setLeadStageAction(input: unknown) {
  return runLeads(setLeadStageInput, input, setLeadStage);
}
export async function deleteLeadAction(input: unknown) {
  return runLeads(deleteLeadInput, input, deleteLead);
}
export async function promoteLeadToContactAction(input: unknown) {
  const r = await runLeads(promoteLeadToContactInput, input, promoteLeadToContact);
  if (r.ok) revalidatePath('/crm/contacts');
  return r;
}

// ─── lead form submissions ───────────────────────────────────────────────────

const listFormSubmissionsInput = z.object({ formId: z.string().uuid() });
const SUBMISSIONS_UNAVAILABLE = 'The submissions could not be loaded. Please try again.';

/**
 * A form's latest submissions, for the panel on the Lead Forms screen. A read,
 * so any member may ask; row-level security decides what comes back.
 */
export async function listFormSubmissionsAction(
  input: unknown,
): Promise<CapResult<FormSubmission[]>> {
  const viewer = await getViewer();
  // The demo and the no-database preview have counts but no stored submissions.
  if (viewer.isDemo) return { ok: true, data: [] };
  const parsed = listFormSubmissionsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: FORM_MESSAGES.gone };
  try {
    const data = createSupabaseReachData(await createClient(), viewer.orgId);
    return { ok: true, data: (await data.listFormSubmissions?.(parsed.data.formId)) ?? [] };
  } catch (error) {
    console.error('[reach-actions] listFormSubmissions failed:', error);
    return { ok: false, error: SUBMISSIONS_UNAVAILABLE };
  }
}

export async function deleteFormSubmissionAction(input: unknown) {
  return runForm(deleteFormSubmissionInput, input, deleteFormSubmission);
}

// ─── appointments ────────────────────────────────────────────────────────────

const APPOINTMENTS_PATHS = ['/reach/appointments', '/crm/appointments'];

/** Same shape as {@link runLeads}, refreshing the Appointments screen. */
async function runAppointments<I, O>(
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: ReachWriteContext, parsed: I) => Promise<CapResult<O>>,
): Promise<CapResult<O>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That input was not valid.' };
  }
  const result = await fn(ctx, parsed.data);
  if (result.ok) for (const path of APPOINTMENTS_PATHS) revalidatePath(path);
  return result;
}

export async function createAppointmentAction(input: unknown) {
  return runAppointments(createAppointmentInput, input, createAppointment);
}
export async function updateAppointmentAction(input: unknown) {
  return runAppointments(updateAppointmentInput, input, updateAppointment);
}
export async function setAppointmentStatusAction(input: unknown) {
  return runAppointments(setAppointmentStatusInput, input, setAppointmentStatus);
}
export async function deleteAppointmentAction(input: unknown) {
  return runAppointments(deleteAppointmentInput, input, deleteAppointment);
}

// ─── agents ──────────────────────────────────────────────────────────────────

/** The Agents screen is Reach-only: crm/finance map to their own components. */
const AGENTS_PATHS = ['/reach/agents'];

/** Same shape as {@link runLeads}, refreshing the Agents screen. */
async function runAgentConfig<I, O>(
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: ReachWriteContext, parsed: I) => Promise<CapResult<O>>,
): Promise<CapResult<O>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That input was not valid.' };
  }
  const result = await fn(ctx, parsed.data);
  if (result.ok) for (const path of AGENTS_PATHS) revalidatePath(path);
  return result;
}

export async function setAgentEnabledAction(input: unknown) {
  return runAgentConfig(setAgentEnabledInput, input, setAgentEnabled);
}
export async function setAgentCadenceAction(input: unknown) {
  // The dropdown also drives the schedule table (the runner reads only that).
  return runAgentConfig(setAgentCadenceInput, input, async (ctx, parsed) => {
    const result = await setAgentCadence(ctx, parsed);
    if (!result.ok) return result;
    const synced = await syncCadenceSchedule(ctx, parsed.cadence);
    return synced.ok ? result : { ok: false, error: synced.error };
  });
}
export async function setAgentCapAction(input: unknown) {
  return runAgentConfig(setAgentCapInput, input, setAgentCap);
}

/** Same shape as {@link runAgentConfig}, for schedules + workspace caps. */
async function runSchedule<I, O>(
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: ReachWriteContext, parsed: I) => Promise<CapResult<O>>,
): Promise<CapResult<O>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return INVALID;
  const result = await fn(ctx, parsed.data);
  if (result.ok) for (const path of AGENTS_PATHS) revalidatePath(path);
  return result;
}

export async function createScheduleAction(input: unknown) {
  return runSchedule(createScheduleInput, input, createSchedule);
}
export async function updateScheduleAction(input: unknown) {
  return runSchedule(updateScheduleInput, input, updateSchedule);
}
export async function pauseScheduleAction(input: unknown) {
  return runSchedule(pauseScheduleInput, input, pauseSchedule);
}
export async function resumeScheduleAction(input: unknown) {
  return runSchedule(resumeScheduleInput, input, resumeSchedule);
}
export async function cancelScheduleAction(input: unknown) {
  return runSchedule(cancelScheduleInput, input, cancelSchedule);
}
export async function setWorkspaceCapsAction(input: unknown) {
  return runSchedule(setWorkspaceCapsInput, input, setWorkspaceCaps);
}

/**
 * Manual "Run now". The viewer gate (writer only) is the authorization; the
 * org comes from the authenticated viewer, never from input. agent_runs and
 * agent_run_assets have no authenticated write grant, so the service client
 * is the writer.
 */
export async function runAgentNowAction(
  input?: unknown,
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  void input; // deliberately ignored: nothing the caller sends may pick the org
  const ctx = await writeCtx();
  if (!ctx) return { ok: false, error: 'You do not have permission to make changes here.' };
  const service = serviceClient();
  try {
    // Throttle: one manual run at a time per org. A run older than RUN_MAX_AGE_MS
    // is treated as dead (reaped by the poll cron), so a stuck run never blocks
    // forever. The window keeps a stale row from permanently locking Run now.
    const since = new Date(Date.now() - RUN_MAX_AGE_MS).toISOString();
    const { data: inflight } = await service
      .from('agent_runs')
      .select('id')
      .eq('org_id', ctx.orgId)
      .eq('status', 'running')
      .gte('started_at', since)
      .limit(1)
      .maybeSingle();
    if (inflight) {
      return { ok: false, error: 'A run is already in progress. Please wait for it to finish.' };
    }
    const result = await runWeeklyStudio(service, ctx.orgId, 'manual');
    for (const path of AGENTS_PATHS) revalidatePath(path);
    return { ok: true, runId: result.runId };
  } catch {
    return { ok: false, error: 'The run could not be started.' };
  }
}

export async function exportLeadsCsv(
  range: ReportRange,
): Promise<{ ok: true; filename: string; csv: string } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (!viewer.orgId) return { ok: false, error: 'Please sign in to export.' };
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
  if (!days) return { ok: false, error: 'That range is not valid.' };
  const supabase = await createClient();
  const leads = await (await getReachData(supabase)).listLeads();
  const cutoff = Date.now() - days * 86_400_000;
  const inRange = leads.filter((l) => new Date(l.created_at).getTime() >= cutoff);
  const stamp = new Date().toISOString().slice(0, 10);
  return { ok: true, filename: `leads-${range}-${stamp}.csv`, csv: leadsToCsv(inRange) };
}

const proposalIdInput = z.object({ id: z.string().uuid() });

/**
 * Approve a queued proposal, claim-first: atomically flip pending -> approved (pending and
 * unexpired only), and only the caller that wins the claim runs the reach capability, under
 * the OWNER's session (never the service-role worker). Postgres serializes concurrent
 * approvals on the row, so the change is applied exactly once. If the capability fails
 * after the claim, the row is corrected approved -> failed with the error.
 */
export async function applyProposalAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const parsed = proposalIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That input was not valid.' };
  const ctx = await writeCtx();
  if (!ctx) return { ok: false, error: 'You do not have permission to make changes here.' };
  const { data: claimed } = await ctx.client
    .from('agent_proposals')
    .update({ status: 'approved', decided_at: new Date().toISOString(), decided_by: ctx.userId })
    .eq('id', parsed.data.id)
    .eq('org_id', ctx.orgId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .select('action, input')
    .maybeSingle();
  if (!claimed) return { ok: false, error: 'That suggestion has already been handled.' };
  const applied = await runProposalAction(ctx, claimed.action as string, claimed.input);
  if (!applied.ok) {
    await ctx.client
      .from('agent_proposals')
      .update({ status: 'failed', result: { error: applied.error } as never })
      .eq('id', parsed.data.id)
      .eq('org_id', ctx.orgId);
    for (const path of AGENTS_PATHS) revalidatePath(path);
    return { ok: false, error: 'The change could not be applied.' };
  }
  // Record what the apply produced on the now-approved row (informational, best-effort:
  // the change already landed, so a failed stamp must not fail the action).
  try {
    await ctx.client
      .from('agent_proposals')
      .update({ result: applied.result as never })
      .eq('id', parsed.data.id)
      .eq('org_id', ctx.orgId);
  } catch (e) {
    // the apply succeeded; the result column is informational. Log for ops only.
    console.error('[agent-proposals] result stamp failed', e);
  }
  for (const path of AGENTS_PATHS) revalidatePath(path);
  return { ok: true };
}

/** Reject a queued proposal: mark it rejected, apply nothing. */
export async function rejectProposalAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const parsed = proposalIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That input was not valid.' };
  const ctx = await writeCtx();
  if (!ctx) return { ok: false, error: 'You do not have permission to make changes here.' };
  const { data } = await ctx.client
    .from('agent_proposals')
    .update({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: ctx.userId })
    .eq('id', parsed.data.id)
    .eq('org_id', ctx.orgId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  for (const path of AGENTS_PATHS) revalidatePath(path);
  return data ? { ok: true } : { ok: false, error: 'That suggestion has already been handled.' };
}
