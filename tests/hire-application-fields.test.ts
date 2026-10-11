import { describe, expect, it } from 'vitest';
import {
  APPLY_FIELDS, APPLY_LIMITS, APPLY_MESSAGES, EMPTY_APPLY_VALUES, applyProblems, fieldProblem,
  firstName, isRequired, ringgitToSen, shownFields,
} from '@/lib/hire/application-fields';

const OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const ALL = { require_cv: true, require_cover_letter: true, ask_portfolio: true, ask_expected_salary: true };
const good = { ...EMPTY_APPLY_VALUES, name: 'Aina Rahman', email: 'aina@example.com', consent: true };

describe('which fields a form shows', () => {
  it('asks for name, email, phone and consent when every switch is off', () => {
    expect(shownFields(OFF)).toEqual(['name', 'email', 'phone', 'consent']);
  });
  it('adds each field its switch turns on, in the fixed order', () => {
    expect(shownFields(ALL)).toEqual([...APPLY_FIELDS]);
    expect(shownFields({ ...OFF, ask_portfolio: true })).toEqual(['name', 'email', 'phone', 'portfolio_url', 'consent']);
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
});
