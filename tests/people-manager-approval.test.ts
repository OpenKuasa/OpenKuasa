import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  tool: 'decideLeave',
  input: {} as object,
  calls: [] as { name: string; args: unknown }[],
  answers: [] as unknown[],
  reply: { data: { id: 'r1', status: 'approved', amount_cents: null } as unknown, error: null as { message: string } | null },
}));

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
          // What the tool answered, as the model is shown it on the next step.
          for (const m of options.prompt as { role: string; content: { type: string; output?: { value?: unknown } }[] }[]) {
            if (m.role !== 'tool') continue;
            for (const part of m.content) if (part.type === 'tool-result') ctl.answers.push(part.output?.value);
          }
          const chunks: Record<string, unknown>[] = resumed
            ? [
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'Done.' },
                { type: 'text-end', id: 'a' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ]
            : [
                { type: 'tool-call', toolCallId: 't1', toolName: ctl.tool, input: JSON.stringify(ctl.input) },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
              ];
          return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { runLekiu } = await import('@/lib/ai/agents/orchestrator');
const { withLekiu } = await import('./helpers/approvals');
const { createSeedPeopleData } = await import('@/lib/people/seed');
const { asManager } = await import('./setup/people-manager-view');

const MANAGER = 'seed-emp-12';
const REQ = '44444444-4444-4444-8444-444444444444';
const EMP = '22222222-2222-4222-8222-222222222222';
const BOSS = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-09T04:00:00Z');
const client = {
  rpc: async (name: string, args: unknown) => {
    ctl.calls.push({ name, args });
    return ctl.reply;
  },
};
const data = asManager(createSeedPeopleData(NOW), MANAGER, ['seed-emp-5']);
const manager = {
  data,
  viewer: { employeeId: MANAGER, isHr: false, isDemo: false, managesTeam: true },
  write: { ctx: { client: client as never, orgId: 'org1' }, tier: 'manager' as const, employeeId: MANAGER, receipt: null, userId: 'u1' },
};
const base = createSeedPeopleData(NOW);
const ownerData = {
  ...data,
  // The two ids the owner tests name must be employees of the workspace, as the tool now checks.
  listEmployees: async () => {
    const people = await base.listEmployees();
    return [...people, { ...people[0], id: EMP, name: 'Faiz Hakim', reports_to: null }, { ...people[1], id: BOSS, name: 'Farid Ismail', reports_to: null }];
  },
};
const owner = {
  data: ownerData,
  viewer: { employeeId: null, isHr: true, isDemo: false },
  write: { ctx: { client: client as never, orgId: 'org1' }, tier: 'hr' as const, employeeId: null, receipt: null, userId: 'u1' },
};
const ask = [{ role: 'user' as const, content: 'Lulus' }];

const start = (tool: string, input: object) => {
  ctl.tool = tool;
  ctl.input = input;
  ctl.calls = [];
  ctl.answers = [];
  ctl.reply = { data: { id: 'r1', status: 'approved', amount_cents: null }, error: null };
};
const history = (approved: boolean) => [
  ...ask,
  {
    role: 'assistant' as const,
    content: [
      { type: 'tool-call' as const, toolCallId: 't1', toolName: ctl.tool, input: ctl.input },
      { type: 'tool-approval-request' as const, approvalId: 'a1', toolCallId: 't1' },
    ],
  },
  { role: 'tool' as const, content: [{ type: 'tool-approval-response' as const, approvalId: 'a1', approved }] },
];
const resume = (people: typeof manager | typeof owner, approved = true) => runLekiu(...withLekiu(history(approved), people));

beforeEach(() => start('decideLeave', { id: REQ, approve: true }));

describe("a manager's decisions", () => {
  it.each([
    ['decideLeave', 'hr_decide_leave'],
    ['decideTimeOff', 'hr_decide_time_off'],
    ['decideClaim', 'hr_decide_claim'],
    ['decideOvertime', 'hr_decide_overtime'],
  ])('%s waits for approval, then makes exactly one write with the recorded id', async (tool, rpc) => {
    start(tool, { id: REQ, approve: true });
    const first = runLekiu(...withLekiu(ask, manager));
    await first.consumeStream();
    expect(ctl.calls).toEqual([]);
    expect(((await first.content) as { type: string }[]).some((p) => p.type === 'tool-approval-request')).toBe(true);
    const second = resume(manager);
    await second.consumeStream();
    expect(ctl.calls).toEqual([{ name: rpc, args: { p_request: REQ, p_approve: true, p_note: null } }]);
  });

  it('a rejection by the person makes no write', async () => {
    const result = resume(manager, false);
    await result.consumeStream();
    expect(ctl.calls).toEqual([]);
  });

  it('an approval of a decision the server never recorded proposing makes no write', async () => {
    const { approvalBinding } = await import('@/lib/ai/products');
    const { storeOf } = await import('./helpers/approvals');
    const result = runLekiu(history(true), manager, undefined, undefined, approvalBinding(storeOf(), history(true)));
    await result.consumeStream();
    expect(ctl.calls).toEqual([]);
  });

  it('a request outside the team comes back as "not found" and nothing more is tried', async () => {
    ctl.reply = { data: null, error: { message: 'LEAVE_NOT_FOUND' } };
    const result = resume(manager);
    await result.consumeStream();
    expect(ctl.calls).toHaveLength(1);
    expect(ctl.answers).toEqual([{ ok: false, error: 'That request was not found.' }]);
  });

  it('a manager\'s decision reply carries no figures at all, even if the database sent an amount', async () => {
    start('decideOvertime', { id: REQ, approve: true });
    ctl.reply = { data: { id: 'r1', status: 'approved', amount_cents: 99999 }, error: null };
    const result = resume(manager);
    await result.consumeStream();
    expect(ctl.answers[0]).toEqual({ ok: true, data: { id: 'r1', status: 'approved' } });
    // Nothing that reads like "no salary on file".
    expect(JSON.stringify(ctl.answers)).not.toMatch(/amount|calculated|salary/i);
  });

  it('a manager\'s decision with no amount in the reply says nothing about one', async () => {
    start('decideOvertime', { id: REQ, approve: false });
    const result = resume(manager);
    await result.consumeStream();
    expect(ctl.answers[0]).toEqual({ ok: true, data: { id: 'r1', status: 'approved' } });
  });

  it('markClaimPaid is not in a manager\'s set: nothing runs, even if the model asks', async () => {
    start('markClaimPaid', { id: REQ, paid_on: '2026-10-09' });
    const result = resume(manager);
    await result.consumeStream();
    expect(ctl.calls).toEqual([]);
  });
});

describe('setReportsTo for an owner', () => {
  it('one write with the recorded ids, and null clears', async () => {
    start('setReportsTo', { id: EMP, manager_id: BOSS });
    ctl.reply = { data: { id: EMP, reports_to: BOSS }, error: null };
    await resume(owner).consumeStream();
    expect(ctl.calls).toEqual([{ name: 'hr_set_reports_to', args: { p_employee: EMP, p_manager: BOSS } }]);
    start('setReportsTo', { id: EMP, manager_id: null });
    ctl.reply = { data: { id: EMP, reports_to: null }, error: null };
    await resume(owner).consumeStream();
    expect(ctl.calls).toEqual([{ name: 'hr_set_reports_to', args: { p_employee: EMP, p_manager: null } }]);
  });

  it('a bad manager comes back as the general sentence, true for a loop or a manager gone', async () => {
    start('setReportsTo', { id: EMP, manager_id: BOSS });
    ctl.reply = { data: null, error: { message: 'EMP_BAD_MANAGER' } };
    const result = resume(owner);
    await result.consumeStream();
    expect((ctl.answers[0] as { error: string }).error).toBe(
      "That person cannot be this employee's manager: it would make a loop, or they are no longer in this workspace.",
    );
  });

  it('refuses a manager who is no employee here, and an employee reporting to themselves, before any call', async () => {
    start('setReportsTo', { id: EMP, manager_id: '99999999-9999-4999-8999-999999999999' });
    await resume(owner).consumeStream();
    expect(ctl.calls).toEqual([]);
    expect(ctl.answers[0]).toEqual({ ok: false, error: 'That manager was not found.' });
    start('setReportsTo', { id: EMP, manager_id: EMP });
    await resume(owner).consumeStream();
    expect(ctl.calls).toEqual([]);
    expect(ctl.answers[0]).toEqual({ ok: false, error: 'An employee cannot report to themselves.' });
  });

  it('is not a manager\'s tool', async () => {
    start('setReportsTo', { id: EMP, manager_id: BOSS });
    await resume(manager).consumeStream();
    expect(ctl.calls).toEqual([]);
  });
});
