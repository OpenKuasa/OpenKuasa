'use server';

import { z } from 'zod';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  HONEYPOT_FIELD,
  SUBMISSION_MESSAGES,
  type SubmissionErrors,
  type SubmissionValues,
  parseSubmission,
} from '@/lib/reach/form-submissions';
import { createAnonymousClient, submitPublicForm } from '@/lib/reach/public-forms';
import { formSubmitLimited } from '@/lib/security/limits';
import { serverWriteClient } from '@/lib/supabase/server-writer';

/** What the public form shows after a submission has been tried. */
export type PublicFormState =
  | {
      /** The response was taken: show the thank-you. */
      done?: true;
      /** The form stopped taking responses while it was open. */
      closed?: true;
      /** A problem with the whole submission. */
      error?: string;
      /** A problem with one field, shown beside it. */
      errors?: SubmissionErrors;
      /** What was typed, so a rejected form is not emptied. */
      values?: SubmissionValues;
    }
  | undefined;

/** Longer than any field may be, so an absurd value is cut before it is checked. */
const READ_LIMIT = 4000;

function read(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.slice(0, READ_LIMIT) : '';
}

/**
 * Takes a visitor's submission. Runs for anyone, signed in or not, so nothing
 * here is trusted: the fields are checked, then checked again by the database.
 */
export async function submitPublicFormAction(
  formId: string,
  _prev: PublicFormState,
  formData: FormData,
): Promise<PublicFormState> {
  const values: SubmissionValues = {
    name: read(formData, 'name'),
    email: read(formData, 'email'),
    phone: read(formData, 'phone'),
    message: read(formData, 'message'),
  };

  // A script filled the field no person can see: thank it and keep nothing.
  if (read(formData, HONEYPOT_FIELD).trim()) return { done: true };

  const parsed = parseSubmission(values);
  if (!parsed.ok) return { errors: parsed.errors, values };

  if (!z.uuid().safeParse(formId).success || !hasSupabaseEnv()) {
    return { error: SUBMISSION_MESSAGES.failed, values };
  }

  // Counted only now, so a post that was never going to be sent uses up nothing. A check a
  // visitor has to pass (a challenge token) would be verified here too, before anything is written.
  const limited = await formSubmitLimited();
  if (limited) return { error: limited, values };

  // Sent by the server as itself: the database takes a response from nobody else.
  const outcome = await submitPublicForm(serverWriteClient(createAnonymousClient), formId, parsed.input);
  switch (outcome.kind) {
    case 'ok':
      return { done: true };
    case 'closed':
    case 'not_found':
      return { closed: true };
    case 'throttled':
      return { error: SUBMISSION_MESSAGES.throttled, values };
    case 'invalid':
      return { errors: outcome.errors, values };
    default:
      return { error: SUBMISSION_MESSAGES.failed, values };
  }
}
