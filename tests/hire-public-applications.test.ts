import { describe, expect, it, vi } from 'vitest';
import { APPLY_MESSAGES, EMPTY_APPLY_VALUES, applyProblems, type ApplyValues } from '@/lib/hire/application-fields';
import { applicationInput, applyOutcome, submitPublicApplication } from '@/lib/hire/public-applications';

const ORG = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const ALL = { require_cv: true, require_cover_letter: true, ask_portfolio: true, ask_expected_salary: true };
const OPTIONAL = { ...ALL, require_cv: false, require_cover_letter: false };
const good: ApplyValues = { ...EMPTY_APPLY_VALUES, name: 'Aina Rahman', email: 'aina@example.com', consent: true };
const full: ApplyValues = {
  name: '  Aina Rahman ', email: ' Aina@Example.com ', phone: ' 012 345 6789 ', cv_url: ' https://example.com/cv ',
  cover_letter: ' Hello. ', portfolio_url: 'https://example.com/work', expected_salary: 'RM 3,500', consent: true,
};
const client = (result: unknown = { data: 'ok', error: null }) => {
  const rpc = vi.fn().mockResolvedValue(result);
  return { rpc, asClient: { rpc } as never };
};

describe('applicationInput', () => {
  const issues = (values: ApplyValues, form: typeof OFF) => {
    const result = applicationInput(form).safeParse(values);
    return result.success ? {} : Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
  };
  it('passes exactly when there are no problems', () => {
    expect(applicationInput(OFF).safeParse(good).success).toBe(true);
    expect(applyProblems(good, OFF)).toEqual({});
  });
  it('reports two wrong fields with the same messages on the same paths', () => {
    const values = { ...good, name: '', email: 'nope' };
    expect(applicationInput(OFF).safeParse(values).success).toBe(false);
    expect(issues(values, OFF)).toEqual(applyProblems(values, OFF));
    expect(issues(values, OFF)).toEqual({ name: APPLY_MESSAGES.name, email: APPLY_MESSAGES.emailInvalid });
  });
  it('ignores a wrong field the form does not show, and reports it when shown', () => {
    const values = { ...good, portfolio_url: 'nonsense' };
    expect(applicationInput(OFF).safeParse(values).success).toBe(true);
    expect(issues(values, OPTIONAL)).toEqual({ portfolio_url: APPLY_MESSAGES.urlInvalid });
  });
});

describe('applyOutcome', () => {
  it('reads the good and refusing words', () => {
    expect(applyOutcome('ok')).toEqual({ kind: 'ok' });
    expect(applyOutcome('closed')).toEqual({ kind: 'closed' });
    expect(applyOutcome('not_found')).toEqual({ kind: 'closed' });
    expect(applyOutcome('throttled')).toEqual({ kind: 'throttled' });
  });
  it('reads a repeat application as a duplicate and a refused file path as a failure', () => {
    expect(applyOutcome('ok_duplicate')).toEqual({ kind: 'duplicate' });
    expect(applyOutcome('invalid_cv_path')).toEqual({ kind: 'failed' });
  });
  it.each([
    ['name_too_long', 'name', 'nameTooLong'],
    ['invalid_name', 'name', 'name'],
    ['email_too_long', 'email', 'emailTooLong'],
    ['invalid_email', 'email', 'emailInvalid'],
    ['phone_too_long', 'phone', 'phoneTooLong'],
    ['cover_letter_too_long', 'cover_letter', 'coverLetterTooLong'],
    ['cover_letter_required', 'cover_letter', 'coverLetterRequired'],
    ['cv_required', 'cv_url', 'cvRequired'],
    ['consent_required', 'consent', 'consent'],
    ['invalid_salary', 'expected_salary', 'salaryInvalid'],
  ] as const)('maps %s to a message on %s', (word, field, message) => {
    expect(applyOutcome(word)).toEqual({ kind: 'invalid', errors: { [field]: APPLY_MESSAGES[message] } });
  });
  it('treats link words and anything unknown as a failure', () => {
    for (const word of ['url_too_long', 'invalid_url', null, undefined, 42, 'surprise']) {
      expect(applyOutcome(word), String(word)).toEqual({ kind: 'failed' });
    }
  });
});

describe('submitPublicApplication', () => {
  it('sends the function the named arguments, trimmed, with the email as typed', async () => {
    const c = client();
    expect(await submitPublicApplication(c.asClient, ORG, JOB, full, ALL)).toEqual({ kind: 'ok' });
    expect(c.rpc).toHaveBeenCalledWith('submit_public_application', {
      p_org_id: ORG, p_job_id: JOB, p_name: 'Aina Rahman', p_email: 'Aina@Example.com', p_phone: '012 345 6789',
      p_cover_letter: 'Hello.', p_cv_url: 'https://example.com/cv', p_portfolio_url: 'https://example.com/work',
      p_expected_salary_cents: 350000, p_consent: true, p_honeypot: null,
    });
  });
  it('sends blank optional fields as null and the honeypot text as given', async () => {
    const c = client();
    await submitPublicApplication(c.asClient, ORG, JOB, good, OPTIONAL, 'spam');
    expect(c.rpc).toHaveBeenCalledWith('submit_public_application', expect.objectContaining({
      p_phone: null, p_cover_letter: null, p_cv_url: null, p_portfolio_url: null, p_expected_salary_cents: null, p_honeypot: 'spam',
    }));
  });
  it('sends null for a field the form does not show, even if a value was posted', async () => {
    const c = client();
    await submitPublicApplication(c.asClient, ORG, JOB, full, OFF);
    expect(c.rpc).toHaveBeenCalledWith('submit_public_application', expect.objectContaining({
      p_cv_url: 'https://example.com/cv', p_cover_letter: null, p_portfolio_url: null, p_expected_salary_cents: null,
    }));
  });
  it('never sends values that fail the checks', async () => {
    const c = client();
    const result = await submitPublicApplication(c.asClient, ORG, JOB, { ...good, email: 'nope', consent: false }, OFF);
    expect(result).toEqual({ kind: 'invalid', errors: { email: APPLY_MESSAGES.emailInvalid, consent: APPLY_MESSAGES.consent } });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it('treats an id that is not a UUID as closed, without calling', async () => {
    const c = client();
    expect(await submitPublicApplication(c.asClient, 'x', JOB, good, OFF)).toEqual({ kind: 'closed' });
    expect(await submitPublicApplication(c.asClient, ORG, 'x', good, OFF)).toEqual({ kind: 'closed' });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it('maps the answer word to an outcome', async () => {
    expect(await submitPublicApplication(client({ data: 'closed', error: null }).asClient, ORG, JOB, good, OFF)).toEqual({ kind: 'closed' });
  });
  it('fails, and logs no form value, when the call errors or throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const errored = client({ data: 'ok', error: { code: '42501', message: 'denied' } });
    expect(await submitPublicApplication(errored.asClient, ORG, JOB, full, ALL)).toEqual({ kind: 'failed' });
    const thrown = { rpc: vi.fn().mockRejectedValue(new Error('network down')) } as never;
    expect(await submitPublicApplication(thrown, ORG, JOB, full, ALL)).toEqual({ kind: 'failed' });
    expect(spy).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain('submit_public_application');
    expect(logged).toContain('42501');
    for (const secret of ['Aina', 'example.com', '012 345', 'Hello']) expect(logged).not.toContain(secret);
    spy.mockRestore();
  });
});

describe('a CV file path', () => {
  const PATH = `${ORG}/${JOB}/33333333-3333-4333-8333-333333333333.pdf`;
  it('is sent as p_cv_path, and meets a required CV with no link', async () => {
    const c = client();
    const values = { ...good, cover_letter: 'Hello.' };
    expect(await submitPublicApplication(c.asClient, ORG, JOB, values, ALL, null, PATH)).toEqual({ kind: 'ok' });
    expect(c.rpc).toHaveBeenCalledWith('submit_public_application', expect.objectContaining({ p_cv_path: PATH }));
  });
  it('is left out of the arguments when none is given', async () => {
    const c = client();
    await submitPublicApplication(c.asClient, ORG, JOB, good, OFF);
    expect(c.rpc.mock.calls[0][1]).not.toHaveProperty('p_cv_path');
  });
  it('does not meet a required CV when there is no path', async () => {
    const c = client();
    const result = await submitPublicApplication(c.asClient, ORG, JOB, { ...good, cover_letter: 'Hello.' }, ALL);
    expect(result).toEqual({ kind: 'invalid', errors: { cv_url: APPLY_MESSAGES.cvRequired } });
    expect(c.rpc).not.toHaveBeenCalled();
  });
});

describe('what reaches the database is what the page counted', () => {
  it('sends the name and phone as one line, so runs of spaces cannot push them over the limit', async () => {
    // 119 characters once collapsed, 177 as typed: fine on the page, too long if sent as typed.
    const name = Array.from({ length: 30 }, () => 'abc').join('   ');
    expect(name.length).toBeGreaterThan(120);
    expect(applyProblems({ ...good, name }, OFF)).toEqual({});
    const c = client();
    expect(await submitPublicApplication(c.asClient, ORG, JOB, { ...good, name, phone: ' 012   345\t6789 ' }, OFF)).toEqual({ kind: 'ok' });
    const sent = c.rpc.mock.calls[0][1] as { p_name: string; p_phone: string };
    expect(sent.p_name).toBe(name.trim().replace(/\s+/g, ' '));
    expect(sent.p_name.length).toBeLessThanOrEqual(120);
    expect(sent.p_phone).toBe('012 345 6789');
  });
  it('answers a post with the wrong kinds of value as a failure, without throwing and without calling the database', async () => {
    const c = client();
    for (const broken of [
      { ...good, phone: null }, { ...good, name: 42 }, { ...good, consent: 'on' }, { name: 'A', email: 'a@b.co' }, null,
    ]) {
      expect(await submitPublicApplication(c.asClient, ORG, JOB, broken as never, ALL)).toEqual({ kind: 'failed' });
    }
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it('logs only a code when the database call fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // An error whose message echoes what was sent must not carry it into the log.
      const errored = client({ data: null, error: { code: '22P02', message: `invalid input: ${full.email} ${full.name}`, details: full.name } });
      expect(await submitPublicApplication(errored.asClient, ORG, JOB, full, ALL)).toEqual({ kind: 'failed' });
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain('22P02');
      expect(logged).not.toContain('Aina');
      expect(logged.toLowerCase()).not.toContain('example.com');
    } finally {
      spy.mockRestore();
    }
  });
});

