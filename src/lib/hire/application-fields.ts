// src/lib/hire/application-fields.ts
/**
 * The public apply form's fields, limits, messages and checks. Pure, with no
 * imports of code: the form in the browser, the server action and the tests
 * all use this one set of rules. The database function checks the same things
 * again, because anyone can call it without the page.
 */
import type { ApplicationFormValues } from './application-form';

/** In the order the form shows them, which is the order problems are reported in. */
export const APPLY_FIELDS = [
  'name', 'email', 'phone', 'cv_url', 'cover_letter', 'portfolio_url', 'expected_salary', 'consent',
] as const;
export type ApplyField = (typeof APPLY_FIELDS)[number];
/** What the form holds, as typed. */
export type ApplyValues = Record<Exclude<ApplyField, 'consent'>, string> & { consent: boolean };
export type ApplyErrors = Partial<Record<ApplyField, string>>;

export const EMPTY_APPLY_VALUES: ApplyValues = {
  name: '', email: '', phone: '', cv_url: '', cover_letter: '', portfolio_url: '', expected_salary: '', consent: false,
};

export const APPLY_LIMITS = {
  name: 120, email: 254, phone: 40, cover_letter: 4000, url: 500, salaryRinggit: 1_000_000,
} as const;

/**
 * A field people never see. A filled one means a script wrote the application,
 * which is then thanked and thrown away. So it must be a field no browser or
 * password manager fills in for a real person from what it has saved (a
 * company, a website, an address): the name is the one the public lead form
 * uses for the same reason, and the form labels it "Leave this field empty".
 */
export const APPLY_HONEYPOT = 'referral_code';

export const APPLY_MESSAGES = {
  name: 'Enter your full name.',
  nameTooLong: `Keep your name to ${APPLY_LIMITS.name} characters or fewer.`,
  email: 'Enter your email address.',
  emailInvalid: 'Enter an email address like name@example.com.',
  emailTooLong: `Keep the email address to ${APPLY_LIMITS.email} characters or fewer.`,
  phoneTooLong: `Keep the phone number to ${APPLY_LIMITS.phone} characters or fewer.`,
  cvRequired: 'Add a link to your CV.',
  coverLetterRequired: 'Write a short cover letter.',
  coverLetterTooLong: 'Keep the cover letter to 4,000 characters or fewer.',
  urlInvalid: 'Enter a link that starts with https://',
  urlTooLong: `Keep the link to ${APPLY_LIMITS.url} characters or fewer.`,
  salaryInvalid: 'Enter the amount in ringgit, for example 3500.',
  consent: 'Tick the box to agree before sending.',
  closed: 'This role is no longer taking applications.',
  throttled: 'Lots of people are applying right now. Please try again in a minute.',
  failed: "Something went wrong on our side. Your application wasn't sent. Please try again.",
  /** The post got no answer, so nobody knows whether it arrived: this one does not say "wasn't sent". */
  unreachable:
    "We couldn't reach the server, so we don't know whether your application was sent. Check your connection and try again.",
  /** The workspace changed what its form asks for while this visitor had it open. */
  formChanged: 'This form has just changed. Please check the new fields below and send again.',
} as const;

/** The fields this workspace's form shows. A CV link and a cover letter appear only when required. */
export function shownFields(form: ApplicationFormValues): ApplyField[] {
  const shown: Record<ApplyField, boolean> = {
    name: true, email: true, phone: true,
    cv_url: form.require_cv,
    cover_letter: form.require_cover_letter,
    portfolio_url: form.ask_portfolio,
    expected_salary: form.ask_expected_salary,
    consent: true,
  };
  return APPLY_FIELDS.filter((field) => shown[field]);
}

export function isRequired(field: ApplyField, form: ApplicationFormValues): boolean {
  if (field === 'name' || field === 'email' || field === 'consent') return true;
  if (field === 'cv_url') return form.require_cv;
  if (field === 'cover_letter') return form.require_cover_letter;
  return false;
}

/**
 * True when an answer has a problem with a field the open form does not show:
 * what the workspace asks for changed after the page was loaded. Such a
 * problem cannot be shown under its field, so the form has to be fetched again.
 */
export function isStaleForm(errors: ApplyErrors, shown: readonly ApplyField[]): boolean {
  return APPLY_FIELDS.some((field) => Boolean(errors[field]) && !shown.includes(field));
}

/** Counted the way the database counts: one per character, not per UTF-16 unit. */
export const countCharacters = (value: string) => [...value].length;
/** One line of text, as the database keeps a name or a phone: runs of spaces, tabs and line breaks become one space. */
export const oneLine = (value: string) => value.trim().replace(/\s+/g, ' ');
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_SHAPE = /^https?:\/\/\S+$/;

/** Ringgit as typed ("3500", "RM 3,500.50") to sen. Blank is null. */
export function ringgitToSen(text: string): number | null | 'invalid' {
  const typed = text.trim().replace(/^RM\s*/i, '');
  if (typed === '') return null;
  // Whole ringgit with optional thousands commas, and at most two decimals.
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(typed)) return 'invalid';
  const ringgit = Number(typed.replace(/,/g, ''));
  if (!Number.isFinite(ringgit) || ringgit > APPLY_LIMITS.salaryRinggit) return 'invalid';
  return Math.round(ringgit * 100);
}

function linkProblem(value: string, required: boolean, missing: string): string | null {
  const link = value.trim();
  if (link === '') return required ? missing : null;
  if (countCharacters(link) > APPLY_LIMITS.url) return APPLY_MESSAGES.urlTooLong;
  return URL_SHAPE.test(link) ? null : APPLY_MESSAGES.urlInvalid;
}

/** What is wrong with one field, or null. A field the form does not show is never wrong. */
export function fieldProblem(field: ApplyField, values: ApplyValues, form: ApplicationFormValues): string | null {
  if (!shownFields(form).includes(field)) return null;
  switch (field) {
    case 'name': {
      const name = oneLine(values.name);
      if (name === '') return APPLY_MESSAGES.name;
      return countCharacters(name) > APPLY_LIMITS.name ? APPLY_MESSAGES.nameTooLong : null;
    }
    case 'email': {
      const email = values.email.trim();
      if (email === '') return APPLY_MESSAGES.email;
      if (countCharacters(email) > APPLY_LIMITS.email) return APPLY_MESSAGES.emailTooLong;
      return EMAIL_SHAPE.test(email) ? null : APPLY_MESSAGES.emailInvalid;
    }
    case 'phone':
      return countCharacters(oneLine(values.phone)) > APPLY_LIMITS.phone ? APPLY_MESSAGES.phoneTooLong : null;
    case 'cv_url':
      return linkProblem(values.cv_url, form.require_cv, APPLY_MESSAGES.cvRequired);
    case 'cover_letter': {
      const letter = values.cover_letter.trim();
      if (letter === '') return form.require_cover_letter ? APPLY_MESSAGES.coverLetterRequired : null;
      return countCharacters(letter) > APPLY_LIMITS.cover_letter ? APPLY_MESSAGES.coverLetterTooLong : null;
    }
    case 'portfolio_url':
      return linkProblem(values.portfolio_url, false, '');
    case 'expected_salary':
      return ringgitToSen(values.expected_salary) === 'invalid' ? APPLY_MESSAGES.salaryInvalid : null;
    case 'consent':
      return values.consent ? null : APPLY_MESSAGES.consent;
  }
}

/** Every field with a problem, each with its own message. */
export function applyProblems(values: ApplyValues, form: ApplicationFormValues): ApplyErrors {
  const errors: ApplyErrors = {};
  for (const field of APPLY_FIELDS) {
    const problem = fieldProblem(field, values, form);
    if (problem) errors[field] = problem;
  }
  return errors;
}

/** The most of a first name the thank-you will carry. */
const FIRST_NAME_LIMIT = 60;

/**
 * The first word of a name, for the thank-you, cut at 60 characters: it can be
 * a word nothing has checked (a script's), and the thank-you must stay short.
 */
export function firstName(name: string): string {
  const first = oneLine(name).split(' ')[0] ?? '';
  return [...first].slice(0, FIRST_NAME_LIMIT).join('');
}
