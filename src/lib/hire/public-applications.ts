// src/lib/hire/public-applications.ts
/**
 * Sends a visitor's application to `submit_public_application` and reads the
 * one word it answers with. The client is passed in, so this file imports no
 * server-only code. The values are a stranger's personal data: they are never
 * logged and never put in an error.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ApplicationFormValues } from './application-form';
import {
  APPLY_MESSAGES, applyProblems, oneLine, ringgitToSen, shownFields,
  type ApplyErrors, type ApplyField, type ApplyValues,
} from './application-fields';

/** The kinds of value a form holds: seven strings and a tick. Anything else did not come from the form. */
const applyShape = z.object({
  name: z.string(), email: z.string(), phone: z.string(), cv_url: z.string(),
  cover_letter: z.string(), portfolio_url: z.string(), expected_salary: z.string(),
  consent: z.boolean(),
});

/** The same checks as `applyProblems`, as a schema: one issue per wrong field, on that field's path. */
export const applicationInput = (form: ApplicationFormValues, hasCvFile = false) =>
  applyShape
    .superRefine((values, ctx) => {
      for (const [field, message] of Object.entries(applyProblems(values, form, hasCvFile))) {
        ctx.addIssue({ code: 'custom', path: [field], message });
      }
    });

export type ApplyOutcome =
  | { kind: 'ok' }
  /** A repeat application: the visitor is thanked as for a new one. */
  | { kind: 'duplicate' }
  | { kind: 'closed' }
  | { kind: 'throttled' }
  | { kind: 'invalid'; errors: ApplyErrors }
  | { kind: 'failed' };

/** The messages that are plain text; the ones that are functions of something cannot be looked up by a word. */
type TextMessageKey = {
  [K in keyof typeof APPLY_MESSAGES]: (typeof APPLY_MESSAGES)[K] extends string ? K : never;
}[keyof typeof APPLY_MESSAGES];

const WORD_ERRORS: Record<string, readonly [ApplyField, TextMessageKey]> = {
  name_too_long: ['name', 'nameTooLong'],
  invalid_name: ['name', 'name'],
  email_too_long: ['email', 'emailTooLong'],
  invalid_email: ['email', 'emailInvalid'],
  phone_too_long: ['phone', 'phoneTooLong'],
  cover_letter_too_long: ['cover_letter', 'coverLetterTooLong'],
  cover_letter_required: ['cover_letter', 'coverLetterRequired'],
  cv_required: ['cv_url', 'cvRequired'],
  consent_required: ['consent', 'consent'],
  invalid_salary: ['expected_salary', 'salaryInvalid'],
};

/**
 * Reads the one word `submit_public_application` answers with. A visitor is not
 * told whether a job is closed or missing. The two link words name no single
 * field, and the page checks both links first, so they read as a failure.
 */
export function applyOutcome(word: unknown): ApplyOutcome {
  if (word === 'ok') return { kind: 'ok' };
  if (word === 'ok_duplicate') return { kind: 'duplicate' };
  if (word === 'closed' || word === 'not_found') return { kind: 'closed' };
  if (word === 'throttled') return { kind: 'throttled' };
  const entry = typeof word === 'string' && Object.hasOwn(WORD_ERRORS, word) ? WORD_ERRORS[word] : undefined;
  return entry ? { kind: 'invalid', errors: { [entry[0]]: APPLY_MESSAGES[entry[1]] } } : { kind: 'failed' };
}

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/**
 * Validates, then calls the function. Only the function's name and the error's
 * code are logged on a failure: never the arguments, and never a message.
 */
export async function submitPublicApplication(
  client: SupabaseClient,
  orgId: string,
  jobId: string,
  values: ApplyValues,
  form: ApplicationFormValues,
  honeypot?: string | null,
  cvPath?: string | null,
): Promise<ApplyOutcome> {
  if (!isUuid(orgId) || !isUuid(jobId)) return { kind: 'closed' };
  // A post that is not the form's shape (a missing field, a number for a name) is not checked field by
  // field: the checks below read strings.
  const shaped = applyShape.safeParse(values);
  if (!shaped.success) return { kind: 'failed' };
  // A path means a file was stored for this application, which meets a required CV.
  const hasCvFile = Boolean(cvPath);
  const parsed = applicationInput(form, hasCvFile).safeParse(shaped.data);
  if (!parsed.success) return { kind: 'invalid', errors: applyProblems(shaped.data, form, hasCvFile) };

  const shown = new Set(shownFields(form));
  const text = (field: Exclude<ApplyField, 'consent'>) => {
    const value = shown.has(field) ? parsed.data[field].trim() : '';
    return value === '' ? null : value;
  };
  const salary = shown.has('expected_salary') ? ringgitToSen(parsed.data.expected_salary) : null;
  const args = {
    p_org_id: orgId,
    p_job_id: jobId,
    // One line, exactly as the page counted it: the database measures before it collapses.
    p_name: oneLine(parsed.data.name),
    p_email: parsed.data.email.trim(),
    p_phone: shown.has('phone') && oneLine(parsed.data.phone) !== '' ? oneLine(parsed.data.phone) : null,
    p_cover_letter: text('cover_letter'),
    p_cv_url: text('cv_url'),
    p_portfolio_url: text('portfolio_url'),
    p_expected_salary_cents: salary === 'invalid' ? null : salary,
    p_consent: parsed.data.consent,
    p_honeypot: honeypot ? honeypot : null,
    ...(cvPath ? { p_cv_path: cvPath } : {}),
  };

  try {
    const { data, error } = await client.rpc('submit_public_application', args);
    if (!error) return applyOutcome(data);
    // The code only: a database message can quote the value it choked on.
    console.error('[public-applications] submit_public_application failed:', { code: error.code });
  } catch (error) {
    const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
    console.error('[public-applications] submit_public_application failed:', { code, name });
  }
  return { kind: 'failed' };
}
