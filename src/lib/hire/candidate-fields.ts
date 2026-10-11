// src/lib/hire/candidate-fields.ts
/**
 * The pure rules for a hand-entered candidate: the limits, the form's shape, the
 * sentences, and the message after an add. Client components import this, so it
 * holds no imports but types. The database enforces the same limits.
 */

export const CANDIDATE_LIMITS = {
  name: 120, email: 254, phone: 40, headline: 160, location: 120, source: 60,
  skills: 20, skill: 40, coverLetter: 4000, url: 500,
} as const;

export type CandidateFormValues = {
  name: string; email: string; phone: string; headline: string; location: string;
  skills: string; source: string; job_id: string; cover_letter: string; cv_url: string;
};

export const EMPTY_CANDIDATE_FORM: CandidateFormValues = {
  name: '', email: '', phone: '', headline: '', location: '',
  skills: '', source: '', job_id: '', cover_letter: '', cv_url: '',
};

/** A comma-separated line as a list: trimmed, blanks and repeats dropped (case-sensitive), in order. */
export function parseSkills(line: string): string[] {
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const part of line.split(',')) {
    const skill = part.trim();
    if (skill && !seen.has(skill)) {
      seen.add(skill);
      skills.push(skill);
    }
  }
  return skills;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC = 'That change could not be saved. Please try again.';
/**
 * An add with a CV file, refused before anyone was saved: the server cannot take a file just now (the
 * workspace's files are refused or its day's worth is used, the job is being flooded, or storage is not
 * set up). Not one of the database's words, so it is not in CANDIDATE_MESSAGES.
 */
export const CV_UPLOADS_REFUSED = 'CV files cannot be uploaded right now. Add the candidate without the file, or try again later.';

const tooLong = (label: string, max: number) => `Keep the ${label} to ${max} characters or fewer.`;

/** One sentence per wrong field. On an edit the job fields (job_id, cover_letter, cv_url) are ignored. */
export function candidateProblems(
  values: CandidateFormValues,
  forEdit: boolean,
): Partial<Record<keyof CandidateFormValues, string>> {
  const problems: Partial<Record<keyof CandidateFormValues, string>> = {};
  const name = values.name.trim();
  if (!name) problems.name = CANDIDATE_MESSAGES.invalid_name;
  else if (name.length > CANDIDATE_LIMITS.name) problems.name = tooLong('name', CANDIDATE_LIMITS.name);

  const email = values.email.trim();
  if (email.length > CANDIDATE_LIMITS.email) problems.email = tooLong('email', CANDIDATE_LIMITS.email);
  else if (email && !EMAIL_SHAPE.test(email)) problems.email = CANDIDATE_MESSAGES.invalid_email;

  for (const key of ['phone', 'headline', 'location', 'source'] as const) {
    if (values[key].trim().length > CANDIDATE_LIMITS[key]) problems[key] = tooLong(key, CANDIDATE_LIMITS[key]);
  }

  const skills = parseSkills(values.skills);
  if (skills.length > CANDIDATE_LIMITS.skills) problems.skills = `List at most ${CANDIDATE_LIMITS.skills} skills.`;
  else if (skills.some((s) => s.length > CANDIDATE_LIMITS.skill)) {
    problems.skills = `Keep each skill to ${CANDIDATE_LIMITS.skill} characters or fewer.`;
  }

  if (!forEdit) {
    if (values.cover_letter.trim().length > CANDIDATE_LIMITS.coverLetter) {
      problems.cover_letter = tooLong('cover note', CANDIDATE_LIMITS.coverLetter);
    }
    const url = values.cv_url.trim();
    if (url.length > CANDIDATE_LIMITS.url) problems.cv_url = tooLong('CV link', CANDIDATE_LIMITS.url);
    // The database's own shape: a lower-case scheme, something after it, and no space inside.
    else if (url && !/^https?:\/\/\S+$/.test(url)) problems.cv_url = CANDIDATE_MESSAGES.invalid_url;
  }
  return problems;
}

/** What the person is told for each word the database functions answer with. */
export const CANDIDATE_MESSAGES: Record<string, string> = {
  not_found: 'That candidate could not be found.',
  forbidden: 'You do not have permission to make changes here.',
  invalid_name: 'Enter the candidate\'s name.',
  invalid_email: 'Enter an email address like name@example.com.',
  email_taken: 'Another candidate already has this email.',
  job_not_found: 'That job could not be found.',
  job_not_open: 'Only an open or paused job can take a new application.',
  invalid_url: 'Enter a link that starts with https://',
  too_long: 'One of the details is too long.',
  // Four words are left to the generic sentence on purpose: nobody could act on a sentence of their own.
  // invalid_changes: a malformed request (an unknown field, skills that are not a list); the app's own schema never sends one.
  // already_attached, not_by_hand, invalid_path: answers about a CV file, which reach a person only as "The CV could not be attached."
};

export function candidateMessage(word: unknown): string {
  return typeof word === 'string' && Object.hasOwn(CANDIDATE_MESSAGES, word) ? CANDIDATE_MESSAGES[word] : GENERIC;
}

/** The sentence after an add, from what the database says it did. */
export function addedMessage(
  result: {
    name: string;
    job: string | null;
    candidate: 'created' | 'existing';
    application: 'created' | 'existing' | 'none';
  },
  cvNotAttached = false,
): string {
  const { name, job, candidate, application } = result;
  const title = job ?? 'the job';
  let text: string;
  if (application === 'created') {
    text = candidate === 'created'
      ? `Added ${name} and an application for ${title}.`
      : `${name} was already on file; added an application for ${title}.`;
  } else if (application === 'existing') {
    text = `${name} has already applied for ${title}. Nothing was changed.`;
  } else {
    text = candidate === 'created' ? `Added ${name}.` : `${name} is already on file. Nothing was changed.`;
  }
  return cvNotAttached ? `${text} The CV could not be attached.` : text;
}
