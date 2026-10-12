import { describe, expect, it, vi } from 'vitest';
import { createSeedHireData } from '@/lib/hire/seed';
import { createSeedReachData } from '@/lib/reach/seed';
import { HIRE_TOOL_NAMES } from '@/lib/ai/hire-tools';
import { HIRE_WRITE_TOOL_NAMES } from '@/lib/ai/products';
import { fullDate } from '@/lib/hire/lists';

const seen = vi.hoisted(() => ({
  calls: [] as { layer: string; system: string; tools: string[]; prompt: string }[],
  /** Everything any model was sent, in every request since a test last emptied it. */
  sent: [] as string[],
  /** Set by the one test that needs a change prepared: Tuah asks Lekir, and Lekir calls createJob. */
  prepareJob: false,
  /**
   * Set by a test that scripts what Lekir calls, step by step (the last one repeats); Tuah then asks Lekir once.
   * A step that is a list makes all of its calls at once, in that one step. The step 'answer' has Lekir report in words,
   * which ends that delegation: Tuah then asks Lekir again, and the script goes on in the new delegation.
   */
  workerScript: null as null | ({ tool: string; input: unknown } | { tool: string; input: unknown }[] | 'answer')[],
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
const poolSet = vi.hoisted(() => vi.fn());
const pipelineMoved = vi.hoisted(() => vi.fn());

// The real schemas, so the prepared input is checked as it is in the app; only the write is recorded.
vi.mock('@/lib/hire/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/capabilities')>()),
  createJob: created,
  closeApplication: closed,
  addCandidate: candidateAdded,
  updateCandidate: candidateSaved,
  deleteApplication: applicationDeleted,
  deleteCandidate: candidateDeleted,
  setPoolStatus: poolSet,
  moveToPipeline: pipelineMoved,
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
            prompt: JSON.stringify(options.prompt),
          });
          seen.sent.push(JSON.stringify(options.prompt));
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
                  ? ((step) => (step === 'answer' ? answer : callAll([step].flat())))(seen.workerScript[Math.min(seen.workerStep++, seen.workerScript.length - 1)])
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
const { namesIn, proposalsIn } = await import('@/lib/chat/delegation');
const { toPendingApproval } = await import('@/components/chat/tool-parts');
const { storedParts } = await import('@/lib/chat/stored-parts');
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
    // A team that can prepare a deletion asks through a gate; for a change that is not a deletion it answers as before.
    expect(Object.keys(toolApproval!)).toEqual(['applyChange']);
    expect(await (toolApproval!.applyChange as (i: unknown, o: unknown) => unknown)({ proposalId: proposal.id }, { toolCallId: 't', messages: [] }))
      .toBe('user-approval');
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
    expect(TUAH_SYSTEM).toContain('outside marketing, the CRM, hiring and HR');
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
  it('keeps only finance in the blind spot now that HR is wired', () => {
    expect(TUAH_SYSTEM).toContain("cannot see the workspace's finance yet");
    expect(TUAH_SYSTEM).toMatch(/invoices and other finance records/);
    // HR is reachable via Lekiu now, so payroll and staff left the blind spot.
    expect(TUAH_SYSTEM).not.toContain('cannot see the rest of the workspace yet');
    expect(TUAH_SYSTEM).not.toContain('payroll and staff');
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
  it('keeps refusing in a later delegation of the same turn, when Tuah asks again with the full name', async () => {
    const { access } = await withUuids();
    const context = await prepare([
      { tool: 'listCandidates', input: { name: 'Aisyah' } },
      { tool: 'deleteCandidate', input: { id: CAND_ID } },
      'answer',
      // A new delegation: its own lookup fits one person, and says nothing of several.
      { tool: 'listCandidates', input: { name: 'Aisyah Lim' } },
      { tool: 'deleteCandidate', input: { id: CAND_ID } },
    ], access);
    expect(context.proposals.size).toBe(0);
    // The first refusal is the first delegation's; the second is the new delegation's, after its own clean lookup.
    expect(seen.refusals.slice(0, 2)).toEqual([AMBIGUOUS, AMBIGUOUS]);
    // The script's last call repeats in delegations that looked nothing up, until Tuah's step limit: refused as well.
    for (const refusal of seen.refusals) expect(refusal === AMBIGUOUS || refusal.startsWith('You have not looked up')).toBe(true);
    nothingDeleted();
  });
  it('prepares the deletion of a candidate whose name another has when the two can be told apart, and keeps the telling line out of what it reports', async () => {
    const { access } = await withUuids();
    const shared = {
      ...access,
      data: {
        ...access.data,
        listCandidates: async () =>
          (await access.data.listCandidates()).map((c) =>
            c.id === CAND_ID ? { ...c, email: 'aina.r@example.com' } : c.id === OTHER_CAND ? { ...c, name: ' aisyah  LIM', email: 'other@example.com' } : c),
      },
    };
    const context = await prepare([{ tool: 'deleteCandidate', input: { id: CAND_ID } }], shared, { [`candidate:${CAND_ID}`]: 'Aisyah Lim' });
    expect(seen.refusals).toEqual([]);
    expect(context.proposals.size).toBe(1);
    // The proposal travels in the conversation, which Tuah's model reads: it holds no email.
    expect(JSON.stringify([...context.proposals.values()])).not.toContain('example.com');
    nothingDeleted();
  });
  it('refuses two candidates of one name that look the same, read from the workspace and not from what was looked up', async () => {
    const { access } = await withUuids();
    const alike = {
      ...access,
      data: {
        ...access.data,
        listCandidates: async () => {
          const rows = await access.data.listCandidates();
          const first = rows.find((c) => c.id === CAND_ID)!;
          return rows.map((c) => (c.id === CAND_ID || c.id === OTHER_CAND ? { ...first, id: c.id, name: c.id === CAND_ID ? 'Aisyah Lim' : ' aisyah  LIM', email: null } : c));
        },
      },
    };
    // The id comes from an earlier turn: this delegation looks nobody up, so no lookup of its own shows the shared name.
    const context = await prepare([{ tool: 'deleteCandidate', input: { id: CAND_ID } }], alike, { [`candidate:${CAND_ID}`]: 'Aisyah Lim' });
    expect(context.proposals.size).toBe(0);
    expect(seen.refusals[0]).toBe('Two candidates called Aisyah Lim look the same from here, so I cannot tell them apart. Nothing was deleted.');
    nothingDeleted();
  });
  it('for an application: refused when another from the same name for the same job looks the same, prepared when it does not', async () => {
    const { application, access } = await withUuids();
    const TWIN = '66666666-6666-4666-8666-666666666663';
    const withTwin = (applied_at?: string) => ({
      ...access,
      data: {
        ...access.data,
        listApplications: async () => {
          const rows = await access.data.listApplications();
          const first = rows.find((a) => a.id === APP_ID)!;
          return [...rows, { ...first, id: TWIN, applied_at: applied_at ?? first.applied_at }];
        },
      },
    });
    const script = [{ tool: 'listApplications', input: {} }, { tool: 'deleteApplication', input: { id: APP_ID } }];
    const refused = await prepare(script, withTwin());
    expect(refused.proposals.size).toBe(0);
    expect(seen.refusals[0]).toBe(
      `Two applications from someone called ${application.candidate_name} for ${application.job_title} look the same from here, so I cannot tell them apart. Nothing was deleted.`,
    );
    const prepared = await prepare(script, withTwin('2020-01-01T02:00:00Z'));
    expect(seen.refusals).toEqual([]);
    expect(prepared.proposals.size).toBe(1);
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
  type Message = import('ai').ModelMessage;
  /** An earlier turn that listed both candidates: an id may only come from a lookup the conversation holds. */
  const listedBoth = [
    { role: 'user', content: 'Who is on file?' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'listCandidates', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'l1', toolName: 'listCandidates', output: { type: 'json', value: { total: 2, candidates: [{ id: A, name: 'Aina Rahman' }, { id: B, name: 'Farid Osman' }] } } }] },
    { role: 'assistant', content: 'Two candidates.' },
  ] as Message[];
  const asked: Message[] = [...listedBoth, { role: 'user', content: 'Delete both candidates' }];

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
      const result = runTuah(asked, reach(), undefined, undefined, null, null, null, writer());
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
  type Run = { cards: { approvalId: string; reason?: string; toolCall: { toolName: string; input: unknown } }[]; denials: (string | undefined)[]; messages: Message[] };
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
  it.each(['tuah', 'lekir'] as const)('%s: an id that no lookup in the conversation returned gets no card, and the model is sent to the lookup', async (agent) => {
    candidateDeleted.mockReset();
    const run = await request([{ role: 'user', content: `Delete candidate ${A}` }], [{ tool: 'deleteCandidate', input: { id: A } }], agent);
    expect(run.cards).toEqual([]);
    expect(run.denials).toEqual([
      `You have not looked up ${A} as a candidate. Never guess an id: use listCandidates ` +
        'to find the candidate and get its real id, then prepare the change again.',
    ]);
    expect(candidateDeleted).not.toHaveBeenCalled();
  });
  it('a card beside a call denied for a made-up id can still be approved', async () => {
    candidateDeleted.mockReset();
    candidateDeleted.mockResolvedValue(removed);
    const MADE_UP = '99999999-9999-4999-8999-999999999999';
    const first = await request(asked, [{ tool: 'deleteCandidate', input: { id: A } }, { tool: 'deleteCandidate', input: { id: MADE_UP } }]);
    expect(first.cards).toHaveLength(1);
    await request([...first.messages, answer(first.cards[0].approvalId, true)], []);
    expect(candidateDeleted).toHaveBeenCalledTimes(1);
    expect(candidateDeleted.mock.calls[0][1]).toEqual({ id: A });
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
  describe('two people with one name', () => {
    type Row = Awaited<ReturnType<ReturnType<typeof hire>['data']['listCandidates']>>[number];
    /** The first two candidates, as the test wants them; nobody else in the seed is called Aisyah. */
    const people = (first: Partial<Row>, second: Partial<Row>, namesake = { on: true }) => {
      const base = hire().data;
      const listCandidates = async () =>
        (await base.listCandidates())
          .filter((c, n) => n < 2 || !c.name.includes('Aisyah'))
          .filter((_, n) => n !== 1 || namesake.on)
          .map((c, n) => (n === 0 ? { ...c, id: A, name: 'Aisyah Lim', ...first } : n === 1 && namesake.on ? { ...c, id: B, name: 'aisyah  lim', ...second } : c));
      return { ...writer(), data: { ...base, listCandidates } };
    };
    // An earlier turn listed both and the user has said which: the model has the id and makes no new lookup, so
    // nothing in this turn says the name is shared. The server's own rows do. No email was ever shown to the model.
    const earlier = [
      { role: 'user', content: 'Delete Aisyah Lim' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'listCandidates', input: { name: 'Aisyah Lim' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'l1', toolName: 'listCandidates', output: { type: 'json', value: { total: 2, candidates: [{ id: A, name: 'Aisyah Lim', location: 'Klang' }, { id: B, name: 'aisyah  lim', location: 'Ipoh' }] } } }] },
      { role: 'assistant', content: 'Two people are called Aisyah Lim, one in Klang and one in Ipoh. Which one?' },
      { role: 'user', content: 'The one in Klang' },
    ] as Message[];
    const deleteA = [{ tool: 'deleteCandidate', input: { id: A } }];
    const created = { created_at: '2026-10-03T02:00:00Z' };
    const LINE = 'More than one candidate is called Aisyah Lim. This one: aina.r@example.com · added 03 Oct 2026.';

    it.each(['tuah', 'lekir'] as const)('%s: the card says which one it is, by the email of the row that will go, and no model is sent that email', async (agent) => {
      candidateDeleted.mockReset();
      candidateDeleted.mockResolvedValue(removed);
      seen.sent = [];
      const access = people({ email: 'aina.r@example.com', ...created }, { email: 'the.other@example.com', ...created });
      const first = await request(earlier, deleteA, agent, access);
      expect(first.cards).toHaveLength(1);
      expect(first.cards[0].toolCall).toMatchObject({ toolName: 'deleteCandidate', input: { id: A } });
      expect(first.cards[0].reason).toBe(LINE);
      expect(candidateDeleted).not.toHaveBeenCalled();
      // Approved: the same card is asked about again, still carries its line, and that one row goes.
      await request([...first.messages, answer(first.cards[0].approvalId, true)], [], agent, access);
      expect(candidateDeleted).toHaveBeenCalledTimes(1);
      expect(candidateDeleted.mock.calls[0][1]).toEqual({ id: A });
      // The model was called after the card, with the whole turn behind it, and was never sent either address.
      expect(seen.sent.length).toBeGreaterThan(1);
      for (const sent of seen.sent) expect(sent).not.toContain('example.com');
    });
    it('nobody shares the name: the card is as it always was, with no line', async () => {
      candidateDeleted.mockReset();
      const access = people({ email: 'aina.r@example.com' }, {}, { on: false });
      const run = await request(earlier, deleteA, 'lekir', access);
      expect(run.cards).toHaveLength(1);
      expect(run.cards[0].reason).toBeUndefined();
    });
    it.each(['tuah', 'lekir'] as const)('%s: two who look the same get no card', async (agent) => {
      candidateDeleted.mockReset();
      const alike = { email: null, location: 'Klang', headline: 'Barista', ...created };
      const run = await request(earlier, deleteA, agent, people(alike, { ...alike, location: ' klang' }));
      expect(run.cards).toEqual([]);
      expect(run.denials).toEqual(['Two candidates called Aisyah Lim look the same from here, so I cannot tell them apart. Nothing was deleted.']);
      expect(candidateDeleted).not.toHaveBeenCalled();
    });
    it('a namesake who appears between the card and the yes stops a card that did not say which one it was', async () => {
      candidateDeleted.mockReset();
      const namesake = { on: false };
      const access = people({ email: 'aina.r@example.com', ...created }, { email: 'the.other@example.com', ...created }, namesake);
      const first = await request(earlier, deleteA, 'lekir', access);
      expect(first.cards[0].reason).toBeUndefined();
      namesake.on = true;
      seen.sent = [];
      const second = await request([...first.messages, answer(first.cards[0].approvalId, true)], [], 'lekir', access);
      expect(candidateDeleted).not.toHaveBeenCalled();
      expect(second.cards).toEqual([]);
      // The model is told why, and that it may prepare it again: nothing here is the user's no.
      expect(seen.sent[0]).toContain('Someone else with the same name appeared after this was shown for approval');
    });
    it('after that stop, the deletion can be prepared again in the same turn, and the new card says which one', async () => {
      candidateDeleted.mockReset();
      const namesake = { on: false };
      const access = people({ email: 'aina.r@example.com', ...created }, { email: 'the.other@example.com', ...created }, namesake);
      const first = await request(earlier, deleteA, 'lekir', access);
      namesake.on = true;
      const second = await request([...first.messages, answer(first.cards[0].approvalId, true)], [[{ tool: 'deleteCandidate', input: { id: A } }]], 'lekir', access);
      expect(second.cards).toHaveLength(1);
      expect(second.cards[0].reason).toBe(LINE);
      expect(candidateDeleted).not.toHaveBeenCalled();
    });
  });
  it('a viewer holds no delete tool, so there is nothing to gate', async () => {
    seen.calls = [];
    await runLekir(asked, { ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: false } }).consumeStream();
    expect(seen.calls[0].tools).not.toContain('deleteCandidate');
    expect(seen.calls[0].tools).not.toContain('deleteApplication');
  });
});

// The browser keeps the chat and sends all of it with each request; a turn that has an approval in it is two
// requests. These run each request as the route does: the chat is turned into model messages by the SDK, the answer
// is read back as the browser reads it, and the user's yes or no is written on the part the way the chat does.
describe('one deletion a turn, as the browser carries the turn between requests', () => {
  type UI = import('ai').UIMessage;
  type Model = import('ai').ModelMessage;
  type ToolPart = { type: string; state?: string; toolCallId?: string; input?: unknown; approval?: { id: string; approved?: boolean; reason?: string; requestReason?: string; isAutomatic?: boolean } };
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const ONE_DELETION = 'One deletion at a time. One is already prepared for approval.';
  const removed = { ok: true, data: { id: A, name: 'Aisyah Lim', job: null, applications: 0, interviews: 0, cv_files: 0, message: 'Deleted Aisyah Lim.' } };
  const say = (id: string, text: string): UI => ({ id, role: 'user', parts: [{ type: 'text', text }] });
  /** Two candidates with real ids and names nobody else in the seed has. */
  const access = (first: Record<string, unknown> = {}, second: Record<string, unknown> = {}) => {
    const base = hire().data;
    const listCandidates = async () =>
      (await base.listCandidates())
        .filter((c, n) => n < 2 || !c.name.includes('Aisyah'))
        .map((c, n) => (n === 0 ? { ...c, id: A, name: 'Aisyah Lim', ...first } : n === 1 ? { ...c, id: B, name: 'Aisyah binti Karim', ...second } : c));
    return { data: { ...base, listCandidates }, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
  };
  type Runner = (messages: Model[], chat: UI[]) => { toUIMessageStream: () => ReadableStream<unknown> };
  const teamWith = (hiring: ReturnType<typeof access>): Runner => (messages, chat) =>
    runTuah(messages, reach(), undefined, undefined, null, null, { transcript: '', proposals: proposalsIn(chat), names: namesIn(chat) }, hiring);
  const asTeam = teamWith(access());
  const alone: Runner = (messages) => runTuah(messages, reach(), undefined, undefined, null, null, null, access());
  /** One request, and the chat as the browser holds it afterwards. */
  const exchange = async (chat: UI[], run: Runner): Promise<UI[]> => {
    const { convertToModelMessages, readUIMessageStream } = await import('ai');
    const last = chat[chat.length - 1];
    const paused = last.role === 'assistant' ? structuredClone(last) : undefined;
    seen.calls = [];
    const result = run(await convertToModelMessages(chat), chat);
    let answer: UI | undefined;
    for await (const message of readUIMessageStream({ message: paused, stream: result.toUIMessageStream() as never })) answer = message as UI;
    return paused ? [...chat.slice(0, -1), answer!] : [...chat, answer!];
  };
  const toolParts = (chat: UI[]) => chat.flatMap((m) => m.parts as unknown as ToolPart[]).filter((p) => p.type.startsWith('tool-'));
  /** The cards waiting for the user. */
  const waiting = (chat: UI[]) => toolParts(chat).filter((p) => p.state === 'approval-requested' && !p.approval?.isAutomatic);
  /** The chat after the user answered its one waiting card. */
  const decide = (chat: UI[], approved: boolean): UI[] => {
    const next = structuredClone(chat);
    const [card] = waiting(next);
    card.state = 'approval-responded';
    card.approval = { ...card.approval!, approved };
    return next;
  };

  it('one agent: the browser\'s form of a denied second deletion does not stop the first card being approved', async () => {
    candidateDeleted.mockReset();
    candidateDeleted.mockResolvedValue(removed);
    seen.singleScript = [
      [{ tool: 'listCandidates', input: {} }],
      [{ tool: 'deleteCandidate', input: { id: A } }, { tool: 'deleteCandidate', input: { id: B } }],
    ];
    try {
      const shown = await exchange([say('u1', 'Delete Aisyah Lim and Aisyah binti Karim')], alone);
      expect(waiting(shown)).toHaveLength(1);
      expect(waiting(shown)[0]).toMatchObject({ type: 'tool-deleteCandidate', input: { id: A } });
      // The second call reached the browser as a denial of the gate's, with its reason.
      const denied = toolParts(shown).filter((p) => p.state === 'output-denied');
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({ input: { id: B }, approval: { approved: false, reason: ONE_DELETION, isAutomatic: true } });
      // What the server is sent next holds that denial as an error text, not as the SDK wrote it in the first request.
      const { convertToModelMessages } = await import('ai');
      const sent = JSON.stringify(await convertToModelMessages(decide(shown, true)));
      expect(sent).toContain(`{"type":"error-text","value":"${ONE_DELETION}"}`);
      // The model, after the deletion ran, asks for the other one again in the same turn.
      seen.singleScript = [[{ tool: 'deleteCandidate', input: { id: B } }]];
      const after = await exchange(decide(shown, true), alone);
      expect(candidateDeleted).toHaveBeenCalledTimes(1);
      expect(candidateDeleted.mock.calls[0][1]).toEqual({ id: A });
      expect(waiting(after)).toEqual([]);
    } finally {
      seen.singleScript = null;
    }
  });

  it('team: after an approval, a second deletion in the same turn is refused and no card is shown; the next message allows one', async () => {
    candidateDeleted.mockReset();
    candidateDeleted.mockResolvedValue(removed);
    seen.refusals = [];
    seen.workerStep = 0;
    seen.workerScript = [
      { tool: 'listCandidates', input: { name: 'Aisyah Lim' } },
      { tool: 'deleteCandidate', input: { id: A } },
      // The request that carries the approval: Tuah asks Lekir again, for the other person.
      { tool: 'listCandidates', input: {} },
      { tool: 'deleteCandidate', input: { id: B } },
    ];
    try {
      const shown = await exchange([say('u1', 'Delete Aisyah Lim and Aisyah binti Karim')], asTeam);
      expect(waiting(shown)).toHaveLength(1);
      expect(waiting(shown)[0].type).toBe('tool-applyChange');
      expect(candidateDeleted).not.toHaveBeenCalled();

      const after = await exchange(decide(shown, true), asTeam);
      expect(candidateDeleted).toHaveBeenCalledTimes(1);
      expect(candidateDeleted.mock.calls[0][1]).toEqual({ id: A });
      expect(waiting(after)).toEqual([]);
      expect(seen.refusals.length).toBeGreaterThan(0);
      for (const refusal of seen.refusals) expect(refusal).toBe(ONE_DELETION);
      // Nothing was prepared for the other person.
      expect([...proposalsIn(after).values()].map((p) => p.input)).toEqual([{ id: A }]);

      // The user speaks again: a new turn, with one deletion of its own.
      seen.workerStep = 0;
      seen.workerScript = [{ tool: 'listCandidates', input: {} }, { tool: 'deleteCandidate', input: { id: B } }];
      const next = await exchange([...after, say('u2', 'Now delete Aisyah binti Karim')], asTeam);
      expect(waiting(next)).toHaveLength(1);
      const proposalId = (waiting(next)[0].input as { proposalId: string }).proposalId;
      expect(proposalsIn(next).get(proposalId)).toMatchObject({ action: 'deleteCandidate', input: { id: B } });
      expect(candidateDeleted).toHaveBeenCalledTimes(1);
    } finally {
      seen.workerScript = null;
    }
  });

  it('team: a shared name puts the telling line on the card the browser shows, and in nothing a model is sent', async () => {
    candidateDeleted.mockReset();
    candidateDeleted.mockResolvedValue(removed);
    seen.refusals = [];
    seen.sent = [];
    seen.workerStep = 0;
    // A listing with no name asked for: nothing calls it ambiguous, and it shows no email.
    seen.workerScript = [{ tool: 'listCandidates', input: {} }, { tool: 'deleteCandidate', input: { id: A } }];
    const run = teamWith(access(
      { email: 'aina.r@example.com', created_at: '2026-10-03T02:00:00Z' },
      { name: 'aisyah  LIM', email: 'the.other@example.com', created_at: '2026-10-03T02:00:00Z' },
    ));
    const LINE = 'More than one candidate is called Aisyah Lim. This one: aina.r@example.com · added 03 Oct 2026.';
    try {
      const shown = await exchange([say('u1', 'Delete the first candidate on the list')], run);
      expect(seen.refusals).toEqual([]);
      const [card] = waiting(shown);
      expect(card.type).toBe('tool-applyChange');
      expect(card.approval?.requestReason).toBe(LINE);
      // What the chat makes of that part: the note is there for the card to show.
      expect(toPendingApproval(card as never)).toMatchObject({ toolName: 'applyChange', note: LINE });
      // A chat saved and opened again keeps it, so the same card is shown and the approval still passes the last check.
      expect((storedParts([card])[0] as { approval?: { requestReason?: string } }).approval?.requestReason).toBe(LINE);

      await exchange(decide(shown, true), run);
      expect(candidateDeleted).toHaveBeenCalledTimes(1);
      expect(candidateDeleted.mock.calls[0][1]).toEqual({ id: A });
      // Tuah's model and Lekir's were each called, before the card and after it, and neither was sent an address.
      expect(seen.sent.length).toBeGreaterThan(2);
      for (const sent of seen.sent) expect(sent).not.toContain('example.com');
    } finally {
      seen.workerScript = null;
    }
  });

  it('team: a lookup that said several match still holds the deletion back in the turn\'s second request', async () => {
    const AMBIGUOUS =
      'More than one match was found for that name, so no deletion was prepared. Stop here: say who matches and ask the user which one they mean. ' +
      'Once the user has said who, they can ask for the deletion again.';
    candidateDeleted.mockReset();
    candidateSaved.mockReset();
    candidateSaved.mockResolvedValue({ ok: true, data: { id: B, name: 'Aisyah binti Karim' } });
    seen.refusals = [];
    seen.workerStep = 0;
    seen.workerScript = [
      // First delegation: the name fits two people, and the deletion is refused.
      { tool: 'listCandidates', input: { name: 'Aisyah' } },
      { tool: 'deleteCandidate', input: { id: A } },
      'answer',
      // Second delegation, same request: another kind of change, which gets a card. The request ends there.
      { tool: 'listCandidates', input: {} },
      { tool: 'updateCandidate', input: { id: B, location: 'Klang' } },
      // The request that carries the user's yes: a clean lookup by full name, then the deletion again.
      { tool: 'listCandidates', input: { name: 'Aisyah Lim' } },
      { tool: 'deleteCandidate', input: { id: A } },
    ];
    try {
      const shown = await exchange([say('u1', 'Delete Aisyah, and move the other one to Klang')], asTeam);
      expect(seen.refusals).toEqual([AMBIGUOUS]);
      expect(waiting(shown)).toHaveLength(1);
      // The first specialist's report, as the browser keeps it, names both ids as ambiguous: that is what the next request reads.
      const reports = toolParts(shown).filter((p) => p.type === 'tool-askLekir').map((p) => (p as { output?: { ambiguous?: string[] } }).output?.ambiguous);
      expect(reports[0]?.slice().sort()).toEqual([A, B]);

      seen.refusals = [];
      const after = await exchange(decide(shown, true), asTeam);
      expect(candidateSaved).toHaveBeenCalledTimes(1);
      expect(seen.refusals.length).toBeGreaterThan(0);
      for (const refusal of seen.refusals) expect(refusal).toBe(AMBIGUOUS);
      expect(waiting(after)).toEqual([]);
      expect(candidateDeleted).not.toHaveBeenCalled();
    } finally {
      seen.workerScript = null;
    }
  });

  it('team: a rejected deletion still counts as the turn\'s one', async () => {
    candidateDeleted.mockReset();
    seen.refusals = [];
    seen.workerStep = 0;
    seen.workerScript = [
      { tool: 'listCandidates', input: { name: 'Aisyah Lim' } },
      { tool: 'deleteCandidate', input: { id: A } },
      { tool: 'listCandidates', input: {} },
      { tool: 'deleteCandidate', input: { id: B } },
    ];
    try {
      const shown = await exchange([say('u1', 'Delete Aisyah Lim and Aisyah binti Karim')], asTeam);
      const after = await exchange(decide(shown, false), asTeam);
      expect(waiting(after)).toEqual([]);
      expect(seen.refusals.length).toBeGreaterThan(0);
      for (const refusal of seen.refusals) expect(refusal).toBe(ONE_DELETION);
      expect(candidateDeleted).not.toHaveBeenCalled();
    } finally {
      seen.workerScript = null;
    }
  });

  describe('applyChange, asked about a deletion a specialist prepared', () => {
    type Gate = (input: unknown, options: { toolCallId: string; messages: Model[] }) => unknown;
    const deletion = (id: string, row: string) =>
      ({ id, product: 'hire', action: 'deleteCandidate', input: { id: row }, title: 'Delete candidate?', detail: null });
    const edit = { id: 'p-edit', product: 'hire', action: 'updateCandidate', input: { id: A, location: 'Klang' }, title: 'Save?', detail: null };
    const older = deletion('p-old', A);
    const newer = deletion('p-new', B);
    const report = (toolCallId: string, proposals: unknown[]): Model =>
      ({ role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'askLekir', output: { type: 'json', value: { agent: 'Lekir', product: 'hire', status: 'done', steps: [], answer: '', proposals } } }] }) as Model;
    const applied = (toolCallId: string, proposalId: string): Model =>
      ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'applyChange', input: { proposalId } }] }) as Model;
    const user = (text: string): Model => ({ role: 'user', content: text });
    const gateFor = (messages: Model[]) => {
      const proposals = new Map([older, newer, edit].map((p) => [p.id, p]));
      const made = createTeamTools([hireProduct(access())], { transcript: '', proposals, names: {} }, messages);
      return (input: unknown, toolCallId: string) => (made.toolApproval!.applyChange as Gate)(input, { toolCallId, messages });
    };
    const DENIED = { type: 'denied', reason: ONE_DELETION };

    it('asks the user about the turn\'s first deletion, and about any change that is not a deletion', async () => {
      const gate = gateFor([user('Delete Aisyah Lim'), report('t1', [newer])]);
      expect(await gate({ proposalId: 'p-edit' }, 'c0')).toBe('user-approval');
      expect(await gate({ proposalId: 'p-new' }, 'c1')).toBe('user-approval');
      expect(await gate({ proposalId: 'p-edit' }, 'c2')).toBe('user-approval');
    });
    it('denies an older deletion beside one prepared in this turn, in either order', async () => {
      const turn = [user('Delete Aisyah Lim'), report('t0', [older]), user('And the other'), report('t1', [newer])];
      expect(await gateFor(turn)({ proposalId: 'p-old' }, 'c1')).toEqual(DENIED);
      const gate = gateFor(turn);
      expect(await gate({ proposalId: 'p-new' }, 'c1')).toBe('user-approval');
      expect(await gate({ proposalId: 'p-old' }, 'c2')).toEqual(DENIED);
    });
    it('denies a second deletion in one request when neither was prepared in this turn', async () => {
      const gate = gateFor([user('x'), report('t0', [older, newer]), user('Do both now')]);
      expect(await gate({ proposalId: 'p-old' }, 'c1')).toBe('user-approval');
      expect(await gate({ proposalId: 'p-new' }, 'c2')).toEqual(DENIED);
    });
    it('denies a deletion after another was put to the user earlier in the turn, whatever they answered', async () => {
      const turn = [user('x'), report('t0', [older, newer]), user('Do both now'), applied('c1', 'p-old')];
      expect(await gateFor(turn)({ proposalId: 'p-new' }, 'c2')).toEqual(DENIED);
      // The same card asked about again by the SDK, when the user's answer arrives: itself, so it passes.
      expect(await gateFor(turn)({ proposalId: 'p-old' }, 'c1')).toBe('user-approval');
      // The same deletion asked for a second time under another call is not itself.
      expect(await gateFor(turn)({ proposalId: 'p-old' }, 'c9')).toEqual(DENIED);
    });
    it('does not count a call this gate denied', async () => {
      const turn = [
        user('x'), report('t0', [older, newer]), user('Do both now'), applied('c1', 'p-old'), applied('c2', 'p-new'),
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'applyChange', output: { type: 'error-text', value: ONE_DELETION } }] } as Model,
      ];
      expect(await gateFor(turn)({ proposalId: 'p-old' }, 'c1')).toBe('user-approval');
    });
    it('starts again once the user has spoken', async () => {
      const turn = [user('x'), report('t0', [older, newer]), user('Delete the first'), applied('c1', 'p-old'), user('Now the second')];
      expect(await gateFor(turn)({ proposalId: 'p-new' }, 'c2')).toBe('user-approval');
    });
  });
});

describe('Tuah’s team changing the talent pool', () => {
  const POOL_ID = '44444444-4444-4444-8444-444444444451';
  const OTHER_ID = '44444444-4444-4444-8444-444444444452';
  const JOB_ID = '55555555-5555-4555-8555-555555555552';
  const MADE_UP = '99999999-9999-4999-8999-999999999999';
  const ONE_POOL_CHANGE = 'One talent pool change at a time. One is already prepared for approval.';
  const AMBIGUOUS =
    'More than one match was found for that name, so no talent pool change was prepared. Stop here: say who matches and ask the user which one they mean. ' +
    'Once the user has said who, they can ask for the change again.';
  const NOT_IN_POOL = 'This candidate is not in the talent pool, so no move to the pipeline was prepared. Say so, and offer to add them to the talent pool first.';
  const notACandidate = (id: string) =>
    `You have not looked up ${id} as a candidate. Never guess an id: use listCandidates or listTalentPool ` +
    'to find the candidate and get its real id, then prepare the change again.';
  type Card = { type: string; isAutomatic?: boolean; reason?: string; toolCall?: { toolName?: string; input?: unknown } };
  /**
   * The seed's ids are not UUIDs, which the change tools require. Two candidates share a first name nobody else in
   * the seed has: one in the pool as Passive, one outside it. The first open job gets a real id too. `second`
   * changes the one outside the pool, for the cases about a shared name.
   */
  const withUuids = async (second: Record<string, unknown> = {}) => {
    const base = hire().data;
    const [c1, c2] = await base.listCandidates();
    const firstOpen = (await base.listJobs()).find((j) => j.status === 'open')!;
    const data = {
      ...base,
      listCandidates: async () =>
        (await base.listCandidates()).map((c) =>
          c.id === c1.id
            ? { ...c, id: POOL_ID, name: 'Zarina binti Hashim', headline: 'Warehouse Supervisor', location: 'Klang', pool_status: 'passive' as const }
            : c.id === c2.id
              ? { ...c, id: OTHER_ID, name: 'Zarina Lau', pool_status: 'none' as const, ...second }
              : c),
      listJobs: async () => (await base.listJobs()).map((j) => (j.id === firstOpen.id ? { ...j, id: JOB_ID } : j)),
    };
    return { first: c1, job: firstOpen, access: { data, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } } };
  };
  /** One request: what Lekir prepared, and the cards put in front of the user with the line each carried. */
  const prepare = async (
    script: NonNullable<typeof seen.workerScript>,
    access: Awaited<ReturnType<typeof withUuids>>['access'],
    names: Record<string, string> = {},
  ) => {
    poolSet.mockReset();
    pipelineMoved.mockReset();
    const context = { ...team(), names };
    seen.calls = [];
    seen.workerScript = script;
    seen.workerStep = 0;
    seen.refusals = [];
    let cards: Card[] = [];
    try {
      const result = runTuah(
        [{ role: 'user' as const, content: 'Mark the candidate Zarina binti Hashim as available in the talent pool' }],
        reach(), undefined, undefined, null, null, context, access,
      );
      await result.consumeStream();
      cards = ((await result.steps) as unknown as { content: Card[] }[])
        .flatMap((s) => s.content)
        .filter((p) => p.type === 'tool-approval-request' && !p.isAutomatic);
    } finally {
      seen.workerScript = null;
    }
    return { context, cards };
  };
  const nothingSaved = () => {
    expect(poolSet).not.toHaveBeenCalled();
    expect(pipelineMoved).not.toHaveBeenCalled();
  };

  it('both tools ask for approval for a writer, and a viewer holds neither', () => {
    const writer = { ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
    const { tools, toolApproval } = combineToolkits([hireProduct(writer)]);
    for (const name of ['setPoolStatus', 'moveToPipeline']) {
      expect(HIRE_WRITE_TOOL_NAMES, name).toContain(name);
      expect(Object.keys(tools), name).toContain(name);
      expect(toolApproval?.[name], name).toBe('user-approval');
    }
    expect(toolApproval?.listTalentPool).toBeUndefined();
    const viewer = combineToolkits([hireProduct({ ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: false } })]);
    for (const name of ['setPoolStatus', 'moveToPipeline']) expect(Object.keys(viewer.tools), name).not.toContain(name);
  });
  it('prepares one card for a status change of a person it looked up by full name, and saves nothing', async () => {
    const { access } = await withUuids();
    const { context, cards } = await prepare([
      { tool: 'listCandidates', input: { name: 'Zarina binti Hashim' } },
      { tool: 'setPoolStatus', input: { id: POOL_ID, status: 'available' } },
    ], access);
    expect(seen.refusals).toEqual([]);
    expect(context.proposals.size).toBe(1);
    expect([...context.proposals.values()][0]).toMatchObject({
      product: 'hire',
      action: 'setPoolStatus',
      input: { id: POOL_ID, status: 'available' },
      title: 'Mark candidate “Zarina binti Hashim” as Available in the talent pool?',
      detail: 'Available: Open to hearing about a role now.',
    });
    // Nobody else has her name: the card carries no extra line.
    expect(cards).toHaveLength(1);
    expect(cards[0].reason).toBeUndefined();
    nothingSaved();
  });
  it('accepts an id from the pool lookup, and words a removal', async () => {
    const { access } = await withUuids();
    const { context } = await prepare([
      { tool: 'listTalentPool', input: { name: 'Zarina binti' } },
      { tool: 'setPoolStatus', input: { id: POOL_ID, status: 'none' } },
    ], access);
    expect(seen.refusals).toEqual([]);
    expect([...context.proposals.values()][0]).toMatchObject({
      title: 'Remove candidate “Zarina binti Hashim” from the talent pool?',
      detail: 'They stay on file with their details and applications.',
    });
  });
  it('words an add for someone outside the pool', async () => {
    const { access } = await withUuids();
    const { context } = await prepare([
      { tool: 'listCandidates', input: { name: 'Zarina Lau' } },
      { tool: 'setPoolStatus', input: { id: OTHER_ID, status: 'available', only_if_outside: true } },
    ], access);
    expect(seen.refusals).toEqual([]);
    expect([...context.proposals.values()][0]).toMatchObject({
      title: 'Add candidate “Zarina Lau” to the talent pool as Available?',
      detail: 'Available: Open to hearing about a role now.',
    });
  });
  it('prepares a move for a pool member and a job it looked up, with the job\'s title on the card', async () => {
    const { job, access } = await withUuids();
    const { context } = await prepare([
      { tool: 'listCandidates', input: { name: 'Zarina binti Hashim' } },
      { tool: 'listJobs', input: {} },
      { tool: 'moveToPipeline', input: { id: POOL_ID, job_id: JOB_ID } },
    ], access);
    expect(seen.refusals).toEqual([]);
    expect([...context.proposals.values()][0]).toMatchObject({
      action: 'moveToPipeline',
      input: { id: POOL_ID, job_id: JOB_ID },
      title: `Move candidate “Zarina binti Hashim” to the pipeline for “${job.title}”?`,
      detail: 'Adds an application at Applied and marks them Re-engaged. They stay in the talent pool.',
    });
    nothingSaved();
  });
  it('refuses a move for someone who is not in the pool, before any card', async () => {
    const { access } = await withUuids();
    const { context, cards } = await prepare([
      { tool: 'listCandidates', input: { name: 'Zarina Lau' } },
      { tool: 'listJobs', input: {} },
      { tool: 'moveToPipeline', input: { id: OTHER_ID, job_id: JOB_ID } },
    ], access);
    expect(context.proposals.size).toBe(0);
    expect(cards).toEqual([]);
    expect(seen.refusals[0]).toBe(NOT_IN_POOL);
    nothingSaved();
  });
  it('refuses a made-up id', async () => {
    const { access } = await withUuids();
    const { context } = await prepare([
      { tool: 'listCandidates', input: { name: 'Zarina binti Hashim' } },
      { tool: 'setPoolStatus', input: { id: MADE_UP, status: 'passive' } },
    ], access);
    expect(context.proposals.size).toBe(0);
    expect(seen.refusals[0]).toContain(`You have not looked up ${MADE_UP}`);
    nothingSaved();
  });
  it('refuses a job\'s id as the person, even one it listed, and names both lookups', async () => {
    const { access } = await withUuids();
    const { context } = await prepare([
      { tool: 'listJobs', input: {} },
      { tool: 'setPoolStatus', input: { id: JOB_ID, status: 'passive' } },
    ], access);
    expect(context.proposals.size).toBe(0);
    expect(seen.refusals[0]).toBe(notACandidate(JOB_ID));
  });
  it('refuses a move whose job was never looked up as a job', async () => {
    const { access } = await withUuids();
    const { context } = await prepare([
      { tool: 'listCandidates', input: {} },
      { tool: 'moveToPipeline', input: { id: POOL_ID, job_id: OTHER_ID } },
    ], access);
    expect(context.proposals.size).toBe(0);
    expect(seen.refusals[0]).toBe(
      `You have not looked up ${OTHER_ID} as a job. Never guess an id: use listJobs ` +
        'to find the job and get its real id, then prepare the change again.',
    );
    nothingSaved();
  });
  it('makes one card when two pool changes are called in one step', async () => {
    const { access } = await withUuids();
    const { context } = await prepare([
      { tool: 'listCandidates', input: {} },
      [
        { tool: 'setPoolStatus', input: { id: POOL_ID, status: 'available' } },
        { tool: 'setPoolStatus', input: { id: OTHER_ID, status: 'available', only_if_outside: true } },
      ],
    ], access);
    expect(context.proposals.size).toBe(1);
    expect([...context.proposals.values()][0]).toMatchObject({ action: 'setPoolStatus', input: { id: POOL_ID } });
    expect(seen.refusals).toEqual([ONE_POOL_CHANGE]);
  });
  it('refuses a pool change when another change is already prepared in the same step', async () => {
    const { access } = await withUuids();
    const { context } = await prepare([
      { tool: 'listCandidates', input: {} },
      [
        { tool: 'updateCandidate', input: { id: POOL_ID, location: 'Klang' } },
        { tool: 'setPoolStatus', input: { id: POOL_ID, status: 'available' } },
      ],
    ], access);
    expect(context.proposals.size).toBe(1);
    expect([...context.proposals.values()][0]).toMatchObject({ action: 'updateCandidate' });
    expect(seen.refusals).toEqual([ONE_POOL_CHANGE]);
  });
  it('refuses a pool change from a lookup that said several people match, in that delegation and in a later one of the same turn', async () => {
    const { access } = await withUuids();
    const { context } = await prepare([
      { tool: 'listCandidates', input: { name: 'Zarina' } },
      { tool: 'setPoolStatus', input: { id: POOL_ID, status: 'available' } },
      'answer',
      // A new delegation: its own lookup fits one person, and says nothing of several.
      { tool: 'listCandidates', input: { name: 'Zarina binti Hashim' } },
      { tool: 'setPoolStatus', input: { id: POOL_ID, status: 'available' } },
    ], access);
    expect(context.proposals.size).toBe(0);
    expect(seen.refusals.slice(0, 2)).toEqual([AMBIGUOUS, AMBIGUOUS]);
    // The script's last call repeats in delegations that looked nothing up, until Tuah's step limit: refused as well.
    for (const refusal of seen.refusals) expect(refusal === AMBIGUOUS || refusal.startsWith('You have not looked up')).toBe(true);
    nothingSaved();
  });
  it('a shared name is not refused: the card says which person it is, on a line read from the workspace, for a status change and for a move', async () => {
    // The other candidate now has her exact name (in another letter case), and is in the pool too.
    const { first, access } = await withUuids({ name: ' zarina  BINTI hashim', pool_status: 'available' });
    const line = `More than one candidate is called Zarina binti Hashim. This one: ${first.email} · added ${fullDate(first.created_at)}.`;
    // Both ids come from an earlier turn: this delegation looks nobody up, so no lookup of its own shows the shared name.
    const known = { [`candidate:${POOL_ID}`]: 'Zarina binti Hashim', [`job:${JOB_ID}`]: 'Software Engineer' };
    const status = await prepare([{ tool: 'setPoolStatus', input: { id: POOL_ID, status: 'available' } }], access, known);
    expect(seen.refusals).toEqual([]);
    expect(status.cards).toHaveLength(1);
    expect(status.cards[0].reason).toBe(line);
    const moved = await prepare([{ tool: 'moveToPipeline', input: { id: POOL_ID, job_id: JOB_ID } }], access, known);
    expect(seen.refusals).toEqual([]);
    expect(moved.cards).toHaveLength(1);
    expect(moved.cards[0].reason).toBe(line);
    // The line is on the card only: no proposal, title or detail holds the email.
    expect(JSON.stringify([...status.context.proposals.values(), ...moved.context.proposals.values()])).not.toContain(first.email!);
    nothingSaved();
  });
  it('refuses only when the two of them would give the same line, and says where it can be done instead', async () => {
    const twin = { name: 'Zarina binti Hashim', email: null, headline: 'Warehouse Supervisor', location: 'Klang', pool_status: 'available' };
    const { first, access } = await withUuids({ ...twin });
    const same = {
      ...access,
      data: {
        ...access.data,
        listCandidates: async () => (await access.data.listCandidates()).map((c) =>
          c.id === POOL_ID ? { ...c, email: null } : c.id === OTHER_ID ? { ...c, created_at: first.created_at } : c),
      },
    };
    const { context, cards } = await prepare(
      [{ tool: 'setPoolStatus', input: { id: POOL_ID, status: 'available' } }],
      same,
      { [`candidate:${POOL_ID}`]: 'Zarina binti Hashim' },
    );
    expect(context.proposals.size).toBe(0);
    expect(cards).toEqual([]);
    expect(seen.refusals[0]).toBe(
      'Two candidates called Zarina binti Hashim look the same from here, so I cannot tell them apart. Nothing was changed. Change the right one from the Talent Pool screen or the Candidates board.',
    );
  });
  it('tells Tuah, in its roster line and in what the specialist is asked, that Lekir can change the talent pool', async () => {
    seen.calls = [];
    await runTuah(ask, reach(), undefined, undefined, null, null, team(), hire()).consumeStream();
    const line = seen.calls[0].system.split('\n').find((l) => l.startsWith('- askLekir:'));
    expect(line).toContain('An application or a candidate can be deleted, one at a time. A candidate can be added to the talent pool, given a pool status, removed from the pool or moved to the pipeline for a job, one at a time. ');
    expect(line!.endsWith('.')).toBe(true);
    expect(line).not.toContain('..');
    const writer = { ...hire(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
    const asks = createTeamTools([hireProduct(writer)], team()).tools.askLekir as unknown as { description: string };
    expect(asks.description).toContain('it can prepare deleting one application or one candidate at a time; it can prepare a talent pool change for one candidate at a time)');
  });
});

describe('one talent pool change a turn, as the browser carries the turn between requests', () => {
  type UI = import('ai').UIMessage;
  type Model = import('ai').ModelMessage;
  type ToolPart = { type: string; state?: string; toolCallId?: string; input?: unknown; approval?: { id: string; approved?: boolean; reason?: string; isAutomatic?: boolean } };
  const A = '11111111-1111-4111-8111-111111111131';
  const B = '22222222-2222-4222-8222-222222222232';
  const ONE_POOL_CHANGE = 'One talent pool change at a time. One is already prepared for approval.';
  const ONE_DELETION = 'One deletion at a time. One is already prepared for approval.';
  const marked = { ok: true, data: { id: A, name: 'Zarina binti Hashim', from: 'available', to: 'passive', message: 'Zarina binti Hashim is now marked Passive.' } };
  const say = (id: string, text: string): UI => ({ id, role: 'user', parts: [{ type: 'text', text }] });
  /** Two pool members with real ids and names nobody else in the seed has. */
  const access = () => {
    const base = hire().data;
    const listCandidates = async () =>
      (await base.listCandidates()).map((c, n) =>
        n === 0 ? { ...c, id: A, name: 'Zarina binti Hashim', pool_status: 'available' as const }
          : n === 1 ? { ...c, id: B, name: 'Kamal Ariffin', pool_status: 'available' as const } : c);
    return { data: { ...base, listCandidates }, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
  };
  type Runner = (messages: Model[], chat: UI[]) => { toUIMessageStream: () => ReadableStream<unknown> };
  const asTeam: Runner = (messages, chat) =>
    runTuah(messages, reach(), undefined, undefined, null, null, { transcript: '', proposals: proposalsIn(chat), names: namesIn(chat) }, access());
  /** One request, and the chat as the browser holds it afterwards. */
  const exchange = async (chat: UI[], run: Runner): Promise<UI[]> => {
    const { convertToModelMessages, readUIMessageStream } = await import('ai');
    const last = chat[chat.length - 1];
    const paused = last.role === 'assistant' ? structuredClone(last) : undefined;
    seen.calls = [];
    const result = run(await convertToModelMessages(chat), chat);
    let answer: UI | undefined;
    for await (const message of readUIMessageStream({ message: paused, stream: result.toUIMessageStream() as never })) answer = message as UI;
    return paused ? [...chat.slice(0, -1), answer!] : [...chat, answer!];
  };
  const toolParts = (chat: UI[]) => chat.flatMap((m) => m.parts as unknown as ToolPart[]).filter((p) => p.type.startsWith('tool-'));
  const waiting = (chat: UI[]) => toolParts(chat).filter((p) => p.state === 'approval-requested' && !p.approval?.isAutomatic);
  const decide = (chat: UI[], approved: boolean): UI[] => {
    const next = structuredClone(chat);
    const [card] = waiting(next);
    card.state = 'approval-responded';
    card.approval = { ...card.approval!, approved };
    return next;
  };

  it.each([true, false])('team: after the card is answered (approved: %s), a second pool change in the same turn is refused; the next message allows one', async (approved) => {
    poolSet.mockReset();
    poolSet.mockResolvedValue(marked);
    seen.refusals = [];
    seen.workerStep = 0;
    seen.workerScript = [
      { tool: 'listCandidates', input: { name: 'Zarina binti Hashim' } },
      { tool: 'setPoolStatus', input: { id: A, status: 'passive' } },
      // The request that carries the answer: Tuah asks Lekir again, for the other person.
      { tool: 'listCandidates', input: { name: 'Kamal Ariffin' } },
      { tool: 'setPoolStatus', input: { id: B, status: 'passive' } },
    ];
    try {
      const shown = await exchange([say('u1', 'Mark the candidates Zarina binti Hashim and Kamal Ariffin as passive')], asTeam);
      expect(waiting(shown)).toHaveLength(1);
      expect(waiting(shown)[0].type).toBe('tool-applyChange');
      expect(poolSet).not.toHaveBeenCalled();

      const after = await exchange(decide(shown, approved), asTeam);
      expect(poolSet).toHaveBeenCalledTimes(approved ? 1 : 0);
      if (approved) expect(poolSet.mock.calls[0][1]).toEqual({ id: A, status: 'passive' });
      expect(waiting(after)).toEqual([]);
      expect(seen.refusals.length).toBeGreaterThan(0);
      for (const refusal of seen.refusals) expect(refusal).toBe(ONE_POOL_CHANGE);
      // Nothing was prepared for the other person.
      expect([...proposalsIn(after).values()].map((p) => p.input)).toEqual([{ id: A, status: 'passive' }]);

      // The user speaks again: a new turn, with one pool change of its own.
      seen.workerStep = 0;
      seen.workerScript = [{ tool: 'listCandidates', input: { name: 'Kamal Ariffin' } }, { tool: 'setPoolStatus', input: { id: B, status: 'passive' } }];
      const next = await exchange([...after, say('u2', 'Now mark the candidate Kamal Ariffin as passive')], asTeam);
      expect(waiting(next)).toHaveLength(1);
      const proposalId = (waiting(next)[0].input as { proposalId: string }).proposalId;
      expect(proposalsIn(next).get(proposalId)).toMatchObject({ action: 'setPoolStatus', input: { id: B, status: 'passive' } });
    } finally {
      seen.workerScript = null;
    }
  });

  // The same gate that holds a deletion to one a turn, asked about pool changes: the two kinds are counted apart.
  describe('applyChange, asked about a pool change a specialist prepared', () => {
    type Gate = (input: unknown, options: { toolCallId: string; messages: Model[] }) => unknown;
    const change = (id: string, row: string) =>
      ({ id, product: 'hire', action: 'setPoolStatus', input: { id: row, status: 'passive' }, title: 'Mark?', detail: null });
    const older = change('p-old', A);
    const newer = change('p-new', B);
    const deletion = { id: 'p-del', product: 'hire', action: 'deleteCandidate', input: { id: B }, title: 'Delete?', detail: null };
    const report = (toolCallId: string, proposals: unknown[]): Model =>
      ({ role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'askLekir', output: { type: 'json', value: { agent: 'Lekir', product: 'hire', status: 'done', steps: [], answer: '', proposals } } }] }) as Model;
    const applied = (toolCallId: string, proposalId: string): Model =>
      ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'applyChange', input: { proposalId } }] }) as Model;
    const user = (text: string): Model => ({ role: 'user', content: text });
    const gateFor = (messages: Model[]) => {
      const proposals = new Map([older, newer, deletion].map((p) => [p.id, p]));
      const made = createTeamTools([hireProduct(access())], { transcript: '', proposals, names: {} }, messages);
      return (input: unknown, toolCallId: string) => (made.toolApproval!.applyChange as Gate)(input, { toolCallId, messages });
    };
    const DENIED = { type: 'denied', reason: ONE_POOL_CHANGE };

    it('denies an older pool change beside one prepared in this turn, in either order', async () => {
      const turn = [user('Mark Zarina passive'), report('t0', [older]), user('And Kamal'), report('t1', [newer])];
      expect(await gateFor(turn)({ proposalId: 'p-old' }, 'c1')).toEqual(DENIED);
      const gate = gateFor(turn);
      expect(await gate({ proposalId: 'p-new' }, 'c1')).toBe('user-approval');
      expect(await gate({ proposalId: 'p-old' }, 'c2')).toEqual(DENIED);
    });
    it('denies a second pool change in one request when neither was prepared in this turn, and lets the same card through again', async () => {
      const gate = gateFor([user('x'), report('t0', [older, newer]), user('Do both now')]);
      expect(await gate({ proposalId: 'p-old' }, 'c1')).toBe('user-approval');
      expect(await gate({ proposalId: 'p-new' }, 'c2')).toEqual(DENIED);
      const answered = [user('x'), report('t0', [older, newer]), user('Do both now'), applied('c1', 'p-old')];
      expect(await gateFor(answered)({ proposalId: 'p-old' }, 'c1')).toBe('user-approval');
      expect(await gateFor(answered)({ proposalId: 'p-new' }, 'c2')).toEqual(DENIED);
    });
    it('counts a deletion and a pool change apart: one of each in a turn', async () => {
      const gate = gateFor([user('x'), report('t0', [older, deletion]), user('Do both now')]);
      expect(await gate({ proposalId: 'p-old' }, 'c1')).toBe('user-approval');
      expect(await gate({ proposalId: 'p-del' }, 'c2')).toBe('user-approval');
      // A second of either kind is still denied, each in its own words.
      expect(await gate({ proposalId: 'p-new' }, 'c3')).toEqual(DENIED);
      expect(await gate({ proposalId: 'p-del' }, 'c4')).toEqual({ type: 'denied', reason: ONE_DELETION });
    });
    it('starts again once the user has spoken', async () => {
      const turn = [user('x'), report('t0', [older, newer]), user('Mark the first'), applied('c1', 'p-old'), user('Now the second')];
      expect(await gateFor(turn)({ proposalId: 'p-new' }, 'c2')).toBe('user-approval');
    });
  });
});

describe('one agent holding the pool tools', () => {
  const A = '11111111-1111-4111-8111-111111111141';
  const B = '22222222-2222-4222-8222-222222222242';
  const C = '33333333-3333-4333-8333-333333333343';
  const JOB = '55555555-5555-4555-8555-555555555543';
  const ONE_POOL_CHANGE = 'One talent pool change at a time. One is already prepared for approval.';
  type Message = import('ai').ModelMessage;
  type Part = { type: string; isAutomatic?: boolean; approved?: boolean; reason?: string; toolCall?: { toolName?: string; input?: unknown } };
  /**
   * Three candidates with real ids: A and B in the pool, C outside it. `second` changes B, for the shared-name case.
   * The checks read these rows; what the model "looked up" is the earlier turn below.
   */
  const writer = (second: Record<string, unknown> = {}) => {
    const base = hire().data;
    const listCandidates = async () =>
      (await base.listCandidates()).map((c, n) =>
        n === 0 ? { ...c, id: A, name: 'Zarina binti Hashim', pool_status: 'available' as const }
          : n === 1 ? { ...c, id: B, name: 'Kamal Ariffin', pool_status: 'passive' as const, ...second }
            : n === 2 ? { ...c, id: C, name: 'Suraya Jamil', pool_status: 'none' as const } : c);
    return { data: { ...base, listCandidates }, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
  };
  /** An earlier turn that listed the three candidates and one job: an id may only come from a lookup the conversation holds. */
  const listed = [
    { role: 'user', content: 'Who is on file, and which jobs are open?' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'listCandidates', input: {} }, { type: 'tool-call', toolCallId: 'l2', toolName: 'listJobs', input: {} }] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'l1', toolName: 'listCandidates', output: { type: 'json', value: { total: 3, candidates: [{ id: A, name: 'Zarina binti Hashim', pool_status: 'available' }, { id: B, name: 'Kamal Ariffin', pool_status: 'passive' }, { id: C, name: 'Suraya Jamil', pool_status: 'none' }] } } },
      { type: 'tool-result', toolCallId: 'l2', toolName: 'listJobs', output: { type: 'json', value: { total: 1, jobs: [{ id: JOB, name: 'Warehouse Supervisor' }] } } },
    ] },
    { role: 'assistant', content: 'Three people and one job.' },
  ] as Message[];
  const asked: Message[] = [...listed, { role: 'user', content: 'Mark both candidates as passive' }];
  type Call = { tool: string; input: unknown };
  /** One request: the model's first step makes every call in `script`, and any later step answers in words. */
  const request = async (script: Call[], agent: 'tuah' | 'lekir', access = writer()) => {
    seen.calls = [];
    seen.singleScript = [script];
    try {
      const result = agent === 'lekir' ? runLekir(asked, access) : runTuah(asked, reach(), undefined, undefined, null, null, null, access);
      await result.consumeStream();
      const content = ((await result.steps) as unknown as { content: Part[] }[]).flatMap((s) => s.content);
      return {
        cards: content.filter((p) => p.type === 'tool-approval-request' && !p.isAutomatic),
        denials: content.filter((p) => p.type === 'tool-approval-response' && p.approved === false).map((p) => p.reason),
      };
    } finally {
      seen.singleScript = null;
    }
  };

  it.each(['tuah', 'lekir'] as const)('%s: the second of two pool changes is denied with the reason, and never becomes a card', async (agent) => {
    poolSet.mockReset();
    const run = await request([
      { tool: 'setPoolStatus', input: { id: A, status: 'passive' } },
      { tool: 'setPoolStatus', input: { id: B, status: 'available' } },
    ], agent);
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0].toolCall).toMatchObject({ toolName: 'setPoolStatus', input: { id: A, status: 'passive' } });
    expect(run.cards[0].reason).toBeUndefined();
    expect(run.denials).toEqual([ONE_POOL_CHANGE]);
    expect(poolSet).not.toHaveBeenCalled();
  });
  it.each(['tuah', 'lekir'] as const)('%s: no card for an id nobody looked up, for a job nobody looked up, or for a move of someone outside the pool', async (agent) => {
    pipelineMoved.mockReset();
    const MADE_UP = '99999999-9999-4999-8999-999999999943';
    const madeUp = await request([{ tool: 'setPoolStatus', input: { id: MADE_UP, status: 'passive' } }], agent);
    expect(madeUp.cards).toEqual([]);
    expect(madeUp.denials).toEqual([
      `You have not looked up ${MADE_UP} as a candidate. Never guess an id: use listCandidates or listTalentPool ` +
        'to find the candidate and get its real id, then prepare the change again.',
    ]);
    const noJob = await request([{ tool: 'moveToPipeline', input: { id: A, job_id: B } }], agent);
    expect(noJob.cards).toEqual([]);
    expect(noJob.denials).toEqual([
      `You have not looked up ${B} as a job. Never guess an id: use listJobs ` +
        'to find the job and get its real id, then prepare the change again.',
    ]);
    const outside = await request([{ tool: 'moveToPipeline', input: { id: C, job_id: JOB } }], agent);
    expect(outside.cards).toEqual([]);
    expect(outside.denials).toEqual(['This candidate is not in the talent pool, so no move to the pipeline was prepared. Say so, and offer to add them to the talent pool first.']);
    const fine = await request([{ tool: 'moveToPipeline', input: { id: A, job_id: JOB } }], agent);
    expect(fine.cards).toHaveLength(1);
    expect(pipelineMoved).not.toHaveBeenCalled();
  });
  it('lekir: when someone else has the name, the card carries the line that says which one, and it is not refused', async () => {
    const access = writer({ name: 'Zarina binti Hashim' });
    const first = (await access.data.listCandidates()).find((c) => c.id === A)!;
    const run = await request([{ tool: 'setPoolStatus', input: { id: A, status: 'passive' } }], 'lekir', access);
    expect(run.denials).toEqual([]);
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0].reason).toBe(`More than one candidate is called Zarina binti Hashim. This one: ${first.email} · added ${fullDate(first.created_at)}.`);
  });
  it('a deletion beside a pool change keeps its own card: the two limits do not count each other', async () => {
    const run = await request([
      { tool: 'setPoolStatus', input: { id: A, status: 'passive' } },
      { tool: 'deleteCandidate', input: { id: B } },
    ], 'lekir');
    expect(run.cards.map((c) => c.toolCall?.toolName).sort()).toEqual(['deleteCandidate', 'setPoolStatus']);
    expect(run.denials).toEqual([]);
  });
});

// Beyond the plan's own tests: what the deletion gate's review asked for, proven for the pool with the SDK driven
// through the whole exchange (the request that shows the card, then the one that carries the user's answer).
describe('one agent holding the pool tools, through the user\'s answer', () => {
  const A = '11111111-1111-4111-8111-111111111151';
  const B = '22222222-2222-4222-8222-222222222252';
  const JOB = '55555555-5555-4555-8555-555555555553';
  type Message = import('ai').ModelMessage;
  type Part = { type: string; isAutomatic?: boolean; approved?: boolean; reason?: string; approvalId?: string; toolCall?: { toolName?: string; input?: unknown } };
  const added = { created_at: '2026-10-03T02:00:00Z' };
  /** A is in the pool while `pool.on`; B has A's name (in another letter case) while `twin.on`. */
  const writer = (pool = { on: true }, twin = { on: false }) => {
    const base = hire().data;
    const listCandidates = async () =>
      (await base.listCandidates()).map((c, n) =>
        n === 0 ? { ...c, ...added, id: A, name: 'Zarina binti Hashim', email: 'zarina.klang@example.com', pool_status: pool.on ? ('available' as const) : ('none' as const) }
          : n === 1 ? { ...c, ...added, id: B, name: twin.on ? ' zarina  BINTI hashim' : 'Kamal Ariffin', email: 'zarina.ipoh@example.com', pool_status: 'passive' as const } : c);
    return { data: { ...base, listCandidates }, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
  };
  // An earlier turn listed the person and the job, with no contact details: no model was ever shown an email.
  const earlier = [
    { role: 'user', content: 'Who is Zarina binti Hashim, and which jobs are open?' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'listTalentPool', input: { name: 'Zarina binti Hashim' } }, { type: 'tool-call', toolCallId: 'l2', toolName: 'listJobs', input: {} }] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'l1', toolName: 'listTalentPool', output: { type: 'json', value: { total: 1, candidates: [{ id: A, name: 'Zarina binti Hashim', pool_status: 'available' }] } } },
      { type: 'tool-result', toolCallId: 'l2', toolName: 'listJobs', output: { type: 'json', value: { total: 1, jobs: [{ id: JOB, name: 'Warehouse Supervisor' }] } } },
    ] },
    { role: 'assistant', content: 'She is in the talent pool as Available. One job is open.' },
    { role: 'user', content: 'Do it for her' },
  ] as Message[];
  const request = async (messages: Message[], script: { tool: string; input: unknown }[], agent: 'tuah' | 'lekir', access: ReturnType<typeof writer>) => {
    seen.calls = [];
    seen.singleScript = [script];
    try {
      const result = agent === 'lekir' ? runLekir(messages, access) : runTuah(messages, reach(), undefined, undefined, null, null, null, access);
      await result.consumeStream();
      const content = ((await result.steps) as unknown as { content: Part[] }[]).flatMap((s) => s.content);
      return {
        cards: content.filter((p) => p.type === 'tool-approval-request' && !p.isAutomatic),
        denials: content.filter((p) => p.type === 'tool-approval-response' && p.approved === false).map((p) => p.reason),
        messages: [...messages, ...(await result.response).messages] as Message[],
      };
    } finally {
      seen.singleScript = null;
    }
  };
  const answer = (approvalId: string | undefined, approved: boolean): Message =>
    ({ role: 'tool', content: [{ type: 'tool-approval-response', approvalId, approved }] }) as Message;
  const LINE = 'More than one candidate is called Zarina binti Hashim. This one: zarina.klang@example.com · added 03 Oct 2026.';
  const ONE_POOL_CHANGE = 'One talent pool change at a time. One is already prepared for approval.';

  it.each(['tuah', 'lekir'] as const)('%s: a shared name puts the line on the card, the approved change runs once, and no model is sent the email', async (agent) => {
    poolSet.mockReset();
    poolSet.mockResolvedValue({ ok: true, data: { id: A, name: 'Zarina binti Hashim', from: 'available', to: 'passive', message: 'Zarina binti Hashim is now marked Passive.' } });
    seen.sent = [];
    const access = writer({ on: true }, { on: true });
    const first = await request(earlier, [{ tool: 'setPoolStatus', input: { id: A, status: 'passive' } }], agent, access);
    expect(first.cards).toHaveLength(1);
    expect(first.cards[0].reason).toBe(LINE);
    expect(poolSet).not.toHaveBeenCalled();
    // The SDK asks the gate about the approved call again: it is let through, with its line, and is that request's one.
    const second = await request([...first.messages, answer(first.cards[0].approvalId, true)], [], agent, access);
    expect(second.cards).toEqual([]);
    expect(poolSet).toHaveBeenCalledTimes(1);
    expect(poolSet.mock.calls[0][1]).toEqual({ id: A, status: 'passive' });
    expect(seen.sent.length).toBeGreaterThan(1);
    for (const sent of seen.sent) expect(sent).not.toContain('example.com');
  });
  it.each(['tuah', 'lekir'] as const)('%s: a namesake who appears after a card with no line was approved stops the change, and the model is told why', async (agent) => {
    poolSet.mockReset();
    const twin = { on: false };
    const access = writer({ on: true }, twin);
    const first = await request(earlier, [{ tool: 'setPoolStatus', input: { id: A, status: 'passive' } }], agent, access);
    expect(first.cards).toHaveLength(1);
    expect(first.cards[0].reason).toBeUndefined();
    twin.on = true;
    seen.sent = [];
    const second = await request([...first.messages, answer(first.cards[0].approvalId, true)], [], agent, access);
    expect(poolSet).not.toHaveBeenCalled();
    expect(second.cards).toEqual([]);
    expect(seen.sent[0]).toContain('A candidate with the same name appeared after this was shown for approval');
    for (const sent of seen.sent) expect(sent).not.toContain('example.com');
  });
  it.each(['tuah', 'lekir'] as const)('%s: a move approved for someone who has left the pool since the card is refused again, and nothing is saved', async (agent) => {
    pipelineMoved.mockReset();
    const pool = { on: true };
    const access = writer(pool);
    const first = await request(earlier, [{ tool: 'moveToPipeline', input: { id: A, job_id: JOB } }], agent, access);
    expect(first.cards).toHaveLength(1);
    expect(first.cards[0].toolCall).toMatchObject({ toolName: 'moveToPipeline', input: { id: A, job_id: JOB } });
    pool.on = false;
    seen.sent = [];
    const second = await request([...first.messages, answer(first.cards[0].approvalId, true)], [], agent, access);
    expect(pipelineMoved).not.toHaveBeenCalled();
    expect(second.cards).toEqual([]);
    expect(seen.sent[0]).toContain('This candidate is not in the talent pool, so no move to the pipeline was prepared.');
  });
  it.each(['tuah', 'lekir'] as const)('%s: after a card the user rejected, a second pool change in the same turn is still refused', async (agent) => {
    poolSet.mockReset();
    pipelineMoved.mockReset();
    const access = writer();
    const first = await request(earlier, [{ tool: 'setPoolStatus', input: { id: A, status: 'passive' } }], agent, access);
    expect(first.cards).toHaveLength(1);
    const second = await request(
      [...first.messages, answer(first.cards[0].approvalId, false)],
      // Another call, under another call id: the scripted model names a call after its tool.
      [{ tool: 'moveToPipeline', input: { id: A, job_id: JOB } }],
      agent, access,
    );
    expect(second.cards).toEqual([]);
    expect(second.denials).toEqual([ONE_POOL_CHANGE]);
    expect(poolSet).not.toHaveBeenCalled();
    expect(pipelineMoved).not.toHaveBeenCalled();
  });
  it('team: applyChange refuses a move for someone who has left the pool since it was prepared', async () => {
    type Gate = (input: unknown, options: { toolCallId: string; messages: Message[] }) => unknown;
    const move = { id: 'p-move', product: 'hire' as const, action: 'moveToPipeline', input: { id: A, job_id: JOB }, title: 'Move?', detail: null };
    const messages = [{ role: 'user', content: 'Move her to the pipeline' }] as Message[];
    const made = createTeamTools([hireProduct(writer({ on: false }))], { transcript: '', proposals: new Map([[move.id, move]]), names: {} }, messages);
    expect(await (made.toolApproval!.applyChange as Gate)({ proposalId: 'p-move' }, { toolCallId: 'c1', messages })).toEqual({
      type: 'denied',
      reason: 'This candidate is not in the talent pool, so no move to the pipeline was prepared. Say so, and offer to add them to the talent pool first.',
    });
  });
});

// A change the user approved and a last check then stopped never ran and is over: it is not the turn's one. The
// browser tells the server only that the call was denied, so on the NEXT request the stopped call comes back with
// the SDK's own words and no reason of the gate's. These go through the browser's round trip for three requests:
// the card, the yes that is stopped, and the yes to the card prepared in its place.
describe('a change stopped after approval is not the turn\'s one, as the browser carries it', () => {
  type UI = import('ai').UIMessage;
  type Model = import('ai').ModelMessage;
  type ToolPart = { type: string; state?: string; toolCallId?: string; input?: unknown; approval?: { id: string; approved?: boolean; reason?: string; requestReason?: string; isAutomatic?: boolean } };
  const A = '11111111-1111-4111-8111-111111111161';
  const B = '22222222-2222-4222-8222-222222222262';
  const JOB = '55555555-5555-4555-8555-555555555563';
  const ONE_POOL_CHANGE = 'One talent pool change at a time. One is already prepared for approval.';
  const LINE = 'More than one candidate is called Zarina binti Hashim. This one: zarina.klang@example.com · added 03 Oct 2026.';
  const say = (id: string, text: string): UI => ({ id, role: 'user', parts: [{ type: 'text', text }] });
  const added = { created_at: '2026-10-03T02:00:00Z' };
  /** A is in the pool while `pool.on`; B has A's name (in another letter case) while `twin.on`. The first open job has a real id. */
  const world = (pool = { on: true }, twin = { on: false }) => {
    const base = hire().data;
    const listCandidates = async () =>
      (await base.listCandidates()).map((c, n) =>
        n === 0 ? { ...c, ...added, id: A, name: 'Zarina binti Hashim', email: 'zarina.klang@example.com', pool_status: pool.on ? ('available' as const) : ('none' as const) }
          : n === 1 ? { ...c, ...added, id: B, name: twin.on ? ' zarina  BINTI hashim' : 'Kamal Ariffin', email: 'zarina.ipoh@example.com', pool_status: 'passive' as const } : c);
    const listJobs = async () => {
      const jobs = await base.listJobs();
      const open = jobs.find((j) => j.status === 'open')!;
      return jobs.map((j) => (j.id === open.id ? { ...j, id: JOB } : j));
    };
    return { data: { ...base, listCandidates, listJobs }, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
  };
  type Access = ReturnType<typeof world>;
  type Runner = (messages: Model[], chat: UI[]) => { toUIMessageStream: () => ReadableStream<unknown> };
  const runners: Record<'lekir' | 'tuah' | 'team', (access: Access) => Runner> = {
    lekir: (access) => (messages) => runLekir(messages, access),
    tuah: (access) => (messages) => runTuah(messages, reach(), undefined, undefined, null, null, null, access),
    team: (access) => (messages, chat) =>
      runTuah(messages, reach(), undefined, undefined, null, null, { transcript: '', proposals: proposalsIn(chat), names: namesIn(chat) }, access),
  };
  type Call = { tool: string; input: unknown };
  /**
   * One request as the route runs it, and the chat as the browser holds it afterwards. `calls` is what the one agent's
   * model calls, one list per step (it answers in words after the last). The team's specialist follows `seen.workerScript`.
   */
  const exchange = async (chat: UI[], run: Runner, calls: Call[][] | null): Promise<UI[]> => {
    const { convertToModelMessages, readUIMessageStream } = await import('ai');
    const last = chat[chat.length - 1];
    const paused = last.role === 'assistant' ? structuredClone(last) : undefined;
    seen.calls = [];
    seen.singleScript = calls;
    try {
      const result = run(await convertToModelMessages(chat), chat);
      let answer: UI | undefined;
      for await (const message of readUIMessageStream({ message: paused, stream: result.toUIMessageStream() as never })) answer = message as UI;
      return paused ? [...chat.slice(0, -1), answer!] : [...chat, answer!];
    } finally {
      seen.singleScript = null;
    }
  };
  const toolParts = (chat: UI[]) => chat.flatMap((m) => m.parts as unknown as ToolPart[]).filter((p) => p.type.startsWith('tool-'));
  const waiting = (chat: UI[]) => toolParts(chat).filter((p) => p.state === 'approval-requested' && !p.approval?.isAutomatic);
  /** The parts the user said yes to that then did not run. */
  const stopped = (chat: UI[]) => toolParts(chat).filter((p) => p.state === 'output-denied' && p.approval?.approved === true);
  /** The user's answer, written on the part as the chat writes it. The chat sends no reason today; `reason` is for the day it does. */
  const decide = (chat: UI[], approved: boolean, reason?: string): UI[] => {
    const next = structuredClone(chat);
    const [card] = waiting(next);
    card.state = 'approval-responded';
    card.approval = { ...card.approval!, approved, ...(reason !== undefined && { reason }) };
    return next;
  };
  /** What a waiting card would do, whichever agent shows it: the tool and its input. */
  const asks = (chat: UI[], card: ToolPart): { action: string; input: unknown } => {
    if (card.type !== 'tool-applyChange') return { action: card.type.slice('tool-'.length), input: card.input };
    const proposal = proposalsIn(chat).get((card.input as { proposalId: string }).proposalId)!;
    return { action: proposal.action, input: proposal.input };
  };
  const reset = () => {
    for (const fn of [poolSet, pipelineMoved, candidateDeleted]) fn.mockReset();
    poolSet.mockResolvedValue({ ok: true, data: { id: A, name: 'Zarina binti Hashim', from: 'none', to: 'available', message: 'Added Zarina binti Hashim to the talent pool as Available.' } });
    candidateDeleted.mockResolvedValue({ ok: true, data: { id: A, name: 'Zarina binti Hashim', job: null, applications: 0, interviews: 0, cv_files: 0, message: 'Deleted Zarina binti Hashim.' } });
    seen.refusals = [];
    seen.workerStep = 0;
  };
  const lookups: Call[] = [{ tool: 'listCandidates', input: { name: 'Zarina binti Hashim' } }, { tool: 'listJobs', input: {} }];
  // A filler lookup first, so the call that follows gets a call id of its own: the scripted model names a call after its tool and its place.
  const again = (call: Call): Call[][] => [[{ tool: 'listJobs', input: {} }, call]];

  type Case = {
    name: string;
    first: Call;
    /** What changes between the card and the yes. */
    change: (pool: { on: boolean }, twin: { on: boolean }) => void;
    second: Call;
    /** The second card carries the line that says which one it is. */
    line: boolean;
    ran: () => void;
  };
  const cases: Case[] = [
    {
      name: 'a move for someone who then left the pool, then adding them to it',
      first: { tool: 'moveToPipeline', input: { id: A, job_id: JOB } },
      change: (pool) => { pool.on = false; },
      second: { tool: 'setPoolStatus', input: { id: A, status: 'available', only_if_outside: true } },
      line: false,
      ran: () => {
        expect(pipelineMoved).not.toHaveBeenCalled();
        expect(poolSet).toHaveBeenCalledTimes(1);
        expect(poolSet.mock.calls[0][1]).toEqual({ id: A, status: 'available', only_if_outside: true });
      },
    },
    {
      name: 'a pool change when a namesake then appeared, prepared again',
      first: { tool: 'setPoolStatus', input: { id: A, status: 'passive' } },
      change: (_pool, twin) => { twin.on = true; },
      second: { tool: 'setPoolStatus', input: { id: A, status: 'passive' } },
      line: true,
      ran: () => {
        expect(poolSet).toHaveBeenCalledTimes(1);
        expect(poolSet.mock.calls[0][1]).toEqual({ id: A, status: 'passive' });
      },
    },
    {
      name: 'a deletion when a namesake then appeared, prepared again',
      first: { tool: 'deleteCandidate', input: { id: A } },
      change: (_pool, twin) => { twin.on = true; },
      second: { tool: 'deleteCandidate', input: { id: A } },
      line: true,
      ran: () => {
        expect(candidateDeleted).toHaveBeenCalledTimes(1);
        expect(candidateDeleted.mock.calls[0][1]).toEqual({ id: A });
      },
    },
  ];

  it('team: a lookup that said several match still holds a pool change back in the turn\'s second request', async () => {
    const AMBIGUOUS =
      'More than one match was found for that name, so no talent pool change was prepared. Stop here: say who matches and ask the user which one they mean. ' +
      'Once the user has said who, they can ask for the change again.';
    reset();
    candidateSaved.mockReset();
    candidateSaved.mockResolvedValue({ ok: true, data: { id: B, name: 'Kamal Ariffin' } });
    const run = runners.team(world());
    seen.workerScript = [
      // First delegation: the letters fit both people (and others), and the pool change is refused.
      { tool: 'listCandidates', input: { name: 'ari' } },
      { tool: 'setPoolStatus', input: { id: A, status: 'passive' } },
      'answer',
      // Second delegation, same request: another kind of change, which gets a card. The request ends there.
      { tool: 'listCandidates', input: {} },
      { tool: 'updateCandidate', input: { id: B, location: 'Klang' } },
      // The request that carries the user's yes: a clean lookup by full name, then the pool change again.
      { tool: 'listCandidates', input: { name: 'Zarina binti Hashim' } },
      { tool: 'setPoolStatus', input: { id: A, status: 'passive' } },
    ];
    try {
      const shown = await exchange([say('u1', 'Mark Zarina passive, and move the other one to Klang')], run, null);
      expect(seen.refusals).toEqual([AMBIGUOUS]);
      expect(waiting(shown)).toHaveLength(1);
      expect(asks(shown, waiting(shown)[0]).action).toBe('updateCandidate');
      // The first specialist's report, as the browser keeps it, names both ids as ambiguous: that is what the next request reads.
      const reports = toolParts(shown).filter((p) => p.type === 'tool-askLekir').map((p) => (p as { output?: { ambiguous?: string[] } }).output?.ambiguous);
      expect(reports[0]).toEqual(expect.arrayContaining([A, B]));

      seen.refusals = [];
      const after = await exchange(decide(shown, true), run, null);
      expect(candidateSaved).toHaveBeenCalledTimes(1);
      expect(seen.refusals.length).toBeGreaterThan(0);
      for (const refusal of seen.refusals) expect(refusal).toBe(AMBIGUOUS);
      expect(waiting(after)).toEqual([]);
      expect(poolSet).not.toHaveBeenCalled();
    } finally {
      seen.workerScript = null;
    }
  });

  describe.each(['lekir', 'tuah', 'team'] as const)('%s', (mode) => {
    it.each(cases)('$name: the second card can be approved and runs once', async ({ first, change, second, line, ran }) => {
      const { toToolStep } = await import('@/components/chat/tool-parts');
      reset();
      const [pool, twin] = [{ on: true }, { on: false }];
      const run = runners[mode](world(pool, twin));
      const own = mode !== 'team';
      seen.workerScript = own ? null : [...lookups, first, second, 'answer'];
      try {
        const shown = await exchange([say('u1', 'Do this for the candidate Zarina binti Hashim')], run, own ? [lookups, [first]] : null);
        expect(waiting(shown)).toHaveLength(1);
        expect(asks(shown, waiting(shown)[0])).toEqual({ action: first.tool, input: first.input });

        change(pool, twin);
        // The yes arrives; the last check stops it; the assistant prepares the next thing, as the refusal tells it to.
        const retried = await exchange(decide(shown, true), run, own ? again(second) : null);
        expect(stopped(retried)).toHaveLength(1);
        // What the person reads on the stopped card: "Not done", not "Not approved".
        expect(toToolStep(stopped(retried)[0] as never, 'm', 0)).toMatchObject({ denied: true, afterApproval: true });
        expect(waiting(retried)).toHaveLength(1);
        expect(asks(retried, waiting(retried)[0])).toEqual({ action: second.tool, input: second.input });
        if (line) expect(waiting(retried)[0].approval?.requestReason).toBe(LINE);

        // The third request: the stopped call now comes back in the SDK's own words. The second card must still run.
        const done = await exchange(decide(retried, true), run, own ? [] : null);
        ran();
        expect(stopped(done)).toHaveLength(1);
        expect(waiting(done)).toEqual([]);
      } finally {
        seen.workerScript = null;
      }
    });

    // The SDK writes a stopped call's result as the user's own reason when their yes carried one, and as its own
    // words only when it did not. Knowing a stopped call must not rest on the chat sending no reason.
    it('a yes that carries a reason: the stopped change is still not the turn\'s one, and the second card runs once', async () => {
      reset();
      const pool = { on: true };
      const run = runners[mode](world(pool));
      const own = mode !== 'team';
      const [first, second] = [cases[0].first, cases[0].second];
      seen.workerScript = own ? null : [...lookups, first, second, 'answer'];
      try {
        const shown = await exchange([say('u1', 'Do this for the candidate Zarina binti Hashim')], run, own ? [lookups, [first]] : null);
        expect(waiting(shown)).toHaveLength(1);
        pool.on = false;
        const retried = await exchange(decide(shown, true, 'Yes, go ahead'), run, own ? again(second) : null);
        expect(stopped(retried)).toHaveLength(1);
        expect(stopped(retried)[0].approval?.reason).toBe('Yes, go ahead');
        expect(waiting(retried)).toHaveLength(1);
        const done = await exchange(decide(retried, true, 'Yes, this one too'), run, own ? [] : null);
        cases[0].ran();
        expect(waiting(done)).toEqual([]);
      } finally {
        seen.workerScript = null;
      }
    });
    it('a no that carries a reason is still the user\'s no: the pool change stays the turn\'s one', async () => {
      reset();
      const run = runners[mode](world());
      const own = mode !== 'team';
      const first: Call = { tool: 'setPoolStatus', input: { id: A, status: 'passive' } };
      const deletion: Call = { tool: 'deleteCandidate', input: { id: B } };
      const another: Call = { tool: 'setPoolStatus', input: { id: B, status: 'available' } };
      seen.workerScript = own ? null : [{ tool: 'listCandidates', input: {} }, first, deletion, another, 'answer'];
      try {
        const shown = await exchange([say('u1', 'Mark Zarina passive, delete Kamal, then mark Kamal available')], run, own ? [[{ tool: 'listCandidates', input: {} }], [first]] : null);
        const second = await exchange(decide(shown, false, 'Not her'), run, own ? [[deletion]] : null);
        expect(waiting(second)).toHaveLength(1);
        const third = await exchange(decide(second, true, 'Yes'), run, own ? again(another) : null);
        expect(candidateDeleted).toHaveBeenCalledTimes(1);
        expect(waiting(third)).toEqual([]);
        expect(poolSet).not.toHaveBeenCalled();
      } finally {
        seen.workerScript = null;
      }
    });

    // The other side: what the user said no to, and what ran, are each still the turn's one. A deletion card in
    // between gives the turn a third request, where the first card comes back in the browser's form.
    it.each([['the user rejected', false], ['ran', true]] as const)('a pool change that %s is still the turn\'s one on a later request', async (_what, approved) => {
      reset();
      const run = runners[mode](world());
      const own = mode !== 'team';
      const first: Call = { tool: 'setPoolStatus', input: { id: A, status: 'passive' } };
      const deletion: Call = { tool: 'deleteCandidate', input: { id: B } };
      const another: Call = { tool: 'setPoolStatus', input: { id: B, status: 'available' } };
      seen.workerScript = own ? null : [{ tool: 'listCandidates', input: {} }, first, deletion, another, 'answer'];
      try {
        const shown = await exchange([say('u1', 'Mark Zarina passive, delete Kamal, then mark Kamal available')], run, own ? [[{ tool: 'listCandidates', input: {} }], [first]] : null);
        expect(waiting(shown)).toHaveLength(1);
        const second = await exchange(decide(shown, approved), run, own ? [[deletion]] : null);
        expect(poolSet).toHaveBeenCalledTimes(approved ? 1 : 0);
        expect(waiting(second)).toHaveLength(1);
        expect(asks(second, waiting(second)[0])).toEqual({ action: 'deleteCandidate', input: { id: B } });
        const third = await exchange(decide(second, true), run, own ? again(another) : null);
        expect(candidateDeleted).toHaveBeenCalledTimes(1);
        // No card for the second pool change, and nothing of it saved.
        expect(waiting(third)).toEqual([]);
        expect(poolSet).toHaveBeenCalledTimes(approved ? 1 : 0);
        if (own) {
          expect(toolParts(third).filter((p) => p.approval?.isAutomatic).map((p) => p.approval?.reason)).toEqual([ONE_POOL_CHANGE]);
        } else {
          expect(seen.refusals.length).toBeGreaterThan(0);
          for (const refusal of seen.refusals) expect(refusal).toBe(ONE_POOL_CHANGE);
        }
      } finally {
        seen.workerScript = null;
      }
    });
  });
});

// The pool lookup sees pool members only, so by a first name it can answer "one" when two people on file have it.
// A deletion therefore takes only an id that listCandidates returned, which searches everyone and says when several
// match. A pool change still takes an id from either lookup.
describe('a deletion never rests on the pool lookup alone', () => {
  const A = '11111111-1111-4111-8111-111111111171';
  const B = '22222222-2222-4222-8222-222222222272';
  type Message = import('ai').ModelMessage;
  type Part = { type: string; isAutomatic?: boolean; approved?: boolean; reason?: string; toolCall?: { toolName?: string; input?: unknown } };
  type Call = { tool: string; input: unknown };
  const NOT_LOOKED_UP =
    `You have not looked up ${A} as a candidate. Never guess an id: use listCandidates ` +
    'to find the candidate and get its real id, then prepare the change again.';
  const AMBIGUOUS =
    'More than one match was found for that name, so no deletion was prepared. Stop here: say who matches and ask the user which one they mean. ' +
    'Once the user has said who, they can ask for the deletion again.';
  /** Two people called Zarina and nobody else: one in the pool, one on file outside it. */
  const world = () => {
    const base = hire().data;
    const listCandidates = async () =>
      (await base.listCandidates())
        .filter((c, n) => n < 2 || !c.name.includes('Zarina'))
        .map((c, n) =>
          n === 0 ? { ...c, id: A, name: 'Zarina Lau', pool_status: 'passive' as const }
            : n === 1 ? { ...c, id: B, name: 'Zarina binti Hashim', pool_status: 'none' as const } : c);
    return { data: { ...base, listCandidates }, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
  };
  const inPool: Call = { tool: 'listTalentPool', input: { name: 'Zarina' } };
  const onFile: Call = { tool: 'listCandidates', input: { name: 'Zarina' } };
  const remove: Call = { tool: 'deleteCandidate', input: { id: A } };
  const mark: Call = { tool: 'setPoolStatus', input: { id: A, status: 'available' } };

  /** One request to one agent: each list is one step of its model, which answers in words after the last. */
  const alone = async (steps: Call[][], agent: 'tuah' | 'lekir') => {
    candidateDeleted.mockReset();
    poolSet.mockReset();
    seen.calls = [];
    seen.singleScript = steps;
    try {
      const messages = [{ role: 'user', content: 'Do it for Zarina' }] as Message[];
      const result = agent === 'lekir' ? runLekir(messages, world()) : runTuah(messages, reach(), undefined, undefined, null, null, null, world());
      await result.consumeStream();
      const content = ((await result.steps) as unknown as { content: Part[] }[]).flatMap((s) => s.content);
      return {
        cards: content.filter((p) => p.type === 'tool-approval-request' && !p.isAutomatic),
        denials: content.filter((p) => p.type === 'tool-approval-response' && p.approved === false).map((p) => p.reason),
      };
    } finally {
      seen.singleScript = null;
    }
  };
  /** One request to the team: what Lekir prepared and what it was refused. */
  const team_ = async (script: NonNullable<typeof seen.workerScript>, names: Record<string, string> = {}) => {
    candidateDeleted.mockReset();
    poolSet.mockReset();
    const context = { ...team(), names };
    seen.calls = [];
    seen.workerScript = script;
    seen.workerStep = 0;
    seen.refusals = [];
    try {
      await runTuah([{ role: 'user' as const, content: 'Do it for Zarina' }], reach(), undefined, undefined, null, null, context, world()).consumeStream();
    } finally {
      seen.workerScript = null;
    }
    return [...context.proposals.values()];
  };

  it('the pool lookup by that first name finds one person and says nothing of several: that is why it is not enough', async () => {
    const tools = hireProduct(world()).read as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<{ total: number; several_match?: string }> }>;
    const pool = await tools.listTalentPool.execute({ name: 'Zarina' }, { toolCallId: 't', messages: [] });
    expect(pool.total).toBe(1);
    expect(pool.several_match).toBeUndefined();
    const everyone = await tools.listCandidates.execute({ name: 'Zarina' }, { toolCallId: 't', messages: [] });
    expect(everyone.total).toBe(2);
    expect(everyone.several_match).toContain('Zarina Lau, Zarina binti Hashim');
  });
  it.each(['tuah', 'lekir'] as const)('%s: an id known only from the pool lookup gets no deletion card, and the model is sent to listCandidates', async (agent) => {
    const run = await alone([[inPool], [remove]], agent);
    expect(run.cards).toEqual([]);
    expect(run.denials).toEqual([NOT_LOOKED_UP]);
    expect(candidateDeleted).not.toHaveBeenCalled();
  });
  it.each(['tuah', 'lekir'] as const)('%s: after listCandidates by that name the deletion is held back, because several match', async (agent) => {
    const run = await alone([[inPool], [onFile], [remove]], agent);
    expect(run.cards).toEqual([]);
    expect(run.denials).toEqual([AMBIGUOUS]);
  });
  it.each(['tuah', 'lekir'] as const)('%s: a pool change from the same pool lookup still gets its card', async (agent) => {
    const run = await alone([[inPool], [mark]], agent);
    expect(run.denials).toEqual([]);
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0].toolCall).toMatchObject({ toolName: 'setPoolStatus', input: { id: A, status: 'available' } });
  });
  it('team: an id known only from the pool lookup is refused for a deletion, in the delegation that looked it up', async () => {
    expect(await team_([inPool, remove, 'answer'])).toEqual([]);
    expect(seen.refusals[0]).toBe(NOT_LOOKED_UP);
    expect(candidateDeleted).not.toHaveBeenCalled();
  });
  it('team: after listCandidates by that name the deletion is held back, because several match', async () => {
    expect(await team_([inPool, onFile, remove, 'answer'])).toEqual([]);
    expect(seen.refusals[0]).toBe(AMBIGUOUS);
  });
  it('team: a pool change from the same pool lookup is still prepared', async () => {
    const proposals = await team_([inPool, mark]);
    expect(seen.refusals).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ action: 'setPoolStatus', input: { id: A, status: 'available' } });
  });
  it('team: an id an earlier turn knew only from the pool lookup, or from a pool change, is refused too; one listCandidates returned is accepted', async () => {
    const { collectNames } = await import('@/lib/chat/change-titles');
    const pooled = { tool: 'listTalentPool', output: { total: 1, candidates: [{ id: A, name: 'Zarina Lau' }] } };
    const changed = { tool: 'setPoolStatus', output: { ok: true, data: { id: A, name: 'Zarina Lau', from: 'available', to: 'passive', message: 'x' } } };
    const listed = { tool: 'listCandidates', output: { total: 1, candidates: [{ id: A, name: 'Zarina Lau' }] } };
    for (const earlier of [[pooled], [changed], [pooled, changed]]) {
      expect(await team_([remove, 'answer'], collectNames(earlier))).toEqual([]);
      expect(seen.refusals[0]).toBe(NOT_LOOKED_UP);
      // The same names still serve a pool change.
      expect(await team_([mark], collectNames(earlier))).toHaveLength(1);
    }
    // In either order, and from two reports put together as the chat's names are.
    for (const earlier of [[pooled, listed], [listed, pooled]]) {
      expect((await team_([remove], collectNames(earlier)))[0]).toMatchObject({ action: 'deleteCandidate', input: { id: A } });
    }
    expect((await team_([remove], { ...collectNames([listed]), ...collectNames([pooled]) }))[0]).toMatchObject({ action: 'deleteCandidate' });
    // Names kept before the pool lookup returned ids carry no mark of where they came from: they are as they were.
    expect((await team_([remove], { [`candidate:${A}`]: 'Zarina Lau' }))[0]).toMatchObject({ action: 'deleteCandidate' });
  });
});
