import { describe, expect, it } from 'vitest';
import {
  APPLY_FIELDS, APPLY_HONEYPOT, APPLY_LIMITS, APPLY_MESSAGES, EMPTY_APPLY_VALUES, applyProblems, chosenFile, countCharacters,
  cvFileProblem, fieldProblem, fileSizeLabel, firstName, isRequired, isStaleForm, ringgitToSen, shownFields,
} from '@/lib/hire/application-fields';

const OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const ALL = { require_cv: true, require_cover_letter: true, ask_portfolio: true, ask_expected_salary: true };
const good = { ...EMPTY_APPLY_VALUES, name: 'Aina Rahman', email: 'aina@example.com', consent: true };

describe('which fields a form shows', () => {
  it('asks for name, email, phone, a CV and consent when every switch is off', () => {
    expect(shownFields(OFF)).toEqual(['name', 'email', 'phone', 'cv_url', 'consent']);
  });
  it('adds each field its switch turns on, in the fixed order', () => {
    expect(shownFields(ALL)).toEqual([...APPLY_FIELDS]);
    expect(shownFields({ ...OFF, ask_portfolio: true })).toEqual(['name', 'email', 'phone', 'cv_url', 'portfolio_url', 'consent']);
  });
  it('requires name, email and consent always, a CV and cover letter only when switched on, the rest never', () => {
    for (const field of ['name', 'email', 'consent'] as const) expect(isRequired(field, OFF)).toBe(true);
    expect(isRequired('cv_url', OFF)).toBe(false);
    expect(isRequired('cv_url', ALL)).toBe(true);
    expect(isRequired('cover_letter', ALL)).toBe(true);
    for (const field of ['phone', 'portfolio_url', 'expected_salary'] as const) expect(isRequired(field, ALL)).toBe(false);
  });
});

describe('checking what was typed', () => {
  it('accepts the least a form can ask for', () => {
    expect(applyProblems(good, OFF)).toEqual({});
  });
  it('says what is wrong with each field, in words that say how to fix it', () => {
    expect(applyProblems({ ...EMPTY_APPLY_VALUES }, OFF)).toEqual({
      name: APPLY_MESSAGES.name, email: APPLY_MESSAGES.email, consent: APPLY_MESSAGES.consent,
    });
    expect(fieldProblem('email', { ...good, email: 'aina@' }, OFF)).toBe(APPLY_MESSAGES.emailInvalid);
    expect(fieldProblem('name', { ...good, name: 'x'.repeat(121) }, OFF)).toBe(APPLY_MESSAGES.nameTooLong);
    expect(fieldProblem('phone', { ...good, phone: '1'.repeat(41) }, OFF)).toBe(APPLY_MESSAGES.phoneTooLong);
  });
  it('requires a CV link and a cover letter only when the workspace does', () => {
    expect(applyProblems(good, ALL)).toEqual({ cv_url: APPLY_MESSAGES.cvRequired, cover_letter: APPLY_MESSAGES.coverLetterRequired });
    expect(applyProblems({ ...good, cv_url: 'https://example.com/cv', cover_letter: 'Hello.' }, ALL)).toEqual({});
  });
  it('takes only http and https links, and nothing with a space', () => {
    for (const bad of ['example.com/cv', 'javascript:alert(1)', 'ftp://x.y/z', 'https://exa mple.com']) {
      expect(fieldProblem('cv_url', { ...good, cv_url: bad }, ALL), bad).toBe(APPLY_MESSAGES.urlInvalid);
      expect(fieldProblem('portfolio_url', { ...good, portfolio_url: bad }, ALL), bad).toBe(APPLY_MESSAGES.urlInvalid);
    }
    expect(fieldProblem('cv_url', { ...good, cv_url: 'https://x.y/' + 'a'.repeat(500) }, ALL)).toBe(APPLY_MESSAGES.urlTooLong);
    expect(fieldProblem('portfolio_url', { ...good, portfolio_url: 'http://example.com/work' }, ALL)).toBeNull();
  });
  it('counts a cover letter the way the database does and stops at 4,000', () => {
    expect(fieldProblem('cover_letter', { ...good, cover_letter: '😀'.repeat(APPLY_LIMITS.cover_letter) }, ALL)).toBeNull();
    expect(fieldProblem('cover_letter', { ...good, cover_letter: '😀'.repeat(APPLY_LIMITS.cover_letter + 1) }, ALL)).toBe(APPLY_MESSAGES.coverLetterTooLong);
  });
  it('ignores a field the form does not show', () => {
    expect(applyProblems({ ...good, portfolio_url: 'nonsense', expected_salary: 'lots' }, OFF)).toEqual({});
  });
});

describe('expected salary', () => {
  it('reads ringgit as typed and gives sen', () => {
    expect(ringgitToSen('3500')).toBe(350000);
    expect(ringgitToSen(' RM 3,500.50 ')).toBe(350050);
    expect(ringgitToSen('')).toBeNull();
    expect(ringgitToSen('   ')).toBeNull();
    // Two decimals at most, so the rounding is exact.
    expect(ringgitToSen('1234.56')).toBe(123456);
    expect(ringgitToSen('0.29')).toBe(29);
    expect(ringgitToSen('999999.99')).toBe(99999999);
    expect(ringgitToSen('007')).toBe(700);
    expect(ringgitToSen('0')).toBe(0);
    expect(ringgitToSen('0.00')).toBe(0);
    for (const bad of ['5.', '+5', '３５００', '9'.repeat(400)]) expect(ringgitToSen(bad), bad).toBe('invalid');
  });
  it('refuses what is not an amount, a negative, or an absurd one', () => {
    for (const bad of ['lots', '-5', '3.5.0', '1e9', '3,5', '12.345']) expect(ringgitToSen(bad), bad).toBe('invalid');
    expect(ringgitToSen(String(APPLY_LIMITS.salaryRinggit))).toBe(APPLY_LIMITS.salaryRinggit * 100);
    expect(ringgitToSen(String(APPLY_LIMITS.salaryRinggit + 1))).toBe('invalid');
    expect(fieldProblem('expected_salary', { ...good, expected_salary: 'lots' }, ALL)).toBe(APPLY_MESSAGES.salaryInvalid);
  });
});

describe('the name on the thank-you', () => {
  it('is the first word of the name, and never empty', () => {
    expect(firstName('  Aina   Rahman ')).toBe('Aina');
    expect(firstName('')).toBe('');
  });
  it('is never longer than 60 characters, however long the first word', () => {
    expect(firstName('Aina Rahman')).toBe('Aina');
    expect(firstName(`${'a'.repeat(60)} Rahman`)).toBe('a'.repeat(60));
    expect(firstName('a'.repeat(61))).toBe('a'.repeat(60));
    expect(firstName('a'.repeat(5000))).toHaveLength(60);
    // Counted in characters: an emoji is one, and is never cut in half.
    expect(firstName('😀'.repeat(100))).toBe('😀'.repeat(60));
  });
});

describe('counting characters', () => {
  it('counts one per character, as the database does, not one per unit', () => {
    expect(countCharacters('')).toBe(0);
    expect(countCharacters('abc')).toBe(3);
    expect(countCharacters('😀a')).toBe(2);
    expect(countCharacters('😀'.repeat(APPLY_LIMITS.cover_letter))).toBe(APPLY_LIMITS.cover_letter);
    expect(countCharacters('a\nb')).toBe(3);
  });
});

describe('the words for a post that did not arrive', () => {
  it('says the outcome is not known, and to try again', () => {
    expect(APPLY_MESSAGES.unreachable).toBe(
      "We couldn't reach the server, so we don't know whether your application was sent. Check your connection and try again.",
    );
  });
});

describe('a form whose requirements changed while it was open', () => {
  it('is stale when the answer has a problem with a field the form does not show', () => {
    expect(isStaleForm({ portfolio_url: APPLY_MESSAGES.urlInvalid }, shownFields(OFF))).toBe(true);
    expect(isStaleForm({ email: APPLY_MESSAGES.email, cover_letter: APPLY_MESSAGES.coverLetterRequired }, shownFields(OFF))).toBe(true);
    expect(isStaleForm({ expected_salary: APPLY_MESSAGES.salaryInvalid }, shownFields({ ...OFF, ask_portfolio: true }))).toBe(true);
  });
  it('is not stale when every problem is with a field the form shows, or there is none', () => {
    expect(isStaleForm({}, shownFields(OFF))).toBe(false);
    expect(isStaleForm({ name: APPLY_MESSAGES.name, consent: APPLY_MESSAGES.consent }, shownFields(OFF))).toBe(false);
    expect(isStaleForm({ cv_url: APPLY_MESSAGES.cvRequired }, shownFields({ ...OFF, require_cv: true }))).toBe(false);
    expect(isStaleForm(applyProblems({ ...EMPTY_APPLY_VALUES }, ALL), shownFields(ALL))).toBe(false);
  });
  it('does not count a field named with no message', () => {
    expect(isStaleForm({ portfolio_url: undefined }, shownFields(OFF))).toBe(false);
    expect(isStaleForm({ portfolio_url: '' }, shownFields(OFF))).toBe(false);
  });
  it('has its own words', () => {
    expect(APPLY_MESSAGES.formChanged).toBe('This form has just changed. Please check the new fields below and send again.');
  });
});

const MB = 1024 * 1024;
const PDF_TYPE = 'application/pdf';

describe('the size of a file, in words', () => {
  it('gives one decimal for megabytes and whole kilobytes', () => {
    expect(fileSizeLabel(7.2 * MB)).toBe('7.2 MB');
    expect(fileSizeLabel(480 * 1024)).toBe('480 KB');
    expect(fileSizeLabel(5 * MB)).toBe('5.0 MB');
  });
});

describe('which value counts as a chosen file', () => {
  it('is nothing for the untouched input, text or null', () => {
    expect(chosenFile({ name: '', size: 0, type: 'application/octet-stream' })).toBeNull();
    expect(chosenFile('text')).toBeNull();
    expect(chosenFile(null)).toBeNull();
  });
  it('keeps the name, size and type and nothing else', () => {
    expect(chosenFile({ name: 'cv.pdf', size: 10, type: PDF_TYPE, extra: 'x' })).toEqual({ name: 'cv.pdf', size: 10, type: PDF_TYPE });
  });
});

describe('what is wrong with a chosen CV file', () => {
  it('is nothing for no file or a small PDF', () => {
    expect(cvFileProblem(null)).toBeNull();
    expect(cvFileProblem({ name: 'cv.pdf', size: 10, type: PDF_TYPE })).toBeNull();
    expect(cvFileProblem({ name: 'CV.PDF', size: 10, type: '' })).toBeNull();
  });
  it('asks for a PDF when the file is empty or not a PDF', () => {
    expect(cvFileProblem({ name: 'cv.pdf', size: 0, type: PDF_TYPE })).toBe('Choose a PDF file.');
    expect(cvFileProblem({
      name: 'cv.docx', size: 10, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })).toBe('Choose a PDF file.');
    expect(cvFileProblem({ name: 'cv.pdf', size: 10, type: 'application/octet-stream' })).toBeNull();
    expect(cvFileProblem({ name: 'cv.txt', size: 10, type: 'text/plain' })).toBe('Choose a PDF file.');
    expect(cvFileProblem({ name: 'scan', size: 10, type: 'application/pdf' })).toBeNull();
  });
  it('names the size when the file is over 5 MB', () => {
    expect(cvFileProblem({ name: 'cv.pdf', size: 7.2 * MB, type: PDF_TYPE })).toBe('This file is 7.2 MB. Choose one under 5 MB.');
  });
});

describe('a CV file meets the CV requirement', () => {
  it('needs a link or a file when the workspace requires a CV', () => {
    const values = { ...good, cover_letter: 'Hello.' };
    expect(applyProblems(values, ALL).cv_url).toBe('Upload a PDF or paste a link to your CV.');
    expect(applyProblems(values, ALL, true)).not.toHaveProperty('cv_url');
    expect(fieldProblem('cv_url', values, ALL, true)).toBeNull();
  });
  it('still refuses a bad link when a file is chosen', () => {
    expect(fieldProblem('cv_url', { ...good, cv_url: 'example.com/cv' }, ALL, true)).toBe(APPLY_MESSAGES.urlInvalid);
  });
});

describe('the field no person sees', () => {
  it('has the name the public lead form uses, which no browser fills in for a person', () => {
    expect(APPLY_HONEYPOT).toBe('referral_code');
  });
});
