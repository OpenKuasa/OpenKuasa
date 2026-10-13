import { describe, expect, it, vi } from 'vitest';

const executed = vi.hoisted(() => ({ applies: 0, cancels: 0, decides: 0, last: null as unknown, tool: 'applyLeave', input: {} as object }));

vi.mock('@/lib/people/leave', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/leave')>();
  return {
    ...actual,
    applyLeave: async (_ctx: unknown, input: unknown) => {
      executed.applies += 1;
      executed.last = input;
      return { ok: true as const, data: { id: 'r1', days: 3, status: 'pending' } };
    },
    cancelLeave: async () => {
      executed.cancels += 1;
      return { ok: true as const, data: { id: 'r1', status: 'cancelled' } };
    },
    decideLeave: async () => {
      executed.decides += 1;
      return { ok: true as const, data: { id: 'r1', status: 'approved' } };
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
          const resumed = options.prompt.some((m) => m.role === 'tool');
          const chunks: Record<string, unknown>[] = resumed
            ? [
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'Done.' },
                { type: 'text-end', id: 'a' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ]
            : [
                { type: 'tool-call', toolCallId: 't1', toolName: executed.tool, input: JSON.stringify(executed.input) },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
              ];
          return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { runLekiu } = await import('@/lib/ai/agents/orchestrator');
// After this file's mocks and the values they use are in place: the helpers load the tools too.
const { withLekiu } = await import('./helpers/approvals');
const { createSeedPeopleData } = await import('@/lib/people/seed');

const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const REQ = '44444444-4444-4444-8444-444444444444';
const data = createSeedPeopleData(new Date('2026-10-09T04:00:00Z'));
const ctx = { client: {} as never, orgId: 'org1' };
const asMember = { data, viewer: { employeeId: ME, isHr: false, isDemo: false }, write: { ctx, tier: 'self' as const, employeeId: ME, receipt: null, userId: 'u1' } };
const asOwner = { data, viewer: { employeeId: null, isHr: true, isDemo: false }, write: { ctx, tier: 'hr' as const, employeeId: null, receipt: null, userId: 'u1' } };
const ask = [{ role: 'user' as const, content: 'Mohon cuti' }];

const reset = (tool: string, input: object) => {
  Object.assign(executed, { applies: 0, cancels: 0, decides: 0, last: null, tool, input });
};

/** The history a client sends after the person taps Approve or Reject on the card. */
const resume = (people: typeof asMember | typeof asOwner, approved: boolean) =>
  runLekiu(...withLekiu(
    [
      ...ask,
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 't1', toolName: executed.tool, input: executed.input },
          { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 't1' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'a1', approved }] },
    ],
    people,
  ));

const APPLY = { leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' };

describe('Lekiu’s leave changes require approval', () => {
  it.each([
    ['applyLeave', APPLY, 'applies', asMember],
    ['cancelLeaveRequest', { id: REQ }, 'cancels', asMember],
    ['decideLeave', { id: REQ, approve: true }, 'decides', asOwner],
  ] as const)('%s does not run until it is approved', async (tool, input, counter, people) => {
    reset(tool, input);
    const result = runLekiu(...withLekiu(ask, people));
    await result.consumeStream();
    expect(executed[counter]).toBe(0);
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
  });

  it('approve: the resumed turn applies for the member’s own employee record', async () => {
    reset('applyLeave', APPLY);
    const result = resume(asMember, true);
    await result.consumeStream();
    expect(executed.applies).toBe(1);
    expect(executed.last).toMatchObject({ employee_id: ME, leave_type: 'annual' });
    expect(await result.text).toBe('Done.');
  });

  it('approve: a history that names another employee never applies for them', async () => {
    reset('applyLeave', { ...APPLY, employee_id: OTHER });
    const result = resume(asMember, true);
    await result.consumeStream();
    // Either the stray field is refused or it is ignored: it is never the employee applied for.
    expect(executed.last === null || (executed.last as { employee_id: string }).employee_id === ME).toBe(true);
  });

  it('reject: nothing is changed and the turn still continues', async () => {
    reset('applyLeave', APPLY);
    const result = resume(asMember, false);
    await result.consumeStream();
    expect(executed.applies).toBe(0);
    expect(await result.text).toBe('Done.');
  });

  it('a member cannot reach a decision: the tool is not theirs, so nothing runs even if the model asks', async () => {
    reset('decideLeave', { id: REQ, approve: true });
    const result = runLekiu(...withLekiu(ask, asMember));
    await result.consumeStream();
    expect(executed.decides).toBe(0);
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(false);
  });

  it('an owner’s decision runs only once approved', async () => {
    reset('decideLeave', { id: REQ, approve: true });
    const result = resume(asOwner, true);
    await result.consumeStream();
    expect(executed.decides).toBe(1);
  });
});
