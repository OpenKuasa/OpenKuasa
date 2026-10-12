'use server';

import { revalidatePath } from 'next/cache';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { APPLY_MESSAGES, CV_FILE_FIELD, CV_MAX_BYTES, chosenFile, cvFileProblem, fileSizeLabel } from '@/lib/hire/application-fields';
import {
  type CandidateFormValues, CV_UPLOADS_REFUSED, addedMessage, candidateMessage, candidateProblems, parseSkills,
} from '@/lib/hire/candidate-fields';
import {
  type CandidateAdded,
  type CapResult,
  type Deleted,
  type HireWriteContext,
  type MovedToPipeline,
  type PoolChange,
  addCandidate,
  attachCandidateCv,
  closeApplication,
  createJob,
  deleteJob,
  deleteApplication,
  deleteCandidate,
  deletionSummary,
  moveApplication,
  moveToPipeline,
  rateApplication,
  reopenApplication,
  setJobStatus,
  setPoolStatus,
  updateApplicationForm,
  updateCandidate,
  updateCareersPage,
  updateJob,
} from '@/lib/hire/capabilities';
import { isPdf, removeCv, signedCvUrl, storeCv } from '@/lib/hire/cv-store';
import type { Removal } from '@/lib/hire/deletion';
import { buildPoolPicker, type PoolPicker } from '@/lib/hire/lists';
import { PICKER_FAILED } from '@/lib/hire/pool';
import { careersPath } from '@/lib/hire/public-careers';
import { createSupabaseHireData } from '@/lib/hire/supabase';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';

const FORBIDDEN: CapResult<never> = { ok: false, error: 'You do not have permission to make changes here.' };
/** Every screen that shows jobs, applications, or numbers worked out from them. */
const JOB_PATHS = [
  '/hire/jobs',
  '/hire/careers-page',
  '/hire/assistant',
  '/hire/dashboard',
  '/hire/applications',
  '/hire/candidates',
  '/hire/interviews',
];

/** Resolve a write context after checking the viewer may edit data. */
async function writeCtx(): Promise<HireWriteContext | null> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'edit-data')) return null;
  return { client: await createClient(), orgId: viewer.orgId };
}

/** Guard, then the capability (which parses with its own schema), then revalidate. */
async function run<O>(fn: (ctx: HireWriteContext) => Promise<CapResult<O>>): Promise<CapResult<O>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const result = await fn(ctx);
  if (result.ok) for (const path of JOB_PATHS) revalidatePath(path);
  return result;
}

export async function createJobAction(input: unknown) {
  return run((ctx) => createJob(ctx, input as never));
}
export async function updateJobAction(input: unknown) {
  return run((ctx) => updateJob(ctx, input as never));
}
export async function setJobStatusAction(input: unknown) {
  return run((ctx) => setJobStatus(ctx, input as never));
}
export async function deleteJobAction(input: unknown) {
  return run((ctx) => deleteJob(ctx, input as never));
}

/**
 * Changing an application: a stage move, a rejection or withdrawal, a reopening, a rating.
 * The input is an application id and the change, nothing else; the workspace is the session's.
 */
export async function moveApplicationAction(input: unknown) {
  return run((ctx) => moveApplication(ctx, input as never));
}
export async function closeApplicationAction(input: unknown) {
  return run((ctx) => closeApplication(ctx, input as never));
}
export async function reopenApplicationAction(input: unknown) {
  return run((ctx) => reopenApplication(ctx, input as never));
}
export async function rateApplicationAction(input: unknown) {
  return run((ctx) => rateApplication(ctx, input as never));
}

/** The careers page is its own thing: it does not change what the job screens show. */
export async function updateCareersPageAction(input: unknown) {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const result = await updateCareersPage(ctx, input as never);
  if (result.ok) {
    revalidatePath('/hire/careers-page');
    revalidatePath('/hire/assistant');
    // The public pages render on every request, so this is not needed today. It is cheap, and it keeps the
    // board right if the pages are ever cached. A literal path takes no `type`.
    revalidatePath(careersPath(ctx.orgId));
  }
  return result;
}

/** What the apply form asks for: the Settings card, the assistant's view of it, and the public job pages that will carry the form. */
export async function updateApplicationFormAction(input: unknown) {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const result = await updateApplicationForm(ctx, input as never);
  if (result.ok) {
    revalidatePath('/hire/settings');
    revalidatePath('/hire/assistant');
    revalidatePath(careersPath(ctx.orgId));
  }
  return result;
}

const CV_GONE = 'This file is no longer available.';
const CV_FAILED = "Couldn't open the CV. Try again.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A five-minute link to an applicant's uploaded CV. Any member may open it; the path never leaves the server. */
export async function viewCvAction(applicationId: unknown): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const viewer = await getViewer();
  // The demo workspace holds no files.
  if (viewer.isDemo) return { ok: false, error: CV_GONE };
  if (typeof applicationId !== 'string' || !UUID.test(applicationId)) return { ok: false, error: CV_GONE };
  const client = await createClient();
  const { data, error } = await client
    .from('hire_applications')
    .select('cv_path')
    .eq('id', applicationId)
    .eq('org_id', viewer.orgId)
    .maybeSingle();
  if (error) return { ok: false, error: CV_FAILED };
  const path = (data as { cv_path: string | null } | null)?.cv_path;
  if (!path) return { ok: false, error: CV_GONE };
  const url = await signedCvUrl(client, path);
  return url ? { ok: true, url } : { ok: false, error: CV_FAILED };
}

// ─── adding and editing a candidate by hand ─────────────────────────────────

/** Every screen that shows a candidate's name or details: the job screens, and the talent pool. */
const CANDIDATE_PATHS = [...JOB_PATHS, '/hire/talent-pool'];
const NOT_SAVED = candidateMessage(null);
const CANDIDATE_NOT_FOUND = candidateMessage('not_found');
const CANDIDATE_NOT_LOADED = "This candidate's details could not be loaded. Please try again.";
const PICK_A_JOB = 'Pick a job to attach a CV.';
/**
 * Longer than any field may be, so an absurd value is cut before it is checked.
 * The cut counts UTF-16 units; the longest cover note allowed must arrive whole.
 */
const READ_LIMIT = 9000;
/** The form's text fields, in the order the form shows them: the first one that is wrong is the one reported. */
const CANDIDATE_FIELDS = [
  'name', 'email', 'phone', 'headline', 'location', 'skills', 'source', 'job_id', 'cover_letter', 'cv_url',
] as const satisfies readonly (keyof CandidateFormValues)[];

/** A posted form, told by what it can do and not by its class (see the public apply action). */
const isForm = (value: unknown): value is FormData =>
  typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function';

/** A posted file, told the same way: by the two things this file needs of it. */
type Readable = { size: number; arrayBuffer: () => Promise<ArrayBuffer> };
const isReadable = (value: unknown): value is Readable =>
  typeof value === 'object' && value !== null
  && typeof (value as { size?: unknown }).size === 'number'
  && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function';

/** One field as text: anything that is not text is empty, NUL is dropped, a text area's line break is one character. */
function readText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').slice(0, READ_LIMIT) : '';
}

/** The code of something that went wrong, and nothing else about it: a message can quote what it choked on. */
const codeOf = (error: unknown) => {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return { code: code ?? name };
};

/**
 * One yes-or-no question asked as the server itself. Only a plain `false` lets
 * a file through: a yes, an error, a throw or anything else is a no.
 */
async function serviceSaysNo(service: ReturnType<typeof serviceClient>, fn: string, args: Record<string, string>): Promise<boolean> {
  try {
    const { data, error } = await service.rpc(fn, args);
    if (error) console.error(`[hire/add-candidate] ${fn} failed:`, { code: error.code });
    return !(!error && data === false);
  } catch (error) {
    console.error(`[hire/add-candidate] ${fn} failed:`, codeOf(error));
    return true;
  }
}

/** Whether an application holds this file: true, false, or null when the question could not be answered. */
async function cvKept(service: ReturnType<typeof serviceClient>, path: string): Promise<boolean | null> {
  try {
    const { data, error } = await service.rpc('hire_cv_attached', { p_path: path });
    if (!error && typeof data === 'boolean') return data;
    console.error('[hire/add-candidate] hire_cv_attached failed:', { code: error?.code });
  } catch (error) {
    console.error('[hire/add-candidate] hire_cv_attached failed:', codeOf(error));
  }
  return null;
}

/**
 * Whether a CV file can be taken for this job right now, asked before anyone
 * is saved: an application made while the answer is no could never be given
 * its file. Answers the server's own client when it can, null when it cannot:
 * the server is not set up to store files, the workspace may not be sent
 * files (or has had its day's worth), or the job is being flooded.
 */
async function cvUploadService(orgId: string, jobId: string): Promise<ReturnType<typeof serviceClient> | null> {
  let service: ReturnType<typeof serviceClient>;
  try {
    service = serviceClient();
  } catch {
    console.error('[hire/add-candidate] a CV was posted but the service role is not configured');
    return null;
  }
  if (await serviceSaysNo(service, 'hire_cv_files_refused', { p_org_id: orgId })) return null;
  if (await serviceSaysNo(service, 'hire_apply_throttled', { p_job_id: jobId })) return null;
  return service;
}

/**
 * Stores a checked PDF and attaches it to an application that was just made.
 * True only when the application now holds the file. Everything here is done
 * as the server itself: the database lets no member write a file or its path.
 * A file the database refused is removed again; one whose attach answer was
 * lost is removed only once the database says no application holds it.
 */
async function attachCv(
  service: ReturnType<typeof serviceClient>, orgId: string, jobId: string, applicationId: string, bytes: Uint8Array,
): Promise<boolean> {
  let path: string | null = null;
  try {
    path = await storeCv(service, orgId, jobId, bytes);
  } catch (error) {
    console.error('[hire/add-candidate] storing a CV failed:', codeOf(error));
  }
  if (!path) return false;

  const word = await attachCandidateCv(service, applicationId, path);
  if (word === 'ok') return true;
  if (word === 'failed') {
    // No answer came back, so the database may have kept the path. Ask before removing anything.
    const kept = await cvKept(service, path);
    if (kept === true) return true;
    // Not known: the file stays, and the sweep takes it if no application holds it.
    if (kept === null) return false;
  }
  try {
    await removeCv(service, path);
  } catch (error) {
    console.error('[hire/add-candidate] removing a CV failed:', codeOf(error));
  }
  return false;
}

/**
 * Adds a candidate by hand, with an application when a job is picked and a PDF
 * CV when one is posted. The person is added as the member (their session, the
 * database's own checks); only the file is handled as the server itself.
 * Whether a file can be taken at all is asked before the add, and a no refuses
 * the whole add with nothing saved, so it can be sent again without the file.
 * The file is stored only once a new application exists to hold it; one that
 * could not be attached after that never undoes the add: the message says so.
 *
 * The values and the file are personal data. Nothing here logs them, the file's
 * name or where it is stored.
 */
export async function addCandidateAction(formData: FormData): Promise<CapResult<CandidateAdded>> {
  // 1. The guard, before anything is read.
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  if (!isForm(formData)) return { ok: false, error: NOT_SAVED };

  // 2. The fields, as text. What is known of the file without opening it.
  const jobId = readText(formData, 'job_id').trim();
  const values: CandidateFormValues = {
    name: readText(formData, 'name'),
    email: readText(formData, 'email'),
    phone: readText(formData, 'phone'),
    headline: readText(formData, 'headline'),
    location: readText(formData, 'location'),
    skills: readText(formData, 'skills'),
    source: readText(formData, 'source'),
    job_id: jobId,
    // With no job there is no application to hold these: they are dropped, not refused.
    cover_letter: jobId ? readText(formData, 'cover_letter') : '',
    cv_url: jobId ? readText(formData, 'cv_url') : '',
  };
  const posted = formData.get(CV_FILE_FIELD);
  const file = chosenFile(posted);

  // 3. The fields first, then what the file says of itself.
  const problems = candidateProblems(values, false);
  if (jobId && !UUID.test(jobId)) problems.job_id = candidateMessage('job_not_found');
  const wrong = CANDIDATE_FIELDS.find((field) => problems[field]);
  if (wrong) return { ok: false, error: problems[wrong] ?? NOT_SAVED };
  if (file && !jobId) return { ok: false, error: PICK_A_JOB };
  const fileProblem = cvFileProblem(file);
  if (fileProblem) return { ok: false, error: fileProblem };

  // 4. The bytes, read once. They decide what the file is and how big, whatever it said of itself. Nothing is saved yet.
  let bytes: Uint8Array | null = null;
  if (file) {
    if (!isReadable(posted)) return { ok: false, error: APPLY_MESSAGES.cvFileType };
    try {
      bytes = new Uint8Array(await posted.arrayBuffer());
    } catch (error) {
      console.error('[hire/add-candidate] the posted file could not be read:', codeOf(error));
      return { ok: false, error: NOT_SAVED };
    }
    if (bytes.length > CV_MAX_BYTES) return { ok: false, error: APPLY_MESSAGES.cvFileTooBig(fileSizeLabel(bytes.length)) };
    if (!isPdf(bytes)) return { ok: false, error: APPLY_MESSAGES.cvFileType };
  }

  // 5. With a file (so with a job): may one be uploaded right now? Asked before anyone is saved, and never without a file.
  let service: ReturnType<typeof serviceClient> | null = null;
  if (bytes) {
    service = await cvUploadService(ctx.orgId, jobId);
    if (!service) return { ok: false, error: CV_UPLOADS_REFUSED };
  }

  // 6. The add, as the member. A refusal goes back as it is.
  const result = await addCandidate(ctx, {
    name: values.name,
    email: values.email,
    phone: values.phone,
    headline: values.headline,
    location: values.location,
    skills: parseSkills(values.skills),
    source: values.source,
    job_id: jobId || null,
    cover_letter: values.cover_letter,
    cv_url: values.cv_url,
  });
  if (!result.ok) return result;
  const { data } = result;

  // 7. The file, only for an application this call made. One that already existed is never given a file here.
  let cvNotAttached = false;
  if (bytes && service) {
    const attached = data.application === 'created' && data.application_id !== null && jobId !== ''
      ? await attachCv(service, ctx.orgId, jobId, data.application_id, bytes)
      : false;
    cvNotAttached = !attached;
  }

  // 8. What happened, in one sentence, and the screens that show it.
  for (const path of CANDIDATE_PATHS) revalidatePath(path);
  return { ok: true, data: { ...data, message: addedMessage(data, cvNotAttached) } };
}

/** What the Edit form is filled with: text for every field, blank for none. */
export type CandidateForEdit = {
  id: string; name: string; email: string; phone: string; headline: string; location: string; skills: string; source: string;
};

/**
 * One candidate's details for the Edit form, contact details included. Only for
 * someone who may edit, and only from their own workspace: this is the one place
 * an email or a phone number leaves the server for a hiring screen.
 */
export async function getCandidateAction(id: unknown): Promise<CapResult<CandidateForEdit>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, error: CANDIDATE_NOT_FOUND };
  let row: Record<string, unknown> | null;
  try {
    const { data, error } = await ctx.client
      .from('hire_candidates')
      .select('id,name,email,phone,headline,location,skills,source')
      .eq('id', id)
      .eq('org_id', ctx.orgId)
      .maybeSingle();
    if (error) {
      console.error('[hire/get-candidate] the read failed:', { code: error.code });
      return { ok: false, error: CANDIDATE_NOT_LOADED };
    }
    row = data as Record<string, unknown> | null;
  } catch (error) {
    console.error('[hire/get-candidate] the read failed:', codeOf(error));
    return { ok: false, error: CANDIDATE_NOT_LOADED };
  }
  if (!row) return { ok: false, error: CANDIDATE_NOT_FOUND };
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const skills = Array.isArray(row.skills) ? row.skills.filter((skill): skill is string => typeof skill === 'string') : [];
  return {
    ok: true,
    data: {
      id,
      name: text(row.name),
      email: text(row.email),
      phone: text(row.phone),
      headline: text(row.headline),
      location: text(row.location),
      skills: skills.join(', '),
      source: text(row.source),
    },
  };
}

/** Editing a candidate's details. The input is the candidate's id and the fields that changed. */
export async function updateCandidateAction(input: unknown): Promise<CapResult<{ id: string; name: string }>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const result = await updateCandidate(ctx, input as never);
  if (result.ok) for (const path of CANDIDATE_PATHS) revalidatePath(path);
  return result;
}

// ─── deleting an application or a candidate ─────────────────────────────────

/**
 * Deleting one application: its interviews and its CV file go with it, the
 * candidate stays. The input is the application's id and nothing else. Every
 * screen that shows an application, a candidate or a number worked out from
 * them is fetched again: a pool row's rating and label can change too.
 */
export async function deleteApplicationAction(input: unknown): Promise<CapResult<Deleted>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const result = await deleteApplication(ctx, input as never);
  if (result.ok) for (const path of CANDIDATE_PATHS) revalidatePath(path);
  return result;
}

/** Deleting one candidate with every application, interview and CV file of theirs. The input is the candidate's id. */
export async function deleteCandidateAction(input: unknown): Promise<CapResult<Deleted>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const result = await deleteCandidate(ctx, input as never);
  if (result.ok) for (const path of CANDIDATE_PATHS) revalidatePath(path);
  return result;
}

/**
 * What a deletion would remove right now, for the confirm dialog. Only for
 * someone who may edit, and only from their own workspace: counts and names,
 * never a storage path or a contact detail. Nothing is changed.
 */
export async function getDeletionSummaryAction(input: unknown): Promise<CapResult<Removal>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  return deletionSummary(ctx, input as never);
}

// ─── the talent pool ────────────────────────────────────────────────────────

/**
 * Setting one candidate's pool status: adding them to the pool, changing the
 * status, or removing them (status none; the person stays on file). The input
 * is the candidate's id, the status, and whether this is an add.
 */
export async function setPoolStatusAction(input: unknown): Promise<CapResult<PoolChange>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const result = await setPoolStatus(ctx, input as never);
  if (result.ok) for (const path of CANDIDATE_PATHS) revalidatePath(path);
  return result;
}

/** Moving one pool member to the pipeline for a job: a new application at Applied, and they are marked Re-engaged. */
export async function moveToPipelineAction(input: unknown): Promise<CapResult<MovedToPipeline>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const result = await moveToPipeline(ctx, input as never);
  if (result.ok) for (const path of CANDIDATE_PATHS) revalidatePath(path);
  return result;
}

/**
 * The people the "Add to Pool" picker offers: everyone on file who is not in
 * the pool. Only for someone who may edit, read with their own client inside
 * their own workspace, when they open the picker. Names, headlines, places,
 * skills and sources: never an email or a phone number. Nothing is changed.
 */
export async function listPoolPickerAction(): Promise<CapResult<PoolPicker>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  try {
    return { ok: true, data: await buildPoolPicker(createSupabaseHireData(ctx.client, ctx.orgId)) };
  } catch (error) {
    console.error('[hire/pool-picker] the read failed:', codeOf(error));
    return { ok: false, error: PICKER_FAILED };
  }
}
