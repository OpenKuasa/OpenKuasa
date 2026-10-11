import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeopleData, PeopleViewer } from '@/lib/people/types';

const ctl = vi.hoisted(() => ({
  ran: [] as { fn: string; orgId: string; input: unknown }[],
  fail: null as string | null,
}));

const SLIP = '77777777-7777-4777-8777-777777777777';
const LINE = '88888888-8888-4888-8888-888888888888';
const RUN = '66666666-6666-4666-8666-666666666666';
const EMP = '22222222-2222-4222-8222-222222222222';

const saved = {
  id: SLIP,
  employee_id: EMP,
  period_month: '2026-10-01',
  basic_cents: 500000,
  gross_cents: 550000,
  epf_cents: 60500,
  socso_cents: 8000,
  eis_cents: 1100,
  pcb_cents: 12000,
  other_deductions_cents: 3000,
  net_cents: 465400,
  set_by_hr: ['epf'],
  status: 'pending',
};

// Every payroll write is replaced by a recorder; the input schemas stay real.
vi.mock('@/lib/people/payroll-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/payroll-writes')>();
  const record = (fn: string, reply: (input: Record<string, unknown>) => unknown) => async (ctx: { orgId: string }, input: Record<string, unknown>) => {
    ctl.ran.push({ fn, orgId: ctx.orgId, input });
    if (ctl.fail === 'throw') throw new Error('secret reason: salary RM 9,999.00');
    if (ctl.fail) return { ok: false as const, error: ctl.fail };
    return { ok: true as const, data: reply(input) };
  };
  return {
    ...actual,
    runPayroll: record('runPayroll', () => ({
      run_id: RUN,
      month: '2026-10',
      payslips: 19,
      skipped: [{ employee_id: 'e9', name: 'Siti Aminah', reason: 'no_salary' }],
    })),
    recalculatePayroll: record('recalculatePayroll', () => ({ run_id: RUN, month: '2026-10', payslips: 20, added: 1, skipped: [] })),
    savePayslipLine: record('savePayslipLine', (input) => ({
      ...saved,
      line: { id: LINE, kind: input.kind, source: 'hr', label: input.label, amount_cents: input.amount_cents },
    })),
    deletePayslipLine: record('deletePayslipLine', () => saved),
    setPayslipStatutory: record('setPayslipStatutory', () => saved),
    removePayslip: record('removePayslip', () => ({ run_id: RUN, employee_id: EMP })),
  };
});

const { PEOPLE_TOOL_NAMES, createPeopleTools } = await import('@/lib/ai/people-tools');
const { PEOPLE_WRITE_TOOL_NAMES, combineToolkits, peopleProduct } = await import('@/lib/ai/products');
const { createSeedPeopleData } = await import('@/lib/people/seed');
const { asMember } = await import('./setup/people-member-view');
const { toolMeta } = await import('@/components/chat/tool-parts');

// A Friday in Kuala Lumpur, 12:00.
const NOW = new Date('2026-10-09T04:00:00Z');
const ME = '22222222-2222-4222-8222-222222222222';
const HR_VIEWER: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const HR_LINKED: PeopleViewer = { employeeId: ME, employeeName: 'Faiz Hakim', isHr: true, isDemo: false };
const MEMBER_VIEWER: PeopleViewer = { employeeId: ME, employeeName: 'Faiz Hakim', isHr: false, isDemo: false };
const DEMO_VIEWER: PeopleViewer = { employeeId: ME, isHr: false, isDemo: true };
const base = createSeedPeopleData(NOW);

const hr = (employeeId: string | null = null) => ({ ctx: { client: {} as never, orgId: 'org-1' }, tier: 'hr' as const, employeeId, receipt: null, userId: 'u1' });
const self = (employeeId: string | null = ME) => ({ ctx: { client: {} as never, orgId: 'org-1' }, tier: 'self' as const, employeeId, receipt: null, userId: 'u1' });
type Write = ReturnType<typeof hr> | ReturnType<typeof self>;

const PAYROLL = ['runPayroll', 'recalculatePayroll', 'savePayslipLine', 'removePayslipLine', 'setPayslipStatutory', 'removePayslip'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const tools = (viewer: PeopleViewer, write?: Write, data: PeopleData = base) => createPeopleTools(data, viewer, NOW, write);
const run = (name: string, input: Record<string, unknown>, viewer: PeopleViewer = HR_VIEWER, write: Write | undefined = hr(), data: PeopleData = base): Promise<Loose> =>
  (tools(viewer, write, data)[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 't',
    messages: [],
  });
const schemaOf = (name: string) =>
  (tools(HR_VIEWER, hr())[name] as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } } }).inputSchema;

beforeEach(() => {
  ctl.ran = [];
  ctl.fail = null;
});

describe('who holds the payroll tools', () => {
  it('an owner or admin holds all six, whether or not their own account is linked', () => {
    for (const [viewer, write] of [[HR_VIEWER, hr(null)], [HR_LINKED, hr(ME)]] as const) {
      const held = Object.keys(tools(viewer, write));
      for (const name of PAYROLL) expect(held, name).toContain(name);
    }
  });

  it('a member, a viewer (linked or not), an unlinked member and anyone without write access hold none: absent, not disabled', () => {
    for (const [viewer, write] of [
      [MEMBER_VIEWER, self()],
      [MEMBER_VIEWER, self(null)],
      [MEMBER_VIEWER, undefined],
      [HR_VIEWER, undefined],
    ] as const) {
      const held = Object.keys(tools(viewer, write));
      for (const name of PAYROLL) expect(held, name).not.toContain(name);
    }
  });

  it('nobody in the demo holds one, an owner included, even when handed write access', () => {
    for (const write of [hr(ME), self(ME)]) {
      const held = Object.keys(tools({ ...HR_LINKED, isDemo: true }, write));
      for (const name of PAYROLL) expect(held, name).not.toContain(name);
    }
    expect(Object.keys(tools(DEMO_VIEWER))).toEqual([...PEOPLE_TOOL_NAMES]);
  });

  it('there is no tool for marking a run paid, undoing paid or deleting a draft', () => {
    const held = Object.keys(tools(HR_LINKED, hr(ME)));
    for (const name of held.filter((n) => /payroll|payslip|run/i.test(n))) {
      expect(name, name).not.toMatch(/paid|reopen|undo|delete/i);
    }
    for (const name of ['markPayrollPaid', 'unmarkPayrollPaid', 'deletePayrollRun', 'reopenPayroll', 'undoPayrollPaid']) expect(held).not.toContain(name);
    expect(PEOPLE_WRITE_TOOL_NAMES.filter((n) => /payroll|payslip/i.test(n)).sort()).toEqual([...PAYROLL].sort());
    // Nor does any payroll tool say it does one of them.
    for (const name of PAYROLL) {
      const description = (tools(HR_LINKED, hr(ME))[name] as unknown as { description: string }).description;
      expect(description, name).not.toMatch(/mark(s|ing)? (it|a run|the run) (as )?paid|undo paid|delete a draft run|reopen/i);
    }
  });

  it('every payroll change waits for approval and the lookups do not', () => {
    const kit = peopleProduct({ data: base, viewer: HR_LINKED, write: hr(ME) });
    const { toolApproval } = combineToolkits([kit]);
    for (const name of PAYROLL) {
      expect(PEOPLE_WRITE_TOOL_NAMES, name).toContain(name);
      expect(kit.write, name).toHaveProperty(name);
      expect(toolApproval?.[name], name).toBe('user-approval');
    }
    for (const name of ['listPayslips', 'getPayrollSummary']) {
      expect(kit.read).toHaveProperty(name);
      expect(toolApproval?.[name]).toBeUndefined();
    }
  });

  it('the change tools show on a card as changes, with readable names', () => {
    for (const [name, label] of [
      ['runPayroll', 'Run payroll'],
      ['recalculatePayroll', 'Recalculate payroll'],
      ['savePayslipLine', 'Save payslip line'],
      ['removePayslipLine', 'Remove payslip line'],
      ['removePayslip', 'Remove payslip'],
    ] as const) {
      expect(toolMeta(name).isFallback, name).toBe(true);
      expect(toolMeta(name).label).toBe(label);
    }
  });
});

describe('listPayslips', () => {
  const october = (rows: Loose[], name: string) => rows.find((p) => p.employee === name && p.month === '2026-10');

  it('for an owner or admin: each payslip’s id, run status, figures, who set them and its lines with ids', async () => {
    const result = await run('listPayslips', { month: '2026-10', limit: 50 });
    expect(result.scope).toBe('everyone in the workspace');
    const slip = result.payslips.find((p: Loose) => p.lines.some((l: Loose) => l.label === 'Sales commission'));
    expect(slip).toBeDefined();
    expect(slip.id).toEqual(expect.any(String));
    expect(slip.employee_id).toEqual(expect.any(String));
    expect(slip.run_status).toBe('draft');
    expect(slip.set_by_hr).toEqual([]);
    for (const key of ['basic', 'gross', 'epf', 'socso', 'eis', 'pcb', 'other_deductions', 'net']) expect(slip[key], key).toMatch(/^RM [\d,]+\.\d{2}$/);
    expect(slip.status).toBe('pending');
    const line = slip.lines.find((l: Loose) => l.label === 'Sales commission');
    expect(line).toEqual({ id: expect.any(String), kind: 'earning', source: 'hr', label: 'Sales commission', amount: expect.stringMatching(/^RM [\d,]+\.\d{2}$/) });
    // System lines carry their source so the model can see they are not its to change.
    expect(slip.lines.every((l: Loose) => typeof l.id === 'string' && typeof l.source === 'string')).toBe(true);
  });

  it('a paid month reads paid, and every row has its lines array', async () => {
    const result = await run('listPayslips', { month: '2026-09', limit: 50 });
    expect(result.payslips.length).toBeGreaterThan(5);
    for (const slip of result.payslips) {
      expect(slip.run_status).toBe('paid');
      expect(Array.isArray(slip.lines)).toBe(true);
    }
  });

  it('money in a lookup is worded Ringgit and never cents', async () => {
    const result = await run('listPayslips', { month: '2026-10', limit: 50 });
    expect(JSON.stringify(result)).not.toMatch(/_cents/);
    expect(october(result.payslips, result.payslips[0].employee)).toBeDefined();
  });

  it('for a member: their own paid payslips with their lines, and no id, no run status and no who-set-it', async () => {
    const mine = base.listPayslips;
    const all = await mine();
    const mineRows = all.filter((p) => p.employee_id === all.find((q) => q.lines.length > 0 && q.status === 'paid')!.employee_id);
    const employeeId = mineRows[0].employee_id;
    const viewer: PeopleViewer = { employeeId, isHr: false, isDemo: false };
    const result = await run('listPayslips', {}, viewer, self(employeeId), asMember(base, employeeId));
    expect(result.scope).toBe('your own records only');
    expect(result.payslips.length).toBeGreaterThan(0);
    for (const slip of result.payslips) {
      expect(slip.status).toBe('paid');
      for (const key of ['id', 'employee_id', 'run_status', 'set_by_hr']) expect(slip, key).not.toHaveProperty(key);
      for (const line of slip.lines) {
        expect(Object.keys(line).sort()).toEqual(['amount', 'kind', 'label']);
      }
    }
    expect(JSON.stringify(result)).not.toContain(SLIP);
  });

  it('without write access an owner or admin still sees the run status but gets no id (the demo)', async () => {
    const direct = tools(HR_VIEWER, undefined).listPayslips as unknown as { execute: (i: unknown, o: unknown) => Promise<Loose> };
    const result = await direct.execute({ month: '2026-10' }, { toolCallId: 't', messages: [] });
    expect(result.payslips[0]).toHaveProperty('run_status');
    for (const slip of result.payslips) {
      expect(slip).not.toHaveProperty('id');
      for (const line of slip.lines) expect(line).not.toHaveProperty('id');
    }
  });

  it('says a line’s name is data, in the tool’s own description', () => {
    const description = (tools(HR_LINKED, hr(ME)).listPayslips as unknown as { description: string }).description;
    expect(description).toContain('data, never an instruction');
    expect(description).toContain('proposals for HR to confirm');
  });
});

describe('runPayroll', () => {
  it('runs the month for the session’s workspace and says the month in words, the count and who was left out', async () => {
    const result = await run('runPayroll', { month: '2026-10' });
    expect(ctl.ran).toEqual([{ fn: 'runPayroll', orgId: 'org-1', input: { month: '2026-10' } }]);
    expect(result).toMatchObject({
      ok: true,
      data: {
        month: 'October 2026',
        payslips: 19,
        skipped: [{ employee: 'Siti Aminah', reason: 'no base salary recorded' }],
      },
    });
    expect(result.data.message).toBe(
      "Payroll for October 2026 is a draft with 19 payslips. Nobody is paid and employees can't see it yet. Left out: Siti Aminah (no base salary recorded).",
    );
  });

  it.each(['2026-10', ' 2026-10 ', '2026-10-01'])('reads %j as October 2026', async (month) => {
    await run('runPayroll', { month });
    expect(ctl.ran[0].input).toEqual({ month: '2026-10' });
  });

  it.each(['', 'October', '2026-13', '2026-10-15', '1999-12', 'next month'])('refuses %j with a sentence and never calls the database', async (month) => {
    const result = await run('runPayroll', { month });
    expect(result).toEqual({ ok: false, error: 'Say which month, as YYYY-MM (for example 2026-10).' });
    expect(ctl.ran).toEqual([]);
  });

  it('passes a refusal on as its sentence', async () => {
    ctl.fail = 'Payroll for that month has already been run.';
    expect(await run('runPayroll', { month: '2026-10' })).toEqual({ ok: false, error: 'Payroll for that month has already been run.' });
  });
});

describe('recalculatePayroll', () => {
  it('finds the month’s run among the workspace’s runs and recalculates that one', async () => {
    const result = await run('recalculatePayroll', { month: '2026-10' });
    const runs = await base.listPayrollRuns();
    const october = runs.find((r) => r.period_month === '2026-10-01')!;
    expect(ctl.ran).toEqual([{ fn: 'recalculatePayroll', orgId: 'org-1', input: { run_id: october.id } }]);
    expect(result).toMatchObject({ ok: true, data: { month: 'October 2026', payslips: 20, added: 1, skipped: [] } });
    expect(result.data.message).toBe('The October 2026 draft now has 20 payslips. 1 added.');
  });

  it('refuses in a sentence when that month has no run, without calling the database', async () => {
    const result = await run('recalculatePayroll', { month: '2027-03' });
    expect(result).toEqual({ ok: false, error: 'No payroll has been run for March 2027 yet.' });
    expect(ctl.ran).toEqual([]);
  });

  it('refuses a month it cannot read', async () => {
    expect(await run('recalculatePayroll', { month: 'bulan ni' })).toMatchObject({ ok: false });
    expect(ctl.ran).toEqual([]);
  });
});

describe('savePayslipLine', () => {
  const add = { payslip_id: SLIP, kind: 'earning', label: 'Sales commission' };

  it.each([
    ['200', 20000],
    ['RM 200', 20000],
    ['rm200', 20000],
    ['1,200.50', 120050],
    ['1200.5', 120050],
    [' 1200.50 ', 120050],
    [200, 20000],
    [1200.5, 120050],
  ])('amount %j is saved as %i cents', async (amount, cents) => {
    const result = await run('savePayslipLine', { ...add, amount });
    expect(ctl.ran).toEqual([
      { fn: 'savePayslipLine', orgId: 'org-1', input: { payslip_id: SLIP, line_id: null, kind: 'earning', label: 'Sales commission', amount_cents: cents } },
    ]);
    expect(result.ok).toBe(true);
  });

  it.each(['', '0', 'RM 0.00', '-5', '12.345', '1,20', 'abc', '1e3', '99999999', 'RM', null, undefined, Number.NaN])(
    'amount %j is refused in a sentence and nothing is saved',
    async (amount) => {
      const result = await run('savePayslipLine', { ...add, amount });
      expect(result).toEqual({ ok: false, error: 'Enter an amount above zero, like 1,200.50. It can be up to RM 9,999,999.99.' });
      expect(ctl.ran).toEqual([]);
    },
  );

  it('an empty or blank line id adds a line; a real one changes that line', async () => {
    for (const line_id of ['', '   ', null, undefined]) await run('savePayslipLine', { ...add, amount: '5', line_id });
    expect(ctl.ran.map((r) => (r.input as { line_id: unknown }).line_id)).toEqual([null, null, null, null]);
    ctl.ran = [];
    await run('savePayslipLine', { ...add, amount: '5', line_id: ` ${LINE} ` });
    expect(ctl.ran[0].input).toMatchObject({ line_id: LINE });
  });

  it('trims the name, and refuses an empty, blank, overlong or wrong-kind one before any call', async () => {
    await run('savePayslipLine', { ...add, label: '  Sales commission  ', amount: '5' });
    expect(ctl.ran[0].input).toMatchObject({ label: 'Sales commission' });
    ctl.ran = [];
    expect(await run('savePayslipLine', { ...add, label: '   ', amount: '5' })).toEqual({ ok: false, error: 'Give the line a name.' });
    expect(await run('savePayslipLine', { ...add, label: 'x'.repeat(81), amount: '5' })).toEqual({ ok: false, error: 'Keep the name to 80 characters.' });
    expect(await run('savePayslipLine', { ...add, kind: 'unpaid', amount: '5' })).toMatchObject({ ok: false });
    expect(ctl.ran).toEqual([]);
  });

  it('answers with the payslip as the database worked it out, in worded Ringgit, never cents', async () => {
    const result = await run('savePayslipLine', { ...add, amount: '1,200.50' });
    expect(result.data).toEqual({
      payslip_id: SLIP,
      employee_id: EMP,
      month: 'October 2026',
      basic: 'RM 5,000.00',
      gross: 'RM 5,500.00',
      epf: 'RM 605.00',
      socso: 'RM 80.00',
      eis: 'RM 11.00',
      pcb: 'RM 120.00',
      other_deductions: 'RM 30.00',
      net: 'RM 4,654.00',
      set_by_hr: ['epf'],
      status: 'pending',
      line: { id: LINE, kind: 'earning', label: 'Sales commission', amount: 'RM 1,200.50' },
    });
  });

  it('the schema takes a payslip id from a lookup, an optional line id that may be empty, and drops what it does not expect', () => {
    const schema = schemaOf('savePayslipLine');
    const parsed = schema.safeParse({ ...add, amount: '200', line_id: '', employee_id: EMP, month: '2026-10', note: 'x' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ payslip_id: SLIP, line_id: '', kind: 'earning', label: 'Sales commission', amount: '200' });
    expect(schema.safeParse({ ...add, payslip_id: 'not-an-id', amount: '200' }).success).toBe(false);
    expect(schema.safeParse({ ...add, payslip_id: '', amount: '200' }).success).toBe(false);
    expect(schema.safeParse({ ...add, line_id: 'not-an-id', amount: '200' }).success).toBe(false);
    expect(schema.safeParse({ ...add, amount: 200 }).success).toBe(true);
  });
});

describe('removePayslipLine and removePayslip', () => {
  it('remove the line, or the payslip, that was named, and answer with the payslip’s figures', async () => {
    const line = await run('removePayslipLine', { line_id: LINE });
    expect(ctl.ran[0]).toEqual({ fn: 'deletePayslipLine', orgId: 'org-1', input: { line_id: LINE } });
    expect(line.data).toMatchObject({ payslip_id: SLIP, month: 'October 2026', net: 'RM 4,654.00' });
    const slip = await run('removePayslip', { payslip_id: SLIP });
    expect(ctl.ran[1]).toEqual({ fn: 'removePayslip', orgId: 'org-1', input: { payslip_id: SLIP } });
    expect(slip.data).toEqual({ removed: true, run_id: RUN, employee_id: EMP });
  });

  it('their schemas take one id and drop anything else', () => {
    expect(schemaOf('removePayslipLine').safeParse({ line_id: LINE, payslip_id: SLIP }).data).toEqual({ line_id: LINE });
    expect(schemaOf('removePayslip').safeParse({ payslip_id: SLIP, line_id: LINE }).data).toEqual({ payslip_id: SLIP });
    expect(schemaOf('removePayslip').safeParse({ payslip_id: '' }).success).toBe(false);
    expect(schemaOf('removePayslipLine').safeParse({}).success).toBe(false);
  });
});

describe('setPayslipStatutory', () => {
  const send = { payslip_id: SLIP, field: 'epf' };

  it.each([
    ['110', 11000],
    ['RM 110.50', 11050],
    ['1,100', 110000],
    [110, 11000],
    ['0', 0],
    ['RM 0.00', 0],
    [0, 0],
    ['', null],
    ['   ', null],
    [null, null],
  ])('amount %j is saved as %j', async (amount, cents) => {
    const result = await run('setPayslipStatutory', { ...send, amount });
    expect(ctl.ran).toEqual([{ fn: 'setPayslipStatutory', orgId: 'org-1', input: { payslip_id: SLIP, field: 'epf', amount_cents: cents } }]);
    expect(result.ok).toBe(true);
  });

  it.each(['abc', '-5', '12.345', '1,20', 'RM'])('amount %j is refused in a sentence and nothing is saved', async (amount) => {
    const result = await run('setPayslipStatutory', { ...send, amount });
    expect(result).toEqual({ ok: false, error: 'Enter an amount like 110.50, or leave it empty to use the proposed amount.' });
    expect(ctl.ran).toEqual([]);
  });

  it('a missing amount is refused by the schema, never read as "back to proposed"', () => {
    const schema = schemaOf('setPayslipStatutory');
    expect(schema.safeParse({ payslip_id: SLIP, field: 'epf' }).success).toBe(false);
    expect(schema.safeParse({ payslip_id: SLIP, field: 'epf', amount: '' }).success).toBe(true);
    expect(schema.safeParse({ payslip_id: SLIP, field: 'epf', amount: null }).success).toBe(true);
    expect(schema.safeParse({ payslip_id: SLIP, field: 'tax', amount: '5' }).success).toBe(false);
    expect(schema.safeParse({ payslip_id: SLIP, field: 'EPF', amount: '5', extra: 1 }).success).toBe(false);
    expect(schema.safeParse({ payslip_id: SLIP, field: 'pcb', amount: '5', extra: 1 }).data).toEqual({ payslip_id: SLIP, field: 'pcb', amount: '5' });
  });

  it('answers with the payslip’s figures and which were set by hand', async () => {
    const result = await run('setPayslipStatutory', { ...send, amount: '605' });
    expect(result.data).toMatchObject({ epf: 'RM 605.00', set_by_hr: ['epf'], net: 'RM 4,654.00' });
  });
});

describe('failures', () => {
  it('a refusal comes back as the write path’s sentence', async () => {
    ctl.fail = 'That run is already paid. Undo paid first to change it.';
    for (const [name, input] of [
      ['savePayslipLine', { payslip_id: SLIP, kind: 'earning', label: 'Bonus', amount: '5' }],
      ['removePayslipLine', { line_id: LINE }],
      ['setPayslipStatutory', { payslip_id: SLIP, field: 'epf', amount: '' }],
      ['removePayslip', { payslip_id: SLIP }],
      ['recalculatePayroll', { month: '2026-10' }],
    ] as const) {
      expect(await run(name, input), name).toEqual({ ok: false, error: 'That run is already paid. Undo paid first to change it.' });
    }
  });

  it('a crash is a plain refusal; nothing typed, no amount and no error text reaches the log', async () => {
    ctl.fail = 'throw';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await run('savePayslipLine', { payslip_id: SLIP, kind: 'earning', label: 'Hush money', amount: '9,999' });
    expect(result).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain('Hush');
    expect(logged).not.toContain('9,999');
    expect(logged).not.toContain('salary');
    expect(logged).toContain('savePayslipLine');
    spy.mockRestore();
  });
});
