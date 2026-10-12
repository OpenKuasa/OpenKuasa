import { describe, expect, it, vi } from 'vitest';

const executed = vi.hoisted(() => ({ creates: 0, modelCalls: 0 }));

vi.mock('@/lib/crm/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crm/contacts')>();
  return {
    ...actual,
    createCrmContact: async () => {
      executed.creates += 1;
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
        doStream: async (options: { prompt: { role: string }[] }) => {
          executed.modelCalls += 1;
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
                  toolName: 'createContact',
                  input: JSON.stringify({ firstName: 'Ali', lastName: 'Hassan', email: 'ali@example.com' }),
                },
                // The SDK reads finishReason.unified: a bare string would silently disable tool execution.
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
              ];
          return {
            stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }),
          };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { runKasturi } = await import('@/lib/ai/agents/orchestrator');
// After this file's mocks and the values they use are in place: the helpers load the tools too.
const { withKasturi } = await import('./helpers/approvals');

const crm = { client: {} as never, orgId: 'org1', userId: 'user1', canWrite: true };
const { createSeedReachData } = await import('@/lib/reach/seed');
const reach = { data: createSeedReachData() };
const ask = [{ role: 'user' as const, content: 'Add Ali Hassan, ali@example.com, as a contact' }];

describe('Kasturi’s changes require approval', () => {
  it('a change does not run until it is approved', async () => {
    executed.creates = 0;
    const result = runKasturi(...withKasturi(ask, crm, reach));
    await result.consumeStream();
    expect(executed.creates).toBe(0);
    // The call is surfaced as awaiting approval rather than silently dropped.
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
  });

  // Replays the history the client sends after the user clicks Approve / Reject:
  // user -> assistant(tool-call + approval-request) -> tool(approval-response).
  const resume = (approved: boolean) =>
    runKasturi(...withKasturi(
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
        { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'a1', approved }] },
      ],
      crm,
      reach,
    ));

  it('approve: the resumed turn adds the contact', async () => {
    executed.creates = 0;
    const result = resume(true);
    await result.consumeStream();
    expect(executed.creates).toBe(1);
    expect(await result.text).toBe('Done.');
  });

  it('reject: the change never runs and the turn still continues', async () => {
    executed.creates = 0;
    executed.modelCalls = 0;
    const result = resume(false);
    await result.consumeStream();
    expect(executed.creates).toBe(0);
    expect(executed.modelCalls).toBeGreaterThan(0);
    expect(await result.text).toBe('Done.');
  });
});
