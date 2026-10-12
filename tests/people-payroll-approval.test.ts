import { describe, expect, it, vi } from 'vitest';
import type { RunResult } from '@/lib/people/payroll-writes';

const executed = vi.hoisted(() => ({
  counts: {} as Record<string, number>,
  last: null as unknown,
  tool: 'runPayroll',
  input: {} as object | string,
}));

const bump = (name: string, input: unknown) => {
  executed.counts[name] = (executed.counts[name] ?? 0) + 1;
  executed.last = input;
};

const saved = {
  id: '77777777-7777-4777-8777-777777777777',
  employee_id: '22222222-2222-4222-8222-222222222222',
  period_month: '2026-10-01',
  basic_cents: 500000,
  gross_cents: 550000,
  epf_cents: 60500,
  socso_cents: 8000,
  eis_cents: 1100,
  pcb_cents: 12000,
  other_deductions_cents: 0,
  net_cents: 468400,
  set_by_hr: [],
  status: 'pending',
};

vi.mock('@/lib/people/payroll-writes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/payroll-writes')>();
  const record = (name: string, data: unknown) => async (_ctx: unknown, input: unknown) => {
    bump(name, input);
    return { ok: true as const, data };
  };
  return {
    ...actual,
    runPayroll: record('runPayroll', { run_id: 'r1', month: '2026-10', payslips: 3, earlier_overtime: 0, skipped: [] } satisfies RunResult),
    recalculatePayroll: record('recalculatePayroll', { run_id: 'r1', month: '2026-10', payslips: 3, added: 0, earlier_overtime: 0, skipped: [] } satisfies RunResult),
    savePayslipLine: record('savePayslipLine', { ...saved, line: { id: 'l1', kind: 'earning', source: 'hr', label: 'x', amount_cents: 1 } }),
    deletePayslipLine: record('deletePayslipLine', saved),
    setPayslipStatutory: record('setPayslipStatutory', saved),
    removePayslip: record('removePayslip', { run_id: 'r1', employee_id: saved.employee_id }),
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
const { createSeedPeopleData } = await import('@/lib/people/seed');
const { approvalTitle, nameIn } = await import('@/lib/chat/change-titles');

const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SLIP = '77777777-7777-4777-8777-777777777777';
const LINE = '88888888-8888-4888-8888-888888888888';
const USER = '99999999-9999-4999-8999-999999999999';
const data = createSeedPeopleData(new Date('2026-10-09T04:00:00Z'));
const octoberRun = (await data.listPayrollRuns()).find((r) => r.period_month === '2026-10-01')!;
const ctx = { client: {} as never, orgId: 'org1' };
const asMember = {
  data,
  viewer: { employeeId: ME, isHr: false, isDemo: false },
  write: { ctx, tier: 'self' as const, employeeId: ME, receipt: null, userId: USER },
};
const asOwner = {
  data,
  viewer: { employeeId: null, isHr: true, isDemo: false },
  write: { ctx, tier: 'hr' as const, employeeId: null, receipt: null, userId: USER },
};
const asViewerRole = {
  data,
  viewer: { employeeId: ME, isHr: false, isDemo: false },
  write: undefined,
};
const asDemoOwner = {
  data,
  viewer: { employeeId: null, isHr: true, isDemo: true },
  write: undefined,
};
const ask = [{ role: 'user' as const, content: 'Run payroll' }];

const reset = (tool: string, input: object | string) => {
  Object.assign(executed, { counts: {}, last: null, tool, input });
};
const ran = (name: string) => executed.counts[name] ?? 0;

type Case = { tool: string; write: string; sent: object | string; saved: unknown; card: string };

/** What the model sends (extra arguments and empty strings included), and what must reach the write path. */
const CASES: Case[] = [
  {
    tool: 'runPayroll', write: 'runPayroll', sent: { month: '2026-10', employee_id: OTHER, dry_run: true },
    saved: { month: '2026-10' }, card: "Run payroll for October 2026? This creates a draft. Nobody is paid and employees can't see it yet.",
  },
  {
    tool: 'runPayroll', write: 'runPayroll', sent: { month: ' 2026-10-01 ' },
    saved: { month: '2026-10' }, card: "Run payroll for October 2026? This creates a draft. Nobody is paid and employees can't see it yet.",
  },
  {
    tool: 'recalculatePayroll', write: 'recalculatePayroll', sent: { month: '2026-10', run_id: LINE, force: true },
    saved: { run_id: octoberRun.id }, card: 'Recalculate the October 2026 draft? Your own lines and figures are kept.',
  },
  {
    tool: 'savePayslipLine', write: 'savePayslipLine',
    sent: { payslip_id: SLIP, line_id: '', kind: 'earning', label: ' Sales commission ', amount: 'RM 200', employee_id: OTHER, month: '2026-10', note: 'x' },
    saved: { payslip_id: SLIP, line_id: null, kind: 'earning', label: 'Sales commission', amount_cents: 20000 },
    card: 'Add the earning “Sales commission”, RM 200.00 to a payslip that was not in the list above?',
  },
  {
    tool: 'savePayslipLine', write: 'savePayslipLine',
    sent: { payslip_id: SLIP, line_id: LINE, kind: 'deduction', label: 'Uniform', amount: '1,200.50' },
    saved: { payslip_id: SLIP, line_id: LINE, kind: 'deduction', label: 'Uniform', amount_cents: 120050 },
    card: 'Change a payslip line that was not in the list above on a payslip that was not in the list above to the deduction “Uniform”, RM 1,200.50?',
  },
  {
    tool: 'savePayslipLine', write: 'savePayslipLine',
    sent: { payslip_id: SLIP, kind: 'earning', label: 'Bonus', amount: 1200.5 },
    saved: { payslip_id: SLIP, line_id: null, kind: 'earning', label: 'Bonus', amount_cents: 120050 },
    card: 'Add the earning “Bonus”, RM 1,200.50 to a payslip that was not in the list above?',
  },
  {
    tool: 'removePayslipLine', write: 'deletePayslipLine', sent: { line_id: LINE, payslip_id: SLIP, reason: 'x' },
    saved: { line_id: LINE }, card: 'Remove a payslip line that was not in the list above?',
  },
  {
    tool: 'setPayslipStatutory', write: 'setPayslipStatutory', sent: { payslip_id: SLIP, field: 'epf', amount: '' },
    saved: { payslip_id: SLIP, field: 'epf', amount_cents: null },
    card: 'Put EPF on a payslip that was not in the list above back to the proposed amount?',
  },
  {
    tool: 'setPayslipStatutory', write: 'setPayslipStatutory', sent: { payslip_id: SLIP, field: 'pcb', amount: null, extra: 1 },
    saved: { payslip_id: SLIP, field: 'pcb', amount_cents: null },
    card: 'Put PCB on a payslip that was not in the list above back to the proposed amount?',
  },
  {
    tool: 'setPayslipStatutory', write: 'setPayslipStatutory', sent: { payslip_id: SLIP, field: 'socso', amount: '0' },
    saved: { payslip_id: SLIP, field: 'socso', amount_cents: 0 },
    card: 'Set SOCSO on a payslip that was not in the list above to RM 0.00?',
  },
  {
    tool: 'setPayslipStatutory', write: 'setPayslipStatutory', sent: { payslip_id: SLIP, field: 'eis', amount: 'RM 110.50' },
    saved: { payslip_id: SLIP, field: 'eis', amount_cents: 11050 },
    card: 'Set EIS on a payslip that was not in the list above to RM 110.50?',
  },
  {
    tool: 'removePayslip', write: 'removePayslip', sent: { payslip_id: SLIP, employee_id: OTHER },
    saved: { payslip_id: SLIP }, card: 'Remove a payslip that was not in the list above from the draft?',
  },
];

type Part = { type: string; toolCallId?: string; toolName?: string; input?: unknown; approvalId?: string };

const history = (call: Part, request: Part, approved: boolean) => [
  ...ask,
  {
    role: 'assistant' as const,
    content: [
      { type: 'tool-call' as const, toolCallId: call.toolCallId!, toolName: call.toolName!, input: call.input },
      { type: 'tool-approval-request' as const, approvalId: request.approvalId!, toolCallId: call.toolCallId! },
    ],
  },
  { role: 'tool' as const, content: [{ type: 'tool-approval-response' as const, approvalId: request.approvalId!, approved }] },
];

const firstTurn = async (c: Case, people = asOwner) => {
  reset(c.tool, c.sent);
  const first = runLekiu(ask, people);
  await first.consumeStream();
  const parts = (await first.content) as Part[];
  return { parts, call: parts.find((p) => p.type === 'tool-call'), request: parts.find((p) => p.type === 'tool-approval-request') };
};

describe('Lekiu’s payroll changes require approval', () => {
  it.each(CASES.map((c) => [c.tool, JSON.stringify(c.sent), c] as const))(
    '%s sent as %s: a card appears first and nothing is written until it is approved',
    async (_tool, _sent, c) => {
      const { call, request } = await firstTurn(c);
      expect(ran(c.write)).toBe(0);
      expect(call?.toolName).toBe(c.tool);
      expect(request).toBeDefined();
      // The card shows what will be saved, read through the SDK's own input parsing (extra arguments dropped).
      expect(approvalTitle(c.tool, call?.input)).toBe(c.card);
      expect(call?.input).not.toHaveProperty('employee_id');
      expect(call?.input).not.toHaveProperty('dry_run');
    },
  );

  it.each(CASES.map((c) => [c.tool, JSON.stringify(c.sent), c] as const))(
    '%s sent as %s: once approved, the write runs exactly once with the normalised values',
    async (_tool, _sent, c) => {
      const { call, request } = await firstTurn(c);
      expect(call).toBeDefined();
      expect(request).toBeDefined();
      const second = runLekiu(history(call!, request!, true), asOwner);
      await second.consumeStream();
      expect(ran(c.write)).toBe(1);
      expect(Object.values(executed.counts).reduce((sum, n) => sum + n, 0)).toBe(1);
      expect(executed.last).toEqual(c.saved);
      expect(await second.text).toBe('Done.');
    },
  );

  it.each(CASES.map((c) => [c.tool, JSON.stringify(c.sent), c] as const))('%s sent as %s: rejecting it writes nothing and the turn continues', async (_tool, _sent, c) => {
    const { call, request } = await firstTurn(c);
    const second = runLekiu(history(call!, request!, false), asOwner);
    await second.consumeStream();
    expect(ran(c.write)).toBe(0);
    expect(await second.text).toBe('Done.');
  });

  it.each(['', '2026-13', 'bulan ni'])('runPayroll sent a month of %j is refused by the schema: no card, no write', async (month) => {
    for (const tool of ['runPayroll', 'recalculatePayroll']) {
      reset(tool, { month });
      const result = runLekiu(ask, asOwner);
      await result.consumeStream();
      const parts = (await result.content) as Part[];
      expect(Object.values(executed.counts).reduce((sum, n) => sum + n, 0), tool).toBe(0);
      expect(parts.some((p) => p.type === 'tool-approval-request'), tool).toBe(false);
    }
  });

  it.each([
    ['savePayslipLine', { payslip_id: SLIP, kind: 'earning', label: 'Bonus', amount: 'a lot' }],
    ['savePayslipLine', { payslip_id: SLIP, kind: 'earning', label: '   ', amount: '5' }],
    ['setPayslipStatutory', { payslip_id: SLIP, field: 'epf', amount: '12.345' }],
  ])('%s with %j is refused by the schema before any card', async (tool, sent) => {
    reset(tool, sent);
    const result = runLekiu(ask, asOwner);
    await result.consumeStream();
    const parts = (await result.content) as Part[];
    expect(Object.values(executed.counts).reduce((sum, n) => sum + n, 0)).toBe(0);
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(false);
  });

  it('the card read with a finder built from an earlier listPayslips result names the employee, the line and the old figure', async () => {
    const lookup = {
      tool: 'listPayslips',
      output: {
        payslips: [
          {
            id: SLIP, employee: 'Aisyah Rahim', month: '2026-10', status: 'pending', epf: 'RM 605.00', socso: 'RM 80.00', eis: 'RM 11.00', pcb: 'RM 120.00',
            lines: [{ id: LINE, kind: 'earning', source: 'hr', label: 'Sales commission', amount: 'RM 850.00' }],
          },
        ],
      },
    };
    const find = nameIn([lookup]);
    const cases: [Case, string][] = [
      [CASES[9], "Change SOCSO on Aisyah Rahim's October 2026 payslip from RM 80.00 to RM 0.00?"],
      [CASES[3], "Add the earning “Sales commission”, RM 200.00 to Aisyah Rahim's October 2026 payslip?"],
      [CASES[4], "Change the earning “Sales commission”, RM 850.00 on Aisyah Rahim's October 2026 payslip to the deduction “Uniform”, RM 1,200.50?"],
      [CASES[6], "Remove the earning “Sales commission”, RM 850.00 from Aisyah Rahim's October 2026 payslip?"],
      [CASES[10], "Change EIS on Aisyah Rahim's October 2026 payslip from RM 11.00 to RM 110.50?"],
      [CASES[11], "Remove Aisyah Rahim's October 2026 payslip from the draft?"],
    ];
    for (const [c, title] of cases) {
      const { call } = await firstTurn(c);
      expect(approvalTitle(c.tool, call?.input, find), c.tool).toBe(title);
    }
  });

  it('a call the schema refuses (no payslip id, an empty payslip id, a missing statutory amount) never reaches a card or a write', async () => {
    for (const [tool, sent] of [
      ['removePayslip', { payslip_id: '' }],
      ['savePayslipLine', { kind: 'earning', label: 'x', amount: '5' }],
      ['setPayslipStatutory', { payslip_id: SLIP, field: 'epf' }],
      ['setPayslipStatutory', { payslip_id: SLIP, field: 'epf', amount: '', extra: 1 }, true],
      ['removePayslipLine', ''],
    ] as const) {
      reset(tool, sent);
      const result = runLekiu(ask, asOwner);
      await result.consumeStream();
      const parts = (await result.content) as Part[];
      const writes = Object.values(executed.counts).reduce((sum, n) => sum + n, 0);
      // Only the one valid row (an explicit empty amount) puts a card up; nothing writes before approval.
      expect(writes, tool).toBe(0);
      expect(parts.some((p) => p.type === 'tool-approval-request'), `${tool} ${JSON.stringify(sent)}`).toBe(tool === 'setPayslipStatutory' && typeof sent === 'object' && 'amount' in sent);
    }
  });

  it.each(CASES.map((c) => [c.tool, c] as const).filter(([, c], i, all) => all.findIndex(([, d]) => d.tool === c.tool) === all.findIndex(([, d]) => d === c)))(
    'a member cannot reach %s: the tool is not theirs, so no card and no write even if the model asks',
    async (_tool, c) => {
      reset(c.tool, c.sent);
      const result = runLekiu(ask, asMember);
      await result.consumeStream();
      expect(Object.values(executed.counts).reduce((sum, n) => sum + n, 0)).toBe(0);
      const parts = (await result.content) as Part[];
      expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(false);
    },
  );

  it.each([
    ['a viewer, linked or not, with no write access', asViewerRole],
    ['an owner of the demo workspace', asDemoOwner],
  ])('%s cannot reach any payroll tool', async (_who, people) => {
    for (const c of CASES) {
      reset(c.tool, c.sent);
      const result = runLekiu(ask, people);
      await result.consumeStream();
      expect(Object.values(executed.counts).reduce((sum, n) => sum + n, 0), c.tool).toBe(0);
      const parts = (await result.content) as Part[];
      expect(parts.some((p) => p.type === 'tool-approval-request'), c.tool).toBe(false);
    }
  });

  it('nothing in the conversation can approve for the person: a call replayed with no approval response writes nothing', async () => {
    const c = CASES[3];
    const { call, request } = await firstTurn(c);
    reset(c.tool, c.sent);
    const replay = runLekiu(history(call!, request!, false).slice(0, 2), asOwner);
    await replay.consumeStream();
    expect(ran(c.write)).toBe(0);
  });
});
