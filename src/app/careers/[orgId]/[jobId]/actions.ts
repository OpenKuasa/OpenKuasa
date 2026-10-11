'use server';

import { z } from 'zod';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  APPLY_HONEYPOT,
  APPLY_MESSAGES,
  applyProblems,
  firstName,
  type ApplyErrors,
  type ApplyValues,
} from '@/lib/hire/application-fields';
import { submitPublicApplication } from '@/lib/hire/public-applications';
import { readPublicJob } from '@/lib/hire/public-careers';
import { createAnonymousClient } from '@/lib/supabase/anonymous';

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

/**
 * Takes a visitor's application to one job. Runs for anyone, signed in or not,
 * and can be called without the page, so nothing that arrives is trusted: not
 * the two ids, not the previous state, and not which fields the form claims to
 * have. What the job asks for is read here, from the job.
 *
 * The values are a stranger's personal data. Nothing here logs them, and
 * nothing goes back but one of the states above.
 */
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

  // A script filled the field no person can see: thank it and keep nothing.
  if (read(formData, APPLY_HONEYPOT).trim()) return { done: { firstName: firstName(values.name) } };

  if (!isUuid(orgId) || !isUuid(jobId) || !hasSupabaseEnv()) return { closed: true };

  const client = createAnonymousClient();
  const lookup = await readPublicJob(client, orgId, jobId);
  // The read did not work, which says nothing about the job: the form is kept, to be sent again.
  if (lookup.state === 'failed') return { error: APPLY_MESSAGES.failed, values };
  if (lookup.state === 'missing' || !lookup.job.accepting) return { closed: true };
  const { job } = lookup;

  const errors = applyProblems(values, job.form);
  if (Object.keys(errors).length > 0) return { errors, values };

  const outcome = await submitPublicApplication(client, orgId, jobId, values, job.form);
  switch (outcome.kind) {
    case 'ok':
      return { done: { firstName: firstName(values.name) } };
    case 'closed':
      return { closed: true };
    case 'throttled':
      return { error: APPLY_MESSAGES.throttled, values };
    case 'invalid':
      return { errors: outcome.errors, values };
    default:
      return { error: APPLY_MESSAGES.failed, values };
  }
}
