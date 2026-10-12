// src/lib/hire/capabilities.ts
/**
 * The single write path for Lekir's hiring data. Each change is one Zod schema
 * and one function; the AI tool's inputSchema IS the schema and the server
 * action parses with it, so the two cannot accept different things. org_id
 * always comes from the HireWriteContext (the caller's session), never the input.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { REJECT_REASONS, changeMessage, type RejectReason } from './application-changes';
import { CANDIDATE_LIMITS, addedMessage, candidateMessage } from './candidate-fields';
import { isInPool, isPoolStatus, movedMessage, poolChangedMessage, poolRefusal } from './pool';
import {
  DELETE_FAILED, SUMMARY_FAILED, deletedMessage, deletionMessage, type DeletionKind, type Removal,
} from './deletion';
import {
  APPLICATION_STAGES, DEFAULT_HIRE_SETTINGS, JOB_COLUMNS, SETTINGS_COLUMNS,
  type ApplicationOutcome, type ApplicationStage, type HireSettings, type Job, type JobStatus, type PoolStatus,
} from './types';

export type HireWriteContext = { client: SupabaseClient; orgId: string };
export type CapResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const JOB_NOT_FOUND = 'That job could not be found.';
export const JOB_HAS_APPLICATIONS = 'This job has applications. Close it instead.';
export const JOB_NEEDS_DESCRIPTION = 'Add a description before opening this job.';
export const JOB_LIVE_NEEDS_DESCRIPTION = 'An open or paused job needs a description.';
export const SALARY_RANGE = 'Maximum salary can\'t be lower than the minimum.';
export const CLOSES_IN_PAST = 'The closing date can\'t be in the past.';
const NOT_A_REAL_DATE = 'Use a real date, like 2026-10-31.';
const WRITE_FAILED = 'That change could not be saved. Please try again.';

/** Logs the DB error for triage; callers only ever see the generic user-facing message. */
function writeFailed(fnName: string, error: unknown): { ok: false; error: string } {
  console.error(`[hire-capability] ${fnName} failed:`, error);
  return { ok: false, error: WRITE_FAILED };
}

const employmentType = z.enum(['full_time', 'part_time', 'contract', 'internship']);
const workArrangement = z.enum(['onsite', 'hybrid', 'remote']);
/**
 * Text that may be cleared. No transform here: these schemas are also the AI
 * tools' input schemas, and a transform cannot be turned into JSON Schema. A
 * blank value is turned into null by `blankToNull` in the functions below.
 */
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
/** '' becomes null; undefined ("not sent") stays undefined. */
const blankToNull = (value: string | null | undefined) => (value === undefined ? undefined : value ? value : null);
const cents = z.number().int().min(0).max(10_000_000_00).nullable().optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-31.').nullable().optional();

const jobFields = {
  title: z.string().trim().min(1, 'Give the job a title.').max(120, 'Keep the title under 120 characters.')
    .describe('The job title, for example "Sales Executive".'),
  department: optionalText(80).describe('The department, for example "Sales".'),
  location: optionalText(120).describe('Where the job is based.'),
  employment_type: employmentType.describe('full_time, part_time, contract or internship.'),
  work_arrangement: workArrangement.nullable().optional().describe('onsite, hybrid or remote.'),
  description: optionalText(10_000).describe('The job description, as plain text.'),
  salary_min_cents: cents.describe('Lowest monthly salary in sen (RM 3,000 is 300000).'),
  salary_max_cents: cents.describe('Highest monthly salary in sen.'),
  show_salary: z.boolean().describe('Whether a public job page may show the salary range.'),
  closes_on: isoDate.describe('Last day to apply, as YYYY-MM-DD.'),
  headcount: z.number().int().min(1, 'Headcount must be at least 1.').max(999).describe('How many people to hire.'),
};

export const createJobInput = z.object({
  ...jobFields,
  employment_type: jobFields.employment_type.default('full_time'),
  show_salary: jobFields.show_salary.default(false),
  headcount: jobFields.headcount.default(1),
});
/**
 * What a made-up id is answered with. The assistant's tools check their input against these schemas before
 * anything else runs, so this is all a model is told when it invents an id: it has to say where a real one
 * comes from. No screen can send one (they pass ids the page was given). The id itself is not repeated.
 */
const NOT_A_JOB_ID = 'That is not a job\'s id. Look the job up with listJobs and use the id it returns. Never make one up.';
const NOT_AN_APPLICATION_ID =
  'That is not an application\'s id. Look it up with listApplications and use the id it returns. Never make one up.';
const NOT_A_CANDIDATE_ID =
  'That is not a candidate\'s id. Look the person up with listCandidates and use the id it returns. Never make one up.';
const NOT_A_LOOKED_UP_ID =
  'That is not an id from a lookup. Look it up with listApplications or listCandidates and use the id it returns. Never make one up.';

export const updateJobInput = z.object({
  id: z.string().uuid(NOT_A_JOB_ID).describe('The job\'s id, from listJobs.'),
  title: jobFields.title.optional(),
  department: jobFields.department,
  location: jobFields.location,
  employment_type: jobFields.employment_type.optional(),
  work_arrangement: jobFields.work_arrangement,
  description: jobFields.description,
  salary_min_cents: jobFields.salary_min_cents,
  salary_max_cents: jobFields.salary_max_cents,
  show_salary: jobFields.show_salary.optional(),
  closes_on: jobFields.closes_on,
  headcount: jobFields.headcount.optional(),
});
export const setJobStatusInput = z.object({
  id: z.string().uuid(NOT_A_JOB_ID).describe('The job\'s id, from listJobs.'),
  status: z.enum(['open', 'paused', 'closed']).describe('open, paused or closed.'),
});
export const deleteJobInput = z.object({ id: z.string().uuid(NOT_A_JOB_ID).describe('The job\'s id, from listJobs.') });

/** Today's date in Kuala Lumpur, as YYYY-MM-DD. */
const klToday = (now: Date) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });

/** The first message of a failed parse, written for the person who typed the input. */
function invalid(error: z.ZodError): { ok: false; error: string } {
  return { ok: false, error: error.issues[0]?.message ?? 'That input was not valid.' };
}

function ruleError(
  fields: Pick<Job, 'salary_min_cents' | 'salary_max_cents' | 'closes_on'>,
  now: Date,
  checkDate: boolean,
): string | null {
  const { salary_min_cents: min, salary_max_cents: max, closes_on } = fields;
  if (min !== null && max !== null && max < min) return SALARY_RANGE;
  if (checkDate && closes_on) {
    // Before the past check: "2026-02-31" would otherwise only fail at the database, with the generic line.
    if (!isRealDate(closes_on)) return NOT_A_REAL_DATE;
    if (closes_on < klToday(now)) return CLOSES_IN_PAST;
  }
  return null;
}

/** Whether a YYYY-MM-DD string names a day that exists: 31 February and month 13 do not. */
function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  // Some dates that do not exist roll over to a later day, others do not parse at all.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

type Lookup = { state: 'found'; job: Job } | { state: 'missing' } | { state: 'failed'; error: string };

async function findJob(ctx: HireWriteContext, id: string, fnName: string): Promise<Lookup> {
  const { data, error } = await ctx.client
    .from('hire_jobs')
    .select(JOB_COLUMNS)
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .maybeSingle();
  if (error) return { state: 'failed', error: writeFailed(fnName, error).error };
  return data ? { state: 'found', job: data as unknown as Job } : { state: 'missing' };
}

export async function createJob(
  ctx: HireWriteContext,
  input: z.input<typeof createJobInput>,
  now: Date = new Date(),
): Promise<CapResult<Job>> {
  const parsed = createJobInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const values = {
    title: parsed.data.title,
    department: blankToNull(parsed.data.department) ?? null,
    location: blankToNull(parsed.data.location) ?? null,
    employment_type: parsed.data.employment_type,
    work_arrangement: parsed.data.work_arrangement ?? null,
    description: blankToNull(parsed.data.description) ?? null,
    salary_min_cents: parsed.data.salary_min_cents ?? null,
    salary_max_cents: parsed.data.salary_max_cents ?? null,
    show_salary: parsed.data.show_salary,
    closes_on: parsed.data.closes_on ?? null,
    headcount: parsed.data.headcount,
  };
  const broken = ruleError(values, now, true);
  if (broken) return { ok: false, error: broken };
  const { data, error } = await ctx.client
    .from('hire_jobs')
    // A new job is always a draft: nothing goes live without a deliberate open.
    .insert({ ...values, status: 'draft', org_id: ctx.orgId })
    .select(JOB_COLUMNS)
    .single();
  if (error || !data) return writeFailed('createJob', error);
  return { ok: true, data: data as unknown as Job };
}

export async function updateJob(
  ctx: HireWriteContext,
  input: z.input<typeof updateJobInput>,
  now: Date = new Date(),
): Promise<CapResult<Job>> {
  const parsed = updateJobInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id, ...sent } = parsed.data;
  const given = {
    ...sent,
    department: blankToNull(sent.department),
    location: blankToNull(sent.location),
    description: blankToNull(sent.description),
  };
  const found = await findJob(ctx, id, 'updateJob');
  if (found.state === 'failed') return { ok: false, error: found.error };
  if (found.state === 'missing') return { ok: false, error: JOB_NOT_FOUND };
  const current = found.job;

  // Only the fields the caller sent; undefined means "leave as it is".
  const patch = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) as Partial<Job>;
  const merged = { ...current, ...patch };
  // A stored closing date that has since passed is not this edit's mistake:
  // the date rule only applies when the date actually changes.
  const dateChanged = 'closes_on' in patch && patch.closes_on !== current.closes_on;
  const broken = ruleError(merged, now, dateChanged);
  if (broken) return { ok: false, error: broken };
  if ((current.status === 'open' || current.status === 'paused') && 'description' in patch && !merged.description) {
    return { ok: false, error: JOB_LIVE_NEEDS_DESCRIPTION };
  }
  if (Object.keys(patch).length === 0) return { ok: true, data: current };

  const { data, error } = await ctx.client
    .from('hire_jobs')
    .update(patch)
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select(JOB_COLUMNS)
    .single();
  if (error || !data) return writeFailed('updateJob', error);
  return { ok: true, data: data as unknown as Job };
}

const MOVES: Record<JobStatus, JobStatus[]> = {
  draft: ['open'],
  open: ['paused', 'closed'],
  paused: ['open', 'closed'],
  closed: ['open'],
};
const STATUS_WORD: Record<JobStatus, string> = { draft: 'a draft', open: 'open', paused: 'paused', closed: 'closed' };

export async function setJobStatus(
  ctx: HireWriteContext,
  input: z.input<typeof setJobStatusInput>,
  now: Date = new Date(),
): Promise<CapResult<Job>> {
  const parsed = setJobStatusInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id, status } = parsed.data;
  const found = await findJob(ctx, id, 'setJobStatus');
  if (found.state === 'failed') return { ok: false, error: found.error };
  if (found.state === 'missing') return { ok: false, error: JOB_NOT_FOUND };
  const current = found.job;
  if (current.status === status) return { ok: true, data: current };
  if (!MOVES[current.status].includes(status)) {
    const allowed = MOVES[current.status].join(' or ');
    return { ok: false, error: `This job is ${STATUS_WORD[current.status]}. It can only be moved to ${allowed}.` };
  }
  if (status === 'open' && !current.description?.trim()) return { ok: false, error: JOB_NEEDS_DESCRIPTION };

  const stamp = now.toISOString();
  const patch: Partial<Job> = { status };
  if (status === 'open') {
    patch.opened_at = current.opened_at ?? stamp;
    patch.closed_at = null;
  }
  if (status === 'closed') patch.closed_at = stamp;

  const { data, error } = await ctx.client
    .from('hire_jobs')
    .update(patch)
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select(JOB_COLUMNS)
    .single();
  if (error || !data) return writeFailed('setJobStatus', error);
  return { ok: true, data: data as unknown as Job };
}

export async function deleteJob(
  ctx: HireWriteContext,
  input: z.input<typeof deleteJobInput>,
): Promise<CapResult<{ id: string; title: string }>> {
  const parsed = deleteJobInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const found = await findJob(ctx, parsed.data.id, 'deleteJob');
  if (found.state === 'failed') return { ok: false, error: found.error };
  if (found.state === 'missing') return { ok: false, error: JOB_NOT_FOUND };
  const current = found.job;

  const { count, error: countError } = await ctx.client
    .from('hire_applications')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', ctx.orgId)
    .eq('job_id', current.id);
  if (countError) return writeFailed('deleteJob', countError);
  if ((count ?? 0) > 0) return { ok: false, error: JOB_HAS_APPLICATIONS };

  const { error } = await ctx.client.from('hire_jobs').delete().eq('id', current.id).eq('org_id', ctx.orgId);
  if (error) return writeFailed('deleteJob', error);
  return { ok: true, data: { id: current.id, title: current.title } };
}

// ─── careers page (one settings row per workspace) ───────────────────────────

export const CAREERS_DEMO = 'The demo workspace cannot have a public careers page.';
const DEMO_SLUG = 'rimba-ventures-demo';

export const updateCareersPageInput = z.object({
  careers_enabled: z.boolean().optional()
    .describe('true turns the public careers page on: open jobs become visible to anyone with the link. false turns it off.'),
  careers_headline: z.string().trim().max(80, 'Keep the headline under 80 characters.').nullable().optional()
    .describe('The headline at the top of the public careers page. Blank clears it.'),
  careers_tagline: z.string().trim().max(160, 'Keep the tagline under 160 characters.').nullable().optional()
    .describe('One line under the headline. Blank clears it.'),
});

const asSettings = (orgId: string, row: unknown): HireSettings =>
  ({ org_id: orgId, ...DEFAULT_HIRE_SETTINGS, ...((row ?? {}) as Partial<HireSettings>) });

/** The settings row as it stands, or the defaults when there is none. */
async function readSettings(ctx: HireWriteContext, fnName: string): Promise<CapResult<HireSettings>> {
  const { data, error } = await ctx.client
    .from('hire_settings').select(SETTINGS_COLUMNS).eq('org_id', ctx.orgId).maybeSingle();
  if (error) return writeFailed(fnName, error);
  return { ok: true, data: asSettings(ctx.orgId, data) };
}

/**
 * Writes some columns of the workspace's settings row, making the row if
 * there is none. Not an upsert: the update grant leaves out org_id, which an
 * upsert's "do update" would set. A new row takes the column defaults for
 * everything not in the patch, so the board stays off.
 */
async function saveSettings(
  ctx: HireWriteContext, patch: Record<string, unknown>, now: Date, fnName: string,
): Promise<CapResult<HireSettings>> {
  const update = () =>
    ctx.client.from('hire_settings')
      .update({ ...patch, updated_at: now.toISOString() })
      .eq('org_id', ctx.orgId).select(SETTINGS_COLUMNS).maybeSingle();

  const first = await update();
  if (first.error) return writeFailed(fnName, first.error);
  if (first.data) return { ok: true, data: asSettings(ctx.orgId, first.data) };

  const inserted = await ctx.client.from('hire_settings')
    .insert({ ...patch, org_id: ctx.orgId }).select(SETTINGS_COLUMNS).single();
  if (!inserted.error && inserted.data) return { ok: true, data: asSettings(ctx.orgId, inserted.data) };
  // Someone else made the row between the two calls: update it after all.
  if ((inserted.error as { code?: string } | null)?.code !== '23505') return writeFailed(fnName, inserted.error);
  const second = await update();
  if (second.error || !second.data) return writeFailed(fnName, second.error);
  return { ok: true, data: asSettings(ctx.orgId, second.data) };
}

export async function updateCareersPage(
  ctx: HireWriteContext,
  input: z.input<typeof updateCareersPageInput>,
  now: Date = new Date(),
): Promise<CapResult<HireSettings>> {
  const parsed = updateCareersPageInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const given = {
    careers_enabled: parsed.data.careers_enabled,
    careers_headline: blankToNull(parsed.data.careers_headline),
    careers_tagline: blankToNull(parsed.data.careers_tagline),
  };
  const patch = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));

  if (Object.keys(patch).length === 0) return readSettings(ctx, 'updateCareersPage');

  if (patch.careers_enabled === true) {
    const { data: org, error } = await ctx.client.from('orgs').select('slug').eq('id', ctx.orgId).maybeSingle();
    // No row is not "not the demo": without knowing which workspace this is, nothing goes public.
    if (error || !org) return writeFailed('updateCareersPage', error ?? 'workspace not readable');
    if ((org as { slug?: string | null }).slug === DEMO_SLUG) return { ok: false, error: CAREERS_DEMO };
  }

  return saveSettings(ctx, patch, now, 'updateCareersPage');
}

// ─── application form (four switches on the same settings row) ───────────────

const formSwitch = (what: string) => z.boolean().optional().describe(what);

export const updateApplicationFormInput = z.object({
  require_cv: formSwitch('true makes a CV (a link or a file) required on applications; false makes it optional.'),
  require_cover_letter: formSwitch('true makes a cover letter required on applications; false removes that.'),
  ask_portfolio: formSwitch('true adds an optional portfolio link to the application form; false removes it.'),
  ask_expected_salary: formSwitch('true adds an optional expected monthly salary (RM) to the application form; false removes it.'),
});

export async function updateApplicationForm(
  ctx: HireWriteContext,
  input: z.input<typeof updateApplicationFormInput>,
  now: Date = new Date(),
): Promise<CapResult<HireSettings>> {
  const parsed = updateApplicationFormInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  // Only the switches the caller sent; undefined means "leave as it is".
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  if (Object.keys(patch).length === 0) return readSettings(ctx, 'updateApplicationForm');
  return saveSettings(ctx, patch, now, 'updateApplicationForm');
}

// ─── changing an application (four database functions, called by rpc) ────────

const applicationId = () => z.string().uuid(NOT_AN_APPLICATION_ID).describe('The application\'s id, from listApplications.');

export const moveApplicationInput = z.object({
  id: applicationId(),
  stage: z.enum(APPLICATION_STAGES).describe('The stage to move to: applied, screening, interview, offer or hired. Forward to any later stage, or back one stage.'),
});
export const closeApplicationInput = z.object({
  id: applicationId(),
  outcome: z.enum(['rejected', 'withdrawn']).describe('rejected when the company turns the candidate down; withdrawn when the candidate pulls out.'),
  reason: z.enum(REJECT_REASONS).nullable().optional().describe('Why, when known: skills, experience, salary, role_filled, not_reachable or other. Leave out when not known.'),
});
export const reopenApplicationInput = z.object({ id: applicationId() });
export const rateApplicationInput = z.object({
  id: applicationId(),
  rating: z.number().int().min(1).max(5).nullable().describe('A whole number from 1 to 5, or null to clear the rating.'),
  // For the person who approves: the capability does not read it, and it is never sent to the database.
  basis: z.string().trim().max(500).optional().describe('One or two sentences giving the grounds for this rating, in plain words, taken from the CV or from what the user said, naming specifics (an employer, the years, a number, a skill) and never general praise. Shown on the Approve card. Not stored.'),
});

export type ApplicationChange = {
  id: string;
  candidate: string;
  job: string;
  /** Null when the change was saved but the row could not be read back and the change does not say. */
  stage: ApplicationStage | null;
  outcome: ApplicationOutcome | null;
  rating: number | null;
  reject_reason: RejectReason | null;
  /** True when these values were read back after the change; false when they are only what the change implies. */
  confirmed: boolean;
  /** Only when the row could not be read back: says so, in words for whoever reads the result. */
  note?: string;
};

const NOT_READ_BACK = 'Saved. The application could not be read back, so some details are not shown.';

/** Logs the error's code only (never the error, an id or a name) and answers with the generic sentence. */
function changeFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const code = (error as { code?: unknown } | null)?.code ?? (error as { name?: unknown } | null)?.name;
  console.error(`[hire-capability] ${fnName} failed:`, { code: typeof code === 'string' ? code : undefined });
  return { ok: false, error: WRITE_FAILED };
}

type ChangeRow = {
  id: string; stage: ApplicationStage; outcome: ApplicationOutcome; rating: number | null;
  reject_reason: RejectReason | null; candidate: { name: string } | null; job: { title: string } | null;
};

/**
 * Calls one database function, then reads the row back. The change is saved
 * once the function says ok, so a failed read-back still answers ok with what
 * the input implies (the stage is only known for a move) and empty names.
 */
async function applicationChange(
  ctx: HireWriteContext,
  fnName: string,
  fn: string,
  args: Record<string, unknown>,
  id: string,
  implied: Partial<Omit<ApplicationChange, 'confirmed' | 'note'>>,
): Promise<CapResult<ApplicationChange>> {
  let word: unknown;
  try {
    const { data, error } = await ctx.client.rpc(fn, args);
    if (error) return changeFailed(fnName, error);
    word = data;
  } catch (error) {
    return changeFailed(fnName, error);
  }
  if (word !== 'ok') return { ok: false, error: changeMessage(word) };
  const fallback: ApplicationChange = {
    // Only what the change itself implies: a guessed stage or outcome would be told to the user as fact.
    id, candidate: '', job: '', stage: null, outcome: null, rating: null, reject_reason: null, ...implied, confirmed: false,
    note: NOT_READ_BACK,
  };
  try {
    const { data } = await ctx.client
      .from('hire_applications')
      .select('id,stage,outcome,rating,reject_reason,candidate:hire_candidates(name),job:hire_jobs(title)')
      .eq('id', id)
      .eq('org_id', ctx.orgId)
      .maybeSingle();
    const row = data as unknown as ChangeRow | null;
    if (!row) return { ok: true, data: fallback };
    return {
      ok: true,
      data: {
        id: row.id, candidate: row.candidate?.name ?? '', job: row.job?.title ?? '', stage: row.stage,
        outcome: row.outcome, rating: row.rating, reject_reason: row.reject_reason, confirmed: true,
      },
    };
  } catch {
    return { ok: true, data: fallback };
  }
}

export async function moveApplication(
  ctx: HireWriteContext,
  input: z.input<typeof moveApplicationInput>,
): Promise<CapResult<ApplicationChange>> {
  const parsed = moveApplicationInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id, stage } = parsed.data;
  return applicationChange(ctx, 'moveApplication', 'hire_move_application', { p_application_id: id, p_stage: stage }, id, { stage, outcome: 'active' });
}

export async function closeApplication(
  ctx: HireWriteContext,
  input: z.input<typeof closeApplicationInput>,
): Promise<CapResult<ApplicationChange>> {
  const parsed = closeApplicationInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id, outcome } = parsed.data;
  const reason = parsed.data.reason ?? null;
  return applicationChange(
    ctx, 'closeApplication', 'hire_close_application',
    { p_application_id: id, p_outcome: outcome, p_reason: reason }, id, { outcome, reject_reason: reason },
  );
}

export async function reopenApplication(
  ctx: HireWriteContext,
  input: z.input<typeof reopenApplicationInput>,
): Promise<CapResult<ApplicationChange>> {
  const parsed = reopenApplicationInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id } = parsed.data;
  return applicationChange(ctx, 'reopenApplication', 'hire_reopen_application', { p_application_id: id }, id, { outcome: 'active' });
}

export async function rateApplication(
  ctx: HireWriteContext,
  input: z.input<typeof rateApplicationInput>,
): Promise<CapResult<ApplicationChange>> {
  const parsed = rateApplicationInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  // `basis` is left behind here: it is for the Approve card, not for the database.
  const { id, rating } = parsed.data;
  return applicationChange(ctx, 'rateApplication', 'hire_rate_application', { p_application_id: id, p_rating: rating }, id, { rating });
}

// ─── adding and editing a candidate by hand (database functions, called by rpc) ──

const text = (max: number, what: string) => optionalText(max).describe(what);

/** The optional details. A new candidate has nothing to clear, so only an edit is told that a blank clears. */
const candidateFields = (forEdit: boolean) => {
  const one = forEdit ? 'Leave out to keep it as it is. Blank clears it.' : 'Leave out when not known.';
  const many = forEdit ? 'Leave out to keep them as they are. An empty list clears them.' : 'Leave out when not known.';
  return {
    email: text(CANDIDATE_LIMITS.email, `The candidate's email address. ${one}`),
    phone: text(CANDIDATE_LIMITS.phone, `The candidate's phone number. ${one}`),
    headline: text(CANDIDATE_LIMITS.headline, `A short line about the candidate, for example "Barista with 3 years in cafes". ${one}`),
    location: text(CANDIDATE_LIMITS.location, `Where the candidate is based. ${one}`),
    // One skill to an entry. The forms hold skills as one comma-separated line, so a comma inside a skill
    // would be read back as two. A refine and not a pattern: the JSON Schema a model is given stays as it was.
    skills: z.array(
      z.string().trim().min(1).max(CANDIDATE_LIMITS.skill).refine((skill) => !skill.includes(','), 'A skill cannot contain a comma.'),
    ).max(CANDIDATE_LIMITS.skills).optional()
      .describe(`Up to 20 skills, each up to 40 characters, as stated by the user or in the CV. ${many}`),
    source: text(CANDIDATE_LIMITS.source, `Where the candidate came from, for example "Referral". ${one}`),
  };
};

export const addCandidateInput = z.object({
  name: z.string().trim().min(1, 'Enter the candidate\'s name.').max(CANDIDATE_LIMITS.name, 'Keep the name to 120 characters or fewer.')
    .describe('The candidate\'s full name.'),
  ...candidateFields(false),
  job_id: z.string().uuid(NOT_A_JOB_ID).nullable().optional()
    .describe('The job to add an application for, from listJobs. Leave out to add the person without an application.'),
  cover_letter: text(CANDIDATE_LIMITS.coverLetter, 'A cover note for the application. Only kept when a job is given. Leave out when there is none.'),
  cv_url: text(CANDIDATE_LIMITS.url, 'A link to the candidate\'s CV, starting with https://. Only kept when a job is given. Leave out when there is none.'),
});

export const updateCandidateInput = z.object({
  id: z.string().uuid(NOT_A_CANDIDATE_ID).describe('The candidate\'s id, from listCandidates.'),
  name: z.string().trim().min(1, 'Enter the candidate\'s name.').max(CANDIDATE_LIMITS.name, 'Keep the name to 120 characters or fewer.')
    .optional().describe('The candidate\'s full name. Cannot be cleared.'),
  ...candidateFields(true),
});

export type CandidateAdded = {
  id: string;
  name: string;
  application_id: string | null;
  job_id: string | null;
  job: string | null;
  candidate: 'created' | 'existing';
  application: 'created' | 'existing' | 'none';
  message: string;
};

/** The word a jsonb answer carries as `word`, or the answer itself when it is a bare string. */
function wordOf(data: unknown): unknown {
  if (data && typeof data === 'object') return (data as { word?: unknown }).word;
  return data;
}

/** One text column of a row of this workspace, or null when it cannot be read. */
async function readColumn(ctx: HireWriteContext, table: string, column: string, id: string): Promise<string | null> {
  try {
    const { data } = await ctx.client.from(table).select(column).eq('id', id).eq('org_id', ctx.orgId).maybeSingle();
    const value = (data as unknown as Record<string, unknown> | null)?.[column];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export async function addCandidate(
  ctx: HireWriteContext,
  input: z.input<typeof addCandidateInput>,
): Promise<CapResult<CandidateAdded>> {
  const parsed = addCandidateInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const d = parsed.data;
  const jobId = d.job_id ?? null;
  let answer: unknown;
  try {
    const { data, error } = await ctx.client.rpc('hire_add_candidate', {
      p_org_id: ctx.orgId,
      p_name: d.name,
      p_email: blankToNull(d.email) ?? null,
      p_phone: blankToNull(d.phone) ?? null,
      p_headline: blankToNull(d.headline) ?? null,
      p_location: blankToNull(d.location) ?? null,
      p_skills: d.skills ?? [],
      p_source: blankToNull(d.source) ?? null,
      p_job_id: jobId,
      p_cover_letter: blankToNull(d.cover_letter) ?? null,
      p_cv_url: blankToNull(d.cv_url) ?? null,
    });
    if (error) return changeFailed('addCandidate', error);
    answer = data;
  } catch (error) {
    return changeFailed('addCandidate', error);
  }
  const word = wordOf(answer);
  if (word !== 'ok') return { ok: false, error: candidateMessage(word) };

  const result = answer as { candidate_id?: unknown; application_id?: unknown; candidate?: unknown; application?: unknown };
  if (typeof result.candidate_id !== 'string') return changeFailed('addCandidate', null);
  const candidate = result.candidate === 'existing' ? 'existing' : 'created';
  const application = result.application === 'created' || result.application === 'existing' ? result.application : 'none';
  const name = (await readColumn(ctx, 'hire_candidates', 'name', result.candidate_id)) ?? d.name;
  const job = jobId ? await readColumn(ctx, 'hire_jobs', 'title', jobId) : null;
  return {
    ok: true,
    data: {
      id: result.candidate_id,
      name,
      application_id: typeof result.application_id === 'string' ? result.application_id : null,
      job_id: application === 'none' ? null : jobId,
      job: application === 'none' ? null : job,
      candidate,
      application,
      message: addedMessage({ name, job, candidate, application }),
    },
  };
}

export async function updateCandidate(
  ctx: HireWriteContext,
  input: z.input<typeof updateCandidateInput>,
): Promise<CapResult<{ id: string; name: string }>> {
  const parsed = updateCandidateInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id, name, skills, ...rest } = parsed.data;
  // Only what was sent: undefined is left out; '' and null are sent as null (a cleared field).
  const given: Record<string, unknown> = {
    name,
    email: blankToNull(rest.email),
    phone: blankToNull(rest.phone),
    headline: blankToNull(rest.headline),
    location: blankToNull(rest.location),
    skills,
    source: blankToNull(rest.source),
  };
  const changes = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
  if (Object.keys(changes).length === 0) return { ok: false, error: 'Nothing to change.' };

  let word: unknown;
  try {
    const { data, error } = await ctx.client.rpc('hire_update_candidate', { p_candidate_id: id, p_changes: changes });
    if (error) return changeFailed('updateCandidate', error);
    word = wordOf(data);
  } catch (error) {
    return changeFailed('updateCandidate', error);
  }
  if (word !== 'ok') return { ok: false, error: candidateMessage(word) };
  return { ok: true, data: { id, name: (await readColumn(ctx, 'hire_candidates', 'name', id)) ?? '' } };
}

/**
 * Attaches a stored CV to an application. `service` is a service-role client the
 * caller passes in. Answers the function's word, or `failed` on an error or a throw.
 */
export async function attachCandidateCv(service: SupabaseClient, applicationId: string, path: string): Promise<string> {
  try {
    const { data, error } = await service.rpc('hire_attach_cv', { p_application_id: applicationId, p_cv_path: path });
    if (error || typeof data !== 'string') {
      changeFailed('attachCandidateCv', error);
      return 'failed';
    }
    return data;
  } catch (error) {
    changeFailed('attachCandidateCv', error);
    return 'failed';
  }
}

// ─── deleting an application or a candidate (two database functions, called by rpc) ──

export const deleteApplicationInput = z.object({ id: applicationId() });
export const deleteCandidateInput = z.object({
  id: z.string().uuid(NOT_A_CANDIDATE_ID).describe('The candidate\'s id, from listCandidates.'),
});
export const deletionSummaryInput = z.object({
  kind: z.enum(['application', 'candidate'])
    .describe('What would be deleted: one application, or one candidate with everything of theirs.'),
  id: z.string().uuid(NOT_A_LOOKED_UP_ID).describe('The id of that application or candidate.'),
});

/** What a deletion removed, as the database function said, and the sentence for it. */
export type Deleted = {
  id: string;
  name: string;
  /** The job's title, for a deleted application; null for a candidate. */
  job: string | null;
  applications: number;
  interviews: number;
  cv_files: number;
  message: string;
};

const wholeNumber = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;

/** Logs the error's code only, and answers with the delete sentence. */
function deleteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  changeFailed(fnName, error);
  return { ok: false, error: DELETE_FAILED };
}

/**
 * Calls one delete function. There is no row to read back afterwards, so the
 * name and the counts are the function's own answer. An `ok` whose details are
 * missing is still a success: the deletion has happened.
 */
async function deletion(
  ctx: HireWriteContext,
  fnName: string,
  fn: string,
  args: Record<string, unknown>,
  kind: DeletionKind,
  id: string,
): Promise<CapResult<Deleted>> {
  let answer: unknown;
  try {
    const { data, error } = await ctx.client.rpc(fn, args);
    if (error) return deleteFailed(fnName, error);
    answer = data;
  } catch (error) {
    return deleteFailed(fnName, error);
  }
  const word = wordOf(answer);
  if (word !== 'ok') return { ok: false, error: deletionMessage(kind, word) };

  const got = answer as { name?: unknown; job?: unknown; applications?: unknown; interviews?: unknown; cv_files?: unknown };
  const name = typeof got.name === 'string' ? got.name : '';
  const job = kind === 'application' && typeof got.job === 'string' && got.job ? got.job : null;
  const removal: Removal = {
    name,
    job,
    applications: wholeNumber(got.applications),
    interviews: wholeNumber(got.interviews),
    cvFiles: wholeNumber(got.cv_files),
  };
  return {
    ok: true,
    data: {
      id,
      name,
      job,
      applications: removal.applications,
      interviews: removal.interviews,
      cv_files: removal.cvFiles,
      message: deletedMessage(kind, removal),
    },
  };
}

export async function deleteApplication(
  ctx: HireWriteContext,
  input: z.input<typeof deleteApplicationInput>,
): Promise<CapResult<Deleted>> {
  const parsed = deleteApplicationInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id } = parsed.data;
  return deletion(ctx, 'deleteApplication', 'hire_delete_application', { p_application_id: id }, 'application', id);
}

export async function deleteCandidate(
  ctx: HireWriteContext,
  input: z.input<typeof deleteCandidateInput>,
): Promise<CapResult<Deleted>> {
  const parsed = deleteCandidateInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id } = parsed.data;
  return deletion(ctx, 'deleteCandidate', 'hire_delete_candidate', { p_candidate_id: id }, 'candidate', id);
}

function summaryFailed(error: unknown): { ok: false; error: string } {
  changeFailed('deletionSummary', error);
  return { ok: false, error: SUMMARY_FAILED };
}

/**
 * What a deletion would remove right now, for the confirm dialog: the name,
 * the job for an application, and three counts. Read with the member's own
 * client, inside their workspace. A storage path is only counted, never
 * returned, and no contact detail is read. A preview: the delete function's
 * own answer is what the success message reports.
 */
export async function deletionSummary(
  ctx: HireWriteContext,
  input: z.input<typeof deletionSummaryInput>,
): Promise<CapResult<Removal>> {
  const parsed = deletionSummaryInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: SUMMARY_FAILED };
  const { kind, id } = parsed.data;
  const missing = { ok: false as const, error: deletionMessage(kind, 'not_found') };
  try {
    if (kind === 'application') {
      const found = await ctx.client
        .from('hire_applications')
        .select('id,cv_path,candidate:hire_candidates(name),job:hire_jobs(title)')
        .eq('id', id)
        .eq('org_id', ctx.orgId)
        .maybeSingle();
      if (found.error) return summaryFailed(found.error);
      const row = found.data as unknown as {
        cv_path: string | null; candidate: { name: string } | null; job: { title: string } | null;
      } | null;
      if (!row) return missing;
      const interviews = await ctx.client
        .from('hire_interviews')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', ctx.orgId)
        .eq('application_id', id);
      if (interviews.error) return summaryFailed(interviews.error);
      return {
        ok: true,
        data: {
          name: row.candidate?.name ?? '',
          job: row.job?.title ?? null,
          applications: 1,
          interviews: interviews.count ?? 0,
          cvFiles: row.cv_path ? 1 : 0,
        },
      };
    }

    const person = await ctx.client
      .from('hire_candidates')
      .select('name')
      .eq('id', id)
      .eq('org_id', ctx.orgId)
      .maybeSingle();
    if (person.error) return summaryFailed(person.error);
    const who = person.data as unknown as { name: string } | null;
    if (!who) return missing;
    const applications = await ctx.client
      .from('hire_applications')
      .select('id,cv_path')
      .eq('org_id', ctx.orgId)
      .eq('candidate_id', id);
    if (applications.error) return summaryFailed(applications.error);
    const rows = (applications.data ?? []) as unknown as { id: string; cv_path: string | null }[];
    let interviews = 0;
    if (rows.length > 0) {
      const counted = await ctx.client
        .from('hire_interviews')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', ctx.orgId)
        .in('application_id', rows.map((row) => row.id));
      if (counted.error) return summaryFailed(counted.error);
      interviews = counted.count ?? 0;
    }
    return {
      ok: true,
      data: {
        name: who.name,
        job: null,
        applications: rows.length,
        interviews,
        cvFiles: rows.filter((row) => row.cv_path).length,
      },
    };
  } catch (error) {
    return summaryFailed(error);
  }
}

// ─── the talent pool (two database functions, called by rpc) ─────────────────

const candidateId = () => z.string().uuid(NOT_A_CANDIDATE_ID).describe('The candidate\'s id, from listCandidates or listTalentPool.');

export const setPoolStatusInput = z.object({
  id: candidateId(),
  status: z.enum(['available', 'passive', 're_engaged', 'none']).describe(
    'available: open to hearing about a role now. passive: not looking right now, worth keeping in touch for later. '
    + 're_engaged: back in touch and put forward for a job again. none removes them from the pool; they stay on file.',
  ),
  only_if_outside: z.boolean().optional().describe(
    'Set true when ADDING someone to the pool: it is then refused, changing nothing, if they are already in it. '
    + 'Leave out when changing the status of someone already in the pool, or removing them.',
  ),
});
export const moveToPipelineInput = z.object({
  id: candidateId(),
  job_id: z.string().uuid(NOT_A_JOB_ID).describe('The job to add an application for, from listJobs. It must be open or paused.'),
});

/** What a pool status change did, and the sentence for it. `from` is null when the answer did not say where the person was. */
export type PoolChange = { id: string; name: string; from: PoolStatus | null; to: PoolStatus; message: string };
/** What a move to the pipeline did. `id` is the candidate's; the application is new. */
export type MovedToPipeline = {
  id: string;
  name: string;
  application_id: string | null;
  job_id: string;
  job: string | null;
  from: PoolStatus | null;
  to: 're_engaged';
  message: string;
};

/** The words that need no name in their sentence: the person is not read for them. */
const NAMELESS_REFUSALS = ['not_found', 'forbidden', 'invalid_status', 'job_not_found', 'job_not_open'];

/**
 * Sets one candidate's pool status: adds them (from none), changes it, or
 * removes them (to none). The change is saved once the function says ok, so a
 * name that cannot be read back still answers ok, with the name left out.
 */
export async function setPoolStatus(
  ctx: HireWriteContext,
  input: z.input<typeof setPoolStatusInput>,
): Promise<CapResult<PoolChange>> {
  const parsed = setPoolStatusInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id, status } = parsed.data;
  const onlyIfOutside = parsed.data.only_if_outside === true;
  let answer: unknown;
  try {
    const { data, error } = await ctx.client.rpc('hire_set_pool_status', {
      p_candidate_id: id, p_status: status, p_only_if_outside: onlyIfOutside,
    });
    if (error) return changeFailed('setPoolStatus', error);
    answer = data;
  } catch (error) {
    return changeFailed('setPoolStatus', error);
  }
  const word = wordOf(answer);
  if (typeof word !== 'string' || NAMELESS_REFUSALS.includes(word)) return { ok: false, error: poolRefusal(word) };
  const got = (answer && typeof answer === 'object' ? answer : {}) as { from?: unknown };
  const name = (await readColumn(ctx, 'hire_candidates', 'name', id)) ?? '';
  if (word !== 'ok') {
    // "The status they already have" is the one that was asked for, when the answer does not say.
    const from = isPoolStatus(got.from) ? got.from : word === 'same_status' ? status : undefined;
    return { ok: false, error: poolRefusal(word, { name, from }) };
  }
  // Only what the answer says or the request itself implies: an add was from outside the pool.
  const from: PoolStatus | null = isPoolStatus(got.from) ? got.from : onlyIfOutside ? 'none' : null;
  return { ok: true, data: { id, name, from, to: status, message: poolChangedMessage(name, from, status) } };
}

/**
 * Gives one pool member a new application at Applied for an open or paused
 * job, and marks them Re-engaged. If they had already applied for that job the
 * function changes nothing and the sentence says so.
 */
export async function moveToPipeline(
  ctx: HireWriteContext,
  input: z.input<typeof moveToPipelineInput>,
): Promise<CapResult<MovedToPipeline>> {
  const parsed = moveToPipelineInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id, job_id: jobId } = parsed.data;
  let answer: unknown;
  try {
    const { data, error } = await ctx.client.rpc('hire_move_to_pipeline', { p_candidate_id: id, p_job_id: jobId });
    if (error) return changeFailed('moveToPipeline', error);
    answer = data;
  } catch (error) {
    return changeFailed('moveToPipeline', error);
  }
  const word = wordOf(answer);
  if (typeof word !== 'string' || NAMELESS_REFUSALS.includes(word)) return { ok: false, error: poolRefusal(word) };
  const got = (answer && typeof answer === 'object' ? answer : {}) as { application_id?: unknown; from?: unknown; outcome?: unknown };
  const name = (await readColumn(ctx, 'hire_candidates', 'name', id)) ?? '';
  const job = await readColumn(ctx, 'hire_jobs', 'title', jobId);
  if (word !== 'ok') return { ok: false, error: poolRefusal(word, { name, job, outcome: got.outcome }) };
  return {
    ok: true,
    data: {
      id,
      name,
      application_id: typeof got.application_id === 'string' ? got.application_id : null,
      job_id: jobId,
      job,
      from: isInPool(got.from) ? got.from : null,
      to: 're_engaged',
      message: movedMessage(name, job),
    },
  };
}
