import { describe, expect, it, vi } from 'vitest';
import { createSeedHireData } from '@/lib/hire/seed';
import { createSeedReachData } from '@/lib/reach/seed';
import { HIRE_TOOL_NAMES } from '@/lib/ai/hire-tools';
import { HIRE_WRITE_TOOL_NAMES } from '@/lib/ai/products';

const seen = vi.hoisted(() => ({
  calls: [] as { layer: string; system: string; tools: string[] }[],
  /** Set by the one test that needs a change prepared: Tuah asks Lekir, and Lekir calls createJob. */
  prepareJob: false,
  /**
   * Set by a test that scripts what Lekir calls, step by step (the last one repeats); Tuah then asks Lekir once.
   * A step that is a list makes all of its calls at once, in that one step.
   */
  workerScript: null as null | ({ tool: string; input: unknown } | { tool: string; input: unknown }[])[],
  workerStep: 0,
  /** Set by a test of one agent holding the tools itself: its nth model call makes all the calls of the nth list in one step, and answers in words after the last. */
  singleScript: null as null | { tool: string; input: unknown }[][],
  /** Every refusal a tool answered with (`prepared: false`), in order. */
  refusals: [] as string[],
}));
const created = vi.hoisted(() => vi.fn());
const closed = vi.hoisted(() => vi.fn());
const candidateAdded = vi.hoisted(() => vi.fn());
const candidateSaved = vi.hoisted(() => vi.fn());
const applicationDeleted = vi.hoisted(() => vi.fn());
const candidateDeleted = vi.hoisted(() => vi.fn());

// The real schemas, so the prepared input is checked as it is in the app; only the write is recorded.
vi.mock('@/lib/hire/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/capabilities')>()),
  createJob: created,
  closeApplication: closed,
  addCandidate: candidateAdded,
  updateCandidate: candidateSaved,
  deleteApplication: applicationDeleted,
  deleteCandidate: candidateDeleted,
}));

// The real `tool`, but a refusal any tool answers with is noted: a specialist stops after the step in which
// a change was prepared, so a call refused in that same step is never shown to a model this file can see.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  type Def = { execute?: (...args: unknown[]) => unknown };
  const noting = (def: Def) => {
    const run = def.execute;
    // A specialist itself streams its progress (a generator): left as it is.
    if (!run || run.constructor.name !== 'AsyncFunction') return def;
    return {
      ...def,
      execute: async (...args: unknown[]) => {
        const output = (await run(...args)) as { prepared?: unknown; error?: unknown } | null;
        if (output?.prepared === false && typeof output.error === 'string') seen.refusals.push(output.error);
        return output;
      },
    };
  };
  return { ...actual, tool: ((def: Def) => (actual.tool as (d: Def) => unknown)(noting(def))) as typeof actual.tool };
});

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return {
    ...actual,
    getModel: (layer: string) =>
      new MockLanguageModelV4({
        doStream: async (options: { prompt: { role: string; content: unknown }[]; tools?: { name: string }[] }) => {
          seen.calls.push({
            layer,
            system: String(options.prompt.find((m) => m.role === 'system')?.content ?? ''),
            tools: (options.tools ?? []).map((t) => t.name),
          });
          const call = (toolName: string, input: unknown): Record<string, unknown>[] => [
            { type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
          ];
          /** Several calls in one step, each with its own call id. */
          const callAll = (calls: { tool: string; input: unknown }[]): Record<string, unknown>[] => [
            ...calls.map(({ tool, input }, n) => ({ type: 'tool-call', toolCallId: `call-${tool}-${n}`, toolName: tool, input: JSON.stringify(input) })),
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
          ];
          const answer: Record<string, unknown>[] = [
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'ok' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ];
          return {
            stream: simulateReadableStream({
              initialDelayInMs: 0,
              chunkDelayInMs: 0,
              chunks: seen.singleScript ? (seen.singleScript[seen.calls.length - 1]?.length ? callAll(seen.singleScript[seen.calls.length - 1]) : answer) : seen.workerScript
                ? layer === 'worker'
                  ? callAll([seen.workerScript[Math.min(seen.workerStep++, seen.workerScript.length - 1)]].flat())
                  : call('askLekir', { task: 'Reject the first applicant' })
                : !seen.prepareJob
                ? answer
                : layer === 'worker'
                  ? call('createJob', { title: 'Barista' })
                  : call('askLekir', { task: 'Post a job for a Barista' }),
            }),
          };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { runLekir, runTuah } = await import('@/lib/ai/agents/orchestrator');
const { createTeamTools } = await import('@/lib/ai/agents/specialists');
const { combineToolkits, hireProduct, reachProduct } = await import('@/lib/ai/products');
const { TUAH_SYSTEM, tuahTeamSystem, subAgentSystem } = await import('@/lib/ai/agents/prompts');

const ask = [{ role: 'user' as const, content: 'how many jobs are open?' }];
const reach = () => ({ data: createSeedReachData() });
const hire = () => ({ data: createSeedHireData(new Date('2026-10-10T04:00:00Z')) });
const team = () => ({ transcript: '', proposals: new Map(), names: {} });

describe('Tuah with hiring', () => {
  it('holds the hiring lookups as a single agent', async () => {
    seen.calls = [];
    await runTuah(ask, reach(), undefined, undefined, null, null, null, hire()).consumeStream();
    // Reading a CV belongs to Lekir: Tuah on its own is given no file reader, so that tool is not made.
    for (const name of HIRE_TOOL_NAMES.filter((n) => n !== 'readCandidateCv')) expect(seen.calls[0].tools, name).toContain(name);
    expect(seen.calls[0].tools).not.toContain('readCandidateCv');
  });

  it('has no hiring tools when no hiring data is passed', async () => {
    seen.calls = [];
    await runTuah(ask, reach()).consumeStream();
    for (const name of HIRE_TOOL_NAMES) expect(seen.calls[0].tools).not.toContain(name);
  });

  it('gets askLekir on its team, and holds no hiring lookup itself', async () => {
    seen.calls = [];
    await runTuah(ask, reach(), undefined, undefined, null, null, team(), hire()).consumeStream();
    const [tuah] = seen.calls;
    expect(tuah.tools).toContain('askLekir');
    expect(tuah.tools).toContain('askJebat');
    expect(tuah.tools).not.toContain('listJobs');
    expect(tuah.system).toContain('askLekir: Lekir, for hiring');
  });
});

describe('Tuah as a single agent with hiring changes', () => {
  it('a viewer (no write access) gets the lookups and no change tools', async () => {
    seen.calls = [];
    await runTuah(ask, reach(), undefined, undefined, null, null, null, hire()).consumeStream();
    for (const name of HIRE_TOOL_NAMES.filter((n) => n !== 'readCandidateCv')) expect(seen.calls[0].tools).toContain(name);
    for (const name of HIRE_WRITE_TOOL_NAMES) expect(seen.calls[0].tools).not.toContain(name);
  });
  it('a writer gets all the change tools', async () => {
    seen.calls = [];
    const writer = { ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
    await runTuah(ask, reach(), undefined, undefined, null, null, null, writer).consumeStream();
    for (const name of HIRE_WRITE_TOOL_NAMES) expect(seen.calls[0].tools).toContain(name);
  });
});

describe('Tuah with hiring changes', () => {
  it('on its team holds askLekir and applyChange, and no hiring change tool itself', async () => {
    seen.calls = [];
    const writer = { ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
    await runTuah(ask, reach(), undefined, undefined, null, null, team(), writer).consumeStream();
    const [tuah] = seen.calls;
    expect(tuah.tools).toContain('askLekir');
    expect(tuah.tools).toContain('applyChange');
    for (const name of HIRE_WRITE_TOOL_NAMES) expect(tuah.tools).not.toContain(name);
  });
});

describe('the site origin reaches the hiring tools', () => {
  it('a hire access carrying an origin gives getCareersPage an address', async () => {
    const settings = { org_id: 'org1', careers_enabled: true, careers_headline: null, careers_tagline: null, require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
    const access = {
      data: { ...createSeedHireData(new Date('2026-10-10T04:00:00Z')), getSettings: async () => settings },
      origin: 'https://openkuasa.com',
    };
    const lookup = hireProduct(access).read.getCareersPage as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    };
    expect(await lookup.execute({}, { toolCallId: 't', messages: [] })).toMatchObject({
      url: 'https://openkuasa.com/careers/org1',
    });
  });
});

describe('Tuah’s team changing a job', () => {
  it('prepares the job without saving it, and applyChange saves it once approved', async () => {
    created.mockReset();
    created.mockResolvedValue({ ok: true, data: { id: 'j1', title: 'Barista' } });
    const ctx = { client: { marker: true } as never, orgId: 'org1' };
    const writer = { ...hire(), write: { ctx, canWrite: true } };
    const context = team();
    const post = [{ role: 'user' as const, content: 'Post a job for a Barista' }];

    seen.calls = [];
    seen.prepareJob = true;
    const result = runTuah(post, reach(), undefined, undefined, null, null, context, writer);
    try {
      await result.consumeStream();
    } finally {
      seen.prepareJob = false;
    }

    // Lekir only prepared it: nothing is saved, and the user is asked once.
    expect(created).not.toHaveBeenCalled();
    expect(context.proposals.size).toBe(1);
    const [proposal] = [...context.proposals.values()];
    expect(proposal).toMatchObject({
      product: 'hire',
      action: 'createJob',
      input: { title: 'Barista' },
      title: 'Create job “Barista” as a draft?',
    });
    const calls = (await result.steps).flatMap((step) => step.toolCalls.map((c) => c.toolName));
    expect(calls).toEqual(['askLekir', 'applyChange']);
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
    // Tuah's own model was called once; the specialist held the change tool, not Tuah.
    expect(seen.calls.filter((c) => c.layer === 'orchestrator')).toHaveLength(1);
    expect(seen.calls.find((c) => c.layer === 'worker')?.tools).toContain('createJob');

    // Approving runs applyChange, the only place the real change tool is ever run.
    const { tools, toolApproval } = createTeamTools([reachProduct(reach()), hireProduct(writer)], {
      transcript: '',
      proposals: context.proposals,
    });
    expect(toolApproval).toEqual({ applyChange: 'user-approval' });
    const apply = tools.applyChange as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> };
    const out = await apply.execute({ proposalId: proposal.id }, { toolCallId: 't', messages: [] });

    expect(created).toHaveBeenCalledTimes(1);
    // The very context object the route built, and the input the specialist prepared.
    expect(created.mock.calls[0][0]).toBe(ctx);
    expect(created.mock.calls[0][1]).toMatchObject({ title: 'Barista' });
    expect(out).toMatchObject({ ok: true, data: { name: 'Barista' } });
  });
});

describe('Tuah prompts and hiring', () => {
  it('no longer says hiring cannot be looked up', () => {
    expect(TUAH_SYSTEM).not.toMatch(/payroll, staff and hiring/);
    expect(TUAH_SYSTEM).toContain('hiring in Lekir');
    const teamPrompt = tuahTeamSystem([{ name: 'Lekir', area: 'hiring' }], true, null);
    expect(teamPrompt).not.toMatch(/payroll, staff or hiring/);
  });
  it('says jobs, applications and candidates can be changed and interviews cannot yet', () => {
    for (const prompt of [TUAH_SYSTEM, tuahTeamSystem([{ name: 'Lekir', area: 'hiring' }], true, null)]) {
      const p = prompt.toLowerCase();
      expect(p).not.toContain('hiring cannot be changed yet');
      expect(p).not.toContain('candidates, applications and interviews cannot be changed yet');
      // Candidates can now be added and edited with approval; only interviews cannot be changed.
      expect(p).not.toContain('candidates and interviews cannot be changed yet');
      expect(p).toContain('interviews cannot be changed yet');
    }
    expect(TUAH_SYSTEM.toLowerCase()).toContain('create, edit, open, pause, close, reopen or delete jobs');
  });
  it('does not contradict itself about jobs', () => {
    expect(TUAH_SYSTEM).not.toContain('job posts');
    expect(tuahTeamSystem([{ name: 'Lekir', area: 'hiring' }], true, null)).not.toContain('job posts');
    expect(TUAH_SYSTEM).toContain('outside marketing, the CRM, jobs and applications');
    const sentence = TUAH_SYSTEM.toLowerCase().split('\n').find((l) => l.startsWith('- to change a specific campaign, creative'));
    expect(sentence).toContain('job');
  });
  it('only says Lekir can change jobs when changes are allowed', () => {
    const off = tuahTeamSystem([{ name: 'Lekir', area: 'hiring' }], false, null).toLowerCase();
    expect(off).toContain('when changes are allowed, lekir can prepare changes to jobs');
  });
  it('tells a read-only specialist it cannot change anything', () => {
    const lekir = subAgentSystem('hire', false).toLowerCase();
    expect(lekir).toContain('you cannot change anything for this user');
  });
  it('gives the hiring specialist the job rules in prepare mode', () => {
    const lekir = subAgentSystem('hire', true).toLowerCase();
    expect(lekir).toContain('when you have change tools');
    expect(lekir).toContain('an open or paused job must keep a description');
    expect(lekir).toContain('a new job is always a draft');
    expect(lekir).toContain('a job with applications cannot be deleted');
    expect(lekir).not.toContain('you can only look things up');
  });
  it('still says finance, payroll and staff cannot be looked up', () => {
    expect(TUAH_SYSTEM).toContain('cannot see the rest of the workspace yet');
    expect(TUAH_SYSTEM).toMatch(/invoices and other finance records, payroll and staff/);
  });
  it('offers a skills-based alternative when declining to rank by protected traits', () => {
    const offer = 'offer to do it on skills and experience instead';
    expect(TUAH_SYSTEM.toLowerCase()).toContain(offer);
    expect(tuahTeamSystem([{ name: 'Lekir', area: 'hiring' }], true, null).toLowerCase()).toContain(offer);
  });
  it('tells the single agent when to fetch contact details', () => {
    expect(TUAH_SYSTEM).toContain('includeContact');
  });
  it('gives the hiring specialist its fairness rule', () => {
    const lekir = subAgentSystem('hire', false);
    expect(lekir).toMatch(/^You are Lekir/);
    expect(lekir.toLowerCase()).toContain('never infer or weigh race');
  });
});

const APPLICATION_TOOLS = ['moveApplication', 'rejectApplication', 'reopenApplication', 'rateApplication'];

describe('the four application changes need approval', () => {
  const writer = () => ({ ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } });
  it('a writer’s toolkit asks for approval on all four, and a viewer’s holds none', () => {
    const { tools, toolApproval } = combineToolkits([hireProduct(writer())]);
    for (const name of APPLICATION_TOOLS) {
      expect(Object.keys(tools), name).toContain(name);
      expect(toolApproval?.[name], name).toBe('user-approval');
    }
    const viewer = combineToolkits([hireProduct({ ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: false } })]);
    for (const name of APPLICATION_TOOLS) {
      expect(Object.keys(viewer.tools), name).not.toContain(name);
      expect(viewer.toolApproval?.[name], name).toBeUndefined();
    }
  });
  it('the single agent Tuah holds the four tools for a writer only', async () => {
    seen.calls = [];
    await runTuah(ask, reach(), undefined, undefined, null, null, null, writer()).consumeStream();
    for (const name of APPLICATION_TOOLS) expect(seen.calls[0].tools).toContain(name);
    seen.calls = [];
    await runTuah(ask, reach(), undefined, undefined, null, null, null, hire()).consumeStream();
    for (const name of APPLICATION_TOOLS) expect(seen.calls[0].tools).not.toContain(name);
  });
});

describe('Tuah’s team rejecting an application', () => {
  const APP_ID = '44444444-4444-4444-8444-444444444444';
  const JOB_ID = '55555555-5555-4555-8555-555555555555';
  /** The seed's ids are not UUIDs, which the change tools require: give the first listed application and the first job real ones. */
  const withUuids = async () => {
    const base = hire().data;
    const lookup = hireProduct(hire()).read.listApplications as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> };
    const listed = (await lookup.execute({}, { toolCallId: 't', messages: [] })) as { applications: { id: string; candidate: string; job: string }[] };
    const first = listed.applications[0];
    const [firstJob] = await base.listJobs();
    const data = {
      ...base,
      listApplications: async () => (await base.listApplications()).map((a) => (a.id === first.id ? { ...a, id: APP_ID } : a)),
      listJobs: async () => (await base.listJobs()).map((j) => (j.id === firstJob.id ? { ...j, id: JOB_ID } : j)),
    };
    return { first, access: { data, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } } };
  };
  const prepare = async (
    script: NonNullable<typeof seen.workerScript>,
    access: Awaited<ReturnType<typeof withUuids>>['access'],
    /** Names the conversation came across in earlier turns, by `kind:id`. */
    names: Record<string, string> = {},
  ) => {
    closed.mockReset();
    const context = { ...team(), names };
    seen.calls = [];
    seen.workerScript = script;
    seen.workerStep = 0;
    seen.refusals = [];
    try {
      await runTuah(
        [{ role: 'user' as const, content: 'Reject the first applicant' }],
        reach(), undefined, undefined, null, null, context, access,
      ).consumeStream();
    } finally {
      seen.workerScript = null;
    }
    return context;
  };

  it('prepares one card for an application it listed, and does not save anything', async () => {
    const { first, access } = await withUuids();
    const context = await prepare([
      { tool: 'listApplications', input: {} },
      { tool: 'rejectApplication', input: { id: APP_ID, outcome: 'rejected', reason: 'salary' } },
    ], access);
    expect(closed).not.toHaveBeenCalled();
    expect(context.proposals.size).toBe(1);
    const [proposal] = [...context.proposals.values()];
    expect(proposal).toMatchObject({
      product: 'hire',
      action: 'rejectApplication',
      title: `Reject ${first.candidate} (${first.job})?`,
      detail: 'Reason: Salary expectations',
    });
  });
  it('puts the grounds of a rating it prepared on the card', async () => {
    const { first, access } = await withUuids();
    const context = await prepare([
      { tool: 'listApplications', input: {} },
      { tool: 'rateApplication', input: { id: APP_ID, rating: 3, basis: 'Six years in B2B sales,\nbut no key account work.' } },
    ], access);
    expect(context.proposals.size).toBe(1);
    const [proposal] = [...context.proposals.values()];
    expect(proposal).toMatchObject({ product: 'hire', action: 'rateApplication', title: `Rate ${first.candidate} (${first.job}) 3 out of 5?` });
    expect(proposal.detail).toMatch(/^Why: /);
    expect(proposal.detail).toBe('Why: Six years in B2B sales, but no key account work.');
  });
  it('prepares one application change per delegation: a second one in the same step is refused', async () => {
    const { first, access } = await withUuids();
    const context = await prepare([
      { tool: 'listApplications', input: {} },
      [
        { tool: 'rejectApplication', input: { id: APP_ID, outcome: 'rejected', reason: 'salary' } },
        { tool: 'rejectApplication', input: { id: APP_ID, outcome: 'withdrawn' } },
      ],
    ], access);
    expect(closed).not.toHaveBeenCalled();
    // Both calls reached the specialist's tools in one step; only the first became a card.
    expect(seen.calls.filter((c) => c.layer === 'worker')).toHaveLength(2);
    expect(context.proposals.size).toBe(1);
    const [proposal] = [...context.proposals.values()];
    expect(proposal).toMatchObject({
      action: 'rejectApplication',
      input: { id: APP_ID, outcome: 'rejected', reason: 'salary' },
      title: `Reject ${first.candidate} (${first.job})?`,
    });
    // The second was answered with the refusal, in the report the specialist's tools gave back.
    expect(seen.refusals).toEqual(['One application change at a time. One is already prepared for approval.']);
  });
  it('accepts an application id seen in an earlier turn, without listing it again', async () => {
    const { access } = await withUuids();
    // Nothing is looked up this turn: the id is only known from the names kept from an earlier one.
    const context = await prepare(
      [{ tool: 'rejectApplication', input: { id: APP_ID, outcome: 'rejected' } }],
      access,
      { [`application:${APP_ID}`]: 'Aina Rahman (Barista)' },
    );
    expect(seen.refusals).toEqual([]);
    expect(closed).not.toHaveBeenCalled();
    expect(context.proposals.size).toBe(1);
    expect([...context.proposals.values()][0]).toMatchObject({
      action: 'rejectApplication',
      input: { id: APP_ID, outcome: 'rejected' },
      // Named from the earlier turn too.
      title: 'Reject Aina Rahman (Barista)?',
    });
  });
  it('does not take the same id for an application when the earlier turn knew it as something else', async () => {
    const { access } = await withUuids();
    const context = await prepare(
      [{ tool: 'rejectApplication', input: { id: APP_ID, outcome: 'rejected' } }],
      access,
      { [`job:${APP_ID}`]: 'Barista' },
    );
    expect(context.proposals.size).toBe(0);
    expect(seen.refusals[0]).toContain(`You have not looked up ${APP_ID} as an application.`);
  });
  it('refuses a job’s id, even one it listed', async () => {
    const { access } = await withUuids();
    const context = await prepare([
      { tool: 'listJobs', input: {} },
      { tool: 'rejectApplication', input: { id: JOB_ID, outcome: 'rejected' } },
    ], access);
    expect(context.proposals.size).toBe(0);
    expect(closed).not.toHaveBeenCalled();
  });
  it('refuses an id nobody looked up', async () => {
    const { access } = await withUuids();
    const context = await prepare([
      { tool: 'listApplications', input: {} },
      { tool: 'rejectApplication', input: { id: '99999999-9999-4999-8999-999999999999', outcome: 'rejected' } },
    ], access);
    expect(context.proposals.size).toBe(0);
    expect(closed).not.toHaveBeenCalled();
  });
});

describe('the candidate changes need approval', () => {
  const CANDIDATE_TOOLS = ['addCandidate', 'updateCandidate'];
  const writer = () => ({ ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } });
  it('a writer’s toolkit asks for approval on both, and a viewer’s holds neither', () => {
    expect(HIRE_WRITE_TOOL_NAMES).toEqual(expect.arrayContaining(CANDIDATE_TOOLS));
    const { tools, toolApproval } = combineToolkits([hireProduct(writer())]);
    for (const name of CANDIDATE_TOOLS) {
      expect(Object.keys(tools), name).toContain(name);
      expect(toolApproval?.[name], name).toBe('user-approval');
    }
    expect(Object.keys(tools)).toContain('listCandidates');
    expect(toolApproval?.listCandidates).toBeUndefined();
    const viewer = combineToolkits([hireProduct({ ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: false } })]);
    for (const name of CANDIDATE_TOOLS) {
      expect(Object.keys(viewer.tools), name).not.toContain(name);
      expect(viewer.toolApproval?.[name], name).toBeUndefined();
    }
  });
});

describe('Tuah’s team adding and editing a candidate', () => {
  const CAND_ID = '44444444-4444-4444-8444-444444444441';
  const JOB_ID = '55555555-5555-4555-8555-555555555551';
  const APP_ID = '66666666-6666-4666-8666-666666666661';
  const MADE_UP = '99999999-9999-4999-8999-999999999999';
  const writer = () => ({ ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } });
  /** The seed's ids are not UUIDs, which the change tools require: the first candidate, job and application get real ones. */
  const withUuids = async () => {
    const base = hire().data;
    const [firstCandidate] = await base.listCandidates();
    const [firstJob] = await base.listJobs();
    const [firstApp] = await base.listApplications();
    const data = {
      ...base,
      listCandidates: async () => (await base.listCandidates()).map((c) => (c.id === firstCandidate.id ? { ...c, id: CAND_ID } : c)),
      listJobs: async () => (await base.listJobs()).map((j) => (j.id === firstJob.id ? { ...j, id: JOB_ID } : j)),
      listApplications: async () => (await base.listApplications()).map((a) => (a.id === firstApp.id ? { ...a, id: APP_ID } : a)),
    };
    return { candidate: firstCandidate, job: firstJob, access: { data, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } } };
  };
  const prepare = async (
    script: NonNullable<typeof seen.workerScript>,
    access: Awaited<ReturnType<typeof withUuids>>['access'],
    names: Record<string, string> = {},
  ) => {
    candidateAdded.mockReset();
    candidateSaved.mockReset();
    const context = { ...team(), names };
    seen.calls = [];
    seen.workerScript = script;
    seen.workerStep = 0;
    seen.refusals = [];
    try {
      await runTuah(
        [{ role: 'user' as const, content: 'Update the first candidate' }],
        reach(), undefined, undefined, null, null, context, access,
      ).consumeStream();
    } finally {
      seen.workerScript = null;
    }
    return context;
  };
  const nothingSaved = () => {
    expect(candidateAdded).not.toHaveBeenCalled();
    expect(candidateSaved).not.toHaveBeenCalled();
  };

  it('prepares one card for an edit of a candidate it listed, and saves nothing', async () => {
    const { candidate, access } = await withUuids();
    const context = await prepare([
      { tool: 'listCandidates', input: {} },
      { tool: 'updateCandidate', input: { id: CAND_ID, phone: '+60 12-999 0000', email: 'new@example.com', headline: null } },
    ], access);
    nothingSaved();
    expect(seen.refusals).toEqual([]);
    expect(context.proposals.size).toBe(1);
    const [proposal] = [...context.proposals.values()];
    expect(proposal).toMatchObject({
      product: 'hire',
      action: 'updateCandidate',
      title: `Save changes to candidate “${candidate.name}”?`,
      detail: 'Changes: email (new@example.com), phone, headline (cleared)',
    });
    expect(JSON.stringify([proposal.title, proposal.detail])).not.toContain('999 0000');
  });
  it('prepares an add for a job it listed, with the job’s title on the card', async () => {
    const { job, access } = await withUuids();
    const context = await prepare([
      { tool: 'listJobs', input: {} },
      { tool: 'addCandidate', input: { name: 'Nur Aina', job_id: JOB_ID, email: 'aina@example.com' } },
    ], access);
    nothingSaved();
    expect(seen.refusals).toEqual([]);
    const [proposal] = [...context.proposals.values()];
    expect(proposal).toMatchObject({
      action: 'addCandidate',
      title: 'Add candidate “Nur Aina”?',
      detail: `Sets: job (${job.title}), email (aina@example.com)`,
    });
  });
  it('prepares an add with no job without looking anything up', async () => {
    const { access } = await withUuids();
    const context = await prepare([{ tool: 'addCandidate', input: { name: 'Nur Aina' } }], access);
    expect(seen.refusals).toEqual([]);
    expect(context.proposals.size).toBe(1);
    expect([...context.proposals.values()][0]).toMatchObject({ action: 'addCandidate', title: 'Add candidate “Nur Aina”?', detail: null });
  });
  it('shows no card for an add whose name is blank: the tool’s schema refuses it before the change is prepared', async () => {
    const { access } = await withUuids();
    const context = await prepare([{ tool: 'addCandidate', input: { name: '   ' } }], access);
    expect(context.proposals.size).toBe(0);
    nothingSaved();
  });
  it('accepts a candidate id seen in an earlier turn, and names it', async () => {
    const { access } = await withUuids();
    const context = await prepare(
      [{ tool: 'updateCandidate', input: { id: CAND_ID, location: 'Klang' } }],
      access,
      { [`candidate:${CAND_ID}`]: 'Aina Rahman' },
    );
    expect(seen.refusals).toEqual([]);
    expect([...context.proposals.values()][0]).toMatchObject({ title: 'Save changes to candidate “Aina Rahman”?' });
  });
  it('refuses an edit with a made-up id', async () => {
    const { access } = await withUuids();
    const context = await prepare([
      { tool: 'listCandidates', input: {} },
      { tool: 'updateCandidate', input: { id: MADE_UP, location: 'Klang' } },
    ], access);
    expect(context.proposals.size).toBe(0);
    nothingSaved();
    expect(seen.refusals[0]).toContain(`You have not looked up ${MADE_UP}`);
  });
  it('refuses an edit with a job’s or an application’s id, even one it listed', async () => {
    const { access } = await withUuids();
    for (const [lookup, id] of [['listJobs', JOB_ID], ['listApplications', APP_ID]] as const) {
      const context = await prepare([
        { tool: lookup, input: {} },
        { tool: 'updateCandidate', input: { id, location: 'Klang' } },
      ], access);
      expect(context.proposals.size, lookup).toBe(0);
      nothingSaved();
      expect(seen.refusals[0], lookup).toBe(
        `You have not looked up ${id} as a candidate. Never guess an id: use listCandidates ` +
          'to find the candidate and get its real id, then prepare the change again.',
      );
    }
  });
  it('refuses an edit with an id an earlier turn knew as something else', async () => {
    const { access } = await withUuids();
    const context = await prepare(
      [{ tool: 'updateCandidate', input: { id: CAND_ID, location: 'Klang' } }],
      access,
      { [`job:${CAND_ID}`]: 'Barista' },
    );
    expect(context.proposals.size).toBe(0);
    expect(seen.refusals[0]).toContain(`You have not looked up ${CAND_ID} as a candidate.`);
  });
  it('refuses an add whose job_id was never looked up as a job', async () => {
    const { access } = await withUuids();
    const unseen = await prepare([{ tool: 'addCandidate', input: { name: 'Nur Aina', job_id: MADE_UP } }], access);
    expect(unseen.proposals.size).toBe(0);
    expect(seen.refusals[0]).toContain(`You have not looked up ${MADE_UP}`);
    // A candidate's id is not a job's.
    const wrong = await prepare([
      { tool: 'listCandidates', input: {} },
      { tool: 'addCandidate', input: { name: 'Nur Aina', job_id: CAND_ID } },
    ], access);
    expect(wrong.proposals.size).toBe(0);
    expect(seen.refusals[0]).toBe(
      `You have not looked up ${CAND_ID} as a job. Never guess an id: use listJobs ` +
        'to find the job and get its real id, then prepare the change again.',
    );
    nothingSaved();
  });
  it('prepares one candidate change per delegation: a second one in the same step is refused', async () => {
    const { access } = await withUuids();
    const context = await prepare([
      { tool: 'listCandidates', input: {} },
      [
        { tool: 'updateCandidate', input: { id: CAND_ID, location: 'Klang' } },
        { tool: 'addCandidate', input: { name: 'Nur Aina' } },
      ],
    ], access);
    nothingSaved();
    expect(seen.calls.filter((c) => c.layer === 'worker')).toHaveLength(2);
    expect(context.proposals.size).toBe(1);
    expect([...context.proposals.values()][0]).toMatchObject({ action: 'updateCandidate', input: { id: CAND_ID, location: 'Klang' } });
    expect(seen.refusals).toEqual(['One candidate change at a time. One is already prepared for approval.']);
  });
  it('tells Tuah, in its roster line, that Lekir can add or edit one candidate at a time', async () => {
    seen.calls = [];
    await runTuah(ask, reach(), undefined, undefined, null, null, team(), hire()).consumeStream();
    const line = seen.calls[0].system.split('\n').find((l) => l.startsWith('- askLekir:'));
    expect(line).toContain('Applications can be moved, rejected, reopened and rated, one at a time. Candidates can be added by hand and edited, one at a time. ');
    expect(line).toContain('Candidates can be added by hand and edited, one at a time. An application or a candidate can be deleted, one at a time. ');
    // The roster line stays one sentence-ending line.
    expect(line!.endsWith('.')).toBe(true);
    expect(line).not.toContain('..');
  });
  it('tells the specialist, in what it is asked, that it can prepare adding or editing one candidate at a time', async () => {
    const asks = createTeamTools([hireProduct(writer())], team()).tools.askLekir as unknown as { description: string };
    expect(asks.description).toContain('it can prepare adding or editing one candidate at a time');
    expect(asks.description).toMatch(/to look things up or to prepare a change\. Give Lekir/);
  });
});

describe('Tuah’s team deleting an application or a candidate', () => {
  const CAND_ID = '44444444-4444-4444-8444-444444444442';
  const OTHER_CAND = '44444444-4444-4444-8444-444444444443';
  const APP_ID = '66666666-6666-4666-8666-666666666662';
  const MADE_UP = '99999999-9999-4999-8999-999999999999';
  const ONE_DELETION = 'One deletion at a time. One is already prepared for approval.';
  const AMBIGUOUS =
    'More than one match was found for that name, so no deletion was prepared. Stop here: say who matches and ask the user which one they mean. ' +
    'Once the user has said who, they can ask for the deletion again.';
  /**
   * The seed's ids are not UUIDs, which the change tools require. Two candidates share a first name, to be ambiguous.
   * The seed has people called Aisyah of its own (one of them an Aisyah Lim): they are left out, so that the full
   * name fits one person and the first name fits exactly these two.
   */
  const withUuids = async () => {
    const base = hire().data;
    const [c1, c2] = await base.listCandidates();
    const [a1] = await base.listApplications();
    const data = {
      ...base,
      listCandidates: async () =>
        (await base.listCandidates())
          .filter((c) => c.id === c1.id || c.id === c2.id || !c.name.includes('Aisyah'))
          .map((c) =>
            c.id === c1.id ? { ...c, id: CAND_ID, name: 'Aisyah Lim' } : c.id === c2.id ? { ...c, id: OTHER_CAND, name: 'Aisyah binti Karim' } : c),
      listApplications: async () => (await base.listApplications()).map((a) => (a.id === a1.id ? { ...a, id: APP_ID } : a)),
    };
    return { application: a1, access: { data, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } } };
  };
  const prepare = async (
    script: NonNullable<typeof seen.workerScript>,
    access: Awaited<ReturnType<typeof withUuids>>['access'],
    names: Record<string, string> = {},
  ) => {
    applicationDeleted.mockReset();
    candidateDeleted.mockReset();
    const context = { ...team(), names };
    seen.calls = [];
    seen.workerScript = script;
    seen.workerStep = 0;
    seen.refusals = [];
    try {
      await runTuah(
        [{ role: 'user' as const, content: 'Delete the candidate Aisyah Lim' }],
        reach(), undefined, undefined, null, null, context, access,
      ).consumeStream();
    } finally {
      seen.workerScript = null;
    }
    return context;
  };
  const nothingDeleted = () => {
    expect(applicationDeleted).not.toHaveBeenCalled();
    expect(candidateDeleted).not.toHaveBeenCalled();
  };

  it('both tools ask for approval for a writer, and a viewer holds neither', () => {
    const writer = { ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
    const { tools, toolApproval } = combineToolkits([hireProduct(writer)]);
    for (const name of ['deleteApplication', 'deleteCandidate']) {
      expect(HIRE_WRITE_TOOL_NAMES, name).toContain(name);
      expect(Object.keys(tools), name).toContain(name);
      expect(toolApproval?.[name], name).toBe('user-approval');
    }
    const viewer = combineToolkits([hireProduct({ ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: false } })]);
    for (const name of ['deleteApplication', 'deleteCandidate']) expect(Object.keys(viewer.tools), name).not.toContain(name);
  });
  it('prepares one card for a candidate it looked up by full name, and deletes nothing', async () => {
    const { access } = await withUuids();
    const context = await prepare([
      { tool: 'listCandidates', input: { name: 'Aisyah Lim' } },
      { tool: 'deleteCandidate', input: { id: CAND_ID } },
    ], access);
    expect(seen.refusals).toEqual([]);
    expect(context.proposals.size).toBe(1);
    expect([...context.proposals.values()][0]).toMatchObject({
      action: 'deleteCandidate',
      input: { id: CAND_ID },
      title: 'Delete candidate “Aisyah Lim”?',
      detail: 'Every application, interview and CV file of theirs is deleted too. This cannot be undone.',
    });
    nothingDeleted();
  });
  it('prepares one card for an application it listed', async () => {
    const { application, access } = await withUuids();
    const context = await prepare([
      { tool: 'listApplications', input: {} },
      { tool: 'deleteApplication', input: { id: APP_ID } },
    ], access);
    expect(seen.refusals).toEqual([]);
    expect([...context.proposals.values()][0]).toMatchObject({
      action: 'deleteApplication',
      title: `Delete the application of ${application.candidate_name} (${application.job_title})?`,
      detail: 'Its interviews and its CV file are deleted too. The candidate stays on file. This cannot be undone.',
    });
    nothingDeleted();
  });
  it('refuses a made-up id', async () => {
    const { access } = await withUuids();
    const context = await prepare([
      { tool: 'listCandidates', input: { name: 'Aisyah Lim' } },
      { tool: 'deleteCandidate', input: { id: MADE_UP } },
    ], access);
    expect(context.proposals.size).toBe(0);
    expect(seen.refusals[0]).toContain(`You have not looked up ${MADE_UP}`);
    nothingDeleted();
  });
  it('refuses an id of the other kind, even one it listed', async () => {
    const { access } = await withUuids();
    const asCandidate = await prepare([
      { tool: 'listApplications', input: {} },
      { tool: 'deleteCandidate', input: { id: APP_ID } },
    ], access);
    expect(asCandidate.proposals.size).toBe(0);
    expect(seen.refusals[0]).toBe(
      `You have not looked up ${APP_ID} as a candidate. Never guess an id: use listCandidates ` +
        'to find the candidate and get its real id, then prepare the change again.',
    );
    const asApplication = await prepare([
      { tool: 'listCandidates', input: { name: 'Aisyah Lim' } },
      { tool: 'deleteApplication', input: { id: CAND_ID } },
    ], access);
    expect(asApplication.proposals.size).toBe(0);
    expect(seen.refusals[0]).toBe(
      `You have not looked up ${CAND_ID} as an application. Never guess an id: use listApplications ` +
        'to find the application and get its real id, then prepare the change again.',
    );
    nothingDeleted();
  });
  it('makes one card when two deletions are called in one step', async () => {
    const { access } = await withUuids();
    const context = await prepare([
      { tool: 'listCandidates', input: {} },
      [
        { tool: 'deleteCandidate', input: { id: CAND_ID } },
        { tool: 'deleteCandidate', input: { id: OTHER_CAND } },
      ],
    ], access);
    expect(context.proposals.size).toBe(1);
    expect([...context.proposals.values()][0]).toMatchObject({ action: 'deleteCandidate', input: { id: CAND_ID } });
    expect(seen.refusals).toEqual([ONE_DELETION]);
    nothingDeleted();
  });
  it('refuses a deletion when another change is already prepared in the same step', async () => {
    const { access } = await withUuids();
    const context = await prepare([
      { tool: 'listCandidates', input: {} },
      [
        { tool: 'updateCandidate', input: { id: CAND_ID, location: 'Klang' } },
        { tool: 'deleteCandidate', input: { id: CAND_ID } },
      ],
    ], access);
    expect(context.proposals.size).toBe(1);
    expect([...context.proposals.values()][0]).toMatchObject({ action: 'updateCandidate' });
    expect(seen.refusals).toEqual([ONE_DELETION]);
  });
  it('refuses a deletion from a lookup that said several people match, and nothing is prepared however often it is tried', async () => {
    const { access } = await withUuids();
    const context = await prepare([
      { tool: 'listCandidates', input: { name: 'Aisyah' } },
      { tool: 'deleteCandidate', input: { id: CAND_ID } },
    ], access);
    // Tuah asks again until its step limit; a later delegation has not looked the id up at all, which is refused too.
    expect(context.proposals.size).toBe(0);
    expect(seen.refusals[0]).toBe(AMBIGUOUS);
    for (const refusal of seen.refusals) expect(refusal === AMBIGUOUS || refusal.startsWith('You have not looked up')).toBe(true);
    nothingDeleted();
  });
  it('accepts an id an earlier turn knew as a candidate, with no new lookup', async () => {
    const { access } = await withUuids();
    const context = await prepare(
      [{ tool: 'deleteCandidate', input: { id: CAND_ID } }],
      access,
      { [`candidate:${CAND_ID}`]: 'Aisyah Lim' },
    );
    expect(seen.refusals).toEqual([]);
    expect([...context.proposals.values()][0]).toMatchObject({ title: 'Delete candidate “Aisyah Lim”?' });
  });
  it('tells Tuah, in what the specialist is asked, that Lekir can prepare a deletion', () => {
    const writer = { ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
    const asks = createTeamTools([hireProduct(writer)], team()).tools.askLekir as unknown as { description: string };
    expect(asks.description).toContain('it can prepare deleting one application or one candidate at a time');
    expect(asks.description).toContain('it can prepare adding or editing one candidate at a time');
  });
});

describe('one agent holding the delete tools', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const writer = () => ({ ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } });
  type Part = { type: string; isAutomatic?: boolean; toolCall?: { toolName?: string } };
  const ONE_DELETION = 'One deletion at a time. One is already prepared for approval.';

  // Tuah without a team holds the hiring tools itself, as Lekir does in its own chat: both go through the same gate.
  // The model here calls deleteCandidate twice in its first step (the script's list), as the worker would.
  it('shows the user one card when the model asks for two deletions at once, and deletes nothing', async () => {
    candidateDeleted.mockReset();
    seen.calls = [];
    seen.refusals = [];
    seen.singleScript = [[
      { tool: 'deleteCandidate', input: { id: A } },
      { tool: 'deleteCandidate', input: { id: B } },
    ]];
    let steps: { content: Part[] }[] = [];
    try {
      const result = runTuah(
        [{ role: 'user' as const, content: 'Delete both candidates' }],
        reach(), undefined, undefined, null, null, null, writer(),
      );
      await result.consumeStream();
      steps = (await result.steps) as unknown as { content: Part[] }[];
    } finally {
      seen.singleScript = null;
    }
    const requests = steps.flatMap((s) => s.content).filter((p) => p.type === 'tool-approval-request');
    const forTheUser = requests.filter((p) => !p.isAutomatic);
    expect(forTheUser).toHaveLength(1);
    expect(forTheUser[0].toolCall?.toolName).toBe('deleteCandidate');
    expect(candidateDeleted).not.toHaveBeenCalled();
  });

  // The rest drive the SDK through the whole exchange: the request that shows the card, then the one the browser
  // sends with the user's answer. The SDK asks the gate about an approved call a second time in that later request.
  type Message = import('ai').ModelMessage;
  type Run = { cards: { approvalId: string; toolCall: { toolName: string; input: unknown } }[]; denials: (string | undefined)[]; messages: Message[] };
  type Call = { tool: string; input: unknown };
  /**
   * One request: the model's first step makes every call in `script`, and any later step answers in words.
   * A script that is a list of lists is one list per step.
   */
  const request = async (
    messages: Message[],
    script: Call[] | Call[][],
    agent: 'tuah' | 'lekir' = 'tuah',
    access: ReturnType<typeof writer> = writer(),
  ): Promise<Run> => {
    seen.calls = [];
    seen.singleScript = (Array.isArray(script[0]) ? script : [script]) as Call[][];
    try {
      const result = agent === 'lekir'
        ? runLekir(messages, access)
        : runTuah(messages, reach(), undefined, undefined, null, null, null, access);
      await result.consumeStream();
      const content = ((await result.steps) as unknown as { content: (Part & Record<string, unknown>)[] }[]).flatMap((s) => s.content);
      return {
        cards: content.filter((p) => p.type === 'tool-approval-request' && !p.isAutomatic) as unknown as Run['cards'],
        denials: content.filter((p) => p.type === 'tool-approval-response' && p.approved === false).map((p) => p.reason as string | undefined),
        messages: [...messages, ...(await result.response).messages],
      };
    } finally {
      seen.singleScript = null;
    }
  };
  const answer = (approvalId: string, approved: boolean): Message =>
    ({ role: 'tool', content: [{ type: 'tool-approval-response', approvalId, approved }] }) as Message;
  const both = [
    { tool: 'deleteCandidate', input: { id: A } },
    { tool: 'deleteCandidate', input: { id: B } },
  ];
  const asked: Message[] = [{ role: 'user', content: 'Delete both candidates' }];
  const removed = { ok: true, data: { id: A, name: 'Aina Rahman', job: null, applications: 0, interviews: 0, cv_files: 0, message: 'Deleted Aina Rahman.' } };

  it.each(['tuah', 'lekir'] as const)('%s: the second of two deletions is denied with the reason, and never becomes a card', async (agent) => {
    candidateDeleted.mockReset();
    const first = await request(asked, both, agent);
    expect(first.cards).toHaveLength(1);
    expect(first.cards[0].toolCall).toMatchObject({ toolName: 'deleteCandidate', input: { id: A } });
    expect(first.denials).toEqual([ONE_DELETION]);
    expect(candidateDeleted).not.toHaveBeenCalled();
  });
  it.each(['tuah', 'lekir'] as const)('%s: approving that one card deletes that one row, and a further deletion in the same turn gets no card', async (agent) => {
    candidateDeleted.mockReset();
    candidateDeleted.mockResolvedValue(removed);
    const first = await request(asked, both, agent);
    // The model, told the row is gone, asks for two more deletions in the same turn.
    const second = await request([...first.messages, answer(first.cards[0].approvalId, true)], both, agent);
    expect(candidateDeleted).toHaveBeenCalledTimes(1);
    expect(candidateDeleted.mock.calls[0][1]).toEqual({ id: A });
    expect(second.cards).toEqual([]);
    expect(second.denials).toEqual([ONE_DELETION, ONE_DELETION]);
  });
  it('a rejected card still counts as the turn\'s one deletion', async () => {
    candidateDeleted.mockReset();
    const first = await request(asked, both);
    const second = await request([...first.messages, answer(first.cards[0].approvalId, false)], [{ tool: 'deleteCandidate', input: { id: B } }]);
    expect(second.cards).toEqual([]);
    expect(second.denials).toEqual([ONE_DELETION]);
    expect(candidateDeleted).not.toHaveBeenCalled();
  });
  it('the next thing the user says is a new turn, with one deletion of its own', async () => {
    candidateDeleted.mockReset();
    candidateDeleted.mockResolvedValue(removed);
    const first = await request(asked, both);
    const second = await request([...first.messages, answer(first.cards[0].approvalId, true)], []);
    const third = await request([...second.messages, { role: 'user', content: 'Now the other one' }], [{ tool: 'deleteCandidate', input: { id: B } }]);
    expect(third.cards).toHaveLength(1);
    expect(third.cards[0].toolCall).toMatchObject({ toolName: 'deleteCandidate', input: { id: B } });
    expect(third.denials).toEqual([]);
    expect(candidateDeleted).toHaveBeenCalledTimes(1);
  });
  it('another kind of change beside a deletion keeps its own card', async () => {
    candidateDeleted.mockReset();
    candidateSaved.mockReset();
    const run = await request(asked, [
      { tool: 'updateCandidate', input: { id: A, location: 'Klang' } },
      { tool: 'deleteCandidate', input: { id: B } },
      { tool: 'updateCandidate', input: { id: B, location: 'Klang' } },
    ]);
    expect(run.cards.map((c) => c.toolCall.toolName)).toEqual(['updateCandidate', 'deleteCandidate', 'updateCandidate']);
    expect(run.denials).toEqual([]);
  });
  const AMBIGUOUS =
    'More than one match was found for that name, so no deletion was prepared. Stop here: say who matches and ask the user which one they mean. ' +
    'Once the user has said who, they can ask for the deletion again.';
  /** Two candidates who share a first name, with real ids. The seed's own Aisyahs are left out, so exactly these two match. */
  const twoAisyahs = () => {
    const base = hire().data;
    const listCandidates = async () => {
      const all = await base.listCandidates();
      return all
        .filter((c, n) => n < 2 || !c.name.includes('Aisyah'))
        .map((c, n) => (n === 0 ? { ...c, id: A, name: 'Aisyah Lim' } : n === 1 ? { ...c, id: B, name: 'Aisyah binti Karim' } : c));
    };
    return { ...writer(), data: { ...base, listCandidates } };
  };
  it.each(['tuah', 'lekir'] as const)('%s: a deletion after a lookup that said several people match is denied with words that stop the model, and there is no card', async (agent) => {
    candidateDeleted.mockReset();
    const run = await request(
      [{ role: 'user', content: 'Delete the candidate Aisyah' }],
      [[{ tool: 'listCandidates', input: { name: 'Aisyah' } }], [{ tool: 'deleteCandidate', input: { id: A } }]],
      agent,
      twoAisyahs(),
    );
    expect(run.cards).toEqual([]);
    expect(run.denials).toEqual([AMBIGUOUS]);
    // The sentence must not send the model back to a lookup, which cannot clear the refusal in the same turn.
    expect(AMBIGUOUS).not.toMatch(/look it up again/);
    expect(candidateDeleted).not.toHaveBeenCalled();
  });
  it('a viewer holds no delete tool, so there is nothing to gate', async () => {
    seen.calls = [];
    await runLekir(asked, { ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: false } }).consumeStream();
    expect(seen.calls[0].tools).not.toContain('deleteCandidate');
    expect(seen.calls[0].tools).not.toContain('deleteApplication');
  });
});
