import { describe, expect, it, vi } from 'vitest';
import { createSeedReachData } from '@/lib/reach/seed';

const seen = vi.hoisted(() => ({
  deletes: 0,
  layers: [] as string[],
  toolNames: [] as string[][],
  systems: [] as string[],
}));

vi.mock('@/lib/reach/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reach/capabilities')>();
  return {
    ...actual,
    deleteCampaign: async () => {
      seen.deletes += 1;
      return { ok: true, data: { id: 'x' } };
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
  return {
    ...actual,
    getModel: (layer: string) => {
      seen.layers.push(layer);
      return new MockLanguageModelV4({
        doStream: async (options: {
          prompt: { role: string; content: unknown }[];
          tools?: { name: string }[];
        }) => {
          seen.toolNames.push((options.tools ?? []).map((t) => t.name));
          const system = options.prompt.find((m) => m.role === 'system');
          seen.systems.push(typeof system?.content === 'string' ? system.content : '');
          // A resumed turn (history already holds the tool call) just answers in text.
          const resumed = options.prompt.some((m) => m.role === 'tool');
          const chunks: Record<string, unknown>[] = resumed
            ? [
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'Done.' },
                { type: 'text-end', id: 'a' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ]
            : [
                {
                  type: 'tool-call',
                  toolCallId: 't1',
                  toolName: 'deleteCampaign',
                  input: JSON.stringify({ id: '00000000-0000-0000-0000-000000000000' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage,
                },
              ];
          return {
            stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }),
          };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never;
    },
  };
});

const { runTuah } = await import('@/lib/ai/agents/orchestrator');
// After this file's mocks and the values they use are in place: the helpers load the tools too.
const { withTuah } = await import('./helpers/approvals');
const { createSeedPeopleData } = await import('@/lib/people/seed');

const member = () => ({
  data: createSeedReachData(),
  write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true },
});
const viewer = () => ({ data: createSeedReachData() });
const peopleData = () => createSeedPeopleData();
const peopleHr = () => ({
  data: peopleData(),
  viewer: { employeeId: null, isHr: true, isDemo: false },
  write: { ctx: { client: {} as never, orgId: 'org1' }, tier: 'hr' as const, employeeId: null, receipt: null, userId: 'u1' },
});
const peopleReadOnly = () => ({
  data: peopleData(),
  viewer: { employeeId: null, isHr: false, isDemo: false },
});
const ask = [{ role: 'user' as const, content: 'delete the Brand Awareness campaign' }];

describe('Tuah has the marketing tools', () => {
  it('gives the model the lookups, and the changes only to someone who may make them', async () => {
    seen.toolNames = [];
    seen.layers = [];
    await runTuah(...withTuah(ask, member())).consumeStream();
    await runTuah(...withTuah(ask, viewer())).consumeStream();

    const [forMember, forViewer] = seen.toolNames;
    expect(forMember).toContain('getLeadSummary');
    expect(forMember).toContain('getCampaigns');
    expect(forMember).toContain('deleteCampaign');
    expect(forViewer).toContain('getLeadSummary');
    expect(forViewer).not.toContain('deleteCampaign');
    expect(forViewer).not.toContain('createCampaign');
    // The model the tool rules were tuned on, as for Jebat.
    expect(seen.layers.every((layer) => layer === 'orchestrator')).toBe(true);
  });

  it('holds the HR tools when HR is passed, with changes only for someone who may make them', async () => {
    seen.toolNames = [];
    // Single-agent Tuah (no team): reach + HR tools combined into one set.
    await runTuah(...withTuah(ask, member(), undefined, undefined, undefined, undefined, undefined, undefined, peopleHr())).consumeStream();
    await runTuah(...withTuah(ask, member(), undefined, undefined, undefined, undefined, undefined, undefined, peopleReadOnly())).consumeStream();

    const [withHrWrite, hrReadOnly] = seen.toolNames;
    expect(withHrWrite).toContain('listEmployees');
    expect(withHrWrite).toContain('getPayrollSummary');
    expect(withHrWrite).toContain('decideLeave');
    // Reach and HR share one set without a name clash.
    expect(withHrWrite).toContain('getCampaigns');
    expect(hrReadOnly).toContain('listEmployees');
    expect(hrReadOnly).not.toContain('decideLeave');
    expect(hrReadOnly).not.toContain('createEmployee');
  });

  it('tells the model where the user is asking from', async () => {
    seen.systems = [];
    await runTuah(...withTuah(ask, viewer(), undefined, undefined, {
      key: 'crm',
      product: 'Kasturi',
      item: 'Contacts',
    })).consumeStream();
    expect(seen.systems[0]).toContain('Kasturi › Contacts');
  });

  it('a change does not run until it is approved', async () => {
    seen.deletes = 0;
    const result = runTuah(...withTuah(ask, member()));
    await result.consumeStream();
    expect(seen.deletes).toBe(0);
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
  });

  const resume = (approved: boolean) =>
    runTuah(...withTuah(
      [
        ...ask,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'deleteCampaign',
              input: { id: '00000000-0000-0000-0000-000000000000' },
            },
            { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 't1' },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-approval-response', approvalId: 'a1', approved }],
        },
      ],
      member(),
    ));

  it('approve: the resumed turn makes the change', async () => {
    seen.deletes = 0;
    const result = resume(true);
    await result.consumeStream();
    expect(seen.deletes).toBe(1);
    expect(await result.text).toBe('Done.');
  });

  it('reject: the change never runs and the turn still finishes', async () => {
    seen.deletes = 0;
    const result = resume(false);
    await result.consumeStream();
    expect(seen.deletes).toBe(0);
    expect(await result.text).toBe('Done.');
  });
});
