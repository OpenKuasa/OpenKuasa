// tests/hire-candidate-fields.test.ts
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_LIMITS, CANDIDATE_MESSAGES, CV_UPLOADS_REFUSED, EMPTY_CANDIDATE_FORM, addedMessage, candidateMessage, candidateProblems,
  parseSkills, type CandidateFormValues,
} from '@/lib/hire/candidate-fields';

const form = (over: Partial<CandidateFormValues> = {}): CandidateFormValues => ({ ...EMPTY_CANDIDATE_FORM, name: 'Aina', ...over });
const x = (n: number) => 'x'.repeat(n);

describe('CANDIDATE_LIMITS', () => {
  it('holds the agreed limits', () => {
    expect(CANDIDATE_LIMITS).toEqual({
      name: 120, email: 254, phone: 40, headline: 160, location: 120, source: 60, skills: 20, skill: 40, coverLetter: 4000, url: 500,
    });
  });
});

describe('parseSkills', () => {
  it('splits on commas, trims, drops blanks and repeats, keeps order', () => {
    expect(parseSkills('a, b,,a , c')).toEqual(['a', 'b', 'c']);
    expect(parseSkills('')).toEqual([]);
    expect(parseSkills('Sales, sales')).toEqual(['Sales', 'sales']);
  });
});

describe('candidateProblems', () => {
  it('accepts a minimal form', () => {
    expect(candidateProblems(form(), false)).toEqual({});
  });
  it('asks for a name', () => {
    expect(candidateProblems(form({ name: '   ' }), false).name).toBe('Enter the candidate\'s name.');
    expect(candidateProblems(form({ name: x(120) }), false).name).toBeUndefined();
    expect(candidateProblems(form({ name: x(121) }), false).name).toBe('Keep the name to 120 characters or fewer.');
  });
  it('checks each length at its edge', () => {
    const edges: [keyof CandidateFormValues, number][] = [['phone', 40], ['headline', 160], ['location', 120], ['source', 60]];
    for (const [key, n] of edges) {
      expect(candidateProblems(form({ [key]: x(n) }), false)[key]).toBeUndefined();
      expect(candidateProblems(form({ [key]: x(n + 1) }), false)[key]).toBe(`Keep the ${key} to ${n} characters or fewer.`);
    }
    expect(candidateProblems(form({ cover_letter: x(4000) }), false).cover_letter).toBeUndefined();
    expect(candidateProblems(form({ cover_letter: x(4001) }), false).cover_letter).toBe('Keep the cover note to 4000 characters or fewer.');
  });
  it('checks the email', () => {
    const email = (e: string) => candidateProblems(form({ email: e }), false).email;
    expect(email('')).toBeUndefined();
    expect(email('a@b.co')).toBeUndefined();
    expect(email(`${x(243)}@example.com`)).toBe('Keep the email to 254 characters or fewer.');
    expect(email(`${x(242)}@example.com`)).toBeUndefined();
    for (const bad of ['a', 'a@b', '@b.co', 'a b@c.co', 'a@@b.co']) {
      expect(email(bad)).toBe('Enter an email address like name@example.com.');
    }
  });
  it('checks skills', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `s${i}`).join(',');
    expect(candidateProblems(form({ skills: twenty }), false).skills).toBeUndefined();
    expect(candidateProblems(form({ skills: `${twenty},s20` }), false).skills).toBe('List at most 20 skills.');
    expect(candidateProblems(form({ skills: x(40) }), false).skills).toBeUndefined();
    expect(candidateProblems(form({ skills: x(41) }), false).skills).toBe('Keep each skill to 40 characters or fewer.');
  });
  it('checks the CV link', () => {
    const link = (v: string) => candidateProblems(form({ cv_url: v }), false).cv_url;
    expect(link('')).toBeUndefined();
    expect(link('https://a.co/cv.pdf')).toBeUndefined();
    expect(link('http://a.co/cv.pdf')).toBeUndefined();
    expect(link('ftp://a.co')).toBe('Enter a link that starts with https://');
    // As the database reads it: something after the scheme, no space inside, and the scheme in lower case.
    expect(link('https://')).toBe('Enter a link that starts with https://');
    expect(link('https://a b')).toBe('Enter a link that starts with https://');
    expect(link('HTTPS://a.co')).toBe('Enter a link that starts with https://');
    expect(link('http://a.co')).toBeUndefined();
    expect(link('javascript:alert(1)')).toBe('Enter a link that starts with https://');
    expect(link(`https://${x(492)}`)).toBeUndefined();
    expect(link(`https://${x(493)}`)).toBe('Keep the CV link to 500 characters or fewer.');
  });
  it('ignores the job fields on an edit', () => {
    const bad = form({ cv_url: 'nope', cover_letter: x(5000), job_id: 'x' });
    expect(candidateProblems(bad, true)).toEqual({});
    expect(Object.keys(candidateProblems(bad, false)).sort()).toEqual(['cover_letter', 'cv_url']);
  });
});

describe('candidateMessage', () => {
  const GENERIC = 'That change could not be saved. Please try again.';
  it('has every sentence verbatim', () => {
    expect(candidateMessage('not_found')).toBe('That candidate could not be found.');
    expect(candidateMessage('forbidden')).toBe('You do not have permission to make changes here.');
    expect(candidateMessage('invalid_name')).toBe('Enter the candidate\'s name.');
    expect(candidateMessage('invalid_email')).toBe('Enter an email address like name@example.com.');
    expect(candidateMessage('email_taken')).toBe('Another candidate already has this email.');
    expect(candidateMessage('job_not_found')).toBe('That job could not be found.');
    expect(candidateMessage('job_not_open')).toBe('Only an open or paused job can take a new application.');
    expect(candidateMessage('invalid_url')).toBe('Enter a link that starts with https://');
    expect(candidateMessage('too_long')).toBe('One of the details is too long.');
  });
  it('falls back for anything else', () => {
    for (const w of [undefined, null, 5, 'whatever', 'toString', '__proto__']) expect(candidateMessage(w)).toBe(GENERIC);
  });
  // The database can answer these four, and none is given a sentence of its own: there is nothing a person could do about it.
  it.each([
    // A malformed request (an unknown field, or skills that are not a list). The app's schema strips or refuses both first.
    ['invalid_changes'],
    // The three below are about a CV file. They never come this way: an add answers them as "The CV could not be attached."
    ['already_attached'],
    ['not_by_hand'],
    ['invalid_path'],
  ])('leaves %s to the generic sentence, on purpose', (word) => {
    expect(Object.hasOwn(CANDIDATE_MESSAGES, word)).toBe(false);
    expect(candidateMessage(word)).toBe(GENERIC);
  });
  it('says the CV sentence, and not a word\'s own, for a file the database would not attach', () => {
    const base = { name: 'Aina', job: 'Barista', candidate: 'created', application: 'created' } as const;
    expect(addedMessage(base, true)).toBe('Added Aina and an application for Barista. The CV could not be attached.');
  });
});

describe('CV_UPLOADS_REFUSED', () => {
  it('says what to do, and is not one of the database\'s words', () => {
    expect(CV_UPLOADS_REFUSED).toBe('CV files cannot be uploaded right now. Add the candidate without the file, or try again later.');
    expect(Object.values(CANDIDATE_MESSAGES)).not.toContain(CV_UPLOADS_REFUSED);
  });
});

describe('addedMessage', () => {
  const base = { name: 'Aina', job: null, candidate: 'created', application: 'none' } as const;
  it('says each of the five results', () => {
    expect(addedMessage(base)).toBe('Added Aina to the talent pool as Available.');
    expect(addedMessage({ ...base, job: 'Barista', application: 'created' })).toBe('Added Aina and an application for Barista.');
    expect(addedMessage({ ...base, job: 'Barista', candidate: 'existing', application: 'created' }))
      .toBe('Aina was already on file; added an application for Barista.');
    expect(addedMessage({ ...base, job: 'Barista', candidate: 'existing', application: 'existing' }))
      .toBe('Aina has already applied for Barista. Nothing was changed.');
    expect(addedMessage({ ...base, candidate: 'existing' })).toBe('Aina is already on file. Nothing was changed.');
  });
  it('appends the CV sentence when a file was not attached', () => {
    expect(addedMessage(base, true)).toBe('Added Aina to the talent pool as Available. The CV could not be attached.');
    expect(addedMessage(base, false)).toBe('Added Aina to the talent pool as Available.');
  });
});
