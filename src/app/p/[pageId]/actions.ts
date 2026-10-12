'use server';

import { z } from 'zod';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { countLandingPageLead, landingPageFormId } from '@/lib/crm/public-landing-pages';
import { HONEYPOT_FIELD, SUBMISSION_MESSAGES } from '@/lib/reach/form-submissions';
import { type PublicFormState, submitPublicFormAction } from '@/app/f/[formId]/actions';

/** The length the form's action cuts every field to before looking at it. */
const HONEYPOT_READ_LIMIT = 4000;

/**
 * Takes a visitor's submission from a landing page. The page only says which
 * lead form it shows: the submission itself goes through that form's own
 * action, with its checks, its limits and its honeypot, unchanged. The form is
 * looked up here from the page, never taken from the browser.
 */
export async function submitLandingPageAction(
  pageId: string,
  prev: PublicFormState,
  formData: FormData,
): Promise<PublicFormState> {
  if (!z.uuid().safeParse(pageId).success || !hasSupabaseEnv()) {
    return { error: SUBMISSION_MESSAGES.failed };
  }

  const formId = await landingPageFormId(pageId);
  // Unpublished, or its form paused, while the visitor had it open.
  if (!formId) return { closed: true };

  const state = await submitPublicFormAction(formId, prev, formData);

  // A filled honeypot is thanked like a real submission but nothing was kept, so nothing is
  // counted. Read exactly as the form's action reads it, so the two never disagree.
  const honeypot = formData.get(HONEYPOT_FIELD);
  const filled = typeof honeypot === 'string' && honeypot.slice(0, HONEYPOT_READ_LIMIT).trim() !== '';
  if (state?.done && !filled) await countLandingPageLead(pageId, formId);
  return state;
}
