import { describe, expect, it, vi } from 'vitest';
import { createSeedReachData } from '@/lib/reach/seed';

const executed = vi.hoisted(() => ({ deletes: 0, modelCalls: 0 }));

vi.mock('@/lib/reach/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reach/capabilities')>();
  return {
    ...actual,
    deleteCampaign: async () => {
      executed.deletes += 1;
      return { ok: true, data: { id: 'x' } };
    },
  };
});

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  return {
    ...actual,
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async (options: { prompt: unknown[] }) => {
          executed.modelCalls += 1;
          // A resumed turn (history already holds the tool call) just answers in text.
          const resumed = options.prompt.some((m) => (m as { role: string }).role === 'tool');
          const usage = {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          };
          if (resumed) {
            return {
              stream: simulateReadableStream({
                initialDelayInMs: 0,
                chunkDelayInMs: 0,
                chunks: [
                  { type: 'text-start', id: 'a' },
                  { type: 'text-delta', id: 'a', delta: 'Done.' },
                  { type: 'text-end', id: 'a' },
                  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
                ],
              }),
            };
          }
          return {
          stream: simulateReadableStream({
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 't1',
                toolName: 'deleteCampaign',
                input: JSON.stringify({ id: '00000000-0000-0000-0000-000000000000' }),
              },
              {
                type: 'finish',
                // The SDK reads finishReason.unified: a bare string would silently disable tool execution.
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ],
          }),
          };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { runJebat } = await import('@/lib/ai/agents/orchestrator');
// After this file's mocks and the values they use are in place: the helpers load the tools too.
const { withJebat } = await import('./helpers/approvals');

describe('AI writes require approval', () => {
  it('a write tool call does not execute until approved', async () => {
    executed.deletes = 0;
    const result = runJebat(...withJebat(
      [{ role: 'user', content: 'delete the Brand Awareness campaign' }],
      {
        data: createSeedReachData(),
        write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true },
      },
    ));
    await result.consumeStream();
    expect(executed.deletes).toBe(0);
    // The call is surfaced as awaiting approval rather than silently dropped.
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
  });

  // Replays the history the client sends after the user clicks Approve / Reject:
  // user -> assistant(tool-call + approval-request) -> tool(approval-response).
  const resume = (approved: boolean) => {
    const input = { id: '00000000-0000-0000-0000-000000000000' };
    return runJebat(...withJebat(
      [
        { role: 'user', content: 'delete the Brand Awareness campaign' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 't1', toolName: 'deleteCampaign', input },
            { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 't1' },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-approval-response', approvalId: 'a1', approved }],
        },
      ],
      {
        data: createSeedReachData(),
        write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true },
      },
    ));
  };

  it('approve: the resumed turn executes the approved write', async () => {
    executed.deletes = 0;
    const result = resume(true);
    await result.consumeStream();
    expect(executed.deletes).toBe(1);
    // The model resumes after the tool ran.
    expect(await result.text).toBe('Done.');
  });

  it('reject: the write never runs and the turn still continues', async () => {
    executed.deletes = 0;
    executed.modelCalls = 0;
    const result = resume(false);
    await result.consumeStream();
    expect(executed.deletes).toBe(0);
    expect(executed.modelCalls).toBeGreaterThan(0);
    expect(await result.text).toBe('Done.');
  });
});
