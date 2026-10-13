import { describe, expect, it, vi } from 'vitest';

const executed = vi.hoisted(() => ({
  counts: {} as Record<string, number>,
  last: null as unknown,
  uploads: 0,
  tool: 'submitClaim',
  input: {} as object,
}));

const bump = (name: string) => {
  executed.counts[name] = (executed.counts[name] ?? 0) + 1;
};

vi.mock('@/lib/people/pay-requests', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/pay-requests')>();
  const record =
    (name: string, data: Record<string, unknown>) => async (_ctx: unknown, input: unknown) => {
      bump(name);
      executed.last = input;
      return { ok: true as const, data };
    };
  return {
    ...actual,
    submitClaim: record('submitClaim', { id: 'c1', status: 'pending', has_receipt: false }),
    cancelClaim: record('cancelClaim', { id: 'c1', status: 'cancelled', removed_receipt_path: null }),
    decideClaim: record('decideClaim', { id: 'c1', status: 'approved' }),
    markClaimPaid: record('markClaimPaid', { id: 'c1', status: 'paid', paid_on: '2026-10-10' }),
    unmarkClaimPaid: record('unmarkClaimPaid', { id: 'c1', status: 'approved' }),
    submitOvertime: record('submitOvertime', { id: 'o1', status: 'pending', amount_cents: 15000, hourly_rate_cents: 2500 }),
    cancelOvertime: record('cancelOvertime', { id: 'o1', status: 'cancelled' }),
    decideOvertime: record('decideOvertime', { id: 'o1', status: 'approved', amount_cents: 15000 }),
  };
});

vi.mock('@/lib/people/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/receipts')>();
  return {
    ...actual,
    uploadReceipt: async (_client: unknown, userId: string) => {
      executed.uploads += 1;
      return { ok: true as const, data: { path: `${userId}/r.png` } };
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
const USER = '99999999-9999-4999-8999-999999999999';
const data = createSeedPeopleData(new Date('2026-10-09T04:00:00Z'));
const ctx = { client: {} as never, orgId: 'org1' };
const PNG = { bytes: Buffer.from('png'), mediaType: 'image/png' };
const member = (receipt: typeof PNG | null = null) => ({
  data,
  viewer: { employeeId: ME, isHr: false, isDemo: false },
  write: { ctx, tier: 'self' as const, employeeId: ME, receipt, userId: USER },
});
const asMember = member();
const asOwner = {
  data,
  viewer: { employeeId: null, isHr: true, isDemo: false },
  write: { ctx, tier: 'hr' as const, employeeId: null, receipt: null, userId: USER },
};
const ask = [{ role: 'user' as const, content: 'Nak tuntut teksi' }];

const reset = (tool: string, input: object) => {
  Object.assign(executed, { counts: {}, last: null, uploads: 0, tool, input });
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

const CLAIM = { category: 'travel', amount_cents: 8500, claim_date: '2026-10-09', description: 'Teksi' };
const OT = { work_date: '2026-10-08', hours: 3, reason: 'Stocktake' };

describe('Lekiu’s claim and overtime changes require approval', () => {
  it.each([
    ['submitClaim', CLAIM, asMember],
    ['cancelClaim', { id: REQ }, asMember],
    ['submitOvertime', OT, asMember],
    ['cancelOvertime', { id: REQ }, asMember],
    ['decideClaim', { id: REQ, approve: true }, asOwner],
    ['markClaimPaid', { id: REQ, paid_on: '2026-10-10' }, asOwner],
    ['unmarkClaimPaid', { id: REQ }, asOwner],
    ['decideOvertime', { id: REQ, approve: true }, asOwner],
  ] as const)('%s does not run until it is approved', async (tool, input, people) => {
    reset(tool, input);
    const result = runLekiu(...withLekiu(ask, people));
    await result.consumeStream();
    expect(ran(tool)).toBe(0);
    expect(executed.uploads).toBe(0);
    const parts = (await result.content) as { type: string }[];
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
  });

  it('approve: the resumed turn submits for the member’s own employee record, with the receipt that came with the question', async () => {
    reset('submitClaim', CLAIM);
    const result = resume(member(PNG), true);
    await result.consumeStream();
    expect(ran('submitClaim')).toBe(1);
    expect(executed.uploads).toBe(1);
    expect(executed.last).toMatchObject({ employee_id: ME, amount_cents: 8500, receipt_path: `${USER}/r.png` });
    expect(await result.text).toBe('Done.');
  });

  it('approve: with no file on the question nothing is uploaded and the claim goes without one', async () => {
    reset('submitClaim', CLAIM);
    const result = resume(asMember, true);
    await result.consumeStream();
    expect(ran('submitClaim')).toBe(1);
    expect(executed.uploads).toBe(0);
    expect(executed.last).toMatchObject({ receipt_path: null });
  });

  it('approve: a history that names another employee or a path never submits for them or with it', async () => {
    reset('submitClaim', { ...CLAIM, employee_id: OTHER, receipt_path: 'someone-else/receipt.png' });
    const result = resume(asMember, true);
    await result.consumeStream();
    // Two different paths. When the model makes a call, the member's schema strips an employee or path field before
    // the tool runs (tests/people-pay-tools.test.ts). Here the history comes from the client and the person has
    // already approved it: the SDK re-validates the approved input and refuses it when the schema's output differs
    // from it ("Approved tool input does not match the validated schema output"), so the stripped call is not run
    // either. Either way nothing is filed for another employee or under another person's path. (The valid-input
    // case above is the one that runs, once, for the member's own id.)
    expect(ran('submitClaim')).toBe(0);
    expect(executed.last).toBeNull();
    expect(executed.uploads).toBe(0);
  });

  it('approve: an owner’s decision and paid mark run once approved', async () => {
    for (const [tool, input] of [
      ['decideClaim', { id: REQ, approve: true }],
      ['markClaimPaid', { id: REQ, paid_on: '2026-10-10' }],
      ['decideOvertime', { id: REQ, approve: false, note: 'Not agreed' }],
    ] as const) {
      reset(tool, input);
      const result = resume(asOwner, true);
      await result.consumeStream();
      expect(ran(tool), tool).toBe(1);
    }
  });

  it('reject: nothing is changed or uploaded and the turn still continues', async () => {
    reset('submitClaim', CLAIM);
    const result = resume(member(PNG), false);
    await result.consumeStream();
    expect(ran('submitClaim')).toBe(0);
    expect(executed.uploads).toBe(0);
    expect(await result.text).toBe('Done.');
  });

  it.each(['decideClaim', 'decideOvertime', 'markClaimPaid', 'unmarkClaimPaid'])(
    'a member cannot reach %s: the tool is not theirs, so nothing runs even if the model asks',
    async (tool) => {
      reset(tool, { id: REQ, approve: true, paid_on: '2026-10-10' });
      const result = runLekiu(...withLekiu(ask, asMember));
      await result.consumeStream();
      expect(ran(tool)).toBe(0);
      const parts = (await result.content) as { type: string }[];
      expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(false);
    },
  );
});
