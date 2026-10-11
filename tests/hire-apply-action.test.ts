import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLY_HONEYPOT, APPLY_MESSAGES, CV_FILE_FIELD, CV_MAX_BYTES } from '@/lib/hire/application-fields';
import type { PublicJob } from '@/lib/hire/public-careers';

/**
 * The action a visitor's application goes through, called as the function it
 * is. The job reader, the sender, the CV store's two writes and the service
 * client are replaced; the field rules and the PDF check are real.
 */

const mocks = vi.hoisted(() => ({
  readPublicJob: vi.fn(),
  submitPublicApplication: vi.fn(),
  hasSupabaseEnv: vi.fn(),
  storeCv: vi.fn(),
  removeCv: vi.fn(),
  serviceClient: vi.fn(),
  /** The service client's one call here: has this job had too many applications just now? */
  rpc: vi.fn(),
}));

vi.mock('@/lib/hire/public-careers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/public-careers')>()),
  readPublicJob: mocks.readPublicJob,
}));
vi.mock('@/lib/hire/public-applications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/public-applications')>()),
  submitPublicApplication: mocks.submitPublicApplication,
}));
// `isPdf` stays real: the bytes decide what is a PDF, and the tests below rely on it.
vi.mock('@/lib/hire/cv-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/cv-store')>()),
  storeCv: mocks.storeCv,
  removeCv: mocks.removeCv,
}));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: mocks.serviceClient }));
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

/** The service client the action is handed. */
const SERVICE = { service: true, rpc: mocks.rpc };
/** Where the store says it put the file. */
const PATH = `${ORG}/${JOB}/33333333-3333-4333-8333-333333333333.pdf`;
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');

/** A post with a file in the CV input, as a browser sends one. */
function withFile(
  fields: Record<string, string | null>,
  bytes: Uint8Array,
  name = 'cv.pdf',
  type = 'application/pdf',
): FormData {
  const formData = post(fields);
  formData.set(CV_FILE_FIELD, new File([bytes as BlobPart], name, { type }));
  return formData;
}

/** Something posted without a browser, with `odd` where the file would be. */
const withOdd = (odd: unknown) => {
  const formData = post();
  return { get: (key: string) => (key === CV_FILE_FIELD ? odd : formData.get(key)) } as never;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasSupabaseEnv.mockReturnValue(true);
  mocks.readPublicJob.mockResolvedValue(found());
  mocks.submitPublicApplication.mockResolvedValue({ kind: 'ok' });
  mocks.serviceClient.mockReturnValue(SERVICE);
  mocks.rpc.mockResolvedValue({ data: false, error: null });
  mocks.storeCv.mockResolvedValue(PATH);
  mocks.removeCv.mockResolvedValue(true);
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

describe('a post with no file in it', () => {
  it('takes the path it always took when the file input was left untouched', async () => {
    // What a browser posts for a file input nobody touched: an empty file with no name.
    const formData = withFile({}, new Uint8Array(0), '', 'application/octet-stream');
    expect(await applyAction(ORG, JOB, undefined, formData)).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.submitPublicApplication).toHaveBeenCalledTimes(1);
    expect(mocks.submitPublicApplication.mock.calls[0]).toEqual([{ anonymous: true }, ORG, JOB, VALUES, NO_EXTRAS]);
    expect(mocks.serviceClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.storeCv).not.toHaveBeenCalled();
    expect(mocks.removeCv).not.toHaveBeenCalled();
  });

  it('does not say a file was lost when a form with problems carried none', async () => {
    const state = await applyAction(ORG, JOB, undefined, withFile({ email: 'nope' }, new Uint8Array(0), ''));
    expect(state).toEqual({ errors: { email: APPLY_MESSAGES.emailInvalid }, values: { ...VALUES, email: 'nope' } });
    expect(state && 'fileDropped' in state).toBe(false);
  });

  it('thanks a repeat application like a new one', async () => {
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'duplicate' });
    expect(await applyAction(ORG, JOB, undefined, post())).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.removeCv).not.toHaveBeenCalled();
  });

  it('asks for a CV when one is required and there is neither a link nor a file', async () => {
    mocks.readPublicJob.mockResolvedValue(found({ form: { ...NO_EXTRAS, require_cv: true } }));
    const state = await applyAction(ORG, JOB, undefined, withFile({}, new Uint8Array(0), ''));
    expect(state?.errors).toEqual({ cv_url: 'Upload a PDF or paste a link to your CV.' });
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
    expect(mocks.storeCv).not.toHaveBeenCalled();
  });
});

describe('a post with a PDF', () => {
  it('asks whether the job is throttled, stores the file, sends with the service client and the path, and thanks', async () => {
    const state = await applyAction(ORG, JOB, undefined, withFile({ phone: '012-345 6789' }, PDF));
    expect(state).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'hire_cv_files_refused', { p_org_id: ORG });
    expect(mocks.rpc).toHaveBeenCalledWith('hire_apply_throttled', { p_job_id: JOB });
    expect(mocks.storeCv).toHaveBeenCalledTimes(1);
    const [service, orgId, jobId, bytes] = mocks.storeCv.mock.calls[0];
    expect(service).toBe(SERVICE);
    expect([orgId, jobId]).toEqual([ORG, JOB]);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual([...PDF]);
    expect(mocks.submitPublicApplication).toHaveBeenCalledTimes(1);
    const sent = mocks.submitPublicApplication.mock.calls[0];
    expect(sent[0]).toBe(SERVICE);
    expect(sent.slice(1)).toEqual([ORG, JOB, { ...VALUES, phone: '012-345 6789' }, NO_EXTRAS, null, PATH]);
    expect(mocks.removeCv).not.toHaveBeenCalled();
    // In this order: nothing is stored for a job that is throttled, and nothing is sent before the file is stored.
    const order = [mocks.rpc, mocks.storeCv, mocks.submitPublicApplication].map((mock) => mock.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('takes the workspace and the job from the route, whatever the post claims', async () => {
    const other = '99999999-9999-4999-8999-999999999999';
    await applyAction(ORG, JOB, undefined, withFile({ org_id: other, job_id: other, p_cv_path: `${other}/${other}/x.pdf`, cv_path: 'x' }, PDF));
    expect(mocks.storeCv.mock.calls[0].slice(1, 3)).toEqual([ORG, JOB]);
    expect(mocks.submitPublicApplication.mock.calls[0].slice(1, 3)).toEqual([ORG, JOB]);
    expect(mocks.submitPublicApplication.mock.calls[0][6]).toBe(PATH);
  });

  it('meets a required CV without a link', async () => {
    mocks.readPublicJob.mockResolvedValue(found({ form: { ...NO_EXTRAS, require_cv: true } }));
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.submitPublicApplication.mock.calls[0][6]).toBe(PATH);
  });

  it('is taken with a link beside it', async () => {
    const state = await applyAction(ORG, JOB, undefined, withFile({ cv_url: 'https://example.com/cv' }, PDF));
    expect(state).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.submitPublicApplication.mock.calls[0][3].cv_url).toBe('https://example.com/cv');
  });

  it('is a PDF by its bytes when the browser declared no type', async () => {
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF, 'cv.PDF', ''))).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.storeCv).toHaveBeenCalledTimes(1);
  });
});

describe('a file that is not a CV we take', () => {
  const nothingStored = () => {
    expect(mocks.serviceClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.storeCv).not.toHaveBeenCalled();
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  };

  it('refuses a text file named cv.pdf and declared a PDF: the bytes decide', async () => {
    const text = new TextEncoder().encode('Curriculum vitae of Aisyah. %PDF- is not how this begins.');
    expect(await applyAction(ORG, JOB, undefined, withFile({}, text))).toEqual({
      errors: { cv_file: 'Choose a PDF file.' }, values: VALUES, fileDropped: true,
    });
    nothingStored();
  });

  it.each([
    ['a picture', 'me.png', 'image/png'],
    ['a document', 'cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['a text file by name and type', 'cv.txt', 'text/plain'],
  ])('refuses %s, even one that begins like a PDF', async (_what, name, type) => {
    const state = await applyAction(ORG, JOB, undefined, withFile({}, PDF, name, type));
    expect(state).toEqual({ errors: { cv_file: APPLY_MESSAGES.cvFileType }, values: VALUES, fileDropped: true });
    nothingStored();
  });

  it('refuses an empty file that has a name', async () => {
    const state = await applyAction(ORG, JOB, undefined, withFile({}, new Uint8Array(0)));
    expect(state).toEqual({ errors: { cv_file: APPLY_MESSAGES.cvFileType }, values: VALUES, fileDropped: true });
    nothingStored();
  });

  it('refuses a file one byte over 5 MB, and says how big it is', async () => {
    const big = new Uint8Array(CV_MAX_BYTES + 1);
    big.set(PDF);
    const state = await applyAction(ORG, JOB, undefined, withFile({}, big));
    expect(state?.errors?.cv_file).toMatch(/^This file is 5\.0 MB\. Choose one under 5 MB\.$/);
    expect(Object.keys(state?.errors ?? {})).toEqual(['cv_file']);
    expect(state?.fileDropped).toBe(true);
    expect(state?.values).toEqual(VALUES);
    nothingStored();
  });

  it('takes a PDF of exactly 5 MB', async () => {
    const most = new Uint8Array(CV_MAX_BYTES);
    most.set(PDF);
    expect(await applyAction(ORG, JOB, undefined, withFile({}, most))).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.storeCv.mock.calls[0][3]).toHaveLength(CV_MAX_BYTES);
  });

  it('does not trust the size a file declares: the bytes are counted', async () => {
    const big = new Uint8Array(CV_MAX_BYTES + 1);
    big.set(PDF);
    // Something posted directly, claiming to be small.
    const liar = { name: 'cv.pdf', type: 'application/pdf', size: 10, arrayBuffer: async () => big.buffer };
    expect(await applyAction(ORG, JOB, undefined, withOdd(liar))).toEqual({
      errors: { cv_file: APPLY_MESSAGES.cvFileTooBig('5.0 MB') }, values: VALUES, fileDropped: true,
    });
    nothingStored();
  });

  it.each([
    ['cannot be read', { name: 'cv.pdf', type: 'application/pdf', size: 10 }, { errors: { cv_file: APPLY_MESSAGES.cvFileType } }],
    ['fails while it is read', {
      name: 'cv.pdf', type: 'application/pdf', size: 10, arrayBuffer: async () => { throw new Error('cv.pdf broke'); },
    }, { error: APPLY_MESSAGES.cvUploadFailed }],
  ])('answers plainly, without throwing, when what stands for the file %s', async (_what, odd, answer) => {
    expect(await applyAction(ORG, JOB, undefined, withOdd(odd))).toEqual({ ...answer, values: VALUES, fileDropped: true });
    nothingStored();
  });

  it('is not read at all while the fields have problems, and the visitor is told the file must be chosen again', async () => {
    const formData = withFile({ name: ' ' }, PDF);
    const read = vi.spyOn(formData.get(CV_FILE_FIELD) as File, 'arrayBuffer');
    expect(await applyAction(ORG, JOB, undefined, formData)).toEqual({
      errors: { name: APPLY_MESSAGES.name }, values: { ...VALUES, name: ' ' }, fileDropped: true,
    });
    expect(read).not.toHaveBeenCalled();
    nothingStored();
  });

  it('is reported beside the fields\' own problems, in one answer', async () => {
    const state = await applyAction(ORG, JOB, undefined, withFile({ email: 'nope', cv_url: 'ftp://x' }, PDF, 'me.png', 'image/png'));
    expect(state).toEqual({
      errors: { email: APPLY_MESSAGES.emailInvalid, cv_url: APPLY_MESSAGES.urlInvalid, cv_file: APPLY_MESSAGES.cvFileType },
      values: { ...VALUES, email: 'nope', cv_url: 'ftp://x' },
      fileDropped: true,
    });
  });
});

describe('a PDF that is not stored', () => {
  it('says the job could not be read, and that the file is gone, when the read failed', async () => {
    mocks.readPublicJob.mockResolvedValue({ state: 'failed' });
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({
      error: APPLY_MESSAGES.failed, values: VALUES, fileDropped: true,
    });
    expect(mocks.storeCv).not.toHaveBeenCalled();
  });

  it('is closed, with nothing stored, when the job has stopped taking applications', async () => {
    mocks.readPublicJob.mockResolvedValue(found({ accepting: false }));
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({ closed: true });
    expect(mocks.serviceClient).not.toHaveBeenCalled();
    expect(mocks.storeCv).not.toHaveBeenCalled();
  });

  it('throttled before upload: the try-again message, and nothing stored or sent', async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'hire_apply_throttled', error: null }));
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({
      error: APPLY_MESSAGES.throttled, values: VALUES, fileDropped: true,
    });
    expect(mocks.storeCv).not.toHaveBeenCalled();
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it.each([
    ['answers with an error', () => mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied for cv.pdf' } })],
    ['throws', () => mocks.rpc.mockRejectedValue(new Error('network'))],
  ])('fails, with nothing stored or sent, when the throttle read %s', async (_what, arrange) => {
    arrange();
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({
      error: APPLY_MESSAGES.failed, values: VALUES, fileDropped: true,
    });
    expect(mocks.storeCv).not.toHaveBeenCalled();
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it('fails, with nothing stored or sent, on a site with no service key', async () => {
    mocks.serviceClient.mockImplementation(() => {
      throw new Error('Service role is not configured.');
    });
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({
      error: APPLY_MESSAGES.failed, values: VALUES, fileDropped: true,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.storeCv).not.toHaveBeenCalled();
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it.each([
    ['answers nothing', () => mocks.storeCv.mockResolvedValue(null)],
    ['throws', () => mocks.storeCv.mockRejectedValue(new Error('storage'))],
  ])('says the upload failed and sends nothing when the store %s', async (_what, arrange) => {
    arrange();
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({
      error: "We couldn't upload your CV, so your application wasn't sent. Please try again.",
      values: VALUES,
      fileDropped: true,
    });
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
    expect(mocks.removeCv).not.toHaveBeenCalled();
  });

  it('a honeypot post is thanked with nothing read from storage, nothing read from the file and nothing stored', async () => {
    const formData = withFile({ [APPLY_HONEYPOT]: 'x' }, PDF);
    const read = vi.spyOn(formData.get(CV_FILE_FIELD) as File, 'arrayBuffer');
    expect(await applyAction(ORG, JOB, undefined, formData)).toEqual({ done: { firstName: 'Aisyah' } });
    expect(read).not.toHaveBeenCalled();
    expect(mocks.readPublicJob).not.toHaveBeenCalled();
    expect(mocks.serviceClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.storeCv).not.toHaveBeenCalled();
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });
});

describe('a stored PDF whose application is not taken', () => {
  const removedOnce = () => {
    expect(mocks.removeCv).toHaveBeenCalledTimes(1);
    expect(mocks.removeCv.mock.calls[0][0]).toBe(SERVICE);
    expect(mocks.removeCv.mock.calls[0][1]).toBe(PATH);
  };

  it('a duplicate leaves no object: the same thank-you, and the file is removed', async () => {
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'duplicate' });
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({ done: { firstName: 'Aisyah' } });
    removedOnce();
  });

  it.each([
    ['closed', { kind: 'closed' }, { closed: true }],
    ['throttled', { kind: 'throttled' }, { error: APPLY_MESSAGES.throttled, values: VALUES, fileDropped: true }],
    ['invalid', { kind: 'invalid', errors: { email: APPLY_MESSAGES.emailInvalid } },
      { errors: { email: APPLY_MESSAGES.emailInvalid }, values: VALUES, fileDropped: true }],
    ['failed', { kind: 'failed' }, { error: APPLY_MESSAGES.failed, values: VALUES, fileDropped: true }],
    ['something it does not know', { kind: 'something_new' }, { error: APPLY_MESSAGES.failed, values: VALUES, fileDropped: true }],
  ])('%s: the answer it always gave, and the file is removed', async (_what, outcome, answer) => {
    mocks.submitPublicApplication.mockResolvedValue(outcome);
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual(answer);
    removedOnce();
  });

  it('the sender throws: the file is removed, and the action fails plainly with what was typed', async () => {
    mocks.submitPublicApplication.mockRejectedValue(new Error('boom cv.pdf'));
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({
      error: APPLY_MESSAGES.failed, values: VALUES, fileDropped: true,
    });
    removedOnce();
  });

  it('a workspace that may not be sent files: said by the file, with the way out, and nothing is stored', async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      ({ data: name === 'hire_cv_files_refused', error: null }));
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({
      errors: { cv_file: "This employer can't take uploaded files yet. Paste a link to your CV instead." },
      values: VALUES, fileDropped: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('hire_cv_files_refused', { p_org_id: ORG });
    expect(mocks.storeCv).not.toHaveBeenCalled();
    expect(mocks.submitPublicApplication).not.toHaveBeenCalled();
  });

  it('the question whether files may be sent fails: the action fails plainly, and nothing is stored', async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'hire_cv_files_refused' ? { data: null, error: { code: '42501' } } : { data: false, error: null });
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({
      error: APPLY_MESSAGES.failed, values: VALUES, fileDropped: true,
    });
    expect(mocks.storeCv).not.toHaveBeenCalled();
  });

  const attached = (answer: unknown) =>
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'hire_cv_attached' ? answer : { data: false, error: null });

  it.each([
    ['answers that it failed', () => mocks.submitPublicApplication.mockResolvedValue({ kind: 'failed' })],
    ['throws', () => mocks.submitPublicApplication.mockRejectedValue(new Error('lost'))],
  ])('the sender %s but the application was kept: the file stays and the visitor is thanked', async (_what, arrange) => {
    arrange();
    attached({ data: true, error: null });
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.rpc).toHaveBeenCalledWith('hire_cv_attached', { p_path: PATH });
    expect(mocks.removeCv).not.toHaveBeenCalled();
  });

  it.each([
    ['answers with an error', () => attached({ data: null, error: { code: '42501' } })],
    ['throws', () => mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'hire_cv_attached') throw new Error('network');
      return { data: false, error: null };
    })],
  ])('nobody can say whether the application was kept (the question %s): the file is left, and the action fails plainly', async (_what, arrange) => {
    arrange();
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'failed' });
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({
      error: APPLY_MESSAGES.failed, values: VALUES, fileDropped: true,
    });
    expect(mocks.removeCv).not.toHaveBeenCalled();
  });

  it('a definite refusal is not questioned: the file goes without asking', async () => {
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'closed' });
    await applyAction(ORG, JOB, undefined, withFile({}, PDF));
    expect(mocks.rpc).not.toHaveBeenCalledWith('hire_cv_attached', expect.anything());
    removedOnce();
  });

  it('is removed before the action answers', async () => {
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'failed' });
    let removed = false;
    mocks.removeCv.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      removed = true;
      return true;
    });
    await applyAction(ORG, JOB, undefined, withFile({}, PDF));
    expect(removed).toBe(true);
  });

  it.each([
    ['answers that it could not', () => mocks.removeCv.mockResolvedValue(false)],
    ['throws', () => mocks.removeCv.mockRejectedValue(new Error('storage'))],
  ])('gives the same answer when the removal %s', async (_what, arrange) => {
    arrange();
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'duplicate' });
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({ done: { firstName: 'Aisyah' } });
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'throttled' });
    expect(await applyAction(ORG, JOB, undefined, withFile({}, PDF))).toEqual({
      error: APPLY_MESSAGES.throttled, values: VALUES, fileDropped: true,
    });
  });
});

describe('what a post with a file never puts in a log or an answer', () => {
  it('no call logs the file\'s name, a value or the path, and no answer carries the name or the path', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}));
    const answers: unknown[] = [];
    const run = async (formData: FormData) => {
      answers.push(await applyAction(ORG, JOB, undefined, formData));
    };
    const text = new TextEncoder().encode('not a pdf');

    await run(withFile({}, PDF));
    await run(withFile({}, text));
    await run(withFile({ name: ' ' }, PDF));
    await run(withFile({ [APPLY_HONEYPOT]: 'x' }, PDF));
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    await run(withFile({}, PDF));
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'cv.pdf aisyah@example.com' } });
    await run(withFile({}, PDF));
    mocks.rpc.mockRejectedValueOnce(new Error('cv.pdf'));
    await run(withFile({}, PDF));
    mocks.storeCv.mockResolvedValueOnce(null);
    await run(withFile({}, PDF));
    for (const kind of ['duplicate', 'closed', 'throttled', 'failed']) {
      mocks.submitPublicApplication.mockResolvedValueOnce({ kind });
      await run(withFile({}, PDF));
    }
    mocks.submitPublicApplication.mockRejectedValueOnce(new Error(`cv.pdf ${PATH}`));
    await run(withFile({}, PDF));
    mocks.removeCv.mockRejectedValueOnce(new Error(PATH));
    mocks.submitPublicApplication.mockResolvedValueOnce({ kind: 'failed' });
    await run(withFile({}, PDF));
    mocks.serviceClient.mockImplementationOnce(() => {
      throw new Error('Service role is not configured.');
    });
    await run(withFile({}, PDF));
    expect(answers).toHaveLength(15);

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls).map((call) =>
      call.map((part) => (part instanceof Error ? `${part.name} ${part.message} ${part.stack}` : part))));
    for (const secret of ['cv.pdf', PATH, 'Aisyah', 'aisyah@example.com', '33333333']) {
      expect(logged).not.toContain(secret);
    }
    const answered = JSON.stringify(answers);
    expect(answered).not.toContain('cv.pdf');
    expect(answered).not.toContain(PATH);
    expect(answered).not.toContain('33333333');
    for (const spy of spies) spy.mockRestore();
  });
});
