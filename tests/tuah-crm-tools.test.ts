import { describe, expect, it, vi } from 'vitest';
import { approvalDetail, approvalTitle } from '@/components/chat/tool-parts';
import { createSeedReachData } from '@/lib/reach/seed';
import type { CrmDeal } from '@/lib/crm/deals';
import type { CrmPipeline } from '@/lib/crm/pipelines';

const seen = vi.hoisted(() => ({ creates: 0, toolNames: [] as string[][] }));

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
  return {
    ...actual,
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async (options: { prompt: { role: string }[]; tools?: { name: string }[] }) => {
          seen.toolNames.push((options.tools ?? []).map((t) => t.name));
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
                  toolName: 'createContact',
                  input: JSON.stringify({ firstName: 'Ali', lastName: 'Hassan', email: 'ali@example.com' }),
                },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
              ];
          return {
            stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }),
          };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { runTuah } = await import('@/lib/ai/agents/orchestrator');
const { CRM_WRITE_TOOL_NAMES, deriveDealStats } = await import('@/lib/ai/crm-tools');

const reach = () => ({ data: createSeedReachData() });
const crm = (canWrite: boolean) => ({
  client: {} as never,
  orgId: 'org1',
  userId: 'user1',
  canWrite,
});
const ask = [{ role: 'user' as const, content: 'Add Ali Hassan, ali@example.com, as a contact' }];

describe('Tuah has the CRM tools', () => {
  it('gives the lookups to everyone in a workspace, and the changes only to those who may make them', async () => {
    // The tools the model was offered on the first call of a run.
    const offered = async (run: () => ReturnType<typeof runTuah>) => {
      seen.toolNames = [];
      await run().consumeStream();
      return seen.toolNames[0];
    };
    const member = await offered(() => runTuah(ask, reach(), undefined, undefined, null, crm(true)));
    const viewer = await offered(() => runTuah(ask, reach(), undefined, undefined, null, crm(false)));
    const noWorkspace = await offered(() => runTuah(ask, reach()));

    for (const name of ['listCrmContacts', 'listDeals', 'listPipelines', 'getDealStats']) {
      expect(member).toContain(name);
      expect(viewer).toContain(name);
      expect(noWorkspace).not.toContain(name);
    }
    for (const name of CRM_WRITE_TOOL_NAMES) {
      expect(member).toContain(name);
      expect(viewer).not.toContain(name);
    }
    // The marketing lookup of leads keeps its own name beside the CRM one.
    expect(member).toContain('listContacts');
  });

  it('a CRM change does not run until it is approved', async () => {
    seen.creates = 0;
    const result = runTuah(ask, reach(), undefined, undefined, null, crm(true));
    await result.consumeStream();
    expect(seen.creates).toBe(0);
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
  });

  it('approve: the resumed turn adds the contact', async () => {
    seen.creates = 0;
    const result = runTuah(
      [
        ...ask,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'createContact',
              input: { firstName: 'Ali', lastName: 'Hassan', email: 'ali@example.com' },
            },
            { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 't1' },
          ],
        },
        { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'a1', approved: true }] },
      ],
      reach(),
      undefined,
      undefined,
      null,
      crm(true),
    );
    await result.consumeStream();
    expect(seen.creates).toBe(1);
    expect(await result.text).toBe('Done.');
  });
});

describe('approval cards for CRM changes', () => {
  const names: Record<string, string> = { c1: 'Ali Hassan', d1: 'Annual plan', s2: 'Proposal' };
  const named = (id: unknown) => (typeof id === 'string' ? (names[id] ?? null) : null);

  it('says who and what', () => {
    expect(approvalTitle('createContact', { firstName: 'Ali', lastName: 'Hassan' })).toBe(
      'Add contact “Ali Hassan”?',
    );
    expect(approvalTitle('deleteContact', { id: 'c1' }, named)).toBe('Delete contact “Ali Hassan”?');
    expect(approvalTitle('createDeal', { title: 'Annual plan', contactId: 'c1' }, named)).toBe(
      'Add deal “Annual plan” for Ali Hassan?',
    );
    expect(approvalTitle('moveDeal', { id: 'd1', stageId: 's2' }, named)).toBe(
      'Move deal “Annual plan” to Proposal?',
    );
    expect(approvalTitle('markDealLost', { id: 'd1' }, named)).toBe('Mark deal “Annual plan” as lost?');
  });

  it('never names a deal after a contact that happens to share the id', async () => {
    const { nameFinder } = await import('@/components/chat/tool-parts');
    const find = nameFinder([
      {
        parts: [
          {
            type: 'tool-listCrmContacts',
            toolCallId: 'x1',
            state: 'output-available',
            input: {},
            output: { contacts: [{ id: 'c1', name: 'Ali Hassan' }] },
          },
        ],
      },
    ] as never);
    expect(find('c1', 'contact')).toBe('Ali Hassan');
    expect(find('c1', 'deal')).toBeNull();
    expect(approvalTitle('moveDeal', { id: 'c1', stageId: 's9' }, find)).toBe(
      'Move this deal to another stage?',
    );
  });

  it('falls back to plain wording, and warns before deletes', () => {
    expect(approvalTitle('moveDeal', { id: 'zz', stageId: 'zz' }, named)).toBe(
      'Move this deal to another stage?',
    );
    expect(approvalDetail('deleteContact')).toContain('deals are deleted too');
    expect(approvalDetail('deleteDeal')).toBe('Its notes, activities and files are deleted too. This cannot be undone.');
  });
});

describe('deriveDealStats', () => {
  const deal = (id: string, status: CrmDeal['status'], value: number, stageId: string) =>
    ({ id, status, value, stageId }) as CrmDeal;
  const pipelines = [
    {
      id: 'p1',
      name: 'Sales pipeline',
      isDefault: true,
      stages: [
        { id: 's1', name: 'New', position: 0, probability: 10, dot: '' },
        { id: 's2', name: 'Proposal', position: 1, probability: 50, dot: '' },
      ],
    },
  ] as CrmPipeline[];

  it('totals deals by status and open deals by stage', () => {
    const stats = deriveDealStats(
      [
        deal('a', 'open', 1000, 's1'),
        deal('b', 'open', 2500.5, 's2'),
        deal('c', 'won', 9000, 's2'),
        deal('d', 'lost', 400, 's1'),
      ],
      pipelines,
    );
    expect(stats.total).toBe(4);
    expect(stats.open).toEqual({ count: 2, value: 'RM 3,500.50' });
    expect(stats.won.count).toBe(1);
    expect(stats.lost.count).toBe(1);
    expect(stats.open_by_stage).toEqual([
      { pipeline: 'Sales pipeline', stage: 'New', count: 1, value: 'RM 1,000.00' },
      { pipeline: 'Sales pipeline', stage: 'Proposal', count: 1, value: 'RM 2,500.50' },
    ]);
  });
});
