'use server';

import { z } from 'zod';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  APPLY_HONEYPOT,
  APPLY_MESSAGES,
  CV_FILE_FIELD,
  CV_MAX_BYTES,
  applyProblems,
  chosenFile,
  cvFileProblem,
  fileSizeLabel,
  firstName,
  type ApplyErrors,
  type ApplyValues,
} from '@/lib/hire/application-fields';
import { isPdf, removeCv, storeCv } from '@/lib/hire/cv-store';
import { submitPublicApplication, type ApplyOutcome } from '@/lib/hire/public-applications';
import { readPublicJob } from '@/lib/hire/public-careers';
import { applyLimited } from '@/lib/security/limits';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { serverWriteClient } from '@/lib/supabase/server-writer';
import { serviceClient } from '@/lib/supabase/service';

/** What the apply form shows after an application has been tried. */
export type ApplyState =
  | {
      /** The application was taken: show the thank-you, by first name. */
      done?: { firstName: string };
      /** The job is not taking applications (or is not there: a visitor is not told which). */
      closed?: true;
      /** A problem with the whole application. */
      error?: string;
      /** A problem with one field, shown under it. */
      errors?: ApplyErrors;
      /** What was typed, so a rejected form is not emptied. */
      values?: ApplyValues;
      /**
       * A file was posted and the application was not taken. A form the server
       * draws again cannot hold a file, so the visitor is told to choose it again.
       */
      fileDropped?: true;
    }
  | undefined;

/**
 * Longer than any field may be, so an absurd value is cut before it is
 * checked. The cut counts UTF-16 units, the checks count characters, and a
 * character can be two units: the longest cover letter allowed is 4,000
 * characters, which can be 8,000 units, and must arrive whole.
 */
const READ_LIMIT = 9000;

/**
 * One field as text, cut before anything looks at it. Anything that is not
 * text (a file, nothing at all) is empty. A form post carries each line break
 * of a text area as two characters; they are made one again first, so a cover
 * letter is counted here as the visitor's browser counted it.
 */
function read(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').slice(0, READ_LIMIT) : '';
}

const isUuid = (value: unknown) => z.uuid().safeParse(value).success;

/**
 * A posted form, told by what it can do and not by its class: the framework
 * builds the form it hands over, and a real application must never be turned
 * away because that was built somewhere this file's `FormData` is not.
 */
const isForm = (value: unknown): value is FormData =>
  typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function';

/** A posted file, told the same way: by the two things this file needs of it. */
type Readable = { size: number; arrayBuffer: () => Promise<ArrayBuffer> };
const isReadable = (value: unknown): value is Readable =>
  typeof value === 'object' && value !== null
  && typeof (value as { size?: unknown }).size === 'number'
  && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function';

/** The code of something that went wrong, and nothing else about it: a message can quote what it choked on. */
const codeOf = (error: unknown) => {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return { code: code ?? name };
};

/**
 * What the form is told for each answer of the sender. A repeat application
 * is thanked exactly like a new one: a visitor is never told an email has
 * applied before. `dropped` rides on every answer that draws the form again.
 */
function answerFor(outcome: ApplyOutcome, values: ApplyValues, dropped: { fileDropped?: true }): ApplyState {
  switch (outcome.kind) {
    case 'ok':
    case 'duplicate':
      return { done: { firstName: firstName(values.name) } };
    case 'closed':
      return { closed: true };
    case 'throttled':
      return { error: APPLY_MESSAGES.throttled, values, ...dropped };
    case 'invalid':
      return { errors: outcome.errors, values, ...dropped };
    default:
      return { error: APPLY_MESSAGES.failed, values, ...dropped };
  }
}

/**
 * Takes a visitor's application to one job. Runs for anyone, signed in or not,
 * and can be called without the page, so nothing that arrives is trusted: not
 * the two ids, not the previous state, and not which fields the form claims to
 * have. What the job asks for is read here, from the job.
 *
 * A CV may come with it, as a PDF. The file is stored only after every check
 * that can be made without storing it, and it is removed again unless the
 * application it came with is taken as a new one. Storing and sending are done
 * as the server itself: the database takes an application from nobody else.
 *
 * One client may send only so many applications an hour, and fewer files a
 * day (a workspace takes a fixed number of files a day in all). Both are
 * counted once the post has passed every check that needs no writing, so a
 * form sent back for a mistake uses up nothing.
 *
 * The values and the file are a stranger's personal data. Nothing here logs
 * them, the file's name or where it is stored, and nothing goes back but one
 * of the states above.
 */
/** Whether an application holds this file: true, false, or null when the question could not be answered. */
async function cvKept(service: ReturnType<typeof serviceClient>, path: string): Promise<boolean | null> {
  try {
    const { data, error } = await service.rpc('hire_cv_attached', { p_path: path });
    if (!error && typeof data === 'boolean') return data;
    console.error('[careers/apply] hire_cv_attached failed:', { code: error?.code });
  } catch (error) {
    console.error('[careers/apply] hire_cv_attached failed:', codeOf(error));
  }
  return null;
}

export async function applyAction(
  orgId: string,
  jobId: string,
  _prev: ApplyState,
  formData: FormData,
): Promise<ApplyState> {
  // Called as a function with something that is not a form: there is nothing to read, and nothing to send back.
  if (!isForm(formData)) return { error: APPLY_MESSAGES.failed };

  const values: ApplyValues = {
    name: read(formData, 'name'),
    email: read(formData, 'email'),
    phone: read(formData, 'phone'),
    cv_url: read(formData, 'cv_url'),
    cover_letter: read(formData, 'cover_letter'),
    portfolio_url: read(formData, 'portfolio_url'),
    expected_salary: read(formData, 'expected_salary'),
    // A ticked checkbox with no value of its own posts exactly this.
    consent: formData.get('consent') === 'on',
  };
  // What is known of the file without opening it. An input nobody touched posts an empty, nameless file: no file.
  const posted = formData.get(CV_FILE_FIELD);
  const file = chosenFile(posted);

  // A script filled the field no person can see: thank it and keep nothing.
  if (read(formData, APPLY_HONEYPOT).trim()) return { done: { firstName: firstName(values.name) } };

  if (!isUuid(orgId) || !isUuid(jobId) || !hasSupabaseEnv()) return { closed: true };

  /** On every answer from here on that draws the form again: the file, if one came, did not survive the trip. */
  const dropped: { fileDropped?: true } = file ? { fileDropped: true } : {};

  const client = createAnonymousClient();
  const lookup = await readPublicJob(client, orgId, jobId);
  // The read did not work, which says nothing about the job: the form is kept, to be sent again.
  if (lookup.state === 'failed') return { error: APPLY_MESSAGES.failed, values, ...dropped };
  if (lookup.state === 'missing' || !lookup.job.accepting) return { closed: true };
  const { job } = lookup;

  // A file meets a required CV. What the file says of itself (name, type, size) is checked with the fields.
  const errors = applyProblems(values, job.form, file !== null);
  const fileProblem = cvFileProblem(file);
  if (fileProblem) errors.cv_file = fileProblem;
  if (Object.keys(errors).length > 0) return { errors, values, ...dropped };

  // No file. A check a visitor has to pass (a challenge token) would be verified here, and below for a file.
  if (!file) {
    const limited = await applyLimited(false);
    if (limited) return { error: limited, values, ...dropped };
    const writer = serverWriteClient(() => client);
    return answerFor(await submitPublicApplication(writer, orgId, jobId, values, job.form), values, dropped);
  }

  // The bytes, read once. What the file said of itself is not trusted: the bytes decide what it is and how big.
  if (!isReadable(posted)) return { errors: { cv_file: APPLY_MESSAGES.cvFileType }, values, ...dropped };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await posted.arrayBuffer());
  } catch (error) {
    console.error('[careers/apply] the posted file could not be read:', codeOf(error));
    return { error: APPLY_MESSAGES.cvUploadFailed, values, ...dropped };
  }
  if (bytes.length > CV_MAX_BYTES) {
    return { errors: { cv_file: APPLY_MESSAGES.cvFileTooBig(fileSizeLabel(bytes.length)) }, values, ...dropped };
  }
  if (!isPdf(bytes)) return { errors: { cv_file: APPLY_MESSAGES.cvFileType }, values, ...dropped };

  // One client's applications this hour, and its files today: asked before anything is stored.
  const limited = await applyLimited(true);
  if (limited) return { error: limited, values, ...dropped };

  // From here the server acts as itself. A site without the key cannot take a file at all.
  let service: ReturnType<typeof serviceClient>;
  try {
    service = serviceClient();
  } catch {
    console.error('[careers/apply] a CV was posted but the service role is not configured');
    return { error: APPLY_MESSAGES.failed, values, ...dropped };
  }

  // A workspace nobody with a real sign-in owns is not sent files: it can still be given a link.
  try {
    const { data, error } = await service.rpc('hire_cv_files_refused', { p_org_id: orgId });
    if (error) {
      console.error('[careers/apply] hire_cv_files_refused failed:', { code: error.code });
      return { error: APPLY_MESSAGES.failed, values, ...dropped };
    }
    if (data === true) return { errors: { [CV_FILE_FIELD]: APPLY_MESSAGES.cvFilesOff }, values, ...dropped };
  } catch (error) {
    console.error('[careers/apply] hire_cv_files_refused failed:', codeOf(error));
    return { error: APPLY_MESSAGES.failed, values, ...dropped };
  }

  // Asked before the upload, so that a job being flooded is not also sent a file per post.
  try {
    const { data, error } = await service.rpc('hire_apply_throttled', { p_job_id: jobId });
    if (error) {
      console.error('[careers/apply] hire_apply_throttled failed:', { code: error.code });
      return { error: APPLY_MESSAGES.failed, values, ...dropped };
    }
    if (data === true) return { error: APPLY_MESSAGES.throttled, values, ...dropped };
  } catch (error) {
    console.error('[careers/apply] hire_apply_throttled failed:', codeOf(error));
    return { error: APPLY_MESSAGES.failed, values, ...dropped };
  }

  let path: string | null = null;
  try {
    path = await storeCv(service, orgId, jobId, bytes);
  } catch (error) {
    console.error('[careers/apply] storing a CV failed:', codeOf(error));
  }
  if (!path) return { error: APPLY_MESSAGES.cvUploadFailed, values, ...dropped };

  // The file is stored. It stays only if the application is taken as a new one: any other end, a thrown
  // error and a repeat application included, removes it before the visitor is answered. One case is
  // asked about first: a call that failed or threw may have been kept by the database all the same.
  let outcome: ApplyOutcome = { kind: 'failed' };
  try {
    outcome = await submitPublicApplication(service, orgId, jobId, values, job.form, null, path);
  } catch (error) {
    console.error('[careers/apply] sending an application with a CV failed:', codeOf(error));
  } finally {
    let remove = outcome.kind !== 'ok';
    if (outcome.kind === 'failed') {
      const kept = await cvKept(service, path);
      // Kept: the application has its file, so this was a success the answer got lost from.
      if (kept === true) outcome = { kind: 'ok' };
      // Not known: a file with no application is the lesser harm than an application without its file.
      if (kept !== false) remove = false;
    }
    if (remove) {
      try {
        await removeCv(service, path);
      } catch (error) {
        // The answer does not change: the visitor's application was refused, or thanked, either way.
        console.error('[careers/apply] removing a CV failed:', codeOf(error));
      }
    }
  }
  return answerFor(outcome, values, dropped);
}
