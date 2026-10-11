import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLY_HONEYPOT, APPLY_MESSAGES } from '@/lib/hire/application-fields';
import type { PublicJob } from '@/lib/hire/public-careers';

/**
 * The action a visitor's application goes through, called as the function it
 * is. The job reader and the sender are replaced; the field rules are real.
 */

const mocks = vi.hoisted(() => ({
  readPublicJob: vi.fn(),
  submitPublicApplication: vi.fn(),
  hasSupabaseEnv: vi.fn(),
}));

vi.mock('@/lib/hire/public-careers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/public-careers')>()),
  readPublicJob: mocks.readPublicJob,
}));
vi.mock('@/lib/hire/public-applications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/public-applications')>()),
  submitPublicApplication: mocks.submitPublicApplication,
}));
vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: mocks.hasSupabaseEnv }));
vi.mock('@/lib/supabase/anonymous', () => ({ createAnonymousClient: () => ({ anonymous: true }) }));

import * as actions from '@/app/careers/[orgId]/[jobId]/actions';

const { applyAction } = actions;

const ORG = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';

const NO_EXTRAS = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const ALL = { require_cv: true, require_cover_letter: true, ask_portfolio: true, ask_expected_salary: true };

const job = (over: Partial<PublicJob> = {}): PublicJob => ({
  id: JOB, title: 'Senior Accountant', department: 'Finance', location: 'Kuala Lumpur',
  workArrangement: 'hybrid', employmentType: 'full_time', closesOn: '2026-10-31', accepting: true,
  orgName: 'Tanjung Trading', headline: null, tagline: null, description: 'Keep the books.',
  salaryMinCents: null, salaryMaxCents: null, form: NO_EXTRAS,
  ...over,
});
/** The job reader's answer when the job is there. */
const found = (over: Partial<PublicJob> = {}) => ({ state: 'found' as const, job: job(over) });

/** What a browser posts: every text field, and `consent=on` only when the box is ticked. */
function post(over: Record<string, string | null> = {}): FormData {
  const fields: Record<string, string | null> = {
    name: 'Aisyah binti Rahman', email: 'aisyah@example.com', phone: '', consent: 'on', [APPLY_HONEYPOT]: '',
    ...over,
  };
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) formData.set(key, value);
  }
  return formData;
}

const VALUES = {
  name: 'Aisyah binti Rahman', email: 'aisyah@example.com', phone: '', cv_url: '', cover_letter: '',
  portfolio_url: '', expected_salary: '', consent: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasSupabaseEnv.mockReturnValue(true);
  mocks.readPublicJob.mockResolvedValue(found());
  mocks.submitPublicApplication.mockResolvedValue({ kind: 'ok' });
});

describe('what the file offers', () => {
  it('exports only async functions, as a "use server" file must', () => {
    for (const exported of Object.values(actions)) {
      expect(exported).toBeInstanceOf(Function);
      expect((exported as { constructor: { name: string } }).constructor.name).toBe('AsyncFunction');
    }
  });
});

describe('a call that carries no form', () => {
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a plain object', { name: 'Aisyah', consent: 'on' }],
    ['text', 'name=Aisyah'],
  ])('fails plainly, without throwing, reading or sending, when the last argument is %s', async (_what, last) => {
    expect(await applyAction(ORG, JOB, undefined, last as never)).toEqual({ error: APPLY_MESSAGES.failed });
    expect(mocks.readPublicJob).not.toHaveBeenCalled();
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });
});

describe('a filled honeypot', () => {
  it('is thanked by first name, with nothing read and nothing sent', async () => {
    const state = await applyAction(ORG, JOB, undefined, post({ [APPLY_HONEYPOT]: 'https://spam.example' }));
    expect(state).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.readPublicJob).not.toHaveBeenCalled();
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it('is thanked with no more than 60 characters of whatever it posted as a name', async () => {
    const state = await applyAction(ORG, JOB, undefined, post({ name: 'x'.repeat(4000), [APPLY_HONEYPOT]: 'x' }));
    expect(state).toEqual({ done: { firstName: 'x'.repeat(60) } });
  });

  it('is thanked even when the rest of the form is wrong', async () => {
    const state = await applyAction(ORG, JOB, undefined, post({ email: 'nope', consent: null, [APPLY_HONEYPOT]: 'x' }));
    expect(state).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.readPublicJob).not.toHaveBeenCalled();
  });
});

describe('an address that cannot be a job', () => {
  it.each([
    ['the workspace id', 'not-a-uuid', JOB],
    ['the job id', ORG, "1' or '1'='1"],
  ])('is closed, with nothing read and nothing sent, when %s is not a UUID', async (_what, orgId, jobId) => {
    expect(await applyAction(orgId, jobId, undefined, post())).toEqual({ closed: true });
    expect(mocks.readPublicJob).not.toHaveBeenCalled();
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it('is closed, with nothing read, on a site with no database', async () => {
    mocks.hasSupabaseEnv.mockReturnValue(false);
    expect(await applyAction(ORG, JOB, undefined, post())).toEqual({ closed: true });
    expect(mocks.readPublicJob).not.toHaveBeenCalled();
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });
});

describe('the job is read again by the action', () => {
  it('reads it with a client that carries no session', async () => {
    await applyAction(ORG, JOB, undefined, post());
    expect(mocks.readPublicJob).toHaveBeenCalledWith({ anonymous: true }, ORG, JOB);
  });

  it('is closed when there is no such job', async () => {
    mocks.readPublicJob.mockResolvedValue({ state: 'missing' });
    expect(await applyAction(ORG, JOB, undefined, post())).toEqual({ closed: true });
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it('says it failed, keeps what was typed and sends nothing when the job could not be read', async () => {
    mocks.readPublicJob.mockResolvedValue({ state: 'failed' });
    // Not "closed": a read that failed says nothing about the job.
    expect(await applyAction(ORG, JOB, undefined, post({ phone: '012-345 6789' }))).toEqual({
      error: APPLY_MESSAGES.failed, values: { ...VALUES, phone: '012-345 6789' },
    });
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it('is closed when the job has stopped taking applications', async () => {
    mocks.readPublicJob.mockResolvedValue(found({ accepting: false }));
    expect(await applyAction(ORG, JOB, undefined, post())).toEqual({ closed: true });
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it('takes what is required from the job, not from the post: no CV to a job that requires one', async () => {
    mocks.readPublicJob.mockResolvedValue(found({ form: { ...NO_EXTRAS, require_cv: true } }));
    // A post that claims nothing is required changes nothing.
    const state = await applyAction(ORG, JOB, undefined, post({ require_cv: 'false', form: '{"require_cv":false}' }));
    expect(state?.errors).toEqual({ cv_url: APPLY_MESSAGES.cvRequired });
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it('sends the job\'s own form with the application', async () => {
    mocks.readPublicJob.mockResolvedValue(found({ form: ALL }));
    const filled = {
      cv_url: 'https://example.com/cv.pdf', cover_letter: 'I close books on time.',
      portfolio_url: 'https://example.com/work', expected_salary: '3500',
    };
    await applyAction(ORG, JOB, undefined, post(filled));
    expect(mocks.submitPublicApplication).toHaveBeenCalledTimes(1);
    const [client, orgId, jobId, values, form] = mocks.submitPublicApplication.mock.calls[0];
    expect(client).toEqual({ anonymous: true });
    expect([orgId, jobId]).toEqual([ORG, JOB]);
    // Ringgit as typed: the sender converts it.
    expect(values).toEqual({ ...VALUES, ...filled });
    expect(form).toEqual(ALL);
  });
});

describe('a form with problems', () => {
  it('comes back with each problem and what was typed, and nothing is sent', async () => {
    const state = await applyAction(ORG, JOB, undefined, post({ name: ' ', email: 'aisyah@', phone: '012-345 6789' }));
    expect(state).toEqual({
      errors: { name: APPLY_MESSAGES.name, email: APPLY_MESSAGES.emailInvalid },
      values: { ...VALUES, name: ' ', email: 'aisyah@', phone: '012-345 6789' },
    });
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it.each([
    ['is not posted', null],
    ['is posted as anything but a ticked box', 'true'],
  ])('asks for consent when the box %s', async (_what, consent) => {
    const state = await applyAction(ORG, JOB, undefined, post({ consent }));
    expect(state?.errors).toEqual({ consent: APPLY_MESSAGES.consent });
    expect(state?.values?.consent).toBe(false);
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it('cuts a 10,000-character name at 9,000 before it is checked', async () => {
    const state = await applyAction(ORG, JOB, undefined, post({ name: 'a'.repeat(10000) }));
    expect(state?.errors).toEqual({ name: APPLY_MESSAGES.nameTooLong });
    expect(state?.values?.name).toHaveLength(9000);
  });

  it('does not cut a 4,000-character cover letter written in emoji, each of which is two units long', async () => {
    mocks.readPublicJob.mockResolvedValue(found({ form: { ...NO_EXTRAS, require_cover_letter: true } }));
    const letter = '😀'.repeat(4000);
    expect(letter).toHaveLength(8000);
    expect(await applyAction(ORG, JOB, undefined, post({ cover_letter: letter }))).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.submitPublicApplication.mock.calls[0][3].cover_letter).toBe(letter);
    // One more is one too many, and is said so: it is not cut down to fit.
    const state = await applyAction(ORG, JOB, undefined, post({ cover_letter: `${letter}😀` }));
    expect(state?.errors).toEqual({ cover_letter: APPLY_MESSAGES.coverLetterTooLong });
  });

  it('counts a line break of a posted cover letter once, as the browser counted it', async () => {
    mocks.readPublicJob.mockResolvedValue(found({ form: { ...NO_EXTRAS, require_cover_letter: true } }));
    // 4,000 characters as typed; a form post sends each of the 100 line breaks as two.
    const lines = Array.from({ length: 101 }, () => 'a'.repeat(39)).join('\r\n').slice(0, 4100);
    expect(lines.replace(/\r\n/g, '\n')).toHaveLength(4000);
    expect(await applyAction(ORG, JOB, undefined, post({ cover_letter: lines }))).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.submitPublicApplication.mock.calls[0][3].cover_letter).toBe(lines.replace(/\r\n/g, '\n'));
  });

  it('drops a NUL character, which the database would refuse as an error of ours', async () => {
    await applyAction(ORG, JOB, undefined, post({ name: 'Ai\u0000syah Rahman' }));
    expect(mocks.submitPublicApplication).toHaveBeenCalledTimes(1);
    expect(mocks.submitPublicApplication.mock.calls[0][3].name).toBe('Aisyah Rahman');
  });

  it('reads a field that is not text (a file) as empty', async () => {
    const formData = post();
    formData.set('name', new Blob(['Aisyah']), 'name.txt');
    const state = await applyAction(ORG, JOB, undefined, formData);
    expect(state?.errors).toEqual({ name: APPLY_MESSAGES.name });
    expect(state?.values?.name).toBe('');
  });
});

describe('what the sender answers', () => {
  it('ok: done, carrying the first name and nothing else', async () => {
    const state = await applyAction(ORG, JOB, undefined, post({ name: '  Aisyah   binti Rahman ' }));
    expect(state).toEqual({ done: { firstName: 'Aisyah' } });
  });

  it('closed: closed', async () => {
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'closed' });
    expect(await applyAction(ORG, JOB, undefined, post())).toEqual({ closed: true });
  });

  it('throttled: the try-again message, with what was typed', async () => {
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'throttled' });
    expect(await applyAction(ORG, JOB, undefined, post())).toEqual({ error: APPLY_MESSAGES.throttled, values: VALUES });
  });

  it('invalid: the field problems, with what was typed', async () => {
    const errors = { email: APPLY_MESSAGES.emailInvalid };
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'invalid', errors });
    expect(await applyAction(ORG, JOB, undefined, post())).toEqual({ errors, values: VALUES });
  });

  it('failed: the plain failure message, with what was typed', async () => {
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'failed' });
    expect(await applyAction(ORG, JOB, undefined, post())).toEqual({ error: APPLY_MESSAGES.failed, values: VALUES });
  });

  it('an answer it does not know reads as a failure', async () => {
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'something_new', id: 'abc' });
    expect(await applyAction(ORG, JOB, undefined, post())).toEqual({ error: APPLY_MESSAGES.failed, values: VALUES });
  });
});

describe('what never leaves the action', () => {
  it('logs nothing, whatever the outcome', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}));
    await applyAction(ORG, JOB, undefined, post());
    await applyAction(ORG, JOB, undefined, post({ email: 'nope' }));
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'failed' });
    await applyAction(ORG, JOB, undefined, post());
    await applyAction(ORG, JOB, undefined, post({ [APPLY_HONEYPOT]: 'x' }));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('ignores the state the browser sends back', async () => {
    const prev = { done: { firstName: 'Mallory' }, closed: true } as never;
    expect(await applyAction(ORG, JOB, prev, post({ email: 'nope' }))).toEqual({
      errors: { email: APPLY_MESSAGES.emailInvalid },
      values: { ...VALUES, email: 'nope' },
    });
  });
});
