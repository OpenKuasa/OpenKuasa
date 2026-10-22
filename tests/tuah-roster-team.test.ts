import { describe, expect, it, vi } from 'vitest';

/**
 * Tuah's team: Lekiu prepares a roster change on the cheaper model. Its change tools only prepare, and a change
 * whose ids were not looked up as what they are is refused before it is ever recorded or shown.
 */
const seen = vi.hoisted(() => ({
  /** What the worker calls, step by step; it answers in words after the last step. */
  script: [] as { tool: string; input: unknown }[][],
  step: 0,
  /** Every prompt the worker was sent, as JSON. */
  prompts: [] as string[],
}));

vi.mock('@/lib/ai/provider', async (orig) => {
  const actual = await orig<typeof import('@/lib/ai/provider')>();
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  return {
    ...actual,
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async (options: { prompt: unknown }) => {
          seen.prompts.push(JSON.stringify(options.prompt));
          const calls = seen.script[seen.step++];
          const chunks: Record<string, unknown>[] = calls
            ? [
                ...calls.map(({ tool, input }, n) => ({ type: 'tool-call', toolCallId: `c-${seen.step}-${n}`, toolName: tool, input: JSON.stringify(input) })),
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
              ]
            : [
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'done' },
                { type: 'text-end', id: '0' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ];
          return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { createTeamTools } = await import('@/lib/ai/agents/specialists');
const { peopleProduct } = await import('@/lib/ai/products');
const { memoryProposalStore } = await import('@/lib/chat/proposal-store');
const { DEFAULT_PEOPLE_SETTINGS } = await import('@/lib/people/types');
type PeopleData = import('@/lib/people/types').PeopleData;
type Delegation = import('@/lib/chat/delegation').Delegation;

const NOW = new Date('2026-10-22T04:00:00Z');
const AINA = '11111111-1111-4111-8111-111111111111';
const MORNING = '44444444-4444-4444-8444-444444444444';

const data = {
  listEmployees: async () => [
    {
      id: AINA, name: 'Aina Rahman', user_id: null, employee_no: 'E1', work_email: null, department_id: null, department_name: null,
      designation: null, employment_type: 'full_time', reports_to: null, join_date: null, status: 'active',
      date_of_birth_day: null, date_of_birth_month: null, created_at: '2026-01-01T00:00:00Z',
    },
  ],
  listShiftTypes: async () => [{ id: MORNING, name: 'Morning', start_time: '09:00', end_time: '18:00', is_off: false, color: 'sky', archived: false }],
  getSettings: async () => structuredClone(DEFAULT_PEOPLE_SETTINGS),
} as unknown as PeopleData;

async function delegate(script: { tool: string; input: unknown }[][]) {
  seen.script = script;
  seen.step = 0;
  seen.prompts = [];
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  try {
    const product = peopleProduct({
      data,
      viewer: { employeeId: null, isHr: true, isDemo: false },
      write: { ctx: { client: {} as never, orgId: 'org-1' }, tier: 'hr', employeeId: null, receipt: null, userId: 'u1' },
    });
    const store = memoryProposalStore();
    const team = { transcript: '', proposals: new Map(), store, names: {} };
    const { tools } = createTeamTools([product], team, []);
    const run = (tools.askLekiu as unknown as { execute: (i: unknown, o: unknown) => AsyncIterable<Delegation> }).execute(
      { task: 'Put Aina on the morning shift on Wednesday 28 October' },
      { toolCallId: 'ask-1', messages: [] },
    );
    let last: Delegation | null = null;
    for await (const snapshot of run) last = snapshot;
    return { report: last!, store };
  } finally {
    vi.useRealTimers();
  }
}

const cells = (employee: string) => ({ cells: [{ employee_id: employee, work_date: '2026-10-28', shift_type_id: MORNING }] });

describe('Lekiu on Tuah\'s team prepares a roster change', () => {
  it('with ids it looked up as what they are: one proposal, worded with the names', async () => {
    const { report, store } = await delegate([
      [{ tool: 'listEmployees', input: {} }, { tool: 'listShiftTypes', input: {} }],
      [{ tool: 'setShifts', input: cells(AINA) }],
    ]);
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0]).toMatchObject({ action: 'setShifts', title: "Set Aina Rahman's shifts for the week of 26 Oct?" });
    expect(JSON.stringify(report.proposals[0].changes)).not.toContain(MORNING);
    expect((store as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('an id seen only as another kind (a shift type passed as the employee) is refused, and nothing is recorded', async () => {
    const { report, store } = await delegate([
      [{ tool: 'listShiftTypes', input: {} }],
      [{ tool: 'setShifts', input: cells(MORNING) }],
    ]);
    expect(report.proposals).toEqual([]);
    expect((store as unknown as { rows: unknown[] }).rows).toEqual([]);
    // The specialist was told why, in its next step.
    expect(seen.prompts.at(-1)).toMatch(/You have not looked up 44444444-[^ ]* as an employee/);
  });

  it('an id nobody looked up at all is refused too', async () => {
    const { report } = await delegate([[{ tool: 'setShifts', input: cells(AINA) }]]);
    expect(report.proposals).toEqual([]);
    expect(seen.prompts.at(-1)).toContain('You have not looked up');
  });
});
