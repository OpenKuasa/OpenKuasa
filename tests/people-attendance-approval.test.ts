import { describe, expect, it, vi } from 'vitest';

const executed = vi.hoisted(() => ({
  counts: {} as Record<string, number>,
  last: null as unknown,
  tool: 'clockIn',
  input: {} as object | string,
}));

const bump = (name: string, input: unknown) => {
  executed.counts[name] = (executed.counts[name] ?? 0) + 1;
  executed.last = input;
};

vi.mock('@/lib/people/attendance-writes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/attendance-writes')>();
  const day = { id: 'a1', work_date: '2026-10-09', clock_in: '2026-10-09T00:52:00Z', clock_out: null, status: 'present' };
  const record = (name: string, data: Record<string, unknown>) => async (_ctx: unknown, input: unknown) => {
    bump(name, input);
    return { ok: true as const, data };
  };
  return {
    ...actual,
    clockIn: record('clockIn', day),
    clockOut: record('clockOut', { ...day, clock_out: '2026-10-09T10:03:00Z' }),
    correctAttendance: record('correctAttendance', { ...day, status: 'absent', clock_in: null }),
    saveHoliday: record('saveHoliday', { id: 'h1', name: 'Deepavali', holiday_date: '2026-11-08' }),
    deleteHoliday: record('deleteHoliday', { id: 'h1' }),
    saveAttendanceSettings: record('saveAttendanceSettings', { work_week: ['mon'], work_start_time: '08:30', late_grace_minutes: 10 }),
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
                { type: 'tool-call', toolCallId: 't1', toolName: executed.tool, input: typeof executed.input === 'string' ? executed.input : JSON.stringify(executed.input) },
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
const HOLIDAY = '55555555-5555-4555-8555-555555555555';
const USER = '99999999-9999-4999-8999-999999999999';
const data = createSeedPeopleData(new Date('2026-10-09T04:00:00Z'));
const ctx = { client: {} as never, orgId: 'org1' };
const asMember = {
  data,
  viewer: { employeeId: ME, isHr: false, isDemo: false },
  write: { ctx, tier: 'self' as const, employeeId: ME, receipt: null, userId: USER },
};
const asOwner = {
  data,
  viewer: { employeeId: ME, isHr: true, isDemo: false },
  write: { ctx, tier: 'hr' as const, employeeId: ME, receipt: null, userId: USER },
};
const ask = [{ role: 'user' as const, content: 'Clock saya masuk' }];

const reset = (tool: string, input: object | string) => {
  Object.assign(executed, { counts: {}, last: null, tool, input });
};
const ran = (name: string) => executed.counts[name] ?? 0;

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

const CLOCK = [
  ['clockIn', {}],
  ['clockOut', {}],
] as const;
const OWNER = [
  ['correctAttendance', { employee_id: OTHER, work_date: '2026-10-08', status: 'absent' }],
  ['saveHoliday', { name: 'Deepavali', holiday_date: '2026-11-08' }],
  ['removeHoliday', { id: HOLIDAY }],
  ['saveAttendanceSettings', { work_week: ['mon'], work_start_time: '08:30', late_grace_minutes: 10 }],
] as const;
const WRITES: Record<string, string> = { removeHoliday: 'deleteHoliday' };
const writeOf = (tool: string) => WRITES[tool] ?? tool;

describe('Lekiu’s attendance changes require approval', () => {
  it.each([
    ...CLOCK.map(([tool, input]) => [tool, input, asMember] as const),
    ...CLOCK.map(([tool, input]) => [tool, input, asOwner] as const),
    ...OWNER.map(([tool, input]) => [tool, input, asOwner] as const),
  ])('%s does not run until it is approved', async (tool, input, people) => {
    reset(tool, input);
    const result = runLekiu(...withLekiu(ask, people));
    await result.consumeStream();
    expect(ran(writeOf(tool))).toBe(0);
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
  });

  it('approve: a clock-in runs once, for the member’s own employee record and nothing else', async () => {
    reset('clockIn', {});
    const result = resume(asMember, true);
    await result.consumeStream();
    expect(ran('clockIn')).toBe(1);
    expect(executed.last).toEqual({ employee_id: ME });
    expect(await result.text).toBe('Done.');
  });

  it('approve: a clock-out from an owner is for the owner’s own record too', async () => {
    reset('clockOut', {});
    const result = resume(asOwner, true);
    await result.consumeStream();
    expect(ran('clockOut')).toBe(1);
    expect(executed.last).toEqual({ employee_id: ME });
  });

  // The model's first turn, parsed by the SDK against the tool's own schema; the card the person sees; then their tap.
  it.each([
    ['clockIn', { employee_id: OTHER, time: '08:00' }, asMember],
    ['clockOut', { employee_id: OTHER, time: '08:00' }, asMember],
    ['clockIn', '', asMember],
    ['clockOut', '', asMember],
    ['clockIn', { employee_id: OTHER, time: '08:00' }, asOwner],
    ['clockOut', '', asOwner],
  ] as const)('%s sent as %j: a card appears, and once approved only the caller\'s own employee reaches the write path', async (tool, sent, people) => {
    reset(tool, sent);
    const first = runLekiu(...withLekiu(ask, people));
    await first.consumeStream();
    expect(ran(tool)).toBe(0);
    const parts = (await first.content) as { type: string; toolCallId?: string; toolName?: string; input?: unknown; approvalId?: string }[];
    const call = parts.find((p) => p.type === 'tool-call');
    const request = parts.find((p) => p.type === 'tool-approval-request');
    expect(call?.toolName).toBe(tool);
    expect(request).toBeDefined();
    // The card carries nothing the model sent.
    expect(call?.input).toEqual({});

    const second = runLekiu(...withLekiu(
      [
        ...ask,
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: call!.toolCallId!, toolName: tool, input: call!.input }, { type: 'tool-approval-request', approvalId: request!.approvalId!, toolCallId: call!.toolCallId! }] },
        { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: request!.approvalId!, approved: true }] },
      ],
      people,
    ));
    await second.consumeStream();
    expect(ran(tool)).toBe(1);
    expect(executed.last).toEqual({ employee_id: ME });
  });

  it('approve: each owner change runs once', async () => {
    for (const [tool, input] of OWNER) {
      reset(tool, input);
      const result = resume(asOwner, true);
      await result.consumeStream();
      expect(ran(writeOf(tool)), tool).toBe(1);
    }
  });

  it('reject: nothing is changed and the turn still continues', async () => {
    for (const [tool, input] of [...CLOCK, ...OWNER]) {
      reset(tool, input);
      const result = resume(asOwner, false);
      await result.consumeStream();
      expect(ran(writeOf(tool)), tool).toBe(0);
      expect(await result.text).toBe('Done.');
    }
  });

  it.each(OWNER)('a member cannot reach %s: the tool is not theirs, so nothing runs even if the model asks', async (tool, input) => {
    reset(tool, input);
    const result = runLekiu(...withLekiu(ask, asMember));
    await result.consumeStream();
    expect(ran(writeOf(tool))).toBe(0);
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(false);
  });
});
