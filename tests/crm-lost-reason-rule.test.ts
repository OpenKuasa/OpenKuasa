import { describe, expect, it, vi } from 'vitest';

/**
 * The workspace rule "a deal marked lost needs a reason", as Kasturi's chat
 * tools see it. With the rule on, a call with no reason fails the tool's own
 * input check, so the user is never shown an Approve card the database would
 * then refuse.
 */

const DEAL_ID = '11111111-1111-4111-8111-111111111111';
const executed = vi.hoisted(() => ({ lostInput: null as unknown, marks: 0 }));

vi.mock('@/lib/crm/deals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crm/deals')>();
  return {
    ...actual,
    markCrmDealLost: async () => {
      executed.marks += 1;
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
        doStream: async (options: { prompt: { role: string }[] }) => {
          // Once the tool has answered (an error, here), the model just replies in text.
          const answered = options.prompt.some((m) => m.role === 'tool');
          const chunks: Record<string, unknown>[] = answered
            ? [
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'Why was it lost?' },
                { type: 'text-end', id: 'a' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ]
            : [
                {
                  type: 'tool-call',
                  toolCallId: 't1',
                  toolName: 'markDealLost',
                  input: JSON.stringify(executed.lostInput),
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

const { createCrmTools } = await import('@/lib/ai/crm-tools');
const { LOST_REASON_REQUIRED_MESSAGE } = await import('@/lib/crm/settings');
const { runKasturi } = await import('@/lib/ai/agents/orchestrator');
const { withKasturi } = await import('./helpers/approvals');
const { createSeedReachData } = await import('@/lib/reach/seed');

const crm = (requireLostReason?: boolean) => ({
  client: {} as never,
  orgId: 'org1',
  userId: 'user1',
  canWrite: true,
  ...(requireLostReason === undefined ? {} : { requireLostReason }),
});

type Parseable = { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } };
const markDealLost = (requireLostReason?: boolean) => {
  const t = (createCrmTools(crm(requireLostReason)) as Record<string, { description?: string; inputSchema: unknown }>)
    .markDealLost;
  return { description: t.description ?? '', schema: t.inputSchema as Parseable };
};

describe('markDealLost and the workspace’s lost-reason rule', () => {
  it('keeps the reason optional when the rule is off (and when it was not loaded)', () => {
    for (const flag of [false, undefined]) {
      const { schema, description } = markDealLost(flag);
      expect(schema.safeParse({ id: DEAL_ID }).success).toBe(true);
      expect(schema.safeParse({ id: DEAL_ID, reason: 'Went with a cheaper vendor' }).success).toBe(true);
      expect(description).not.toMatch(/requires a reason/);
    }
  });

  it('requires a reason that is not only spaces when the rule is on', () => {
    const { schema, description } = markDealLost(true);
    expect(schema.safeParse({ id: DEAL_ID }).success).toBe(false);
    const blank = schema.safeParse({ id: DEAL_ID, reason: '   ' });
    expect(blank.success).toBe(false);
    expect(blank.error?.issues.map((i) => i.message)).toContain(LOST_REASON_REQUIRED_MESSAGE);
    expect(schema.safeParse({ id: DEAL_ID, reason: 'Went with a cheaper vendor' }).success).toBe(true);
    expect(schema.safeParse({ id: DEAL_ID, reason: 'x'.repeat(201) }).success).toBe(false);
    // The model is told before it calls, so it asks the user for the reason first.
    expect(description).toMatch(/requires a reason/);
  });

  const ask = [{ role: 'user' as const, content: 'Mark the Annual plan deal as lost' }];
  const run = async (requireLostReason: boolean, input: unknown) => {
    executed.lostInput = input;
    executed.marks = 0;
    const result = runKasturi(...withKasturi(ask, crm(requireLostReason), { data: createSeedReachData() }));
    await result.consumeStream();
    return (await result.content) as { type: string; error?: unknown }[];
  };

  it('with the rule on, a call without a reason gets no Approve card and never runs', async () => {
    for (const input of [{ id: DEAL_ID }, { id: DEAL_ID, reason: '  ' }]) {
      const parts = await run(true, input);
      expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(false);
      expect(parts.some((p) => p.type === 'tool-error')).toBe(true);
      expect(executed.marks).toBe(0);
    }
  });

  it('with the rule on, a call with a reason still goes to the user as a card', async () => {
    const parts = await run(true, { id: DEAL_ID, reason: 'Went with a cheaper vendor' });
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
    expect(executed.marks).toBe(0);
  });

  it('with the rule off, a call without a reason goes to the user as a card, as before', async () => {
    const parts = await run(false, { id: DEAL_ID });
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
    expect(executed.marks).toBe(0);
  });
});
