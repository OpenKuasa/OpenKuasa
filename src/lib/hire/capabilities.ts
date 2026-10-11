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
import {
  APPLICATION_STAGES, DEFAULT_HIRE_SETTINGS, JOB_COLUMNS, SETTINGS_COLUMNS,
  type ApplicationOutcome, type ApplicationStage, type HireSettings, type Job, type JobStatus,
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
export const updateJobInput = z.object({
  id: z.string().uuid().describe('The job\'s id, from listJobs.'),
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
  id: z.string().uuid().describe('The job\'s id, from listJobs.'),
  status: z.enum(['open', 'paused', 'closed']).describe('open, paused or closed.'),
});
export const deleteJobInput = z.object({ id: z.string().uuid().describe('The job\'s id, from listJobs.') });

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

const applicationId = () => z.string().uuid().describe('The application\'s id, from listApplications.');

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
