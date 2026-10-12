import { describe, expect, it, vi } from 'vitest';
import { createSeedReachData } from '@/lib/reach/seed';
import type { Delegation, Proposal } from '@/lib/chat/delegation';

const seen = vi.hoisted(() => ({
  creates: 0,
  layers: [] as string[],
  /** What Kasturi calls first; the contact by default. */
  workerCall: null as null | { tool: string; input: unknown },
  tuahTools: [] as string[][],
  workerTools: [] as string[][],
  workerPrompts: [] as string[],
}));

vi.mock('@/lib/crm/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crm/contacts')>();
  return {
    ...actual,
    createCrmContact: async () => {
      seen.creates += 1;
      return { id: 'c1', first: 'Ali', last: 'Hassan' };
    },
  };
});

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const text = (id: string, delta: string) => [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta },
    { type: 'text-end', id },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
  const call = (toolName: string, input: unknown) => [
    { type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ];
  type Options = { prompt: { role: string }[]; tools?: { name: string }[] };
  const model = (script: (options: Options) => Record<string, unknown>[]) =>
    new MockLanguageModelV4({
      doStream: async (options: Options) => ({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: script(options),
        }),
      }),
    } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never;

  return {
    ...actual,
    getModel: (layer: string) => {
      seen.layers.push(layer);
      if (layer === 'worker') {
        // Kasturi: prepare the contact, then report the proposal.
        return model((options) => {
          seen.workerTools.push((options.tools ?? []).map((t) => t.name));
          const all = JSON.stringify(options.prompt);
          seen.workerPrompts.push(all);
          const id = /proposalId\\?":\\?"([\w-]{36})/.exec(all)?.[1];
          if (id) return text('w', `Prepared the contact. proposalId ${id}`);
          if (all.includes('Never guess an id')) return text('w', 'I could not find that stage.');
          return seen.workerCall
            ? call(seen.workerCall.tool, seen.workerCall.input)
            : call('createContact', {
                firstName: 'Ali',
                lastName: 'Hassan',
                email: 'ali@example.com',
              });
        });
      }
      // Tuah: ask Kasturi, then put the prepared change in front of the user.
      return model((options) => {
        seen.tuahTools.push((options.tools ?? []).map((t) => t.name));
        const all = JSON.stringify(options.prompt);
        const id = /proposalId ([\w-]{36})/.exec(all)?.[1];
        if (all.includes('call-applyChange')) return text('t', 'Done.');
        return id
          ? call('applyChange', { proposalId: id })
          : call('askKasturi', { task: 'Add Ali Hassan, ali@example.com, as a contact' });
      });
    },
  };
});

const { runTuah } = await import('@/lib/ai/agents/orchestrator');
// After this file's mocks and the values they use are in place: the helpers load the tools too.
const { storeOf, withTuah } = await import('./helpers/approvals');
const { createTeamTools, delegationForModel } = await import('@/lib/ai/agents/specialists');
const { crmProduct, reachProduct } = await import('@/lib/ai/products');
const { createSeedPeopleData } = await import('@/lib/people/seed');
const { proposalsIn, transcriptOf, usesSpecialists } = await import('@/lib/chat/delegation');

const reach = () => ({ data: createSeedReachData() });
const crm = (canWrite = true) => ({ client: {} as never, orgId: 'org1', userId: 'u1', canWrite });
const people = () => ({
  data: createSeedPeopleData(),
  viewer: { employeeId: null, isHr: true, isDemo: false },
  write: { ctx: { client: {} as never, orgId: 'org1' }, tier: 'hr' as const, employeeId: null, receipt: null, userId: 'u1' },
});
const finance = () => ({ client: {} as never, orgId: 'org1', canWrite: true });
const ask = [{ role: 'user' as const, content: 'Add Ali Hassan, ali@example.com, as a contact' }];
const team = () => ({ transcript: 'User: Add Ali Hassan', proposals: new Map<string, Proposal>() });

describe('Tuah with its team', () => {
  it('holds only the ask tools and applyChange, and the specialist holds the product tools', async () => {
    seen.tuahTools = [];
    seen.workerTools = [];
    seen.layers = [];
    await runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm(), team())).consumeStream();

    expect(seen.tuahTools[0].sort()).toEqual(['applyChange', 'askJebat', 'askKasturi']);
    expect(seen.workerTools[0]).toContain('listCrmContacts');
    expect(seen.workerTools[0]).toContain('createContact');
    // Tuah on the larger model, the specialist on the cheaper one.
    expect(seen.layers).toContain('orchestrator');
    expect(seen.layers).toContain('worker');
  });

  it('a change a specialist prepares is not saved, and reaches the user as one approval', async () => {
    seen.creates = 0;
    const context = team();
    const result = runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm(), context));
    await result.consumeStream();

    expect(seen.creates).toBe(0);
    const [proposal] = [...context.proposals.values()];
    expect(proposal).toMatchObject({
      product: 'crm',
      action: 'createContact',
      title: 'Add contact “Ali Hassan”?',
    });

    const steps = await result.steps;
    const calls = steps.flatMap((step) => step.toolCalls.map((c) => c.toolName));
    expect(calls).toEqual(['askKasturi', 'applyChange']);
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
  });

  it('gives the specialist the conversation, since it does not see it otherwise', async () => {
    seen.workerPrompts = [];
    await runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm(), team())).consumeStream();
    expect(seen.workerPrompts[0]).toContain('User: Add Ali Hassan');
    expect(seen.workerPrompts[0]).toContain('Task from Tuah');
  });

  it('does not prepare a change that uses an id nobody looked up', async () => {
    const deal = '11111111-1111-4111-8111-111111111111';
    const madeUpStage = '22222222-2222-4222-8222-222222222222';
    seen.workerCall = { tool: 'moveDeal', input: { id: deal, stageId: madeUpStage } };
    seen.workerPrompts = [];
    // The deal's id is known from an earlier turn; the stage's is not.
    const context = { ...team(), names: { [`deal:${deal}`]: 'Oven lease' } };
    try {
      await runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm(), context)).consumeStream();
    } finally {
      seen.workerCall = null;
    }
    expect(context.proposals.size).toBe(0);
    const told = seen.workerPrompts.join(' ');
    expect(told).toContain('Never guess an id');
    expect(told).toContain(madeUpStage);
    expect(told).not.toContain(`not looked up ${deal}`);
  });

  it('a viewer gets no applyChange, and the specialist no change tools', async () => {
    seen.tuahTools = [];
    seen.workerTools = [];
    await runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm(false), team())).consumeStream();
    expect(seen.tuahTools[0]).not.toContain('applyChange');
    expect(seen.workerTools[0] ?? []).not.toContain('createContact');
  });

  it('adds Lekiu to the roster when HR is passed, and not otherwise', async () => {
    seen.tuahTools = [];
    await runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm(), team(), null, people())).consumeStream();
    expect(seen.tuahTools[0]).toContain('askLekiu');

    seen.tuahTools = [];
    await runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm(), team())).consumeStream();
    expect(seen.tuahTools[0]).not.toContain('askLekiu');
  });

  it('adds Bendahara to the roster when finance is passed, and not otherwise', async () => {
    seen.tuahTools = [];
    await runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm(), team(), null, null, finance())).consumeStream();
    expect(seen.tuahTools[0]).toContain('askBendahara');

    seen.tuahTools = [];
    await runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm(), team())).consumeStream();
    expect(seen.tuahTools[0]).not.toContain('askBendahara');
  });
});

describe('applying a prepared change without another model call', () => {
  const report = (over: Partial<Delegation> = {}): Delegation => ({
    agent: 'Kasturi',
    product: 'crm',
    status: 'done',
    steps: [],
    answer: '',
    proposals: [
      { id: 'abc12345', product: 'crm', action: 'createContact', input: {}, title: 'Add?', detail: null },
    ],
    ...over,
  });
  const step = (...outputs: unknown[]) => ({
    toolResults: outputs.map((output) => ({ toolName: 'askKasturi', output })),
  });

  it('applies the one change a finished specialist prepared', async () => {
    const { changeToApply } = await import('@/lib/ai/agents/specialists');
    expect(changeToApply(step(report()))?.id).toBe('abc12345');
    // A lookup beside it changes nothing: there is still exactly one change.
    expect(changeToApply(step(report(), report({ proposals: [] })))?.id).toBe('abc12345');
  });

  it('leaves everything else to Tuah', async () => {
    const { changeToApply } = await import('@/lib/ai/agents/specialists');
    expect(changeToApply(undefined)).toBeNull();
    expect(changeToApply(step(report({ proposals: [] })))).toBeNull();
    expect(changeToApply(step(report(), report()))).toBeNull();
    expect(changeToApply(step(report({ status: 'failed' })))).toBeNull();
    expect(changeToApply(step(report({ status: 'working' })))).toBeNull();
    expect(changeToApply({ toolResults: [{ toolName: 'applyChange', output: report() }] })).toBeNull();
    expect(
      changeToApply({ toolResults: [{ toolName: 'askKasturi', output: report(), preliminary: true }] }),
    ).toBeNull();
  });

  it('makes one model call for Tuah on a change, not two', async () => {
    // `tuahTools` gets one entry each time Tuah's model is actually called.
    seen.tuahTools = [];
    const result = runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm(), team()));
    await result.consumeStream();
    expect(seen.tuahTools).toHaveLength(1);
    // The change still reaches the user as an approval.
    const calls = (await result.steps).flatMap((s) => s.toolCalls.map((c) => c.toolName));
    expect(calls).toEqual(['askKasturi', 'applyChange']);
  });
});

describe('applyChange', () => {
  const products = () => [
    reachProduct({ data: createSeedReachData() }),
    crmProduct(crm()),
  ];
  const proposal = (over: Partial<Proposal> = {}): Proposal => ({
    id: 'abc12345',
    product: 'crm',
    action: 'createContact',
    input: { firstName: 'Ali', lastName: 'Hassan', email: 'ali@example.com' },
    title: 'Add contact “Ali Hassan”?',
    detail: null,
    ...over,
  });
  const applyWith = async (p: Proposal | null, id = 'abc12345') => {
    const { tools, toolApproval } = createTeamTools(products(), {
      transcript: '',
      proposals: new Map(p ? [[p.id, p]] : []),
      // What the server recorded when the change was prepared: the change that runs comes from here.
      store: storeOf(p ? [p] : []),
    });
    expect(toolApproval).toEqual({ applyChange: 'user-approval' });
    const execute = (tools.applyChange as { execute: (i: unknown, o: unknown) => Promise<unknown> })
      .execute;
    return execute({ proposalId: id }, { toolCallId: 't', messages: [] });
  };

  it('runs the product’s own change with the prepared input', async () => {
    seen.creates = 0;
    const out = await applyWith(proposal());
    expect(seen.creates).toBe(1);
    expect(out).toMatchObject({ ok: true });
  });

  it('refuses an id it does not know', async () => {
    seen.creates = 0;
    expect(await applyWith(null)).toMatchObject({ ok: false });
    expect(seen.creates).toBe(0);
  });

  it('refuses a change that is not one of the product’s, or whose input does not pass its rules', async () => {
    seen.creates = 0;
    expect(await applyWith(proposal({ action: 'toString' }))).toMatchObject({ ok: false });
    expect(await applyWith(proposal({ action: 'listCrmContacts' }))).toMatchObject({ ok: false });
    expect(await applyWith(proposal({ product: 'nope' }))).toMatchObject({ ok: false });
    expect(await applyWith(proposal({ input: { firstName: '' } }))).toMatchObject({ ok: false });
    expect(seen.creates).toBe(0);
  });
});

describe('Tuah’s instructions when it leads the team', () => {
  it('sends a change to the specialist instead of asking the user for details first', async () => {
    const { tuahTeamSystem } = await import('@/lib/ai/agents/prompts');
    const system = tuahTeamSystem([{ name: 'Jebat', area: 'marketing' }], true).toLowerCase();
    // On prod, "create a campaign called X" was met with a request for an
    // objective and a budget, neither of which a campaign needs.
    expect(system).toContain('never ask the user for more details before trying');
    expect(system).toContain('only when the specialist reports back that something required is missing');
  });
});

describe('reading a team conversation back', () => {
  const delegation: Delegation = {
    agent: 'Kasturi',
    product: 'crm',
    status: 'done',
    steps: [{ tool: 'createContact', done: true }],
    answer: 'Prepared the contact.',
    proposals: [
      { id: 'abc12345', product: 'crm', action: 'createContact', input: {}, title: 'Add contact “Ali”?', detail: null },
    ],
  };
  const messages = [
    { role: 'user', parts: [{ type: 'text', text: 'Add Ali' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me check with Kasturi...' },
        { type: 'tool-askKasturi', state: 'output-available', output: delegation },
        { type: 'tool-applyChange', state: 'approval-requested', input: { proposalId: 'abc12345' } },
      ],
    },
  ];

  it('finds prepared changes, knows the turn was the team’s, and words the conversation', () => {
    expect(proposalsIn(messages).get('abc12345')?.action).toBe('createContact');
    expect(usesSpecialists(messages[1])).toBe(true);
    expect(usesSpecialists(messages[0])).toBe(false);
    expect(transcriptOf(messages)).toBe('User: Add Ali\nTuah: Let me check with Kasturi...');
  });

  it('remembers the names of rows from earlier turns, by kind', async () => {
    const { namesIn } = await import('@/lib/chat/delegation');
    const { approvalTitle } = await import('@/lib/chat/change-titles');
    const earlier = [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-askKasturi',
            state: 'output-available',
            output: { ...delegation, names: { 'deal:d1': 'Stock system' } },
          },
          {
            type: 'tool-applyChange',
            state: 'output-available',
            input: { proposalId: 'abc12345' },
            output: { ok: true, data: { id: 'c9', name: 'Hana Lee' } },
          },
        ],
      },
    ];
    const names = namesIn(earlier);
    expect(names).toEqual({ 'deal:d1': 'Stock system', 'contact:c9': 'Hana Lee' });
    const find = (id: unknown, kind?: string) => names[`${kind}:${String(id)}`] ?? null;
    expect(approvalTitle('deleteContact', { id: 'c9' }, find)).toBe('Delete contact “Hana Lee”?');
    // The same id is never taken for another kind of thing.
    expect(approvalTitle('deleteDeal', { id: 'c9' }, find)).toBe('Delete this deal?');
  });

  it('answers with the team by default, and finishes a turn with whoever started it', async () => {
    const { answersWithTeam } = await import('@/lib/chat/delegation');
    const question = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    expect(answersWithTeam(undefined, question)).toBe(true);
    expect(answersWithTeam(true, question)).toBe(true);
    expect(answersWithTeam(false, question)).toBe(false);
    // Resuming after an approval: the team's own turn stays with the team...
    expect(answersWithTeam(false, messages[1])).toBe(true);
    // ...and a single-agent turn stays with the single agent, whatever is asked.
    const solo = {
      role: 'assistant',
      parts: [{ type: 'tool-deleteCampaign', state: 'approval-responded', input: { id: 'x' } }],
    };
    expect(answersWithTeam(undefined, solo)).toBe(false);
    expect(answersWithTeam(true, solo)).toBe(false);
  });

  it('tells Tuah the answer and the ids of what was prepared', () => {
    const view = delegationForModel(delegation);
    expect(view).toContain('Prepared the contact.');
    expect(view).toContain('proposalId abc12345: Add contact “Ali”?');
    expect(delegationForModel({ ...delegation, status: 'failed', answer: 'Try again.' })).toContain(
      'could not finish',
    );
  });
});
