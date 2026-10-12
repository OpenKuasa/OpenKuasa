import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three actions behind the Add Candidate and Edit candidate forms. The
 * viewer, both database clients, the bucket and the capabilities are replaced:
 * nothing here reaches a database.
 */

const ctl = vi.hoisted(() => ({
  viewer: { orgId: 'org1', role: 'member', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  revalidated: [] as string[],
  /** Everything that happened, in order: `addCandidate`, `rpc:<name>`, `storeCv`, `attach`, `removeCv`. */
  order: [] as string[],
  added: [] as { ctx: { orgId: string; client: unknown }; input: Record<string, unknown> }[],
  updated: [] as { ctx: { orgId: string }; input: unknown }[],
  addResult: null as unknown,
  updateResult: null as unknown,
  serviceThrows: false,
  rpc: {} as Record<string, { data: unknown; error: unknown } | 'throw'>,
  rpcArgs: [] as { fn: string; args: unknown }[],
  storePath: 'org1/job/file.pdf' as string | null,
  stored: [] as { orgId: string; jobId: string; size: number }[],
  attachWord: 'ok',
  attached: [] as { applicationId: string; path: string }[],
  removed: [] as string[],
  // The session client's read of one candidate.
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { ctl.revalidated.push(path); } }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ marker: 'session', from: ctl.from }) }));
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    if (ctl.serviceThrows) throw new Error('Service role is not configured.');
    return {
      marker: 'service',
      rpc: async (fn: string, args: unknown) => {
        ctl.order.push(`rpc:${fn}`);
        ctl.rpcArgs.push({ fn, args });
        const answer = ctl.rpc[fn] ?? { data: false, error: null };
        if (answer === 'throw') throw new Error('network');
        return answer;
      },
    };
  },
}));
vi.mock('@/lib/hire/cv-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hire/cv-store')>();
  return {
    ...actual,
    storeCv: async (service: { marker: string }, orgId: string, jobId: string, bytes: Uint8Array) => {
      ctl.order.push('storeCv');
      ctl.stored.push({ orgId, jobId, size: bytes.length });
      expect(service.marker).toBe('service');
      return ctl.storePath;
    },
    removeCv: async (service: { marker: string }, path: string) => {
      ctl.order.push('removeCv');
      ctl.removed.push(path);
      expect(service.marker).toBe('service');
      return true;
    },
  };
});
vi.mock('@/lib/hire/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hire/capabilities')>();
  return {
    ...actual,
    addCandidate: async (ctx: { orgId: string; client: unknown }, input: Record<string, unknown>) => {
      ctl.order.push('addCandidate');
      ctl.added.push({ ctx, input });
      return ctl.addResult;
    },
    updateCandidate: async (ctx: { orgId: string }, input: unknown) => {
      ctl.updated.push({ ctx, input });
      return ctl.updateResult;
    },
    attachCandidateCv: async (service: { marker: string }, applicationId: string, path: string) => {
      ctl.order.push('attach');
      ctl.attached.push({ applicationId, path });
      expect(service.marker).toBe('service');
      return ctl.attachWord;
    },
  };
});

const { addCandidateAction, getCandidateAction, updateCandidateAction } = await import('@/app/(app)/hire/actions');

const JOB = '22222222-2222-4222-8222-222222222222';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const APP = '44444444-4444-4444-8444-444444444444';
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const REFUSED_VIEWERS = [
  { orgId: 'org1', role: 'viewer', isDemo: false },
  { orgId: 'demo', role: 'viewer', isDemo: true },
  { orgId: 'org1', role: 'owner', isDemo: true },
];
const SCREENS = [
  '/hire/applications', '/hire/assistant', '/hire/candidates', '/hire/careers-page', '/hire/dashboard',
  '/hire/interviews', '/hire/jobs', '/hire/talent-pool',
];
const NAME = 'Zulaikha Binti Osman';
const EMAIL = 'zulaikha.osman@example.com';
const PHONE = '+60123456789';
const FILE_NAME = 'zulaikha-private-cv.pdf';
const PDF = new TextEncoder().encode('%PDF-1.7 a small file');

const form = (fields: Record<string, string> = {}, file?: File): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ name: NAME, ...fields })) data.set(key, value);
  if (file) data.set('cv_file', file);
  return data;
};
const pdf = (bytes: Uint8Array = PDF, name = FILE_NAME) => new File([bytes as BlobPart], name, { type: 'application/pdf' });
const added = (over: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    id: CANDIDATE, name: NAME, application_id: APP, job_id: JOB, job: 'Barista', candidate: 'created', application: 'created',
    message: `Added ${NAME} and an application for Barista.`,
    ...over,
  },
});
const WITH_APPLICATION = `Added ${NAME} and an application for Barista.`;
const NOT_ATTACHED = ' The CV could not be attached.';
const NO_UPLOADS = 'CV files cannot be uploaded right now. Add the candidate without the file, or try again later.';
const ASKED = ['rpc:hire_cv_files_refused', 'rpc:hire_apply_throttled'];

let consoles: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  ctl.viewer = { orgId: 'org1', role: 'member', isDemo: false };
  ctl.revalidated = [];
  ctl.order = [];
  ctl.added = [];
  ctl.updated = [];
  ctl.addResult = added();
  ctl.updateResult = { ok: true, data: { id: CANDIDATE, name: NAME } };
  ctl.serviceThrows = false;
  ctl.rpc = {};
  ctl.rpcArgs = [];
  ctl.storePath = 'org1/job/file.pdf';
  ctl.stored = [];
  ctl.attachWord = 'ok';
  ctl.attached = [];
  ctl.removed = [];
  ctl.from.mockReset().mockReturnValue({ select: ctl.select });
  ctl.select.mockReset().mockReturnValue({ eq: ctl.eq });
  ctl.eq.mockReset().mockReturnValue({ eq: ctl.eq, maybeSingle: ctl.maybeSingle });
  ctl.maybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
  consoles = (['error', 'warn', 'log', 'info', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('addCandidateAction', () => {
  it('refuses a viewer, a demo visitor and a demo owner before anything is read or called', async () => {
    for (const viewer of REFUSED_VIEWERS) {
      ctl.viewer = viewer;
      // A form that throws if it is touched: the guard comes first.
      const untouchable = { get: () => { throw new Error('read before the guard'); } } as unknown as FormData;
      expect(await addCandidateAction(untouchable)).toEqual(FORBIDDEN);
    }
    expect(ctl.order).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('answers the generic sentence for something that is not a form', async () => {
    expect(await addCandidateAction('nope' as unknown as FormData)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(ctl.order).toEqual([]);
  });

  it('adds a person with no job: the capability once, with the session\'s workspace and the skills as a list', async () => {
    ctl.addResult = added({ application_id: null, job_id: null, job: null, application: 'none', message: `Added ${NAME} to the talent pool as Available.` });
    const result = await addCandidateAction(form({
      email: EMAIL, phone: PHONE, headline: 'Barista', location: 'Shah Alam', skills: 'Latte art, , Cashier,Latte art', source: 'Referral', org_id: 'someone-else',
    }));
    expect(result).toEqual({ ok: true, data: { id: CANDIDATE, name: NAME, application_id: null, job_id: null, job: null, candidate: 'created', application: 'none', message: `Added ${NAME} to the talent pool as Available.` } });
    expect(ctl.added).toHaveLength(1);
    expect(ctl.added[0].ctx).toMatchObject({ orgId: 'org1', client: { marker: 'session' } });
    expect(ctl.added[0].input).toEqual({
      name: NAME, email: EMAIL, phone: PHONE, headline: 'Barista', location: 'Shah Alam', skills: ['Latte art', 'Cashier'], source: 'Referral',
      job_id: null, cover_letter: '', cv_url: '',
    });
    // No file: the server never acts as itself.
    expect(ctl.order).toEqual(['addCandidate']);
    expect([...ctl.revalidated].sort()).toEqual(SCREENS);
  });

  it('sends the job, the cover note and the CV link when a job is picked, and drops the last two when none is', async () => {
    await addCandidateAction(form({ job_id: JOB, cover_letter: 'Line one\r\nLine two', cv_url: 'https://example.com/cv' }));
    expect(ctl.added[0].input).toMatchObject({ job_id: JOB, cover_letter: 'Line one\nLine two', cv_url: 'https://example.com/cv' });
    // A job and no file: the upload questions are not asked.
    expect(ctl.order).toEqual(['addCandidate']);
    await addCandidateAction(form({ cover_letter: 'Kept for nobody', cv_url: 'not a link' }));
    expect(ctl.added[1].input).toMatchObject({ job_id: null, cover_letter: '', cv_url: '' });
  });

  it('strips NUL and reads only text', async () => {
    const data = form({ name: 'Ai\u0000na', headline: 'x' });
    data.set('location', new File(['x'], 'location.txt'));
    await addCandidateAction(data);
    expect(ctl.added[0].input).toMatchObject({ name: 'Aina', location: '' });
  });

  it.each([
    [{ name: '   ' }, 'Enter the candidate\'s name.'],
    [{ email: 'not-an-email' }, 'Enter an email address like name@example.com.'],
    [{ phone: '1'.repeat(41) }, 'Keep the phone to 40 characters or fewer.'],
    [{ skills: Array.from({ length: 21 }, (_, i) => `s${i}`).join(',') }, 'List at most 20 skills.'],
    [{ job_id: JOB, cv_url: 'ftp://example.com/cv' }, 'Enter a link that starts with https://'],
    [{ job_id: JOB, cover_letter: 'x'.repeat(4001) }, 'Keep the cover note to 4000 characters or fewer.'],
    [{ job_id: 'not-a-uuid' }, 'That job could not be found.'],
    // The first wrong field, in the order of the form.
    [{ name: '', email: 'bad' }, 'Enter the candidate\'s name.'],
  ])('refuses %j with the field\'s own sentence and saves nothing', async (fields, error) => {
    expect(await addCandidateAction(form(fields))).toEqual({ ok: false, error });
    expect(ctl.order).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('refuses a file with no job picked, without asking whether files may be uploaded', async () => {
    expect(await addCandidateAction(form({}, pdf()))).toEqual({ ok: false, error: 'Pick a job to attach a CV.' });
    expect(ctl.order).toEqual([]);
  });

  it('refuses a text file named .pdf, by its first bytes, before anything is saved', async () => {
    const text = new File(['just some text'], 'cv.pdf', { type: 'application/pdf' });
    expect(await addCandidateAction(form({ job_id: JOB }, text))).toEqual({ ok: false, error: 'Choose a PDF file.' });
    expect(ctl.order).toEqual([]);
  });

  it('refuses a file that is not a PDF by its name or type', async () => {
    const doc = new File([PDF as BlobPart], 'cv.docx', { type: 'application/msword' });
    expect(await addCandidateAction(form({ job_id: JOB }, doc))).toEqual({ ok: false, error: 'Choose a PDF file.' });
    expect(ctl.order).toEqual([]);
  });

  it('refuses an oversize file, by what it says of itself', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PDF);
    expect(await addCandidateAction(form({ job_id: JOB }, pdf(big)))).toEqual({ ok: false, error: 'This file is 5.0 MB. Choose one under 5 MB.' });
    expect(ctl.order).toEqual([]);
  });

  it('refuses an oversize file that lies about its size, by its bytes', async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(PDF);
    const liar = { name: 'cv.pdf', type: 'application/pdf', size: 10, arrayBuffer: async () => big.buffer };
    const fields: Record<string, unknown> = { name: NAME, job_id: JOB, cv_file: liar };
    const fake = { get: (key: string) => fields[key] ?? null } as unknown as FormData;
    expect(await addCandidateAction(fake)).toEqual({ ok: false, error: 'This file is 6.0 MB. Choose one under 5 MB.' });
    expect(ctl.order).toEqual([]);
  });

  it('refuses a posted file that cannot be read as one', async () => {
    const fields: Record<string, unknown> = { name: NAME, job_id: JOB, cv_file: { name: 'cv.pdf', type: 'application/pdf', size: 10 } };
    const fake = { get: (key: string) => fields[key] ?? null } as unknown as FormData;
    expect(await addCandidateAction(fake)).toEqual({ ok: false, error: 'Choose a PDF file.' });
    expect(ctl.order).toEqual([]);
  });

  it('treats an untouched file input (an empty, nameless file) as no file', async () => {
    ctl.addResult = added({ application_id: null, job_id: null, job: null, application: 'none', message: `Added ${NAME} to the talent pool as Available.` });
    const result = await addCandidateAction(form({}, new File([], '')));
    expect(result).toMatchObject({ ok: true, data: { message: `Added ${NAME} to the talent pool as Available.` } });
    expect(ctl.order).toEqual(['addCandidate']);
  });

  it('returns the capability\'s refusal as it is, stores nothing and refreshes nothing', async () => {
    ctl.addResult = { ok: false, error: 'Only an open or paused job can take a new application.' };
    expect(await addCandidateAction(form({ job_id: JOB }, pdf()))).toEqual({ ok: false, error: 'Only an open or paused job can take a new application.' });
    expect(ctl.order).toEqual([...ASKED, 'addCandidate']);
    expect(ctl.revalidated).toEqual([]);
  });

  it('with a file and a job: asks the two questions before the add, then adds, stores, attaches, in that order', async () => {
    const result = await addCandidateAction(form({ job_id: JOB }, pdf()));
    expect(ctl.order).toEqual(['rpc:hire_cv_files_refused', 'rpc:hire_apply_throttled', 'addCandidate', 'storeCv', 'attach']);
    expect(ctl.rpcArgs).toEqual([
      { fn: 'hire_cv_files_refused', args: { p_org_id: 'org1' } },
      { fn: 'hire_apply_throttled', args: { p_job_id: JOB } },
    ]);
    expect(ctl.stored).toEqual([{ orgId: 'org1', jobId: JOB, size: PDF.length }]);
    expect(ctl.attached).toEqual([{ applicationId: APP, path: 'org1/job/file.pdf' }]);
    expect(ctl.removed).toEqual([]);
    expect(result).toMatchObject({ ok: true, data: { id: CANDIDATE, application_id: APP, message: WITH_APPLICATION } });
    // The path stays on the server.
    expect(JSON.stringify(result)).not.toContain('file.pdf');
    expect([...ctl.revalidated].sort()).toEqual(SCREENS);
  });

  it('removes the stored file and says so when the attach answers already_attached', async () => {
    ctl.attachWord = 'already_attached';
    const result = await addCandidateAction(form({ job_id: JOB }, pdf()));
    expect(ctl.order).toEqual([...ASKED, 'addCandidate', 'storeCv', 'attach', 'removeCv']);
    expect(ctl.removed).toEqual(['org1/job/file.pdf']);
    expect(result).toMatchObject({ ok: true, data: { message: WITH_APPLICATION + NOT_ATTACHED } });
  });

  it.each(['forbidden', 'not_found', 'invalid_path', 'not_by_hand'])('removes the stored file when the attach answers %s', async (word) => {
    ctl.attachWord = word;
    const result = await addCandidateAction(form({ job_id: JOB }, pdf()));
    expect(ctl.removed).toEqual(['org1/job/file.pdf']);
    // The database said no: there is nothing to ask about.
    expect(ctl.order).not.toContain('rpc:hire_cv_attached');
    expect(result).toMatchObject({ ok: true, data: { message: WITH_APPLICATION + NOT_ATTACHED } });
  });

  it('keeps the file when the attach answer was lost but the application holds it', async () => {
    ctl.attachWord = 'failed';
    ctl.rpc.hire_cv_attached = { data: true, error: null };
    const result = await addCandidateAction(form({ job_id: JOB }, pdf()));
    expect(ctl.rpcArgs.at(-1)).toEqual({ fn: 'hire_cv_attached', args: { p_path: 'org1/job/file.pdf' } });
    expect(ctl.removed).toEqual([]);
    expect(result).toMatchObject({ ok: true, data: { message: WITH_APPLICATION } });
  });

  it('removes the file when the attach failed and no application holds it', async () => {
    ctl.attachWord = 'failed';
    ctl.rpc.hire_cv_attached = { data: false, error: null };
    const result = await addCandidateAction(form({ job_id: JOB }, pdf()));
    expect(ctl.removed).toEqual(['org1/job/file.pdf']);
    expect(result).toMatchObject({ ok: true, data: { message: WITH_APPLICATION + NOT_ATTACHED } });
  });

  it.each([
    ['errors', { data: null, error: { code: '42501' } }],
    ['answers something that is not a boolean', { data: null, error: null }],
    ['throws', 'throw' as const],
  ])('leaves the file where it is when the attach failed and hire_cv_attached %s', async (_label, answer) => {
    ctl.attachWord = 'failed';
    ctl.rpc.hire_cv_attached = answer;
    const result = await addCandidateAction(form({ job_id: JOB }, pdf()));
    // Not known: removing it could leave an application pointing at nothing. The sweep takes a file no application holds.
    expect(ctl.removed).toEqual([]);
    expect(result).toMatchObject({ ok: true, data: { message: WITH_APPLICATION + NOT_ATTACHED } });
  });

  it.each([
    ['says files are refused', { data: true, error: null }],
    ['errors', { data: null, error: { code: '42501' } }],
    ['answers something that is not a boolean', { data: null, error: null }],
    ['throws', 'throw' as const],
  ])('refuses the whole add, and saves nobody, when hire_cv_files_refused %s', async (_label, answer) => {
    ctl.rpc.hire_cv_files_refused = answer;
    const result = await addCandidateAction(form({ job_id: JOB }, pdf()));
    // Asked before the add: an application made now could never be given its CV.
    expect(ctl.order).toEqual(['rpc:hire_cv_files_refused']);
    expect(ctl.added).toEqual([]);
    expect(result).toEqual({ ok: false, error: NO_UPLOADS });
    expect(ctl.revalidated).toEqual([]);
  });

  it.each([
    ['says the job is flooded', { data: true, error: null }],
    ['errors', { data: null, error: { code: '500' } }],
    ['throws', 'throw' as const],
  ])('refuses the whole add, and saves nobody, when hire_apply_throttled %s', async (_label, answer) => {
    ctl.rpc.hire_apply_throttled = answer;
    const result = await addCandidateAction(form({ job_id: JOB }, pdf()));
    expect(ctl.order).toEqual(ASKED);
    expect(ctl.added).toEqual([]);
    expect(result).toEqual({ ok: false, error: NO_UPLOADS });
    expect(ctl.revalidated).toEqual([]);
  });

  it('the same form without the file is then added, with nothing asked', async () => {
    ctl.rpc.hire_cv_files_refused = { data: true, error: null };
    expect(await addCandidateAction(form({ job_id: JOB }, pdf()))).toEqual({ ok: false, error: NO_UPLOADS });
    ctl.order = [];
    expect(await addCandidateAction(form({ job_id: JOB }))).toMatchObject({ ok: true, data: { message: WITH_APPLICATION } });
    expect(ctl.order).toEqual(['addCandidate']);
  });

  it('says so, and attaches nothing, when storage refuses the file', async () => {
    ctl.storePath = null;
    const result = await addCandidateAction(form({ job_id: JOB }, pdf()));
    expect(ctl.order).toEqual([...ASKED, 'addCandidate', 'storeCv']);
    expect(result).toMatchObject({ ok: true, data: { message: WITH_APPLICATION + NOT_ATTACHED } });
  });

  it('refuses an add with a file, and saves nobody, when the service role is not configured; without the file it is added', async () => {
    ctl.serviceThrows = true;
    expect(await addCandidateAction(form({ job_id: JOB }, pdf()))).toEqual({ ok: false, error: NO_UPLOADS });
    expect(ctl.order).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
    expect(await addCandidateAction(form({ job_id: JOB }))).toMatchObject({ ok: true, data: { message: WITH_APPLICATION } });
    expect(ctl.order).toEqual(['addCandidate']);
  });

  it('never stores a file for an application that already existed, and says the CV was not attached', async () => {
    const message = `${NAME} has already applied for Barista. Nothing was changed.`;
    ctl.addResult = added({ candidate: 'existing', application: 'existing', message });
    const result = await addCandidateAction(form({ job_id: JOB }, pdf()));
    expect(ctl.order).toEqual([...ASKED, 'addCandidate']);
    expect(result).toMatchObject({ ok: true, data: { message: message + NOT_ATTACHED } });
  });

  it('logs no name, email, phone, file name or path, whatever goes wrong', async () => {
    const runs: (() => void)[] = [
      () => {},
      () => { ctl.attachWord = 'failed'; },
      () => { ctl.rpc.hire_cv_files_refused = { data: null, error: { code: '42501', message: `denied for ${EMAIL}` } }; },
      () => { ctl.rpc.hire_apply_throttled = 'throw'; },
      () => { ctl.storePath = null; },
      () => { ctl.serviceThrows = true; },
      () => { ctl.addResult = { ok: false, error: 'That job could not be found.' }; },
    ];
    for (const arrange of runs) {
      ctl.rpc = {};
      ctl.attachWord = 'ok';
      ctl.storePath = 'org1/job/file.pdf';
      ctl.serviceThrows = false;
      ctl.addResult = added();
      arrange();
      await addCandidateAction(form({ email: EMAIL, phone: PHONE, job_id: JOB }, pdf()));
    }
    const logged = JSON.stringify(consoles.flatMap((spy) => spy.mock.calls));
    for (const secret of [NAME, 'Zulaikha', EMAIL, PHONE, FILE_NAME, 'org1/job/file.pdf']) expect(logged).not.toContain(secret);
  });
});

describe('getCandidateAction', () => {
  const ROW = {
    id: CANDIDATE, name: NAME, email: EMAIL, phone: null, headline: null, location: 'Shah Alam', skills: ['Latte art', 'Cashier'], source: null,
  };

  it('refuses a viewer, a demo visitor and a demo owner without a query', async () => {
    for (const viewer of REFUSED_VIEWERS) {
      ctl.viewer = viewer;
      expect(await getCandidateAction(CANDIDATE)).toEqual(FORBIDDEN);
    }
    expect(ctl.from).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 5, '', 'not-a-uuid', `${CANDIDATE}x`, { id: CANDIDATE }])('does not find %j, without a query', async (id) => {
    expect(await getCandidateAction(id)).toEqual({ ok: false, error: 'That candidate could not be found.' });
    expect(ctl.from).not.toHaveBeenCalled();
  });

  it('does not find a candidate with no row', async () => {
    expect(await getCandidateAction(CANDIDATE)).toEqual({ ok: false, error: 'That candidate could not be found.' });
  });

  it('says it could not load, not that nobody is there, when the read fails', async () => {
    ctl.maybeSingle.mockResolvedValue({ data: null, error: { code: '500', message: `boom ${EMAIL}` } });
    const result = await getCandidateAction(CANDIDATE);
    expect(result).toEqual({ ok: false, error: "This candidate's details could not be loaded. Please try again." });
    ctl.maybeSingle.mockRejectedValue(new Error(`network ${EMAIL}`));
    expect(await getCandidateAction(CANDIDATE)).toEqual(result);
    expect(JSON.stringify(consoles.flatMap((spy) => spy.mock.calls))).not.toContain(EMAIL);
  });

  it('answers the row as text, read by its id and the session\'s workspace: nulls blank, skills joined', async () => {
    ctl.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    expect(await getCandidateAction(CANDIDATE)).toEqual({
      ok: true,
      data: { id: CANDIDATE, name: NAME, email: EMAIL, phone: '', headline: '', location: 'Shah Alam', skills: 'Latte art, Cashier', source: '' },
    });
    expect(ctl.from).toHaveBeenCalledWith('hire_candidates');
    expect(ctl.select).toHaveBeenCalledWith('id,name,email,phone,headline,location,skills,source');
    expect(ctl.eq).toHaveBeenCalledWith('id', CANDIDATE);
    expect(ctl.eq).toHaveBeenCalledWith('org_id', 'org1');
    expect(ctl.revalidated).toEqual([]);
  });

  it('answers a row with no skills as a blank line', async () => {
    ctl.maybeSingle.mockResolvedValue({ data: { ...ROW, skills: null }, error: null });
    expect(await getCandidateAction(CANDIDATE)).toMatchObject({ ok: true, data: { skills: '' } });
  });
});

describe('updateCandidateAction', () => {
  it('refuses a viewer, a demo visitor and a demo owner without calling the capability', async () => {
    for (const viewer of REFUSED_VIEWERS) {
      ctl.viewer = viewer;
      expect(await updateCandidateAction({ id: CANDIDATE, name: 'x' })).toEqual(FORBIDDEN);
    }
    expect(ctl.updated).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('gives the capability the input as sent and the session\'s workspace, and refreshes every screen that shows a candidate', async () => {
    const sent = { id: CANDIDATE, email: '', org_id: 'someone-else' };
    expect(await updateCandidateAction(sent)).toEqual({ ok: true, data: { id: CANDIDATE, name: NAME } });
    expect(ctl.updated).toHaveLength(1);
    expect(ctl.updated[0].ctx).toMatchObject({ orgId: 'org1', client: { marker: 'session' } });
    expect(ctl.updated[0].input).toEqual(sent);
    expect([...ctl.revalidated].sort()).toEqual(SCREENS);
  });

  it('answers the capability\'s refusal, word for word, and refreshes nothing', async () => {
    ctl.updateResult = { ok: false, error: 'Another candidate already has this email.' };
    expect(await updateCandidateAction({ id: CANDIDATE, email: EMAIL })).toEqual({ ok: false, error: 'Another candidate already has this email.' });
    expect(ctl.revalidated).toEqual([]);
  });
});
