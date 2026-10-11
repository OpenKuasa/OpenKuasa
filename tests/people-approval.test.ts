import { describe, expect, it, vi } from 'vitest';

const executed = vi.hoisted(() => ({ creates: 0, modelCalls: 0 }));

vi.mock('@/lib/people/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/capabilities')>();
  return {
    ...actual,
    createDepartment: async () => {
      executed.creates += 1;
      return { ok: true as const, data: { id: 'd1', name: 'Legal', created_at: '2026-10-11T00:00:00Z' } };
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
                { type: 'tool-call', toolCallId: 't1', toolName: 'createDepartment', input: JSON.stringify({ name: 'Legal' }) },
                // The SDK reads finishReason.unified: a bare string would silently disable tool execution.
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
              ];
          return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { runLekiu } = await import('@/lib/ai/agents/orchestrator');
const { createSeedPeopleData } = await import('@/lib/people/seed');

const people = {
  data: createSeedPeopleData(new Date('2026-10-09T04:00:00Z')),
  viewer: { employeeId: null, isHr: true, isDemo: false },
  write: { ctx: { client: {} as never, orgId: 'org1' }, tier: 'hr' as const, employeeId: null, receipt: null, userId: 'u1' },
};
const ask = [{ role: 'user' as const, content: 'Tambah department Legal' }];

describe('Lekiu’s changes require approval', () => {
  it('a change does not run until it is approved', async () => {
    executed.creates = 0;
    const result = runLekiu(ask, people);
    await result.consumeStream();
    expect(executed.creates).toBe(0);
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
  });

  // The history the client sends after the person taps Approve or Reject.
  const resume = (approved: boolean) =>
    runLekiu(
      [
        ...ask,
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 't1', toolName: 'createDepartment', input: { name: 'Legal' } },
            { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 't1' },
          ],
        },
        { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'a1', approved }] },
      ],
      people,
    );

  it('approve: the resumed turn adds the department', async () => {
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
