import { describe, expect, it, vi } from 'vitest';
import { createSeedHireData } from '@/lib/hire/seed';
import { createSeedReachData } from '@/lib/reach/seed';
import { HIRE_TOOL_NAMES } from '@/lib/ai/hire-tools';
import { HIRE_WRITE_TOOL_NAMES } from '@/lib/ai/products';

const seen = vi.hoisted(() => ({
  calls: [] as { layer: string; system: string; tools: string[] }[],
  /** Set by the one test that needs a change prepared: Tuah asks Lekir, and Lekir calls createJob. */
  prepareJob: false,
}));
const created = vi.hoisted(() => vi.fn());

// The real schemas, so the prepared input is checked as it is in the app; only the write is recorded.
vi.mock('@/lib/hire/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/capabilities')>()),
  createJob: created,
}));

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
              chunks: !seen.prepareJob
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

const { runTuah } = await import('@/lib/ai/agents/orchestrator');
const { createTeamTools } = await import('@/lib/ai/agents/specialists');
const { hireProduct, reachProduct } = await import('@/lib/ai/products');
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
  it('a writer gets all four change tools', async () => {
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
  it('says jobs can be changed and the rest of hiring cannot yet', () => {
    for (const prompt of [TUAH_SYSTEM, tuahTeamSystem([{ name: 'Lekir', area: 'hiring' }], true, null)]) {
      const p = prompt.toLowerCase();
      expect(p).not.toContain('hiring cannot be changed yet');
      expect(p).toContain('candidates, applications and interviews cannot be changed yet');
    }
    expect(TUAH_SYSTEM.toLowerCase()).toContain('create, edit, open, pause, close, reopen or delete jobs');
  });
  it('does not contradict itself about jobs', () => {
    expect(TUAH_SYSTEM).not.toContain('job posts');
    expect(tuahTeamSystem([{ name: 'Lekir', area: 'hiring' }], true, null)).not.toContain('job posts');
    expect(TUAH_SYSTEM).toContain('outside marketing, the CRM and jobs');
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
